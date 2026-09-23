/* global Zotero, Services, ChromeUtils */
/* global SSModels, SSEvents, SSModelManager, SSStore, SSVectorIndex, SSEmbedder, SSPassages, SSSearch, SSIndexer, SSOcr, SSMcpEndpoint, SSUI */
var { setTimeout, clearTimeout, setInterval, clearInterval } = ChromeUtils.importESModule(
	'resource://gre/modules/Timer.sys.mjs'
);

var SemanticSearchPlugin = {
	STARTUP_DELAY_MS: 20000,
	_startupTimer: null,

	async startup({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		for (let f of ['mcp', 'models', 'f16', 'model-manager', 'embedding-store', 'store', 'vector-index',
			'embedder', 'passages', 'search', 'indexer', 'ocr', 'mcp-endpoint', 'ui']) {
			Services.scriptloader.loadSubScript(rootURI + `content/lib/${f}.js`);
		}

		// Public API used by the UI windows (they run in their own globals)
		Zotero.SemanticSearch = {
			plugin: this,
			models: SSModels,
			events: SSEvents,
			model: SSModelManager,
			store: SSStore,
			index: SSVectorIndex,
			embedder: SSEmbedder,
			passages: SSPassages,
			search: SSSearch,
			indexer: SSIndexer,
			ocr: SSOcr,
			mcp: SSMcpEndpoint,
			ui: SSUI,
		};

		// Choose the default model on first run, then migrate earlier versions' database
		try {
			await SSModels.init();
			await SSStore.open();
		}
		catch (e) {
			Zotero.logError(e);
		}

		SSMcpEndpoint.register();
		SSIndexer.registerNotifier();
		SSUI.startup(this);
		SSOcr.startup().catch(e => Zotero.logError(e));

		// Background work after Zotero has settled: load the index, then pick up new PDFs
		this._startupTimer = setTimeout(() => this._backgroundStart(), this.STARTUP_DELAY_MS);
		Zotero.debug('Semantic Search: started ' + version);
	},

	async _backgroundStart() {
		this._startupTimer = null;
		try {
			if (!(await SSModelManager.isReady())) return;
			await SSVectorIndex.load();
			let building = SSModels.building;
			if (building) {
				// A model switch was in progress: finish downloading, keep building
				await building.files.ensureDownloaded();
				await SSIndexer.indexNew();
			}
			else if (SSIndexer.autoIndex) {
				await SSIndexer.indexNew();
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	onMainWindowLoad(window) {
		SSUI.onMainWindowLoad(window);
	},

	onMainWindowUnload(window) {
		SSUI.onMainWindowUnload(window);
	},

	async shutdown() {
		if (this._startupTimer) clearTimeout(this._startupTimer);
		try {
			SSUI.shutdown();
			SSIndexer.unregisterNotifier();
			SSIndexer.cancel();
			SSOcr.shutdown();
			SSMcpEndpoint.unregister();
			await SSModels.shutdown();
			await SSStore.close();
		}
		catch (e) {
			Zotero.logError(e);
		}
		delete Zotero.SemanticSearch;
	},
};
