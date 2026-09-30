//! The plugin's vector index cache (profile/semantic-search/vectors-e5-small.bin,
//! see SSVectorIndexImpl in addon/content/lib/vector-index.js): passages added
//! here are appended to it, so Zotero does not have to read them back from the
//! database when it starts.
//!
//! Format (little-endian): "SSVI" | u32 version (1) | u32 n | u32 header length |
//! JSON {dbPath, docs: [[key, fileName]]} | padding to 4 | i32 rowids[n] |
//! i32 docIdx[n] | i32 sections[n] | f32 scales[n] | i8 vectors[n * dim].
//! Vectors are normalised and quantised with one scale each, as in _push().

use anyhow::{bail, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// Passages to add to the cache
#[derive(Default)]
pub struct NewEntries {
    pub dim: usize,
    rowids: Vec<i32>,
    docs: Vec<(String, String)>,
    doc_of: Vec<i32>,
    sections: Vec<i32>,
    scales: Vec<f32>,
    vecs: Vec<i8>,
}

impl NewEntries {
    pub fn new(dim: usize) -> Self {
        NewEntries { dim, ..Default::default() }
    }

    pub fn len(&self) -> usize {
        self.rowids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rowids.is_empty()
    }

    /// One document's passages (vectors as stored in the database)
    pub fn add_document(&mut self, key: &str, file_name: &str, rowids: &[i64], vectors: &[Vec<f32>]) {
        let d = self.docs.len() as i32;
        self.docs.push((key.to_string(), file_name.to_string()));
        for (i, (rowid, v)) in rowids.iter().zip(vectors).enumerate() {
            // same arithmetic as the plugin's _push (JS Math.round)
            let norm = v.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>().sqrt();
            let norm = if norm > 0.0 { norm } else { 1.0 };
            let max = v.iter().map(|x| ((*x as f64) / norm).abs()).fold(0.0, f64::max);
            let scale = if max > 0.0 { max / 127.0 } else { 1e-9 };
            for x in v {
                self.vecs.push(((*x as f64) / norm / scale + 0.5).floor() as i8);
            }
            self.rowids.push(*rowid as i32);
            self.doc_of.push(d);
            self.sections.push(i as i32);
            self.scales.push(scale as f32);
        }
    }
}

fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

/// Append the entries to an existing cache written by the plugin for `db_path`.
/// Returns false (and leaves the file alone) when there is no usable cache:
/// the plugin then reads the new passages from the database.
pub fn append(cache: &Path, db_path: &Path, new: &NewEntries) -> Result<bool> {
    if new.is_empty() || !cache.exists() {
        return Ok(false);
    }
    let bytes = std::fs::read(cache)?;
    if bytes.len() < 16 || &bytes[0..4] != b"SSVI" || u32_at(&bytes, 4) != 1 {
        return Ok(false);
    }
    let n = u32_at(&bytes, 8) as usize;
    let hlen = u32_at(&bytes, 12) as usize;
    let header: Value = serde_json::from_slice(&bytes[16..16 + hlen])?;
    // the plugin only uses a cache made for its own database path
    if header["dbPath"].as_str() != Some(&db_path.to_string_lossy()) {
        return Ok(false);
    }
    let dim = new.dim;
    let off = (16 + hlen + 3) & !3;
    if bytes.len() < off + n * (16 + dim) {
        bail!("{} is truncated", cache.display());
    }
    let mut docs: Vec<(String, String)> = header["docs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|d| (d[0].as_str().unwrap_or("").to_string(), d[1].as_str().unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default();
    let mut index: HashMap<String, i32> = docs.iter().enumerate().map(|(i, d)| (d.0.clone(), i as i32)).collect();
    let mut new_doc = Vec::with_capacity(new.docs.len());
    for (k, f) in &new.docs {
        let i = *index.entry(k.clone()).or_insert_with(|| {
            docs.push((k.clone(), f.clone()));
            (docs.len() - 1) as i32
        });
        new_doc.push(i);
    }
    let total = n + new.len();
    let header = serde_json::to_vec(&serde_json::json!({
        "dbPath": db_path.to_string_lossy(),
        "docs": docs.iter().map(|(k, f)| serde_json::json!([k, f])).collect::<Vec<_>>(),
    }))?;
    let noff = (16 + header.len() + 3) & !3;
    let mut out = Vec::with_capacity(noff + total * (16 + dim));
    out.extend_from_slice(b"SSVI");
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.resize(noff, 0);
    let old = |i: usize, width: usize| &bytes[off + i * n * 4..off + i * n * 4 + n * width];
    // rowids, docIdx, sections: old then new
    out.extend_from_slice(old(0, 4));
    for r in &new.rowids {
        out.extend_from_slice(&r.to_le_bytes());
    }
    out.extend_from_slice(old(1, 4));
    for d in &new.doc_of {
        out.extend_from_slice(&new_doc[*d as usize].to_le_bytes());
    }
    out.extend_from_slice(old(2, 4));
    for s in &new.sections {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out.extend_from_slice(old(3, 4));
    for s in &new.scales {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out.extend_from_slice(&bytes[off + n * 16..off + n * 16 + n * dim]);
    out.extend(new.vecs.iter().map(|v| *v as u8));
    let tmp = cache.with_extension("bin.tmp");
    std::fs::write(&tmp, &out)?;
    std::fs::rename(&tmp, cache)?;
    Ok(true)
}
