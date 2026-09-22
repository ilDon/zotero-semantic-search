/*
 * Streams a URL to disk with progress, then verifies size and SHA-256.
 *   {url, path, size, sha256} -> {type:'progress', received, total} ... {type:'done'} | {type:'error'}
 */
/* global IOUtils */
self.onmessage = async (event) => {
	const { url, path, size, sha256 } = event.data;
	const partPath = path + '.part';
	try {
		const resp = await fetch(url);
		if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
		const total = Number(resp.headers.get('Content-Length')) || size || 0;
		await IOUtils.write(partPath, new Uint8Array(0));
		const reader = resp.body.getReader();
		let received = 0;
		let pending = [];
		let pendingBytes = 0;
		let lastReport = 0;
		const flush = async () => {
			if (!pendingBytes) return;
			const buf = new Uint8Array(pendingBytes);
			let o = 0;
			for (const p of pending) {
				buf.set(p, o);
				o += p.length;
			}
			pending = [];
			pendingBytes = 0;
			await IOUtils.write(partPath, buf, { mode: 'append' });
		};
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			pending.push(value);
			pendingBytes += value.length;
			received += value.length;
			if (pendingBytes > 8 * 1024 * 1024) await flush();
			const now = Date.now();
			if (now - lastReport > 300) {
				lastReport = now;
				postMessage({ type: 'progress', received, total });
			}
		}
		await flush();
		if (size && received !== size) throw new Error(`Size mismatch: got ${received}, expected ${size}`);
		if (sha256) {
			postMessage({ type: 'verifying' });
			const digest = await IOUtils.computeHexDigest(partPath, 'sha256');
			if (digest.toLowerCase() !== sha256.toLowerCase()) throw new Error('Checksum mismatch');
		}
		await IOUtils.move(partPath, path);
		postMessage({ type: 'done', received });
	}
	catch (e) {
		try {
			await IOUtils.remove(partPath, { ignoreAbsent: true });
		}
		catch (_) {}
		postMessage({ type: 'error', error: String(e && e.message || e) });
	}
};
