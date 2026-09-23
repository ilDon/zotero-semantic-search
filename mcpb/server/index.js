#!/usr/bin/env node
/*
 * Zotero Semantic Search – Claude Desktop extension (MCP stdio bridge).
 *
 * Claude Desktop starts this process on the user's computer and talks MCP over
 * stdio (one JSON-RPC message per line). Every message is forwarded to the
 * plugin's endpoint on Zotero's local HTTP server; nothing leaves the machine.
 *
 * When Zotero is not running, requests are answered locally with the same
 * protocol code the plugin uses (mcp.js), so the extension still starts and
 * tool calls return a clear "open Zotero" message instead of failing.
 *
 * No dependencies: Node >= 18 (fetch). Env: ZOTERO_PORT (default 23119).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// In the packaged extension mcp.js sits next to this file; in the repo it is the plugin's copy
const mcp = fs.existsSync(path.join(__dirname, 'mcp.js'))
	? require('./mcp.js')
	: require('../../addon/content/lib/mcp.js');
const { handle } = mcp;
try {
	mcp.SERVER_INFO.version = require('../manifest.json').version;
}
catch (e) {}

const PORT = parseInt(process.env.ZOTERO_PORT, 10) || 23119;
const ENDPOINT = `http://127.0.0.1:${PORT}/semantic-search/mcp`;
const TIMEOUT_MS = 120000;

function log(...args) {
	// stdout is the protocol channel: diagnostics go to stderr (Claude's MCP log)
	console.error('[zotero-semantic-search]', ...args);
}

function send(message) {
	process.stdout.write(JSON.stringify(message) + '\n');
}

const OFFLINE = 'Zotero is not running (or the Semantic Search plugin is not installed or its MCP endpoint '
	+ 'is disabled). Open Zotero and try again. Plugin: https://github.com/ilDon/zotero-semantic-search';

// Used only when Zotero cannot be reached: protocol answers work, tools report the problem
const offlineService = new Proxy({}, {
	get: () => async () => {
		throw new Error(OFFLINE);
	},
});

async function forward(message) {
	const res = await fetch(ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
		body: JSON.stringify(message),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (res.status === 202) return null;
	if (res.status === 404) throw new Error('endpoint not found');
	const text = await res.text();
	if (!text) return null;
	return JSON.parse(text);
}

async function process1(message) {
	let reply;
	try {
		reply = await forward(message);
	}
	catch (e) {
		if (e.name === 'TimeoutError' || e.name === 'AbortError') {
			log('request timed out:', message && message.method);
			if (message && message.id !== undefined && message.id !== null) {
				send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Zotero did not answer in time' } });
			}
			return;
		}
		log(`Zotero unreachable at ${ENDPOINT}: ${e.message}`);
		reply = await handle(message, offlineService);
	}
	if (reply) send(reply);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let pending = 0;
let closing = false;

rl.on('line', (line) => {
	line = line.trim();
	if (!line) return;
	let message;
	try {
		message = JSON.parse(line);
	}
	catch (e) {
		send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
		return;
	}
	pending++;
	process1(message)
		.catch((e) => {
			log('unexpected error:', e);
			if (message && message.id !== undefined && message.id !== null) {
				send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(e.message || e) } });
			}
		})
		.finally(() => {
			pending--;
			if (closing && !pending) process.exit(0);
		});
});

rl.on('close', () => {
	closing = true;
	if (!pending) process.exit(0);
});

log(`bridge started, forwarding to ${ENDPOINT}`);
