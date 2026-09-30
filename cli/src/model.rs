//! multilingual-e5-small on the GPU (candle, Metal), with the plugin's own
//! weight file (e5-small-int8.ssew): the int8 weights are expanded to float32
//! (the "int8 weights only" variant, which scores like the original model).
//! BERT: absolute positions, post-LN, GELU FFN, mean pooling, L2 norm.

use anyhow::{bail, Context, Result};
use candle_core::{DType, Device, Tensor, D};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Deserialize)]
struct TensorInfo {
    dtype: String,
    shape: Vec<usize>,
    offset: u64,
    length: u64,
}

#[derive(Deserialize)]
struct Config {
    flags: u32,
    hidden: usize,
    heads: usize,
    #[allow(dead_code)]
    ffn: usize,
    layers: usize,
    max_tokens: usize,
    pooling: u32,
    ln_eps: f64,
}

#[derive(Deserialize)]
struct Header {
    model: String,
    config: Config,
    tensors: HashMap<String, TensorInfo>,
}

struct Layer {
    qkv_w: Tensor, // [H, 3H] (transposed)
    qkv_b: Tensor,
    o_w: Tensor,
    o_b: Tensor,
    ln1: (Tensor, Tensor),
    up_w: Tensor,
    up_b: Tensor,
    down_w: Tensor,
    down_b: Tensor,
    ln2: (Tensor, Tensor),
}

pub struct E5 {
    dev: Device,
    h: usize,
    heads: usize,
    eps: f32,
    pub max_tokens: usize,
    word: Tensor, // [V, H]
    pos: Tensor,  // [max_t, H], position + token type 0
    emb_ln: (Tensor, Tensor),
    layers: Vec<Layer>,
}

struct Reader {
    file: std::fs::File,
    data_start: u64,
    tensors: HashMap<String, TensorInfo>,
}

impl Reader {
    fn bytes(&mut self, name: &str) -> Result<(Vec<u8>, Vec<usize>, String)> {
        let t = self.tensors.get(name).with_context(|| format!("missing tensor {name}"))?;
        let mut buf = vec![0u8; t.length as usize];
        self.file.seek(SeekFrom::Start(self.data_start + t.offset))?;
        self.file.read_exact(&mut buf)?;
        Ok((buf, t.shape.clone(), t.dtype.clone()))
    }

    fn f32(&mut self, name: &str) -> Result<(Vec<f32>, Vec<usize>)> {
        let (b, shape, dt) = self.bytes(name)?;
        if dt != "f32" {
            bail!("{name}: expected f32");
        }
        Ok((b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect(), shape))
    }

    /// int8 rows times their scale -> f32 [rows, cols]
    fn dequant(&mut self, name: &str) -> Result<(Vec<f32>, usize, usize)> {
        let (q, shape, dt) = self.bytes(&format!("{name}.q"))?;
        if dt != "i8" {
            bail!("{name}.q: expected i8");
        }
        let (s, _) = self.f32(&format!("{name}.s"))?;
        let (rows, cols) = (shape[0], shape[1]);
        let mut out = vec![0f32; rows * cols];
        for r in 0..rows {
            let sc = s[r];
            for c in 0..cols {
                out[r * cols + c] = (q[r * cols + c] as i8) as f32 * sc;
            }
        }
        Ok((out, rows, cols))
    }
}

impl E5 {
    pub fn load(path: &Path, dev: &Device) -> Result<Self> {
        let mut file = std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let mut pre = [0u8; 12];
        file.read_exact(&mut pre)?;
        if &pre[0..4] != b"SSEW" || u32::from_le_bytes(pre[4..8].try_into()?) != 1 {
            bail!("{} is not an encoder weight file", path.display());
        }
        let len = u32::from_le_bytes(pre[8..12].try_into()?) as usize;
        let mut hb = vec![0u8; len];
        file.read_exact(&mut hb)?;
        let header: Header = serde_json::from_slice(&hb)?;
        if header.model != "e5-small" || header.config.flags != 4 || header.config.pooling != 0 {
            bail!("unexpected model in {}: {}", path.display(), header.model);
        }
        let c = header.config;
        let mut r = Reader { file, data_start: (12 + len as u64).div_ceil(64) * 64, tensors: header.tensors };
        let vec = |r: &mut Reader, name: &str| -> Result<Tensor> {
            let (v, shape) = r.f32(name)?;
            Ok(Tensor::from_vec(v, shape, dev)?)
        };
        // weights are stored [out, in]; keep them transposed for x · W
        let mat = |r: &mut Reader, name: &str| -> Result<Tensor> {
            let (v, rows, cols) = r.dequant(name)?;
            Ok(Tensor::from_vec(v, (rows, cols), dev)?.t()?.contiguous()?)
        };
        let (wv, wr, wc) = r.dequant("word")?;
        let word = Tensor::from_vec(wv, (wr, wc), dev)?;
        let mut layers = Vec::with_capacity(c.layers);
        for l in 0..c.layers {
            let p = format!("l{l}.");
            layers.push(Layer {
                qkv_w: mat(&mut r, &format!("{p}qkv"))?,
                qkv_b: vec(&mut r, &format!("{p}qkv.b"))?.unsqueeze(0)?,
                o_w: mat(&mut r, &format!("{p}o"))?,
                o_b: vec(&mut r, &format!("{p}o.b"))?.unsqueeze(0)?,
                ln1: (vec(&mut r, &format!("{p}ln1.g"))?, vec(&mut r, &format!("{p}ln1.b"))?),
                up_w: mat(&mut r, &format!("{p}up"))?,
                up_b: vec(&mut r, &format!("{p}up.b"))?.unsqueeze(0)?,
                down_w: mat(&mut r, &format!("{p}down"))?,
                down_b: vec(&mut r, &format!("{p}down.b"))?.unsqueeze(0)?,
                ln2: (vec(&mut r, &format!("{p}ln2.g"))?, vec(&mut r, &format!("{p}ln2.b"))?),
            });
        }
        Ok(E5 {
            dev: dev.clone(),
            h: c.hidden,
            heads: c.heads,
            eps: c.ln_eps as f32,
            max_tokens: c.max_tokens,
            word,
            // token type 0 is added to every position: one table
            pos: vec(&mut r, "pos")?.broadcast_add(&vec(&mut r, "tt0")?)?,
            emb_ln: (vec(&mut r, "emb_ln.g")?, vec(&mut r, "emb_ln.b")?),
            layers,
        })
    }

