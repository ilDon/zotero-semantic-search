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
		minSim.value = parseFloat(this.pref('minSimilarity') || '0.6').toFixed(2);
		minSim.addEventListener('change', () => {
			let v = parseFloat(minSim.value);
			if (Number.isFinite(v) && v > 0 && v < 1) this.setPref('minSimilarity', v.toFixed(2));
		});
		this._intPref('semsearch-max-results', 'maxResults', 10, 5000);
		this._intPref('semsearch-workers', 'workers', 1, 8);
		this._boolPref('semsearch-auto-index', 'autoIndex');
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
		this.$('semsearch-db-path').textContent = this.S.store.path;

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

	async refresh() {
		let model = await this.S.model.status();
		let status = this.$('semsearch-model-status');
		let dl = this.$('semsearch-model-download');
		dl.hidden = model.state === 'ready' || model.state === 'downloading';
		if (model.state === 'ready') {
			document.l10n.setAttributes(status, 'semsearch-model-ready');
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
			document.l10n.setAttributes(status, 'semsearch-model-missing');
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
