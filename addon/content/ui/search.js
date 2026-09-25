/* global Zotero, Services, IntersectionObserver */
/* exported SemanticSearchWindow */

const STATUS = { todo: 0, cited: 1, irrelevant: 2 };

// Same prompt as the original app's "Copy prompt to clipboard"
const PROMPT = `I am a university professor of law. I am writing a paper. The following is a section of my paper (SECTION), after that there is an excerpt from a paper that might be relevant in relation to what I wrote (EXCERPT). Please explain in one short sentence how the EXCERPT could support the contents of SECTION.

SECTION:
[QUERY]

EXCERPT:
[TEXT]
`;

/*
 * The stylesheet is loaded with the plugin version in its URL: Zotero keeps
 * chrome stylesheets cached across plugin updates, so a fixed URL would keep
 * serving the previous version's CSS until Zotero is restarted.
 */
(function loadStylesheet() {
	let S = Zotero.SemanticSearch;
	let version = (S && S.plugin && S.plugin.version) || String(Date.now());
	let pi = document.createProcessingInstruction('xml-stylesheet',
		`href="chrome://semantic-search/content/ui/search.css?v=${encodeURIComponent(version)}" type="text/css"`);
	document.insertBefore(pi, document.documentElement);
})();

var SemanticSearchWindow = {
	S: null,
	current: null, // {id, query, date, results, fromCache, model, similar?}
	view: 'results', // results | excluded | similar
	historyItems: [],
	_unsubscribe: [],
	_observer: null,
	_textQueue: [],
	_textBusy: 0,
	_searchSeq: 0,
	typeFilter: new Set(), // Zotero item type names; empty = all types
	addedSince: null, // {date: 'YYYY-MM-DD', utc: 'YYYY-MM-DD HH:MM:SS'}: only items added since then

	$(id) {
		return document.getElementById(id);
	},

	el(tag, attrs = {}, ...children) {
		let e = document.createElement(tag);
		for (let [k, v] of Object.entries(attrs)) {
			if (v === undefined || v === null || v === false) continue;
			if (k === 'class') e.className = v;
			else if (k === 'text') e.textContent = v;
			else if (k === 'l10n') {
				document.l10n.setAttributes(e, v[0], v[1]);
			}
			else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
			else e.setAttribute(k, v === true ? '' : v);
		}
		for (let c of children) {
			if (c === null || c === undefined || c === false) continue;
			e.append(c);
		}
		return e;
	},

	async init() {
		this.S = Zotero.SemanticSearch;
		if (!this.S) {
			window.close();
			return;
		}
		document.title = await document.l10n.formatValue('semsearch-window-title');
		this.$('threshold').value = this.S.search.minSimilarity.toFixed(2);
		this.$('group-toggle').checked = !!Zotero.Prefs.get('extensions.semantic-search.groupByDocument', true);

		this.$('query-form').addEventListener('submit', (e) => {
			e.preventDefault();
			this.doSearch();
		});
		this.$('query').addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.doSearch();
			}
		});
		this.$('group-toggle').addEventListener('change', () => {
			Zotero.Prefs.set('extensions.semantic-search.groupByDocument', this.$('group-toggle').checked, true);
			this.renderResults();
		});
		this.$('status-filter').addEventListener('change', () => this.renderResults());
		this.$('model-indicator').addEventListener('click', () => this.openModelSettings());
		this._renderModelIndicator();
		this.$('history-filter').addEventListener('input', () => this.renderHistory());
		this.$('new-search-button').addEventListener('click', () => this.newSearch());
		this.$('rerun-button').addEventListener('click', () => {
			// results of another model: run with the active one, keeping the marks
			let other = this.current && this.current.model && this.current.model !== this.S.models.activeId;
			this.doSearch({ useCache: false, carryFrom: other ? this.current.id : undefined });
		});
		this.$('copy-list-button').addEventListener('click', () => this.copyList());
		this.$('collection-button').addEventListener('click', () => this.saveAsCollection());
		this.$('excluded-button').addEventListener('click', () => this.showExcluded());
		this.$('duplicates-button').addEventListener('click', () => this.showDuplicates());
		this.$('type-filter-button').addEventListener('click', (e) => {
			e.stopPropagation();
			let popup = this.$('type-filter-popup');
			popup.hidden = !popup.hidden;
			this.$('date-filter-popup').hidden = true;
		});
		this.$('type-filter-popup').addEventListener('click', e => e.stopPropagation());
		this.$('date-filter-button').addEventListener('click', (e) => {
			e.stopPropagation();
			let popup = this.$('date-filter-popup');
			popup.hidden = !popup.hidden;
			this.$('type-filter-popup').hidden = true;
		});
		this.$('date-filter-popup').addEventListener('click', e => e.stopPropagation());
		this.$('date-filter-input').addEventListener('change', () => this.setAddedSince(this.$('date-filter-input').value));
		for (let b of document.querySelectorAll('.date-presets button')) {
			b.addEventListener('click', () => {
				let d = new Date();
				d.setMonth(d.getMonth() - parseInt(b.dataset.months));
				let pad = n => String(n).padStart(2, '0');
				this.setAddedSince(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
			});
		}
		this.$('date-filter-reset').addEventListener('click', () => this.setAddedSince(null));
		let closePopups = () => {
			this.$('type-filter-popup').hidden = true;
			this.$('date-filter-popup').hidden = true;
		};
		document.addEventListener('click', closePopups);
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') closePopups();
		});

		this._observer = new IntersectionObserver((entries) => {
			for (let entry of entries) {
				if (entry.isIntersecting && entry.target._ssLoadText) {
					let fn = entry.target._ssLoadText;
					entry.target._ssLoadText = null;
					this._observer.unobserve(entry.target);
					this._enqueueText(fn);
				}
			}
		}, { root: this.$('results'), rootMargin: '400px' });

		let refreshStatus = this._throttle(() => this.renderStatus(), 400);
		this._unsubscribe.push(this.S.indexer.onChange(refreshStatus));
		this._unsubscribe.push(this.S.index.onChange(refreshStatus));
		this._unsubscribe.push(this.S.model.onChange(refreshStatus));
		// the active model changed (switch finished, or switched back)
		this._unsubscribe.push(this.S.events.on('models', () => {
			this._renderModelIndicator();
			this.$('threshold').value = this.S.search.minSimilarity.toFixed(2);
			refreshStatus();
			this.renderHistory();
			if (this.view === 'results') this.renderResults();
			this._warmUp();
		}));
		let refreshDuplicates = this._throttle(() => {
			this._updateDuplicatesButton();
			if (this.view === 'duplicates' && !this._dupBusy) this.showDuplicates();
		}, 1500);
		this._unsubscribe.push(this.S.duplicates.onChange(refreshDuplicates));
		this._unsubscribe.push(this.S.ocr.onChange(() => {
			if (this.view === 'excluded') this.showExcluded();
		}));
		window.addEventListener('unload', () => this.destroy());

		await this.renderStatus();
		await this.loadHistoryList();
		this.renderResults();
		this.handleArgs(window.arguments && window.arguments[0] || {});
		this.$('query').focus();
		// Warm up the model and the index in the background so the first search is fast
		this._warmUp();
	},

	destroy() {
		for (let fn of this._unsubscribe) fn();
		this._unsubscribe = [];
		if (this._observer) this._observer.disconnect();
	},

	async _warmUp() {
		try {
			if (!(await this.S.model.isReady())) return;
			await Promise.all([this.S.embedder.warmUp(), this.S.index.load()]);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	_throttle(fn, ms) {
		let timer = null;
		return () => {
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				fn();
			}, ms);
		};
	},

	handleArgs(args) {
		if (!args) return;
		if (args.wrappedJSObject) args = args.wrappedJSObject;
		if (args.query) {
			this.$('query').value = args.query;
			this.doSearch();
		}
		else if (args.similarTo) {
			this.showSimilar(args.similarTo);
		}
		else if (args.historyID) {
			this.openHistory(args.historyID);
		}
		else if (args.duplicates) {
			this.showDuplicates();
		}
	},

	// ------------------------------------------------------------ status panel

	async renderStatus() {
		let panel = this.$('status-panel');
		let parts = [];
		let model = await this.S.model.status();
		if (model.state !== 'ready') {
			if (model.state === 'downloading') {
				let p = model.progress || {};
				if (p.verifying) {
					parts.push(this.el('div', { class: 'status-line', l10n: ['semsearch-model-verifying'] }));
				}
				else {
					let pct = p.total ? Math.floor(100 * p.received / p.total) : 0;
					parts.push(this.el('div', { class: 'status-line', l10n: ['semsearch-model-downloading', { percent: pct }] }));
					parts.push(this.el('progress', { max: 100, value: pct }));
				}
			}
			else {
				if (model.state === 'error') {
					parts.push(this.el('div', { class: 'status-line', l10n: ['semsearch-model-error', { error: model.error }] }));
				}
				parts.push(this.el('div', { class: 'status-line', l10n: this._modelMissingL10n() }));
				parts.push(this.el('div', { class: 'status-buttons' },
					this.el('button', { l10n: ['semsearch-model-download'], onclick: () => this.downloadModel() })));
			}
			await this._swapPanel(panel, parts);
			this._updateNotice(model);
			return;
		}
		this._updateNotice(model);

		let index = this.S.index;
		if (index.progress) {
			let p = index.progress;
			if (p.phase === 'db-index') {
				parts.push(this.el('div', { class: 'status-line', l10n: ['semsearch-index-db'] }));
				parts.push(this.el('progress'));
			}
			else if (p.phase === 'build' || p.phase === 'update') {
				parts.push(this.el('div', { class: 'status-line', l10n: ['semsearch-index-building', { done: p.done, total: p.total }] }));
				parts.push(this.el('progress', { max: p.total || 1, value: p.done }));
			}
			else {
				parts.push(this.el('div', { class: 'status-line', l10n: ['semsearch-index-loading'] }));
			}
		}
		else if (index.loaded) {
			parts.push(this.el('div', {
				class: 'status-line',
				l10n: ['semsearch-index-status', {
					docs: index.documentCount().toLocaleString(),
					passages: index.liveCount.toLocaleString(),
				}],
			}));
		}

		await this._buildStatus(parts);
		let ix = this.S.indexer.status();
		let buttons = this.el('div', { class: 'status-buttons' });
		if (ix.state === 'indexing' || ix.state === 'paused' || ix.state === 'scanning') {
			let done = ix.stats.done + ix.stats.failed + ix.stats.excluded;
			let total = Math.max(ix.stats.total, done + ix.queued + ix.current.length);
			// during a model switch the build progress above says it all
			if (!ix.build) {
				parts.push(this.el('div', { class: 'status-line', l10n: ['semsearch-index-running', { done, total }] }));
				parts.push(this.el('progress', { max: total || 1, value: done }));
			}
			for (let c of ix.current) {
				parts.push(this.el('div', {
					class: 'status-line status-current',
					title: c.title,
					l10n: ['semsearch-index-current', { title: c.title, done: c.done, total: c.total || '…' }],
				}));
			}
			if (ix.state === 'paused') {
				buttons.append(this.el('button', { l10n: ['semsearch-index-resume'], onclick: () => this.S.indexer.resume() }));
			}
			else {
				buttons.append(this.el('button', { l10n: ['semsearch-index-pause'], onclick: () => this.S.indexer.pause() }));
			}
			buttons.append(this.el('button', { l10n: ['semsearch-index-cancel'], onclick: () => this.S.indexer.cancel() }));
		}
		else {
			if (this._lastScan !== undefined) {
				parts.push(this.el('div', {
					class: 'status-line',
					l10n: this._lastScan ? ['semsearch-index-found', { count: this._lastScan }] : ['semsearch-index-uptodate'],
				}));
			}
			buttons.append(this.el('button', {
				l10n: ['semsearch-index-new'],
				onclick: async () => {
					try {
						this._lastScan = await this.S.indexer.indexNew();
						this.renderStatus();
					}
					catch (e) {
						this.showError(e);
					}
				},
			}));
		}
		if (ix.lastError) {
			parts.push(this.el('div', { class: 'status-line', title: ix.lastError, l10n: ['semsearch-error', { message: ix.lastError.slice(0, 120) }] }));
		}
		parts.push(buttons);
		await this._swapPanel(panel, parts);
		this._updateExcludedButton();
		this._updateDuplicatesButton();
	},

	/**
	 * Replace the status panel content only if it changed, with its strings
	 * already translated: it is re-rendered on every indexing update, and
	 * swapping in untranslated (empty) lines made the panel jump.
	 */
	async _swapPanel(panel, parts) {
		let signature = parts.map(p => p.outerHTML).join('');
		if (signature === panel._ssSignature) return;
		try {
			await document.l10n.translateElements(parts.flatMap(p => [p, ...p.querySelectorAll('[data-l10n-id]')]));
		}
		catch (e) {}
		panel._ssSignature = signature;
		panel.replaceChildren(...parts);
	},

	async _updateDuplicatesButton() {
		try {
			let n = await this.S.duplicates.count();
			let button = this.$('duplicates-button');
			button.hidden = !n;
			document.l10n.setAttributes(button, 'semsearch-duplicates', { count: n });
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	async _updateExcludedButton() {
		try {
			let n = (await this.S.store.getExcluded()).length;
			document.l10n.setAttributes(this.$('excluded-button'), 'semsearch-excluded', { count: n });
		}
		catch (e) {}
	},

	_updateNotice(model) {
		let notice = this.$('notice');
		if (model.state === 'ready') {
			if (notice.dataset.kind === 'model') {
				notice.hidden = true;
				notice.dataset.kind = '';
			}
			return;
		}
		notice.dataset.kind = 'model';
		notice.className = '';
		let children = [this.el('span', { l10n: this._modelMissingL10n() })];
		if (model.state !== 'downloading') {
			children.push(this.el('button', { class: 'primary', l10n: ['semsearch-model-download'], onclick: () => this.downloadModel() }));
		}
		notice.replaceChildren(...children);
		notice.hidden = false;
	},

	/** Model in use (and model being switched to), next to the search button */
	_renderModelIndicator() {
		let models = this.S.models;
		let chip = this.$('model-indicator');
		let args = { model: models.active.spec.label };
		if (models.building) {
			document.l10n.setAttributes(chip, 'semsearch-model-indicator-switching', { ...args, next: models.building.spec.label });
		}
		else {
			document.l10n.setAttributes(chip, 'semsearch-model-indicator', args);
		}
	},

	openModelSettings() {
		Zotero.Utilities.Internal.openPreferences(this.S.ui._prefPaneID);
	},

	_modelMissingL10n() {
		let spec = this.S.models.active.spec;
		return ['semsearch-model-missing', { model: spec.label, size: String(spec.downloadMB) }];
	},

	_modelLabel(id) {
		let spec = this.S.models.registry.get(id || 'lealla');
		return spec ? spec.label : id;
	},

	/** Progress of a model switch (download, then indexing) */
	async _buildStatus(parts) {
		let building = this.S.models.building;
		if (!building) return;
		let args = { model: building.spec.label, current: this.S.models.active.spec.label };
		let dl = await building.files.status();
		if (dl.state === 'downloading') {
			let p = dl.progress || {};
			let pct = p.total ? Math.floor(100 * p.received / p.total) : 0;
			parts.push(this.el('div', { class: 'status-line', l10n: ['semsearch-build-downloading', { ...args, percent: pct }] }));
			parts.push(this.el('progress', { max: 100, value: pct }));
			return;
		}
		let build = this.S.indexer.status().build;
		if (build && build.model === building.id) {
			parts.push(this.el('div', {
				class: 'status-line',
				l10n: ['semsearch-build-status', { ...args, done: build.done.toLocaleString(), total: build.total.toLocaleString() }],
			}));
			parts.push(this.el('progress', { max: build.total || 1, value: build.done }));
		}
		else {
			parts.push(this.el('div', { class: 'status-line', l10n: ['semsearch-build-waiting', args] }));
		}
	},

	async downloadModel() {
		try {
			await this.S.model.ensureDownloaded();
			if (await this.S.model.isReady()) {
				this._warmUp();
				// pick up PDFs added since the last indexing
				if (this.S.indexer.autoIndex) {
					this.S.index.load().then(() => this.S.indexer.indexNew()).catch(e => Zotero.logError(e));
				}
			}
		}
		catch (e) {
			this.showError(e);
		}
		this.renderStatus();
	},

	// ------------------------------------------------------------ history

	async loadHistoryList() {
		try {
			this.historyItems = await this.S.store.listHistory();
		}
		catch (e) {
			Zotero.logError(e);
			this.historyItems = [];
		}
		this.renderHistory();
	},

	renderHistory() {
		// "New search" is pointless on the empty search page itself
		this.$('new-search-button').disabled = this.view === 'results' && !this.current;
		// the management views (excluded documents, duplicates) have nothing to search
		this.$('query-form').hidden = this.view === 'excluded' || this.view === 'duplicates';
		let filter = this.$('history-filter').value.trim().toLowerCase();
		let list = this.$('history-list');
		let items = this.historyItems.filter(h => !filter || h.query.toLowerCase().includes(filter));
		if (!items.length) {
			list.replaceChildren(this.el('li', { class: 'history-empty', l10n: ['semsearch-history-empty'] }));
			return;
		}
		list.replaceChildren(...items.map((h) => {
			let li = this.el('li', {
				class: this.current && this.current.id === h.id && this.view === 'results' ? 'selected' : '',
				title: h.query,
				onclick: () => this.openHistory(h.id),
			},
			this.el('div', { class: 'history-query', text: h.query }),
			this.el('div', { class: 'history-meta', text: `${this._formatDate(h.date)} · ${h.count}` },
				h.model !== this.S.models.activeId
					? this.el('span', { class: 'history-model', text: this._modelLabel(h.model), l10n: ['semsearch-history-model', { model: this._modelLabel(h.model) }] })
					: null),
			this.el('button', {
				class: 'history-delete',
				text: '×',
				l10n: ['semsearch-history-delete'],
				onclick: (e) => {
					e.stopPropagation();
					this.deleteHistory(h.id);
				},
			}));
			return li;
		}));
	},

	_formatDate(d) {
		if (!d) return '';
		let date = new Date(d + 'T00:00:00');
		return isNaN(date) ? d : date.toLocaleDateString();
	},

	async openHistory(id) {
		let h = await this.S.store.getHistory(id);
		if (!h) return;
		this.$('query').value = h.query;
		await this.showResults({ ...h, fromCache: true });
	},

	async deleteHistory(id) {
		await this.S.store.deleteHistory(id);
		if (this.current && this.current.id === id) {
			this.current = null;
			this.renderResults();
		}
		await this.loadHistoryList();
	},

	// ------------------------------------------------------------ searching

	async doSearch({ useCache = true, carryFrom } = {}) {
		let query = this.$('query').value.trim();
		if (!query) return;
		let minSimilarity = parseFloat(this.$('threshold').value);
		if (!Number.isFinite(minSimilarity)) minSimilarity = this.S.search.minSimilarity;
		let seq = ++this._searchSeq;
		this.view = 'results';
		this._setBusy(true);
		try {
			let res = await this.S.search.search(query, { useCache, minSimilarity, carryFrom });
			if (seq !== this._searchSeq) return;
			await this.showResults(res);
			if (!res.fromCache) await this.loadHistoryList();
		}
		catch (e) {
			if (seq === this._searchSeq) this.showError(e);
		}
		finally {
			if (seq === this._searchSeq) this._setBusy(false);
		}
	},

	_setBusy(busy) {
		this.$('search-button').disabled = busy;
		if (busy) {
			this.$('results-header').hidden = true;
			this.$('results').replaceChildren(this.el('div', { class: 'placeholder', l10n: ['semsearch-searching'] }));
		}
	},

	/** Back to the page the window opens with: empty query, no results */
	newSearch() {
		this._searchSeq++; // a search still running must not show up
		this.view = 'results';
		this.current = null;
		this.typeFilter = new Set();
		this.setAddedSince(null);
		this.$('query').value = '';
		let notice = this.$('notice');
		if (notice.dataset.kind === 'error') notice.hidden = true;
		this._setBusy(false);
		this.renderHistory();
		this.renderResults();
		this.$('query').focus();
	},

	async showResults(res) {
		this.view = 'results';
		this.current = res;
		this.typeFilter = new Set();
		// metadata first (fast); passage texts are loaded lazily as cards scroll into view
		await this.S.passages.enrich(res.results, { text: false, model: res.model });
		this.renderHistory();
		this.renderResults();
	},

	/** Model of the results on screen (saved searches may come from another model) */
	_resultsModel() {
		return (this.current && this.current.model) || this.S.models.activeId;
	},

	showError(e) {
		Zotero.logError(e);
		let notice = this.$('notice');
		notice.dataset.kind = 'error';
		notice.className = 'error';
		notice.replaceChildren(this.el('span', { l10n: ['semsearch-error', { message: String(e.message || e) }] }));
		notice.hidden = false;
		if (e.code === 'MODEL_MISSING') this.renderStatus();
	},

	// ------------------------------------------------------------ rendering results

	_filtered() {
		let f = this.$('status-filter').value;
		let results = this.current ? this.current.results : [];
		if (this.typeFilter.size) results = results.filter(r => this.typeFilter.has(r.itemType));
		if (this.addedSince) results = results.filter(r => r.dateAdded && r.dateAdded >= this.addedSince.utc);
		if (f === 'all') return results;
		if (f === 'hide-irrelevant') return results.filter(r => (r.status || 0) !== STATUS.irrelevant);
		let s = parseInt(f);
		return results.filter(r => (r.status || 0) === s);
	},

	renderResults() {
		let container = this.$('results');
		let header = this.$('results-header');
		this._textQueue = [];
		if (this.view !== 'results') return;
		if (!this.current) {
			header.hidden = true;
			container.replaceChildren();
			return;
		}
		let notice = this.$('notice');
		if (notice.dataset.kind === 'error') notice.hidden = true;
		let results = this._filtered();
		let docCount = new Set(results.map(r => r.folder_id)).size;
		let summary = [this.el('span', { l10n: ['semsearch-results-count', { count: results.length }] }), ' ',
			this.el('span', { l10n: ['semsearch-results-docs', { count: docCount }] })];
		if (this.current.fromCache) {
			summary.push(' · ', this.el('span', { l10n: ['semsearch-results-from-history', { date: this._formatDate(this.current.date) }] }));
		}
		let otherModel = this.current.model && this.current.model !== this.S.models.activeId;
		if (otherModel) {
			summary.push(' · ', this.el('span', { class: 'other-model', l10n: ['semsearch-results-other-model', { model: this._modelLabel(this.current.model) }] }));
		}
		this.$('results-summary').replaceChildren(...summary);
		this.$('rerun-button').hidden = !this.current.fromCache;
		if (otherModel) {
			document.l10n.setAttributes(this.$('rerun-button'), 'semsearch-rerun-with', { model: this.S.models.active.spec.label });
		}
		else {
			document.l10n.setAttributes(this.$('rerun-button'), 'semsearch-rerun');
		}
		this._renderTypeFilter();
		this._renderDateFilter();
		header.hidden = false;

		if (!this.current.results.length) {
			container.replaceChildren(this.el('div', { class: 'placeholder', l10n: ['semsearch-results-none'] }));
			return;
		}
		let frag = document.createDocumentFragment();
		if (this.$('group-toggle').checked) {
			for (let g of this.S.search.groupByDocument(results)) {
				frag.append(this._groupCard(g));
			}
		}
		else {
			for (let r of results) frag.append(this._resultCard(r));
		}
		container.replaceChildren(frag);
		container.scrollTop = 0;
	},

	_typeName(type) {
		try {
			return Zotero.ItemTypes.getLocalizedString(type) || type;
		}
		catch (e) {
			return type;
		}
	},

	/** Multi-select filter on the item types present in the current results */
	_renderTypeFilter() {
		let button = this.$('type-filter-button');
		let popup = this.$('type-filter-popup');
		let counts = new Map();
		for (let r of this.current ? this.current.results : []) {
			if (!r.itemType) continue;
			counts.set(r.itemType, (counts.get(r.itemType) || 0) + 1);
		}
		// drop selections that no longer match anything
		for (let t of [...this.typeFilter]) {
			if (!counts.has(t)) this.typeFilter.delete(t);
		}
		let types = [...counts.keys()].sort((a, b) => this._typeName(a).localeCompare(this._typeName(b)));
		this.$('type-filter').hidden = !types.length;
		if (this.typeFilter.size) {
			let names = [...this.typeFilter].map(t => this._typeName(t));
			let label = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
			document.l10n.setAttributes(button, 'semsearch-type-filter-some', { types: label });
			button.classList.add('active');
		}
		else {
			document.l10n.setAttributes(button, 'semsearch-type-filter-all');
			button.classList.remove('active');
		}
		let rows = types.map((t) => {
			let box = this.el('input', { type: 'checkbox' });
			box.checked = this.typeFilter.has(t);
			box.addEventListener('change', () => {
				if (box.checked) this.typeFilter.add(t);
				else this.typeFilter.delete(t);
				this.renderResults();
			});
			return this.el('label', {}, box, this.el('span', { text: this._typeName(t) }),
				this.el('span', { class: 'count', text: String(counts.get(t)) }));
		});
		let reset = this.el('button', {
			class: 'link-button reset',
			l10n: ['semsearch-type-filter-reset'],
			disabled: !this.typeFilter.size,
			onclick: () => {
				this.typeFilter = new Set();
				this.renderResults();
			},
		});
		popup.replaceChildren(...rows, reset);
	},

	/** Only show items added to Zotero on or after `date` (YYYY-MM-DD, local); null = any time */
	setAddedSince(date) {
		let utc = date ? this.S.passages.sinceToUTC(date) : null;
		this.addedSince = utc ? { date, utc } : null;
		this.renderResults();
	},

	_renderDateFilter() {
		let button = this.$('date-filter-button');
		if (this.addedSince) {
			let d = new Date(this.addedSince.date + 'T00:00:00');
			document.l10n.setAttributes(button, 'semsearch-date-filter-since', { date: d.toLocaleDateString() });
			button.classList.add('active');
		}
		else {
			document.l10n.setAttributes(button, 'semsearch-date-filter-any');
			button.classList.remove('active');
		}
		this.$('date-filter-input').value = this.addedSince ? this.addedSince.date : '';
		this.$('date-filter-reset').disabled = !this.addedSince;
	},

	_strength(sim) {
		// 0.4 -> weak, 0.8 -> strong
		return Math.max(0.15, Math.min(1, (sim - 0.4) / 0.4));
	},

	_scoreBadge(sim) {
		let b = this.el('span', { class: 'score', text: sim.toFixed(3), title: 'cosine similarity' });
		b.style.setProperty('--strength', this._strength(sim));
		return b;
	},

	_subline(r, withPage = true) {
		let parts = [];
		if (r.creators) parts.push(r.creators);
		if (r.year) parts.push(r.year);
		if (r.publication) parts.push(r.publication);
		let sub = this.el('div', { class: 'sub', text: parts.join(' · ') });
		if (withPage && Number.isInteger(r.page)) {
			if (parts.length) sub.append(' · ');
			sub.append(this.el('span', { l10n: ['semsearch-page', { page: (r.approximate ? '≈' : '') + (r.page + 1) }] }));
		}
		return sub;
	},

	_titleEl(r) {
		return this.el('div', {
			class: 'title',
			text: r.title || r.file_name,
			title: r.file_name,
			onclick: () => this.showInLibrary(r),
		});
	},

	_groupCard(g) {
		let first = g.results[0];
		let card = this.el('section', { class: 'group' + (first.missing ? ' missing' : '') },
			this.el('div', { class: 'group-head' },
				this._scoreBadge(g.best),
				this.el('div', { class: 'meta' }, this._titleEl(first), this._subline(first, false),
					first.duplicates ? this.el('div', { class: 'dup-note', l10n: ['semsearch-also-in', { count: first.duplicates.length }] }) : null)));
		for (let r of g.results) card.append(this._resultCard(r, true));
		return card;
	},

	_resultCard(r, inGroup = false) {
		let card = this.el('article', { class: 'result' + (r.missing ? ' missing' : ''), 'data-status': r.status || 0 });
		card._inGroup = inGroup;
		let status = this.el('select', { class: 'status-select' },
			this.el('option', { value: STATUS.todo, l10n: ['semsearch-status-todo'] }),
			this.el('option', { value: STATUS.cited, l10n: ['semsearch-status-cited'] }),
			this.el('option', { value: STATUS.irrelevant, l10n: ['semsearch-status-irrelevant'] }));
		status.value = String(r.status || 0);
		status.addEventListener('change', () => this.setStatus(r, parseInt(status.value), card));

		let head;
		if (inGroup) {
			head = this.el('div', { class: 'result-head' },
				this._scoreBadge(r.similarity),
				this.el('div', { class: 'meta' }, this._pageLine(r)),
				status);
		}
		else {
			head = this.el('div', { class: 'result-head' },
				this._scoreBadge(r.similarity),
				this.el('div', { class: 'meta' }, this._titleEl(r), this._subline(r),
					r.duplicates ? this.el('div', { class: 'dup-note', l10n: ['semsearch-also-in', { count: r.duplicates.length }] }) : null),
				status);
		}
		let matched = r.matched ? this.el('div', { class: 'matched', l10n: ['semsearch-matched', { text: r.matched }] }) : null;
		let passage = this.el('blockquote', { class: 'passage', onclick: () => passage.classList.toggle('expanded') });
		let approx = this.el('div', { class: 'approx', hidden: true });
		let actions = this.el('div', { class: 'actions' });
		card.append(head, matched || '', passage, approx, actions);
		this._fillCard(r, card, passage, approx, actions);
		if (r.text === undefined && !r.missing) {
			passage.classList.add('loading');
			passage.textContent = '…';
			card._ssLoadText = async () => {
				await this.S.passages.enrich([r], { text: true, model: this._resultsModel() });
				this._fillCard(r, card, passage, approx, actions);
			};
			this._observer.observe(card);
		}
		return card;
	},

	_pageLine(r) {
		let line = this.el('div', { class: 'sub' });
		if (Number.isInteger(r.page)) {
			line.append(this.el('span', { l10n: ['semsearch-page', { page: (r.approximate ? '≈' : '') + (r.page + 1) }] }));
		}
		return line;
	},

	_fillCard(r, card, passage, approx, actions) {
		if (r.text !== undefined) {
			passage.classList.remove('loading');
			passage.textContent = r.text || '';
			passage.hidden = !r.text;
		}
		if (r.missing) {
			passage.hidden = true;
			actions.replaceChildren(this.el('span', { class: 'sub', l10n: ['semsearch-missing-item'] }));
			return;
		}
		// the page shown in the header/subline
		let sub = card.querySelector(':scope > .result-head .meta');
		if (sub) {
			let old = sub.querySelector(':scope > .sub');
			let fresh = card._inGroup ? this._pageLine(r) : this._subline(r);
			if (old) old.replaceWith(fresh);
		}
		approx.hidden = !(r.approximate && r.text);
		if (!approx.hidden) {
			let locate = this.el('button', {
				l10n: ['semsearch-locate'],
				onclick: async () => {
					document.l10n.setAttributes(locate, 'semsearch-locating');
					locate.disabled = true;
					try {
						await this.locate(r);
						this._fillCard(r, card, passage, approx, actions);
					}
					catch (e) {
						this.showError(e);
						document.l10n.setAttributes(locate, 'semsearch-locate');
						locate.disabled = false;
					}
				},
			});
			approx.replaceChildren(this.el('span', { l10n: ['semsearch-approximate'] }), locate);
		}
		let open = this.el('button', {
			l10n: Number.isInteger(r.page) ? ['semsearch-open-pdf-page', { page: (r.approximate ? '≈' : '') + (r.page + 1) }] : ['semsearch-open-pdf'],
			onclick: () => this.openPDF(r),
		});
		actions.replaceChildren(
			this.el('button', { l10n: ['semsearch-show-in-library'], onclick: () => this.showInLibrary(r) }),
			open,
			this.el('button', { l10n: ['semsearch-copy-prompt'], onclick: e => this.copyPrompt(r, e.target) }),
			this.el('button', { l10n: ['semsearch-copy-citation'], onclick: e => this.copyCitation(r, e.target) }),
			this.el('button', { l10n: ['semsearch-exclude-doc'], onclick: () => this.excludeDocument(r) }),
		);
	},

	_enqueueText(fn) {
		this._textQueue.push(fn);
		this._pumpText();
	},

	async _pumpText() {
		// PDF text extraction is serial in Zotero anyway; two in flight keep cached ones flowing
		while (this._textBusy < 2 && this._textQueue.length) {
			let fn = this._textQueue.shift();
			this._textBusy++;
			fn().catch(e => Zotero.debug('Semantic Search: ' + e)).finally(() => {
				this._textBusy--;
				this._pumpText();
			});
		}
	},

	// ------------------------------------------------------------ actions

	async setStatus(r, status, card) {
		r.status = status;
		if (card) card.dataset.status = status;
		if (this.current && this.current.id && !this.current.similar) {
			let clean = this.current.results.map(x => this._historyShape(x));
			await this.S.store.updateHistoryResults(this.current.id, clean);
		}
		if (this.$('status-filter').value !== 'all') this.renderResults();
	},

	/** Keep only the fields stored in the history table (legacy-compatible) */
	_historyShape(r) {
		let o = {
			similarity: r.similarity,
			folder_id: r.folder_id,
			file_name: r.file_name,
			section_number: r.section_number,
		};
		if (r.status !== undefined) o.status = r.status;
		if (r.rowid !== undefined) o.rowid = r.rowid;
		if (Number.isInteger(r.page)) o.page = r.page;
		if (r.duplicates) o.duplicates = r.duplicates;
		if (r.matched) o.matched = r.matched;
		return o;
	},

	async locate(r) {
		let item = await this.S.passages.getItemByKey(r.folder_id);
		if (!item || !r.rowid) return;
		// legacy sections only exist in the LEALLA-large database
		let store = this.S.models.space('lealla').store;
		let vec = (await store.getVectors([r.rowid])).get(r.rowid);
		let count = r.sectionCount || await store.countSections(r.folder_id);
		let res = await this.S.passages.locateLegacy(item, r.section_number, count, vec);
		if (res) {
			r.text = res.text;
			r.page = res.page;
			r.approximate = false;
			await store.setLegacyLocation(r.rowid, res.text, res.page, res.charStart);
		}
	},

	showInLibrary(r) {
		if (r.missing || !r.itemID) return;
		let win = Zotero.getMainWindow();
		if (win) {
			win.focus();
			win.ZoteroPane.selectItem(r.itemID);
		}
	},

	async openPDF(r) {
		if (!r.attachmentID) return;
		let location = Number.isInteger(r.page) ? { pageIndex: r.page } : undefined;
		let reader = await Zotero.Reader.open(r.attachmentID, location);
		let win = Zotero.getMainWindow();
		if (win) win.focus();
		if (reader && r.text && !r.approximate) this._findInReader(reader, r.text);
	},

	/**
	 * Highlight the passage in Zotero's reader by searching its first words.
	 * Uses the reader's internal find state: best effort, silently skipped if the
	 * reader implementation changes.
	 */
	async _findInReader(reader, text) {
		try {
			if (reader._initPromise) await reader._initPromise;
			let internal = null;
			for (let i = 0; i < 20 && !internal; i++) {
				internal = reader._internalReader;
				if (!internal) await Zotero.Promise.delay(250);
			}
			let prev = internal && internal._state && internal._state.primaryViewFindState;
			if (!prev || typeof internal._handleFindStateChange !== 'function') return;
			await Zotero.Promise.delay(500);
			let query = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
			internal._handleFindStateChange(true, { ...prev, popupOpen: true, active: true, query, result: null });
		}
		catch (e) {
			Zotero.debug('Semantic Search: cannot highlight passage in reader: ' + e);
		}
	},

	async copyPrompt(r, button) {
		if (r.text === undefined) await this.S.passages.enrich([r], { text: true, model: this._resultsModel() });
		let query = this.current ? this.current.query : '';
		this._copy(PROMPT.replace('[QUERY]', query).replace('[TEXT]', r.text || ''), button);
	},

	async copyCitation(r, button) {
		let item = r.itemID && Zotero.Items.get(r.itemID);
		if (!item) return;
		let setting = Zotero.Prefs.get('export.quickCopy.setting');
		let text = '';
		try {
			if (setting && setting.startsWith('bibliography')) {
				let content = Zotero.QuickCopy.getContentFromItems([item], setting);
				text = content && content.text ? content.text.trim() : '';
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (!text) text = [r.creators, r.year, r.title].filter(Boolean).join(', ');
		if (Number.isInteger(r.page)) text += `, p. ${r.page + 1}`;
		this._copy(text, button);
	},

	_copy(text, button) {
		Zotero.Utilities.Internal.copyTextToClipboard(text);
		if (button) {
			let old = button.getAttribute('data-l10n-id');
			let args = button.getAttribute('data-l10n-args');
			document.l10n.setAttributes(button, 'semsearch-copied');
			setTimeout(() => document.l10n.setAttributes(button, old, args ? JSON.parse(args) : undefined), 1200);
		}
	},

	async excludeDocument(r) {
		await this.S.indexer.exclude([r.folder_id]);
		if (this.current) {
			this.current.results = this.current.results.filter(x => x.folder_id !== r.folder_id);
			if (this.current.id && !this.current.similar) {
				await this.S.store.updateHistoryResults(this.current.id, this.current.results.map(x => this._historyShape(x)));
			}
		}
		this.renderResults();
		this.loadHistoryList();
	},

	copyList() {
		let results = this._filtered();
		let lines = [];
		let n = 1;
		for (let g of this.S.search.groupByDocument(results)) {
			let r = g.results[0];
			let pages = g.results.filter(x => Number.isInteger(x.page)).map(x => (x.approximate ? '≈' : '') + (x.page + 1));
			let head = [r.creators, r.year, r.title].filter(Boolean).join(', ');
			lines.push(`${n++}. ${head}${pages.length ? ' — p. ' + [...new Set(pages)].join(', ') : ''} (${g.best.toFixed(3)})`);
		}
		this._copy(lines.join('\n'), this.$('copy-list-button'));
	},

	async saveAsCollection() {
		if (!this.current) return;
		let results = this._filtered().filter(r => !r.missing && r.itemID && (r.status || 0) !== STATUS.irrelevant);
		if (!results.length) return;
		let byLibrary = new Map();
		for (let r of results) {
			if (!byLibrary.has(r.libraryID)) byLibrary.set(r.libraryID, new Set());
			byLibrary.get(r.libraryID).add(r.itemID);
		}
		let query = this.current.query.replace(/\s+/g, ' ').trim();
		if (query.length > 60) query = query.slice(0, 60) + '…';
		let name = await document.l10n.formatValue('semsearch-collection-name', { query });
		let total = 0;
		for (let [libraryID, ids] of byLibrary) {
			if (!Zotero.Libraries.get(libraryID).editable) continue;
			let collection = new Zotero.Collection();
			collection.libraryID = libraryID;
			collection.name = name;
			await collection.saveTx();
			await Zotero.DB.executeTransaction(async () => {
				await collection.addItems([...ids]);
			});
			total += ids.size;
			let win = Zotero.getMainWindow();
			if (win && win.ZoteroPane) win.ZoteroPane.collectionsView.selectCollection(collection.id);
		}
		let msg = await document.l10n.formatValue('semsearch-collection-created', { name, count: total });
		let notice = this.$('notice');
		notice.dataset.kind = 'info';
		notice.className = '';
		notice.replaceChildren(this.el('span', { text: msg }));
		notice.hidden = false;
		setTimeout(() => {
			if (notice.dataset.kind === 'info') notice.hidden = true;
		}, 5000);
	},

	// ------------------------------------------------------------ other views

	async showExcluded() {
		this.view = 'excluded';
		this.renderHistory();
		this.$('results-header').hidden = true;
		let container = this.$('results');
		let list = await this.S.store.getExcluded();
		let rows = [this.el('h3', { class: 'view-title', l10n: ['semsearch-excluded-title'] })];
		if (!list.length) rows.push(this.el('div', { class: 'placeholder', l10n: ['semsearch-excluded-empty'] }));
		for (let e of list) {
			let item = await this.S.passages.getItemByKey(e.id);
			let meta = item ? this.S.passages.describeItem(item) : null;
			let row = this.el('div', { class: 'excluded-row' + (item ? '' : ' missing') },
				this.el('div', { class: 'meta' },
					this.el('div', {
						class: 'title',
						text: meta ? meta.title : e.id,
						onclick: () => meta && this.showInLibrary(meta),
					}),
					this.el('div', { class: 'sub' },
						this.el('span', { l10n: ['semsearch-reason-' + e.reason] }),
						` · ${this._formatDate(e.date)}${meta && meta.creators ? ' · ' + meta.creators : ''}`)),
				this._ocrControl(e, item),
				this.el('button', {
					l10n: ['semsearch-excluded-include'],
					onclick: async () => {
						await this.S.indexer.include([e.id]);
						row.remove();
						this._updateExcludedButton();
					},
				}));
			rows.push(row);
		}
		container.replaceChildren(...rows);
	},

	// ------------------------------------------------------------ duplicates

	/** Groups of identical PDFs, to merge or clean up */
	async showDuplicates() {
		this.view = 'duplicates';
		this.renderHistory();
		this.$('results-header').hidden = true;
		let container = this.$('results');
		let D = this.S.duplicates;
		if (!container.querySelector('.dup-group')) {
			container.replaceChildren(this.el('div', { class: 'placeholder', l10n: ['semsearch-searching'] }));
		}
		let groups = await D.groups();
		if (this.view !== 'duplicates') return;
		let rows = [
			this.el('h3', { class: 'view-title', l10n: ['semsearch-dup-title'] }),
			this.el('p', { class: 'view-desc', l10n: ['semsearch-dup-desc'] }),
		];
		if (D.state === 'scanning' && D.progress) {
			rows.push(this.el('p', { class: 'view-desc', l10n: ['semsearch-dup-scanning', { done: D.progress.done, total: D.progress.total }] }));
		}
		if (!groups.length) rows.push(this.el('div', { class: 'placeholder', l10n: ['semsearch-dup-empty'] }));
		for (let g of groups) rows.push(this._dupGroup(g));
		container.replaceChildren(...rows);
		this._updateDuplicatesButton();
	},

	_dupGroup(group) {
		let D = this.S.duplicates;
		let infos = group.items.map(a => D.describe(a));
		let boxes = [];
		let card = this.el('section', { class: 'dup-group' });
		let trashButton;
		let update = () => {
			let n = boxes.filter(b => b.checked).length;
			trashButton.disabled = n === 0 || n === boxes.length;
		};
		let rows = infos.map((info) => {
			let box = this.el('input', { type: 'checkbox', onchange: update });
			box._ssItem = info.attachment;
			boxes.push(box);
			let badge = info.hasMetadata
				? this.el('span', { class: 'dup-badge ok', l10n: ['semsearch-dup-has-metadata', { count: info.fieldCount }] })
				: this.el('span', { class: 'dup-badge', l10n: [info.parent ? 'semsearch-dup-no-metadata' : 'semsearch-dup-no-parent'] });
			let sub = [info.creators, info.year, info.itemType ? this._typeName(info.itemType) : null].filter(Boolean).join(' · ');
			let extras = [];
			if (info.notes) extras.push(this.el('span', { l10n: ['semsearch-dup-notes', { count: info.notes }] }));
			if (info.annotations) extras.push(this.el('span', { l10n: ['semsearch-dup-annotations', { count: info.annotations }] }));
			if (info.collections) extras.push(this.el('span', { l10n: ['semsearch-dup-collections', { count: info.collections }] }));
			let added = this.el('span', { l10n: ['semsearch-dup-added', { date: this._formatDate((info.dateAdded || '').slice(0, 10)) }] });
			return this.el('label', { class: 'dup-row' },
				box,
				this.el('div', { class: 'meta' },
					this.el('div', { class: 'dup-title' },
						this.el('a', {
							class: 'title',
							text: info.title || info.attachment.attachmentFilename,
							onclick: (e) => {
								e.preventDefault();
								this.showInLibrary({ itemID: (info.parent || info.attachment).id });
							},
						}),
						badge),
					this.el('div', { class: 'sub' }, sub || info.attachment.attachmentFilename || ''),
					this.el('div', { class: 'sub dup-extras' }, added, ...extras)));
		});
		let run = async (fn) => {
			this._dupBusy = true;
			card.classList.add('busy');
			try {
				await fn();
			}
			catch (e) {
				this.showError(e);
			}
			finally {
				this._dupBusy = false;
			}
			await this.showDuplicates();
		};
		let mergeButton = this.el('button', {
			class: 'primary',
			l10n: ['semsearch-dup-merge'],
			onclick: () => run(async () => {
				let keep = this._mergeKeeper(infos);
				let msg = await document.l10n.formatValue('semsearch-dup-merge-confirm', { count: infos.length, title: keep });
				if (!Services.prompt.confirm(window, 'Semantic Search', msg)) return;
				await D.merge(group.items);
			}),
		});
		trashButton = this.el('button', {
			l10n: ['semsearch-dup-trash'],
			disabled: true,
			onclick: () => run(async () => {
				let chosen = boxes.filter(b => b.checked).map(b => b._ssItem);
				let msg = await document.l10n.formatValue('semsearch-dup-trash-confirm', { count: chosen.length });
				if (!Services.prompt.confirm(window, 'Semantic Search', msg)) return;
				await D.trash(chosen);
			}),
		});
		let ignoreButton = this.el('button', {
			class: 'link-button',
			l10n: ['semsearch-dup-ignore'],
			onclick: () => run(() => D.ignore(group.hash)),
		});
		let file = group.items[0].attachmentFilename || '';
		card.append(
			this.el('div', { class: 'dup-head' },
				this.el('span', { class: 'dup-file', text: file }),
				this.el('span', { class: 'dup-count', l10n: ['semsearch-dup-copies', { count: infos.length }] })),
			...rows,
			this.el('div', { class: 'actions' }, mergeButton, trashButton, ignoreButton));
		return card;
	},

	/** Title of the item a merge keeps (see SSDuplicates.merge) */
	_mergeKeeper(infos) {
		let withParent = infos.filter(i => i.parent).sort((a, b) => (a.dateModified < b.dateModified ? 1 : -1));
		if (withParent.length) return withParent[0].title;
		return infos.slice().sort((a, b) => (a.dateAdded < b.dateAdded ? -1 : 1))[0].title;
	},

	/** OCR button for documents excluded because their PDF has no text */
	_ocrControl(exclusion, item) {
		if (exclusion.reason !== 'no_text' || !item || !item.isPDFAttachment()) return null;
		if (this.S.ocr.isPending(item.key)) {
			return this.el('span', { class: 'ocr-note', l10n: ['semsearch-ocr-running'] });
		}
		return this.el('button', {
			l10n: ['semsearch-ocr'],
			title: 'ocrmypdf',
			onclick: async () => {
				try {
					await this.S.ocr.start(item);
				}
				catch (err) {
					this.showError(err);
				}
			},
		});
	},

	async showSimilar(key) {
		this.view = 'similar';
		this.renderHistory();
		this.$('results-header').hidden = true;
		let container = this.$('results');
		container.replaceChildren(this.el('div', { class: 'placeholder', l10n: ['semsearch-searching'] }));
		try {
			let item = await this.S.passages.getItemByKey(key);
			let source = item ? this.S.passages.describeItem(item) : { title: key };
			let docs = await this.S.search.similarDocuments(key, 30);
			let rows = [this.el('h3', { class: 'view-title', l10n: ['semsearch-similar-title', { title: source.title }] })];
			for (let d of docs) {
				rows.push(this.el('article', { class: 'result' },
					this.el('div', { class: 'result-head' },
						this._scoreBadge(d.score),
						this.el('div', { class: 'meta' }, this._titleEl(d), this._subline(d, false)),
						this.el('button', {
							l10n: ['semsearch-open-pdf'],
							onclick: () => Zotero.Reader.open(d.attachmentID),
						}))));
			}
			container.replaceChildren(...rows);
		}
		catch (e) {
			this.showError(e);
		}
	},
};

window.SemanticSearchWindow = SemanticSearchWindow;
window.addEventListener('load', () => SemanticSearchWindow.init(), { once: true });
