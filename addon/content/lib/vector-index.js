/* global Zotero, IOUtils, PathUtils, SSEvents, SSActiveProxy, SSModels */
/* exported SSVectorIndexImpl, SSVectorIndex */

/**
 * In-memory index of all passage vectors of one embedding model,
 * int8-quantised (one byte per dimension + 1 scale per passage: ~130 MB for
 * 500k LEALLA passages instead of ~3 GB of JSON in SQLite). The full scan runs
 * in WebAssembly SIMD; candidates are then re-scored with the exact vectors
 * from the database, so similarities are exact.
 *
 * The quantised vectors are cached in the profile directory and reconciled
 * with the database (by rowid) at load time.
 */
var SSVectorIndexImpl = class {
	constructor(space) {
		this.space = space;
		this.DIM = space.spec.dim;
		this.CACHE_VERSION = 1;
		this._lealla = space.spec.runtime === 'lealla';
		this._inst = null;
		this._w = null;
		this._cap = 0;
		this.n = 0;
		this.rowids = null; // Int32Array
		this.docIdx = null; // Int32Array (-1 = deleted)
		this.sections = null; // Int32Array
		this.docs = []; // {key, fileName, idx: number[]}
		this.docByKey = new Map();
		this.liveCount = 0;
		this.loaded = false;
		this._loading = null;
		this._dirty = false;
		this._saveTimer = null;
		this.progress = null; // {phase, done, total}
	}

	get store() {
		return this.space.store;
	}

	get cachePath() {
		let name = this._lealla ? 'vectors.bin' : `vectors-${this.space.id}.bin`;
		return PathUtils.join(Zotero.Profile.dir, 'semantic-search', name);
	}

	onChange(fn) {
		return SSEvents.on('index', fn);
	}

	_emit() {
		SSEvents.emit('index');
	}

	/** Scan kernel: lealla.wasm (256 dims) for LEALLA, encoder.wasm (any dimension) otherwise */
	async _wasmModule() {
		let url = this._lealla ? 'chrome://semantic-search/content/lealla.wasm' : 'chrome://semantic-search/content/encoder.wasm';
		let cache = SSVectorIndexImpl._modules || (SSVectorIndexImpl._modules = new Map());
		if (!cache.has(url)) {
			cache.set(url, (async () => {
				let req = await Zotero.HTTP.request('GET', url, { responseType: 'arraybuffer' });
				return WebAssembly.compile(req.response);
			})());
		}
		return cache.get(url);
	}

	/** (Re)allocate storage for `cap` vectors, keeping current contents */
	async _allocate(cap) {
		let module = await this._wasmModule();
		let inst = await WebAssembly.instantiate(module, {});
		let e = inst.exports;
		let qPtr = e.alloc_bytes(this.DIM * 2);
		let scalePtr = e.alloc_bytes(cap * 4);
		let outPtr = e.alloc_bytes(cap * 4);
		let vecPtr = e.alloc_bytes(cap * this.DIM);
		if (!vecPtr) throw new Error('Out of memory allocating the vector index');
		let buf = e.memory.buffer;
		let next = {
			inst,
			q: new Int16Array(buf, qPtr, this.DIM),
			qPtr,
			scales: new Float32Array(buf, scalePtr, cap),
			scalePtr,
			out: new Float32Array(buf, outPtr, cap),
			outPtr,
			vecs: new Int8Array(buf, vecPtr, cap * this.DIM),
			vecPtr,
		};
		let rowids = new Int32Array(cap);
		let docIdx = new Int32Array(cap);
		let sections = new Int32Array(cap);
		if (this._inst && this.n) {
			next.scales.set(this._w.scales.subarray(0, this.n));
			next.vecs.set(this._w.vecs.subarray(0, this.n * this.DIM));
			rowids.set(this.rowids.subarray(0, this.n));
			docIdx.set(this.docIdx.subarray(0, this.n));
			sections.set(this.sections.subarray(0, this.n));
		}
		this._inst = inst;
		this._w = next;
		this._cap = cap;
		this.rowids = rowids;
		this.docIdx = docIdx;
		this.sections = sections;
	}

	async _ensureCapacity(extra) {
		if (this.n + extra <= this._cap) return;
		let cap = Math.max(Math.ceil((this.n + extra) * 1.25), 1024);
		await this._allocate(cap);
	}

	_reset() {
		this.n = 0;
		this.docs = [];
		this.docByKey = new Map();
		this.liveCount = 0;
		this._inst = null;
		this._w = null;
		this._cap = 0;
	}

	_doc(key, fileName) {
		let d = this.docByKey.get(key);
		if (d === undefined) {
			d = this.docs.length;
			this.docs.push({ key, fileName, idx: [] });
			this.docByKey.set(key, d);
		}
		else if (fileName && !this.docs[d].fileName) {
			this.docs[d].fileName = fileName;
		}
		return d;
	}

	/** Append one vector (already reserved capacity) */
	_push(rowid, key, fileName, section, vec) {
		let i = this.n++;
		let maxAbs = 0;
		let norm = 0;
		for (let k = 0; k < this.DIM; k++) {
			let v = vec[k];
			norm += v * v;
		}
		norm = Math.sqrt(norm) || 1;
		for (let k = 0; k < this.DIM; k++) {
			let a = Math.abs(vec[k] / norm);
			if (a > maxAbs) maxAbs = a;
		}
		let scale = maxAbs / 127 || 1e-9;
		let base = i * this.DIM;
		let vecs = this._w.vecs;
		for (let k = 0; k < this.DIM; k++) {
			vecs[base + k] = Math.round(vec[k] / norm / scale);
		}
		this._w.scales[i] = scale;
		this.rowids[i] = rowid;
		this.sections[i] = section;
		let d = this._doc(key, fileName);
		this.docIdx[i] = d;
		this.docs[d].idx.push(i);
		this.liveCount++;
	}

	_tombstone(i) {
		if (this.docIdx[i] === -1) return;
		this.docIdx[i] = -1;
		this._w.scales[i] = 0;
		this.liveCount--;
	}

	// ---------------------------------------------------------------- loading

	/** Load (from cache + DB reconciliation, or full build). Idempotent. */
	load() {
		if (this.loaded) return Promise.resolve();
		if (!this._loading) {
			this._loading = this._load()
				.then(() => {
					this.loaded = true;
				})
				.finally(() => {
					this._loading = null;
					this.progress = null;
					this._emit();
				});
		}
		return this._loading;
	}

	async _load() {
		this._reset();
		this.progress = { phase: 'index', done: 0, total: 0 };
		this._emit();
		// Needed for cheap rowid scans; one-time cost on legacy databases
		if (!(await this.store.hasIdIndex())) {
			this.progress = { phase: 'db-index', done: 0, total: 0 };
			this._emit();
			await this.store.ensureIdIndex();
		}
		let dbRowids = await this.store.getAllRowids();
		let loadedFromCache = false;
		try {
			loadedFromCache = await this._readCache();
		}
		catch (e) {
			Zotero.logError(e);
			this._reset();
		}
		let missing;
		if (loadedFromCache) {
			let dbSet = new Set(dbRowids);
			let changed = false;
			for (let i = 0; i < this.n; i++) {
				if (this.docIdx[i] !== -1 && !dbSet.has(this.rowids[i])) {
					this._tombstone(i);
					changed = true;
				}
			}
			let have = new Set();
			for (let i = 0; i < this.n; i++) {
				if (this.docIdx[i] !== -1) have.add(this.rowids[i]);
			}
			missing = dbRowids.filter(r => !have.has(r));
			if (changed) this._dirty = true;
		}
		else {
			missing = null; // everything
		}
		let total = missing ? missing.length : dbRowids.length;
		if (total) {
			await this._ensureCapacity(total);
			this.progress = { phase: missing ? 'update' : 'build', done: 0, total };
			this._emit();
			let done = 0;
			let lastEmit = 0;
			await this.store.forEachEmbedding((rowid, id, fileName, section, vec) => {
				if (vec.length !== this.DIM) return;
				if (this.n >= this._cap) return; // DB grew while loading; picked up next time
				this._push(rowid, id, fileName, section, vec);
				done++;
				let now = Date.now();
				if (now - lastEmit > 250) {
					lastEmit = now;
					this.progress.done = done;
					this._emit();
				}
			}, missing || undefined);
			this._dirty = true;
		}
		else if (!this._inst) {
			await this._allocate(1024);
		}
		if (this._dirty) await this.save();
	}

	async _readCache() {
		let path = this.cachePath;
		if (!(await IOUtils.exists(path))) return false;
		let bytes = await IOUtils.read(path);
		let dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let magic = new TextDecoder().decode(bytes.subarray(0, 4));
		if (magic !== 'SSVI' || dv.getUint32(4, true) !== this.CACHE_VERSION) return false;
		let n = dv.getUint32(8, true);
		let headerLen = dv.getUint32(12, true);
		let header = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + headerLen)));
		if (header.dbPath !== this.store.path) return false;
		let off = 16 + headerLen;
		off = (off + 3) & ~3;
		let need = off + n * (4 * 4 + this.DIM);
		if (bytes.byteLength < need) return false;
		let copyI32 = (o) => new Int32Array(bytes.slice(o, o + n * 4).buffer);
		let rowids = copyI32(off);
		off += n * 4;
		let docIdx = copyI32(off);
		off += n * 4;
		let sections = copyI32(off);
		off += n * 4;
		let scales = new Float32Array(bytes.slice(off, off + n * 4).buffer);
		off += n * 4;
		let vecs = new Int8Array(bytes.buffer, bytes.byteOffset + off, n * this.DIM);

		await this._allocate(Math.max(Math.ceil(n * 1.1), 1024));
		this.docs = header.docs.map(([key, fileName]) => ({ key, fileName, idx: [] }));
		this.docByKey = new Map(this.docs.map((d, i) => [d.key, i]));
		this.rowids.set(rowids);
		this.docIdx.set(docIdx);
		this.sections.set(sections);
		this._w.scales.set(scales);
		this._w.vecs.set(vecs);
		this.n = n;
		this.liveCount = 0;
		for (let i = 0; i < n; i++) {
			let d = docIdx[i];
			if (d >= 0) {
				this.docs[d].idx.push(i);
				this.liveCount++;
			}
		}
		return true;
	}

	/** Write the cache (compacting deleted entries) */
	async save() {
		if (!this._inst) return;
		// compact
		let live = [];
		for (let i = 0; i < this.n; i++) {
			if (this.docIdx[i] !== -1) live.push(i);
		}
		let docMap = new Map();
		let docs = [];
		for (let i of live) {
			let d = this.docIdx[i];
			if (!docMap.has(d)) {
				docMap.set(d, docs.length);
				docs.push([this.docs[d].key, this.docs[d].fileName]);
			}
		}
		let n = live.length;
		let header = new TextEncoder().encode(JSON.stringify({ dbPath: this.store.path, docs }));
		let off = 16 + header.length;
		off = (off + 3) & ~3;
		let total = off + n * (16 + this.DIM);
		let out = new Uint8Array(total);
		let dv = new DataView(out.buffer);
		out.set(new TextEncoder().encode('SSVI'), 0);
		dv.setUint32(4, this.CACHE_VERSION, true);
		dv.setUint32(8, n, true);
		dv.setUint32(12, header.length, true);
		out.set(header, 16);
		let rowids = new Int32Array(out.buffer, off, n);
		let docIdx = new Int32Array(out.buffer, off + n * 4, n);
		let sections = new Int32Array(out.buffer, off + n * 8, n);
		let scales = new Float32Array(out.buffer, off + n * 12, n);
		let vecs = new Int8Array(out.buffer, off + n * 16, n * this.DIM);
		for (let j = 0; j < n; j++) {
			let i = live[j];
			rowids[j] = this.rowids[i];
			docIdx[j] = docMap.get(this.docIdx[i]);
			sections[j] = this.sections[i];
			scales[j] = this._w.scales[i];
			vecs.set(this._w.vecs.subarray(i * this.DIM, (i + 1) * this.DIM), j * this.DIM);
		}
		await IOUtils.makeDirectory(PathUtils.parent(this.cachePath), { createAncestors: true, ignoreExisting: true });
		await IOUtils.write(this.cachePath, out, { tmpPath: this.cachePath + '.tmp' });
		this._dirty = false;
	}

	// The cache only speeds up loading (the database is the source of truth), so it
	// is written at most every few minutes, when indexing ends and at shutdown
	scheduleSave() {
		this._dirty = true;
		if (this._saveTimer) return;
		this._saveTimer = setTimeout(async () => {
			this._saveTimer = null;
			try {
				await this.save();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}, 5 * 60 * 1000);
	}

	async flush() {
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
			this._saveTimer = null;
		}
		if (this._dirty && this.loaded) await this.save();
	}

	unload() {
		this._reset();
		this.loaded = false;
	}

	/** Drop the cache file and rebuild from the database */
	async rebuild() {
		if (this._loading) await this._loading;
		this.unload();
		await IOUtils.remove(this.cachePath, { ignoreAbsent: true });
		this._emit();
		await this.load();
	}

	// ---------------------------------------------------------------- updates

	async addDocument(key, fileName, rowids, vectors) {
		// Rows inserted while the index is loading were not in the rowid snapshot
		if (this._loading) await this._loading.catch(() => {});
		if (!this.loaded) return;
		this.removeDocument(key);
		await this._ensureCapacity(rowids.length);
		for (let i = 0; i < rowids.length; i++) {
			this._push(rowids[i], key, fileName, i, vectors.subarray(i * this.DIM, (i + 1) * this.DIM));
		}
		this.scheduleSave();
		this._emit();
	}

	removeDocument(key) {
		if (!this.loaded) return;
		let d = this.docByKey.get(key);
		if (d === undefined) return;
		for (let i of this.docs[d].idx) this._tombstone(i);
		this.docs[d].idx = [];
		this.scheduleSave();
		this._emit();
	}

	hasDocument(key) {
		let d = this.docByKey.get(key);
		return d !== undefined && this.docs[d].idx.length > 0;
	}

	documentCount() {
		let n = 0;
		for (let d of this.docs) {
			if (d.idx.length) n++;
		}
		return n;
	}

	// ---------------------------------------------------------------- search

	/**
	 * Approximate scores for all passages (cosine, error ~±0.005).
	 * @returns {Float32Array} view valid until the next call
	 */
	scan(query) {
		let q = query;
		let norm = 0;
		for (let k = 0; k < this.DIM; k++) norm += q[k] * q[k];
		norm = Math.sqrt(norm) || 1;
		let maxAbs = 0;
		for (let k = 0; k < this.DIM; k++) maxAbs = Math.max(maxAbs, Math.abs(q[k] / norm));
		let qScale = maxAbs / 32767 || 1e-9;
		for (let k = 0; k < this.DIM; k++) this._w.q[k] = Math.round(q[k] / norm / qScale);
		if (this._lealla) {
			this._inst.exports.scan_i8(this._w.vecPtr, this._w.scalePtr, this.n, this._w.qPtr, qScale, this._w.outPtr);
		}
		else {
			this._inst.exports.scan_i8(this._w.vecPtr, this._w.scalePtr, this.n, this.DIM, this._w.qPtr, qScale, this._w.outPtr);
		}
		return this._w.out.subarray(0, this.n);
	}

	/**
	 * @returns {number[]} indices with approx score >= minScore, best first, at most `limit`
	 * @param {Set<string>} [onlyKeys] - restrict to these documents
	 */
	candidates(query, minScore, limit, onlyKeys) {
		let scores = this.scan(query);
		let idx = [];
		if (onlyKeys) {
			for (let key of onlyKeys) {
				let d = this.docByKey.get(key);
				if (d === undefined) continue;
				for (let i of this.docs[d].idx) {
					if (scores[i] >= minScore) idx.push(i);
				}
			}
		}
		else {
			for (let i = 0; i < scores.length; i++) {
				if (scores[i] >= minScore) idx.push(i);
			}
		}
		idx.sort((a, b) => scores[b] - scores[a]);
		if (idx.length > limit) idx.length = limit;
		return idx.map(i => ({ i, score: scores[i] }));
	}

	/** Top-k indices regardless of threshold */
	topK(query, k, onlyKeys) {
		return this.candidates(query, -2, k, onlyKeys);
	}

	/** Mean (normalised) vector of a document, dequantised */
	centroid(key) {
		let d = this.docByKey.get(key);
		if (d === undefined || !this.docs[d].idx.length) return null;
		let c = new Float32Array(this.DIM);
		for (let i of this.docs[d].idx) {
			let s = this._w.scales[i];
			let base = i * this.DIM;
			for (let k = 0; k < this.DIM; k++) c[k] += this._w.vecs[base + k] * s;
		}
		let norm = 0;
		for (let k = 0; k < this.DIM; k++) norm += c[k] * c[k];
		norm = Math.sqrt(norm) || 1;
		for (let k = 0; k < this.DIM; k++) c[k] /= norm;
		return c;
	}

	entry(i) {
		let d = this.docIdx[i];
		return {
			rowid: this.rowids[i],
			key: d >= 0 ? this.docs[d].key : null,
			fileName: d >= 0 ? this.docs[d].fileName : null,
			section: this.sections[i],
			sectionCount: d >= 0 ? this.docs[d].idx.length : 0,
		};
	}
};

/** The active model's index */
var SSVectorIndex = SSActiveProxy(() => SSModels.active.index, {
	onChange: fn => SSEvents.on('index', fn),
});
