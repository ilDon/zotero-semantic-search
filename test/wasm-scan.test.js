'use strict';
// The int8 scan kernel used by the vector index approximates cosine similarity.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('scan_i8 approximates cosine similarity within 0.01', async () => {
	const wasm = fs.readFileSync(path.join(__dirname, '..', 'addon', 'content', 'lealla.wasm'));
	const { instance } = await WebAssembly.instantiate(wasm, {});
	const e = instance.exports;
	const D = 256;
	const N = 2000;
	let seed = 42;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
	const norm = (v) => {
		let s = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
		return v.map(x => x / s);
	};
	const vecs = [];
	for (let i = 0; i < N; i++) vecs.push(norm(Array.from({ length: D }, rnd)));
	const q = norm(Array.from({ length: D }, (_, k) => vecs[7][k] + 0.05 * rnd()));

	const qPtr = e.alloc_bytes(D * 2);
	const sPtr = e.alloc_bytes(N * 4);
	const oPtr = e.alloc_bytes(N * 4);
	const vPtr = e.alloc_bytes(N * D);
	const mem = e.memory.buffer;
	const scales = new Float32Array(mem, sPtr, N);
	const v8 = new Int8Array(mem, vPtr, N * D);
	for (let i = 0; i < N; i++) {
		const max = Math.max(...vecs[i].map(Math.abs));
		scales[i] = max / 127;
		for (let k = 0; k < D; k++) v8[i * D + k] = Math.round(vecs[i][k] / scales[i]);
	}
	const qmax = Math.max(...q.map(Math.abs));
	const qScale = qmax / 32767;
	const q16 = new Int16Array(mem, qPtr, D);
	for (let k = 0; k < D; k++) q16[k] = Math.round(q[k] / qScale);
	e.scan_i8(vPtr, sPtr, N, qPtr, qScale, oPtr);
	const out = new Float32Array(mem, oPtr, N);
	let maxErr = 0;
	let exactBest = 0;
	let exactBestScore = -2;
	for (let i = 0; i < N; i++) {
		const exact = vecs[i].reduce((a, x, k) => a + x * q[k], 0);
		maxErr = Math.max(maxErr, Math.abs(exact - out[i]));
		if (exact > exactBestScore) {
			exactBestScore = exact;
			exactBest = i;
		}
	}
	assert.strictEqual(exactBest, 7);
	assert.ok(maxErr < 0.01, 'max error ' + maxErr);
	let best = 0;
	for (let i = 1; i < N; i++) if (out[i] > out[best]) best = i;
	assert.strictEqual(best, 7);
});

test('encoder.wasm scan_i8 handles other dimensions (384)', async () => {
	const wasm = fs.readFileSync(path.join(__dirname, '..', 'addon', 'content', 'encoder.wasm'));
	const { instance } = await WebAssembly.instantiate(wasm, {});
	const e = instance.exports;
	const D = 384;
	const N = 500;
	let seed = 3;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
	const norm = (v) => {
		const s = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
		return v.map(x => x / s);
	};
	const vecs = [];
	for (let i = 0; i < N; i++) vecs.push(norm(Array.from({ length: D }, rnd)));
	const q = norm(Array.from({ length: D }, (_, k) => vecs[42][k] + 0.05 * rnd()));
	const qPtr = e.alloc_bytes(D * 2);
	const sPtr = e.alloc_bytes(N * 4);
	const oPtr = e.alloc_bytes(N * 4);
	const vPtr = e.alloc_bytes(N * D);
	const mem = e.memory.buffer;
	const scales = new Float32Array(mem, sPtr, N);
	const v8 = new Int8Array(mem, vPtr, N * D);
	for (let i = 0; i < N; i++) {
		scales[i] = Math.max(...vecs[i].map(Math.abs)) / 127;
		for (let k = 0; k < D; k++) v8[i * D + k] = Math.round(vecs[i][k] / scales[i]);
	}
	const qScale = Math.max(...q.map(Math.abs)) / 32767;
	const q16 = new Int16Array(mem, qPtr, D);
	for (let k = 0; k < D; k++) q16[k] = Math.round(q[k] / qScale);
	e.scan_i8(vPtr, sPtr, N, D, qPtr, qScale, oPtr);
	const out = new Float32Array(mem, oPtr, N);
	for (let i = 0; i < N; i++) {
		const exact = vecs[i].reduce((a, x, k) => a + x * q[k], 0);
		assert.ok(Math.abs(exact - out[i]) < 0.01);
	}
});

test('lealla.wasm is unchanged (LEALLA-large stays bit-for-bit compatible)', () => {
	const hash = require('crypto').createHash('sha256')
		.update(fs.readFileSync(path.join(__dirname, '..', 'addon', 'content', 'lealla.wasm'))).digest('hex');
	assert.strictEqual(hash, 'a8dd86db85c671e99f150c26f769e6497d1df2a9c81c6e43a4b8c7acbb440781');
});
