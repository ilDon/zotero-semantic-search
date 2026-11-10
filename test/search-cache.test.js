'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIB = path.join(__dirname, '..', 'addon', 'content', 'lib');

/** Load an add-on script (plain `var` globals) in a sandbox with the given globals */
function load(file, globals) {
	let ctx = vm.createContext({ ...globals });
	vm.runInContext(fs.readFileSync(path.join(LIB, file), 'utf8'), ctx, { filename: file });
	return ctx;
}

/** SSSearch with an in-memory history and a fake index whose state and results the test sets */
function setup() {
	let history = new Map();
	let index = { state: 's0', results: [] };
	let ctx = load('search.js', {
		Zotero: { Prefs: { get: () => undefined } },
		SSModels: { activeId: 'e5-small', active: { minSimilarity: 0.87 } },
		SSModelManager: { isReady: async () => true },
		SSVectorIndex: { load: async () => {}, stateKey: () => index.state },
		SSEmbedder: { embedQuery: async q => ({ vectors: [Float32Array.from([1, 0])], segments: [q] }) },
		SSStore: {
			today: () => '2026-11-10',
			getHistory: async id => (history.has(id) ? structuredClone(history.get(id)) : null),
			async saveHistory(id, query, emb, results, model, source, run = {}) {
				history.set(id, { id, query, date: '2026-11-10', results: structuredClone(results), model, source,
					indexState: run.indexState ?? null, minSimilarity: run.minSimilarity ?? null });
			},
		},
	});
	let S = ctx.SSSearch;
	S.hashQuery = q => q;
	S.rank = async () => structuredClone(index.results);
	return { S, history, index };
}

const hit = (folder, section, similarity = 0.9) => ({ similarity, folder_id: folder, section_number: section, rowid: section });

test('an empty result saved while indexing is not replayed once the index has passages', async () => {
	let { S, index } = setup();
	let r = await S.search('backpropagation');
	assert.strictEqual(r.fromCache, false);
	assert.deepStrictEqual(r.results, []);
	// indexing finishes
	index.state = 's1';
	index.results = [hit('A', 113)];
	r = await S.search('backpropagation');
	assert.strictEqual(r.fromCache, false);
	assert.strictEqual(r.results.length, 1);
});

test('an empty result is never reused, even with an unchanged index', async () => {
	let { S, index } = setup();
	await S.search('q');
	index.results = [hit('A', 1)];
	let r = await S.search('q');
	assert.strictEqual(r.fromCache, false);
	assert.strictEqual(r.results.length, 1);
});

test('saved results are reused only while the index and the threshold are unchanged', async () => {
	let { S, index } = setup();
	index.results = [hit('A', 1)];
	await S.search('q', { minSimilarity: 0.8 });
	assert.strictEqual((await S.search('q', { minSimilarity: 0.8 })).fromCache, true);
	// other threshold
	assert.strictEqual((await S.search('q', { minSimilarity: 0.1 })).fromCache, false);
	assert.strictEqual((await S.search('q', { minSimilarity: 0.1 })).fromCache, true);
	// a PDF indexed or removed
	index.state = 's1';
	assert.strictEqual((await S.search('q', { minSimilarity: 0.1 })).fromCache, false);
	// "Search again"
	assert.strictEqual((await S.search('q', { minSimilarity: 0.1, useCache: false })).fromCache, false);
});

test('searches saved before the index state was recorded are run again', async () => {
	let { S, history, index } = setup();
	history.set('e5-small\nq', { id: 'e5-small\nq', query: 'q', date: '2020-01-01', results: [hit('A', 1)],
		model: 'e5-small', source: 'manual', indexState: null, minSimilarity: null });
	index.results = [hit('A', 1), hit('B', 2)];
	let r = await S.search('q');
	assert.strictEqual(r.fromCache, false);
	assert.strictEqual(r.results.length, 2);
});

test('a stale saved search run again keeps the statuses the user set', async () => {
	let { S, history, index } = setup();
	index.results = [hit('A', 1), hit('B', 2)];
	await S.search('q');
	history.get('e5-small\nq').results[0].status = 1;
	index.state = 's1';
	index.results = [hit('C', 3), hit('A', 1)];
	let r = await S.search('q');
	assert.strictEqual(r.fromCache, false);
	assert.strictEqual(r.results.find(x => x.folder_id === 'A').status, 1);
	assert.strictEqual(r.results.find(x => x.folder_id === 'C').status, undefined);
});

test('the index state changes when passages are added or removed', () => {
	let ctx = load('vector-index.js', { SSActiveProxy: () => ({}) });
	let key = idx => ctx.SSVectorIndexImpl.prototype.stateKey.call(idx);
	let idx = { n: 3, docIdx: Int32Array.from([0, 0, 1]), rowids: Int32Array.from([5, 6, 7]), liveCount: 3 };
	let before = key(idx);
	assert.strictEqual(before, '3:7');
	// document 1 removed (tombstoned)
	assert.notStrictEqual(key({ ...idx, docIdx: Int32Array.from([0, 0, -1]), liveCount: 2 }), before);
	// document 0 re-indexed: new rows at the end
	let re = { n: 5, docIdx: Int32Array.from([-1, -1, 1, 0, 0]), rowids: Int32Array.from([5, 6, 7, 8, 9]), liveCount: 3 };
	assert.notStrictEqual(key(re), before);
});
