/* global Zotero, IOUtils, ChromeWorker, setTimeout, clearTimeout */
/* exported SSTextExtractor */

/**
 * Text of PDFs, with the plugin's own instance of Zotero's document worker
 * (the pdf.js-based engine behind Zotero.PDFWorker, so the text is the same).
 *
 * Zotero's PDFWorker serves everyone (full-text indexing, the reader,
 * plugins) through one queue, and has no timeout: a request that never
 * returns blocks the queue until Zotero restarts. Here a request that takes
 * too long terminates the worker, which is recreated for the next PDF, and
 * Zotero's own queue is never touched.
 */
var SSTextExtractor = {
	WORKER_URL: 'resource://zotero/document-worker/worker.js',
	ASSETS_URL: 'resource://zotero/document-worker/',
	READER_PDF_ASSETS_URL: 'resource://zotero/reader/pdf/web/',
	TIMEOUT_MS: 5 * 60 * 1000,

	_worker: null,
	_lastID: 0,
	_pending: new Map(), // id -> {resolve, reject}
	_queue: Promise.resolve(),
	_unavailable: false, // the worker cannot be started in this Zotero version
	_worked: false,

	_assetURL(path) {
		if (path.startsWith('cmaps/') || path.startsWith('standard_fonts/')) return this.READER_PDF_ASSETS_URL + path;
		return this.ASSETS_URL + path;
	},

	_init() {
		if (this._worker) return this._worker;
		let worker = new ChromeWorker(this.WORKER_URL);
		worker.addEventListener('message', async (event) => {
			let message = event.data;
			if ('progressID' in message) return;
			if ('responseID' in message) {
				this._worked = true;
				let p = this._pending.get(message.responseID);
				if (!p) return;
				this._pending.delete(message.responseID);
				if ('error' in message) p.reject(new Error(JSON.stringify(message.error)));
				else p.resolve(message.data);
				return;
			}
			// the worker asks for fonts and character maps
			if ('id' in message) {
				let data = null;
				try {
					if (message.action === 'FetchData') {
						let res = await Zotero.HTTP.request('GET', this._assetURL(message.data), { responseType: 'arraybuffer' });
						data = new Uint8Array(res.response);
					}
				}
				catch (e) {
					Zotero.debug(`Semantic Search: document worker asset ${message.data} not available: ${e}`);
				}
				if (this._worker === worker) {
					worker.postMessage({ responseID: message.id, data }, data ? [data.buffer] : []);
				}
			}
		});
		worker.addEventListener('error', (event) => {
			Zotero.logError(`Semantic Search: document worker error (${event.filename}:${event.lineno}): ${event.message}`);
			// never answered at all: not usable here, fall back to Zotero.PDFWorker
			if (!this._worked) this._unavailable = true;
			this._reset(new Error('The PDF text extractor crashed'));
		});
		this._worker = worker;
		return worker;
	},

	/** Terminate the worker and fail what it was doing */
	_reset(error) {
		let worker = this._worker;
		this._worker = null;
		if (worker) {
			try {
				worker.terminate();
			}
			catch (e) {}
		}
		for (let p of this._pending.values()) p.reject(error);
		this._pending.clear();
	},

	_query(action, data, transfer) {
		let worker = this._init();
		let id = ++this._lastID;
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject });
			worker.postMessage({ id, action, data }, transfer);
		});
	},

	/**
	 * Text of a PDF attachment, pages separated by "\f" ({text} like Zotero.PDFWorker.getFullText).
	 * One PDF at a time; gives up (and restarts the worker) after TIMEOUT_MS.
	 */
	getFullText(item) {
		let run = () => this._extract(item);
		let p = this._queue.then(run, run);
		this._queue = p.catch(() => {});
		return p;
	},

	async _extract(item) {
		if (this._unavailable) return Zotero.PDFWorker.getFullText(item.id, null);
		let path = await item.getFilePathAsync();
		if (!path) throw new Error('File not found');
		let buf = (await IOUtils.read(path)).buffer;
		let timer;
		try {
			return await Promise.race([
				this._query('pdf.getFulltext', { buf, maxPages: null }, [buf]),
				new Promise((resolve, reject) => {
					timer = setTimeout(() => {
						let error = new Error(`Reading the text took more than ${Math.round(this.TIMEOUT_MS / 60000)} minutes`);
						error.name = 'TimeoutError';
						this._reset(error);
						reject(error);
					}, this.TIMEOUT_MS);
				}),
			]);
		}
		catch (e) {
			// Worker missing in this Zotero version: use Zotero's own (no timeout there)
			if (this._unavailable) return Zotero.PDFWorker.getFullText(item.id, null);
			throw e;
		}
		finally {
			clearTimeout(timer);
		}
	},

	shutdown() {
		this._reset(new Error('Shutting down'));
	},
};
