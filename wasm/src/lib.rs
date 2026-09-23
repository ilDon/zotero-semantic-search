//! Forward pass of google/LEALLA/LEALLA-large/1 (TF Hub) in WebAssembly SIMD,
//! plus an int8 vector scan used by the semantic index.
//!
//! The graph reproduced here is the one that produced the legacy
//! `file_embeddings.db` (verified bit-for-bit against the TF SavedModel):
//!
//!   x   = word_emb[ids] + token_type_embeddings[0] + position_emb[0..T]
//!   x   = LayerNorm(x)                                   (eps 1e-12)
//!   24x post-LN BERT layers (8 heads, hidden 256, FFN 1024, GELU-tanh)
//!   out = l2_normalize(GELU_tanh(W_pool · x[CLS] + b_pool))
//!
//! Note the pooler activation is GELU, not tanh as in stock BERT, and the
//! token type row comes from `token_type_embeddings` (not `_real`).
//!
//! Word embeddings are looked up by the host (JS reads rows from disk), so this
//! module only holds the ~19M encoder parameters.
//!
//! Weight buffer layout (f32, linear layers in PyTorch [out, in] order):
//!   tt0[256] pos[512*256] emb_ln_g[256] emb_ln_b[256]
//!   24 x { q_w q_b k_w k_b v_w v_b ao_w ao_b ao_ln_g ao_ln_b
//!          i_w[1024*256] i_b[1024] o_w[256*1024] o_b[256] o_ln_g o_ln_b }
//!   pool_w[256*256] pool_b[256]

#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use core::arch::wasm32::*;

const H: usize = 256;
const HEADS: usize = 8;
const HD: usize = H / HEADS;
const FF: usize = 1024;
const LAYERS: usize = 24;
const MAX_T: usize = 512;
const LN_EPS: f32 = 1e-12;
const ATT_SCALE: f32 = 0.176_776_69; // 1/sqrt(32), same constant as the TF graph

const LAYER_FLOATS: usize = 4 * (H * H + H) + 2 * H + (FF * H + FF) + (H * FF + H) + 2 * H;
pub const WEIGHT_FLOATS: usize = H + MAX_T * H + 2 * H + LAYERS * LAYER_FLOATS + H * H + H;

#[global_allocator]
static ALLOC: Bump = Bump;

/// Minimal allocator: grows linear memory, frees nothing except via `reset`
/// semantics of the host (buffers are allocated once and reused).
struct Bump;

static mut HEAP_TOP: usize = 0;

unsafe impl core::alloc::GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        let align = layout.align().max(16);
        if HEAP_TOP == 0 {
            extern "C" {
                static __heap_base: u8;
            }
            HEAP_TOP = &__heap_base as *const u8 as usize;
        }
        let start = (HEAP_TOP + align - 1) & !(align - 1);
        let end = start + layout.size();
        let have = memory_size(0) * 65536;
        if end > have {
            let pages = (end - have + 65535) / 65536;
            if memory_grow(0, pages) == usize::MAX {
                return core::ptr::null_mut();
            }
        }
        HEAP_TOP = end;
        start as *mut u8
    }
    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: core::alloc::Layout) {}
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

fn buf(n: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(n);
    v.resize(n, 0.0);
    v
}

