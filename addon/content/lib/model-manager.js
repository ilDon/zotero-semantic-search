/* global Zotero, IOUtils, PathUtils, ChromeWorker, SSEvents, SSActiveProxy, SSModels */
/* exported SSModelFiles, SSModelManager */

/**
 * Locates and downloads the weights of an embedding model. The files are
 * stored in the Zotero *profile* directory (not the data directory, which is
 * often synced).
 *
 * LEALLA-large: Hugging Face port, pinned revision, ~600 MB, in
 * semantic-search/model (as in earlier versions). Other models: int8 weight
 * files published with the plugin's releases, in semantic-search/models/<id>.
 */
var SSModelFiles = class {
	constructor(spec) {
		this.spec = spec;
		this._download = null; // { promise, progress: {file, received, total}, abort }
		this._lastError = null;
		if (spec.id === 'lealla') {
			this.REPO = 'setu4993/LEALLA-large';
			this.REVISION = '84f26abc31038fe88ef1927f798019e68a80feb0';
			this.FILES = {
				model: {
					name: 'model.safetensors',
					size: 589837568,
					sha256: 'c21233d9f284d55d4f25815efd41a669358b9d0f954706f6568e852a5b212979',
				},
				vocab: {
					name: 'vocab.txt',
					size: 5220781,
					sha256: null,
				},
			};
		}
		else {
			this.FILES = spec.files;
		}
	}

	get baseDir() {
		return PathUtils.join(Zotero.Profile.dir, 'semantic-search');
	}

	get modelDir() {
		if (this.spec.id === 'lealla') {
			let custom = Zotero.Prefs.get('extensions.semantic-search.modelDir', true);
			return custom || PathUtils.join(this.baseDir, 'model');
		}
		return PathUtils.join(this.baseDir, 'models', this.spec.id);
	}

	path(key) {
		return PathUtils.join(this.modelDir, this.FILES[key].name);
	}

	// LEALLA file names, as used by the embedding worker
	get modelPath() {
		return this.path(this.spec.id === 'lealla' ? 'model' : 'weights');
	}

	get vocabPath() {
		return this.path(this.spec.id === 'lealla' ? 'vocab' : 'tokenizer');
	}

	url(file) {
		if (this.spec.id === 'lealla') {
			return `https://huggingface.co/${this.REPO}/resolve/${this.REVISION}/${file}`;
		}
		return this.spec.baseURL + file;
	}

	/** Total download size in bytes */
	get size() {
		return Object.values(this.FILES).reduce((a, f) => a + f.size, 0);
	}

	async isReady() {
		for (let f of Object.values(this.FILES)) {
			let path = PathUtils.join(this.modelDir, f.name);
			try {
				let info = await IOUtils.stat(path);
				if (info.size !== f.size) return false;
			}
			catch (e) {
				return false;
			}
		}
		return true;
	}

	async status() {
		if (this._download) {
			return { state: 'downloading', progress: this._download.progress };
		}
		if (this._lastError) {
			return { state: (await this.isReady()) ? 'ready' : 'error', error: this._lastError };
		}
		return { state: (await this.isReady()) ? 'ready' : 'missing' };
	}

	onChange(fn) {
		return SSEvents.on('model', fn);
	}

	_emit() {
		SSEvents.emit('model');
	}

	/** Download missing/corrupt files. Resolves when the model is ready. */
	ensureDownloaded() {
		if (this._download) return this._download.promise;
		let dl = { progress: { file: null, received: 0, total: 0 } };
		dl.promise = (async () => {
			this._lastError = null;
			await IOUtils.makeDirectory(this.modelDir, { createAncestors: true, ignoreExisting: true });
			// small files first
			let files = Object.values(this.FILES).sort((a, b) => a.size - b.size);
			for (let f of files) {
				let path = PathUtils.join(this.modelDir, f.name);
				let ok = false;
				try {
					ok = (await IOUtils.stat(path)).size === f.size;
				}
				catch (e) {}
				if (ok) continue;
				dl.progress = { file: f.name, received: 0, total: f.size };
				this._emit();
				await this._downloadFile(f, path, dl);
			}
		})();
		this._download = dl;
		this._emit();
		dl.promise
			.catch((e) => {
				this._lastError = String(e.message || e);
				Zotero.logError(e);
			})
			.finally(() => {
				this._download = null;
				this._emit();
			});
		return dl.promise;
	}

	_downloadFile(f, path, dl) {
		return new Promise((resolve, reject) => {
			let worker = new ChromeWorker('chrome://semantic-search/content/workers/download-worker.js');
			dl.abort = () => {
				worker.terminate();
				reject(new Error('Download cancelled'));
			};
			worker.onmessage = (event) => {
				let m = event.data;
				if (m.type === 'progress') {
					dl.progress = { file: f.name, received: m.received, total: m.total || f.size };
					this._emit();
				}
				else if (m.type === 'verifying') {
					dl.progress = { file: f.name, received: f.size, total: f.size, verifying: true };
					this._emit();
				}
				else if (m.type === 'done') {
					worker.terminate();
					resolve();
				}
				else if (m.type === 'error') {
					worker.terminate();
					reject(new Error(`Download of ${f.name} failed: ${m.error}`));
				}
			};
			worker.onerror = (e) => {
				worker.terminate();
				reject(new Error(e.message));
			};
			worker.postMessage({ url: this.url(f.name), path, size: f.size, sha256: f.sha256 });
		});
	}

	cancelDownload() {
		if (this._download && this._download.abort) {
			this._download.abort();
		}
	}
};

/** The active model's files */
var SSModelManager = SSActiveProxy(() => SSModels.active.files, {
	onChange: fn => SSEvents.on('model', fn),
});
