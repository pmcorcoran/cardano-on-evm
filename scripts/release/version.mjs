import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const names = ['wallet', 'protocol', 'enrollment', 'sdk', 'submission', 'contracts'];
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function packageVersions(root) {
  const packages = names.map((name) => ({ path: `packages/${name}`, ...json(resolve(root, `packages/${name}/package.json`)) }));
  const version = packages[0].version;
  assert.match(version, semver, 'Release versions must be stable semantic versions');
  for (const [index, meta] of packages.entries()) {
    assert.equal(meta.name, `@cardano-on-evm/${names[index]}`);
    assert.equal(meta.version, version, `Version differs for ${meta.name}`);
    for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, wanted] of Object.entries(meta[kind] ?? {})) {
        if (name.startsWith('@cardano-on-evm/')) {
          assert.ok(names.includes(name.split('/')[1]), `Unknown sibling ${name}`);
          assert.equal(wanted, version, `${meta.name} must use the exact coordinated ${name} version`);
        }
      }
    }
  }
  return { version, packages };
}

export function checkVersions(root) {
  const result = packageVersions(root), meta = json(resolve(root, 'versions.json'));
  assert.equal(json(resolve(root, 'package.json')).version, result.version, 'Root version differs');
  assert.equal(meta.packageVersion, result.version, 'versions.json packageVersion differs');
  assert.equal(meta.releasePackages.version, result.version, 'Release metadata version differs');
  assert.deepEqual([...meta.releasePackages.libraries].sort(), [...names].sort(), 'Release metadata must list all six libraries');
  const lock = json(resolve(root, 'package-lock.json'));
  assert.equal(lock.version, result.version, 'Lockfile root version differs');
  assert.equal(lock.packages[''].version, result.version);
  for (const pkg of result.packages) {
    const locked = lock.packages[pkg.path];
    assert.equal(locked.version, result.version, `Lockfile version differs: ${pkg.name}`);
    assert.deepEqual(locked.dependencies ?? {}, pkg.dependencies ?? {}, `Lockfile sibling dependencies differ: ${pkg.name}`);
  }
  return result;
}

export function syncMetadata(root) {
  const { version } = packageVersions(root);
  const pkg = json(resolve(root, 'package.json')), meta = json(resolve(root, 'versions.json'));
  pkg.version = version;
  meta.packageVersion = version;
  meta.releasePackages.version = version;
  meta.releasePackages.libraries = names;
  // Historical network/deployment metadata stays intact; it is not a release gate.
  write(resolve(root, 'package.json'), pkg);
  write(resolve(root, 'versions.json'), meta);
  return version;
}

export function versionSignal(root, base) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git('rev-parse', '--verify', 'HEAD');
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  const version = checkVersions(root).version;
  if (!base) base = git('rev-parse', '--verify', 'HEAD^');
  assert.match(base, /^[a-f0-9]{40,64}$/, '--base must be an immutable commit');
  const previousVersion = JSON.parse(git('show', `${base}:package.json`)).version;
  assert.match(previousVersion, semver);
  const compare = version.split('.').map(Number), previous = previousVersion.split('.').map(Number);
  const differing = compare.findIndex((part, index) => part !== previous[index]);
  assert.ok(differing < 0 || compare[differing] > previous[differing], 'Version must increase');
  return { changed: version !== previousVersion, version, previousVersion, commit };
}

export function main(args = process.argv.slice(2)) {
  const command = args.shift();
  let root = process.cwd(), base;
  while (args.length) {
    const option = args.shift(), value = args.shift();
    assert.ok(value, `Missing value for ${option}`);
    if (option === '--root') root = resolve(value);
    else if (option === '--base') base = value;
    else throw new Error(`Unknown argument ${option}`);
  }
  let result;
  if (command === 'check') result = { version: checkVersions(root).version, coordinated: true };
  else if (command === 'apply') {
    const oldVersion = checkVersions(root).version;
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/@changesets/cli/bin.js');
    execFileSync(process.execPath, [cli, 'version'], { cwd: root, stdio: 'inherit' });
    const version = syncMetadata(root);
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
    checkVersions(root);
    result = { version, previousVersion: oldVersion, changed: oldVersion !== version };
  } else if (command === 'signal') result = versionSignal(root, base);
  else throw new Error('Usage: version.mjs check|apply|signal [--root DIR] [--base COMMIT]');
  if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
