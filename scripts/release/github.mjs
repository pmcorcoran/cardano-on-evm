import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const hashFile = (file) => sha256(readFileSync(file));
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
export const SHA = /^[0-9a-f]{40}$/;
export const HASH = /^[0-9a-f]{64}$/;
export const ID = /^[1-9][0-9]*$/;
export const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const WORKFLOW = '.github/workflows/release.yml';

// Pass credentials only through the subprocess environment, never arguments/logs.
export function gh(args, { binary = false, input, optional = false } = {}) {
  const result = spawnSync('gh', args, { input, encoding: binary ? undefined : 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '');
    // Missing is distinct from permission, rate-limit, network and server failures.
    if (optional && /\(HTTP 404\)/.test(stderr)) return null;
    throw new Error(`GitHub command failed (${result.status}): ${stderr.slice(0, 2000)}`);
  }
  return result.stdout;
}

export function api(path, { method = 'GET', body, optional = false, paginate = false } = {}) {
  const args = ['api', path, '--method', method, '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (paginate) args.push('--paginate', '--slurp');
  if (body !== undefined) args.push('--input', '-');
  const output = gh(args, { input: body === undefined ? undefined : JSON.stringify(body), optional });
  return output === null ? null : output.trim() ? JSON.parse(output) : null;
}

export function artifactName(run, attempt) {
  assert.match(String(run), ID); assert.match(String(attempt), ID);
  return `release-candidate-${run}-${attempt}`;
}

export function runIdentity(run, repository, runId, attempt, successful = false) {
  assert.equal(String(run.id), String(runId), 'Wrong GitHub run');
  assert.equal(String(run.run_attempt), String(attempt), 'Wrong GitHub run attempt');
  assert.equal(run.repository?.full_name, repository, 'Wrong GitHub repository');
  assert.equal(run.path, WORKFLOW, 'Wrong signer workflow');
  assert.equal(run.head_branch, 'main', 'Candidate run must originate from main');
  assert.ok(['push', 'workflow_dispatch'].includes(run.event), 'Untrusted candidate event');
  assert.match(run.head_sha, SHA);
  assert.equal(run.status, 'completed', 'Prior candidate run is still active');
  if (successful) assert.equal(run.conclusion, 'success', 'Candidate-only rehearsal did not succeed');
  return run;
}

export function findArtifact(rows, name) {
  const matches = rows.filter((row) => row.name === name);
  assert.equal(matches.length, 1, 'Missing/ambiguous candidate artifact');
  const row = matches[0];
  assert.match(String(row.id), ID);
  assert.equal(row.expired, false, 'Candidate artifact expired');
  assert.match(row.digest ?? '', /^sha256:[0-9a-f]{64}$/, 'GitHub artifact digest is unavailable');
  return row;
}

export function downloadArtifact(repository, artifactId, expectedDigest, out, adapter = { api, gh }) {
  assert.match(repository, REPOSITORY); assert.match(String(artifactId), ID);
  assert.match(expectedDigest, /^sha256:[0-9a-f]{64}$/);
  const meta = adapter.api(`repos/${repository}/actions/artifacts/${artifactId}`);
  assert.equal(String(meta.id), String(artifactId));
  assert.equal(meta.expired, false, 'Candidate artifact expired');
  assert.equal(meta.digest, expectedDigest, 'Artifact identity changed');
  const bytes = adapter.gh(['api', `repos/${repository}/actions/artifacts/${artifactId}/zip`], { binary: true });
  assert.equal('sha256:' + sha256(bytes), expectedDigest, 'Downloaded Actions artifact checksum mismatch');
  mkdirSync(out, { recursive: true });
  // Transport bytes must never enter the immutable handoff tree (not even when
  // extracting directly into its assets/ subdirectory before attestation).
  const temporary = mkdtempSync(resolve(tmpdir(), 'cardano-on-evm-artifact-'));
  try {
    const zip = resolve(temporary, 'download.zip');
    writeFileSync(zip, bytes);
    // Refuse path traversal, links and duplicates before extracting even trusted artifacts.
    execFileSync('python3', ['-c', `import pathlib,stat,sys,zipfile
root=pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as archive:
 seen=set()
 for item in archive.infolist():
  path=pathlib.PurePosixPath(item.filename)
  mode=item.external_attr >> 16
  assert not path.is_absolute() and '..' not in path.parts and '\\\\' not in item.filename and item.filename not in seen, 'Unsafe/duplicate artifact entry'
  assert not mode or stat.S_IFMT(mode) in (0,stat.S_IFREG,stat.S_IFDIR), 'Artifact links/special files are forbidden'
  seen.add(item.filename)
  target=root.joinpath(*path.parts)
  if item.is_dir():
   assert not target.is_symlink(), 'Artifact link directory is forbidden'
   target.mkdir(parents=True,exist_ok=True)
  else:
   assert not target.exists(), 'Artifact extraction would overwrite a file'
   target.parent.mkdir(parents=True,exist_ok=True)
   target.write_bytes(archive.read(item))
`, zip, resolve(out)], { stdio: 'pipe' });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return meta;
}

export function attestationArgs(file, receipt, bundle) {
  assert.match(receipt.repository, REPOSITORY); assert.match(receipt.commit, SHA);
  assert.equal(receipt.workflow, `${receipt.repository}/${WORKFLOW}@refs/heads/main`);
  // New candidates require release commit == GITHUB_SHA == GITHUB_WORKFLOW_SHA.
  // Recovery verifies the original certificate; it never re-attests older code.
  // gh makes cert-identity and signer-workflow mutually exclusive. The exact
  // certificate identity below binds the repository, workflow path and main ref.
  return ['attestation', 'verify', file, '--repo', receipt.repository, '--bundle', bundle,
    '--source-digest', receipt.commit, '--source-ref', 'refs/heads/main',
    '--signer-digest', receipt.commit,
    '--cert-identity', `https://github.com/${receipt.workflow}`, '--deny-self-hosted-runners', '--format', 'json'];
}

export function verifyAttestations(candidate, adapter = { gh }) {
  const results = [];
  for (const item of candidate.receipt.assets) {
    const output = adapter.gh(attestationArgs(resolve(candidate.assets, item.name), candidate.receipt, candidate.bundle));
    const verified = JSON.parse(output);
    assert.ok(Array.isArray(verified) && verified.length > 0, 'Attestation tool returned no verified result');
    results.push({ name: item.name, sha256: item.sha256, verified });
  }
  return results;
}
