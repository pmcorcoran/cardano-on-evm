import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { names, packageVersions, checkVersions, syncMetadata, versionSignal } from '../../scripts/release/version.mjs';

const root = resolve('.'), helper = resolve('scripts/release/version.mjs');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, object) => writeFileSync(path, JSON.stringify(object, null, 2) + '\n');
function fixture() {
  const stage = mkdtempSync(join(tmpdir(), 'cardano-version-test-'));
  for (const path of ['package.json', 'package-lock.json', 'versions.json', '.changeset/config.json', ...names.map((name) => `packages/${name}/package.json`)]) {
    mkdirSync(resolve(stage, path, '..'), { recursive: true });
    copyFileSync(resolve(root, path), resolve(stage, path));
  }
  symlinkSync(resolve(root, 'node_modules'), resolve(stage, 'node_modules'), 'dir');
  writeFileSync(resolve(stage, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: stage });
  const git = (...args) => execFileSync('git', args, { cwd: stage, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Version fixture', '-c', 'user.email=version@example.invalid', 'commit', '--quiet', '-m', 'Disposable version fixture');
    return git('rev-parse', 'HEAD');
  };
  return { stage, git, commit };
}

test('version checks reject mismatched package, internal dependency, root, and lock metadata', () => {
  const { stage } = fixture();
  assert.equal(checkVersions(stage).packages.length, 6);
  for (const target of ['packages/sdk/package.json', 'package.json', 'package-lock.json']) {
    const path = resolve(stage, target), original = readFileSync(path);
    const value = json(path); value.version = '3.2.1'; write(path, value);
    assert.throws(() => checkVersions(stage), /version differs|Version differs/i);
    writeFileSync(path, original);
  }
  const sdk = json(resolve(stage, 'packages/sdk/package.json'));
  sdk.dependencies['@cardano-on-evm/wallet'] = '^' + sdk.version;
  write(resolve(stage, 'packages/sdk/package.json'), sdk);
  assert.throws(() => packageVersions(stage), /exact coordinated/);
});

test('real Changesets versions all six private packages and changelogs in a disposable commit', { timeout: 120000 }, () => {
  const { stage, commit } = fixture();
  const base = commit(), before = checkVersions(stage).version;
  writeFileSync(resolve(stage, '.changeset/disposable-fixture.md'), '---\n"@cardano-on-evm/wallet": minor\n---\n\nDisposable alternate-version regression fixture.\n');
  execFileSync(process.execPath, [helper, 'apply', '--root', stage], { cwd: stage, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  const result = checkVersions(stage);
  assert.notEqual(result.version, before);
  for (const name of names) assert.match(readFileSync(resolve(stage, `packages/${name}/CHANGELOG.md`), 'utf8'), new RegExp(result.version.replaceAll('.', '\\.')));
  const head = commit(), signal = versionSignal(stage, base);
  assert.deepEqual(signal, { changed: true, version: result.version, previousVersion: before, commit: head });
  assert.equal(versionSignal(stage, head).changed, false);
  assert.equal(checkVersions(root).version, before, 'The real checkout must not be version-bumped by this test');
});

test('root metadata synchronizes another coordinated version while configured upstream network pins stay intact', () => {
  const { stage } = fixture();
  const original = json(resolve(stage, 'versions.json'));
  for (const name of names) {
    const path = resolve(stage, `packages/${name}/package.json`), value = json(path);
    value.version = '9.8.7';
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const dep of Object.keys(value[kind] ?? {})) if (dep.startsWith('@cardano-on-evm/')) value[kind][dep] = '9.8.7';
    write(path, value);
  }
  assert.equal(syncMetadata(stage), '9.8.7');
  const value = json(resolve(stage, 'versions.json'));
  assert.equal(value.packageVersion, '9.8.7');
  assert.equal(value.releasePackages.version, '9.8.7');
  assert.deepEqual(value.baseSepolia, original.baseSepolia);
});
