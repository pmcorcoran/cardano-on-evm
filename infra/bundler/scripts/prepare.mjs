import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { patchedText } from '../src/patches.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(await readFile(resolve(root, 'upstream.json'), 'utf8'));
const source = process.argv.find((value) => value.startsWith('--source='))?.slice(9);
const installed = resolve(root, 'node_modules/@pimlico/alto');
const pkg = JSON.parse(await readFile(resolve(source ?? installed, source ? 'src/package.json' : 'package.json'), 'utf8'));
if (pkg.name !== pin.package || pkg.version !== pin.version) throw new Error('Alto package version differs from the source pin');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const changes = [];
for (const patch of pin.patches) {
  const file = resolve(source ?? installed, source ? patch.sourcePath : patch.installedPath);
  const content = await readFile(file, 'utf8');
  const { original, changed } = patchedText(content, patch, Boolean(source));
  if (content !== changed) await writeFile(file, changed);
  changes.push({ name: patch.name, file: source ? patch.sourcePath : patch.installedPath, beforeSha256: sha(original), afterSha256: sha(changed) });
}
await mkdir(resolve(root, '.local'), { recursive: true });
const evidence = JSON.stringify({ version: pin.version, commit: pin.commit, source: Boolean(source),
  runtimeLockSha256: sha(await readFile(resolve(root, 'package-lock.json'))),
  patchDefinitionSha256: sha(await readFile(resolve(root, 'upstream.json'))), changes }, null, 2) + '\n';
await writeFile(resolve(root, `.local/patch-evidence-${source ? 'source' : 'package'}.json`), evidence);
await writeFile(resolve(root, '.local/patch-evidence.json'), evidence);
console.log(JSON.stringify({ status: 'pinned-worker-patched', version: pin.version, patches: changes.map((change) => change.name) }));
