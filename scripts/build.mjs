// Packages addon/ into build/zotero-semantic-search-<version>.xpi
// Usage: node scripts/build.mjs [--wasm] [--version X.Y.Z]
//   --wasm     rebuild lealla.wasm with cargo first
//   --version  build with this version instead of the one in addon/manifest.json
//              (used by the release workflow, which takes it from the git tag)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const addon = join(root, 'addon');
const arg = (name) => {
	const i = process.argv.indexOf(name);
	return i === -1 ? null : process.argv[i + 1];
};

if (process.argv.includes('--wasm')) {
	execFileSync('cargo', ['build', '--release'], { cwd: join(root, 'wasm'), stdio: 'inherit' });
	copyFileSync(join(root, 'wasm/target/wasm32-unknown-unknown/release/lealla_wasm.wasm'),
		join(addon, 'content/lealla.wasm'));
}
if (!existsSync(join(addon, 'content/lealla.wasm'))) {
	console.error('addon/content/lealla.wasm missing: run `node scripts/build.mjs --wasm`');
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(addon, 'manifest.json'), 'utf8'));
const version = arg('--version') || manifest.version;
if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(version)) {
	console.error(`Invalid version: ${version}`);
	process.exit(1);
}

// Stage a copy so the version can be set without touching the sources
const build = join(root, 'build');
const stage = join(build, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
cpSync(addon, stage, { recursive: true, filter: src => !/(^|\/)\.[^/]+$/.test(src) && !src.endsWith('/content/dev.js') });
manifest.version = version;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const out = join(build, `zotero-semantic-search-${version}.xpi`);
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, '.'], { cwd: stage, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
console.log(out);
