'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { WordPieceTokenizer } = require('../addon/content/lib/tokenizer.js');
const { chunkPages, normalizePage } = require('../addon/content/lib/chunker.js');
const { MODEL_DIR, haveModel } = require('./_helpers.js');

test('normalizePage joins hyphenated line breaks and collapses whitespace', () => {
	assert.strictEqual(normalizePage('ammini-\nstrazione  pubblica\n\ttest'), 'amministrazione pubblica test');
	assert.strictEqual(normalizePage('Stato-\nRegioni'), 'Stato- Regioni');
});

test('chunks fit the 128-token window and cover the whole text', { skip: !haveModel() }, () => {
	const tok = new WordPieceTokenizer(fs.readFileSync(path.join(MODEL_DIR, 'vocab.txt'), 'utf8'));
	const sentence = 'Il principio di legalità impone che ogni potere amministrativo sia attribuito dalla legge. ';
	const pages = [sentence.repeat(40), 'Seconda pagina. ' + sentence.repeat(25), ''];
	const chunks = chunkPages(pages, tok);
	assert.ok(chunks.length > 5);
	for (const c of chunks) {
		assert.ok(tok.encode(c.text, 100000).length - 2 <= 126, 'chunk too long');
		assert.strictEqual(tok.encode(c.text, 100000).length - 2, c.pieces);
	}
	// every word of the input appears exactly once across chunks
	const allWords = pages.map(normalizePage).join(' ').split(/\s+/).filter(Boolean);
	const chunkWords = chunks.map((c) => c.text).join(' ').split(/\s+/).filter(Boolean);
	assert.deepStrictEqual(chunkWords, allWords);
	assert.strictEqual(chunks[0].page, 0);
	assert.ok(chunks.some((c) => c.page === 1));
	// prefers sentence boundaries
	assert.ok(chunks.slice(0, -1).every((c) => /\.$/.test(c.text)));
});
