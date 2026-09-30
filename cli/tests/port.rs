//! The Rust ports must produce exactly what the plugin's JavaScript produces
//! (fixtures written by node from addon/content/lib). Needs the tokenizer file
//! built by tools/quantize_encoder.py in ../.models (or XLMR_DIR).
use semsearch_index::{text, xlmr::XlmrTokenizer};
use std::path::PathBuf;

fn tokenizer() -> Option<XlmrTokenizer> {
    let dir = std::env::var("XLMR_DIR").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("../.models"));
    let path = dir.join("xlmr-tokenizer.json");
    if !path.exists() {
        eprintln!("skipped: {} not found", path.display());
        return None;
    }
    Some(XlmrTokenizer::from_file(&path).unwrap())
}

fn fixture(name: &str) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(if name == "chunks.json" { format!("tests/fixtures/{name}") } else { format!("../test/fixtures/{name}") }).unwrap()).unwrap()
}

#[test]
fn tokenizer_matches_hugging_face() {
    let Some(tok) = tokenizer() else { return };
    let o = fixture("xlmr-tokenizer-oracle.json");
    let texts = o["texts"].as_array().unwrap();
    let ids = o["ids"].as_array().unwrap();
    let mut bad = 0;
    for (t, want) in texts.iter().zip(ids) {
        let want: Vec<u32> = want.as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
        if tok.encode(t.as_str().unwrap(), 512) != want {
            bad += 1;
            eprintln!("mismatch: {}", &t.as_str().unwrap().chars().take(80).collect::<String>());
        }
    }
    assert_eq!(bad, 0, "{bad} of {} texts differ", texts.len());
}

#[test]
fn chunks_match_the_plugin() {
    let Some(tok) = tokenizer() else { return };
    let cases = fixture("chunks.json");
    for (n, case) in cases.as_array().unwrap().iter().enumerate() {
        let pages: Vec<String> = case["pages"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect();
        let want: Vec<text::Chunk> = serde_json::from_value(case["chunks"].clone()).unwrap();
        let got = text::chunk_pages(&pages, &tok, 160);
        assert_eq!(got.len(), want.len(), "case {n}: number of chunks");
        for (i, (g, w)) in got.iter().zip(&want).enumerate() {
            assert_eq!(g, w, "case {n}, chunk {i}");
        }
    }
}
