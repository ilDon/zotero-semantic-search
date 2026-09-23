'use strict';
// Checks the tokenizer and the WASM encoder against outputs of the original
// TF Hub model (google/LEALLA/LEALLA-large/1), captured with tools/tf_oracle.py.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { WordPieceTokenizer } = require('../addon/content/lib/tokenizer.js');
const { MODEL_DIR, haveModel, loadModel, cosine } = require('./_helpers.js');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tf-oracle.json'), 'utf8'));

test('tokenizer reproduces the TF graph token ids', { skip: !haveModel() }, () => {
	const tok = new WordPieceTokenizer(fs.readFileSync(path.join(MODEL_DIR, 'vocab.txt'), 'utf8'));
	for (const f of fixtures) {
		assert.deepStrictEqual(tok.encode(f.text), f.ids, JSON.stringify(f.text));
	}
});

test('WASM encoder reproduces the TF embeddings', { skip: !haveModel() }, async () => {
	const { model } = await loadModel();
	for (const f of fixtures) {
		const e = await model.embed(f.text);
		assert.ok(cosine(e, f.embedding) > 0.99999, JSON.stringify(f.text));
	}
});
