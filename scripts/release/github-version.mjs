import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions, versionSignal } from './version.mjs';
import { api, gh, REPOSITORY, SHA } from './github.mjs';

export function versionPath(path) {
  return ['package.json', 'package-lock.json', 'versions.json'].includes(path)
    || /^packages\/(wallet|protocol|enrollment|sdk|submission|contracts)\/(package.json|CHANGELOG.md)$/.test(path)
    || /^\.changeset\/[A-Za-z0-9_-]+\.md$/.test(path);
}

export function main(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.match(env.GITHUB_REPOSITORY ?? '', REPOSITORY); assert.match(env.GITHUB_SHA ?? '', SHA);
  assert.match(env.VERSION_APP_SLUG ?? '', /^[a-z0-9-]+$/);
  assert.ok(env.GH_TOKEN, 'Repository-scoped App token is required');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const gitAuthenticated = (...args) => git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args);
  assert.equal(git('rev-parse', 'HEAD'), env.GITHUB_SHA);
  const version = checkVersions(process.cwd()).version;
  const changed = execFileSync('git', ['status', '--porcelain=v1', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  if (!changed.length) { console.log('No pending coordinated version change.'); return; }
  assert.equal(versionSignal(process.cwd(), env.GITHUB_SHA).changed, true, 'Version metadata must increase before a version PR is opened');
  const paths = changed.map((entry) => {
    assert.ok(!entry.slice(0, 2).includes('R'), 'Version automation does not rename arbitrary files');
    const path = entry.slice(3); assert.ok(versionPath(path), 'Unexpected versioning change: ' + path); return path;
  });
  const branch = `release/version-${version}`, repository = env.GITHUB_REPOSITORY;
  const head = encodeURIComponent(`${repository.split('/')[0]}:${branch}`);
  const open = api(`repos/${repository}/pulls?state=open&base=main&head=${head}`);
  if (open.length) {
    assert.equal(open.length, 1);
    assert.equal(open[0].user.login, `${env.VERSION_APP_SLUG}[bot]`, 'Existing version branch is not owned by the configured App');
    assert.equal(open[0].head.repo.full_name, repository); assert.equal(open[0].head.ref, branch); assert.equal(open[0].base.ref, 'main');
    console.log(`Version PR already awaits normal review: ${open[0].html_url}`); return;
  }
  const actor = api(`users/${env.VERSION_APP_SLUG}[bot]`);
  assert.ok(Number.isSafeInteger(actor.id) && actor.id > 0);
  git('config', 'user.name', `${env.VERSION_APP_SLUG}[bot]`);
  git('config', 'user.email', `${actor.id}+${env.VERSION_APP_SLUG}[bot]@users.noreply.github.com`);
  git('checkout', '-b', branch);
  git('add', '--', ...paths);
  git('commit', '-m', `Version Cardano on EVM ${version}`);
  const prior = api(`repos/${repository}/git/ref/heads/${branch}`, { optional: true });
  if (prior) {
    // Recover an interrupted push only when its complete tree is the exact prepared tree.
    gitAuthenticated('fetch', 'origin', `refs/heads/${branch}`);
    assert.equal(git('rev-parse', 'FETCH_HEAD^{tree}'), git('rev-parse', 'HEAD^{tree}'), 'Existing version branch conflicts; inspect it without force-pushing');
  } else {
    // gh's credential helper consumes GH_TOKEN from the environment, not process arguments.
    gitAuthenticated('push', 'origin', `HEAD:refs/heads/${branch}`);
  }
  mkdirSync('.local/version', { recursive: true });
  const body = '.local/version/pr-body.md';
  writeFileSync(body, `Prepare the coordinated Cardano on EVM ${version} release. Changesets updates the six library versions, internal dependencies and changelogs; root release metadata and lockfiles stay synchronized.\n\nThis App-created PR requires normal source checks and maintainer review. Merging a version change starts the immutable release candidate workflow. Publication remains separately gated by the repository bootstrap setting and github-release environment approval.\n`);
  gh(['pr', 'create', '--repo', repository, '--base', 'main', '--head', branch, '--title', `Version Cardano on EVM ${version}`, '--body-file', body]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error('Version PR stopped: ' + error.message); process.exitCode = 1; }
}
