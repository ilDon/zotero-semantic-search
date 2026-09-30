//! XLM-R SentencePiece tokenizer: a port of addon/content/lib/xlmr.js (which
//! reproduces the Hugging Face `tokenizers` pipeline of multilingual-e5):
//! Precompiled (nmt_nfkc) normalisation grapheme by grapheme, whitespace split
//! with the "▁" prefix, Unigram Viterbi with fused unknowns, <s> … </s>.

use anyhow::{bail, Context, Result};
use base64::Engine;
use serde::Deserialize;
use std::collections::HashMap;
use unicode_segmentation::UnicodeSegmentation;

const SPACE: char = '\u{2581}';
const UNK_PENALTY: f64 = 10.0;

#[derive(Deserialize)]
struct TokenizerFile {
    pieces: Vec<String>,
    scores: Vec<f64>,
    unk_id: u32,
    bos_id: u32,
    eos_id: u32,
    charsmap: String,
}

/// darts-clone double array + NUL-terminated replacement strings
struct CharsMap {
    units: Vec<u32>,
    normalized: Vec<u8>,
}

impl CharsMap {
    fn new(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 4 {
            bail!("invalid charsmap");
        }
        let size = u32::from_le_bytes(bytes[0..4].try_into()?) as usize;
        let trie = &bytes[4..4 + size];
        let units = trie.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        Ok(CharsMap { units, normalized: bytes[4 + size..].to_vec() })
    }

    /// Value of the shortest key that is a prefix of `bytes` (like spm_precompiled)
    fn first_prefix(&self, bytes: &[u8]) -> Option<usize> {
        let u = &self.units;
        let offset = |unit: u32| (unit >> 10) << ((unit & 512) >> 6);
        let mut pos = offset(u[0]) as usize;
        for &c in bytes {
            pos ^= c as usize;
            let unit = *u.get(pos)?;
            if (unit & 0x8000_00FF) != c as u32 {
                return None;
            }
            pos ^= offset(unit) as usize;
            if (unit >> 8) & 1 == 1 {
                return Some((u[pos] & 0x7FFF_FFFF) as usize);
            }
        }
        None
    }

    fn transform(&self, chunk: &str) -> Option<&str> {
        let v = self.first_prefix(chunk.as_bytes())?;
        let end = self.normalized[v..].iter().position(|&b| b == 0).map(|p| v + p).unwrap_or(self.normalized.len());
        std::str::from_utf8(&self.normalized[v..end]).ok()
    }
}

pub struct XlmrTokenizer {
    ids: HashMap<String, u32>,
    scores: Vec<f64>,
    max_piece_chars: usize,
    unk_id: u32,
    pub bos_id: u32,
    pub eos_id: u32,
    unk_score: f64,
    charsmap: CharsMap,
    special: Vec<(&'static str, u32)>,
    cache: std::cell::RefCell<HashMap<String, Vec<u32>>>,
}

impl XlmrTokenizer {
    pub fn from_file(path: &std::path::Path) -> Result<Self> {
        let data: TokenizerFile =
            serde_json::from_slice(&std::fs::read(path).with_context(|| format!("reading {}", path.display()))?)?;
        let charsmap = CharsMap::new(&base64::engine::general_purpose::STANDARD.decode(&data.charsmap)?)?;
        let mut ids = HashMap::with_capacity(data.pieces.len());
        let mut max_piece_chars = 0;
        let mut min_score = f64::INFINITY;
        for (i, p) in data.pieces.iter().enumerate() {
            ids.entry(p.clone()).or_insert(i as u32);
            max_piece_chars = max_piece_chars.max(p.chars().count());
            min_score = min_score.min(data.scores[i]);
        }
        let mut special = Vec::new();
        for s in ["<s>", "<pad>", "</s>", "<unk>", "<mask>"] {
            if let Some(&id) = ids.get(s) {
                special.push((s, id));
            }
        }
        Ok(XlmrTokenizer {
            ids,
            scores: data.scores,
            max_piece_chars,
            unk_id: data.unk_id,
            bos_id: data.bos_id,
            eos_id: data.eos_id,
            unk_score: min_score - UNK_PENALTY,
            charsmap,
            special,
            cache: std::cell::RefCell::new(HashMap::new()),
        })
    }

