#!/usr/bin/env node
// Forge invokes a version-selected symlink to this wrapper. Solc-js has the
// same standard-JSON compiler; it also runs on arm64 for old Solidity releases.
import { basename } from 'node:path';
const name = basename(process.argv[1]);
if (!/^solc-0(817|823|828)$/.test(name)) throw new Error('Choose a pinned solc shim');
const { default: solc } = await import(`./node_modules/${name}/index.js`);
if (process.argv.includes('--version')) {
  console.log(`solc, the solidity compiler commandline interface\nVersion: ${solc.version()}`);
} else {
  if (!process.argv.includes('--standard-json')) throw new Error('Only standard-JSON compilation is supported');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  // Forge supplies every source in JSON; filesystem import callbacks are not used.
  process.stdout.write(solc.compile(Buffer.concat(chunks).toString('utf8')));
}
