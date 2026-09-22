// Packages addon/ into build/zotero-semantic-search-<version>.xpi
// Usage: node scripts/build.mjs [--wasm]   (--wasm rebuilds lealla.wasm with cargo first)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const addon = join(root, 'addon');
const manifest = JSON.parse(readFileSync(join(addon, 'manifest.json'), 'utf8'));

if (process.argv.includes('--wasm')) {
	execFileSync('cargo', ['build', '--release'], { cwd: join(root, 'wasm'), stdio: 'inherit' });
	copyFileSync(join(root, 'wasm/target/wasm32-unknown-unknown/release/lealla_wasm.wasm'),
		join(addon, 'content/lealla.wasm'));
}
if (!existsSync(join(addon, 'content/lealla.wasm'))) {
	console.error('addon/content/lealla.wasm missing: run `node scripts/build.mjs --wasm`');
	process.exit(1);
}

mkdirSync(join(root, 'build'), { recursive: true });
const out = join(root, 'build', `zotero-semantic-search-${manifest.version}.xpi`);
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', '.*', '-x', '*/.*'], { cwd: addon, stdio: 'inherit' });
console.log('Built', out);
