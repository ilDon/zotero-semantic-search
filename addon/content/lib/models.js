/* global Zotero, IOUtils, PathUtils, SSModelFiles, SSLegacyEmbeddingStore, SSBlobEmbeddingStore, SSVectorIndexImpl, SSEmbedderImpl, SSIndexer, SSEvents */
/* exported SSModelRegistry, SSModels, SSEvents, SSActiveProxy */

/**
 * The embedding models the user can choose from, and the per-model "spaces"
 * (weights, passage database, vector index, embedding workers).
 *
 * Each model has its own passage database next to zotero.sqlite
 * (file_embeddings_<model>.db): vectors of different models cannot be mixed.
 * LEALLA-large is the model of the original app; its database keeps the
 * original format (it is the original file, renamed) and its code path is
 * unchanged.
 *
 * Switching model builds the new index in the background while searches keep
 * using the current one; the new model becomes active when every PDF has been
 * processed (or earlier, on request). Old indexes are kept until deleted.
 */

/** Tiny event hub shared by all spaces (UI listeners survive a model switch) */
var SSEvents = {
	_listeners: new Map(),

	on(channel, fn) {
		if (!this._listeners.has(channel)) this._listeners.set(channel, new Set());
		this._listeners.get(channel).add(fn);
		return () => this._listeners.get(channel).delete(fn);
	},

	emit(channel) {
		for (let fn of this._listeners.get(channel) || []) {
			try {
				fn();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},
};

var SS_MODEL_RELEASE = 'https://github.com/ilDon/zotero-semantic-search/releases/download/models-1/';
var SS_XLMR_TOKENIZER = {
	name: 'xlmr-tokenizer.json',
	size: 8579939,
	sha256: '16241a4a586b34ed74689274cd501978b04f8a512308a05f2b10953ea8d92045',
};

var SSModelRegistry = {
	order: ['lealla', 'e5-small', 'arctic-m-v2'],

	lealla: {
		id: 'lealla',
		label: 'LEALLA-large',
		runtime: 'lealla',
		storage: 'legacy',
		dim: 256,
		languages: 109,
		dbFile: 'file_embeddings_lealla.db',
		legacyDbFile: 'file_embeddings.db',
		minSimilarityPref: 'minSimilarity',
		// Defaults of the other models match the same percentiles of the scores of
		// matching / non-matching passages (benchmark on a real library)
		minSimilarity: 0.6,
		mcpMinSimilarity: 0.4,
		// query-length dependent guidance for LLM clients (see mcp.js)
		guidance: { paragraph: '0.6+', short: '0.45-0.55' },
		downloadMB: 595,
		source: 'https://huggingface.co/setu4993/LEALLA-large',
	},

	'e5-small': {
		id: 'e5-small',
		label: 'Multilingual E5 small',
		runtime: 'xlmr',
		storage: 'blob',
		dim: 384,
		languages: 94,
		dbFile: 'file_embeddings_e5-small.db',
		minSimilarityPref: 'minSimilarity.e5-small',
		// e5 compresses similarities into ~0.75-0.95: much higher thresholds
		minSimilarity: 0.87,
		mcpMinSimilarity: 0.84,
		guidance: { paragraph: '0.88+', short: '0.84-0.87' },
		queryPrefix: 'query: ',
		passagePrefix: 'passage: ',
		chunkPieces: 160,
		files: {
			weights: { name: 'e5-small-int8.ssew', size: 119459840, sha256: 'dd9c8cf3fe407a23e22e0e210b57d3b0e025ecfc49d2da178064b365d53b62d2' },
			tokenizer: SS_XLMR_TOKENIZER,
		},
		baseURL: SS_MODEL_RELEASE,
		downloadMB: 128,
		source: 'https://huggingface.co/intfloat/multilingual-e5-small',
	},

	'arctic-m-v2': {
		id: 'arctic-m-v2',
		label: 'Arctic Embed M v2',
		runtime: 'xlmr',
		storage: 'blob',
		dim: 256,
		languages: 74,
		dbFile: 'file_embeddings_arctic-m-v2.db',
		minSimilarityPref: 'minSimilarity.arctic-m-v2',
		minSimilarity: 0.58,
		mcpMinSimilarity: 0.45,
		guidance: { paragraph: '0.6+', short: '0.45-0.55' },
		queryPrefix: 'query: ',
		passagePrefix: '',
		chunkPieces: 160,
		files: {
			weights: { name: 'arctic-m-v2-int8.ssew', size: 307117888, sha256: '4c4bf5dce8dee817ec891e462d04692ddc47884cd32aea38b086d2eacd9446e5' },
			tokenizer: SS_XLMR_TOKENIZER,
		},
		baseURL: SS_MODEL_RELEASE,
		downloadMB: 316,
		source: 'https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0',
	},

	get(id) {
		return this.order.includes(id) ? this[id] : null;
	},
};

/**
 * Forward property access to the object returned by `getTarget()` (the active
 * model's instance), so callers can keep using one global name.
 */
function SSActiveProxy(getTarget, own = {}) {
	return new Proxy(own, {
		get(target, prop) {
			if (prop in target) return target[prop];
			let t = getTarget();
			let v = t[prop];
			return typeof v === 'function' ? v.bind(t) : v;
		},
		set(target, prop, value) {
			getTarget()[prop] = value;
			return true;
		},
	});
}

var SSSpace = class {
	constructor(spec) {
		this.id = spec.id;
		this.spec = spec;
		this.files = new SSModelFiles(spec);
		this._store = null;
		this._index = null;
		this._embedder = null;
	}

	get dbPath() {
		return SSModels.dbPath(this.id);
	}

	get store() {
		if (!this._store) {
			this._store = this.spec.storage === 'legacy'
				? new SSLegacyEmbeddingStore(this)
				: new SSBlobEmbeddingStore(this);
		}
		return this._store;
	}

	get index() {
		if (!this._index) this._index = new SSVectorIndexImpl(this);
		return this._index;
	}

	get embedder() {
		if (!this._embedder) this._embedder = new SSEmbedderImpl(this);
		return this._embedder;
	}

	get minSimilarity() {
		let v = parseFloat(Zotero.Prefs.get('extensions.semantic-search.' + this.spec.minSimilarityPref, true));
		return Number.isFinite(v) ? v : this.spec.minSimilarity;
	}

	set minSimilarity(v) {
		Zotero.Prefs.set('extensions.semantic-search.' + this.spec.minSimilarityPref, Number(v).toFixed(2), true);
	}

	async indexExists() {
		return IOUtils.exists(this.dbPath);
	}

	/** Free memory: stop the workers and drop the in-memory index */
	async release() {
		if (this._embedder) this._embedder.shutdown();
		if (this._index) {
			try {
				await this._index.flush();
			}
			catch (e) {
				Zotero.logError(e);
			}
			this._index.unload();
		}
	}

	async close() {
		await this.release();
		if (this._store) await this._store.close();
	}
};

var SSModels = {
	PREF: 'extensions.semantic-search.model',
	BUILD_PREF: 'extensions.semantic-search.model.building',
	registry: SSModelRegistry,
	_spaces: new Map(),

	/** Directory of the passage databases (the Zotero data directory by default) */
	get dataDir() {
		let custom = Zotero.Prefs.get('extensions.semantic-search.dbPath', true);
		return custom ? PathUtils.parent(custom) : Zotero.DataDirectory.dir;
	},

	/** Path of a model's passage database */
	dbPath(id) {
		let spec = this.registry.get(id);
		// A custom database path (older setting) always meant the LEALLA database
		let custom = Zotero.Prefs.get('extensions.semantic-search.dbPath', true);
		if (id === 'lealla' && custom) return custom;
		return PathUtils.join(this.dataDir, spec.dbFile);
	},

	space(id) {
		let s = this._spaces.get(id);
		if (!s) {
			let spec = this.registry.get(id);
			if (!spec) throw new Error('Unknown embedding model: ' + id);
			s = new SSSpace(spec);
			this._spaces.set(id, s);
		}
		return s;
	},

	get activeId() {
		let id = Zotero.Prefs.get(this.PREF, true);
		return this.registry.get(id) ? id : 'lealla';
	},

	get active() {
		return this.space(this.activeId);
	},

	get buildingId() {
		let id = Zotero.Prefs.get(this.BUILD_PREF, true);
		return id && id !== this.activeId && this.registry.get(id) ? id : null;
	},

	get building() {
		let id = this.buildingId;
		return id ? this.space(id) : null;
	},

	/** Spaces that indexing keeps up to date */
	targets() {
		let t = [this.active];
		if (this.building) t.push(this.building);
		return t;
	},

	/**
	 * First run: users of the original app or of an earlier version keep
	 * LEALLA-large; new users start with multilingual-e5-small.
	 */
	async init() {
		if (this.registry.get(Zotero.Prefs.get(this.PREF, true))) return;
		let hasLealla = await IOUtils.exists(this.dbPath('lealla'))
			|| await IOUtils.exists(PathUtils.join(this.dataDir, this.registry.lealla.legacyDbFile));
		Zotero.Prefs.set(this.PREF, hasLealla ? 'lealla' : 'e5-small', true);
	},

	/**
	 * Choose a model. If it is the active one, any build in progress is
	 * cancelled; otherwise its index is built (or brought up to date) in the
	 * background and it becomes active when done.
	 */
	async choose(id) {
		if (!this.registry.get(id)) throw new Error('Unknown embedding model: ' + id);
		if (id === this.activeId) {
			await this.cancelBuild();
			return;
		}
		let previous = this.buildingId;
		Zotero.Prefs.set(this.BUILD_PREF, id, true);
		if (previous && previous !== id) {
			SSIndexer.dropTarget(previous);
			await this.space(previous).release();
		}
		SSEvents.emit('models');
		let space = this.space(id);
		await space.files.ensureDownloaded();
		if (this.buildingId !== id) return;
		await SSIndexer.indexNew();
	},

	async cancelBuild() {
		let id = this.buildingId;
		Zotero.Prefs.set(this.BUILD_PREF, '', true);
		if (!id) return;
		SSIndexer.dropTarget(id);
		this.space(id).files.cancelDownload();
		await this.space(id).release();
		SSEvents.emit('models');
	},

	/** Make the model being built the active one (its index may be partial) */
	async promote() {
		let id = this.buildingId;
		if (!id) return;
		let old = this.active;
		Zotero.Prefs.set(this.PREF, id, true);
		Zotero.Prefs.set(this.BUILD_PREF, '', true);
		await old.release();
		SSEvents.emit('models');
		SSEvents.emit('index');
		SSEvents.emit('model');
		try {
			await this.active.index.load();
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	/** Called by the indexer when a full pass over the library has finished */
	async onPassComplete() {
		if (this.buildingId) await this.promote();
	},

	/** Size on disk of each model's database, for the preferences */
	async indexes() {
		let out = [];
		for (let id of this.registry.order) {
			let path = this.dbPath(id);
			let size = 0;
			try {
				size = (await IOUtils.stat(path)).size;
			}
			catch (e) {
				continue;
			}
			out.push({ id, label: this.registry[id].label, path, size, active: id === this.activeId, building: id === this.buildingId });
		}
		return out;
	},

	/** Delete the database and caches of a model that is neither active nor being built */
	async deleteIndex(id) {
		if (id === this.activeId || id === this.buildingId) throw new Error('This index is in use');
		let space = this.space(id);
		await space.close();
		let path = this.dbPath(id);
		for (let suffix of ['', '-journal', '-wal', '-shm']) {
			await IOUtils.remove(path + suffix, { ignoreAbsent: true });
		}
		await IOUtils.remove(space.index.cachePath, { ignoreAbsent: true });
		this._spaces.delete(id);
		SSEvents.emit('models');
	},

	/** Remove a document from every model's index (exclusion, deleted item) */
	async deleteDocumentEverywhere(key) {
		for (let id of this.registry.order) {
			let space = this.space(id);
			if (!(await space.indexExists())) continue;
			try {
				await space.store.deleteDocument(key);
				space.index.removeDocument(key);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},

	async shutdown() {
		for (let s of this._spaces.values()) {
			try {
				s.files.cancelDownload();
				await s.close();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		this._spaces.clear();
	},
};
