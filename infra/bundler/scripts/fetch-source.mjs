import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(await readFile(resolve(root, 'upstream.json'), 'utf8'));
const cache = resolve(root, '.local');
await mkdir(cache, { recursive: true });
const archive = resolve(cache, 'alto-source.tar.gz');
const provided = process.argv.find((arg) => arg.startsWith('--archive='))?.slice(10);
const bytes = provided ? await readFile(provided) : Buffer.from(await (async () => {
  const response = await fetch(pin.sourceArchive, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error('Pinned Alto source download failed');
  return response.arrayBuffer();
})());
if (createHash('sha256').update(bytes).digest('hex') !== pin.sourceArchiveSha256) throw new Error('Pinned source archive checksum mismatch');
await writeFile(archive, bytes);
execFileSync('tar', ['-xzf', archive, '-C', cache], { stdio: 'pipe' });
const source = resolve(cache, `alto-${pin.commit}`);
for (const item of pin.submodules) {
  if (!item.sourceArchive || !/^[0-9a-f]{64}$/.test(item.sourceArchiveSha256)) throw new Error('Missing pinned submodule archive');
  const subArchive = resolve(cache, `${item.path.split('/').at(-1)}-${item.sha}.tar.gz`);
  let subBytes;
  try { subBytes = await readFile(subArchive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(item.sourceArchive, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Submodule source download failed: ${item.path}`);
    subBytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(subBytes).digest('hex') !== item.sourceArchiveSha256) throw new Error(`Submodule checksum mismatch: ${item.path}`);
  await writeFile(subArchive, subBytes);
  const destination = resolve(source, item.path);
  await mkdir(destination, { recursive: true });
  execFileSync('tar', ['-xzf', subArchive, '-C', destination, '--strip-components=1'], { stdio: 'pipe' });
}
execFileSync(process.execPath, [resolve(root, 'scripts/prepare.mjs'), `--source=${source}`], { stdio: 'inherit' });
console.log(JSON.stringify({ status: 'preferred-source-ready', source, commit: pin.commit, submodulePins: pin.submodules.length }));
