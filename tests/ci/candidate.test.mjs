import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolveNew, verifyPayload } from '../../scripts/release/candidate.mjs';
import { versionPath } from '../../scripts/release/github-version.mjs';

const repository = 'fixture/cardano-on-evm';
const makeRepo = (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'kernel-release-resolution-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['package.json', 'package-lock.json', 'versions.json', ...['wallet', 'protocol', 'enrollment', 'sdk', 'submission', 'contracts'].map(name => `packages/${name}/package.json`)]) {
    mkdirSync(resolve(root, file, '..'), { recursive: true }); cpSync(file, resolve(root, file));
  }
  writeFileSync(resolve(root, '.gitignore'), '.local/\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Controlled Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const commit = (text) => { git('add', '.'); git('commit', '-m', text); return git('rev-parse', 'HEAD'); };
  const before = commit('initial fixture');
  const previousVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const alternateVersion = `${Number(previousVersion.split('.')[0]) + 1}.0.0`;
  const bump = (commitChanges = true) => {
    const walk = (object) => {
      for (const [key, value] of Object.entries(object)) {
        if (value && typeof value === 'object') walk(value);
        else if ((key === 'version' || key === 'packageVersion' || key.startsWith('@cardano-on-evm/')) && value === previousVersion) object[key] = alternateVersion;
      }
    };
    for (const file of ['package.json', 'package-lock.json', 'versions.json', ...['wallet', 'protocol', 'enrollment', 'sdk', 'submission', 'contracts'].map(name => `packages/${name}/package.json`)]) {
      const data = JSON.parse(readFileSync(resolve(root, file), 'utf8')); walk(data); writeFileSync(resolve(root, file), JSON.stringify(data));
    }
    return commitChanges ? commit('fixture version bump') : undefined;
  };
  const env = (sha, extra = {}) => ({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha,
    GITHUB_WORKFLOW_SHA: sha, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@refs/heads/main`,
    GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'push', ...extra });
  const event = (sha, base = before) => ({ ref: 'refs/heads/main', before: base, after: sha, deleted: false });
  return { root, git, commit, before, bump, env, event, alternateVersion };
};

test('push version detection compares the complete immutable before..after range', (t) => {
  const f = makeRepo(t); f.bump(); writeFileSync(resolve(f.root, 'following.md'), 'unrelated subsequent commit');
  const after = f.commit('following commit');
  const result = resolveNew(f.root, f.env(after), f.event(after));
  assert.equal(result.build, true); assert.equal(result.publish, false); assert.equal(result.commit, after); assert.equal(result.version, f.alternateVersion);
});
test('push without a version change does not build a candidate', (t) => {
  const f = makeRepo(t); writeFileSync(resolve(f.root, 'following.md'), 'unchanged version'); const after = f.commit('same version');
  assert.equal(resolveNew(f.root, f.env(after), f.event(after)).build, false);
});
test('repository import requires explicit first-candidate dispatch', (t) => {
  const f = makeRepo(t);
  assert.equal(resolveNew(f.root, f.env(f.before), f.event(f.before, '0'.repeat(40))).build, false);
  const manual = resolveNew(f.root, f.env(f.before, { GITHUB_EVENT_NAME: 'workflow_dispatch' }), {});
  assert.equal(manual.build, true); assert.equal(manual.mode, 'candidate-only'); assert.equal(manual.publish, false);
});
test('moving main cannot change the captured release commit', (t) => {
  const f = makeRepo(t), version = f.bump(); writeFileSync(resolve(f.root, 'later.md'), 'later main'); const newer = f.commit('main moved');
  f.git('checkout', '--detach', version);
  assert.equal(resolveNew(f.root, f.env(version), f.event(version)).commit, version);
  assert.throws(() => resolveNew(f.root, f.env(newer), f.event(newer)), /Checkout moved/);
});
test('candidate event/ref, before ancestry, checkout and workflow provenance mismatches fail closed', (t) => {
  const f = makeRepo(t), sha = f.bump();
  for (const extra of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_WORKFLOW_SHA: 'f'.repeat(40) }, { GITHUB_ACTIONS: 'false' }]) {
    assert.throws(() => resolveNew(f.root, f.env(sha, extra), f.event(sha)));
  }
  assert.throws(() => resolveNew(f.root, f.env(sha), f.event(sha, 'f'.repeat(40))));
  assert.throws(() => resolveNew(f.root, f.env(sha), { ...f.event(sha), after: f.before }));
  assert.throws(() => resolveNew(f.root, f.env(sha), { ...f.event(sha), deleted: true }));
});
test('only literal publication enablement promotes changed main versions; recovery never rebuilds', (t) => {
  const f = makeRepo(t), sha = f.bump();
  for (const value of [undefined, '', 'false', 'TRUE', '1']) assert.equal(resolveNew(f.root, f.env(sha, { RELEASE_PUBLISH_ENABLED: value }), f.event(sha)).publish, false);
  assert.equal(resolveNew(f.root, f.env(sha, { RELEASE_PUBLISH_ENABLED: 'true' }), f.event(sha)).publish, true);
  const recovery = resolveNew(f.root, f.env(sha, { GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_MODE: 'recover' }), {});
  assert.equal(recovery.build, false); assert.equal(recovery.publish, true);
});
test('every prepublication payload verification requires the packager freshness gate and propagates stale evidence failures', () => {
  let called = false;
  verifyPayload('/fixture/assets', 'a'.repeat(64), (_command, args) => {
    called = true; assert.ok(args.includes('--for-publication'));
    return JSON.stringify({ verified: true, candidateId: 'a'.repeat(64) });
  });
  assert.equal(called, true);
  assert.throws(() => verifyPayload('/fixture/assets', 'a'.repeat(64), () => { throw new Error('Evidence expired'); }), /expired/);
});
test('version App commit path boundary permits release metadata only', () => {
  for (const path of ['package.json', 'package-lock.json', 'versions.json', 'packages/sdk/package.json', 'packages/contracts/CHANGELOG.md', '.changeset/little-green-fox.md']) assert.equal(versionPath(path), true, path);
  for (const path of ['.github/workflows/release.yml', '.changeset/config.json', 'scripts/ci/evidence.py', '.env', 'packages/sdk/index.ts', '../package.json']) assert.equal(versionPath(path), false, path);
});
test('version PR helper commits only prepared coordinated metadata and opens App PR without force pushing', (t) => {
  const f = makeRepo(t); f.bump(false);
  const remoteRoot = mkdtempSync(resolve(tmpdir(), 'kernel-version-app-')); t.after(() => rmSync(remoteRoot, { recursive: true, force: true }));
  const remote = resolve(remoteRoot, 'remote.git'); execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' }); f.git('remote', 'add', 'origin', remote);
  const binary = resolve(remoteRoot, 'bin'); mkdirSync(binary);
  writeFileSync(resolve(binary, 'gh'), `#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
with open(os.environ['GH_FIXTURE_LOG'],'a') as log: log.write(json.dumps(args)+'\\n')
if args[0]=='api':
 path=args[1]
 if '/pulls?' in path: print('[]')
 elif path=='users/fixture-app[bot]': print('{"id": 123}')
 elif '/git/ref/heads/' in path:
  print('gh: Not Found (HTTP 404)',file=sys.stderr);sys.exit(1)
 else: raise AssertionError('Unexpected mock request')
elif args[:2]==['pr','create']: print('https://github.com/fixture/cardano-on-evm/pull/1')
else: raise AssertionError('Unexpected mock command')
`, { mode: 0o755 });
  const log = resolve(remoteRoot, 'commands.jsonl');
  const env = { ...process.env, ...f.env(f.before, { GITHUB_EVENT_NAME: 'workflow_dispatch' }), PATH: binary + ':' + process.env.PATH,
    GH_TOKEN: 'controlled-fixture', VERSION_APP_SLUG: 'fixture-app', GH_FIXTURE_LOG: log };
  execFileSync(process.execPath, [resolve('scripts/release/github-version.mjs')], { cwd: f.root, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(f.git('branch', '--show-current'), `release/version-${f.alternateVersion}`);
  assert.ok(f.git('diff', '--name-only', f.before).split('\n').every(versionPath));
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('ls-remote', 'origin', `refs/heads/release/version-${f.alternateVersion}`).split('\t')[0], f.git('rev-parse', 'HEAD'));
  const commands = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(commands.some(args => args[0] === 'pr' && args[1] === 'create' && args.includes('--body-file')));
  assert.equal(readFileSync(log, 'utf8').includes('controlled-fixture'), false, 'Token must stay out of command arguments');
});
test('workflow wiring separates build, attest and approval privileges and freezes the candidate before approval', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const block = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.match(workflow, /options: \[candidate-only, publish, recover\]\n\s+default: candidate-only/);
  assert.match(block('validate'), /uses: \.\/\.github\/workflows\/check.yml/); assert.match(block('validate'), /candidate: true/);
  assert.match(block('validate'), /ref: \$\{\{ needs.resolve.outputs.commit \}\}/);
  for (const job of ['resolve', 'package', 'review']) assert.doesNotMatch(block(job), /id-token: write|contents: write|secrets\./);
  assert.match(block('attest'), /id-token: write/); assert.match(block('attest'), /attestations: write/);
  assert.doesNotMatch(block('attest'), /contents: write|npm ci|build:contracts/);
  assert.match(block('publish'), /environment:\n\s+name: github-release/);
  assert.match(block('publish'), /needs.review.result == 'success'/);
  assert.match(block('publish'), /contents: write/); assert.doesNotMatch(block('publish'), /id-token: write|npm ci|package-release.py prepare|secrets\./);
  assert.match(block('publish'), /cancel-in-progress: false/);
  assert.match(block('review'), /candidate.mjs consumer .local\/review-candidate/);
  assert.doesNotMatch(workflow, /actions\/cache@|cache: npm|continue-on-error:|pull_request_target:|secrets\./);
  for (const line of workflow.split('\n').filter(line => /uses: actions\//.test(line))) assert.match(line, /@[a-f0-9]{40}(?: |$)/);
  const version = readFileSync('.github/workflows/version.yml', 'utf8');
  assert.match(version, /vars.VERSION_PR_ENABLED == 'true'/); assert.match(version, /secrets.VERSION_APP_PRIVATE_KEY/);
  assert.match(version, /repositories: \$\{\{ github.event.repository.name \}\}/);
  assert.match(version, /permission-contents: write/); assert.match(version, /permission-pull-requests: write/);
  assert.doesNotMatch(version, /pull_request:|pull_request_target:|id-token:|contents: write\n\s+steps:/);
});
