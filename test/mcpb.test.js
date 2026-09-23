'use strict';
// The Claude Desktop extension bridge: stdio <-> the plugin's HTTP endpoint.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const BRIDGE = path.join(__dirname, '..', 'mcpb', 'server', 'index.js');

function runBridge(port, messages) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env, ZOTERO_PORT: String(port) } });
		const lines = [];
		let buf = '';
		child.stdout.on('data', (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf('\n')) !== -1) {
				lines.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
		});
		child.on('error', reject);
		child.on('exit', () => resolve(lines));
		for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
		child.stdin.end();
	});
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const notif = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'index_status', arguments: {} } };

test('forwards messages to the plugin endpoint', async () => {
	const seen = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', d => body += d);
		req.on('end', () => {
			const m = JSON.parse(body);
			seen.push([req.url, m.method]);
			if (m.id === undefined) {
				res.writeHead(202);
				return res.end();
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { echo: m.method } }));
		});
	});
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	const lines = await runBridge(server.address().port, [init, notif, call]);
	server.close();
	assert.deepStrictEqual(seen.map(s => s[0]), ['/semantic-search/mcp', '/semantic-search/mcp', '/semantic-search/mcp']);
	assert.deepStrictEqual(lines.map(l => [l.id, l.result.echo]).sort(), [[1, 'initialize'], [2, 'tools/call']]);
});

test('answers locally with a clear error when Zotero is not running', async () => {
	const server = http.createServer();
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	const port = server.address().port;
	server.close(); // nothing listens on this port any more
	const lines = await runBridge(port, [init, notif, call]);
	const byId = Object.fromEntries(lines.map(l => [l.id, l]));
	assert.ok(byId[1].result.capabilities.tools);
	assert.strictEqual(byId[2].result.isError, true);
	assert.match(byId[2].result.content[0].text, /Zotero is not running/);
});
