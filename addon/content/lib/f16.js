/*
 * IEEE half-precision (fp16) packing of embedding vectors, used by the
 * passage databases of the newer models (half the size of float32, with no
 * measurable effect on similarities: relative error < 5e-4 per component).
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	}
	else {
		root.SSF16 = factory();
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const f32 = new Float32Array(1);
	const u32 = new Uint32Array(f32.buffer);

	function toHalf(x) {
		f32[0] = x;
		const b = u32[0];
		const sign = (b >>> 16) & 0x8000;
		const exp = (b >>> 23) & 0xff;
		let mant = b & 0x7fffff;
		if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // inf / nan
		let e = exp - 127 + 15;
		if (e >= 0x1f) return sign | 0x7c00; // overflow -> inf
		if (e <= 0) {
			if (e < -10) return sign; // underflow -> 0
			mant |= 0x800000;
			const shift = 14 - e;
			let h = mant >>> shift;
			const rem = mant & ((1 << shift) - 1);
			const half = 1 << (shift - 1);
			if (rem > half || (rem === half && (h & 1))) h++;
			return sign | h;
		}
		let h = (e << 10) | (mant >>> 13);
		const rem = mant & 0x1fff;
		if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++; // round half to even
		return sign | h;
	}

	function fromHalf(h) {
		const sign = h & 0x8000 ? -1 : 1;
		const exp = (h >>> 10) & 0x1f;
		const mant = h & 0x3ff;
		if (exp === 0) return sign * mant * 2 ** -24;
		if (exp === 0x1f) return mant ? NaN : sign * Infinity;
		return sign * (1 + mant / 1024) * 2 ** (exp - 15);
	}

	/** @returns {Uint8Array} little-endian fp16 bytes */
	function encode(vec) {
		const out = new Uint16Array(vec.length);
		for (let i = 0; i < vec.length; i++) out[i] = toHalf(vec[i]);
		return new Uint8Array(out.buffer);
	}

	let table = null;

	/** @param {Uint8Array|number[]} bytes @returns {Float32Array} */
	function decode(bytes) {
		if (!table) {
			table = new Float32Array(65536);
			for (let h = 0; h < 65536; h++) table[h] = fromHalf(h);
		}
		const n = bytes.length >> 1;
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = table[bytes[2 * i] | (bytes[2 * i + 1] << 8)];
		return out;
	}

	return { encode, decode, toHalf, fromHalf };
}));
