/* global Zotero, ChromeUtils, IOUtils, PathUtils */
/* exported SSStore */

/**
 * Access to file_embeddings.db — the SQLite database created by the original
 * Python app, kept in the Zotero data directory.
 *
 * Legacy schema (kept as is, so existing databases keep working):
 *   embeddings(id TEXT, date TEXT, file_name TEXT, section_number INTEGER, embedding TEXT)
 *     id = attachment key (= storage folder name), embedding = JSON array of 256 floats
 *   excluded(id TEXT, date TEXT, reason TEXT)
 *   history(id TEXT, date TEXT, query TEXT, query_embedding TEXT, results TEXT)
 *     id = sha256(query), query_embedding = JSON [[256 floats]], results = JSON list
 *
 * Additive changes made here:
 *   embeddings.scheme (NULL = legacy 2500-char sections, 2 = 128-token passages),
 *   embeddings.chunk_text, embeddings.page (0-based), embeddings.char_start,
 *   indexes on embeddings(id), excluded(id), history(id), table ss_meta.
 */
var SSStore = {
	_conn: null,
	_path: null,
	_opening: null,

	get path() {
		let custom = Zotero.Prefs.get('extensions.semantic-search.dbPath', true);
		return custom || PathUtils.join(Zotero.DataDirectory.dir, 'file_embeddings.db');
	},

	async open() {
		if (this._conn && this._path === this.path) return this._conn;
		if (this._opening) return this._opening;
		this._opening = (async () => {
			if (this._conn) await this.close();
			const { Sqlite } = ChromeUtils.importESModule('resource://gre/modules/Sqlite.sys.mjs');
			let path = this.path;
			let conn = await Sqlite.openConnection({ path });
			await this._migrate(conn);
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

	async _migrate(conn) {
		await conn.execute(`CREATE TABLE IF NOT EXISTS embeddings (
			id TEXT, date TEXT, file_name TEXT, section_number INTEGER, embedding TEXT)`);
		await conn.execute('CREATE TABLE IF NOT EXISTS excluded (id TEXT, date TEXT, reason TEXT)');
		await conn.execute(`CREATE TABLE IF NOT EXISTS history (
			id TEXT, date TEXT, query TEXT, query_embedding TEXT, results TEXT)`);
		await conn.execute('CREATE TABLE IF NOT EXISTS ss_meta (key TEXT PRIMARY KEY, value TEXT)');
		let cols = (await conn.execute('PRAGMA table_info(embeddings)')).map(r => r.getResultByName('name'));
		for (let [name, type] of [['scheme', 'INTEGER'], ['chunk_text', 'TEXT'], ['page', 'INTEGER'], ['char_start', 'INTEGER']]) {
			if (!cols.includes(name)) {
				await conn.execute(`ALTER TABLE embeddings ADD COLUMN ${name} ${type}`);
			}
		}
		await conn.execute('CREATE INDEX IF NOT EXISTS ss_excluded_id ON excluded(id)');
		await conn.execute('CREATE INDEX IF NOT EXISTS ss_history_id ON history(id)');
	},

	/**
	 * The index on embeddings(id) makes per-document operations and rowid scans
	 * fast. Building it reads the whole (possibly multi-GB) table once.
	 */
	async hasIdIndex() {
		let conn = await this.open();
		let rows = await conn.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='ss_embeddings_id'");
		return rows.length > 0;
	},

	async ensureIdIndex() {
		let conn = await this.open();
		if (await this.hasIdIndex()) return false;
		await conn.execute('CREATE INDEX IF NOT EXISTS ss_embeddings_id ON embeddings(id)');
		return true;
	},

	today() {
		let d = new Date();
		let pad = n => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	},

	async fileSize() {
		try {
			return (await IOUtils.stat(this.path)).size;
		}
		catch (e) {
			return 0;
		}
	},

	// ---- embeddings ----

	async getIndexedIDs() {
		let conn = await this.open();
		let ids = new Set();
		await conn.execute('SELECT DISTINCT id FROM embeddings', null, (row) => {
			ids.add(row.getResultByIndex(0));
		});
		return ids;
	},

	/** Documents indexed by the original app (2500-char sections) */
	async getLegacyDocumentIDs() {
		let conn = await this.open();
		let ids = [];
		await conn.execute('SELECT DISTINCT id FROM embeddings WHERE scheme IS NULL', null, (row) => {
			ids.push(row.getResultByIndex(0));
		});
		return ids;
	},

	async getAllRowids() {
		let conn = await this.open();
		let out = [];
		// Uses the covering index on id when present (much cheaper than a table scan)
		await conn.execute('SELECT rowid FROM embeddings', null, (row) => {
			out.push(row.getResultByIndex(0));
		});
		return out;
	},

	/**
	 * Stream embeddings. onRow(rowid, id, fileName, section, vectorArray, scheme)
	 * @param {number[]} [rowids] - restrict to these rowids
	 */
	async forEachEmbedding(onRow, rowids) {
		let conn = await this.open();
		let sql = 'SELECT rowid, id, file_name, section_number, embedding, scheme FROM embeddings';
		let handler = (row) => {
			let vec;
			try {
				vec = JSON.parse(row.getResultByIndex(4));
			}
			catch (e) {
				return;
			}
			if (Array.isArray(vec[0])) vec = vec[0];
			onRow(row.getResultByIndex(0), row.getResultByIndex(1), row.getResultByIndex(2),
				row.getResultByIndex(3), vec, row.getResultByIndex(5));
		};
		if (!rowids) {
			await conn.execute(sql, null, handler);
			return;
		}
		for (let i = 0; i < rowids.length; i += 500) {
			let part = rowids.slice(i, i + 500);
			await conn.execute(`${sql} WHERE rowid IN (${part.map(() => '?').join(',')})`, part, handler);
		}
	},

	/** @returns {Map<number, Float64Array>} exact vectors for rowids */
	async getVectors(rowids) {
		let out = new Map();
		await this.forEachEmbedding((rowid, id, fn, sec, vec) => {
			out.set(rowid, Float64Array.from(vec));
		}, rowids);
		return out;
	},

	/** @returns {Map<number, {id, fileName, section, scheme, text, page, charStart}>} */
	async getChunkInfo(rowids) {
		let conn = await this.open();
		let out = new Map();
		for (let i = 0; i < rowids.length; i += 500) {
			let part = rowids.slice(i, i + 500);
			await conn.execute(
				`SELECT rowid, id, file_name, section_number, scheme, chunk_text, page, char_start
				FROM embeddings WHERE rowid IN (${part.map(() => '?').join(',')})`,
				part,
				(row) => {
					out.set(row.getResultByIndex(0), {
						id: row.getResultByIndex(1),
						fileName: row.getResultByIndex(2),
						section: row.getResultByIndex(3),
						scheme: row.getResultByIndex(4),
						text: row.getResultByIndex(5),
						page: row.getResultByIndex(6),
						charStart: row.getResultByIndex(7),
					});
				}
			);
		}
		return out;
	},

	/** @param {Array<[string, number]>} pairs - [id, section_number] */
	async findRowids(pairs) {
		let conn = await this.open();
		let out = new Map();
		let ids = [...new Set(pairs.map(p => p[0]))];
		for (let i = 0; i < ids.length; i += 500) {
			let part = ids.slice(i, i + 500);
			await conn.execute(
				`SELECT rowid, id, section_number, scheme FROM embeddings WHERE id IN (${part.map(() => '?').join(',')})`,
				part,
				(row) => {
					out.set(row.getResultByIndex(1) + '\u0000' + row.getResultByIndex(2), {
						rowid: row.getResultByIndex(0),
						scheme: row.getResultByIndex(3),
					});
				}
			);
		}
		return out;
	},

	async countSections(id) {
		let conn = await this.open();
		let rows = await conn.execute('SELECT count(*) FROM embeddings WHERE id = ?', [id]);
		return rows[0].getResultByIndex(0);
	},

	async getDocumentInfo(id) {
		let conn = await this.open();
		let rows = await conn.execute(
			`SELECT count(*) AS n, min(date) AS date, max(scheme) AS scheme, max(file_name) AS file_name
			FROM embeddings WHERE id = ?`, [id]);
		let r = rows[0];
		let n = r.getResultByName('n');
		if (!n) return null;
		return {
			sections: n,
			date: r.getResultByName('date'),
			scheme: r.getResultByName('scheme') || 1,
			fileName: r.getResultByName('file_name'),
		};
	},

	async getDocumentChunks(id) {
		let conn = await this.open();
		let rows = await conn.execute(
			`SELECT rowid, section_number, chunk_text, page, char_start, scheme
			FROM embeddings WHERE id = ? ORDER BY section_number`, [id]);
		return rows.map(r => ({
			rowid: r.getResultByIndex(0),
			section: r.getResultByIndex(1),
			text: r.getResultByIndex(2),
			page: r.getResultByIndex(3),
			charStart: r.getResultByIndex(4),
			scheme: r.getResultByIndex(5),
		}));
	},

	/**
	 * Insert the passages of one document in a single transaction.
	 * @returns {Promise<number[]>} rowids, in chunk order
	 */
	async insertDocument(id, fileName, chunks, vectors, scheme) {
		let conn = await this.open();
		let date = this.today();
		let rowids = [];
		await conn.executeTransaction(async () => {
			await conn.execute('DELETE FROM embeddings WHERE id = ?', [id]);
			for (let i = 0; i < chunks.length; i++) {
				let c = chunks[i];
				let vec = Array.from(vectors.subarray(i * 256, (i + 1) * 256), x => Math.fround(x));
				await conn.executeCached(
					`INSERT INTO embeddings (id, date, file_name, section_number, embedding, scheme, chunk_text, page, char_start)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[id, date, fileName, i, JSON.stringify(vec), scheme, c.text, c.page, c.charStart]
				);
				let r = await conn.executeCached('SELECT last_insert_rowid()');
				rowids.push(r[0].getResultByIndex(0));
			}
		});
		return rowids;
	},

	/** Remember where a legacy section was found in the PDF (see SSPassages.locateLegacy) */
	async setLegacyLocation(rowid, text, page, charStart) {
		let conn = await this.open();
		await conn.execute(
			'UPDATE embeddings SET chunk_text = ?, page = ?, char_start = ? WHERE rowid = ? AND scheme IS NULL',
			[text, page, charStart, rowid]
		);
	},

	async deleteDocument(id) {
		let conn = await this.open();
		await conn.execute('DELETE FROM embeddings WHERE id = ?', [id]);
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

	/** Exclude a document; like the original app, its embeddings are removed */
	async addExcluded(id, reason) {
		let conn = await this.open();
		await conn.executeTransaction(async () => {
			await conn.execute('DELETE FROM excluded WHERE id = ?', [id]);
			await conn.execute('INSERT INTO excluded (id, reason, date) VALUES (?, ?, ?)', [id, reason, this.today()]);
			await conn.execute('DELETE FROM embeddings WHERE id = ?', [id]);
		});
	},

	async removeExcluded(id) {
		let conn = await this.open();
		await conn.execute('DELETE FROM excluded WHERE id = ?', [id]);
	},

	// ---- history ----

	async listHistory() {
		let conn = await this.open();
		let rows = await conn.execute('SELECT id, query, date, results FROM history ORDER BY date DESC, rowid DESC');
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
			out.push({ id, query: r.getResultByIndex(1), date: r.getResultByIndex(2), count });
		}
		return out;
	},

	async getHistory(id) {
		let conn = await this.open();
		let rows = await conn.execute(
			'SELECT id, query, date, results, query_embedding FROM history WHERE id = ? ORDER BY rowid DESC LIMIT 1', [id]);
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
		};
	},

	async saveHistory(id, query, queryEmbedding, results) {
		let conn = await this.open();
		let qe = JSON.stringify([Array.from(queryEmbedding, x => Math.fround(x))]);
		await conn.executeTransaction(async () => {
			await conn.execute('DELETE FROM history WHERE id = ?', [id]);
			await conn.execute(
				'INSERT INTO history (id, date, query, query_embedding, results) VALUES (?, ?, ?, ?, ?)',
				[id, this.today(), query, qe, JSON.stringify(results)]
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
