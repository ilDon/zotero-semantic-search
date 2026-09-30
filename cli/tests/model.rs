//! The GPU encoder against PyTorch (fp32 original and the plugin's int8 scheme).
//! Needs ../.models/e5-small-int8.ssew (tools/quantize_encoder.py) and a Metal GPU.
use semsearch_index::model::E5;
use std::path::PathBuf;

fn cos(a: &[f32], b: &[f64]) -> f64 {
    let (mut d, mut na, mut nb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        d += *x as f64 * y;
        na += (*x as f64).powi(2);
        nb += y * y;
    }
    d / (na * nb).sqrt()
}

#[test]
fn encoder_matches_pytorch() {
    let dir = std::env::var("XLMR_DIR").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("../.models"));
    let path = dir.join("e5-small-int8.ssew");
    if !path.exists() {
        eprintln!("skipped: {} not found", path.display());
        return;
    }
    let dev = candle_core::Device::new_metal(0).expect("Metal GPU");
    let model = E5::load(&path, &dev).unwrap();
    let o: serde_json::Value = serde_json::from_slice(&std::fs::read("../test/fixtures/e5-small-oracle.json").unwrap()).unwrap();
    let ids: Vec<Vec<u32>> = o["ids"].as_array().unwrap().iter()
        .map(|v| v.as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u32).collect()).collect();
    // all texts in one padded batch: padding must not change anything
    let got = model.embed(&ids).unwrap();
    for (i, g) in got.iter().enumerate() {
        let fp32: Vec<f64> = o["fp32"][i].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
        let int8: Vec<f64> = o["int8"][i].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
        let (cf, ci) = (cos(g, &fp32), cos(g, &int8));
        eprintln!("#{i}: {} tokens, cos fp32 {cf:.5}, cos plugin-int8 {ci:.5}", ids[i].len());
        assert!(cf > 0.999, "text {i}: cos vs fp32 {cf}");
        assert!(ci > 0.99, "text {i}: cos vs int8 {ci}");
    }
}
