//! semsearch-index — index a Zotero library for the Semantic Search plugin
//! with multilingual-e5-small on the Apple GPU, while Zotero is closed.
//!
//!   semsearch-index [ZOTERO_DATA_DIR] [--workers N] [--limit N]
//!
//! Reads the PDFs listed in zotero.sqlite, skips those already indexed or
//! excluded, and writes passages to file_embeddings_e5-small.db exactly as the
//! plugin does. Interrupt with Ctrl+C at any time: finished documents are kept.

use anyhow::{bail, Result};
use indicatif::{ProgressBar, ProgressStyle};
use semsearch_index::{cache, model::E5, pdf, store, text, xlmr::XlmrTokenizer, zotero};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const USAGE: &str = "\
semsearch-index — fast indexing for Zotero Semantic Search (Multilingual E5 small, Apple GPU)

Usage: semsearch-index [ZOTERO_DATA_DIR] [options]

  ZOTERO_DATA_DIR     folder with zotero.sqlite (default: the one set in Zotero, or ~/Zotero)

Options:
  --workers N         PDFs read in parallel (default: number of performance cores)
  --limit N           stop after N PDFs
  --timeout S         give up on a PDF after S seconds (default 300)
  --model-dir DIR     folder with e5-small-int8.ssew and xlmr-tokenizer.json
                      (default: the copy downloaded by the plugin in the Zotero profile)
  --profile DIR       Zotero profile folder (default: the one with the plugin's model files)
  --base-dir DIR      base directory of linked files (\"attachments:\" paths)
  --dry-run           only show what would be indexed (writes nothing)
  --version           print the version

Zotero must be closed while this runs.";

struct Args {
    data_dir: Option<PathBuf>,
    workers: Option<usize>,
    limit: Option<usize>,
    timeout: u64,
    model_dir: Option<PathBuf>,
    profile: Option<PathBuf>,
    base_dir: Option<PathBuf>,
    dry_run: bool,
}

fn parse_args() -> Result<Args> {
    let mut a = Args { data_dir: None, workers: None, limit: None, timeout: 300, model_dir: None, profile: None, base_dir: None, dry_run: false };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| anyhow::anyhow!("{name} needs a value"));
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            "--version" => {
                println!("semsearch-index {}", option_env!("SEMSEARCH_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")));
                std::process::exit(0);
            }
            "--dry-run" => a.dry_run = true,
            "--workers" => a.workers = Some(value("--workers")?.parse()?),
            "--limit" => a.limit = Some(value("--limit")?.parse()?),
            "--timeout" => a.timeout = value("--timeout")?.parse()?,
            "--model-dir" => a.model_dir = Some(value("--model-dir")?.into()),
            "--profile" => a.profile = Some(value("--profile")?.into()),
            "--base-dir" => a.base_dir = Some(value("--base-dir")?.into()),
            s if s.starts_with('-') => bail!("unknown option {s}\n\n{USAGE}"),
            s => a.data_dir = Some(PathBuf::from(s)),
        }
    }
    Ok(a)
}

