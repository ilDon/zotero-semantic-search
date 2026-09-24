/* global Zotero, window, document, Services */
// Loaded in a sandbox whose prototype is the preferences window: expose on window
window.SemanticSearchPrefs = {
	PREFIX: 'extensions.semantic-search.',

	get S() {
		return Zotero.SemanticSearch;
	},

	$(id) {
		return document.getElementById(id);
	},

	pref(name) {
		return Zotero.Prefs.get(this.PREFIX + name, true);
	},

	setPref(name, value) {
		Zotero.Prefs.set(this.PREFIX + name, value, true);
	},

	init() {
		if (!this.S) return;
		let minSim = this.$('semsearch-min-similarity');
		// the threshold is per model: similarity scales differ between models
		minSim.value = this.S.models.active.minSimilarity.toFixed(2);
		minSim.addEventListener('change', () => {
			let v = parseFloat(minSim.value);
			if (Number.isFinite(v) && v > 0 && v < 1) this.S.models.active.minSimilarity = v;
		});
		this._initModel();
		this._intPref('semsearch-max-results', 'maxResults', 10, 5000);
		this._intPref('semsearch-workers', 'workers', 1, 8);
		this._boolPref('semsearch-auto-index', 'autoIndex');
		let langs = this.$('semsearch-ocr-languages');
		langs.value = this.pref('ocr.languages') || 'ita+eng';
		langs.addEventListener('change', () => {
			let v = langs.value.trim().replace(/\s+/g, '');
			if (/^[a-z_]+(\+[a-z_]+)*$/i.test(v)) this.setPref('ocr.languages', v);
			else langs.value = this.pref('ocr.languages');
		});
		this._boolPref('semsearch-mcp-enabled', 'mcp.enabled');

		let cfg = this.S.mcp.clientConfig();
		this.$('semsearch-mcp-url').value = this.S.mcp.url;
		this.$('semsearch-mcp-claude-code').value = cfg.claudeCode;
		this.$('semsearch-mcp-desktop').value = cfg.claudeDesktop;
		for (let b of document.querySelectorAll('#semsearch-prefpane .ss-copy')) {
			b.addEventListener('click', () => {
				Zotero.Utilities.Internal.copyTextToClipboard(this.$(b.dataset.copy).value);
			});
		}
		this.$('semsearch-db-path').textContent = this.S.models.active.dbPath;

		this.$('semsearch-model-download').addEventListener('click', () => {
			this.S.model.ensureDownloaded().catch(e => Zotero.logError(e));
		});
		this.$('semsearch-index-new').addEventListener('click', async () => {
			try {
				await this.S.index.load();
				await this.S.indexer.indexNew();
			}
			catch (e) {
				this._error(e);
			}
		});
		this.$('semsearch-upgrade-legacy').addEventListener('click', () => this.upgradeLegacy());
		this.$('semsearch-rebuild-cache').addEventListener('click', async (e) => {
			e.target.disabled = true;
			try {
				await this.S.index.rebuild();
			}
			catch (err) {
				this._error(err);
			}
			e.target.disabled = false;
		});

		let refresh = this._throttle(() => this.refresh(), 500);
		let unsub = [
			this.S.model.onChange(refresh),
			this.S.index.onChange(refresh),
			this.S.indexer.onChange(refresh),
			this.S.events.on('models', () => {
				this.$('semsearch-min-similarity').value = this.S.models.active.minSimilarity.toFixed(2);
				this.$('semsearch-db-path').textContent = this.S.models.active.dbPath;
				refresh();
			}),
		];
		window.addEventListener('unload', () => unsub.forEach(fn => fn()), { once: true });
		this.refresh();
	},

	_intPref(id, name, min, max) {
		let el = this.$(id);
		el.value = this.pref(name);
		el.addEventListener('change', () => {
			let v = parseInt(el.value);
			if (Number.isFinite(v)) this.setPref(name, Math.max(min, Math.min(max, v)));
		});
	},

	_boolPref(id, name) {
		let el = this.$(id);
		el.checked = !!this.pref(name);
		el.addEventListener('change', () => this.setPref(name, el.checked));
	},

	_throttle(fn, ms) {
		let t = null;
		return () => {
			if (t) return;
			t = setTimeout(() => {
				t = null;
				fn();
			}, ms);
		};
	},

	_error(e) {
		Zotero.logError(e);
		Services.prompt.alert(window, 'Semantic Search', String(e.message || e));
	},

	// ------------------------------------------------------------ model choice

	_initModel() {
		let select = this.$('semsearch-model-select');
		select.value = this.S.models.buildingId || this.S.models.activeId;
		select.addEventListener('change', () => this.chooseModel(select.value));
		this.$('semsearch-build-use-now').addEventListener('click', () => {
			this.S.models.promote().catch(e => this._error(e));
		});
		this.$('semsearch-build-cancel').addEventListener('click', async () => {
			try {
				await this.S.models.cancelBuild();
			}
			catch (e) {
				this._error(e);
			}
			this.$('semsearch-model-select').value = this.S.models.activeId;
			this.refresh();
		});
		this.$('semsearch-build-resume').addEventListener('click', () => {
			let id = this.S.models.buildingId;
			if (id) this.S.models.choose(id).catch(e => this._error(e));
		});
		this.$('semsearch-migration-show').addEventListener('click', () => {
			let notice = this.S.store.migrationNotice;
			if (notice) Zotero.File.reveal(notice.legacy);
		});
	},

	_label(id) {
		return this.S.models.registry[id].label;
	},

	async chooseModel(id) {
		let models = this.S.models;
		let select = this.$('semsearch-model-select');
		if (id === models.activeId || id === models.buildingId) {
			if (id === models.activeId && models.buildingId) await models.cancelBuild();
			this.refresh();
			return;
		}
		let space = models.space(id);
		let args = {
			model: this._label(id),
			current: this._label(models.activeId),
			size: String(space.spec.downloadMB),
		};
		let exists = await space.indexExists();
		let parts = [await document.l10n.formatValue('semsearch-model-switch-title', args)];
		if (exists) {
			parts.push(await document.l10n.formatValue('semsearch-model-switch-existing', args));
		}
		else {
			parts.push(await document.l10n.formatValue('semsearch-model-switch-new', args));
			parts.push(await document.l10n.formatValue('semsearch-model-switch-keep', args));
		}
		if (!Services.prompt.confirm(window, 'Semantic Search', parts.join('\n\n'))) {
			select.value = models.buildingId || models.activeId;
			return;
		}
		models.choose(id).catch(e => this._error(e)).finally(() => this.refresh());
		this.refresh();
	},

	_formatSize(bytes) {
		if (bytes >= 1e9) return (bytes / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' GB';
		return Math.max(1, Math.round(bytes / 1e6)).toLocaleString() + ' MB';
	},

	async refreshModel() {
		let models = this.S.models;
		let select = this.$('semsearch-model-select');
		let shown = models.buildingId || models.activeId;
		if (document.activeElement !== select) select.value = shown;
		let info = this.$('semsearch-model-info');
		document.l10n.setAttributes(info, 'semsearch-model-info-' + select.value,
			{ size: String(models.registry[select.value].downloadMB) });

		// model switch in progress
		let box = this.$('semsearch-build');
		let building = models.building;
		box.hidden = !building;
		if (building) {
			let status = this.$('semsearch-build-status');
			let progress = this.$('semsearch-build-progress');
			let dl = await building.files.status();
			let build = this.S.indexer.status().build;
			let args = { model: building.spec.label, current: models.active.spec.label };
			let running = this.S.indexer.status().state !== 'idle';
			this.$('semsearch-build-resume').hidden = true;
			if (dl.state === 'downloading') {
				let p = dl.progress || {};
				let pct = p.total ? Math.floor(100 * p.received / p.total) : 0;
				document.l10n.setAttributes(status, 'semsearch-build-downloading', { ...args, percent: pct });
				progress.max = 100;
				progress.value = pct;
			}
			else if (build && build.model === building.id) {
				document.l10n.setAttributes(status, 'semsearch-build-status', {
					...args, done: build.done.toLocaleString(), total: build.total.toLocaleString(),
				});
				progress.max = build.total || 1;
				progress.value = build.done;
				this.$('semsearch-build-resume').hidden = running;
			}
			else {
				document.l10n.setAttributes(status, dl.state === 'error' ? 'semsearch-model-error' : 'semsearch-build-waiting',
					{ ...args, error: dl.error });
				progress.removeAttribute('value');
				this.$('semsearch-build-resume').hidden = running || dl.state === 'downloading';
			}
		}

		// indexes on disk (redrawn only when something changed, translated before
		// being shown: this runs every half second while indexing)
		let list = this.$('semsearch-indexes');
		let indexes = await models.indexes();
		let signature = JSON.stringify(indexes.map(ix => [ix.id, this._formatSize(ix.size), ix.active, ix.building]));
		let rows = [];
		if (indexes.length) {
			let title = document.createElement('div');
			document.l10n.setAttributes(title, 'semsearch-indexes');
			rows.push(title);
		}
		for (let ix of indexes) {
			let row = document.createElement('div');
			row.className = 'ss-index-row';
			let label = document.createElement('span');
			document.l10n.setAttributes(label, 'semsearch-index-row', { model: ix.label, size: this._formatSize(ix.size) });
			label.title = ix.path;
			row.append(label);
			if (ix.active || ix.building) {
				if (ix.active) {
					let tag = document.createElement('span');
					tag.className = 'ss-in-use';
					document.l10n.setAttributes(tag, 'semsearch-index-in-use');
					row.append(tag);
				}
			}
			else {
				let del = document.createElement('button');
				document.l10n.setAttributes(del, 'semsearch-index-delete');
				del.addEventListener('click', async () => {
					let msg = await document.l10n.formatValue('semsearch-index-delete-confirm',
						{ model: ix.label, size: this._formatSize(ix.size) });
					if (!Services.prompt.confirm(window, 'Semantic Search', msg)) return;
					try {
						await models.deleteIndex(ix.id);
					}
					catch (e) {
						this._error(e);
					}
					this.refresh();
				});
				row.append(del);
			}
			rows.push(row);
		}
		if (signature !== this._indexesSignature) {
			this._indexesSignature = signature;
			try {
				await document.l10n.translateElements(rows.flatMap(r => [r, ...r.querySelectorAll('[data-l10n-id]')]));
			}
			catch (e) {}
			list.replaceChildren(...rows);
		}

		let notice = this.S.store.migrationNotice;
		let box2 = this.$('semsearch-migration-notice');
		box2.hidden = !notice;
		if (notice) {
			document.l10n.setAttributes(this.$('semsearch-migration-text'), 'semsearch-migration-notice',
				{ legacy: notice.legacy, target: notice.target });
		}
		this.$('semsearch-upgrade-legacy').hidden = models.activeId !== 'lealla';
	},

	async refresh() {
		try {
			await this.refreshModel();
		}
		catch (e) {
			Zotero.logError(e);
		}
		let model = await this.S.model.status();
		let status = this.$('semsearch-model-status');
		let dl = this.$('semsearch-model-download');
		dl.hidden = model.state === 'ready' || model.state === 'downloading';
		let spec = this.S.models.active.spec;
		if (model.state === 'ready') {
			document.l10n.setAttributes(status, 'semsearch-model-active', { model: spec.label });
		}
		else if (model.state === 'downloading') {
			let p = model.progress || {};
			document.l10n.setAttributes(status, p.verifying ? 'semsearch-model-verifying' : 'semsearch-model-downloading',
				{ percent: p.total ? Math.floor(100 * p.received / p.total) : 0 });
		}
		else if (model.state === 'error') {
			document.l10n.setAttributes(status, 'semsearch-model-error', { error: model.error });
		}
		else {
			document.l10n.setAttributes(status, 'semsearch-model-missing', { model: spec.label, size: String(spec.downloadMB) });
		}

		let ix = this.$('semsearch-index-status');
		let index = this.S.index;
		let st = this.S.indexer.status();
		if (st.state === 'indexing' || st.state === 'paused') {
			let done = st.stats.done + st.stats.failed + st.stats.excluded;
			document.l10n.setAttributes(ix, 'semsearch-index-running', { done, total: Math.max(st.stats.total, done) });
		}
		else if (index.progress) {
			let p = index.progress;
			document.l10n.setAttributes(ix, p.phase === 'db-index' ? 'semsearch-index-db' : 'semsearch-index-building',
				{ done: p.done || 0, total: p.total || 0 });
		}
		else if (index.loaded) {
			document.l10n.setAttributes(ix, 'semsearch-index-status', {
				docs: index.documentCount().toLocaleString(),
				passages: index.liveCount.toLocaleString(),
			});
		}
		else {
			ix.textContent = '';
			ix.removeAttribute('data-l10n-id');
		}
	},

	async upgradeLegacy() {
		try {
			let keys = await this.S.store.getLegacyDocumentIDs();
			let msg = await document.l10n.formatValue('semsearch-prefs-upgrade-legacy-confirm', { count: keys.length });
			if (!keys.length || !Services.prompt.confirm(window, 'Semantic Search', msg)) return;
			await this.S.index.load();
			let items = [];
			for (let key of keys) {
				let item = await this.S.passages.getItemByKey(key);
				if (item && item.isPDFAttachment()) items.push(item);
			}
			await this.S.indexer.indexItems(items.reverse(), { force: true });
		}
		catch (e) {
			this._error(e);
		}
	},
};
