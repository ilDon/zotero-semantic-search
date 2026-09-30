/* global Zotero, ChromeWorker, SSActiveProxy, SSModels, setTimeout, clearTimeout */
/* exported SSEmbedderImpl, SSEmbedder */

/**
 * Pool of embedding workers for one model. One dedicated worker answers
 * queries (so a search is never stuck behind a long document), up to N others
 * index documents. Idle workers are terminated to give memory back.
 */
var SSEmbedderImpl = class {
	constructor(space) {
		this.space = space;
		this.dim = space.spec.dim;
		this.QUERY_IDLE_MS = 15 * 60 * 1000;
		this.POOL_IDLE_MS = 60 * 1000;
		// watchdog: a worker silent for this long is considered stuck and restarted
		this.STALL_MS = 3 * 60 * 1000;
		this._query = null;
		this._pool = [];
		this._waiters = [];
		this._nextID = 1;
	}

	get poolSize() {
		let n = parseInt(Zotero.Prefs.get('extensions.semantic-search.workers', true));
		return Math.max(1, Math.min(8, Number.isFinite(n) ? n : 3));
	}

	_createWorker() {
		let w = {
			worker: new ChromeWorker('chrome://semantic-search/content/workers/embed-worker.js'),
			pending: new Map(),
			busy: false,
			lastUsed: Date.now(),
			timer: null,
		};
		w.ready = new Promise((resolve, reject) => {
			w.rejectReady = reject;
			w.worker.onmessage = (event) => {
				let m = event.data;
				if (m.type === 'ready') {
					clearTimeout(w.initTimer);
					return resolve();
				}
				if (m.type === 'init-error') {
					clearTimeout(w.initTimer);
					return reject(new Error(m.error));
				}
				let p = w.pending.get(m.id);
				if (!p) return;
				if (m.type === 'progress') {
					p.arm();
					if (p.onProgress) p.onProgress(m.done, m.total);
					return;
				}
				clearTimeout(p.timer);
				w.pending.delete(m.id);
				if (m.type === 'error') p.reject(new Error(m.error));
				else p.resolve(m);
			};
			w.worker.onerror = (e) => {
				let err = new Error('Embedding worker error: ' + e.message);
				reject(err);
				for (let p of w.pending.values()) p.reject(err);
				w.pending.clear();
				w.dead = true;
			};
		});
		let spec = this.space.spec;
		let files = this.space.files;
		w.worker.postMessage(spec.runtime === 'lealla'
			? {
				type: 'init',
				runtime: 'lealla',
				modelPath: files.modelPath,
				vocabPath: files.vocabPath,
				wasmURL: 'chrome://semantic-search/content/lealla.wasm',
				extraURL: 'chrome://semantic-search/content/model-extra.json',
			}
			: {
				type: 'init',
				runtime: 'xlmr',
				modelPath: files.modelPath,
				vocabPath: files.vocabPath,
				wasmURL: 'chrome://semantic-search/content/encoder.wasm',
				queryPrefix: spec.queryPrefix,
				passagePrefix: spec.passagePrefix,
				chunkPieces: spec.chunkPieces,
			});
		// Don't leave an unhandled rejection if nobody awaits yet
		w.ready.catch(() => {});
		w.initTimer = setTimeout(() => {
			Zotero.logError(new Error('Semantic Search: embedding worker did not start'));
			this._terminate(w, new Error('The embedding worker did not start'));
		}, this.STALL_MS);
		return w;
	}

	_call(w, message, transfer, onProgress) {
		let id = this._nextID++;
		return new Promise((resolve, reject) => {
			let p = { resolve, reject, onProgress, timer: null };
			// restarted on every progress message: only a silent worker trips it
			p.arm = () => {
				clearTimeout(p.timer);
				p.timer = setTimeout(() => {
					Zotero.logError(new Error(`Semantic Search: embedding worker stopped responding (${message.type})`));
					this._terminate(w, new Error('The embedding worker stopped responding'));
				}, this.STALL_MS);
			};
			p.arm();
			w.pending.set(id, p);
			w.worker.postMessage({ ...message, id }, transfer || []);
		});
	}

	_terminate(w, error = new Error('Worker terminated')) {
		if (w.timer) clearTimeout(w.timer);
		clearTimeout(w.initTimer);
		if (w.rejectReady) w.rejectReady(error); // no-op once started
		try {
			w.worker.terminate();
		}
		catch (e) {}
		for (let p of w.pending.values()) {
			clearTimeout(p.timer);
			p.reject(error);
		}
		w.pending.clear();
		w.dead = true;
	}

	_scheduleIdle(w, ms, onIdle) {
		if (w.timer) clearTimeout(w.timer);
		w.timer = setTimeout(() => {
			if (!w.busy && !w.dead) onIdle();
		}, ms);
	}

	async _queryWorker() {
		if (!this._query || this._query.dead) {
			if (!(await this.space.files.isReady())) {
				throw new Error('The embedding model is not downloaded yet');
			}
			this._query = this._createWorker();
		}
		let w = this._query;
		try {
			await w.ready;
		}
		catch (e) {
			this._terminate(w);
			if (this._query === w) this._query = null;
			throw e;
		}
		return w;
	}

	/** Warm up the query worker (loads the encoder weights) */
	async warmUp() {
		let w = await this._queryWorker();
		this._scheduleIdle(w, this.QUERY_IDLE_MS, () => {
			this._terminate(w);
			if (this._query === w) this._query = null;
		});
	}

	/** @returns {Promise<Float32Array[]>} one normalised vector per text */
	async embed(texts) {
		let w = await this._queryWorker();
		w.busy = true;
		try {
			let m = await this._call(w, { type: 'embed', texts });
			let out = [];
			for (let i = 0; i < texts.length; i++) {
				out.push(m.vectors.subarray(i * this.dim, (i + 1) * this.dim));
			}
			return out;
		}
		finally {
			w.busy = false;
			w.lastUsed = Date.now();
			this._scheduleIdle(w, this.QUERY_IDLE_MS, () => {
				this._terminate(w);
				if (this._query === w) this._query = null;
			});
		}
	}

	async embedOne(text) {
		return (await this.embed([text]))[0];
	}

	/**
	 * Embed a search query; long queries give one vector per segment.
	 * @returns {Promise<{vectors: Float32Array[], segments: string[]}>}
	 */
	async embedQuery(text) {
		let w = await this._queryWorker();
		w.busy = true;
		try {
			let m = await this._call(w, { type: 'query', text });
			let vectors = [];
			for (let i = 0; i < m.segments.length; i++) {
				vectors.push(m.vectors.subarray(i * this.dim, (i + 1) * this.dim));
			}
			return { vectors, segments: m.segments };
		}
		finally {
			w.busy = false;
			w.lastUsed = Date.now();
			this._scheduleIdle(w, this.QUERY_IDLE_MS, () => {
				this._terminate(w);
				if (this._query === w) this._query = null;
			});
		}
	}

	async _acquire() {
		for (;;) {
			this._pool = this._pool.filter((w) => !w.dead);
			let free = this._pool.find((w) => !w.busy);
			if (free) {
				free.busy = true;
				return free;
			}
			if (this._pool.length < this.poolSize) {
				if (!(await this.space.files.isReady())) {
					throw new Error('The embedding model is not downloaded yet');
				}
				let w = this._createWorker();
				w.busy = true;
				this._pool.push(w);
				return w;
			}
			await new Promise((resolve) => this._waiters.push(resolve));
		}
	}

	_release(w) {
		w.busy = false;
		w.lastUsed = Date.now();
		// Shrink if the pool size preference was lowered
		if (this._pool.filter((x) => !x.dead).length > this.poolSize) {
			this._terminate(w);
		}
		else {
			this._scheduleIdle(w, this.POOL_IDLE_MS, () => this._terminate(w));
		}
		let next = this._waiters.shift();
		if (next) next();
	}

	/**
	 * Chunk and embed a document.
	 * @param {string[]} pages
	 * @param {Function} [onProgress] (done, total)
	 * @param {Object} [control] - object whose `cancel` gets set to a function
	 * @returns {Promise<{chunks: Object[], vectors: Float32Array}>}
	 */
	async embedDocument(pages, onProgress, control) {
		let w = await this._acquire();
		try {
			await w.ready;
			let promise = this._call(w, { type: 'document', pages }, null, onProgress);
			if (control) {
				let id = this._nextID - 1;
				control.cancel = () => w.worker.postMessage({ type: 'cancel', id });
			}
			let m = await promise;
			return { chunks: m.chunks, vectors: m.vectors };
		}
		catch (e) {
			if (/init|worker error|did not start/i.test(e.message)) this._terminate(w);
			throw e;
		}
		finally {
			this._release(w);
		}
	}

	shutdown() {
		if (this._query) this._terminate(this._query);
		this._query = null;
		for (let w of this._pool) this._terminate(w);
		this._pool = [];
		for (let r of this._waiters) r();
		this._waiters = [];
	}
};

/** The active model's workers */
var SSEmbedder = SSActiveProxy(() => SSModels.active.embedder);
