/*
 * Embedding worker (ChromeWorker). Holds the tokenizer, the WASM encoder and a
 * word-embedding row cache of one model. Messages:
 *   {type:'init', runtime, modelPath, vocabPath, ...}  -> {type:'ready'}
 *   {type:'embed', id, texts}                          -> {id, vectors}
 *   {type:'query', id, text}                           -> {id, vectors, segments}
 *   {type:'document', id, pages}                       -> progress..., {id, chunks, vectors}
 *   {type:'cancel', id}
 *
 * runtime 'lealla': LEALLA-large (lealla.wasm, WordPiece), exactly as before.
 * runtime 'xlmr': multilingual-e5 / Arctic-embed (encoder.wasm, SentencePiece).
 */
/* global importScripts, IOUtils, SSTokenizer, SSLealla, SSXlmr, SSChunker */
importScripts(
	'chrome://semantic-search/content/lib/tokenizer.js',
	'chrome://semantic-search/content/lib/lealla.js',
	'chrome://semantic-search/content/lib/xlmr.js',
	'chrome://semantic-search/content/lib/chunker.js'
);

let model = null;
let dim = 0;
let chunkOpts = {}; // passage size for the chunker (default: LEALLA's 126 pieces)
const cancelled = new Set();

function readRangeFactory(path) {
	return async (offset, length) => IOUtils.read(path, { offset, maxBytes: length });
}

async function initLealla({ modelPath, vocabPath, wasmURL, extraURL }) {
	const readRange = readRangeFactory(modelPath);
	const [vocab, tensors, wasmBytes, extra] = await Promise.all([
		IOUtils.readUTF8(vocabPath),
		SSLealla.readSafetensorsHeader(readRange),
		fetch(wasmURL).then((r) => r.arrayBuffer()),
		fetch(extraURL).then((r) => r.json()),
	]);
	const tokenizer = new SSTokenizer.WordPieceTokenizer(vocab);
	const { instance } = await WebAssembly.instantiate(wasmBytes, {});
	const encoder = new SSLealla.Encoder(instance);
	await SSLealla.packEncoderWeights(tensors, readRange,
		Float32Array.from(extra.token_type_row0), encoder.weightView());
	encoder.init();
	const words = new SSLealla.WordEmbeddings(tensors['embeddings.word_embeddings.weight'], readRange);
	model = new SSLealla.LeallaModel(tokenizer, words, encoder);
	dim = SSLealla.HIDDEN;
}

async function initXlmr({ modelPath, vocabPath, wasmURL, queryPrefix, passagePrefix, chunkPieces }) {
	const readRange = readRangeFactory(modelPath);
	const [tokData, wasmBytes] = await Promise.all([
		IOUtils.readJSON(vocabPath),
		fetch(wasmURL).then((r) => r.arrayBuffer()),
	]);
	const { instance } = await WebAssembly.instantiate(wasmBytes, {});
	model = await SSXlmr.loadModel(instance, tokData, readRange, { queryPrefix, passagePrefix });
	dim = model.dim;
	chunkOpts = { maxPieces: chunkPieces };
}

function init(msg) {
	return msg.runtime === 'xlmr' ? initXlmr(msg) : initLealla(msg);
}

/** Embed passages (or, for LEALLA, any text: it has no query/passage distinction) */
async function embedTexts(texts, kind = 'passage') {
	const out = new Float32Array(texts.length * dim);
	for (let i = 0; i < texts.length; i++) {
		out.set(await model.embed(texts[i], kind), i * dim);
	}
	return out;
}

/** Number of pieces of a text, without special tokens */
function countPieces(text) {
	return model.tokenizer.encode(text, 100000).length - 2;
}

/**
 * Queries longer than one passage are split into sentence-aligned segments;
 * shorter ones are embedded verbatim (for LEALLA exactly like the original app).
 */
async function embedQuery(text) {
	const max = chunkOpts.maxPieces || 126;
	let segments = [text];
	if (countPieces(text) > max) {
		// Keep the verbatim (truncated) query first: results are then a superset of
		// what the original app returned, plus matches for the rest of the text
		segments = segments.concat(SSChunker.chunkPages([text], model.tokenizer, chunkOpts).map(c => c.text));
	}
	const vectors = await embedTexts(segments, 'query');
	return { vectors, segments };
}

async function processDocument(id, pages) {
	const chunks = SSChunker.chunkPages(pages, model.tokenizer, chunkOpts);
	const vectors = new Float32Array(chunks.length * dim);
	let lastReport = 0;
	for (let i = 0; i < chunks.length; i++) {
		if (cancelled.has(id)) {
			cancelled.delete(id);
			throw new Error('cancelled');
		}
		vectors.set(await model.embed(chunks[i].text, 'passage'), i * dim);
		const now = Date.now();
		if (now - lastReport > 500) {
			lastReport = now;
			postMessage({ type: 'progress', id, done: i + 1, total: chunks.length });
		}
	}
	return { chunks, vectors };
}

self.onmessage = async (event) => {
	const msg = event.data;
	try {
		switch (msg.type) {
			case 'init':
				await init(msg);
				postMessage({ type: 'ready' });
				break;
			case 'embed': {
				const vectors = await embedTexts(msg.texts);
				postMessage({ type: 'result', id: msg.id, vectors }, [vectors.buffer]);
				break;
			}
			case 'query': {
				const { vectors, segments } = await embedQuery(msg.text);
				postMessage({ type: 'result', id: msg.id, vectors, segments }, [vectors.buffer]);
				break;
			}
			case 'document': {
				const { chunks, vectors } = await processDocument(msg.id, msg.pages);
				postMessage({ type: 'result', id: msg.id, chunks, vectors }, [vectors.buffer]);
				break;
			}
			case 'cancel':
				cancelled.add(msg.id);
				break;
		}
	}
	catch (e) {
		postMessage({ type: msg.type === 'init' ? 'init-error' : 'error', id: msg.id, error: String(e && e.message || e) });
	}
};