/// Allocate `bytes` bytes (16-byte aligned) in linear memory for the host.
#[no_mangle]
pub extern "C" fn alloc_bytes(bytes: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(bytes);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn weight_floats() -> usize {
    WEIGHT_FLOATS
}

#[no_mangle]
pub extern "C" fn max_tokens() -> usize {
    MAX_T
}

struct Scratch {
    x: Vec<f32>,
    q: Vec<f32>,
    k: Vec<f32>,
    v: Vec<f32>,
    vt: Vec<f32>,
    ctx: Vec<f32>,
    tmp: Vec<f32>,
    ff: Vec<f32>,
    scores: Vec<f32>,
}

static mut WEIGHTS: *const f32 = core::ptr::null();
static mut SCRATCH: Option<Scratch> = None;

/// Allocate the weight buffer; the host fills it and then calls `init`.
#[no_mangle]
pub extern "C" fn alloc_weights() -> *mut f32 {
    alloc_bytes(WEIGHT_FLOATS * 4) as *mut f32
}

#[no_mangle]
pub unsafe extern "C" fn init(weights: *const f32) {
    WEIGHTS = weights;
    SCRATCH = Some(Scratch {
        x: buf(MAX_T * H),
        q: buf(MAX_T * H),
        k: buf(MAX_T * H),
        v: buf(MAX_T * H),
        vt: buf(HD * MAX_T),
        ctx: buf(MAX_T * H),
        tmp: buf(MAX_T * H),
        ff: buf(MAX_T * FF),
        scores: buf(MAX_T * MAX_T),
    });
}

/// Buffer where the host writes T word-embedding rows before calling `embed`.
#[no_mangle]
pub unsafe extern "C" fn input_ptr() -> *mut f32 {
    (*core::ptr::addr_of_mut!(SCRATCH)).as_mut().unwrap().x.as_mut_ptr()
}

struct W {
    p: *const f32,
}

impl W {
    unsafe fn take(&mut self, n: usize) -> &'static [f32] {
        let s = core::slice::from_raw_parts(self.p, n);
        self.p = self.p.add(n);
        s
    }
}

#[inline(always)]
fn hsum(v: v128) -> f32 {
    f32x4_extract_lane::<0>(v)
        + f32x4_extract_lane::<1>(v)
        + f32x4_extract_lane::<2>(v)
        + f32x4_extract_lane::<3>(v)
}

