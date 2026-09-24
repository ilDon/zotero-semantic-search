'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../addon/content/lib/f16.js');

test('fp16 packing round-trips with relative error < 5e-4', () => {
	let seed = 7;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
	const v = Float32Array.from({ length: 5000 }, () => rnd() * Math.exp(rnd() * 8));
	const bytes = F.encode(v);
	assert.strictEqual(bytes.length, v.length * 2);
	const back = F.decode(bytes);
	for (let i = 0; i < v.length; i++) {
		if (Math.abs(v[i]) < 1e-4) continue;
		assert.ok(Math.abs(back[i] - v[i]) / Math.abs(v[i]) < 5e-4, `${v[i]} -> ${back[i]}`);
	}
	// mozStorage returns BLOBs as plain arrays of octets
	assert.deepStrictEqual(Array.from(F.decode(Array.from(F.encode([1, -2, 0.5, 0])))), [1, -2, 0.5, 0]);
});
