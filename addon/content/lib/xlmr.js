/*
 * XLM-R SentencePiece tokenizer and host side of the int8 encoder
 * (encoder.wasm) used by multilingual-e5-small and Arctic-embed-m-v2.0.
 *
 * The tokenizer reproduces the Hugging Face `tokenizers` pipeline of both
 * models: Precompiled (nmt_nfkc) normalisation, whitespace split with the "▁"
 * prefix, Unigram (Viterbi) segmentation with fused unknowns, <s> … </s>.
 *
 * Environment-agnostic: works in ChromeWorkers and in Node (tests). File access
 * is injected through a `readRange(offset, length) => Promise<Uint8Array>`.
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	}
	else {
		root.SSXlmr = factory();
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const SPACE = '▁';
	const UNK_PENALTY = 10;
	const SPECIAL_RE = /<s>|<\/s>|<unk>|<pad>|<mask>/g;

	function base64ToBytes(b64) {
		if (typeof atob === 'function') {
			const bin = atob(b64);
			const out = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			return out;
		}
		return new Uint8Array(Buffer.from(b64, 'base64'));
	}

	/**
	 * SentencePiece "precompiled charsmap": a darts-clone double-array trie over
	 * UTF-8 byte strings, whose values index NUL-terminated replacement strings.
	 */
	class CharsMap {
		constructor(bytes) {
			const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const trieSize = dv.getUint32(0, true);
			const trie = new Uint8Array(trieSize);
			trie.set(bytes.subarray(4, 4 + trieSize));
			this.units = new Uint32Array(trie.buffer);
			this.normalized = bytes.subarray(4 + trieSize);
			this.encoder = new TextEncoder();
			this.decoder = new TextDecoder();
			this.cache = new Map();
		}

		/** Value of the shortest key that is a prefix of `bytes` (like spm_precompiled), or -1 */
		_firstPrefix(bytes) {
			const u = this.units;
			let pos = (u[0] >>> 10) << ((u[0] & 512) >>> 6);
			for (let i = 0; i < bytes.length; i++) {
				const c = bytes[i];
				pos ^= c;
				const unit = u[pos];
				if (((unit & 0x800000FF) >>> 0) !== c) return -1;
				pos ^= (unit >>> 10) << ((unit & 512) >>> 6);
				if ((unit >>> 8) & 1) return u[pos] & 0x7FFFFFFF;
			}
			return -1;
		}

		/** Replacement for `chunk`, or null */
		transform(chunk) {
			let r = this.cache.get(chunk);
			if (r !== undefined) return r;
			const v = this._firstPrefix(this.encoder.encode(chunk));
			if (v < 0) {
				r = null;
			}
			else {
				let end = v;
				while (end < this.normalized.length && this.normalized[end] !== 0) end++;
				r = this.decoder.decode(this.normalized.subarray(v, end));
			}
			if (this.cache.size > 20000) this.cache.clear();
			this.cache.set(chunk, r);
			return r;
		}
	}

	let segmenter = null;
	function graphemes(text) {
		if (segmenter === null) {
			segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
				? new Intl.Segmenter('und', { granularity: 'grapheme' })
				: false;
		}
		if (!segmenter) return Array.from(text); // code points (older Firefox)
		return Array.from(segmenter.segment(text), s => s.segment);
	}

	function utf8Length(s) {
		let n = 0;
		for (let i = 0; i < s.length; i++) {
			const c = s.charCodeAt(i);
			if (c < 0x80) n += 1;
			else if (c < 0x800) n += 2;
			else if (c >= 0xD800 && c <= 0xDBFF) {
				n += 4;
				i++;
			}
			else n += 3;
		}
		return n;
	}

	class XlmrTokenizer {
		/**
		 * @param {Object} data - xlmr-tokenizer.json: {pieces, scores, unk_id, bos_id, eos_id, charsmap}
		 */
		constructor(data) {
			this.pieces = data.pieces;
			this.scores = Float64Array.from(data.scores);
			this.unkID = data.unk_id;
			this.bosID = data.bos_id;
			this.eosID = data.eos_id;
			this.ids = new Map();
			let maxLen = 0;
			let minScore = Infinity;
			for (let i = 0; i < this.pieces.length; i++) {
				const p = this.pieces[i];
				if (!this.ids.has(p)) this.ids.set(p, i);
				if (p.length > maxLen) maxLen = p.length;
				if (this.scores[i] < minScore) minScore = this.scores[i];
			}
			this.maxPieceLength = maxLen;
			this.unkScore = minScore - UNK_PENALTY;
			this.charsMap = new CharsMap(base64ToBytes(data.charsmap));
			this.special = new Map([['<s>', 0], ['<pad>', 1], ['</s>', 2], ['<unk>', 3], ['<mask>', this.pieces.length - 1]]
				.filter(([p]) => this.ids.has(p)).map(([p]) => [p, this.ids.get(p)]));
			this._wordCache = new Map();
		}

		/** Precompiled (nmt_nfkc) normalisation, grapheme by grapheme like HF tokenizers */
		normalize(text) {
			const cm = this.charsMap;
			let out = '';
			for (const g of graphemes(text)) {
				if (utf8Length(g) < 6) {
					const r = cm.transform(g);
					if (r !== null) {
						out += r;
						continue;
					}
				}
				for (const ch of g) {
					const r = cm.transform(ch);
					out += r === null ? ch : r;
				}
			}
			return out;
		}

		/** Unigram Viterbi segmentation of one "▁word" -> ids */
		_segment(word) {
			const n = word.length;
			const score = new Float64Array(n + 1).fill(-Infinity);
			const from = new Int32Array(n + 1).fill(-1);
			const tok = new Int32Array(n + 1).fill(-1);
			score[0] = 0;
			const maxLen = this.maxPieceLength;
			for (let i = 0; i < n; i++) {
				if (score[i] === -Infinity) continue;
				const base = score[i];
				const c = word.charCodeAt(i);
				const mblen = (c >= 0xD800 && c <= 0xDBFF && i + 1 < n) ? 2 : 1;
				let single = false;
				const limit = Math.min(n, i + maxLen);
				for (let j = i + 1; j <= limit; j++) {
					// never end inside a surrogate pair
					const last = word.charCodeAt(j - 1);
					if (last >= 0xD800 && last <= 0xDBFF && j < n) continue;
					const id = this.ids.get(word.slice(i, j));
					if (id === undefined) continue;
					const cand = base + this.scores[id];
					if (from[j] === -1 || cand > score[j]) {
						score[j] = cand;
						from[j] = i;
						tok[j] = id;
					}
					if (j - i === mblen) single = true;
				}
				if (!single) {
					const j = i + mblen;
					const cand = base + this.unkScore;
					if (from[j] === -1 || cand > score[j]) {
						score[j] = cand;
						from[j] = i;
						tok[j] = this.unkID;
					}
				}
			}
			const ids = [];
			for (let j = n; j > 0; j = from[j]) ids.push(tok[j]);
			ids.reverse();
			// fuse consecutive unknowns
			const out = [];
			for (const id of ids) {
				if (id === this.unkID && out.length && out[out.length - 1] === this.unkID) continue;
				out.push(id);
			}
			return out;
		}

		_word(word) {
			let ids = this._wordCache.get(word);
			if (!ids) {
				ids = this._segment(word);
				if (this._wordCache.size > 50000) this._wordCache.clear();
				this._wordCache.set(word, ids);
			}
			return ids;
		}

		/** ids of a text fragment without special tokens */
		_encodePlain(text, out) {
			const norm = this.normalize(text).replace(/ {2,}/g, ' ').trim();
			if (!norm) return;
			for (const w of norm.split(' ')) {
				for (const id of this._word(SPACE + w)) out.push(id);
			}
		}

		/**
		 * @param {string} text
		 * @param {number} [maxTokens=512] - including <s> and </s>
		 * @returns {number[]} ids
		 */
		encode(text, maxTokens = 512) {
			text = String(text).replace(/\s+/g, ' ').trim();
			const ids = [];
			let last = 0;
			SPECIAL_RE.lastIndex = 0;
			let m;
			while ((m = SPECIAL_RE.exec(text))) {
				this._encodePlain(text.slice(last, m.index), ids);
				ids.push(this.special.get(m[0]));
				last = m.index + m[0].length;
			}
			this._encodePlain(text.slice(last), ids);
			if (ids.length > maxTokens - 2) ids.length = maxTokens - 2;
			return [this.bosID, ...ids, this.eosID];
		}

		/** Number of pieces of a fragment of raw text, for passage chunking (see chunker.js) */
		countPieces(text) {
			const norm = this.normalize(text).replace(/ {2,}/g, ' ').trim();
			if (!norm) return 0;
			let n = 0;
			for (const w of norm.split(' ')) n += this._word(SPACE + w).length;
			return n;
		}

		/** Pieces of one word */
		wordPiece(word) {
			const norm = this.normalize(word).replace(/\s+/g, '');
			return norm ? this._word(SPACE + norm) : [];
		}
	}

	// ---------------------------------------------------------------- weights

	/** Parse the header of an .ssew weight file (tools/quantize_encoder.py) */
	async function readWeightsHeader(readRange) {
		const pre = await readRange(0, 12);
		const magic = String.fromCharCode(pre[0], pre[1], pre[2], pre[3]);
		const dv = new DataView(pre.buffer, pre.byteOffset, 12);
		if (magic !== 'SSEW' || dv.getUint32(4, true) !== 1) throw new Error('Not an encoder weight file');
		const len = dv.getUint32(8, true);
		const header = JSON.parse(new TextDecoder().decode(await readRange(12, len)));
		header.dataStart = Math.ceil((12 + len) / 64) * 64;
		return header;
	}

	function copyBytes(bytes) {
		const c = new Uint8Array(bytes.byteLength);
		c.set(bytes);
		return c;
	}

	/** Word-embedding rows (int8 + per-row scale) read lazily, with an LRU cache */
	class WordEmbeddings {
		constructor(header, scales, readRange, maxCachedRows = 30000) {
			const t = header.tensors['word.q'];
			this.vocab = t.shape[0];
			this.dim = t.shape[1];
			this.offset = header.dataStart + t.offset;
			this.scales = scales;
			this.readRange = readRange;
			this.cache = new Map();
			this.maxCachedRows = maxCachedRows;
		}

		async row(id) {
			let r = this.cache.get(id);
			if (r) {
				this.cache.delete(id);
				this.cache.set(id, r);
				return r;
			}
			const q = new Int8Array(copyBytes(await this.readRange(this.offset + id * this.dim, this.dim)).buffer);
			const s = this.scales[id];
			r = new Float32Array(this.dim);
			for (let i = 0; i < this.dim; i++) r[i] = q[i] * s;
			this.cache.set(id, r);
			if (this.cache.size > this.maxCachedRows) this.cache.delete(this.cache.keys().next().value);
			return r;
		}

		async gather(ids, dest) {
			const unique = [...new Set(ids)];
			const rows = new Map();
			await Promise.all(unique.map(async (id) => {
				rows.set(id, await this.row(id));
			}));
			for (let i = 0; i < ids.length; i++) dest.set(rows.get(ids[i]), i * this.dim);
		}
	}

	const HEADER_WORDS = 14;
	const LAYER_KEYS = ['qkv.q', 'qkv.s', 'qkv.b', 'o.q', 'o.s', 'o.b', 'ln1.g', 'ln1.b',
		'up.q', 'up.s', 'up.b', 'down.q', 'down.s', 'down.b', 'ln2.g', 'ln2.b'];

	/** Thin wrapper around an instantiated encoder.wasm, loaded with one model */
	class Encoder {
		constructor(instance) {
			this.exports = instance.exports;
			this.memory = instance.exports.memory;
		}

		/**
		 * Copy the encoder tensors (all but the word embeddings) into WASM memory
		 * and initialise the forward pass.
		 */
		async load(header, readRange) {
			const e = this.exports;
			const c = header.config;
			const put = async (name) => {
				const t = header.tensors[name];
				if (!t) return 0;
				const ptr = e.alloc_bytes(t.length);
				if (!ptr) throw new Error('Out of memory loading ' + name);
				const bytes = await readRange(header.dataStart + t.offset, t.length);
				new Uint8Array(this.memory.buffer, ptr, t.length).set(bytes);
				return ptr;
			};
			const table = new Uint32Array(HEADER_WORDS + c.layers * LAYER_KEYS.length);
			const f32bits = (x) => new Uint32Array(Float32Array.of(x).buffer)[0];
			table.set([c.flags, c.hidden, c.heads, c.ffn, c.layers, c.max_tokens, c.pooling, c.out_dim,
				f32bits(c.ln_eps), f32bits(c.rope_theta || 0)]);
			table[10] = await put('tt0');
			table[11] = await put('pos');
			table[12] = await put('emb_ln.g');
			table[13] = await put('emb_ln.b');
			for (let l = 0; l < c.layers; l++) {
				for (let k = 0; k < LAYER_KEYS.length; k++) {
					table[HEADER_WORDS + l * LAYER_KEYS.length + k] = await put(`l${l}.${LAYER_KEYS[k]}`);
				}
			}
			const tablePtr = e.alloc_bytes(table.byteLength);
			new Uint32Array(this.memory.buffer, tablePtr, table.length).set(table);
			const rc = e.init(tablePtr);
			if (rc !== 0) throw new Error('encoder init failed: ' + rc);
			this.hidden = c.hidden;
			this.dim = e.out_dim();
			this.maxTokens = e.max_tokens();
			this.inputPtr = e.input_ptr();
			this.outPtr = e.alloc_bytes(this.dim * 4);
		}

		inputView(tokens) {
			return new Float32Array(this.memory.buffer, this.inputPtr, tokens * this.hidden);
		}

		run(tokens) {
			const rc = this.exports.embed(tokens, this.outPtr);
			if (rc !== 0) throw new Error('embed() failed: ' + rc);
			return new Float32Array(this.memory.buffer, this.outPtr, this.dim).slice();
		}
	}

	/** Tokenizer + word embeddings + encoder + the model's input prefixes */
	class XlmrModel {
		/**
		 * @param {Object} opts - {queryPrefix, passagePrefix}
		 */
		constructor(tokenizer, words, encoder, opts = {}) {
			this.tokenizer = tokenizer;
			this.words = words;
			this.encoder = encoder;
			this.queryPrefix = opts.queryPrefix || '';
			this.passagePrefix = opts.passagePrefix || '';
			this.dim = encoder.dim;
			this._queue = Promise.resolve();
		}

		embedIds(ids) {
			const run = async () => {
				const rows = new Float32Array(ids.length * this.encoder.hidden);
				await this.words.gather(ids, rows);
				this.encoder.inputView(ids.length).set(rows);
				return this.encoder.run(ids.length);
			};
			const p = this._queue.then(run, run);
			this._queue = p.catch(() => {});
			return p;
		}

		/** @param {'query'|'passage'} kind */
		embed(text, kind = 'passage') {
			const prefix = kind === 'query' ? this.queryPrefix : this.passagePrefix;
			return this.embedIds(this.tokenizer.encode(prefix + text, this.encoder.maxTokens));
		}
	}

	/**
	 * Load everything from the weight file.
	 * @param {WebAssembly.Instance} instance - fresh encoder.wasm instance
	 */
	async function loadModel(instance, tokenizerData, readRange, opts) {
		const header = await readWeightsHeader(readRange);
		const st = header.tensors['word.s'];
		const scales = new Float32Array(copyBytes(await readRange(header.dataStart + st.offset, st.length)).buffer);
		const encoder = new Encoder(instance);
		await encoder.load(header, readRange);
		const tokenizer = tokenizerData instanceof XlmrTokenizer ? tokenizerData : new XlmrTokenizer(tokenizerData);
		return new XlmrModel(tokenizer, new WordEmbeddings(header, scales, readRange), encoder, opts);
	}

	return { XlmrTokenizer, CharsMap, readWeightsHeader, WordEmbeddings, Encoder, XlmrModel, loadModel };
}));
