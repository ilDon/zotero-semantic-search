/* global Zotero, PathUtils, IOUtils, SSStore, SSEmbedder, SSModels, SSPassages, SSEvents */
/* exported SSIndexer */

/**
 * Incremental indexing of PDF attachments.
 *
 * A document is "processed" for a model when its key (= storage folder name)
 * is in that model's passage database, or in the excluded table — same rule
 * as the original app, so everything indexed by it is kept and only new PDFs
 * are processed.
 *
 * Indexing keeps the active model up to date. While the user is switching
 * model, full passes build the new model's index instead, and newly added PDFs
 * go to both (their text is extracted once). When a full pass over the library
 * ends, the new model becomes the active one (see SSModels).
 */
var SSIndexer = {
	state: 'idle', // idle | scanning | indexing | paused
	queue: [], // [{itemID, key, libraryID, targets: [modelID], force}]
	current: new Map(), // key -> {title, done, total, control, model}
	stats: { done: 0, failed: 0, excluded: 0, total: 0 },
	build: null, // {model, done, total}: progress of the model being built
	lastError: null,
	_running: null,
	_paused: false,
	_pass: null, // model ids of the full pass in progress (indexNew)
	_notifierID: null,
	_pendingNew: new Map(), // itemID -> timer

	onChange(fn) {
		return SSEvents.on('indexer', fn);
	},

	_emit() {
		SSEvents.emit('indexer');
	},

	status() {
		return {
			state: this.state,
			queued: this.queue.length,
			current: [...this.current.entries()].map(([key, c]) => ({ key, title: c.title, done: c.done, total: c.total, model: c.model })),
			stats: { ...this.stats },
			build: this.build ? { ...this.build } : null,
			lastError: this.lastError,
		};
	},

	/** Models to index into: the active one and the one being built, if downloaded */
	async _targets() {
		let out = [];
		for (let space of SSModels.targets()) {
			if (await space.files.isReady()) out.push(space);
		}
		return out;
	},

	/** PDF attachments with a file on disk (not in the trash) */
	async _pdfAttachments() {
		return Zotero.DB.queryAsync(
			`SELECT IA.itemID, I.key, I.libraryID FROM itemAttachments IA
			JOIN items I USING (itemID)
			WHERE IA.contentType = 'application/pdf'
			AND IA.linkMode != ?
			AND IA.itemID NOT IN (SELECT itemID FROM deletedItems)`,
			[Zotero.Attachments.LINK_MODE_LINKED_URL]
		);
	},

	/**
	 * PDF attachments that are not excluded and missing from at least one model.
	 * @param {Object} [opts] - {activeOnly}: only look at the active model
	 * @returns {Promise<Object[]>} jobs {itemID, key, libraryID, targets}
	 */
	async findUnprocessed(opts = {}) {
		let spaces = opts.activeOnly ? [SSModels.active] : (opts.spaces || await this._targets());
		let rows = await this._pdfAttachments();
		let excluded = await SSStore.getExcludedIDs();
		let indexed = await Promise.all(spaces.map(s => s.store.getIndexedIDs()));
		let out = [];
		for (let r of rows) {
			if (excluded.has(r.key)) continue;
			let targets = spaces.filter((s, i) => !indexed[i].has(r.key)).map(s => s.id);
			if (targets.length) out.push({ itemID: r.itemID, key: r.key, libraryID: r.libraryID, targets });
		}
		return out;
	},

	/** Scan the library and index everything new (a full pass). */
	async indexNew() {
		if (this.state === 'scanning') return 0;
		if (!(await SSModels.active.files.isReady())) throw new Error('The embedding model has not been downloaded yet.');
		this.state = 'scanning';
		this._emit();
		let spaces = await this._targets();
		// During a model switch the full pass fills the new model's index; the active
		// one only receives newly added PDFs (see indexItems), since it is about to be
		// replaced (and may be partial, after "Use it now")
		let building = spaces.find(s => s.id === SSModels.buildingId);
		if (building) spaces = [building];
		try {
			let todo = await this.findUnprocessed({ spaces });
			let queued = new Map(this.queue.map(q => [q.key, q]));
			for (let t of todo) {
				let q = queued.get(t.key);
				if (q) {
					q.targets = [...new Set([...(q.targets || []), ...t.targets])];
				}
				else if (!this.current.has(t.key)) {
					this.queue.push(t);
				}
			}
			if (building) {
				let total = (await this._pdfAttachments()).length - (await SSStore.getExcludedIDs()).size;
				let missing = todo.length;
				this.build = { model: building.id, total: Math.max(total, missing), done: Math.max(0, total - missing) };
			}
			else {
				this.build = null;
			}
			this._pass = new Set(spaces.map(s => s.id));
			this.stats.total = this.stats.done + this.stats.failed + this.stats.excluded
				+ this.queue.length + this.current.size;
		}
		finally {
			this.state = this._running ? 'indexing' : 'idle';
			this._emit();
		}
		this._start();
		// nothing to do: the pass is already over
		if (!this._running && !this.queue.length && !this._paused) this._passEnded();
		return this.queue.length;
	},

	/** Index (or re-index) specific attachments now, in every model being maintained */
	async indexItems(attachments, { force = false } = {}) {
		if (!(await SSModels.active.files.isReady())) throw new Error('The embedding model has not been downloaded yet.');
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

	/** Stop indexing into a model (build cancelled or replaced) */
	dropTarget(id) {
		for (let q of this.queue) {
			if (q.targets) q.targets = q.targets.filter(t => t !== id);
		}
		this.queue = this.queue.filter(q => !q.targets || q.targets.length);
		for (let c of this.current.values()) {
			if (c.model === id && c.control.cancel) c.control.cancel();
		}
		if (this._pass) this._pass.delete(id);
		if (this.build && this.build.model === id) this.build = null;
		this._emit();
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
		this._pass = null;
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
			for (let space of SSModels.targets()) {
				try {
					await space.index.flush();
				}
				catch (e) {
					Zotero.logError(e);
				}
			}
			this._emit();
			if (!this.queue.length && !this._paused) this._passEnded();
		});
	},

	/** A full pass is over: a model being built becomes the active one */
	_passEnded() {
		let pass = this._pass;
		this._pass = null;
		let building = SSModels.buildingId;
		if (pass && building && pass.has(building)) {
			this.build = null;
			SSModels.onPassComplete().catch(e => Zotero.logError(e));
		}
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
			this._countBuild(job);
			this._emit();
		}
	},

	_countBuild(job) {
		if (this.build && (!job.targets || job.targets.includes(this.build.model))) {
			this.build.done = Math.min(this.build.total, this.build.done + 1);
		}
	},

	/** Text of a PDF, pages separated: our text cache first, else Zotero's PDF worker */
	async _pages(item) {
		let cachePath = PathUtils.join(SSPassages.textCacheDir, item.key + '.txt');
		try {
			if (await IOUtils.exists(cachePath)) return (await IOUtils.readUTF8(cachePath)).split('\f');
		}
		catch (e) {}
		let res = await Zotero.PDFWorker.getFullText(item.id, null);
		return (res && res.text ? res.text : '').split('\f');
	},

	async _indexOne(job) {
		let item = await Zotero.Items.getAsync(job.itemID);
		if (!item || item.deleted || !item.isPDFAttachment()) return;
		if (!job.force) {
			if (await SSStore.getExclusion(item.key)) return;
		}
		// Models to index into (the job's, if still maintained; otherwise all)
		let live = await this._targets();
		let spaces = job.targets ? live.filter(s => job.targets.includes(s.id)) : live;
		if (!job.force) {
			let missing = [];
			for (let s of spaces) {
				if (!(await s.store.getDocumentInfo(item.key))) missing.push(s);
			}
			spaces = missing;
		}
		if (!spaces.length) return;
		let path = await item.getFilePathAsync();
		if (!path) {
			// File not available locally (not synced/downloaded yet): try again another time
			return;
		}
		let title = (item.parentItem || item).getDisplayTitle();
		let control = {};
		let entry = { title, done: 0, total: 0, control, model: spaces[0].id };
		this.current.set(item.key, entry);
		this._emit();
		try {
			let pages;
			try {
				pages = await this._pages(item);
			}
			catch (e) {
				let reason = /password/i.test(e.name + ' ' + e.message) ? 'encrypted' : 'unreadable';
				await this._exclude(item.key, reason);
				return;
			}
			if (pages.join('').replace(/\s+/g, '').length < 100) {
				await this._exclude(item.key, 'no_text');
				return;
			}
			let fileName = PathUtils.filename(path);
			for (let space of spaces) {
				// the model may have been dropped meanwhile (build cancelled)
				if (!SSModels.targets().includes(space)) continue;
				entry.model = space.id;
				entry.done = 0;
				entry.total = 0;
				let { chunks, vectors } = await space.embedder.embedDocument(pages, (done, total) => {
					entry.done = done;
					entry.total = total;
					this._emit();
				}, control);
				if (!chunks.length) {
					await this._exclude(item.key, 'no_text');
					return;
				}
				let rowids = await space.store.insertDocument(item.key, fileName, chunks, vectors, 2);
				await space.index.addDocument(item.key, fileName, rowids, vectors);
			}
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
		this.stats.excluded++;
	},

	/** Exclude documents manually (removes their passages, like the original app) */
	async exclude(keys, reason = 'manual') {
		for (let key of keys) {
			await SSStore.addExcluded(key, reason);
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
						if (key) SSModels.deleteDocumentEverywhere(key).catch(e => Zotero.logError(e));
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
				if (SSModels.active.index.hasDocument(item.key)) return;
				if (await SSStore.getExclusion(item.key)) return;
				if (!(await SSModels.active.store.getDocumentInfo(item.key)) && await item.getFilePathAsync()
						&& await SSModels.active.files.isReady()) {
					await this.indexItems([item]);
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
		}, 20000));
	},
};
