// Capture notices from the exact installed, separately locked dependency trees.
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const output = 'licenses/npm'; await mkdir(output, { recursive: true });
const supplemental = JSON.parse(await readFile('licenses/supplemental.json', 'utf8'));
const inventory = { kind: 'locked-dependency-license-inventory', packages: [], locks: {}, notes: [
  'Original package license declarations are preserved; source-file SPDX and supplied license texts control where metadata differs.',
  'Platform-specific optional packages not installed on this host remain pinned by integrity; npm supplies their package notices on the target platform.',
  'Alto and EntryPoint corresponding source/build inputs are supplied separately; this notice inventory does not relicense their code.',
] };
for (const root of ['.', 'infra/bundler', 'infra/bundler/build-tools']) {
  const lockPath = `${root}/package-lock.json`, bytes = await readFile(lockPath), lock = JSON.parse(bytes);
  inventory.locks[lockPath] = sha(bytes);
  for (const [path, record] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/') || record.link) continue;
    const directory = resolve(root, path), name = path.split('node_modules/').at(-1);
    const item = { tree: root, path, name, version: record.version, integrity: record.integrity, declaredLicense: record.license ?? null, notices: [] };
    try {
      const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
      if (pkg.name !== name) item.resolvedName = pkg.name; // Preserve npm alias provenance.
      item.declaredLicense ??= pkg.license ?? pkg.licenses ?? null;
      item.repository = pkg.repository ?? null;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!/^(licen[sc]e|copying|notice)([._-]|$)/i.test(entry.name) || !entry.isFile()) continue;
        const source = resolve(directory, entry.name); assertSmall((await stat(source)).size);
        const text = await readFile(source), digest = sha(text), file = `${output}/${digest}.txt`;
        await writeFile(file, text);
        item.notices.push({ original: relative(directory, source), sha256: digest, file });
      }
      item.installed = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; item.installed = false; }
    if (!item.notices.length) {
      const extra = supplemental.find((entry) => entry.version === item.version && (entry.name === name || entry.name.endsWith('/*') && name.startsWith(entry.name.slice(0, -1))));
      if (extra) {
        if (sha(await readFile(extra.file)) !== extra.sha256) throw new Error('Supplemental notice digest changed');
        item.notices.push(extra);
      }
    }
    inventory.packages.push(item);
  }
}
function assertSmall(size) { if (size > 2 * 1024 * 1024) throw new Error('Unexpected notice size'); }
inventory.packages.sort((a, b) => `${a.tree}/${a.path}`.localeCompare(`${b.tree}/${b.path}`));
await writeFile('licenses/dependencies.json', JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ packages: inventory.packages.length, installedWithoutNotice: inventory.packages.filter((p) => p.installed && !p.notices.length).map(({ tree, name, version, declaredLicense }) => ({ tree, name, version, declaredLicense })) }, null, 2));
if (inventory.packages.some((p) => p.installed && !p.notices.length)) throw new Error('Installed dependency lacks a recorded license notice');
