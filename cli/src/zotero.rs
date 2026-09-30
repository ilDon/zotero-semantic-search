//! The Zotero side: where things are, which PDFs exist, which are done.

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Weight and tokenizer files of multilingual-e5-small, as published for the plugin
pub const WEIGHTS: (&str, &str) = ("e5-small-int8.ssew", "dd9c8cf3fe407a23e22e0e210b57d3b0e025ecfc49d2da178064b365d53b62d2");
pub const TOKENIZER: (&str, &str) = ("xlmr-tokenizer.json", "16241a4a586b34ed74689274cd501978b04f8a512308a05f2b10953ea8d92045");
pub const MODEL_ID: &str = "e5-small";
pub const DIM: usize = 384;
pub const PASSAGE_PREFIX: &str = "passage: ";
pub const CHUNK_PIECES: usize = 160;

pub struct Pdf {
    pub key: String,
    pub path: PathBuf,
    pub file_name: String,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

/// Zotero profile directories (macOS)
pub fn profiles() -> Vec<PathBuf> {
    let dir = home().join("Library/Application Support/Zotero/Profiles");
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|it| it.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// A user_pref("name", "value") string value from a profile's prefs.js
pub fn pref(profile: &Path, name: &str) -> Option<String> {
    let text = std::fs::read_to_string(profile.join("prefs.js")).ok()?;
    let needle = format!("user_pref(\"{name}\", \"");
    let start = text.find(&needle)? + needle.len();
    let end = text[start..].find("\");")? + start;
    Some(text[start..end].replace("\\\\", "\\").replace("\\\"", "\""))
}

/// The Zotero data directory: given, from the profile, or ~/Zotero
pub fn data_dir(given: Option<PathBuf>, profile: Option<&Path>) -> PathBuf {
    if let Some(d) = given {
        return d;
    }
    if let Some(d) = profile.and_then(|p| pref(p, "extensions.zotero.dataDir")) {
        return PathBuf::from(d);
    }
    home().join("Zotero")
}

/// Directory with the model files: given, or the plugin's copy in a Zotero profile
pub fn model_dir(given: Option<PathBuf>, profile: Option<PathBuf>) -> Result<(PathBuf, Option<PathBuf>)> {
    if let Some(d) = given {
        // …/<profile>/semantic-search/models/e5-small: that profile
        let from_dir = d.ancestors().nth(3).filter(|p| p.join("prefs.js").exists()).map(|p| p.to_path_buf());
        return Ok((d.clone(), profile.or(from_dir)));
    }
    let candidates = match profile {
        Some(p) => vec![p],
        None => profiles(),
    };
    for p in candidates {
        let d = p.join("semantic-search/models").join(MODEL_ID);
        if d.join(WEIGHTS.0).exists() && d.join(TOKENIZER.0).exists() {
            return Ok((d, Some(p)));
        }
    }
    bail!(
        "The {} model files were not found in a Zotero profile.\n\
         Select \"Multilingual E5 small\" in Zotero → Settings → Semantic Search once (it downloads them), \
         or pass --model-dir.",
        MODEL_ID
    )
}

pub fn check_sha256(path: &Path, want: &str) -> Result<()> {
    let mut f = std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h)?;
    let got = format!("{:x}", h.finalize());
    if got != want {
        bail!("{} is not the expected file (sha256 {got})", path.display());
    }
    Ok(())
}

/// All PDF attachments of the library that are not in the trash
pub fn pdfs(data_dir: &Path, base_dir: Option<&Path>) -> Result<Vec<Pdf>> {
    let db = data_dir.join("zotero.sqlite");
    if !db.exists() {
        bail!("{} not found: is this the Zotero data directory?", db.display());
    }
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let mut stmt = conn
        .prepare(
            "SELECT I.key, IA.path, IA.linkMode FROM itemAttachments IA JOIN items I USING (itemID)
             WHERE IA.contentType = 'application/pdf' AND IA.linkMode != 3
             AND IA.itemID NOT IN (SELECT itemID FROM deletedItems)",
        )
        .map_err(|e| {
            if e.to_string().contains("locked") {
                anyhow::anyhow!("zotero.sqlite is locked: close Zotero first (the plugin would also index the same PDFs)")
            }
            else {
                e.into()
            }
        })?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (key, path, _mode) = row.map_err(|e| {
            if e.to_string().contains("locked") {
                anyhow::anyhow!("zotero.sqlite is locked: close Zotero first (the plugin would also index the same PDFs)")
            }
            else {
                e.into()
            }
        })?;
        let Some(path) = path else { continue };
        let full = if let Some(name) = path.strip_prefix("storage:") {
            data_dir.join("storage").join(&key).join(name)
        }
        else if let Some(rel) = path.strip_prefix("attachments:") {
            match base_dir {
                Some(b) => b.join(rel),
                None => continue,
            }
        }
        else {
            PathBuf::from(path)
        };
        let file_name = full.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        out.push(Pdf { key, path: full, file_name });
    }
    Ok(out)
}

/// Keys already indexed with the model, and keys excluded by the user or the plugin
pub fn done_keys(emb: &Connection, user: &Connection) -> Result<HashSet<String>> {
    let mut keys = HashSet::new();
    let mut s = emb.prepare("SELECT DISTINCT id FROM embeddings")?;
    for k in s.query_map([], |r| r.get::<_, String>(0))? {
        keys.insert(k?);
    }
    let mut s = user.prepare("SELECT id FROM excluded")?;
    for k in s.query_map([], |r| r.get::<_, String>(0))? {
        keys.insert(k?);
    }
    Ok(keys)
}
