/* global ChromeUtils, PathUtils, SSModels, SSEvents */
/* exported SSStore */

/**
 * The user's own data: saved searches, excluded documents and plugin state,
 * in semantic_search.db next to zotero.sqlite. The passages and vectors of
 * each embedding model live in their own database (see embedding-store.js);
 * the embedding methods below act on the active model's database.
 *
 *   history(id TEXT, date TEXT, query TEXT, query_embedding TEXT, results TEXT, model TEXT, source TEXT)
 *     id = sha256(query) for LEALLA-large, sha256(model + "\n" + query) for the
 *          other models, prefixed by "mcp\n" for searches made by AI assistants
 *     source = 'mcp' for searches made by AI assistants, NULL for the user's own
 *   excluded(id TEXT, date TEXT, reason TEXT)
 *   ss_meta(key TEXT PRIMARY KEY, value TEXT)
 */
var SSStore = {
	FILE: 'semantic_search.db',
	_conn: null,
	_path: null,
	_opening: null,

	get path() {
		return PathUtils.join(SSModels.dataDir, this.FILE);
	},

	async open() {
		if (this._conn && this._path === this.path) return this._conn;
		if (this._opening) return this._opening;
		this._opening = (async () => {
			if (this._conn) await this.close();
			const { Sqlite } = ChromeUtils.importESModule('resource://gre/modules/Sqlite.sys.mjs');
			let path = this.path;
			let conn = await Sqlite.openConnection({ path });
			await this._createTables(conn);
			this._conn = conn;
			this._path = path;
			return conn;
		})();
		try {
			return await this._opening;
		}
		finally {
			this._opening = null;
		}
	},

	async close() {
		if (this._conn) {
			let c = this._conn;
			this._conn = null;
			await c.close();
		}
	},

	async _createTables(conn) {
		await conn.execute('CREATE TABLE IF NOT EXISTS excluded (id TEXT, date TEXT, reason TEXT)');
		await conn.execute(`CREATE TABLE IF NOT EXISTS history (
			id TEXT, date TEXT, query TEXT, query_embedding TEXT, results TEXT, model TEXT)`);
		await conn.execute('CREATE TABLE IF NOT EXISTS ss_meta (key TEXT PRIMARY KEY, value TEXT)');
		let cols = (await conn.execute('PRAGMA table_info(history)')).map(r => r.getResultByName('name'));
		if (!cols.includes('source')) await conn.execute('ALTER TABLE history ADD COLUMN source TEXT');
		await conn.execute('CREATE INDEX IF NOT EXISTS ss_excluded_id ON excluded(id)');
		await conn.execute('CREATE INDEX IF NOT EXISTS ss_history_id ON history(id)');
	},

	today() {
		let d = new Date();
		let pad = n => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	},

	// ---- passages of the active model (see embedding-store.js) ----

	get embeddings() {
		return SSModels.active.store;
	},

	fileSize() {
		return this.embeddings.fileSize();
	},

	hasIdIndex() {
		return this.embeddings.hasIdIndex();
	},

	ensureIdIndex() {
		return this.embeddings.ensureIdIndex();
	},

	getIndexedIDs() {
		return this.embeddings.getIndexedIDs();
	},

	getLegacyDocumentIDs() {
		return this.embeddings.getLegacyDocumentIDs();
	},

	getAllRowids() {
		return this.embeddings.getAllRowids();
	},

	forEachEmbedding(onRow, rowids) {
		return this.embeddings.forEachEmbedding(onRow, rowids);
	},

	getVectors(rowids) {
		return this.embeddings.getVectors(rowids);
	},

	getChunkInfo(rowids) {
		return this.embeddings.getChunkInfo(rowids);
	},

	findRowids(pairs) {
		return this.embeddings.findRowids(pairs);
	},

	countSections(id) {
		return this.embeddings.countSections(id);
	},

	getDocumentInfo(id) {
		return this.embeddings.getDocumentInfo(id);
	},

	getDocumentChunks(id) {
		return this.embeddings.getDocumentChunks(id);
	},

	setLegacyLocation(rowid, text, page, charStart) {
		return this.embeddings.setLegacyLocation(rowid, text, page, charStart);
	},

	deleteDocument(id) {
		return this.embeddings.deleteDocument(id);
	},

	// ---- excluded ----

	async getExcluded() {
		let conn = await this.open();
		let rows = await conn.execute('SELECT id, reason, date FROM excluded ORDER BY date DESC');
		return rows.map(r => ({
			id: r.getResultByIndex(0),
			reason: r.getResultByIndex(1),
			date: r.getResultByIndex(2),
		}));
	},

	async getExcludedIDs() {
		return new Set((await this.getExcluded()).map(e => e.id));
	},

	async getExclusion(id) {
		let conn = await this.open();
		let rows = await conn.execute('SELECT reason, date FROM excluded WHERE id = ? LIMIT 1', [id]);
		return rows.length ? { reason: rows[0].getResultByIndex(0), date: rows[0].getResultByIndex(1) } : null;
	},

	/** Exclude a document; like the original app, its passages are removed (from every model) */
	async addExcluded(id, reason) {
		let conn = await this.open();
		await conn.executeTransaction(async () => {
			await conn.execute('DELETE FROM excluded WHERE id = ?', [id]);
			await conn.execute('INSERT INTO excluded (id, reason, date) VALUES (?, ?, ?)', [id, reason, this.today()]);
		});
		await SSModels.deleteDocumentEverywhere(id);
	},

	async removeExcluded(id) {
		let conn = await this.open();
		await conn.execute('DELETE FROM excluded WHERE id = ?', [id]);
	},

	// ---- history ----

	async listHistory() {
		let conn = await this.open();
		let rows = await conn.execute('SELECT id, query, date, results, model, source FROM history ORDER BY date DESC, rowid DESC');
		let seen = new Set();
		let out = [];
		for (let r of rows) {
			let id = r.getResultByIndex(0);
			if (seen.has(id)) continue;
			seen.add(id);
			let count = 0;
			try {
				count = JSON.parse(r.getResultByIndex(3)).length;
			}
			catch (e) {}
			out.push({
				id,
				query: r.getResultByIndex(1),
				date: r.getResultByIndex(2),
				count,
				model: r.getResultByIndex(4) || 'lealla',
				source: r.getResultByIndex(5) === 'mcp' ? 'mcp' : 'manual',
			});
		}
		return out;
	},

	async getHistory(id) {
		let conn = await this.open();
		let rows = await conn.execute(
			'SELECT id, query, date, results, model, source FROM history WHERE id = ? ORDER BY rowid DESC LIMIT 1', [id]);
		if (!rows.length) return null;
		let r = rows[0];
		let results = [];
		try {
			results = JSON.parse(r.getResultByIndex(3)) || [];
		}
		catch (e) {}
		return {
			id: r.getResultByIndex(0),
			query: r.getResultByIndex(1),
			date: r.getResultByIndex(2),
			results,
			model: r.getResultByIndex(4) || 'lealla',
			source: r.getResultByIndex(5) === 'mcp' ? 'mcp' : 'manual',
		};
	},

	async saveHistory(id, query, queryEmbedding, results, model, source = 'manual') {
		let conn = await this.open();
		let qe = JSON.stringify([Array.from(queryEmbedding, x => Math.fround(x))]);
		await conn.executeTransaction(async () => {
			await conn.execute('DELETE FROM history WHERE id = ?', [id]);
			await conn.execute(
				'INSERT INTO history (id, date, query, query_embedding, results, model, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
				[id, this.today(), query, qe, JSON.stringify(results), model, source === 'mcp' ? 'mcp' : null]
			);
		});
		SSEvents.emit('history');
	},

	async updateHistoryResults(id, results) {
		let conn = await this.open();
		await conn.execute('UPDATE history SET results = ? WHERE id = ?', [JSON.stringify(results), id]);
	},

	async deleteHistory(id) {
		let conn = await this.open();
		await conn.execute('DELETE FROM history WHERE id = ?', [id]);
	},

	// ---- meta ----

	async getMeta(key) {
		let conn = await this.open();
		let rows = await conn.execute('SELECT value FROM ss_meta WHERE key = ?', [key]);
		return rows.length ? rows[0].getResultByIndex(0) : null;
	},

	async setMeta(key, value) {
		let conn = await this.open();
		await conn.execute('INSERT OR REPLACE INTO ss_meta (key, value) VALUES (?, ?)', [key, String(value)]);
	},
};
