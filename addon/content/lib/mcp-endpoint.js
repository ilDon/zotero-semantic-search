/* global Zotero, SSMcp, SSSearch, SSPassages, SSStore, SSVectorIndex, SSIndexer, SSModelManager */
/* exported SSMcpEndpoint */

/**
 * Exposes the MCP server on Zotero's local HTTP server:
 *   http://127.0.0.1:23119/semantic-search/mcp
 * Zotero's server only listens on localhost and refuses requests coming from
 * web pages (browser user agents / Origin header), so only local programs
 * (Claude Code, Claude Desktop via mcp-remote, other MCP clients) can call it.
 */
var SSMcpEndpoint = {
	PATH: '/semantic-search/mcp',
	DEFAULT_MIN_SIMILARITY: 0.4,
	TEXT_BUDGET_MS: 15000,

	get url() {
		let port = Zotero.Prefs.get('httpServer.port') || 23119;
		return `http://127.0.0.1:${port}${this.PATH}`;
	},

	get enabled() {
		return !!Zotero.Prefs.get('extensions.semantic-search.mcp.enabled', true);
	},

	register() {
		let codes = Zotero.Server.responseCodes;
		if (!codes[202]) codes[202] = 'Accepted';
		if (!codes[405]) codes[405] = 'Method Not Allowed';
		let self = this;
		let Endpoint = function () {};
		Endpoint.prototype = {
			supportedMethods: ['GET', 'POST'],
			supportedDataTypes: ['application/json'],
			async init(req) {
				if (!self.enabled) {
					return [404, 'text/plain', 'MCP endpoint disabled in Semantic Search settings\n'];
				}
				if (req.method !== 'POST') {
					// No server-initiated streams: GET is not supported (Streamable HTTP spec)
					return [405, { 'Content-Type': 'text/plain', Allow: 'POST' }, 'Method Not Allowed\n'];
				}
				if (!req.data || typeof req.data !== 'object') {
					return [400, 'application/json', JSON.stringify({
						jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
					})];
				}
				let res;
				try {
					res = await SSMcp.handle(req.data, self.service);
				}
				catch (e) {
					Zotero.logError(e);
					return [500, 'application/json', JSON.stringify({
						jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e.message || e) },
					})];
				}
				if (res === null) return [202, 'text/plain', ''];
				return [200, 'application/json; charset=utf-8', JSON.stringify(res)];
			},
		};
		Zotero.Server.Endpoints[this.PATH] = Endpoint;
	},

	unregister() {
		delete Zotero.Server.Endpoints[this.PATH];
	},

	/** Configuration snippets for MCP clients */
	clientConfig() {
		return {
			claudeCode: `claude mcp add --transport http zotero ${this.url}`,
			json: JSON.stringify({ mcpServers: { zotero: { type: 'http', url: this.url } } }, null, 2),
			claudeDesktop: JSON.stringify({
				mcpServers: { zotero: { command: 'npx', args: ['-y', 'mcp-remote', this.url] } },
			}, null, 2),
		};
	},

	async _resolveAttachment(key) {
		let item = await SSPassages.getItemByKey(key);
		if (!item) return null;
		if (item.isPDFAttachment()) return item;
		if (item.isRegularItem()) {
			let best = await item.getBestAttachment();
			if (best && best.isPDFAttachment()) return best;
			for (let id of item.getAttachments()) {
				let a = Zotero.Items.get(id);
				if (a && a.isPDFAttachment() && SSVectorIndex.hasDocument(a.key)) return a;
			}
		}
		return null;
	},

	_shape(r, maxText) {
		let text = r.text || '';
		if (maxText && text.length > maxText) text = text.slice(0, maxText) + '…';
		let page = Number.isInteger(r.page) ? r.page + 1 : null;
		return {
			similarity: Math.round(r.similarity * 10000) / 10000,
			title: r.title || r.file_name,
			authors: r.authors || [],
			year: r.year || null,
			item_type: r.itemType || null,
			item_key: r.itemKey || null,
			attachment_key: r.folder_id,
			section: r.section_number,
			page,
			text: r.textPending ? null : text,
			text_is_approximate: !!r.approximate,
			...(r.textPending ? { text_note: 'Text still being extracted from a large PDF; call get_passage.' } : {}),
			zotero_select: r.itemKey ? `zotero://select/library/items/${r.itemKey}` : null,
			zotero_open_pdf: `zotero://open-pdf/library/items/${r.folder_id}${page ? '?page=' + page : ''}`,
			in_library: !r.missing,
			...(r.duplicates ? { identical_copies_in: r.duplicates } : {}),
		};
	},

	service: {
		async search(args) {
			let limit = Math.min(100, Math.max(1, parseInt(args.limit) || 10));
			let res = await SSSearch.search(args.query, {
				// Short LLM queries score lower than the paragraph-long queries of the UI
				minSimilarity: typeof args.min_similarity === 'number' ? args.min_similarity : SSMcpEndpoint.DEFAULT_MIN_SIMILARITY,
				useCache: args.use_cache !== false,
				// Searches made by an LLM do not clutter the user's history
				save: false,
			});
			let results = res.results;
			let total = results.length;
			if (args.group_by_item) {
				results = SSSearch.groupByDocument(results).map(g => g.results[0]);
			}
			results = results.slice(0, limit).map(r => ({ ...r }));
			// Passage text: cached/fast sources first, then PDF extraction within a time budget
			await SSPassages.enrich(results, { text: true, fast: true, chars: 2000 });
			let deadline = Date.now() + SSMcpEndpoint.TEXT_BUDGET_MS;
			for (let r of results.filter(x => x.textPending)) {
				let remaining = deadline - Date.now();
				if (remaining <= 0) break;
				let done = await Promise.race([
					SSPassages.enrich([r], { text: true, chars: 2000 }).then(() => true, () => true),
					Zotero.Promise.delay(remaining).then(() => false),
				]);
				if (!done) break;
			}
			results = results.filter(r => !r.missing);
			if (!results.length) {
				return {
					query: res.query,
					total_matches: 0,
					results: [],
					note: 'No passage reached the similarity threshold. Try rephrasing the query as a full sentence, '
						+ 'or lower min_similarity (e.g. 0.5).',
				};
			}
			return {
				query: res.query,
				from_cache: !!res.fromCache,
				total_matches: total,
				results: results.map(r => SSMcpEndpoint._shape(r, 2500)),
			};
		},

		async getPassage(args) {
			let item = await SSPassages.getItemByKey(args.attachment_key);
			if (!item) throw new Error('No item with key ' + args.attachment_key);
			let context = Math.min(5, Math.max(0, parseInt(args.context ?? 1)));
			let chunks = await SSStore.getDocumentChunks(item.key);
			if (!chunks.length) throw new Error('This document is not indexed');
			let meta = SSPassages.describeItem(item);
			let section = args.section;
			if (chunks[0].scheme === 2) {
				let from = Math.max(0, section - context);
				let to = Math.min(chunks.length - 1, section + context);
				let sel = chunks.slice(from, to + 1);
				return {
					title: meta.title,
					item_key: meta.itemKey,
					attachment_key: item.key,
					sections: [from, to],
					page: Number.isInteger(sel[0].page) ? sel[0].page + 1 : null,
					text: sel.map(c => c.text).join(' '),
					text_is_approximate: false,
				};
			}
			// Legacy section: text recovered proportionally from the PDF
			let ft = await SSPassages.getFullText(item);
			let n = Math.max(chunks.length, section + 1);
			let len = ft.full.length;
			let start = Math.floor(((section - context) / n) * len);
			let end = Math.ceil(((section + context + 1) / n) * len);
			start = Math.max(0, start);
			end = Math.min(len, end);
			return {
				title: meta.title,
				item_key: meta.itemKey,
				attachment_key: item.key,
				sections: [Math.max(0, section - context), Math.min(n - 1, section + context)],
				page: SSPassages.pageAt(ft.pageStarts, start) + 1,
				text: SSPassages.clean(ft.full.slice(start, end)),
				text_is_approximate: true,
			};
		},

		async getItem(args) {
			let item = await SSPassages.getItemByKey(args.key);
			if (!item) throw new Error('No item with key ' + args.key);
			let parent = item.isAttachment() && item.parentItem ? item.parentItem : item;
			let fields = {};
			for (let f of ['title', 'date', 'publicationTitle', 'bookTitle', 'volume', 'issue', 'pages',
				'publisher', 'place', 'edition', 'series', 'DOI', 'ISBN', 'ISSN', 'url', 'language',
				'abstractNote', 'court', 'reporter', 'docketNumber', 'dateDecided']) {
				try {
					let v = parent.getField(f, false, true);
					if (v) fields[f] = v;
				}
				catch (e) {}
			}
			let citation = null;
			try {
				let setting = Zotero.Prefs.get('export.quickCopy.setting');
				if (parent.isRegularItem() && setting && setting.startsWith('bibliography')) {
					let content = Zotero.QuickCopy.getContentFromItems([parent], setting);
					if (content && content.text) citation = content.text.trim();
				}
			}
			catch (e) {
				Zotero.debug('Semantic Search: citation failed: ' + e);
			}
			let attachments = [];
			if (parent.isRegularItem()) {
				for (let id of parent.getAttachments()) {
					let a = Zotero.Items.get(id);
					if (!a || !a.isPDFAttachment()) continue;
					attachments.push({
						attachment_key: a.key,
						title: a.getField('title'),
						indexed: SSVectorIndex.loaded ? SSVectorIndex.hasDocument(a.key) : undefined,
					});
				}
			}
			else if (parent.isPDFAttachment()) {
				attachments.push({ attachment_key: parent.key, title: parent.getField('title') });
			}
			return {
				item_key: parent.key,
				item_type: Zotero.ItemTypes.getName(parent.itemTypeID),
				creators: parent.getCreators().map(c => ({
					type: Zotero.CreatorTypes.getName(c.creatorTypeID),
					first_name: c.firstName || undefined,
					last_name: c.lastName || undefined,
				})),
				...fields,
				tags: parent.getTags().map(t => t.tag),
				citation,
				attachments,
				zotero_select: `zotero://select/library/items/${parent.key}`,
			};
		},

		async findSimilar(args) {
			let att = await SSMcpEndpoint._resolveAttachment(args.key);
			if (!att) throw new Error('No indexed PDF found for key ' + args.key);
			let docs = await SSSearch.similarDocuments(att.key, Math.min(50, parseInt(args.limit) || 10));
			return {
				source: SSPassages.describeItem(att).title,
				results: docs.map(d => ({
					similarity: Math.round(d.score * 10000) / 10000,
					title: d.title,
					authors: d.authors,
					year: d.year || null,
					item_key: d.itemKey,
					attachment_key: d.key,
					zotero_select: `zotero://select/library/items/${d.itemKey}`,
				})),
			};
		},

		async indexStatus() {
			let excluded = await SSStore.getExcluded();
			let byReason = {};
			for (let e of excluded) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
			let pending = null;
			try {
				pending = (await SSIndexer.findUnprocessed()).length;
			}
			catch (e) {}
			return {
				model: (await SSModelManager.status()).state,
				indexed_documents: SSVectorIndex.loaded ? SSVectorIndex.documentCount() : (await SSStore.getIndexedIDs()).size,
				indexed_passages: SSVectorIndex.loaded ? SSVectorIndex.liveCount : null,
				excluded_documents: excluded.length,
				excluded_by_reason: byReason,
				waiting_to_be_indexed: pending,
				indexer: SSIndexer.status().state,
				database: SSStore.path,
			};
		},

		async listSearches(args) {
			let limit = Math.min(200, Math.max(1, parseInt(args.limit) || 20));
			let list = await SSStore.listHistory();
			return {
				searches: list.slice(0, limit).map(h => ({ query: h.query, date: h.date, results: h.count })),
			};
		},
	},
};
