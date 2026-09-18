import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const sources = JSON.parse(readFileSync('vendor/sources.json', 'utf8')) as { name: string; files: Record<string, string> }[];
let count = 0;
for (const source of sources) for (const [file, expected] of Object.entries(source.files)) {
  const path = `vendor/${source.name}/${file}`;
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected, path); count++;
}
console.log(`Verified ${count} pinned upstream files in ${sources.length} source packages`);
