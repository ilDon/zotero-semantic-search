// Writes the Zotero update manifest (updates.json) for one released XPI.
// Usage: node scripts/updates-json.mjs <xpi> <version> <download-url> <out.json>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [xpi, version, url, out] = process.argv.slice(2);
if (!xpi || !version || !url || !out) {
	console.error('Usage: node scripts/updates-json.mjs <xpi> <version> <download-url> <out.json>');
	process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'addon', 'manifest.json'), 'utf8'));
const app = manifest.applications.zotero;
const hash = createHash('sha512').update(readFileSync(xpi)).digest('hex');

const updates = {
	addons: {
		[app.id]: {
			updates: [
				{
					version,
					update_link: url,
					update_hash: `sha512:${hash}`,
					applications: {
						zotero: {
							strict_min_version: app.strict_min_version,
							...(app.strict_max_version ? { strict_max_version: app.strict_max_version } : {}),
						},
					},
				},
			],
		},
	},
};
writeFileSync(out, JSON.stringify(updates, null, 2) + '\n');
console.log(out);
