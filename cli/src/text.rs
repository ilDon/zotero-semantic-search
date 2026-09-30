//! Passage chunking: a port of the word split of addon/content/lib/tokenizer.js
//! (splitWords) and of addon/content/lib/chunker.js, so that passages are cut
//! exactly where the plugin would cut them. Offsets are in UTF-16 code units,
//! like JavaScript string indices (char_start is stored in the database).

use crate::xlmr::XlmrTokenizer;
use regex::Regex;
use std::sync::OnceLock;
use unicode_general_category::{get_general_category, GeneralCategory as GC};
use unicode_script::{Script, UnicodeScript};

fn emoji_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\x{203c}\x{2049}\x{2139}\x{2194}-\x{2199}\x{21a9}\x{21aa}\x{231a}\x{231b}\x{2328}\x{23cf}\x{23e9}-\x{23f3}\x{23f8}-\x{23fa}\x{24c2}\x{25aa}\x{25ab}\x{25b6}\x{25c0}\x{25fb}-\x{25fe}\x{2600}-\x{26ff}\x{2702}\x{2705}\x{2708}-\x{270d}\x{270f}\x{2712}\x{2714}\x{2716}\x{271d}\x{2721}\x{2728}\x{2733}\x{2734}\x{2744}\x{2747}\x{274c}\x{274e}\x{2753}-\x{2755}\x{2757}\x{2763}\x{2764}\x{2795}-\x{2797}\x{2934}\x{2935}\x{2b05}-\x{2b07}\x{2b1b}\x{2b1c}\x{2b50}\x{2b55}\x{3030}\x{303d}\x{3297}\x{3299}\x{1f004}\x{1f0cf}\x{1f170}\x{1f171}\x{1f17e}\x{1f17f}\x{1f18e}\x{1f191}-\x{1f19a}\x{1f1e6}-\x{1f1ff}\x{1f201}\x{1f202}\x{1f21a}\x{1f22f}\x{1f232}-\x{1f23a}\x{1f250}\x{1f251}\x{1f300}-\x{1f6ff}\x{1f900}-\x{1f9ff}\x{1fa70}-\x{1fa74}\x{1fa78}-\x{1fa7a}\x{1fa80}-\x{1fa86}\x{1fa90}-\x{1faa8}\x{1fab0}-\x{1fab6}\x{1fac0}-\x{1fac2}\x{1fad0}-\x{1fad6}]").unwrap())
}

fn is_control_or_format(c: char) -> bool {
    matches!(get_general_category(c), GC::Control | GC::Format)
}

fn is_punct_or_symbol(c: char) -> bool {
    matches!(
        get_general_category(c),
        GC::ConnectorPunctuation
            | GC::DashPunctuation
            | GC::OpenPunctuation
            | GC::ClosePunctuation
            | GC::InitialPunctuation
            | GC::FinalPunctuation
            | GC::OtherPunctuation
            | GC::MathSymbol
            | GC::CurrencySymbol
            | GC::ModifierSymbol
            | GC::OtherSymbol
    ) || c == '|'
}

/// Script class of a character: whitespace is Common (it breaks runs) but flagged
#[derive(PartialEq, Clone, Copy)]
enum Class {
    Space,
    Script(Script),
}

fn class_of(c: char) -> Class {
    if c.is_whitespace() {
        Class::Space
    }
    else {
        Class::Script(c.script())
    }
}

fn should_split_chars(word: &[char]) -> bool {
    let s: String = word.iter().collect();
    word[0].script() == Script::Han || emoji_re().is_match(&s) || word.iter().all(|&c| is_punct_or_symbol(c))
}

/// A page of text as chars, with UTF-16 offsets
struct Page {
    chars: Vec<char>,
    u16: Vec<usize>, // UTF-16 offset of each char, plus the total length
}

impl Page {
    fn new(text: &str) -> Self {
        let chars: Vec<char> = text.chars().collect();
        let mut u16 = Vec::with_capacity(chars.len() + 1);
        let mut o = 0;
        for c in &chars {
            u16.push(o);
            o += c.len_utf16();
        }
        u16.push(o);
        Page { chars, u16 }
    }

    fn slice(&self, from: usize, to: usize) -> String {
        self.chars[from..to].iter().collect()
    }
}

/// A word of the ICU UnicodeScriptTokenizer split, as char indices into the page
struct Word {
    start: usize,
    end: usize,
}

