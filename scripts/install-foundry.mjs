import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const version = '1.8.1';
const pins = { arm64: '27a32bd282d73018ab4d043de15ab0320b561c71b4bf3a549b130a0806e79f5c', x64: '37b45855232e57624d90113b049ca54f0c92055bb5c1997fcbdc3076c7b89c10' };
if (process.platform !== 'linux' || !pins[process.arch]) throw new Error('This installer supports Linux arm64/x64; install the pinned upstream release manually on other platforms');
const directory = resolve('.local/tools/foundry'), archive = resolve(directory, 'foundry.tar.gz');
await mkdir(directory, { recursive: true });
const name = `foundry_v${version}_linux_${process.arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`;
const url = `https://github.com/foundry-rs/foundry/releases/download/v${version}/${name}`;
const provided = process.argv.find((arg) => arg.startsWith('--archive='))?.slice(10);
let bytes;
if (provided) bytes = await readFile(provided);
else {
  try { bytes = await readFile(archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Pinned Foundry download failed');
    bytes = Buffer.from(await response.arrayBuffer());
  }
}
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (sha256 !== pins[process.arch]) throw new Error('Foundry archive checksum mismatch');
await writeFile(archive, bytes);
execFileSync('tar', ['-xzf', archive, '-C', directory, 'anvil', 'forge', 'cast'], { stdio: 'inherit' });
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ version, url, sha256, architecture: process.arch }, null, 2) + '\n');
console.log(JSON.stringify({ version, directory, sha256 }));
