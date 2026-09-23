/* global Zotero, Cc, Ci, SSStore, SSVectorIndex, SSEmbedder, SSModelManager, SSPassages */
/* exported SSSearch */

/**
 * Semantic search over the passage index, with the search history of the
 * original app (history table, id = sha256(query)) used as a result cache.
 */
var SSSearch = {
	// approximate (int8) scores are within ~0.01 of the exact cosine
	APPROX_MARGIN: 0.02,

	get minSimilarity() {
		let v = parseFloat(Zotero.Prefs.get('extensions.semantic-search.minSimilarity', true));
		return Number.isFinite(v) ? v : 0.6;
	},

	get maxResults() {
		let v = parseInt(Zotero.Prefs.get('extensions.semantic-search.maxResults', true));
		return Number.isFinite(v) && v > 0 ? v : 200;
	},

	/** sha256 hex of the UTF-8 query — same id the Python app used */
	hashQuery(query) {
		let ch = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
		ch.init(ch.SHA256);
		let data = new TextEncoder().encode(query);
		ch.update(data, data.length);
		let bin = ch.finish(false);
		let hex = '';
		for (let i = 0; i < bin.length; i++) {
			hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
		}
		return hex;
	},

	async ensureReady() {
		if (!(await SSModelManager.isReady())) {
			let e = new Error('The embedding model has not been downloaded yet.');
			e.code = 'MODEL_MISSING';
			throw e;
		}
		await SSVectorIndex.load();
	},

	/**
	 * @param {string} query
	 * @param {Object} [opts]
	 * @param {number} [opts.minSimilarity]
	 * @param {number} [opts.limit]
	 * @param {boolean} [opts.useCache=true] - return saved results for an identical query
	 * @param {boolean} [opts.save=true] - store in the history
	 * @param {string[]} [opts.keys] - restrict to these attachment keys
	 * @returns {Promise<{id, query, date, results, fromCache}>}
	 */
	async search(query, opts = {}) {
		query = String(query || '');
		if (!query.trim()) throw new Error('Empty query');
		let id = this.hashQuery(query);
		let useCache = opts.useCache !== false && !opts.keys;
		if (useCache) {
			let saved = await SSStore.getHistory(id);
			if (saved) {
				return { ...saved, fromCache: true };
			}
		}
		await this.ensureReady();
		let minSim = opts.minSimilarity !== undefined ? opts.minSimilarity : this.minSimilarity;
		let limit = opts.limit || this.maxResults;
		let { vectors: qvecs, segments } = await SSEmbedder.embedQuery(query);
		let results = await this.rank(qvecs, minSim, limit, opts.keys ? new Set(opts.keys) : null);
		// Long queries: remember which part of the query each passage matches
		// (segment 0 is the whole query as the original app embedded it)
		if (segments.length > 1) {
			for (let r of results) {
				if (r.segment > 0) r.matched = this.excerpt(segments[r.segment], 90);
				delete r.segment;
			}
		}
		// Keep the statuses the user already set on a previous run of this query
		let previous = opts.useCache === false ? await SSStore.getHistory(id) : null;
		if (previous) {
			let status = new Map(previous.results.map(r => [r.folder_id + '/' + r.section_number, r.status]));
			for (let r of results) {
				let s = status.get(r.folder_id + '/' + r.section_number);
				if (s !== undefined) r.status = s;
			}
		}
		if (opts.save !== false && !opts.keys) {
			await SSStore.saveHistory(id, query, this.meanVector(qvecs), results);
		}
		return { id, query, date: SSStore.today(), results, fromCache: false };
	},

	excerpt(text, n) {
		text = text.replace(/\s+/g, ' ').trim();
		return text.length > n ? text.slice(0, n).replace(/\s+\S*$/, '') + '…' : text;
	},

	meanVector(vecs) {
		let m = new Float32Array(256);
		for (let v of vecs) {
			for (let k = 0; k < 256; k++) m[k] += v[k];
		}
		let n = Math.sqrt(m.reduce((a, x) => a + x * x, 0)) || 1;
		return m.map(x => x / n);
	},

	/**
	 * Exact ranking: approximate scan, then exact cosine on the candidates.
	 * With several query vectors (a long query split into segments) a passage
	 * scores its best match among them.
	 * @param {Float32Array|Float32Array[]} qvecs
	 * @returns {Object[]} history-format results, best first
	 */
	async rank(qvecs, minSim, limit, onlyKeys) {
		if (!Array.isArray(qvecs)) qvecs = [qvecs];
		let best = new Map(); // index -> approx score
		for (let q of qvecs) {
			for (let c of SSVectorIndex.candidates(q, minSim - this.APPROX_MARGIN, 50000, onlyKeys)) {
				let prev = best.get(c.i);
				if (prev === undefined || c.score > prev) best.set(c.i, c.score);
			}
		}
		let cands = [...best.entries()].map(([i, score]) => ({ i, score })).sort((a, b) => b.score - a.score);
		if (!cands.length) return [];
		// Only the candidates that can still make the top `limit` need exact scores
		if (cands.length > limit) {
			let floor = cands[limit - 1].score - this.APPROX_MARGIN;
			let k = limit;
			while (k < cands.length && cands[k].score >= floor) k++;
			cands = cands.slice(0, k);
		}
		let entries = cands.map(c => SSVectorIndex.entry(c.i));
		let vectors = await SSStore.getVectors(entries.map(e => e.rowid));
		let qnorms = qvecs.map(q => Math.sqrt(q.reduce((a, x) => a + x * x, 0)) || 1);
		let results = [];
		for (let e of entries) {
			let v = vectors.get(e.rowid);
			if (!v || !e.key) continue;
			let vn = 0;
			for (let k = 0; k < 256; k++) vn += v[k] * v[k];
			vn = Math.sqrt(vn) || 1;
			let sim = -2;
			let segment = 0;
			for (let j = 0; j < qvecs.length; j++) {
				let q = qvecs[j];
				let d = 0;
				for (let k = 0; k < 256; k++) d += q[k] * v[k];
				d /= qnorms[j] * vn;
				if (d > sim) {
					sim = d;
					segment = j;
				}
			}
			if (sim < minSim) continue;
			let r = {
				similarity: sim,
				folder_id: e.key,
				file_name: e.fileName,
				section_number: e.section,
				rowid: e.rowid,
			};
			if (qvecs.length > 1) r.segment = segment;
			results.push(r);
		}
		results.sort((a, b) => b.similarity - a.similarity);
		// The legacy database contains a few duplicated sections: keep the best one.
		// Identical PDFs attached to duplicate items give identical scores for the same
		// section: show them once, listing the other copies.
		let seen = new Set();
		let identical = new Map();
		results = results.filter((r) => {
			let k = r.folder_id + '/' + r.section_number;
			if (seen.has(k)) return false;
			seen.add(k);
			let fp = r.section_number + '|' + r.similarity.toFixed(7);
			let first = identical.get(fp);
			if (first) {
				(first.duplicates || (first.duplicates = [])).push(r.folder_id);
				return false;
			}
			identical.set(fp, r);
			return true;
		});
		if (results.length > limit) results.length = limit;
		return results;
	},

	/** Documents most similar to a document (centroid of its passages) */
	async similarDocuments(key, limit = 20) {
		await this.ensureReady();
		let c = SSVectorIndex.centroid(key);
		if (!c) return [];
		let scores = SSVectorIndex.scan(c);
		let best = new Map();
		for (let i = 0; i < scores.length; i++) {
			let d = SSVectorIndex.docIdx[i];
			if (d < 0) continue;
			let s = scores[i];
			let cur = best.get(d);
			if (cur === undefined || s > cur.max) {
				best.set(d, { max: s, i, sum: (cur ? cur.sum : 0) + s, n: (cur ? cur.n : 0) + 1 });
			}
			else {
				cur.sum += s;
				cur.n++;
			}
		}
		let self = SSVectorIndex.docByKey.get(key);
		let docs = [...best.entries()]
			.filter(([d]) => d !== self)
			.map(([d, v]) => ({ key: SSVectorIndex.docs[d].key, score: v.max, mean: v.sum / v.n, bestIndex: v.i }))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
		for (let doc of docs) {
			let e = SSVectorIndex.entry(doc.bestIndex);
			doc.section_number = e.section;
			doc.rowid = e.rowid;
			let item = await SSPassages.getItemByKey(doc.key);
			if (item) Object.assign(doc, SSPassages.describeItem(item));
		}
		return docs.filter(d => d.itemID);
	},

	/** Group passage results by document */
	groupByDocument(results) {
		let groups = new Map();
		for (let r of results) {
			let g = groups.get(r.folder_id);
			if (!g) {
				g = { key: r.folder_id, best: r.similarity, results: [] };
				groups.set(r.folder_id, g);
			}
			g.results.push(r);
			g.best = Math.max(g.best, r.similarity);
		}
		return [...groups.values()].sort((a, b) => b.best - a.best);
	},
};