/// C[m, n] = sum_k A[m, k] * B[n, k] (+ bias[n])
/// A: M x K (row stride lda), B: N x K (row stride ldb), C: M x N (row stride ldc).
#[allow(clippy::too_many_arguments)]
unsafe fn gemm_nt(
    a: *const f32,
    lda: usize,
    b: *const f32,
    ldb: usize,
    c: *mut f32,
    ldc: usize,
    m: usize,
    n: usize,
    k: usize,
    bias: Option<&[f32]>,
) {
    let k4 = k & !3;
    let mut i = 0;
    while i + 4 <= m {
        let a0 = a.add(i * lda);
        let a1 = a.add((i + 1) * lda);
        let a2 = a.add((i + 2) * lda);
        let a3 = a.add((i + 3) * lda);
        let mut j = 0;
        while j + 4 <= n {
            let b0 = b.add(j * ldb);
            let b1 = b.add((j + 1) * ldb);
            let b2 = b.add((j + 2) * ldb);
            let b3 = b.add((j + 3) * ldb);
            let z = f32x4_splat(0.0);
            let (mut c00, mut c01, mut c02, mut c03) = (z, z, z, z);
            let (mut c10, mut c11, mut c12, mut c13) = (z, z, z, z);
            let (mut c20, mut c21, mut c22, mut c23) = (z, z, z, z);
            let (mut c30, mut c31, mut c32, mut c33) = (z, z, z, z);
            let mut p = 0;
            while p < k4 {
                let va0 = v128_load(a0.add(p) as *const v128);
                let va1 = v128_load(a1.add(p) as *const v128);
                let va2 = v128_load(a2.add(p) as *const v128);
                let va3 = v128_load(a3.add(p) as *const v128);
                let vb0 = v128_load(b0.add(p) as *const v128);
                let vb1 = v128_load(b1.add(p) as *const v128);
                let vb2 = v128_load(b2.add(p) as *const v128);
                let vb3 = v128_load(b3.add(p) as *const v128);
                c00 = f32x4_add(c00, f32x4_mul(va0, vb0));
                c01 = f32x4_add(c01, f32x4_mul(va0, vb1));
                c02 = f32x4_add(c02, f32x4_mul(va0, vb2));
                c03 = f32x4_add(c03, f32x4_mul(va0, vb3));
                c10 = f32x4_add(c10, f32x4_mul(va1, vb0));
                c11 = f32x4_add(c11, f32x4_mul(va1, vb1));
                c12 = f32x4_add(c12, f32x4_mul(va1, vb2));
                c13 = f32x4_add(c13, f32x4_mul(va1, vb3));
                c20 = f32x4_add(c20, f32x4_mul(va2, vb0));
                c21 = f32x4_add(c21, f32x4_mul(va2, vb1));
                c22 = f32x4_add(c22, f32x4_mul(va2, vb2));
                c23 = f32x4_add(c23, f32x4_mul(va2, vb3));
                c30 = f32x4_add(c30, f32x4_mul(va3, vb0));
                c31 = f32x4_add(c31, f32x4_mul(va3, vb1));
                c32 = f32x4_add(c32, f32x4_mul(va3, vb2));
                c33 = f32x4_add(c33, f32x4_mul(va3, vb3));
                p += 4;
            }
            let mut r = [
                [hsum(c00), hsum(c01), hsum(c02), hsum(c03)],
                [hsum(c10), hsum(c11), hsum(c12), hsum(c13)],
                [hsum(c20), hsum(c21), hsum(c22), hsum(c23)],
                [hsum(c30), hsum(c31), hsum(c32), hsum(c33)],
            ];
            while p < k {
                let av = [*a0.add(p), *a1.add(p), *a2.add(p), *a3.add(p)];
                let bv = [*b0.add(p), *b1.add(p), *b2.add(p), *b3.add(p)];
                for (ri, row) in r.iter_mut().enumerate() {
                    for (ci, cell) in row.iter_mut().enumerate() {
                        *cell += av[ri] * bv[ci];
                    }
                }
                p += 1;
            }
            for (ri, row) in r.iter().enumerate() {
                for (ci, cell) in row.iter().enumerate() {
                    let bb = match bias {
                        Some(bs) => bs[j + ci],
                        None => 0.0,
                    };
                    *c.add((i + ri) * ldc + j + ci) = *cell + bb;
                }
            }
            j += 4;
        }
        while j < n {
            for ri in 0..4 {
                let v = dot(a.add((i + ri) * lda), b.add(j * ldb), k);
                let bb = match bias {
                    Some(bs) => bs[j],
                    None => 0.0,
                };
                *c.add((i + ri) * ldc + j) = v + bb;
            }
            j += 1;
        }
        i += 4;
    }
    while i < m {
        for j in 0..n {
            let v = dot(a.add(i * lda), b.add(j * ldb), k);
            let bb = match bias {
                Some(bs) => bs[j],
                None => 0.0,
            };
            *c.add(i * ldc + j) = v + bb;
        }
        i += 1;
    }
}

#[inline(always)]
unsafe fn dot(a: *const f32, b: *const f32, k: usize) -> f32 {
    let mut acc = f32x4_splat(0.0);
    let mut p = 0;
    while p + 4 <= k {
        acc = f32x4_add(
            acc,
            f32x4_mul(v128_load(a.add(p) as *const v128), v128_load(b.add(p) as *const v128)),
        );
        p += 4;
    }
    let mut s = hsum(acc);
    while p < k {
        s += *a.add(p) * *b.add(p);
        p += 1;
    }
    s
}

/// y = LayerNorm(x + r) in place into x (r may be None)
unsafe fn add_layer_norm(x: &mut [f32], r: Option<&[f32]>, t: usize, g: &[f32], b: &[f32]) {
    for row in 0..t {
        let xr = &mut x[row * H..(row + 1) * H];
        if let Some(rr) = r {
            let rr = &rr[row * H..(row + 1) * H];
            for i in 0..H {
                xr[i] += rr[i];
            }
        }
        let mut mean = 0.0f32;
        for v in xr.iter() {
            mean += *v;
        }
        mean /= H as f32;
        let mut var = 0.0f32;
        for v in xr.iter() {
            let d = *v - mean;
            var += d * d;
        }
        var /= H as f32;
        let inv = 1.0 / sqrtf(var + LN_EPS);
        for i in 0..H {
            let s = inv * g[i];
            xr[i] = xr[i] * s + (b[i] - mean * s);
        }
    }
}

