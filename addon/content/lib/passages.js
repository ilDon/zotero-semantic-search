/* global Zotero, IOUtils, PathUtils, SSStore, SSEmbedder */
/* exported SSPassages */

/**
 * Resolves search results to Zotero items and passage text.
 *
 * New ("scheme 2") passages store their text and page in the database.
 * Legacy sections (2500 characters of PyPDF2 text, of which the model read
 * only the first ~128 tokens) store nothing but their index, so their text is
 * recovered from Zotero's own PDF text extraction: first by proportional
 * position, then — on demand — precisely, by re-embedding candidate windows
 * and matching them against the stored vector.
 */
var SSPassages = {
	LEGACY_SECTION_CHARS: 2500,
	_itemIDByKey: new Map(),
	_fulltext: new Map(), // key -> Promise<{pages, full, pageStarts}>
	FULLTEXT_CACHE: 12,

	isTrashed(item) {
		return !!(item.deleted || (item.parentItem && item.parentItem.deleted));
	},

	/** Find an item by key in any library (items in the trash count as missing) */
	async getItemByKey(key) {
		let cached = this._itemIDByKey.get(key);
		if (cached) {
			let item = Zotero.Items.get(cached);
			if (item) return this.isTrashed(item) ? null : item;
		}
		for (let lib of Zotero.Libraries.getAll()) {
			let item = await Zotero.Items.getByLibraryAndKeyAsync(lib.libraryID, key);
			if (item) {
				this._itemIDByKey.set(key, item.id);
				return this.isTrashed(item) ? null : item;
			}
		}
		return null;
	},

	describeItem(attachment) {
		let parent = attachment.parentItem || attachment;
		let year = '';
		let date = parent.getField('date', true, true);
		if (date) year = date.substr(0, 4).replace(/^0000$/, '');
		let creators = parent.getCreators ? parent.getCreators() : [];
		let authors = creators
			.filter(c => ['author', 'editor'].includes(Zotero.CreatorTypes.getName(c.creatorTypeID)))
			.map(c => (c.lastName || c.firstName || '').trim())
			.filter(Boolean);
		return {
			itemID: parent.id,
			itemKey: parent.key,
			libraryID: parent.libraryID,
			attachmentID: attachment.id,
			attachmentKey: attachment.key,
			title: parent.getDisplayTitle() || attachment.getField('title'),
			creators: parent.getField('firstCreator') || '',
			authors,
			year,
			itemType: Zotero.ItemTypes.getName(parent.itemTypeID),
			publication: parent.getField('publicationTitle', false, true) || parent.getField('bookTitle', false, true) || '',
			// when the item was added to Zotero, UTC "YYYY-MM-DD HH:MM:SS"
			dateAdded: parent.dateAdded || attachment.dateAdded || '',
		};
	},

	/**
	 * Parse a "YYYY-MM-DD" date as local midnight and return it in the format of
	 * Zotero's dateAdded (UTC "YYYY-MM-DD HH:MM:SS"), or null if invalid.
	 */
	sinceToUTC(date) {
		let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
		if (!m) return null;
		let d = new Date(+m[1], +m[2] - 1, +m[3]);
		if (isNaN(d) || d.getMonth() !== +m[2] - 1) return null;
		return d.toISOString().replace('T', ' ').slice(0, 19);
	},

	/**
	 * Keys of the PDF attachments whose item (the parent, or the attachment itself
	 * when standalone) was added to Zotero at or after `sinceUTC`.
	 */
	async attachmentKeysAddedSince(sinceUTC) {
		return Zotero.DB.columnQueryAsync(
			`SELECT A.key FROM itemAttachments IA
			JOIN items A ON A.itemID = IA.itemID
			LEFT JOIN items P ON P.itemID = IA.parentItemID
			WHERE IA.contentType = 'application/pdf'
			AND COALESCE(P.dateAdded, A.dateAdded) >= ?`,
			[sinceUTC]
		);
	},

	get textCacheDir() {
		return PathUtils.join(Zotero.Profile.dir, 'semantic-search', 'text');
	},

	TEXT_CACHE_MAX_BYTES: 1024 * 1024 * 1024,

	_build(pages, approxPages) {
		let pageStarts = [];
		let full = '';
		for (let i = 0; i < pages.length; i++) {
			pageStarts.push(full.length);
			full += pages[i] + (i < pages.length - 1 ? '\n' : '');
		}
		return { pages, full, pageStarts, approxPages: !!approxPages };
	},

	/**
	 * Full text with page boundaries. Sources, fastest first:
	 *  1. our text cache (profile dir, pages separated by \f)
	 *  2. Zotero's .zotero-ft-cache, when the whole document was indexed
	 *     (no page breaks there: pages are then estimated proportionally)
	 *  3. Zotero's PDF worker (slow for big books), then stored in 1.
	 * @param {Object} [opts] - {fast: true} skips the PDF worker (returns null)
	 */
	getFullText(item, opts = {}) {
		let key = item.key;
		let p = this._fulltext.get(key);
		if (p) {
			this._fulltext.delete(key);
			this._fulltext.set(key, p);
			return p;
		}
		p = this._loadFullText(item, opts);
		let slowOK = !opts.fast;
		p.then((r) => {
			if (!r && !slowOK) this._fulltext.delete(key);
		}, () => this._fulltext.delete(key));
		this._fulltext.set(key, p);
		while (this._fulltext.size > this.FULLTEXT_CACHE) {
			this._fulltext.delete(this._fulltext.keys().next().value);
		}
		return p;
	},

	async _loadFullText(item, opts) {
		let cachePath = PathUtils.join(this.textCacheDir, item.key + '.txt');
		try {
			if (await IOUtils.exists(cachePath)) {
				let text = await IOUtils.readUTF8(cachePath);
				// touch for LRU eviction
				IOUtils.setModificationTime(cachePath).catch(() => {});
				return this._build(text.split('\f'));
			}
		}
		catch (e) {
			Zotero.debug('Semantic Search: text cache read failed: ' + e);
		}
		try {
			if (opts.noZoteroCache) throw new Error('skip');
			let pagesInfo = await Zotero.FullText.getPages(item.id);
			let ftFile = Zotero.FullText.getItemCacheFile(item);
			if (pagesInfo && pagesInfo.total && pagesInfo.indexedPages >= pagesInfo.total
					&& ftFile && await IOUtils.exists(ftFile.path)) {
				let text = await IOUtils.readUTF8(ftFile.path);
				let maxChars = Zotero.Prefs.get('fulltext.textMaxLength') || 500000;
				if (text.length < maxChars - 10) {
					// Spread the text evenly over the pages
					let n = pagesInfo.total;
					let pages = [];
					let per = Math.ceil(text.length / n);
					for (let i = 0; i < n; i++) pages.push(text.slice(i * per, (i + 1) * per));
					return this._build(pages, true);
				}
			}
		}
		catch (e) {
			Zotero.debug('Semantic Search: fulltext cache not usable: ' + e);
		}
		if (opts.fast) return null;
		// isPriority: user-facing requests jump ahead of background indexing
		let res = await Zotero.PDFWorker.getFullText(item.id, null, true);
		let raw = res && res.text ? res.text : '';
		try {
			await IOUtils.makeDirectory(this.textCacheDir, { createAncestors: true, ignoreExisting: true });
			await IOUtils.writeUTF8(cachePath, raw);
			this._pruneTextCache();
		}
		catch (e) {
			Zotero.debug('Semantic Search: text cache write failed: ' + e);
		}
		return this._build(raw.split('\f'));
	},

	_pruning: false,
	async _pruneTextCache() {
		if (this._pruning) return;
		this._pruning = true;
		try {
			let files = [];
			let total = 0;
			for (let path of await IOUtils.getChildren(this.textCacheDir)) {
				let info = await IOUtils.stat(path);
				files.push({ path, size: info.size, time: info.lastModified });
				total += info.size;
			}
			files.sort((a, b) => a.time - b.time);
			while (total > this.TEXT_CACHE_MAX_BYTES && files.length) {
				let f = files.shift();
				await IOUtils.remove(f.path, { ignoreAbsent: true });
				total -= f.size;
			}
		}
		catch (e) {
			Zotero.debug('Semantic Search: text cache pruning failed: ' + e);
		}
		finally {
			this._pruning = false;
		}
	},

	pageAt(pageStarts, offset) {
		let lo = 0;
		let hi = pageStarts.length - 1;
		while (lo < hi) {
			let mid = (lo + hi + 1) >> 1;
			if (pageStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	},

	clean(text) {
		return text.replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, '$1$2').replace(/\s+/g, ' ').trim();
	},

	/**
	 * Approximate text of a legacy section: the section index is mapped
	 * proportionally onto Zotero's extraction of the same PDF.
	 */
	async legacyPassage(item, section, sectionCount, chars = 1200, opts = {}) {
		let ft = await this.getFullText(item, opts);
		if (!ft) return null;
		let len = ft.full.length;
		if (!len) return { text: '', page: null, approximate: true };
		let n = Math.max(sectionCount, section + 1);
		let start = Math.floor((section / n) * len);
		// snap to a word boundary
		let ws = ft.full.lastIndexOf(' ', start);
		if (ws > start - 40 && ws >= 0) start = ws + 1;
		let end = Math.min(len, start + chars);
		let we = ft.full.indexOf(' ', end);
		if (we !== -1 && we < end + 40) end = we;
		return {
			text: this.clean(ft.full.slice(start, end)),
			page: this.pageAt(ft.pageStarts, start),
			charStart: start,
			approximate: true,
		};
	},

	/**
	 * Precisely locate a legacy section: embed windows around the proportional
	 * estimate and pick the one closest to the stored vector.
	 */
	async locateLegacy(item, section, sectionCount, storedVector) {
		let ft = await this.getFullText(item);
		if (ft.approxPages) {
			// Page boundaries unknown in Zotero's cache: extract the PDF for exact pages
			this._fulltext.delete(item.key);
			ft = await this.getFullText(item, { noZoteroCache: true });
		}
		let len = ft.full.length;
		if (!len) return null;
		let n = Math.max(sectionCount, section + 1);
		let span = len / n;
		let center = (section / n) * len;
		let starts = [];
		let step = Math.max(80, Math.round(span / 16));
		for (let s = Math.max(0, center - 1.5 * span); s <= Math.min(len - 1, center + 1.5 * span); s += step) {
			// windows start at a word boundary, like PyPDF2 sections start at arbitrary chars
			let ws = ft.full.lastIndexOf(' ', Math.round(s));
			starts.push(ws < 0 ? 0 : ws + 1);
		}
		let unique = [...new Set(starts)];
		// The model only reads the first 128 tokens; ~900 chars are plenty
		let texts = unique.map(s => ft.full.slice(s, s + 900).replace(/\s+/g, ' '));
		let vecs = await SSEmbedder.embed(texts);
		let best = -2;
		let bestStart = unique[0];
		for (let i = 0; i < vecs.length; i++) {
			let d = 0;
			for (let k = 0; k < 256; k++) d += vecs[i][k] * storedVector[k];
			if (d > best) {
				best = d;
				bestStart = unique[i];
			}
		}
		// refine around the best coarse window
		let fine = [];
		for (let s = bestStart - step; s <= bestStart + step; s += Math.max(15, step / 8)) {
			if (s < 0 || s >= len) continue;
			let ws = ft.full.lastIndexOf(' ', Math.round(s));
			fine.push(ws < 0 ? 0 : ws + 1);
		}
		fine = [...new Set(fine)].filter(s => s !== bestStart);
		if (fine.length) {
			let fv = await SSEmbedder.embed(fine.map(s => ft.full.slice(s, s + 900).replace(/\s+/g, ' ')));
			for (let i = 0; i < fv.length; i++) {
				let d = 0;
				for (let k = 0; k < 256; k++) d += fv[i][k] * storedVector[k];
				if (d > best) {
					best = d;
					bestStart = fine[i];
				}
			}
		}
		let end = Math.min(len, bestStart + 1200);
		let we = ft.full.indexOf(' ', end);
		if (we !== -1 && we < end + 40) end = we;
		return {
			text: this.clean(ft.full.slice(bestStart, end)),
			page: this.pageAt(ft.pageStarts, bestStart),
			charStart: bestStart,
			approximate: false,
			match: best,
		};
	},

	/**
	 * Attach item metadata and passage text to results (in place).
	 * @param {Object[]} results - history-format results
	 * @param {Object} [opts] - {text: boolean} also load passage text
	 */
	async enrich(results, opts = {}) {
		// rowids for legacy history entries saved by the old app
		let needLookup = results.filter(r => r.rowid === undefined);
		if (needLookup.length) {
			let found = await SSStore.findRowids(needLookup.map(r => [r.folder_id, r.section_number]));
			for (let r of needLookup) {
				let hit = found.get(r.folder_id + '\u0000' + r.section_number);
				if (hit) {
					r.rowid = hit.rowid;
					r.scheme = hit.scheme || 1;
				}
			}
		}
		let rowids = results.map(r => r.rowid).filter(x => x !== undefined);
		let info = rowids.length ? await SSStore.getChunkInfo(rowids) : new Map();
		let counts = new Map();
		for (let r of results) {
			let item = await this.getItemByKey(r.folder_id);
			r.missing = !item;
			if (item) Object.assign(r, this.describeItem(item));
			else r.title = r.file_name;
			let ci = r.rowid !== undefined ? info.get(r.rowid) : null;
			if (ci && (ci.scheme === 2 || ci.text)) {
				// new passages, or legacy sections already located precisely
				r.scheme = ci.scheme || 1;
				r.text = ci.text;
				r.page = ci.page;
				r.approximate = false;
			}
			else if (opts.text && item) {
				if (!counts.has(r.folder_id)) {
					counts.set(r.folder_id, await SSStore.countSections(r.folder_id));
				}
				try {
					let p = await this.legacyPassage(item, r.section_number, counts.get(r.folder_id),
						opts.chars || 1200, { fast: !!opts.fast });
					if (p) {
						r.text = p.text;
						r.page = p.page;
						r.textPending = false;
					}
					else {
						r.text = null;
						r.textPending = true;
					}
					r.approximate = true;
				}
				catch (e) {
					Zotero.debug('Semantic Search: cannot read text of ' + r.folder_id + ': ' + e);
					r.text = '';
				}
				r.scheme = 1;
				r.sectionCount = counts.get(r.folder_id);
			}
		}
		return results;
	},
};
