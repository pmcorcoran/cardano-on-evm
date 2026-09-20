import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkConsumer, consumerTypeScriptVersion, nodeTypeVersions, parseArgs, readArchives, runtimeNodeArgs } from '../../scripts/check-package-install.mjs';

test('consumer matrix checks the runtime floor, previous types, and exact development types', () => {
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(consumerTypeScriptVersion, root.devDependencies.typescript);
  assert.deepEqual(nodeTypeVersions, ['22.18.0', '24.3.1', root.devDependencies['@types/node']]);
  assert.equal(new Set(nodeTypeVersions).size, nodeTypeVersions.length);
});

function fixture() {
  const stage = mkdtempSync(join(tmpdir(), 'cardano-consumer-archive-test-'));
  const packs = join(stage, 'archives'); mkdirSync(packs);
  for (const name of ['wallet', 'protocol', 'enrollment', 'sdk', 'submission', 'contracts']) {
    const directory = join(stage, name, 'package'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@cardano-on-evm/' + name, version: '2.3.4', dependencies: name === 'wallet' ? {} : { '@cardano-on-evm/wallet': '2.3.4' } }));
    execFileSync('tar', ['-czf', join(packs, `cardano-on-evm-${name}-2.3.4.tgz`), '-C', join(stage, name), 'package']);
  }
  return { stage, packs };
}

test('prebuilt archive interface reads exactly six coordinated tarballs without npm pack', async () => {
  const { packs } = fixture();
  const archives = await readArchives(packs);
  assert.equal(archives.length, 6);
  assert.ok(archives.every((item) => item.version === '2.3.4' && /^[a-f0-9]{64}$/.test(item.sha256) && item.integrity.startsWith('sha512-')));
  assert.equal(parseArgs(['--archives', packs, '--out', '/tmp/consumer-output']).archives, packs);
  assert.throws(() => parseArgs(['--archives']), /Missing value/);
  assert.throws(() => parseArgs(['--repack']), /Unknown argument/);
});

test('consumer rejects incomplete or additional archives and altered sibling versions', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'cardano-consumer-empty-'));
  await assert.rejects(readArchives(empty), /exactly six/);
  const { stage, packs } = fixture();
  const wallet = join(stage, 'wallet/package/package.json');
  const metadata = JSON.parse(readFileSync(wallet, 'utf8')); metadata.version = '9.8.7';
  writeFileSync(wallet, JSON.stringify(metadata));
  execFileSync('tar', ['-czf', join(packs, 'cardano-on-evm-wallet-2.3.4.tgz'), '-C', join(stage, 'wallet'), 'package']);
  await assert.rejects(readArchives(packs), /cardano-on-evm-wallet-9.8.7/);
  writeFileSync(join(packs, 'unreviewed.tgz'), 'not an archive');
  await assert.rejects(readArchives(packs), /exactly six/);
});

test('consumer rejects an Alto npm alias before any installation', async () => {
  const { stage, packs } = fixture();
  const file = join(stage, 'sdk/package/package.json');
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  meta.dependencies['innocent-alias'] = 'npm:@pimlico/alto@0.0.21';
  writeFileSync(file, JSON.stringify(meta));
  execFileSync('tar', ['-czf', join(packs, 'cardano-on-evm-sdk-2.3.4.tgz'), '-C', join(stage, 'sdk'), 'package']);
  await assert.rejects(readArchives(packs), /Alto dependencies and aliases/);
});

test('consumer refuses symlink archives and preserves existing reports', async () => {
  const { stage, packs } = fixture();
  const archive = join(packs, 'cardano-on-evm-wallet-2.3.4.tgz');
  const target = join(stage, 'original.tgz');
  renameSync(archive, target); symlinkSync(target, archive);
  await assert.rejects(readArchives(packs), (error) => error.code === 'ELOOP');
  const out = join(stage, 'consumer'); mkdirSync(out);
  const report = join(out, 'package-install.json');
  writeFileSync(report, 'existing evidence');
  await assert.rejects(checkConsumer({ out, archives: packs }), /Consumer report exists/);
  assert.equal(readFileSync(report, 'utf8'), 'existing evidence');
});

test('optional consumer runtime guard is loaded explicitly and denies public RPC', () => {
  const guard = resolve('scripts/ci/local-network-guard.mjs');
  const options = parseArgs(['--network-guard', guard]);
  assert.equal(options.networkGuard, guard);
  const output = execFileSync(process.execPath, runtimeNodeArgs(options, ['--input-type=module', '-e',
    "import assert from 'node:assert/strict'; await assert.rejects(fetch('https://sepolia.base.org'), error=>error.cause?.code==='LOCAL_NETWORK_DENIED'); console.log('public RPC unavailable');"]),
  { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, timeout: 10000 });
  assert.match(output, /public RPC unavailable/);
  assert.deepEqual(runtimeNodeArgs({}, ['consumer.mjs']), ['consumer.mjs']);
});