fn performance_cores() -> usize {
    std::process::Command::new("sysctl")
        .args(["-n", "hw.perflevel0.physicalcpu"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(4)
}

/// A document waiting for its passages to be embedded
struct Doc {
    key: String,
    file_name: String,
    chunks: Vec<text::Chunk>,
    ids: Vec<Vec<u32>>,
}

#[derive(Default)]
struct Stats {
    indexed: usize,
    passages: usize,
    no_text: usize,
    encrypted: usize,
    unreadable: usize,
    skipped: usize,
    skipped_files: Vec<String>,
}

/// Embed the passages of several documents together (GPU batches of similar
/// lengths), then write each document
fn flush(
    docs: &mut Vec<Doc>,
    model: &E5,
    conn: &mut rusqlite::Connection,
    stats: &mut Stats,
    bar: &ProgressBar,
    added: &mut cache::NewEntries,
) -> Result<()> {
    const TOKEN_BUDGET: usize = 16384;
    let mut all: Vec<(usize, usize, usize)> = Vec::new(); // (len, doc, chunk)
    for (d, doc) in docs.iter().enumerate() {
        for (c, ids) in doc.ids.iter().enumerate() {
            all.push((ids.len(), d, c));
        }
    }
    all.sort();
    let mut vectors: Vec<Vec<Vec<f32>>> = docs.iter().map(|d| vec![Vec::new(); d.ids.len()]).collect();
    let mut i = 0;
    while i < all.len() {
        // lengths are sorted: the batch's longest is its last
        let mut j = i;
        while j < all.len() && (j - i + 1) * all[j].0 <= TOKEN_BUDGET {
            j += 1;
        }
        let j = j.max(i + 1);
        let batch: Vec<Vec<u32>> = all[i..j].iter().map(|&(_, d, c)| docs[d].ids[c].clone()).collect();
        let out = model.embed(&batch)?;
        for (k, v) in out.into_iter().enumerate() {
            let (_, d, c) = all[i + k];
            vectors[d][c] = v;
        }
        i = j;
    }
    for (doc, vecs) in docs.iter().zip(vectors) {
        let rowids = store::insert_document(conn, &doc.key, &doc.file_name, &doc.chunks, &vecs)?;
        // the cache holds what the plugin would read back from the database (fp16)
        let stored: Vec<Vec<f32>> = vecs.iter().map(|v| v.iter().map(|x| half::f16::from_f32(*x).to_f32()).collect()).collect();
        added.add_document(&doc.key, &doc.file_name, &rowids, &stored);
        stats.indexed += 1;
        stats.passages += doc.chunks.len();
        bar.inc(1);
    }
    docs.clear();
    Ok(())
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let (model_dir, profile) = zotero::model_dir(args.model_dir.clone(), args.profile.clone())?;
    let data_dir = zotero::data_dir(args.data_dir.clone(), profile.as_deref());
    let base_dir = args.base_dir.clone().or_else(|| {
        profile.as_deref().and_then(|p| zotero::pref(p, "extensions.zotero.baseAttachmentPath")).map(PathBuf::from)
    });

    println!("Zotero data:  {}", data_dir.display());
    println!("Model:        Multilingual E5 small ({})", model_dir.display());
    let weights = model_dir.join(zotero::WEIGHTS.0);
    let tok_path = model_dir.join(zotero::TOKENIZER.0);
    zotero::check_sha256(&weights, zotero::WEIGHTS.1)?;
    zotero::check_sha256(&tok_path, zotero::TOKENIZER.1)?;

    // Zotero keeps zotero.sqlite locked while it runs: reading it fails then
    let pdfs = zotero::pdfs(&data_dir, base_dir.as_deref())?;
    let emb_path = data_dir.join("file_embeddings_e5-small.db");
    let user_path = data_dir.join("semantic_search.db");
    let done = if args.dry_run {
        let ro = |p: &std::path::Path| rusqlite::Connection::open_with_flags(p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY);
        match (ro(&emb_path), ro(&user_path)) {
            (Ok(e), Ok(u)) => zotero::done_keys(&e, &u)?,
            _ => Default::default(),
        }
    }
    else {
        zotero::done_keys(&store::open_embeddings(&emb_path)?, &store::open_user(&user_path)?)?
    };
    let total = pdfs.len();
    let mut todo: Vec<zotero::Pdf> = pdfs.into_iter().filter(|p| !done.contains(&p.key)).collect();
    println!("PDFs:         {} to index, {} already indexed or excluded", todo.len(), total - todo.len());
    if let Some(n) = args.limit {
        if n < todo.len() {
            todo.truncate(n);
            println!("              (only the first {n} this time)");
        }
    }
    if todo.is_empty() {
        println!("Nothing to do.");
        return Ok(());
    }
    if args.dry_run {
        println!("Index:        {}", emb_path.display());
        println!("Dry run: nothing written.");
        return Ok(());
    }
    let mut emb = store::open_embeddings(&emb_path)?;
    let user = store::open_user(&user_path)?;

    let dev = candle_core::Device::new_metal(0).map_err(|e| anyhow::anyhow!("no Metal GPU: {e}"))?;
    let tokenizer = XlmrTokenizer::from_file(&tok_path)?;
    let model = E5::load(&weights, &dev)?;
    let workers = args.workers.unwrap_or_else(performance_cores).clamp(1, 32);

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        ctrlc::set_handler(move || {
            if stop.swap(true, Ordering::SeqCst) {
                std::process::exit(130);
            }
            eprintln!("\nStopping after the documents in progress… (Ctrl+C again to quit now)");
        })?;
    }

    let bar = ProgressBar::new(todo.len() as u64);
    bar.set_style(
        ProgressStyle::with_template("{bar:32.cyan/blue} {pos}/{len} PDFs · {msg} · {elapsed} elapsed · ~{eta} left")?
            .progress_chars("█▉▊▋▌▍▎▏ "),
    );
    bar.enable_steady_tick(Duration::from_millis(500));

    let started = Instant::now();
    let paths = todo.iter().map(|p| p.path.clone()).collect();
    let rx = pdf::extract_all(paths, workers, Duration::from_secs(args.timeout), stop.clone());
    let mut stats = Stats::default();
    let mut added = cache::NewEntries::new(zotero::DIM);
    let mut pending: Vec<Doc> = Vec::new();
    let mut pending_passages = 0usize;
    for (i, result) in rx.iter() {
        let pdf = &todo[i];
        match result {
            pdf::Extracted::Pages(pages) => {
                // same rule as the plugin: fewer than 100 non-space characters = no text
                let chars: usize = pages.iter().map(|p| p.chars().filter(|c| !c.is_whitespace()).map(|c| c.len_utf16()).sum::<usize>()).sum();
                let chunks = if chars < 100 { Vec::new() } else { text::chunk_pages(&pages, &tokenizer, zotero::CHUNK_PIECES) };
                if chunks.is_empty() {
                    store::exclude(&user, &pdf.key, "no_text")?;
                    stats.no_text += 1;
                    bar.inc(1);
                }
                else {
                    let ids: Vec<Vec<u32>> = chunks
                        .iter()
                        .map(|c| tokenizer.encode(&format!("{}{}", zotero::PASSAGE_PREFIX, c.text), model.max_tokens))
                        .collect();
                    pending_passages += ids.len();
                    pending.push(Doc { key: pdf.key.clone(), file_name: pdf.file_name.clone(), chunks, ids });
                }
            }
            pdf::Extracted::Encrypted => {
                store::exclude(&user, &pdf.key, "encrypted")?;
                stats.encrypted += 1;
                bar.inc(1);
            }
            pdf::Extracted::Unreadable(_) => {
                store::exclude(&user, &pdf.key, "unreadable")?;
                stats.unreadable += 1;
                bar.inc(1);
            }
            pdf::Extracted::Unavailable(why) | pdf::Extracted::Failed(why) => {
                // not excluded: the plugin (or a later run) will try again
                stats.skipped += 1;
                stats.skipped_files.push(format!("{} ({why})", pdf.path.display()));
                bar.inc(1);
            }
        }
        if pending_passages >= 2048 {
            flush(&mut pending, &model, &mut emb, &mut stats, &bar, &mut added)?;
            pending_passages = 0;
        }
        let secs = started.elapsed().as_secs_f64().max(1.0);
        bar.set_message(format!("{:.0} passages/s", stats.passages as f64 / secs));
        if stop.load(Ordering::Relaxed) {
            break;
        }
    }
    flush(&mut pending, &model, &mut emb, &mut stats, &bar, &mut added)?;
    bar.finish_and_clear();
    drop(emb);
    // Zotero then finds the new passages already in its index cache
    let mut cache_note = None;
    if let (Some(p), false) = (&profile, added.is_empty()) {
        let cache_path = p.join("semantic-search").join(format!("vectors-{}.bin", zotero::MODEL_ID));
        cache_note = match cache::append(&cache_path, &emb_path, &added) {
            Ok(true) => Some("Zotero's index cache updated: Zotero starts with the new passages already loaded.".to_string()),
            Ok(false) => None,
            Err(e) => Some(format!("Could not update Zotero's index cache ({e:#}): Zotero reads the new passages at startup.")),
        };
    }

    let secs = started.elapsed().as_secs_f64();
    let took = if secs < 120.0 { format!("{secs:.0} s") } else { format!("{:.0} min", secs / 60.0) };
    println!(
        "{} PDFs indexed ({} passages, {:.0}/s) in {took}{}",
        stats.indexed,
        stats.passages,
        stats.passages as f64 / secs.max(1.0),
        if stop.load(Ordering::Relaxed) { " — interrupted, run again to continue" } else { "" }
    );
    if stats.no_text + stats.encrypted + stats.unreadable > 0 {
        println!(
            "Excluded: {} without text (scans: OCR them from Zotero), {} encrypted, {} unreadable",
            stats.no_text, stats.encrypted, stats.unreadable
        );
    }
    if stats.skipped > 0 {
        println!("{} PDFs could not be read now (file unavailable, too slow or crashed): they will be retried.", stats.skipped);
        for f in stats.skipped_files.iter().take(5) {
            println!("  {f}");
        }
    }
    if let Some(note) = cache_note {
        println!("{note}");
    }
    println!("Open Zotero: the new passages are picked up automatically.");
    Ok(())
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some(pdf::WORKER_ARG) {
        if let Err(e) = pdf::worker_main() {
            eprintln!("{e:#}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(e) = run() {
        eprintln!("Error: {e:#}");
        std::process::exit(1);
    }
}
