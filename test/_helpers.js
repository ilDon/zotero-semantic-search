'use strict';
const fs = require('fs');
const path = require('path');
const { WordPieceTokenizer } = require('../addon/content/lib/tokenizer.js');
const L = require('../addon/content/lib/lealla.js');

// MODEL_DIR must contain model.safetensors and vocab.txt (setu4993/LEALLA-large)
const MODEL_DIR = process.env.MODEL_DIR || path.join(__dirname, '..', '.model');

function haveModel() {
	return fs.existsSync(path.join(MODEL_DIR, 'model.safetensors'))
		&& fs.existsSync(path.join(MODEL_DIR, 'vocab.txt'));
}

async function loadModel() {
	const fd = fs.openSync(path.join(MODEL_DIR, 'model.safetensors'), 'r');
	const readRange = async (offset, length) => {
		const b = Buffer.alloc(length);
		fs.readSync(fd, b, 0, length, offset);
		return new Uint8Array(b.buffer, b.byteOffset, length);
	};
	const tensors = await L.readSafetensorsHeader(readRange);
	const wasm = fs.readFileSync(path.join(__dirname, '..', 'addon', 'content', 'lealla.wasm'));
	const { instance } = await WebAssembly.instantiate(wasm, {});
	const enc = new L.Encoder(instance);
	const extra = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'addon', 'content', 'model-extra.json')));
	await L.packEncoderWeights(tensors, readRange, Float32Array.from(extra.token_type_row0), enc.weightView());
	enc.init();
	const tok = new WordPieceTokenizer(fs.readFileSync(path.join(MODEL_DIR, 'vocab.txt'), 'utf8'));
	const we = new L.WordEmbeddings(tensors['embeddings.word_embeddings.weight'], readRange);
	return { model: new L.LeallaModel(tok, we, enc), tokenizer: tok, instance };
}

function cosine(a, b) {
	let d = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		d += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return d / Math.sqrt(na * nb);
}

module.exports = { MODEL_DIR, haveModel, loadModel, cosine };
