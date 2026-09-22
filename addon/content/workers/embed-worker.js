/*
 * Embedding worker (ChromeWorker). Holds the tokenizer, the WASM encoder and a
 * word-embedding row cache. Messages:
 *   {type:'init', modelPath, vocabPath, wasmURL, extraURL}  -> {type:'ready'}
 *   {type:'embed', id, texts}                                -> {id, vectors}
 *   {type:'document', id, pages}                             -> progress..., {id, chunks, vectors}
 *   {type:'cancel', id}
 */
/* global importScripts, IOUtils, SSTokenizer, SSLealla, SSChunker */
importScripts(
	'chrome://semantic-search/content/lib/tokenizer.js',
	'chrome://semantic-search/content/lib/lealla.js',
	'chrome://semantic-search/content/lib/chunker.js'
);

let model = null;
const cancelled = new Set();

function readRangeFactory(path) {
	return async (offset, length) => IOUtils.read(path, { offset, maxBytes: length });
}

async function init({ modelPath, vocabPath, wasmURL, extraURL }) {
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
}

async function embedTexts(texts) {
	const out = new Float32Array(texts.length * SSLealla.HIDDEN);
	for (let i = 0; i < texts.length; i++) {
		out.set(await model.embed(texts[i]), i * SSLealla.HIDDEN);
	}
	return out;
}

async function processDocument(id, pages) {
	const chunks = SSChunker.chunkPages(pages, model.tokenizer);
	const vectors = new Float32Array(chunks.length * SSLealla.HIDDEN);
	let lastReport = 0;
	for (let i = 0; i < chunks.length; i++) {
		if (cancelled.has(id)) {
			cancelled.delete(id);
			throw new Error('cancelled');
		}
		vectors.set(await model.embed(chunks[i].text), i * SSLealla.HIDDEN);
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
