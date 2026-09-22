/*
 * Passage chunking for newly indexed documents ("scheme 2").
 *
 * The legacy index cut the text every 2500 characters, but the model only
 * reads the first 128 tokens of its input, so ~80% of every section was never
 * embedded. Scheme 2 cuts the text into passages that fit the 128-token window
 * (preferring sentence boundaries), so the whole document is searchable, and it
 * keeps the passage text and page number for display.
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory(require('./tokenizer.js'));
	}
	else {
		root.SSChunker = factory(root.SSTokenizer);
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Tok) {
	'use strict';

	const SCHEME = 2;
	const DEFAULT_MAX_PIECES = 126; // 128 minus [CLS] and [SEP]
	const SENTENCE_END_RE = /[.!?;:…»”)\]]$/u;

	/** Normalise one page of pdf.js text: join hyphenated line breaks, collapse whitespace */
	function normalizePage(text) {
		return text
			.replace(/(\p{L})[-­]\s*\n\s*(\p{Ll})/gu, '$1$2')
			.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
			.trim();
	}

	/**
	 * @param {string[]} pages - raw page texts
	 * @param {WordPieceTokenizer} tokenizer
	 * @param {Object} [opts]
	 * @returns {{text: string, page: number, charStart: number, pieces: number}[]}
	 *   page is 0-based; charStart is the offset in the concatenation of the
	 *   normalised pages joined with "\n".
	 */
	function chunkPages(pages, tokenizer, opts = {}) {
		const maxPieces = opts.maxPieces || DEFAULT_MAX_PIECES;
		const minCutPieces = opts.minCutPieces || Math.floor(maxPieces * 0.6);
		const minChunkPieces = opts.minChunkPieces || 12;

		// Word stream across pages
		const words = [];
		let docOffset = 0;
		const normPages = pages.map(normalizePage);
		for (let p = 0; p < normPages.length; p++) {
			const text = normPages[p];
			for (const w of Tok.splitWords(text)) {
				words.push({
					page: p,
					start: w.start,
					end: w.end,
					docStart: docOffset + w.start,
					pieces: tokenizer.wordPiece(w.word).length,
					sentenceEnd: SENTENCE_END_RE.test(text.slice(w.start, w.end)),
				});
			}
			docOffset += text.length + 1;
		}

		const chunks = [];
		const emit = (from, to) => {
			// words[from..to) — may span pages; text is taken page by page
			if (to <= from) return;
			let pieces = 0;
			for (let i = from; i < to; i++) pieces += words[i].pieces;
			const parts = [];
			let i = from;
			while (i < to) {
				const page = words[i].page;
				let j = i;
				while (j + 1 < to && words[j + 1].page === page) j++;
				parts.push(normPages[page].slice(words[i].start, words[j].end));
				i = j + 1;
			}
			chunks.push({
				text: parts.join(' '),
				page: words[from].page,
				charStart: words[from].docStart,
				pieces,
			});
		};

		let start = 0;
		let count = 0;
		let lastSentenceCut = -1; // index after a sentence end within the current chunk
		let countAtCut = 0;
		for (let i = 0; i < words.length; i++) {
			const w = words[i];
			if (count > 0 && count + w.pieces > maxPieces) {
				let cut = i;
				if (lastSentenceCut > start && countAtCut >= minCutPieces) cut = lastSentenceCut;
				emit(start, cut);
				start = cut;
				count = 0;
				for (let k = start; k < i; k++) count += words[k].pieces;
				lastSentenceCut = -1;
				countAtCut = 0;
			}
			count += w.pieces;
			if (w.sentenceEnd) {
				lastSentenceCut = i + 1;
				countAtCut = count;
			}
		}
		if (start < words.length) {
			// Merge a tiny tail into the previous chunk text only if it still fits
			if (count < minChunkPieces && chunks.length) {
				const prev = chunks[chunks.length - 1];
				if (prev.pieces + count <= maxPieces) {
					chunks.pop();
					let from = start;
					// walk back to the previous chunk's first word
					while (from > 0 && words[from - 1].docStart >= prev.charStart) from--;
					emit(from, words.length);
					return chunks;
				}
			}
			emit(start, words.length);
		}
		return chunks;
	}

	return { SCHEME, chunkPages, normalizePage };
}));
