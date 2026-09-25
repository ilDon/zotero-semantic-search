'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handle, TOOLS, SUPPORTED_VERSIONS } = require('../addon/content/lib/mcp.js');

const calls = [];
const service = {
	async search(args) {
		calls.push(['search', args]);
		return { query: args.query, results: [{ similarity: 0.7, title: 'T' }] };
	},
	async getPassage(args) {
		return { text: 'passage ' + args.section };
	},
	async getItem(args) {
		if (args.key === 'MISSING') throw new Error('No item with key MISSING');
		return { item_key: args.key };
	},
	async findSimilar() {
		return { results: [] };
	},
	async indexStatus() {
		return { indexed_documents: 1 };
	},
	async listSearches() {
		return { searches: [] };
	},
};

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('initialize negotiates the protocol version', async () => {
	let r = await handle(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }), service);
	assert.strictEqual(r.result.protocolVersion, '2025-03-26');
	assert.ok(r.result.capabilities.tools);
	assert.ok(r.result.serverInfo.name);
	r = await handle(rpc('initialize', { protocolVersion: '1999-01-01' }), service);
	assert.strictEqual(r.result.protocolVersion, SUPPORTED_VERSIONS[0]);
});

test('notifications get no response', async () => {
	assert.strictEqual(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, service), null);
	assert.strictEqual(await handle([{ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }], service), null);
});

test('tools/list exposes valid JSON schemas', async () => {
	let r = await handle(rpc('tools/list'), service);
	assert.strictEqual(r.result.tools.length, TOOLS.length);
	for (let t of r.result.tools) {
		assert.ok(t.name && t.description);
		assert.strictEqual(t.inputSchema.type, 'object');
	}
});

test('tools/call returns text and structured content', async () => {
	let r = await handle(rpc('tools/call', { name: 'semantic_search', arguments: { query: 'abc', limit: 3 } }), service);
	assert.ok(!r.result.isError);
	assert.strictEqual(r.result.structuredContent.results[0].similarity, 0.7);
	assert.deepStrictEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent);
	assert.deepStrictEqual(calls[0], ['search', { query: 'abc', limit: 3 }]);
});

test('tool errors are reported as isError results, not protocol errors', async () => {
	let r = await handle(rpc('tools/call', { name: 'get_item', arguments: { key: 'MISSING' } }), service);
	assert.strictEqual(r.result.isError, true);
	assert.match(r.result.content[0].text, /MISSING/);
	r = await handle(rpc('tools/call', { name: 'semantic_search', arguments: { query: '  ' } }), service);
	assert.strictEqual(r.result.isError, true);
});

test('unknown tools and methods are JSON-RPC errors', async () => {
	let r = await handle(rpc('tools/call', { name: 'nope', arguments: {} }), service);
	assert.strictEqual(r.error.code, -32602);
	r = await handle(rpc('does/not/exist'), service);
	assert.strictEqual(r.error.code, -32601);
	r = await handle({ id: 3, method: 'x' }, service);
	assert.strictEqual(r.error.code, -32600);
});

test('batches return one response per request', async () => {
	let r = await handle([rpc('ping', {}, 1), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list', {}, 2)], service);
	assert.strictEqual(r.length, 2);
	assert.deepStrictEqual(r.map(x => x.id), [1, 2]);
});

test('added_after is validated and passed to the service', async () => {
	let r = await handle(rpc('tools/call', { name: 'semantic_search', arguments: { query: 'abc', added_after: '31/01/2024' } }), service);
	assert.strictEqual(r.result.isError, true);
	assert.match(r.result.content[0].text, /YYYY-MM-DD/);
	r = await handle(rpc('tools/call', { name: 'semantic_search', arguments: { query: 'abc', added_after: '2024-01-31' } }), service);
	assert.ok(!r.result.isError);
	assert.strictEqual(calls[calls.length - 1][1].added_after, '2024-01-31');
	const tool = TOOLS.find(t => t.name === 'semantic_search');
	assert.strictEqual(tool.inputSchema.properties.added_after.type, 'string');
});

test('create_parent_item validates its arguments before calling the service', async () => {
	let r = await handle(rpc('tools/call', { name: 'create_parent_item', arguments: { attachment_key: 'K', item_type: 'book' } }), service);
	assert.strictEqual(r.result.isError, true);
	r = await handle(rpc('tools/call', { name: 'create_parent_item', arguments: { attachment_key: 'K', item_type: 'book', title: 'T', fields: [] } }), service);
	assert.strictEqual(r.result.isError, true);
	const tool = TOOLS.find(t => t.name === 'create_parent_item');
	assert.strictEqual(tool.annotations.readOnlyHint, false);
});

test('list_attachments_without_parent validates added_after', async () => {
	let r = await handle(rpc('tools/call', { name: 'list_attachments_without_parent', arguments: { added_after: '2024/01/31' } }), service);
	assert.strictEqual(r.result.isError, true);
	const tool = TOOLS.find(t => t.name === 'list_attachments_without_parent');
	assert.ok(tool.inputSchema.properties.added_after);
});
