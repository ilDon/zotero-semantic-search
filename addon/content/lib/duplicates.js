/* global Zotero, ChromeUtils, IOUtils, Services, SSStore, SSEvents, SSUI */
/* exported SSDuplicates */

/**
 * Identical PDF files in the library, found by a hash of their content.
 *
 * Hashes are kept in semantic_search.db (file_hashes, refreshed when a file's
 * size or modification time changes) and computed in the background for the
 * whole library, then for every new PDF. When a PDF just added to Zotero is
 * identical to one already there, the user is asked whether to keep it.
 *
 * Groups can be merged (one item keeps all metadata, notes, tags, collections
 * and annotations; see merge()) or cleaned up by moving chosen copies to the
 * trash. Groups the user wants to keep are remembered (duplicate_ignored).
 */
var SSDuplicates = {
	NEW_ITEM_MAX_AGE_MS: 10 * 60 * 1000, // older "new" items come from sync, not from the user
	ALERT_BATCH_MS: 4000,

	state: 'idle', // idle | scanning
	progress: null, // {done, total}
	_groups: null, // cached result of groups()
	_notifierID: null,
	_pending: new Map(), // itemID -> timer
	_alertQueue: [],
	_alertTimer: null,
	_scanning: null,

	onChange(fn) {
		return SSEvents.on('duplicates', fn);
	},

	_emit() {
		SSEvents.emit('duplicates');
	},

	async _conn() {
		let conn = await SSStore.open();
		if (!this._tables) {
			await conn.execute(`CREATE TABLE IF NOT EXISTS file_hashes (
				key TEXT PRIMARY KEY, libraryID INTEGER, size INTEGER, mtime INTEGER, hash TEXT)`);
			await conn.execute('CREATE INDEX IF NOT EXISTS ss_file_hashes_hash ON file_hashes(hash)');
			await conn.execute('CREATE TABLE IF NOT EXISTS duplicate_ignored (hash TEXT PRIMARY KEY, date TEXT)');
			this._tables = true;
		}
		return conn;
	},

	/** Content hash of a file ("sha256:…", or "md5:…" where IOUtils cannot hash) */
	async _hashFile(path) {
		if (typeof IOUtils.computeHexDigest === 'function') {
			return 'sha256:' + await IOUtils.computeHexDigest(path, 'sha256');
		}
		return 'md5:' + await Zotero.Utilities.Internal.md5Async(path);
	},

	/**
	 * Hash of an attachment's file, computed only if the file changed since last time.
	 * @returns {Promise<string|null>} null if the file is not available
	 */
	async hashAttachment(item) {
		let path = await item.getFilePathAsync();
		if (!path) return null;
		let info;
		try {
			info = await IOUtils.stat(path);
		}
		catch (e) {
			return null;
		}
		let conn = await this._conn();
		let rows = await conn.execute('SELECT size, mtime, hash FROM file_hashes WHERE key = ?', [item.key]);
		if (rows.length && rows[0].getResultByIndex(0) === info.size && rows[0].getResultByIndex(1) === info.lastModified) {
			return rows[0].getResultByIndex(2);
		}
		let hash = await this._hashFile(path);
		await conn.execute('INSERT OR REPLACE INTO file_hashes (key, libraryID, size, mtime, hash) VALUES (?, ?, ?, ?, ?)',
			[item.key, item.libraryID, info.size, info.lastModified, hash]);
		return hash;
	},

	// ------------------------------------------------------------ library scan

	/** Hash every PDF of the library (in the background, once per file) */
	scan() {
		if (this._scanning) return this._scanning;
		this._scanning = (async () => {
			this.state = 'scanning';
			let ids = await Zotero.DB.columnQueryAsync(
				`SELECT IA.itemID FROM itemAttachments IA
				WHERE IA.contentType = 'application/pdf' AND IA.linkMode != ?
				AND IA.itemID NOT IN (SELECT itemID FROM deletedItems)`,
				[Zotero.Attachments.LINK_MODE_LINKED_URL]
			);
			this.progress = { done: 0, total: ids.length };
			this._emit();
			let lastEmit = 0;
			for (let id of ids) {
				if (this._stopped) break;
				try {
					let item = await Zotero.Items.getAsync(id);
					if (item) await this.hashAttachment(item);
				}
				catch (e) {
					Zotero.debug('Semantic Search: cannot hash item ' + id + ': ' + e);
				}
				this.progress.done++;
				if (Date.now() - lastEmit > 1000) {
					lastEmit = Date.now();
					this._emit();
				}
			}
			await this._prune();
		})().catch(e => Zotero.logError(e)).finally(() => {
			this._scanning = null;
			this.state = 'idle';
			this.progress = null;
			this._groups = null;
			this._emit();
		});
		return this._scanning;
	},

	/** Forget hashes of items that no longer exist */
	async _prune() {
		let conn = await this._conn();
		let keys = [];
		await conn.execute('SELECT key, libraryID FROM file_hashes', null, (row) => {
			keys.push([row.getResultByIndex(0), row.getResultByIndex(1)]);
		});
		let gone = [];
		for (let [key, libraryID] of keys) {
			if (!Zotero.Items.getIDFromLibraryAndKey(libraryID, key)) gone.push(key);
		}
		for (let i = 0; i < gone.length; i += 500) {
			let part = gone.slice(i, i + 500);
			await conn.execute(`DELETE FROM file_hashes WHERE key IN (${part.map(() => '?').join(',')})`, part);
		}
	},

	// ------------------------------------------------------------ groups

	/** Live (not trashed) PDF attachments with this hash */
	async _itemsWithHash(hash) {
		let conn = await this._conn();
		let rows = await conn.execute('SELECT key, libraryID FROM file_hashes WHERE hash = ?', [hash]);
		let items = [];
		for (let r of rows) {
			let id = Zotero.Items.getIDFromLibraryAndKey(r.getResultByIndex(1), r.getResultByIndex(0));
			let item = id && await Zotero.Items.getAsync(id);
			if (!item || item.deleted || (item.parentItem && item.parentItem.deleted)) continue;
			if (!item.isPDFAttachment()) continue;
			items.push(item);
		}
		return items;
	},

	/**
	 * Groups of identical PDFs (at least two live copies, not ignored), largest first.
	 * @returns {Promise<{hash, items: Zotero.Item[]}[]>}
	 */
	async groups() {
		if (this._groups) return this._groups;
		let conn = await this._conn();
		let hashes = (await conn.execute(
			`SELECT hash FROM file_hashes WHERE hash NOT IN (SELECT hash FROM duplicate_ignored)
			GROUP BY hash HAVING COUNT(*) > 1`
		)).map(r => r.getResultByIndex(0));
		let groups = [];
		for (let hash of hashes) {
			let items = await this._itemsWithHash(hash);
			if (items.length > 1) groups.push({ hash, items });
		}
		groups.sort((a, b) => b.items.length - a.items.length);
		this._groups = groups;
		return groups;
	},

	async count() {
		return (await this.groups()).length;
	},

	invalidate() {
		this._groups = null;
		this._emit();
	},

	async ignore(hash) {
		let conn = await this._conn();
		await conn.execute('INSERT OR REPLACE INTO duplicate_ignored (hash, date) VALUES (?, ?)', [hash, SSStore.today()]);
		this.invalidate();
	},

	/** Does the item have bibliographic metadata (a regular parent item with more than a title)? */
	describe(att) {
		let parent = att.parentItem;
		let meta = parent && parent.isRegularItem() ? parent : null;
		let filled = 0;
		if (meta) {
			for (let fieldID of meta.getUsedFields()) {
				let name = Zotero.ItemFields.getName(fieldID);
				if (!['title', 'accessDate', 'url', 'dateAdded', 'dateModified'].includes(name)) filled++;
			}
		}
		return {
			attachment: att,
			parent: meta,
			title: meta ? meta.getDisplayTitle() : att.getField('title'),
			creators: meta ? meta.getField('firstCreator') : '',
			year: meta ? (meta.getField('date', true, true) || '').slice(0, 4).replace(/^0000$/, '') : '',
			itemType: meta ? Zotero.ItemTypes.getName(meta.itemTypeID) : null,
			fieldCount: meta ? filled + meta.getCreators().length : 0,
			hasMetadata: !!meta && (filled > 0 || meta.getCreators().length > 0),
			dateAdded: (meta || att).dateAdded,
			dateModified: (meta || att).dateModified,
			collections: (meta || att).getCollections().length,
			notes: meta ? meta.getNotes().length : 0,
			annotations: att.isFileAttachment() ? att.getAnnotations().length : 0,
		};
	},

	// ------------------------------------------------------------ actions

	/**
	 * Merge identical PDFs into one item.
	 *
	 * With parent items: the most recently modified one is kept; its fields are
	 * filled with those of the others (on conflicts the most recently modified
	 * item wins), then Zotero merges them (notes, tags, collections, relations;
	 * identical PDFs are merged with their annotations). Copies without a
	 * parent item are folded into the kept PDF (annotations, tags, collections).
	 * Without any parent item, the oldest PDF is kept.
	 * Merged items go to the trash.
	 * @returns {Promise<Zotero.Item>} the item kept
	 */
	async merge(items) {
		items = items.filter(i => !i.deleted);
		if (items.length < 2) throw new Error('Nothing to merge');
		let byModified = (a, b) => (a.dateModified < b.dateModified ? -1 : a.dateModified > b.dateModified ? 1 : 0);
		let parents = [...new Map(items.filter(a => a.parentItem && a.parentItem.isRegularItem())
			.map(a => [a.parentItem.id, a.parentItem])).values()].sort(byModified);
		let master = null;
		if (parents.length) {
			master = parents[parents.length - 1];
			let others = parents.slice(0, -1);
			if (others.length) {
				this._mergeFields(master, parents);
				await master.saveTx();
				const { mergeItems } = ChromeUtils.importESModule('chrome://zotero/content/mergeItems.mjs');
				await mergeItems(master, others);
			}
		}
		// Zotero keeps identical PDFs apart when they have embedded annotations;
		// these files are identical byte for byte, so one copy is enough
		let live = [];
		for (let a of items) {
			let fresh = await Zotero.Items.getAsync(a.id);
			if (fresh && !fresh.deleted) live.push(fresh);
		}
		let rank = a => [
			master && a.parentItemID === master.id ? 0 : 1,
			-a.getAnnotations().length,
			a.dateAdded,
		];
		live.sort((a, b) => {
			let ra = rank(a);
			let rb = rank(b);
			for (let i = 0; i < ra.length; i++) {
				if (ra[i] < rb[i]) return -1;
				if (ra[i] > rb[i]) return 1;
			}
			return 0;
		});
		let keeper = live.shift();
		if (!keeper) throw new Error('Merge failed: no PDF left to keep');
		let target = master || keeper;
		for (let other of live) {
			await Zotero.DB.executeTransaction(async () => {
				await Zotero.Items.moveChildItems(other, keeper, { includeTrashed: true, skipEditCheck: true });
				if (other.getNote() && !keeper.getNote()) {
					keeper.setNote(other.getNote());
					await keeper.save();
				}
				if (!other.parentItem) {
					// a standalone copy: its collections and tags go to the item kept
					for (let id of other.getCollections()) target.addToCollection(id);
					for (let t of other.getTags()) {
						if (!target.hasTag(t.tag)) target.addTag(t.tag, t.type);
					}
					await target.save();
				}
				other.deleted = true;
				await other.save();
			});
		}
		this.invalidate();
		return target;
	},

	/** Fill the master's fields from all items, the most recently modified winning */
	_mergeFields(master, parentsOldestFirst) {
		let typeID = master.itemTypeID;
		let values = new Map();
		let creators = null;
		for (let p of parentsOldestFirst) {
			for (let fieldID of p.getUsedFields()) {
				let name = Zotero.ItemFields.getName(fieldID);
				if (['dateAdded', 'dateModified'].includes(name)) continue;
				let value = p.getField(fieldID);
				if (!value) continue;
				let target = Zotero.ItemFields.isValidForType(fieldID, typeID)
					? fieldID
					: Zotero.ItemFields.getFieldIDFromTypeAndBase(typeID, Zotero.ItemFields.getBaseIDFromTypeAndField(p.itemTypeID, fieldID) || fieldID);
				if (target && Zotero.ItemFields.isValidForType(target, typeID)) values.set(target, value);
			}
			if (p.getCreators().length) creators = p.getCreators();
		}
		for (let [fieldID, value] of values) master.setField(fieldID, value);
		if (creators) {
			// creator types that do not exist for the master's type become its primary type
			let primary = Zotero.CreatorTypes.getPrimaryIDForType(typeID);
			master.setCreators(creators.map(c => ({
				...c,
				creatorTypeID: Zotero.CreatorTypes.isValidForItemType(c.creatorTypeID, typeID) ? c.creatorTypeID : primary,
			})));
		}
	},

	/**
	 * Move chosen copies to the trash. A parent item left without children goes too.
	 */
	async trash(items) {
		for (let att of items) {
			let parent = att.parentItem;
			await Zotero.DB.executeTransaction(async () => {
				att.deleted = true;
				await att.save();
				if (parent && parent.isRegularItem()) {
					let children = parent.getAttachments(false).concat(parent.getNotes(false))
						.filter(id => id !== att.id);
					if (!children.length) {
						parent.deleted = true;
						await parent.save();
					}
				}
			});
		}
		this.invalidate();
	},

	// ------------------------------------------------------------ new PDFs

	registerNotifier() {
		if (this._notifierID) return;
		this._notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => {
				if (type !== 'item') return;
				if (event === 'add') {
					for (let id of ids) this._scheduleCheck(id);
				}
				else if (event === 'delete' || event === 'trash') {
					this.invalidate();
				}
			},
		}, ['item'], 'semanticSearchDuplicates');
	},

	unregisterNotifier() {
		this._stopped = true;
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
		}
		for (let t of this._pending.values()) clearTimeout(t);
		this._pending.clear();
		if (this._alertTimer) clearTimeout(this._alertTimer);
	},

	_scheduleCheck(id) {
		if (this._pending.has(id)) clearTimeout(this._pending.get(id));
		// the file of a new attachment may still be downloading
		this._pending.set(id, setTimeout(() => {
			this._pending.delete(id);
			this._checkNew(id).catch(e => Zotero.logError(e));
		}, 15000));
	},

	async _checkNew(id) {
		let item = await Zotero.Items.getAsync(id);
		if (!item || item.deleted || !item.isPDFAttachment()) return;
		// items synced from another computer keep their old dateAdded
		let added = Zotero.Date.sqlToDate(item.dateAdded, true);
		if (!added || Date.now() - added.getTime() > this.NEW_ITEM_MAX_AGE_MS) return;
		let hash = await this.hashAttachment(item);
		if (!hash) return;
		let conn = await this._conn();
		if ((await conn.execute('SELECT 1 FROM duplicate_ignored WHERE hash = ?', [hash])).length) return;
		let others = (await this._itemsWithHash(hash)).filter(i => i.id !== item.id);
		this.invalidate();
		if (!others.length) return;
		this._alertQueue.push({ item, others, hash });
		if (this._alertTimer) clearTimeout(this._alertTimer);
		this._scheduleAlert();
	},

	/** Several PDFs added together get one question; never two dialogs at once */
	_scheduleAlert() {
		if (this._alertTimer) clearTimeout(this._alertTimer);
		this._alertTimer = setTimeout(async () => {
			this._alertTimer = null;
			if (this._asking) {
				this._scheduleAlert();
				return;
			}
			let batch = this._alertQueue.splice(0);
			if (!batch.length) return;
			this._asking = true;
			try {
				await this._ask(batch);
			}
			catch (e) {
				Zotero.logError(e);
			}
			finally {
				this._asking = false;
			}
		}, this.ALERT_BATCH_MS);
	},

	async _ask(batch) {
		batch = batch.filter(b => !b.item.deleted);
		if (!batch.length) return;
		let win = Zotero.getMainWindow();
		if (!win) return;
		let l10n = win.document.l10n;
		let strings = {};
		for (let [id, args] of [
			['semsearch-dup-new-title'], ['semsearch-dup-new-review'],
			['semsearch-dup-new-delete', { count: batch.length }], ['semsearch-dup-new-keep', { count: batch.length }],
		]) {
			strings[id] = await l10n.formatValue(id, args);
		}
		let fmt = id => strings[id];
		let title = (i) => {
			let p = i.parentItem;
			return (p && p.isRegularItem() ? p : i).getDisplayTitle();
		};
		let text;
		if (batch.length === 1) {
			let b = batch[0];
			text = await l10n.formatValue('semsearch-dup-new-one', {
				title: title(b.item),
				other: title(b.others[0]),
				count: b.others.length,
			});
		}
		else {
			text = await l10n.formatValue('semsearch-dup-new-many', { count: batch.length })
				+ '\n\n' + batch.slice(0, 8).map(b => '• ' + title(b.item)).join('\n')
				+ (batch.length > 8 ? '\n…' : '');
		}
		let ps = Services.prompt;
		let flags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_1_DEFAULT;
		let choice = ps.confirmEx(win, fmt('semsearch-dup-new-title'), text, flags,
			fmt('semsearch-dup-new-delete'),
			fmt('semsearch-dup-new-keep'),
			fmt('semsearch-dup-new-review'),
			null, {});
		if (choice === 0) {
			await this.trash(batch.map(b => b.item));
		}
		else if (choice === 1) {
			for (let b of batch) await this.ignore(b.hash);
		}
		else {
			SSUI.openWindow({ duplicates: true });
		}
	},
};
