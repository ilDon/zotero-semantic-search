//! Text of PDFs with pdfium, in worker processes (this same executable, run
//! with a hidden argument): several PDFs are read in parallel, and a PDF that
//! crashes or hangs pdfium only costs a worker, which is restarted.
//!
//! Protocol: the parent writes one path per line on the worker's stdin; the
//! worker answers one JSON line per path: {"pages": [...]} or {"error": kind}.

use anyhow::{Context, Result};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

pub const WORKER_ARG: &str = "--pdf-worker";

#[derive(Serialize, Deserialize, Debug)]
pub enum Extracted {
    /// text of each page
    Pages(Vec<String>),
    /// the PDF is protected by a password
    Encrypted,
    /// pdfium could not read it
    Unreadable(String),
    /// the file could not be read from disk (not downloaded yet, removed…): try again later
    Unavailable(String),
    /// the worker took too long or crashed
    Failed(String),
}

/// Library directory of libpdfium.dylib: next to the executable, or PDFIUM_DIR
pub fn pdfium_dir() -> PathBuf {
    if let Ok(d) = std::env::var("PDFIUM_DIR") {
        return PathBuf::from(d);
    }
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default()
}

fn extract(pdfium: &Pdfium, path: &Path) -> Extracted {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return Extracted::Unavailable(e.to_string()),
    };
    let doc = match pdfium.load_pdf_from_byte_vec(bytes, None) {
        Ok(d) => d,
        Err(PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError)) => return Extracted::Encrypted,
        Err(e) => return Extracted::Unreadable(format!("{e:?}")),
    };
    let mut pages = Vec::new();
    for page in doc.pages().iter() {
        match page.text() {
            // pdfium marks a hyphen at the end of a line as U+0002: give it back as
            // pdf.js (Zotero) has it, "-\n", so words are joined the same way
            Ok(t) => pages.push(t.all().replace('\u{2}', "-\n")),
            Err(_) => pages.push(String::new()),
        }
    }
    Extracted::Pages(pages)
}

/// Entry point of a worker process
pub fn worker_main() -> Result<()> {
    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&pdfium_dir()))
        .map_err(|e| anyhow::anyhow!("cannot load libpdfium.dylib: {e:?}"))?;
    let pdfium = Pdfium::new(bindings);
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        let result = extract(&pdfium, Path::new(&line));
        serde_json::to_writer(&mut out, &result)?;
        out.write_all(b"\n")?;
        out.flush()?;
    }
    Ok(())
}

struct Worker {
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<String>,
}

impl Worker {
    fn spawn() -> Result<Self> {
        let exe = std::env::current_exe()?;
        let mut child = Command::new(exe)
            .arg(WORKER_ARG)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("starting a PDF worker")?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Worker { child, stdin, rx })
    }

    fn run(&mut self, path: &Path, timeout: Duration) -> Result<Extracted, String> {
        writeln!(self.stdin, "{}", path.display()).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        match self.rx.recv_timeout(timeout) {
            Ok(line) => serde_json::from_str(&line).map_err(|e| e.to_string()),
            Err(mpsc::RecvTimeoutError::Timeout) => Err("timed out".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("crashed".into()),
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Extract the PDFs of `jobs` with `n` parallel workers; results arrive on the
/// returned channel as (job index, result), in completion order.
pub fn extract_all(jobs: Vec<PathBuf>, n: usize, timeout: Duration, stop: std::sync::Arc<std::sync::atomic::AtomicBool>)
    -> mpsc::Receiver<(usize, Extracted)> {
    let (tx, rx) = mpsc::sync_channel(n * 2);
    let queue = std::sync::Arc::new(std::sync::Mutex::new(jobs.into_iter().enumerate().collect::<std::collections::VecDeque<_>>()));
    for _ in 0..n {
        let queue = queue.clone();
        let tx = tx.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut worker: Option<Worker> = None;
            loop {
                if stop.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                let Some((i, path)) = queue.lock().unwrap().pop_front() else { break };
                if worker.is_none() {
                    match Worker::spawn() {
                        Ok(w) => worker = Some(w),
                        Err(e) => {
                            let _ = tx.send((i, Extracted::Failed(e.to_string())));
                            continue;
                        }
                    }
                }
                let result = match worker.as_mut().unwrap().run(&path, timeout) {
                    Ok(r) => r,
                    Err(e) => {
                        worker = None; // killed on drop, restarted for the next PDF
                        Extracted::Failed(e)
                    }
                };
                if tx.send((i, result)).is_err() {
                    break;
                }
            }
        });
    }
    rx
}
