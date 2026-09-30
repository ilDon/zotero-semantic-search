//! Writing passages and exclusions in the plugin's formats
//! (addon/content/lib/embedding-store.js, store.js).

use crate::text::Chunk;
use crate::zotero::{DIM, MODEL_ID};
use anyhow::{bail, Result};
use half::f16;
use rusqlite::{params, Connection};
use std::path::Path;

pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// file_embeddings_e5-small.db, created like the plugin does if missing
pub fn open_embeddings(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS embeddings (
            id TEXT NOT NULL, date TEXT, file_name TEXT, section_number INTEGER, embedding BLOB,
            scheme INTEGER, chunk_text TEXT, page INTEGER, char_start INTEGER);
         CREATE INDEX IF NOT EXISTS ss_embeddings_id ON embeddings(id);
         CREATE TABLE IF NOT EXISTS ss_model (key TEXT PRIMARY KEY, value TEXT);",
    )?;
    let model: Option<String> = conn.query_row("SELECT value FROM ss_model WHERE key = 'model'", [], |r| r.get(0)).ok();
    match model {
        Some(m) if m != MODEL_ID => bail!("{} belongs to the model {m}, not {MODEL_ID}", path.display()),
        Some(_) => {}
        None => {
            conn.execute(
                "INSERT INTO ss_model (key, value) VALUES ('model', ?1), ('dim', ?2), ('vector', 'f16')",
                params![MODEL_ID, DIM.to_string()],
            )?;
        }
    }
    Ok(conn)
}

/// semantic_search.db (saved searches, exclusions)
pub fn open_user(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS excluded (id TEXT, date TEXT, reason TEXT);
         CREATE INDEX IF NOT EXISTS ss_excluded_id ON excluded(id);",
    )?;
    Ok(conn)
}

/// Replace the passages of one document (one transaction)
pub fn insert_document(conn: &mut Connection, key: &str, file_name: &str, chunks: &[Chunk], vectors: &[Vec<f32>]) -> Result<()> {
    let date = today();
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM embeddings WHERE id = ?1", params![key])?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO embeddings (id, date, file_name, section_number, embedding, scheme, chunk_text, page, char_start)
             VALUES (?1, ?2, ?3, ?4, ?5, 2, ?6, ?7, ?8)",
        )?;
        for (i, (c, v)) in chunks.iter().zip(vectors).enumerate() {
            let mut blob = Vec::with_capacity(v.len() * 2);
            for x in v {
                blob.extend_from_slice(&f16::from_f32(*x).to_le_bytes());
            }
            stmt.execute(params![key, date, file_name, i as i64, blob, c.text, c.page as i64, c.char_start as i64])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Same reasons as the plugin: no_text, encrypted, unreadable
pub fn exclude(conn: &Connection, key: &str, reason: &str) -> Result<()> {
    conn.execute("DELETE FROM excluded WHERE id = ?1", params![key])?;
    conn.execute("INSERT INTO excluded (id, reason, date) VALUES (?1, ?2, ?3)", params![key, reason, today()])?;
    Ok(())
}