#[inline(always)]
fn sqrtf(x: f32) -> f32 {
    f32x4_extract_lane::<0>(f32x4_sqrt(f32x4_splat(x)))
}

fn expf(x: f32) -> f32 {
    exp64(x as f64) as f32
}

fn tanhf(x: f32) -> f32 {
    if x > 20.0 {
        return 1.0;
    }
    if x < -20.0 {
        return -1.0;
    }
    // Computed in f64 so the cancellation in (e - 1) is harmless
    let e = exp64(2.0 * x as f64);
    ((e - 1.0) / (e + 1.0)) as f32
}

/// exp(x) in f64 (no libm in no_std): range reduction + degree-13 Taylor.
fn exp64(x: f64) -> f64 {
    if x < -700.0 {
        return 0.0;
    }
    if x > 700.0 {
        return f64::INFINITY;
    }
    const LN2: f64 = core::f64::consts::LN_2;
    let kf = x / LN2;
    let k = if kf >= 0.0 { (kf + 0.5) as i64 } else { (kf - 0.5) as i64 };
    let r = x - (k as f64) * LN2;
    let mut term = 1.0f64;
    let mut sum = 1.0f64;
    let mut i = 1.0f64;
    while i < 14.0 {
        term *= r / i;
        sum += term;
        i += 1.0;
    }
    sum * f64::from_bits(((k + 1023) as u64) << 52)
}

#[inline(always)]
fn gelu(x: f32) -> f32 {
    0.5 * x * (1.0 + tanhf(0.797_884_6 * (x + 0.044_715 * x * x * x)))
}

