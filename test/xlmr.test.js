'use strict';
// multilingual-e5-small and Arctic-embed-m-v2.0: the SentencePiece tokenizer
// against Hugging Face `tokenizers`, and the int8 WASM encoder against
// PyTorch (fp32, and the same int8 scheme simulated), with the oracles
// written by tools/quantize_encoder.py. The weight files are built by the same
// script into .models/ (or XLMR_DIR); tests that need them are skipped otherwise.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('../addon/content/lib/xlmr.js');
const { cosine } = require('./_helpers.js');

const DIR = process.env.XLMR_DIR || path.join(__dirname, '..', '.models');
const TOKENIZER = path.join(DIR, 'xlmr-tokenizer.json');
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

let tokenizer = null;
function getTokenizer() {
	if (!tokenizer) tokenizer = new X.XlmrTokenizer(JSON.parse(fs.readFileSync(TOKENIZER, 'utf8')));
	return tokenizer;
}

function readRange(file) {
	const fd = fs.openSync(file, 'r');
	return async (offset, length) => {
		const b = Buffer.alloc(length);
		fs.readSync(fd, b, 0, length, offset);
		return new Uint8Array(b.buffer, b.byteOffset, length);
	};
}

test('XLM-R tokenizer reproduces Hugging Face token ids', { skip: !fs.existsSync(TOKENIZER) }, () => {
	const o = fixture('xlmr-tokenizer-oracle.json');
	const tok = getTokenizer();
	for (let i = 0; i < o.texts.length; i++) {
		assert.deepStrictEqual(tok.encode(o.texts[i]), o.ids[i], JSON.stringify(o.texts[i].slice(0, 80)));
	}
});

for (const [name, opts] of [
	['e5-small', { queryPrefix: 'query: ', passagePrefix: 'passage: ' }],
	['arctic-m-v2', { queryPrefix: 'query: ', passagePrefix: '' }],
]) {
	const weights = path.join(DIR, `${name}-int8.ssew`);
	test(`int8 WASM encoder matches PyTorch: ${name}`, { skip: !fs.existsSync(weights) || !fs.existsSync(TOKENIZER) }, async () => {
		const o = fixture(`${name}-oracle.json`);
		const wasm = fs.readFileSync(path.join(__dirname, '..', 'addon', 'content', 'encoder.wasm'));
		const { instance } = await WebAssembly.instantiate(wasm, {});
		const model = await X.loadModel(instance, getTokenizer(), readRange(weights), opts);
		for (let i = 0; i < o.texts.length; i++) {
			assert.deepStrictEqual(getTokenizer().encode(o.texts[i], 512), o.ids[i]);
			const v = await model.embedIds(o.ids[i]);
			assert.strictEqual(v.length, o.fp32[i].length);
			// Per-token int8 activations amplify tiny float differences (a 1e-6 input
			// perturbation alone moves the PyTorch output by ~1e-3): compare loosely
			assert.ok(cosine(v, o.int8[i]) > 0.99, `${name} #${i} vs int8 reference`);
			assert.ok(cosine(v, o.fp32[i]) > 0.99, `${name} #${i} vs fp32`);
		}
	});
}