    fn ln(&self, x: &Tensor, p: &(Tensor, Tensor)) -> Result<Tensor> {
        Ok(candle_nn::ops::layer_norm(x, &p.0, &p.1, self.eps)?)
    }

    /// Normalised embeddings of a batch of token id sequences (any lengths)
    pub fn embed(&self, batch: &[Vec<u32>]) -> Result<Vec<Vec<f32>>> {
        let b = batch.len();
        let t = batch.iter().map(|s| s.len()).max().unwrap_or(0);
        if b == 0 || t == 0 {
            return Ok(Vec::new());
        }
        if t > self.max_tokens {
            bail!("sequence longer than {} tokens", self.max_tokens);
        }
        let (h, heads) = (self.h, self.heads);
        let hd = h / heads;
        let mut ids = vec![1u32; b * t]; // <pad>
        let mut mask = vec![0f32; b * t];
        for (i, s) in batch.iter().enumerate() {
            ids[i * t..i * t + s.len()].copy_from_slice(s);
            for j in 0..s.len() {
                mask[i * t + j] = 1.0;
            }
        }
        let ids = Tensor::from_vec(ids, b * t, &self.dev)?;
        let mask = Tensor::from_vec(mask, (b, t), &self.dev)?;
        // additive attention bias: 0 for tokens, -1e9 for padding keys
        // (broadcast view: the fused attention kernel reads it through strides)
        let bias = ((mask.clone() - 1.0)? * 1e9)?.reshape((b, 1, 1, t))?.broadcast_as((b, heads, t, t))?;

        // Broadcast element-wise ops are slow on Metal in candle: embeddings are
        // gathered as contiguous tensors, and biases are added as ones·bias
        let pos_ids = Tensor::from_vec((0..b * t).map(|i| (i % t) as u32).collect::<Vec<_>>(), b * t, &self.dev)?;
        let ones = Tensor::ones((b * t, 1), DType::F32, &self.dev)?;
        let lin = |x: &Tensor, w: &Tensor, bias: &Tensor| -> Result<Tensor> { Ok((x.matmul(w)? + ones.matmul(bias)?)?) };
        let mut x = (self.word.index_select(&ids, 0)? + self.pos.index_select(&pos_ids, 0)?)?.reshape((b, t, h))?;
        x = self.ln(&x, &self.emb_ln)?;
        let scale = 1.0 / (hd as f32).sqrt();
        for l in &self.layers {
            let x2 = x.reshape((b * t, h))?;
            let qkv = lin(&x2, &l.qkv_w, &l.qkv_b)?; // [BT, 3H]
            // [B, heads, T, hd] views (no copies)
            let split = |i: usize| -> Result<Tensor> { Ok(qkv.narrow(1, i * h, h)?.reshape((b, t, heads, hd))?.transpose(1, 2)?) };
            let (q, k, v) = (split(0)?, split(1)?, split(2)?);
            // fused scaled dot-product attention (softmax(q·kᵀ·scale + bias)·v)
            let att = candle_nn::ops::sdpa(&q, &k, &v, Some(&bias), false, scale, 1.0)?;
            let ctx = att.transpose(1, 2)?.contiguous()?.reshape((b * t, h))?;
            let o = lin(&ctx, &l.o_w, &l.o_b)?.reshape((b, t, h))?;
            x = self.ln(&(x + o)?, &l.ln1)?;
            let x2 = x.reshape((b * t, h))?;
            let up = lin(&x2, &l.up_w, &l.up_b)?.gelu_erf()?;
            let down = lin(&up, &l.down_w, &l.down_b)?.reshape((b, t, h))?;
            x = self.ln(&(x + down)?, &l.ln2)?;
        }
        // mean over the real tokens, then L2
        let m = mask.unsqueeze(2)?;
        let sum = x.broadcast_mul(&m)?.sum(1)?;
        let n = m.sum(1)?;
        let mean = sum.broadcast_div(&n)?;
        let norm = mean.sqr()?.sum_keepdim(D::Minus1)?.sqrt()?;
        let out = mean.broadcast_div(&norm)?.to_dtype(DType::F32)?.to_vec2::<f32>()?;
        Ok(out)
    }
}