    /// Precompiled (nmt_nfkc) normalisation, grapheme by grapheme like HF tokenizers
    pub fn normalize(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        for g in text.graphemes(true) {
            if g.len() < 6 {
                if let Some(r) = self.charsmap.transform(g) {
                    out.push_str(r);
                    continue;
                }
            }
            let mut buf = [0u8; 4];
            for ch in g.chars() {
                let s = ch.encode_utf8(&mut buf);
                match self.charsmap.transform(s) {
                    Some(r) => out.push_str(r),
                    None => out.push(ch),
                }
            }
        }
        out
    }

    /// Unigram Viterbi segmentation of one "▁word"
    fn segment(&self, word: &str) -> Vec<u32> {
        let chars: Vec<char> = word.chars().collect();
        let n = chars.len();
        // byte offsets of each char boundary, to slice the word
        let mut offs = Vec::with_capacity(n + 1);
        let mut o = 0;
        for c in &chars {
            offs.push(o);
            o += c.len_utf8();
        }
        offs.push(o);
        let mut score = vec![f64::NEG_INFINITY; n + 1];
        let mut from = vec![usize::MAX; n + 1];
        let mut tok = vec![u32::MAX; n + 1];
        score[0] = 0.0;
        for i in 0..n {
            if score[i] == f64::NEG_INFINITY {
                continue;
            }
            let base = score[i];
            let mut single = false;
            let limit = n.min(i + self.max_piece_chars);
            for j in i + 1..=limit {
                if let Some(&id) = self.ids.get(&word[offs[i]..offs[j]]) {
                    let cand = base + self.scores[id as usize];
                    if from[j] == usize::MAX || cand > score[j] {
                        score[j] = cand;
                        from[j] = i;
                        tok[j] = id;
                    }
                    if j - i == 1 {
                        single = true;
                    }
                }
            }
            if !single {
                let j = i + 1;
                let cand = base + self.unk_score;
                if from[j] == usize::MAX || cand > score[j] {
                    score[j] = cand;
                    from[j] = i;
                    tok[j] = self.unk_id;
                }
            }
        }
        let mut ids = Vec::new();
        let mut j = n;
        while j > 0 {
            ids.push(tok[j]);
            j = from[j];
        }
        ids.reverse();
        let mut out: Vec<u32> = Vec::with_capacity(ids.len());
        for id in ids {
            if id == self.unk_id && out.last() == Some(&self.unk_id) {
                continue;
            }
            out.push(id);
        }
        out
    }

    fn word(&self, word: &str, out: &mut Vec<u32>) {
        if let Some(ids) = self.cache.borrow().get(word) {
            out.extend_from_slice(ids);
            return;
        }
        let ids = self.segment(word);
        out.extend_from_slice(&ids);
        let mut cache = self.cache.borrow_mut();
        if cache.len() > 200_000 {
            cache.clear();
        }
        cache.insert(word.to_string(), ids);
    }

    fn encode_plain(&self, text: &str, out: &mut Vec<u32>) {
        let norm = self.normalize(text);
        for w in norm.split(' ').filter(|w| !w.is_empty()) {
            let mut s = String::with_capacity(w.len() + 3);
            s.push(SPACE);
            s.push_str(w);
            self.word(&s, out);
        }
    }

    /// <s> ids </s>, at most `max_tokens` in total
    pub fn encode(&self, text: &str, max_tokens: usize) -> Vec<u32> {
        let text = collapse_whitespace(text);
        let mut ids = Vec::new();
        let mut rest: &str = &text;
        loop {
            // next special token, if any
            let next = self
                .special
                .iter()
                .filter_map(|(s, id)| rest.find(s).map(|p| (p, *s, *id)))
                .min_by_key(|(p, _, _)| *p);
            match next {
                Some((p, s, id)) => {
                    self.encode_plain(&rest[..p], &mut ids);
                    ids.push(id);
                    rest = &rest[p + s.len()..];
                }
                None => {
                    self.encode_plain(rest, &mut ids);
                    break;
                }
            }
        }
        ids.truncate(max_tokens.saturating_sub(2));
        let mut out = Vec::with_capacity(ids.len() + 2);
        out.push(self.bos_id);
        out.extend(ids);
        out.push(self.eos_id);
        out
    }

    /// Number of pieces of a fragment of raw text (see chunker)
    pub fn count_pieces(&self, text: &str) -> usize {
        let mut ids = Vec::new();
        self.encode_plain(text, &mut ids);
        ids.len()
    }
}

/// JS `text.replace(/\s+/g, ' ').trim()`
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if is_js_space(c) {
            space = true;
        }
        else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

/// JS `\s`: White_Space plus the BOM
pub fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}