/// Run the encoder on `t` tokens whose word embeddings the host wrote at
/// `input_ptr()` (t rows of 256 floats). Writes the 256-d L2-normalised
/// sentence embedding to `out`. Returns 0 on success.
#[no_mangle]
pub unsafe extern "C" fn embed(t: usize, out: *mut f32) -> i32 {
    if WEIGHTS.is_null() || t == 0 || t > MAX_T {
        return -1;
    }
    let s = (*core::ptr::addr_of_mut!(SCRATCH)).as_mut().unwrap();
    let mut w = W { p: WEIGHTS };
    let tt0 = w.take(H);
    let pos = w.take(MAX_T * H);
    let emb_g = w.take(H);
    let emb_b = w.take(H);

    let x = &mut s.x[..t * H];
    for row in 0..t {
        for i in 0..H {
            x[row * H + i] = (x[row * H + i] + tt0[i]) + pos[row * H + i];
        }
    }
    add_layer_norm(x, None, t, emb_g, emb_b);

    for _layer in 0..LAYERS {
        let q_w = w.take(H * H);
        let q_b = w.take(H);
        let k_w = w.take(H * H);
        let k_b = w.take(H);
        let v_w = w.take(H * H);
        let v_b = w.take(H);
        let ao_w = w.take(H * H);
        let ao_b = w.take(H);
        let ao_g = w.take(H);
        let ao_bb = w.take(H);
        let i_w = w.take(FF * H);
        let i_b = w.take(FF);
        let o_w = w.take(H * FF);
        let o_b = w.take(H);
        let o_g = w.take(H);
        let o_bb = w.take(H);

        let xp = s.x.as_ptr();
        gemm_nt(xp, H, q_w.as_ptr(), H, s.q.as_mut_ptr(), H, t, H, H, Some(q_b));
        gemm_nt(xp, H, k_w.as_ptr(), H, s.k.as_mut_ptr(), H, t, H, H, Some(k_b));
        gemm_nt(xp, H, v_w.as_ptr(), H, s.v.as_mut_ptr(), H, t, H, H, Some(v_b));

        for h in 0..HEADS {
            let off = h * HD;
            // scores = Q_h K_h^T
            gemm_nt(
                s.q.as_ptr().add(off),
                H,
                s.k.as_ptr().add(off),
                H,
                s.scores.as_mut_ptr(),
                t,
                t,
                t,
                HD,
                None,
            );
            for row in 0..t {
                let sr = &mut s.scores[row * t..(row + 1) * t];
                let mut mx = f32::NEG_INFINITY;
                for v in sr.iter_mut() {
                    *v *= ATT_SCALE;
                    if *v > mx {
                        mx = *v;
                    }
                }
                let mut sum = 0.0f32;
                for v in sr.iter_mut() {
                    *v = expf(*v - mx);
                    sum += *v;
                }
                let inv = 1.0 / sum;
                for v in sr.iter_mut() {
                    *v *= inv;
                }
            }
            // vt = V_h^T  (HD x t)
            for row in 0..t {
                for d in 0..HD {
                    s.vt[d * t + row] = s.v[row * H + off + d];
                }
            }
            // ctx_h = P · V_h
            gemm_nt(
                s.scores.as_ptr(),
                t,
                s.vt.as_ptr(),
                t,
                s.ctx.as_mut_ptr().add(off),
                H,
                t,
                HD,
                t,
                None,
            );
        }
        gemm_nt(s.ctx.as_ptr(), H, ao_w.as_ptr(), H, s.tmp.as_mut_ptr(), H, t, H, H, Some(ao_b));
        add_layer_norm(&mut s.x[..t * H], Some(&s.tmp[..t * H]), t, ao_g, ao_bb);

        gemm_nt(s.x.as_ptr(), H, i_w.as_ptr(), H, s.ff.as_mut_ptr(), FF, t, FF, H, Some(i_b));
        for v in s.ff[..t * FF].iter_mut() {
            *v = gelu(*v);
        }
        gemm_nt(s.ff.as_ptr(), FF, o_w.as_ptr(), FF, s.tmp.as_mut_ptr(), H, t, H, FF, Some(o_b));
        add_layer_norm(&mut s.x[..t * H], Some(&s.tmp[..t * H]), t, o_g, o_bb);
    }

    let pool_w = w.take(H * H);
    let pool_b = w.take(H);
    let mut pooled = [0.0f32; H];
    for (j, p) in pooled.iter_mut().enumerate() {
        *p = gelu(dot(s.x.as_ptr(), pool_w.as_ptr().add(j * H), H) + pool_b[j]);
    }
    let mut ss = 0.0f32;
    for p in pooled.iter() {
        ss += p * p;
    }
    let inv = 1.0 / sqrtf(if ss > 1e-12 { ss } else { 1e-12 });
    for (j, p) in pooled.iter().enumerate() {
        *out.add(j) = p * inv;
    }
    0
}

/// Score `n` int8-quantised vectors (256 dims each, contiguous) against an
/// int16-quantised query. score[i] = (v_i · q) * scales[i] * q_scale
#[no_mangle]
pub unsafe extern "C" fn scan_i8(
    vecs: *const i8,
    scales: *const f32,
    n: usize,
    q: *const i16,
    q_scale: f32,
    out: *mut f32,
) {
    let mut qv = [i16x8_splat(0); H / 8];
    for (i, slot) in qv.iter_mut().enumerate() {
        *slot = v128_load(q.add(i * 8) as *const v128);
    }
    for i in 0..n {
        let base = vecs.add(i * H);
        let mut acc = i32x4_splat(0);
        let mut c = 0;
        while c < H / 16 {
            let v = v128_load(base.add(c * 16) as *const v128);
            let lo = i16x8_extend_low_i8x16(v);
            let hi = i16x8_extend_high_i8x16(v);
            acc = i32x4_add(acc, i32x4_dot_i16x8(lo, qv[c * 2]));
            acc = i32x4_add(acc, i32x4_dot_i16x8(hi, qv[c * 2 + 1]));
            c += 1;
        }
        let sum = i32x4_extract_lane::<0>(acc)
            + i32x4_extract_lane::<1>(acc)
            + i32x4_extract_lane::<2>(acc)
            + i32x4_extract_lane::<3>(acc);
        *out.add(i) = (sum as f32) * *scales.add(i) * q_scale;
    }
}
