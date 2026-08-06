/**
 * Merge per-architecture macOS update manifests into one `latest-mac.yml`.
 *
 * When arm64 and x64 are built in separate CI jobs, each emits its own
 * `latest-mac.yml`. Publishing them independently makes the second overwrite
 * the first, so electron-updater only sees one architecture. This unions the
 * `files` arrays into a single manifest that lists both — electron-updater then
 * picks the entry whose URL matches the running arch.
 *
 * Usage: node scripts/merge-mac-latest-yml.mjs <out.yml> <in1.yml> <in2.yml> ...
 */
import fs from 'node:fs';
import yaml from 'js-yaml';

const [, , out, ...inputs] = process.argv;
if (!out || inputs.length < 1) {
  console.error('usage: merge-mac-latest-yml.mjs <out> <in...>');
  process.exit(1);
}

const docs = inputs
  .filter((p) => fs.existsSync(p))
  .map((p) => yaml.load(fs.readFileSync(p, 'utf8')));

if (!docs.length) { console.error('no input manifests found'); process.exit(1); }

const seen = new Set();
const files = [];
for (const d of docs) {
  for (const f of d.files || []) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    files.push(f);
  }
}

// Base off the first doc; replace files with the union and use the newest date.
const merged = { ...docs[0], files };
const dates = docs
  .map((d) => d.releaseDate)
  .filter(Boolean)
  .map((x) => (x instanceof Date ? x.toISOString() : String(x)))
  .sort();
if (dates.length) merged.releaseDate = dates[dates.length - 1];

fs.writeFileSync(out, yaml.dump(merged, { lineWidth: -1 }));
console.log(`merged ${docs.length} manifest(s) -> ${out} (${files.length} file entries)`);