/// splitWords() of tokenizer.js
fn split_words(p: &Page) -> Vec<Word> {
    let mut words = Vec::new();
    let text = &p.chars;
    let mut cur: Vec<char> = Vec::new();
    let mut cur_start = 0usize;
    let mut cur_end = 0usize;
    let mut cur_script: Option<Class> = None;
    let flush = |cur: &mut Vec<char>, cur_start: usize, cur_end: usize, words: &mut Vec<Word>| {
        if !cur.is_empty() {
            if should_split_chars(cur) {
                // like JS: each char located with indexOf from the previous one
                let mut pos = cur_start;
                for &ch in cur.iter() {
                    let at = text[pos.min(text.len())..].iter().position(|&c| c == ch).map(|i| i + pos);
                    let s = at.unwrap_or(pos);
                    words.push(Word { start: s, end: s + 1 });
                    pos = s + 1;
                }
            }
            else {
                words.push(Word { start: cur_start, end: cur_end });
            }
        }
        cur.clear();
    };
    for (i, &c) in text.iter().enumerate() {
        if is_control_or_format(c) {
            continue;
        }
        let cls = class_of(c);
        let script = if cls == Class::Space { Class::Script(Script::Common) } else { cls };
        if cur_script.is_some() && cur_script != Some(script) {
            flush(&mut cur, cur_start, cur_end, &mut words);
        }
        cur_script = Some(script);
        if cls != Class::Space {
            if cur.is_empty() {
                cur_start = i;
            }
            cur.push(c);
            cur_end = i + 1;
        }
    }
    flush(&mut cur, cur_start, cur_end, &mut words);
    words
}

/// normalizePage() of chunker.js: join hyphenated line breaks, collapse whitespace
pub fn normalize_page(text: &str) -> String {
    static HYPHEN: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    let hyphen = HYPHEN.get_or_init(|| Regex::new(r"(\p{L})[-\x{ad}]\s*\n\s*(\p{Ll})").unwrap());
    let spaces = SPACES.get_or_init(|| Regex::new(r"[\p{Cc}\p{Cf}\s\x{feff}]+").unwrap());
    let joined = hyphen.replace_all(text, "$1$2");
    let collapsed = spaces.replace_all(&joined, " ");
    collapsed.trim_matches(|c: char| crate::xlmr::is_js_space(c)).to_string()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Chunk {
    pub text: String,
    pub page: usize,
    #[serde(rename = "charStart")]
    pub char_start: usize,
    pub pieces: usize,
}

struct WordInfo {
    page: usize,
    start: usize, // char index in the page
    end: usize,
    doc_start: usize, // UTF-16 offset in the pages joined with "\n"
    pieces: usize,
    sentence_end: bool,
}

fn sentence_end_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[.!?;:\x{2026}\x{bb}\x{201d})\]]$").unwrap())
}

/// chunkPages() of chunker.js with an XLM-R tokenizer
pub fn chunk_pages(pages: &[String], tok: &XlmrTokenizer, max_pieces: usize) -> Vec<Chunk> {
    let min_cut = (max_pieces as f64 * 0.6).floor() as usize;
    let min_chunk = 12usize;
    let norm: Vec<Page> = pages.iter().map(|p| Page::new(&normalize_page(p))).collect();
    let mut words: Vec<WordInfo> = Vec::new();
    let mut doc_offset = 0usize;
    for (pi, page) in norm.iter().enumerate() {
        for w in split_words(page) {
            let raw = page.slice(w.start, w.end);
            words.push(WordInfo {
                page: pi,
                start: w.start,
                end: w.end,
                doc_start: doc_offset + page.u16[w.start],
                pieces: tok.count_pieces(&raw),
                sentence_end: sentence_end_re().is_match(&raw),
            });
        }
        doc_offset += page.u16[page.chars.len()] + 1;
    }

    let mut chunks: Vec<Chunk> = Vec::new();
    let emit = |from: usize, to: usize, chunks: &mut Vec<Chunk>| {
        if to <= from {
            return;
        }
        let pieces = words[from..to].iter().map(|w| w.pieces).sum();
        let mut parts = Vec::new();
        let mut i = from;
        while i < to {
            let page = words[i].page;
            let mut j = i;
            while j + 1 < to && words[j + 1].page == page {
                j += 1;
            }
            parts.push(norm[page].slice(words[i].start, words[j].end));
            i = j + 1;
        }
        chunks.push(Chunk { text: parts.join(" "), page: words[from].page, char_start: words[from].doc_start, pieces });
    };

    let mut start = 0usize;
    let mut count = 0usize;
    let mut last_sentence_cut: Option<usize> = None;
    let mut count_at_cut = 0usize;
    for i in 0..words.len() {
        let w = &words[i];
        if count > 0 && count + w.pieces > max_pieces {
            let mut cut = i;
            if let Some(lc) = last_sentence_cut {
                if lc > start && count_at_cut >= min_cut {
                    cut = lc;
                }
            }
            emit(start, cut, &mut chunks);
            start = cut;
            count = words[start..i].iter().map(|w| w.pieces).sum();
            last_sentence_cut = None;
            count_at_cut = 0;
        }
        count += w.pieces;
        if w.sentence_end {
            last_sentence_cut = Some(i + 1);
            count_at_cut = count;
        }
    }
    if start < words.len() {
        if count < min_chunk && !chunks.is_empty() {
            let prev = chunks.last().unwrap().clone();
            if prev.pieces + count <= max_pieces {
                chunks.pop();
                let mut from = start;
                while from > 0 && words[from - 1].doc_start >= prev.char_start {
                    from -= 1;
                }
                emit(from, words.len(), &mut chunks);
                return chunks;
            }
        }
        emit(start, words.len(), &mut chunks);
    }
    chunks
}
