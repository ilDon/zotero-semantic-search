/* global ChromeUtils, IOUtils, SSF16, SSStore */
/* exported SSLegacyEmbeddingStore, SSBlobEmbeddingStore */

/**
 * Passage databases, one per embedding model (see models.js).
 *
 * Both stores expose the same interface, used by the indexer, the vector
 * index, search and the passage resolver:
 *   getIndexedIDs, getAllRowids, forEachEmbedding, getVectors, getChunkInfo,
 *   findRowids, countSections, getDocumentInfo, getDocumentChunks,
 *   insertDocument, deleteDocument, setLegacyLocation, getLegacyDocumentIDs,
 *   hasIdIndex, ensureIdIndex, countDocuments, fileSize.
 */

var SSBaseEmbeddingStore = class {
	constructor(space) {
		this.space = space;
		this._conn = null;
		this._path = null;
		this._opening = null;
	}

	get path() {
		return this.space.dbPath;
	}

	async open() {
		if (this._conn && this._path === this.path) return this._conn;
		if (this._opening) return this._opening;
		this._opening = (async () => {
			if (this._conn) await this.close();
			// Earlier versions' database must be renamed before anything opens it
			await SSStore.open();
			const { Sqlite } = ChromeUtils.importESModule('resource://gre/modules/Sqlite.sys.mjs');
			let path = this.path;
			let conn = await Sqlite.openConnection({ path });
			try {
				await this._migrate(conn);
			}
			catch (e) {
				await conn.close();
				throw e;
			}
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
	}

	async close() {
		if (this._conn) {
			let c = this._conn;
			this._conn = null;
			await c.close();
		}
	}

	async fileSize() {
		try {
			return (await IOUtils.stat(this.path)).size;
		}
		catch (e) {
			return 0;
		}
	}

	today() {
		let d = new Date();
		let pad = n => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
};

/**
 * LEALLA-large: the database of the original Python app, format unchanged.
 *
 *   embeddings(id TEXT, date TEXT, file_name TEXT, section_number INTEGER, embedding TEXT)
 *     id = attachment key (= storage folder name), embedding = JSON array of 256 floats
 *
 * Additive columns: scheme (NULL = legacy 2500-char sections, 2 = 128-token
 * passages), chunk_text, page (0-based), char_start; index on embeddings(id).
 */
var SSLegacyEmbeddingStore = class extends SSBaseEmbeddingStore {
	get TABLE() {
		return 'embeddings';
	}

	async _migrate(conn) {
		await conn.execute(`CREATE TABLE IF NOT EXISTS embeddings (
			id TEXT, date TEXT, file_name TEXT, section_number INTEGER, embedding TEXT)`);
		let cols = (await conn.execute('PRAGMA table_info(embeddings)')).map(r => r.getResultByName('name'));
		for (let [name, type] of [['scheme', 'INTEGER'], ['chunk_text', 'TEXT'], ['page', 'INTEGER'], ['char_start', 'INTEGER']]) {
			if (!cols.includes(name)) {
				await conn.execute(`ALTER TABLE embeddings ADD COLUMN ${name} ${type}`);
			}
		}
	}

	/**
	 * The index on embeddings(id) makes per-document operations and rowid scans
	 * fast. Building it reads the whole (possibly multi-GB) table once.
	 */
	async hasIdIndex() {
		let conn = await this.open();
		let rows = await conn.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='ss_embeddings_id'");
		return rows.length > 0;
	}

	async ensureIdIndex() {
		let conn = await this.open();
		if (await this.hasIdIndex()) return false;
		await conn.execute('CREATE INDEX IF NOT EXISTS ss_embeddings_id ON embeddings(id)');
		return true;
	}

	_parse(text) {
		let vec;
		try {
			vec = JSON.parse(text);
		}
		catch (e) {
			return null;
		}
		if (Array.isArray(vec[0])) vec = vec[0];
		return vec;
	}

	_encode(vec) {
		return JSON.stringify(Array.from(vec, x => Math.fround(x)));
	}

	/** Documents indexed by the original app (2500-char sections) */
	async getLegacyDocumentIDs() {
		let conn = await this.open();
		let ids = [];
		await conn.execute('SELECT DISTINCT id FROM embeddings WHERE scheme IS NULL', null, (row) => {
			ids.push(row.getResultByIndex(0));
		});
		return ids;
	}

	/** Remember where a legacy section was found in the PDF (see SSPassages.locateLegacy) */
	async setLegacyLocation(rowid, text, page, charStart) {
		let conn = await this.open();
		await conn.execute(
			'UPDATE embeddings SET chunk_text = ?, page = ?, char_start = ? WHERE rowid = ? AND scheme IS NULL',
			[text, page, charStart, rowid]
		);
	}

	// ---- shared implementation (table name and vector encoding differ) ----

	async getIndexedIDs() {
		let conn = await this.open();
		let ids = new Set();
		await conn.execute(`SELECT DISTINCT id FROM ${this.TABLE}`, null, (row) => {
			ids.add(row.getResultByIndex(0));
		});
		return ids;
	}

	async countDocuments() {
		let conn = await this.open();
		let rows = await conn.execute(`SELECT count(DISTINCT id) FROM ${this.TABLE}`);
		return rows[0].getResultByIndex(0);
	}

	async getAllRowids() {
		let conn = await this.open();
		let out = [];
		// Uses the covering index on id when present (much cheaper than a table scan)
		await conn.execute(`SELECT rowid FROM ${this.TABLE}`, null, (row) => {
			out.push(row.getResultByIndex(0));
		});
		return out;
	}

	/**
	 * Stream embeddings. onRow(rowid, id, fileName, section, vector, scheme)
	 * @param {number[]} [rowids] - restrict to these rowids
	 */
	async forEachEmbedding(onRow, rowids) {
		let conn = await this.open();
		let sql = `SELECT rowid, id, file_name, section_number, embedding, scheme FROM ${this.TABLE}`;
		let handler = (row) => {
			let vec = this._parse(row.getResultByIndex(4));
			if (!vec) return;
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
	}

	/** @returns {Map<number, Float64Array|Float32Array>} exact vectors for rowids */
	async getVectors(rowids) {
		let out = new Map();
		await this.forEachEmbedding((rowid, id, fn, sec, vec) => {
			out.set(rowid, vec instanceof Float32Array ? vec : Float64Array.from(vec));
		}, rowids);
		return out;
	}

	/** @returns {Map<number, {id, fileName, section, scheme, text, page, charStart}>} */
	async getChunkInfo(rowids) {
		let conn = await this.open();
		let out = new Map();
		for (let i = 0; i < rowids.length; i += 500) {
			let part = rowids.slice(i, i + 500);
			await conn.execute(
				`SELECT rowid, id, file_name, section_number, scheme, chunk_text, page, char_start
				FROM ${this.TABLE} WHERE rowid IN (${part.map(() => '?').join(',')})`,
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
	}

	/** @param {Array<[string, number]>} pairs - [id, section_number] */
	async findRowids(pairs) {
		let conn = await this.open();
		let out = new Map();
		let ids = [...new Set(pairs.map(p => p[0]))];
		for (let i = 0; i < ids.length; i += 500) {
			let part = ids.slice(i, i + 500);
			await conn.execute(
				`SELECT rowid, id, section_number, scheme FROM ${this.TABLE} WHERE id IN (${part.map(() => '?').join(',')})`,
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
	}

	async countSections(id) {
		let conn = await this.open();
		let rows = await conn.execute(`SELECT count(*) FROM ${this.TABLE} WHERE id = ?`, [id]);
		return rows[0].getResultByIndex(0);
	}

	async getDocumentInfo(id) {
		let conn = await this.open();
		let rows = await conn.execute(
			`SELECT count(*) AS n, min(date) AS date, max(scheme) AS scheme, max(file_name) AS file_name
			FROM ${this.TABLE} WHERE id = ?`, [id]);
		let r = rows[0];
		let n = r.getResultByName('n');
		if (!n) return null;
		return {
			sections: n,
			date: r.getResultByName('date'),
			scheme: r.getResultByName('scheme') || 1,
			fileName: r.getResultByName('file_name'),
		};
	}

	async getDocumentChunks(id) {
		let conn = await this.open();
		let rows = await conn.execute(
			`SELECT rowid, section_number, chunk_text, page, char_start, scheme
			FROM ${this.TABLE} WHERE id = ? ORDER BY section_number`, [id]);
		return rows.map(r => ({
			rowid: r.getResultByIndex(0),
			section: r.getResultByIndex(1),
			text: r.getResultByIndex(2),
			page: r.getResultByIndex(3),
			charStart: r.getResultByIndex(4),
			scheme: r.getResultByIndex(5),
		}));
	}

	/**
	 * Insert the passages of one document in a single transaction.
	 * @param {Float32Array} vectors - chunks.length vectors of the model's dimension
	 * @returns {Promise<number[]>} rowids, in chunk order
	 */
	async insertDocument(id, fileName, chunks, vectors, scheme) {
		let conn = await this.open();
		let date = this.today();
		let dim = this.space.spec.dim;
		let rowids = [];
		await conn.executeTransaction(async () => {
			await conn.execute(`DELETE FROM ${this.TABLE} WHERE id = ?`, [id]);
			for (let i = 0; i < chunks.length; i++) {
				let c = chunks[i];
				await conn.executeCached(
					`INSERT INTO ${this.TABLE} (id, date, file_name, section_number, embedding, scheme, chunk_text, page, char_start)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[id, date, fileName, i, this._encode(vectors.subarray(i * dim, (i + 1) * dim)), scheme, c.text, c.page, c.charStart]
				);
				let r = await conn.executeCached('SELECT last_insert_rowid()');
				rowids.push(r[0].getResultByIndex(0));
			}
		});
		return rowids;
	}

	async deleteDocument(id) {
		let conn = await this.open();
		await conn.execute(`DELETE FROM ${this.TABLE} WHERE id = ?`, [id]);
	}
};

/**
 * Newer models: same row layout, vectors as fp16 BLOBs.
 *
 *   embeddings(id, date, file_name, section_number, embedding BLOB, scheme,
 *              chunk_text, page, char_start)
 *   ss_model(key, value): model id and vector dimension of this file
 */
var SSBlobEmbeddingStore = class extends SSLegacyEmbeddingStore {
	async _migrate(conn) {
		await conn.execute(`CREATE TABLE IF NOT EXISTS embeddings (
			id TEXT NOT NULL, date TEXT, file_name TEXT, section_number INTEGER, embedding BLOB,
			scheme INTEGER, chunk_text TEXT, page INTEGER, char_start INTEGER)`);
		await conn.execute('CREATE INDEX IF NOT EXISTS ss_embeddings_id ON embeddings(id)');
		await conn.execute('CREATE TABLE IF NOT EXISTS ss_model (key TEXT PRIMARY KEY, value TEXT)');
		let rows = await conn.execute("SELECT value FROM ss_model WHERE key = 'model'");
		let spec = this.space.spec;
		if (rows.length) {
			let model = rows[0].getResultByIndex(0);
			if (model !== spec.id) throw new Error(`${this.path} belongs to the model ${model}, not ${spec.id}`);
		}
		else {
			await conn.execute("INSERT INTO ss_model (key, value) VALUES ('model', ?), ('dim', ?), ('vector', 'f16')",
				[spec.id, String(spec.dim)]);
		}
	}

	async hasIdIndex() {
		return true;
	}

	async ensureIdIndex() {
		return false;
	}

	_parse(blob) {
		if (!blob || !blob.length) return null;
		return SSF16.decode(blob);
	}

	_encode(vec) {
		return SSF16.encode(vec);
	}

	async getLegacyDocumentIDs() {
		return [];
	}

	async setLegacyLocation() {}
};
