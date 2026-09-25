/*
 * Model Context Protocol server (Streamable HTTP transport, JSON responses).
 *
 * Transport-agnostic: `handle(body, service)` takes the parsed JSON-RPC
 * payload (object or batch array) and returns the JSON-RPC response payload,
 * or null when nothing must be sent back (notifications only -> HTTP 202).
 * `service` provides the actual operations (see mcp-endpoint.js).
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	}
	else {
		root.SSMcp = factory();
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
	const SERVER_INFO = { name: 'zotero-semantic-search', title: 'Zotero Semantic Search', version: '2.1.0' };

	/**
	 * Server instructions. `model` describes the active embedding model:
	 * {label, languages, paragraph, short} (similarity guidance); defaults to
	 * LEALLA-large, the model of earlier versions.
	 */
	function instructions(model) {
		const m = Object.assign({ label: 'LEALLA-large', languages: 109, paragraph: '0.6+', short: '0.45-0.55' }, model || {});
		return `This server searches the user's Zotero library by meaning (not keywords).
Every PDF in the library is split into passages and embedded with ${m.label}, a
multilingual (${m.languages} languages) sentence encoder; a query is embedded the same way and passages
are ranked by cosine similarity. Queries work best as a full sentence or short paragraph that
states the idea you are looking for (e.g. a sentence from the user's draft), in any language.
Similarity depends on the model and on query length: with paragraph-long queries ${m.paragraph} is a good
match; with short queries (a phrase or one sentence) ${m.short} is already relevant. Passage text of
documents indexed by the old version of this tool is located approximately (text_is_approximate).
Use semantic_search first, then get_passage for more context around a hit and get_item for
bibliographic details. Cite works using the metadata returned by get_item.`;
	}

	const INSTRUCTIONS = instructions();

	const TOOLS = [
		{
			name: 'semantic_search',
			title: 'Semantic search in Zotero',
			description: 'Find passages in the PDFs of the Zotero library whose meaning is close to the query. '
				+ 'Returns passages ranked by cosine similarity, with the Zotero item they come from '
				+ '(title, authors, year, item type, item key), the page and the passage text.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'A sentence or short paragraph expressing the concept to find (any language).' },
					limit: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Maximum number of passages.' },
					min_similarity: { type: 'number', minimum: 0, maximum: 1, description: 'Minimum cosine similarity. The default depends on the embedding model (see the server instructions).' },
					group_by_item: { type: 'boolean', default: false, description: 'Return at most one passage (the best) per document.' },
					added_after: {
						type: 'string',
						description: 'Only search items added to the Zotero library on or after this date (YYYY-MM-DD). Filtering happens before ranking, so `limit` applies to the matching items only. Each result reports its date_added.',
					},
					item_types: {
						type: 'array',
						items: { type: 'string' },
						description: 'Only return passages from items of these Zotero item types, e.g. ["book", "journalArticle", "bookSection", "case", "statute", "thesis", "report", "conferencePaper", "document"]. Each result reports its item_type.',
					},
					use_cache: { type: 'boolean', default: false, description: 'Return the results saved in the user\'s search history if this exact query was searched before in Zotero.' },
				},
				required: ['query'],
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		{
			name: 'get_passage',
			title: 'Get passage context',
			description: 'Get the text of a passage returned by semantic_search, with surrounding context.',
			inputSchema: {
				type: 'object',
				properties: {
					attachment_key: { type: 'string', description: 'attachment_key of the search result.' },
					section: { type: 'integer', description: 'section of the search result.' },
					context: { type: 'integer', minimum: 0, maximum: 5, default: 1, description: 'Number of neighbouring passages to include on each side.' },
				},
				required: ['attachment_key', 'section'],
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		{
			name: 'get_item',
			title: 'Get Zotero item',
			description: 'Bibliographic metadata of a Zotero item (by item key or attachment key): type, title, '
				+ 'creators, date, publication, DOI/URL, abstract, tags, a formatted citation and a zotero:// link.',
			inputSchema: {
				type: 'object',
				properties: {
					key: { type: 'string', description: 'item_key or attachment_key.' },
				},
				required: ['key'],
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		{
			name: 'find_similar_items',
			title: 'Find similar documents',
			description: 'Documents in the library whose content is most similar overall to the given document.',
			inputSchema: {
				type: 'object',
				properties: {
					key: { type: 'string', description: 'item_key or attachment_key of an indexed document.' },
					limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
				},
				required: ['key'],
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		{
			name: 'index_status',
			title: 'Index status',
			description: 'How many documents and passages are indexed, excluded or waiting to be indexed.',
			inputSchema: { type: 'object', properties: {} },
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		{
			name: 'list_attachments_without_parent',
			title: 'List PDFs without a parent item',
			description: 'PDF attachments that are standalone items (no parent item, hence no bibliographic metadata), '
				+ 'newest first. Use create_parent_item to give them one.',
			inputSchema: {
				type: 'object',
				properties: {
					limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
					offset: { type: 'integer', minimum: 0, default: 0 },
				},
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		{
			name: 'create_parent_item',
			title: 'Create a parent item for a PDF',
			description: 'Create a Zotero item with bibliographic metadata and make a standalone PDF attachment its child '
				+ '(like "Create Parent Item" in Zotero). Only for attachments without a parent item. Use get_passage '
				+ 'or semantic_search to read the PDF (title page, colophon) and fill the metadata from it; do not invent '
				+ 'values you cannot find. Fields that are not valid for the item type are reported and ignored.',
			inputSchema: {
				type: 'object',
				properties: {
					attachment_key: { type: 'string', description: 'Key of the standalone PDF attachment.' },
					item_type: {
						type: 'string',
						description: 'Zotero item type, e.g. "book", "bookSection", "journalArticle", "thesis", "report", '
							+ '"conferencePaper", "case", "statute", "document".',
					},
					title: { type: 'string' },
					creators: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								first_name: { type: 'string' },
								last_name: { type: 'string' },
								name: { type: 'string', description: 'Single-field name (institutions); instead of first/last name.' },
								creator_type: { type: 'string', default: 'author', description: 'e.g. author, editor, contributor.' },
							},
						},
					},
					fields: {
						type: 'object',
						additionalProperties: { type: 'string' },
						description: 'Other Zotero fields, e.g. {"date": "2021", "publisher": "Il Mulino", "place": "Bologna", '
							+ '"publicationTitle": "...", "volume": "3", "pages": "12-34", "DOI": "...", "ISBN": "...", "language": "it"}.',
					},
					tags: { type: 'array', items: { type: 'string' } },
				},
				required: ['attachment_key', 'item_type', 'title'],
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		{
			name: 'list_saved_searches',
			title: 'List saved searches',
			description: 'Searches previously run by the user (the search history), newest first.',
			inputSchema: {
				type: 'object',
				properties: {
					limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
				},
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
	];

	function rpcError(id, code, message, data) {
		const e = { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
		if (data !== undefined) e.error.data = data;
		return e;
	}

	function toolResult(value) {
		return {
			content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
			structuredContent: typeof value === 'object' && !Array.isArray(value) ? value : { result: value },
		};
	}

	function toolError(message) {
		return { content: [{ type: 'text', text: message }], isError: true };
	}

	async function callTool(name, args, service) {
		args = args || {};
		switch (name) {
			case 'semantic_search':
				if (typeof args.query !== 'string' || !args.query.trim()) return toolError('query must be a non-empty string');
				if (args.added_after !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(args.added_after))) {
					return toolError('added_after must be a date in the form YYYY-MM-DD');
				}
				return toolResult(await service.search(args));
			case 'get_passage':
				if (!args.attachment_key || !Number.isInteger(args.section)) {
					return toolError('attachment_key and integer section are required');
				}
				return toolResult(await service.getPassage(args));
			case 'get_item':
				if (!args.key) return toolError('key is required');
				return toolResult(await service.getItem(args));
			case 'find_similar_items':
				if (!args.key) return toolError('key is required');
				return toolResult(await service.findSimilar(args));
			case 'index_status':
				return toolResult(await service.indexStatus());
			case 'list_saved_searches':
				return toolResult(await service.listSearches(args));
			case 'list_attachments_without_parent':
				return toolResult(await service.listOrphanAttachments(args));
			case 'create_parent_item':
				if (!args.attachment_key || !args.item_type || typeof args.title !== 'string' || !args.title.trim()) {
					return toolError('attachment_key, item_type and a non-empty title are required');
				}
				if (args.creators !== undefined && !Array.isArray(args.creators)) return toolError('creators must be an array');
				if (args.fields !== undefined && (typeof args.fields !== 'object' || Array.isArray(args.fields))) {
					return toolError('fields must be an object');
				}
				return toolResult(await service.createParentItem(args));
			default:
				return null;
		}
	}

	async function handleOne(msg, service) {
		if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
			// Responses from the client (to server requests we never send) are ignored
			if (msg && msg.jsonrpc === '2.0' && (msg.result !== undefined || msg.error !== undefined)) return null;
			return rpcError(msg && msg.id, -32600, 'Invalid Request');
		}
		const isNotification = msg.id === undefined || msg.id === null;
		const id = msg.id;
		const params = msg.params || {};
		try {
			let result;
			switch (msg.method) {
				case 'initialize': {
					const requested = params.protocolVersion;
					let instr = INSTRUCTIONS;
					if (typeof service.instructions === 'function') {
						try {
							instr = (await service.instructions()) || INSTRUCTIONS;
						}
						catch (e) {} // e.g. the Claude Desktop bridge while Zotero is closed
					}
					result = {
						protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
						capabilities: { tools: { listChanged: false } },
						serverInfo: SERVER_INFO,
						instructions: instr,
					};
					break;
				}
				case 'ping':
					result = {};
					break;
				case 'tools/list':
					result = { tools: TOOLS };
					break;
				case 'tools/call': {
					let r;
					try {
						r = await callTool(params.name, params.arguments, service);
					}
					catch (e) {
						r = toolError(String(e && e.message || e));
					}
					if (r === null) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
					result = r;
					break;
				}
				case 'resources/list':
					result = { resources: [] };
					break;
				case 'resources/templates/list':
					result = { resourceTemplates: [] };
					break;
				case 'prompts/list':
					result = { prompts: [] };
					break;
				default:
					if (msg.method.startsWith('notifications/')) return null;
					if (isNotification) return null;
					return rpcError(id, -32601, `Method not found: ${msg.method}`);
			}
			if (isNotification) return null;
			return { jsonrpc: '2.0', id, result };
		}
		catch (e) {
			if (isNotification) return null;
			return rpcError(id, -32603, String(e && e.message || e));
		}
	}

	async function handle(body, service) {
		if (Array.isArray(body)) {
			if (!body.length) return rpcError(null, -32600, 'Invalid Request');
			const out = [];
			for (const m of body) {
				const r = await handleOne(m, service);
				if (r) out.push(r);
			}
			return out.length ? out : null;
		}
		return handleOne(body, service);
	}

	return { handle, instructions, TOOLS, SUPPORTED_VERSIONS, SERVER_INFO };
}));
