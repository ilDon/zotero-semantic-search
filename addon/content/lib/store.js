/* global Zotero, ChromeUtils, IOUtils, PathUtils, SSModels */
/* exported SSStore */

/**
 * The user's own data: saved searches, excluded documents and plugin state,
 * in semantic_search.db next to zotero.sqlite. The passages and vectors of
 * each embedding model live in their own database (see embedding-store.js);
 * the embedding methods below act on the active model's database.
 *
 *   history(id TEXT, date TEXT, query TEXT, query_embedding TEXT, results TEXT, model TEXT)
 *     id = sha256(query) for LEALLA-large (as in the original app),
 *          sha256(model + "\n" + query) for the other models
 *   excluded(id TEXT, date TEXT, reason TEXT)
 *   ss_meta(key TEXT PRIMARY KEY, value TEXT)
 *
 * Migration from earlier versions, which kept everything in
 * file_embeddings.db: the file is renamed file_embeddings_lealla.db (it stays
 * the LEALLA passage database, in its original format) and its history,
 * excluded and ss_meta rows are copied here.
 */
var SSStore = {
	FILE: 'semantic_search.db',
	_conn: null,
	_path: null,
	_opening: null,
	migrationNotice: null, // set when a stray legacy database was found

	get path() {
		return PathUtils.join(SSModels.dataDir, this.FILE);
	},

	async open() {
		if (this._conn && this._path === this.path) return this._conn;
		if (this._opening) return this._opening;
		this._opening = (async () => {
			if (this._conn) await this.close();
			const { Sqlite } = ChromeUtils.importESModule('resource://gre/modules/Sqlite.sys.mjs');
			await this.migrateFiles(SSModels.dataDir);
			let path = this.path;
			let isNew = !(await IOUtils.exists(path));
			let conn = await Sqlite.openConnection({ path });
			await this._createTables(conn);
			if (isNew) await this._importLegacy(conn);
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
		await conn.execute('CREATE INDEX IF NOT EXISTS ss_excluded_id ON excluded(id)');
		await conn.execute('CREATE INDEX IF NOT EXISTS ss_history_id ON history(id)');
	},

	/**
	 * Rename file_embeddings.db to file_embeddings_lealla.db (once).
	 * Not done when a custom database path is set (that path is the LEALLA database).
	 */
	async migrateFiles(dir) {
		if (Zotero.Prefs.get('extensions.semantic-search.dbPath', true)) return;
		let spec = SSModels.registry.lealla;
		let legacy = PathUtils.join(dir, spec.legacyDbFile);
		let target = PathUtils.join(dir, spec.dbFile);
		if (!(await IOUtils.exists(legacy))) return;
		if (await IOUtils.exists(target)) {
			// Probably recreated by an older version of the plugin on another computer
			// sharing this data directory: leave both alone and tell the user
			this.migrationNotice = { legacy, target };
			Zotero.debug(`Semantic Search: both ${legacy} and ${target} exist; using the latter`);
			return;
		}
		// A leftover journal means an interrupted transaction: let SQLite recover it first
		if (await IOUtils.exists(legacy + '-journal') || await IOUtils.exists(legacy + '-wal')) {
			const { Sqlite } = ChromeUtils.importESModule('resource://gre/modules/Sqlite.sys.mjs');
			let c = await Sqlite.openConnection({ path: legacy });
			await c.execute('SELECT count(*) FROM sqlite_master');
			await c.close();
		}
		await IOUtils.move(legacy, target, { noOverwrite: true });
		Zotero.debug(`Semantic Search: renamed ${legacy} to ${target}`);
	},

	/** Copy searches, exclusions and state from the LEALLA database (earlier versions) */
	async _importLegacy(conn) {
		let lealla = SSModels.dbPath('lealla');
		if (!(await IOUtils.exists(lealla))) return;
		try {
			await conn.execute('ATTACH DATABASE ? AS legacy', [lealla]);
			try {
				let tables = (await conn.execute("SELECT name FROM legacy.sqlite_master WHERE type = 'table'"))
					.map(r => r.getResultByIndex(0));
				await conn.executeTransaction(async () => {
					if (tables.includes('history')) {
						await conn.execute(`INSERT INTO history (id, date, query, query_embedding, results, model)
							SELECT id, date, query, query_embedding, results, 'lealla' FROM legacy.history ORDER BY rowid`);
					}
					if (tables.includes('excluded')) {
						await conn.execute('INSERT INTO excluded (id, date, reason) SELECT id, date, reason FROM legacy.excluded ORDER BY rowid');
					}
					if (tables.includes('ss_meta')) {
						await conn.execute('INSERT OR REPLACE INTO ss_meta (key, value) SELECT key, value FROM legacy.ss_meta');
					}
				});
			}
			finally {
				await conn.execute('DETACH DATABASE legacy');
			}
			Zotero.debug('Semantic Search: imported searches and exclusions from ' + lealla);
		}
		catch (e) {
			Zotero.logError(e);
		}
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
		let rows = await conn.execute('SELECT id, query, date, results, model FROM history ORDER BY date DESC, rowid DESC');
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
			out.push({ id, query: r.getResultByIndex(1), date: r.getResultByIndex(2), count, model: r.getResultByIndex(4) || 'lealla' });
		}
		return out;
	},

	async getHistory(id) {
		let conn = await this.open();
		let rows = await conn.execute(
			'SELECT id, query, date, results, model FROM history WHERE id = ? ORDER BY rowid DESC LIMIT 1', [id]);
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
		};
	},

	async saveHistory(id, query, queryEmbedding, results, model) {
		let conn = await this.open();
		let qe = JSON.stringify([Array.from(queryEmbedding, x => Math.fround(x))]);
		await conn.executeTransaction(async () => {
			await conn.execute('DELETE FROM history WHERE id = ?', [id]);
			await conn.execute(
				'INSERT INTO history (id, date, query, query_embedding, results, model) VALUES (?, ?, ?, ?, ?, ?)',
				[id, this.today(), query, qe, JSON.stringify(results), model]
			);
		});
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
