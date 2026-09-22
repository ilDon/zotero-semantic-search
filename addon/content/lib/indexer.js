/* global Zotero, PathUtils, SSStore, SSVectorIndex, SSEmbedder, SSModelManager, SSPassages */
/* exported SSIndexer */

/**
 * Incremental indexing of PDF attachments.
 *
 * A document is "processed" when its key (= storage folder name) is in the
 * embeddings table or in the excluded table — same rule as the original app,
 * so everything indexed by it is kept and only new PDFs are processed.
 */
var SSIndexer = {
	state: 'idle', // idle | scanning | indexing | paused
	queue: [], // [{itemID, key, title}]
	current: new Map(), // key -> {title, done, total, control}
	stats: { done: 0, failed: 0, excluded: 0, total: 0 },
	lastError: null,
	_listeners: new Set(),
	_running: null,
	_paused: false,
	_notifierID: null,
	_pendingNew: new Map(), // itemID -> timer

	onChange(fn) {
		this._listeners.add(fn);
		return () => this._listeners.delete(fn);
	},

	_emit() {
		for (let fn of this._listeners) {
			try {
				fn();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},

	status() {
		return {
			state: this.state,
			queued: this.queue.length,
			current: [...this.current.entries()].map(([key, c]) => ({ key, title: c.title, done: c.done, total: c.total })),
			stats: { ...this.stats },
			lastError: this.lastError,
		};
	},

	/** All PDF attachments with a file on disk that are neither indexed nor excluded */
	async findUnprocessed() {
		let rows = await Zotero.DB.queryAsync(
			`SELECT IA.itemID, I.key, I.libraryID FROM itemAttachments IA
			JOIN items I USING (itemID)
			WHERE IA.contentType = 'application/pdf'
			AND IA.linkMode != ?
			AND IA.itemID NOT IN (SELECT itemID FROM deletedItems)`,
			[Zotero.Attachments.LINK_MODE_LINKED_URL]
		);
		let indexed = await SSStore.getIndexedIDs();
		let excluded = await SSStore.getExcludedIDs();
		let out = [];
		for (let r of rows) {
			if (indexed.has(r.key) || excluded.has(r.key)) continue;
			out.push({ itemID: r.itemID, key: r.key, libraryID: r.libraryID });
		}
		return out;
	},

	/** Scan the library and index everything new. */
	async indexNew() {
		if (this.state === 'scanning') return;
		if (!(await SSModelManager.isReady())) throw new Error('The embedding model has not been downloaded yet.');
		this.state = 'scanning';
		this._emit();
		try {
			let todo = await this.findUnprocessed();
			let queued = new Set(this.queue.map(q => q.key));
			for (let t of todo) {
				if (!queued.has(t.key) && !this.current.has(t.key)) this.queue.push(t);
			}
			this.stats.total = this.stats.done + this.stats.failed + this.stats.excluded
				+ this.queue.length + this.current.size;
		}
		finally {
			this.state = this._running ? 'indexing' : 'idle';
			this._emit();
		}
		this._start();
		return this.queue.length;
	},

	/** Index (or re-index) specific attachments now */
	async indexItems(attachments, { force = false } = {}) {
		if (!(await SSModelManager.isReady())) throw new Error('The embedding model has not been downloaded yet.');
		for (let a of attachments) {
			if (!a.isPDFAttachment || !a.isPDFAttachment()) continue;
			if (force) {
				await SSStore.removeExcluded(a.key);
			}
			if (this.current.has(a.key) || this.queue.some(q => q.key === a.key)) continue;
			// priority: front of the queue
			this.queue.unshift({ itemID: a.id, key: a.key, libraryID: a.libraryID, force });
			this.stats.total++;
		}
		this._emit();
		this._start();
	},

	pause() {
		this._paused = true;
		this.state = 'paused';
		this._emit();
	},

	resume() {
		this._paused = false;
		if (this.queue.length || this.current.size) this.state = 'indexing';
		this._emit();
		this._start();
	},

	cancel() {
		this.queue = [];
		for (let c of this.current.values()) {
			if (c.control.cancel) c.control.cancel();
		}
		this._paused = false;
		this._emit();
	},

	_start() {
		if (this._running || this._paused || !this.queue.length) return;
		this.state = 'indexing';
		this.lastError = null;
		this._emit();
		this._running = (async () => {
			let lanes = [];
			let n = SSEmbedder.poolSize;
			for (let i = 0; i < n; i++) lanes.push(this._lane());
			await Promise.all(lanes);
		})().finally(async () => {
			this._running = null;
			this.state = this._paused ? 'paused' : 'idle';
			if (!this.queue.length && !this._paused) {
				this.stats = { done: 0, failed: 0, excluded: 0, total: 0 };
			}
			try {
				await SSVectorIndex.flush();
			}
			catch (e) {
				Zotero.logError(e);
			}
			this._emit();
		});
	},

	async _lane() {
		while (!this._paused && this.queue.length) {
			let job = this.queue.shift();
			try {
				await this._indexOne(job);
			}
			catch (e) {
				this.stats.failed++;
				this.lastError = `${job.key}: ${e.message}`;
				Zotero.logError(e);
			}
			this._emit();
		}
	},

	async _indexOne(job) {
		let item = await Zotero.Items.getAsync(job.itemID);
		if (!item || item.deleted || !item.isPDFAttachment()) return;
		if (!job.force) {
			if (await SSStore.getExclusion(item.key)) return;
		}
		let path = await item.getFilePathAsync();
		if (!path) {
			// File not available locally (not synced/downloaded yet): try again another time
			return;
		}
		let title = (item.parentItem || item).getDisplayTitle();
		let control = {};
		let entry = { title, done: 0, total: 0, control };
		this.current.set(item.key, entry);
		this._emit();
		try {
			let res;
			try {
				res = await Zotero.PDFWorker.getFullText(item.id, null);
			}
			catch (e) {
				let reason = /password/i.test(e.name + ' ' + e.message) ? 'encrypted' : 'unreadable';
				await this._exclude(item.key, reason);
				return;
			}
			let pages = (res && res.text ? res.text : '').split('\f');
			if (pages.join('').replace(/\s+/g, '').length < 100) {
				await this._exclude(item.key, 'no_text');
				return;
			}
			let { chunks, vectors } = await SSEmbedder.embedDocument(pages, (done, total) => {
				entry.done = done;
				entry.total = total;
				this._emit();
			}, control);
			if (!chunks.length) {
				await this._exclude(item.key, 'no_text');
				return;
			}
			let fileName = PathUtils.filename(path);
			let rowids = await SSStore.insertDocument(item.key, fileName, chunks, vectors, 2);
			await SSVectorIndex.addDocument(item.key, fileName, rowids, vectors);
			this.stats.done++;
		}
		catch (e) {
			if (e.message === 'cancelled') return;
			throw e;
		}
		finally {
			this.current.delete(item.key);
			this._emit();
		}
	},

	async _exclude(key, reason) {
		await SSStore.addExcluded(key, reason);
		SSVectorIndex.removeDocument(key);
		this.stats.excluded++;
	},

	/** Exclude documents manually (removes their passages, like the original app) */
	async exclude(keys, reason = 'manual') {
		for (let key of keys) {
			await SSStore.addExcluded(key, reason);
			SSVectorIndex.removeDocument(key);
		}
		this._emit();
	},

	async include(keys) {
		for (let key of keys) await SSStore.removeExcluded(key);
		this._emit();
		if (this.autoIndex) {
			let items = [];
			for (let key of keys) {
				let item = await SSPassages.getItemByKey(key);
				if (item) items.push(item);
			}
			await this.indexItems(items);
		}
	},

	get autoIndex() {
		return !!Zotero.Prefs.get('extensions.semantic-search.autoIndex', true);
	},

	// ---- watch the library for new PDFs ----

	registerNotifier() {
		if (this._notifierID) return;
		this._notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids, extraData) => {
				if (type !== 'item') return;
				if (event === 'add' || event === 'modify') {
					if (!this.autoIndex) return;
					for (let id of ids) this._scheduleNew(id);
				}
				else if (event === 'delete') {
					// Permanently deleted items: drop their passages
					for (let id of ids) {
						let key = extraData && extraData[id] && extraData[id].key;
						if (key && SSVectorIndex.hasDocument(key)) {
							SSStore.deleteDocument(key).catch(e => Zotero.logError(e));
							SSVectorIndex.removeDocument(key);
						}
					}
				}
			},
		}, ['item'], 'semanticSearch');
	},

	unregisterNotifier() {
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
		}
		for (let t of this._pendingNew.values()) clearTimeout(t);
		this._pendingNew.clear();
	},

	_scheduleNew(id) {
		if (this._pendingNew.has(id)) clearTimeout(this._pendingNew.get(id));
		// Wait a bit: the file of a new attachment may still be downloading/syncing
		this._pendingNew.set(id, setTimeout(async () => {
			this._pendingNew.delete(id);
			try {
				let item = await Zotero.Items.getAsync(id);
				if (!item || !item.isPDFAttachment() || item.deleted) return;
				if (SSVectorIndex.hasDocument(item.key)) return;
				if (await SSStore.getExclusion(item.key)) return;
				if (!(await SSStore.getDocumentInfo(item.key)) && await item.getFilePathAsync()
						&& await SSModelManager.isReady()) {
					await this.indexItems([item]);
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
		}, 20000));
	},
};
