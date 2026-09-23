/* global Zotero, Services, SSStore, SSVectorIndex, SSIndexer, SSSearch, SSPassages, SSModelManager, SSOcr */
/* exported SSUI */

/**
 * Integration with the Zotero main window: Tools menu, item context menu,
 * keyboard shortcut, item pane section and preferences pane.
 */
var SSUI = {
	WINDOW_URL: 'chrome://semantic-search/content/ui/search.xhtml',
	WINDOW_TYPE: 'zotero:semantic-search',
	ICON: 'chrome://semantic-search/content/icons/semantic-search.svg',
	FTL: 'semantic-search.ftl',

	_menuIDs: [],
	_paneID: null,
	_prefPaneID: null,
	_unsubscribe: [],

	startup(plugin) {
		this.plugin = plugin;
		this._registerMenus();
		this._registerItemPane();
		Zotero.PreferencePanes.register({
			pluginID: plugin.id,
			src: plugin.rootURI + 'content/ui/preferences.xhtml',
			scripts: [plugin.rootURI + 'content/ui/preferences.js'],
			stylesheets: [plugin.rootURI + 'content/ui/preferences.css'],
			label: Zotero.locale.startsWith('it') ? 'Ricerca semantica' : 'Semantic Search',
			image: this.ICON,
		}).then((id) => {
			this._prefPaneID = id;
		});
		for (let win of Zotero.getMainWindows()) this.onMainWindowLoad(win);
	},

	shutdown() {
		for (let id of this._menuIDs) Zotero.MenuManager.unregisterMenu(id);
		this._menuIDs = [];
		if (this._paneID) Zotero.ItemPaneManager.unregisterSection(this._paneID);
		this._paneID = null;
		if (this._prefPaneID) Zotero.PreferencePanes.unregister(this._prefPaneID);
		for (let fn of this._unsubscribe) fn();
		this._unsubscribe = [];
		for (let win of Zotero.getMainWindows()) this.onMainWindowUnload(win);
		let enumerator = Services.wm.getEnumerator(this.WINDOW_TYPE);
		while (enumerator.hasMoreElements()) enumerator.getNext().close();
	},

	onMainWindowLoad(win) {
		let doc = win.document;
		win.MozXULElement.insertFTLIfNeeded(this.FTL);
		if (doc.getElementById('semsearch-key')) return;
		let keyset = doc.getElementById('mainKeyset') || doc.querySelector('keyset');
		if (!keyset) {
			keyset = doc.createXULElement('keyset');
			doc.documentElement.appendChild(keyset);
		}
		let key = doc.createXULElement('key');
		key.id = 'semsearch-key';
		key.setAttribute('key', 'E');
		key.setAttribute('modifiers', 'accel,shift');
		key.addEventListener('command', () => this.openWindow());
		keyset.appendChild(key);
	},

	onMainWindowUnload(win) {
		let doc = win.document;
		let key = doc.getElementById('semsearch-key');
		if (key) key.remove();
		let link = doc.querySelector(`link[href="${this.FTL}"]`);
		if (link) link.remove();
	},

	/**
	 * Open (or focus) the search window.
	 * @param {Object} [args] - {query}, {similarTo: attachmentKey}, {historyID}
	 */
	openWindow(args = {}) {
		let existing = Services.wm.getMostRecentWindow(this.WINDOW_TYPE);
		if (existing) {
			existing.focus();
			if (existing.SemanticSearchWindow) existing.SemanticSearchWindow.handleArgs(args);
			return existing;
		}
		let win = Zotero.getMainWindow();
		return win.openDialog(this.WINDOW_URL, '', 'chrome,resizable,centerscreen,dialog=no', args);
	},

	/** PDF attachments of the selected items */
	pdfAttachments(items) {
		let out = [];
		let seen = new Set();
		for (let item of items || []) {
			let atts = [];
			if (item.isPDFAttachment()) atts.push(item);
			else if (item.isRegularItem()) {
				atts = item.getAttachments().map(id => Zotero.Items.get(id)).filter(a => a && a.isPDFAttachment());
			}
			for (let a of atts) {
				if (!seen.has(a.id)) {
					seen.add(a.id);
					out.push(a);
				}
			}
		}
		return out;
	},

	_registerMenus() {
		let pluginID = this.plugin.id;
		let id = Zotero.MenuManager.registerMenu({
			menuID: 'semsearch-tools',
			pluginID,
			target: 'main/menubar/tools',
			menus: [{
				menuType: 'menuitem',
				l10nID: 'semsearch-menuitem-open',
				icon: this.ICON,
				onCommand: () => this.openWindow(),
			}],
		});
		if (id) this._menuIDs.push(id);

		let selected = ctx => this.pdfAttachments(ctx.items || []);
		id = Zotero.MenuManager.registerMenu({
			menuID: 'semsearch-item',
			pluginID,
			target: 'main/library/item',
			menus: [{
				menuType: 'submenu',
				l10nID: 'semsearch-menuitem-item',
				icon: this.ICON,
				onShowing: (ev, ctx) => {
					ctx.setVisible(selected(ctx).length > 0);
				},
				menus: [
					{
						menuType: 'menuitem',
						l10nID: 'semsearch-menuitem-find-similar',
						onShowing: (ev, ctx) => ctx.setEnabled(selected(ctx).length === 1),
						onCommand: (ev, ctx) => {
							let a = selected(ctx)[0];
							if (a) this.openWindow({ similarTo: a.key });
						},
					},
					{
						menuType: 'menuitem',
						l10nID: 'semsearch-menuitem-search-abstract',
						onShowing: (ev, ctx) => {
							let items = ctx.items || [];
							ctx.setVisible(items.length === 1 && items[0].isRegularItem()
								&& !!items[0].getField('abstractNote'));
						},
						onCommand: (ev, ctx) => {
							let item = (ctx.items || [])[0];
							if (item) this.openWindow({ query: item.getField('abstractNote') });
						},
					},
					{ menuType: 'separator' },
					{
						menuType: 'menuitem',
						l10nID: 'semsearch-menuitem-index',
						onCommand: (ev, ctx) => SSIndexer.indexItems(selected(ctx)).catch(e => this.alertError(e)),
					},
					{
						menuType: 'menuitem',
						l10nID: 'semsearch-menuitem-reindex',
						onCommand: (ev, ctx) => SSIndexer.indexItems(selected(ctx), { force: true }).catch(e => this.alertError(e)),
					},
					{
						menuType: 'menuitem',
						l10nID: 'semsearch-menuitem-exclude',
						onCommand: (ev, ctx) => SSIndexer.exclude(selected(ctx).map(a => a.key)).catch(e => this.alertError(e)),
					},
					{
						menuType: 'menuitem',
						l10nID: 'semsearch-menuitem-include',
						onCommand: (ev, ctx) => SSIndexer.include(selected(ctx).map(a => a.key)).catch(e => this.alertError(e)),
					},
				],
			}],
		});
		if (id) this._menuIDs.push(id);
	},

	alertError(e) {
		Zotero.logError(e);
		Services.prompt.alert(Zotero.getMainWindow(), 'Semantic Search', String(e.message || e));
	},

	// ------------------------------------------------------------ item pane

	_registerItemPane() {
		let refreshers = new Set();
		let refreshAll = () => {
			for (let r of refreshers) {
				try {
					r();
				}
				catch (e) {}
			}
		};
		let pending = null;
		let throttled = () => {
			if (pending) return;
			pending = setTimeout(() => {
				pending = null;
				refreshAll();
			}, 1000);
		};
		this._unsubscribe.push(SSIndexer.onChange(throttled));
		this._unsubscribe.push(SSOcr.onChange(throttled));
		this._unsubscribe.push(SSVectorIndex.onChange(() => {
			if (SSVectorIndex.loaded) throttled();
		}));

		this._paneID = Zotero.ItemPaneManager.registerSection({
			paneID: 'semantic-search',
			pluginID: this.plugin.id,
			header: { l10nID: 'semsearch-pane-header', icon: this.ICON },
			sidenav: { l10nID: 'semsearch-pane-sidenav', icon: this.ICON },
			onInit: ({ body, refresh }) => {
				body._ssRefresh = refresh;
				refreshers.add(refresh);
			},
			onDestroy: ({ body }) => {
				refreshers.delete(body._ssRefresh);
			},
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(this.pdfAttachments([item]).length > 0);
				return true;
			},
			onRender: ({ doc, body }) => {
				// May be called again without a following onAsyncRender: build the
				// skeleton once and never clear rendered content here
				if (body.querySelector('.ss-content')) return;
				body.classList.add('semsearch-pane');
				let style = doc.createElement('style');
				style.textContent = `
					.semsearch-pane { display: flex; flex-direction: column; gap: 6px; padding-block: 2px 6px; }
					.semsearch-pane .ss-content { display: flex; flex-direction: column; gap: 6px; }
					.semsearch-pane .ss-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
					.semsearch-pane .ss-status { color: var(--fill-secondary); }
					.semsearch-pane .ss-att { font-weight: 600; }
					.semsearch-pane .ss-similar { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; }
					.semsearch-pane .ss-similar a { color: var(--accent-blue); cursor: pointer; text-decoration: none; }
					.semsearch-pane .ss-similar a:hover { text-decoration: underline; }
					.semsearch-pane .ss-score { font-variant-numeric: tabular-nums; color: var(--fill-secondary); margin-inline-end: 6px; }
					.semsearch-pane .ss-subhead { margin-top: 4px; font-weight: 600; }
					.semsearch-pane button { margin: 0; }
				`;
				let content = doc.createElement('div');
				content.className = 'ss-content';
				body.append(style, content);
			},
			onAsyncRender: async ({ doc, body, item, setSectionSummary }) => {
				let content = body.querySelector('.ss-content');
				if (!content) return;
				let atts = this.pdfAttachments([item]);
				let frag = doc.createDocumentFragment();
				let summary = '';
				for (let a of atts) {
					let row = await this._attachmentRow(doc, a, atts.length > 1);
					frag.appendChild(row.el);
					summary = summary || row.summary;
				}
				// Similar documents (only if the index is already loaded: never block the pane)
				let indexed = atts.find(a => SSVectorIndex.loaded && SSVectorIndex.hasDocument(a.key));
				if (indexed) {
					let head = doc.createElement('div');
					head.className = 'ss-subhead';
					doc.l10n.setAttributes(head, 'semsearch-pane-similar');
					frag.appendChild(head);
					let list = doc.createElement('ul');
					list.className = 'ss-similar';
					frag.appendChild(list);
					SSSearch.similarDocuments(indexed.key, 5).then((docs) => {
						if (!docs.length) {
							let li = doc.createElement('li');
							doc.l10n.setAttributes(li, 'semsearch-pane-similar-none');
							list.appendChild(li);
						}
						for (let d of docs) {
							let li = doc.createElement('li');
							let score = doc.createElement('span');
							score.className = 'ss-score';
							score.textContent = d.score.toFixed(2);
							let link = doc.createElement('a');
							link.textContent = [d.creators, d.year].filter(Boolean).join(' ') + (d.creators || d.year ? ' – ' : '') + d.title;
							link.title = d.title;
							link.addEventListener('click', () => Zotero.getActiveZoteroPane().selectItem(d.itemID));
							li.append(score, link);
							list.appendChild(li);
						}
					}).catch(e => Zotero.debug('Semantic Search: similar documents failed: ' + e));
				}
				content.replaceChildren(frag);
				if (summary) setSectionSummary(summary);
			},
		});
	},

	async _attachmentRow(doc, att, showName) {
		let el = doc.createElement('div');
		el.className = 'ss-row';
		if (showName) {
			let name = doc.createElement('span');
			name.className = 'ss-att';
			name.textContent = att.getField('title');
			el.appendChild(name);
		}
		let status = doc.createElement('span');
		status.className = 'ss-status';
		el.appendChild(status);
		let buttons = [];
		let summary = '';
		let current = SSIndexer.current.get(att.key);
		let queued = SSIndexer.queue.some(q => q.key === att.key);
		let exclusion = await SSStore.getExclusion(att.key);
		let info = exclusion ? null : await SSStore.getDocumentInfo(att.key);
		if (current) {
			doc.l10n.setAttributes(status, 'semsearch-pane-indexing', { done: current.done, total: current.total || '?' });
		}
		else if (queued) {
			doc.l10n.setAttributes(status, 'semsearch-pane-queued');
		}
		else if (exclusion) {
			let reason = await doc.l10n.formatValue('semsearch-reason-' + exclusion.reason).catch(() => exclusion.reason);
			doc.l10n.setAttributes(status, 'semsearch-pane-excluded', { reason: reason || exclusion.reason });
			if (exclusion.reason === 'no_text') {
				if (SSOcr.isPending(att.key)) {
					let note = doc.createElement('span');
					note.className = 'ss-status';
					doc.l10n.setAttributes(note, 'semsearch-ocr-running');
					el.appendChild(note);
				}
				else {
					buttons.push(['semsearch-ocr', () => SSOcr.start(att)]);
				}
			}
			buttons.push(['semsearch-menu-include', () => SSIndexer.include([att.key])]);
		}
		else if (info) {
			let date = info.date ? new Date(info.date + 'T00:00:00').toLocaleDateString() : '';
			doc.l10n.setAttributes(status, info.scheme === 2 ? 'semsearch-pane-indexed' : 'semsearch-pane-indexed-legacy',
				{ count: info.sections, date });
			summary = String(info.sections);
			buttons.push(['semsearch-menu-find-similar', () => this.openWindow({ similarTo: att.key })]);
			buttons.push(['semsearch-menu-reindex', () => SSIndexer.indexItems([att], { force: true })]);
			buttons.push(['semsearch-menu-exclude', () => SSIndexer.exclude([att.key])]);
		}
		else {
			doc.l10n.setAttributes(status, 'semsearch-pane-not-indexed');
			buttons.push(['semsearch-menu-index', () => SSIndexer.indexItems([att])]);
			buttons.push(['semsearch-menu-exclude', () => SSIndexer.exclude([att.key])]);
		}
		for (let [l10n, fn] of buttons) {
			let b = doc.createElement('button');
			doc.l10n.setAttributes(b, l10n);
			b.addEventListener('click', async () => {
				try {
					await fn();
				}
				catch (e) {
					this.alertError(e);
				}
			});
			el.appendChild(b);
		}
		return { el, summary };
	},
};
