/*
 * Host side of the LEALLA-large encoder: safetensors parsing, weight packing
 * for the WASM module, word-embedding lookup with an LRU row cache.
 *
 * Environment-agnostic: works in ChromeWorkers and in Node (tests). File access
 * is injected through a `readRange(offset, length) => Promise<Uint8Array>`.
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	}
	else {
		root.SSLealla = factory();
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const HIDDEN = 256;
	const MAX_POS = 512;
	const LAYERS = 24;
	const FF = 1024;
	const VOCAB = 501153;
	const MAX_SEQ = 128; // the TF Hub model truncates every input to 128 tokens

	/** Parse a safetensors header. `readRange` reads bytes from the file. */
	async function readSafetensorsHeader(readRange) {
		const lenBytes = await readRange(0, 8);
		const dv = new DataView(lenBytes.buffer, lenBytes.byteOffset, 8);
		const headerLen = Number(dv.getBigUint64(0, true));
		if (headerLen <= 0 || headerLen > 10 * 1024 * 1024) {
			throw new Error('Invalid safetensors header');
		}
		const headerBytes = await readRange(8, headerLen);
		const header = JSON.parse(new TextDecoder().decode(headerBytes));
		const dataStart = 8 + headerLen;
		const tensors = {};
		for (const [name, info] of Object.entries(header)) {
			if (name === '__metadata__') continue;
			tensors[name] = {
				dtype: info.dtype,
				shape: info.shape,
				offset: dataStart + info.data_offsets[0],
				length: info.data_offsets[1] - info.data_offsets[0],
			};
		}
		return tensors;
	}

	function toFloat32(bytes) {
		// Copy to an aligned buffer (safetensors data offsets are not 4-aligned in general)
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		return new Float32Array(copy.buffer);
	}

	/**
	 * Build the flat f32 weight buffer expected by lealla.wasm.
	 * @param {Object} tensors - from readSafetensorsHeader
	 * @param {Function} readRange
	 * @param {Float32Array} tokenTypeRow0 - token_type_embeddings[0] of the TF graph
	 * @param {Float32Array} [target] - optional destination (e.g. a view on WASM memory)
	 */
	async function packEncoderWeights(tensors, readRange, tokenTypeRow0, target) {
		const layerFloats = 4 * (HIDDEN * HIDDEN + HIDDEN) + 2 * HIDDEN + (FF * HIDDEN + FF)
			+ (HIDDEN * FF + HIDDEN) + 2 * HIDDEN;
		const total = HIDDEN + MAX_POS * HIDDEN + 2 * HIDDEN + LAYERS * layerFloats
			+ HIDDEN * HIDDEN + HIDDEN;
		const out = target || new Float32Array(total);
		if (out.length < total) throw new Error('Weight buffer too small');
		let pos = 0;
		const put = (arr, expected) => {
			if (arr.length !== expected) {
				throw new Error(`Unexpected tensor size ${arr.length} (expected ${expected})`);
			}
			out.set(arr, pos);
			pos += arr.length;
		};
		const get = async (name, expected) => {
			const t = tensors[name] || tensors['bert.' + name];
			if (!t) throw new Error('Missing tensor ' + name);
			if (t.dtype !== 'F32') throw new Error(`Tensor ${name} has dtype ${t.dtype}`);
			put(toFloat32(await readRange(t.offset, t.length)), expected);
		};
		put(tokenTypeRow0, HIDDEN);
		await get('embeddings.position_embeddings.weight', MAX_POS * HIDDEN);
		await get('embeddings.LayerNorm.weight', HIDDEN);
		await get('embeddings.LayerNorm.bias', HIDDEN);
		for (let l = 0; l < LAYERS; l++) {
			const p = `encoder.layer.${l}.`;
			await get(p + 'attention.self.query.weight', HIDDEN * HIDDEN);
			await get(p + 'attention.self.query.bias', HIDDEN);
			await get(p + 'attention.self.key.weight', HIDDEN * HIDDEN);
			await get(p + 'attention.self.key.bias', HIDDEN);
			await get(p + 'attention.self.value.weight', HIDDEN * HIDDEN);
			await get(p + 'attention.self.value.bias', HIDDEN);
			await get(p + 'attention.output.dense.weight', HIDDEN * HIDDEN);
			await get(p + 'attention.output.dense.bias', HIDDEN);
			await get(p + 'attention.output.LayerNorm.weight', HIDDEN);
			await get(p + 'attention.output.LayerNorm.bias', HIDDEN);
			await get(p + 'intermediate.dense.weight', FF * HIDDEN);
			await get(p + 'intermediate.dense.bias', FF);
			await get(p + 'output.dense.weight', HIDDEN * FF);
			await get(p + 'output.dense.bias', HIDDEN);
			await get(p + 'output.LayerNorm.weight', HIDDEN);
			await get(p + 'output.LayerNorm.bias', HIDDEN);
		}
		await get('pooler.dense.weight', HIDDEN * HIDDEN);
		await get('pooler.dense.bias', HIDDEN);
		if (pos !== total) throw new Error('Weight packing size mismatch');
		return out;
	}

	/** Word-embedding rows read lazily from the safetensors file, with an LRU cache. */
	class WordEmbeddings {
		constructor(tensorInfo, readRange, maxCachedRows = 40000) {
			if (!tensorInfo || tensorInfo.dtype !== 'F32'
					|| tensorInfo.shape[0] !== VOCAB || tensorInfo.shape[1] !== HIDDEN) {
				throw new Error('Unexpected word embedding tensor');
			}
			this.info = tensorInfo;
			this.readRange = readRange;
			this.cache = new Map();
			this.maxCachedRows = maxCachedRows;
		}

		async row(id) {
			let r = this.cache.get(id);
			if (r) {
				// refresh LRU position
				this.cache.delete(id);
				this.cache.set(id, r);
				return r;
			}
			const bytes = await this.readRange(this.info.offset + id * HIDDEN * 4, HIDDEN * 4);
			r = toFloat32(bytes);
			this.cache.set(id, r);
			if (this.cache.size > this.maxCachedRows) {
				this.cache.delete(this.cache.keys().next().value);
			}
			return r;
		}

		/** Write rows for `ids` contiguously into `dest` (Float32Array) */
		async gather(ids, dest) {
			const unique = [...new Set(ids)];
			const rows = new Map();
			await Promise.all(unique.map(async (id) => {
				rows.set(id, await this.row(id));
			}));
			for (let i = 0; i < ids.length; i++) {
				dest.set(rows.get(ids[i]), i * HIDDEN);
			}
		}
	}

	/** Thin wrapper around an instantiated lealla.wasm */
	class Encoder {
		/**
		 * @param {WebAssembly.Instance} instance
		 */
		constructor(instance) {
			this.exports = instance.exports;
			this.memory = instance.exports.memory;
			this.weightFloats = this.exports.weight_floats();
			this.maxTokens = this.exports.max_tokens();
			this.weightsPtr = 0;
			this.outPtr = 0;
		}

		weightView() {
			if (!this.weightsPtr) this.weightsPtr = this.exports.alloc_weights();
			return new Float32Array(this.memory.buffer, this.weightsPtr, this.weightFloats);
		}

		init() {
			this.exports.init(this.weightsPtr);
			this.outPtr = this.exports.alloc_bytes(HIDDEN * 4);
			this.inputPtr = this.exports.input_ptr();
		}

		inputView(tokens) {
			return new Float32Array(this.memory.buffer, this.inputPtr, tokens * HIDDEN);
		}

		/** Run the encoder on the word embeddings already written to inputView */
		run(tokens) {
			const rc = this.exports.embed(tokens, this.outPtr);
			if (rc !== 0) throw new Error('embed() failed: ' + rc);
			return new Float32Array(this.memory.buffer, this.outPtr, HIDDEN).slice();
		}
	}

	/** Tokenizer + embeddings + encoder */
	class LeallaModel {
		constructor(tokenizer, wordEmbeddings, encoder) {
			this.tokenizer = tokenizer;
			this.wordEmbeddings = wordEmbeddings;
			this.encoder = encoder;
			this._queue = Promise.resolve();
		}

		/** Serialised: the encoder has a single input buffer */
		embedIds(ids) {
			const run = async () => {
				const rows = new Float32Array(ids.length * HIDDEN);
				await this.wordEmbeddings.gather(ids, rows);
				this.encoder.inputView(ids.length).set(rows);
				return this.encoder.run(ids.length);
			};
			const p = this._queue.then(run, run);
			this._queue = p.catch(() => {});
			return p;
		}

		async embed(text) {
			return this.embedIds(this.tokenizer.encode(text, MAX_SEQ));
		}
	}

	return {
		HIDDEN, MAX_SEQ, VOCAB,
		readSafetensorsHeader, packEncoderWeights, WordEmbeddings, Encoder, LeallaModel,
	};
}));
