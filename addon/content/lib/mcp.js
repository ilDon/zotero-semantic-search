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
	const SERVER_INFO = { name: 'zotero-semantic-search', title: 'Zotero Semantic Search', version: '2.0.0' };

	const INSTRUCTIONS = `This server searches the user's Zotero library by meaning (not keywords).
Every PDF in the library is split into passages and embedded with LEALLA-large, a
multilingual (109 languages) sentence encoder; a query is embedded the same way and passages
are ranked by cosine similarity. Queries work best as a full sentence or short paragraph that
states the idea you are looking for (e.g. a sentence from the user's draft), in any language.
Similarity depends on query length: with paragraph-long queries 0.6+ is a good match; with
short queries (a phrase or one sentence) 0.45-0.55 is already relevant. Passage text of
documents indexed by the old version of this tool is located approximately (text_is_approximate).
Use semantic_search first, then get_passage for more context around a hit and get_item for
bibliographic details. Cite works using the metadata returned by get_item.`;

	const TOOLS = [
		{
			name: 'semantic_search',
			title: 'Semantic search in Zotero',
			description: 'Find passages in the PDFs of the Zotero library whose meaning is close to the query. '
				+ 'Returns passages ranked by cosine similarity, with the Zotero item they come from '
				+ '(title, authors, year, item key), the page and the passage text.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'A sentence or short paragraph expressing the concept to find (any language).' },
					limit: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Maximum number of passages.' },
					min_similarity: { type: 'number', minimum: 0, maximum: 1, description: 'Minimum cosine similarity (default 0.4).' },
					group_by_item: { type: 'boolean', default: false, description: 'Return at most one passage (the best) per document.' },
					use_cache: { type: 'boolean', default: true, description: 'Reuse saved results if this exact query was searched before.' },
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
					result = {
						protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
						capabilities: { tools: { listChanged: false } },
						serverInfo: SERVER_INFO,
						instructions: INSTRUCTIONS,
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

	return { handle, TOOLS, SUPPORTED_VERSIONS, SERVER_INFO };
}));
