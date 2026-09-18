import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions, versionSignal } from './version.mjs';
import { api, gh, artifactName, downloadArtifact, findArtifact, HASH, hashFile, ID, readJson, REPOSITORY, runIdentity, SHA, VERSION, verifyAttestations, WORKFLOW, writeJson } from './github.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
export const output = (values) => {
  if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(values)) {
    assert.ok(!String(value).includes('\n'));
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(JSON.stringify(values));
};

export function resolveNew(root, env, event) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Release resolution requires GitHub Actions');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Release workflow must be dispatched on main');
  assert.match(env.GITHUB_REPOSITORY ?? '', REPOSITORY);
  assert.match(env.GITHUB_SHA ?? '', SHA);
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA, 'Workflow/source snapshots must match for OIDC provenance');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${env.GITHUB_REPOSITORY}/${WORKFLOW}@refs/heads/main`);
  assert.equal(git(root, 'rev-parse', 'HEAD'), env.GITHUB_SHA, 'Checkout moved from the triggering commit');
  const version = checkVersions(root).version;
  let changed = true, mode = env.RELEASE_MODE || 'candidate-only';
  if (env.GITHUB_EVENT_NAME === 'push') {
    assert.equal(event.ref, 'refs/heads/main');
    assert.equal(event.after, env.GITHUB_SHA);
    assert.equal(event.deleted, false);
    assert.match(event.before ?? '', SHA);
    if (/^0{40}$/.test(event.before)) changed = false; // First import uses explicit dispatch.
    else {
      git(root, 'merge-base', '--is-ancestor', event.before, env.GITHUB_SHA);
      changed = versionSignal(root, event.before).changed; // Entire push, not HEAD^.
    }
    mode = env.RELEASE_PUBLISH_ENABLED === 'true' ? 'publish' : 'candidate-only';
  } else assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.ok(['candidate-only', 'publish', 'recover'].includes(mode), 'Invalid release mode');
  return { build: changed && mode !== 'recover', publish: changed && mode !== 'candidate-only', mode,
    commit: env.GITHUB_SHA, version, repository: env.GITHUB_REPOSITORY };
}

export function readCandidate(out, expected = {}) {
  const root = resolve(out), receipt = readJson(resolve(root, 'candidate.json'));
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'cardano-on-evm-candidate-handoff');
  assert.match(receipt.repository, REPOSITORY); assert.match(receipt.commit, SHA); assert.match(receipt.version, VERSION);
  assert.match(receipt.candidateId, HASH); assert.match(receipt.contextSha256, HASH);
  assert.match(receipt.bundleSha256, HASH); assert.match(String(receipt.runId), ID); assert.match(String(receipt.runAttempt), ID);
  assert.ok(['candidate-only', 'publish'].includes(receipt.mode));
  assert.equal(receipt.workflow, `${receipt.repository}/${WORKFLOW}@refs/heads/main`);
  for (const [key, value] of Object.entries(expected)) assert.equal(receipt[key], String(value), `Candidate ${key} mismatch`);
  assert.deepEqual(readdirSync(root).sort(), ['assets', 'candidate.json', 'provenance.sigstore.jsonl'], 'Unexpected handoff files');
  for (const name of ['candidate.json', 'provenance.sigstore.jsonl', 'assets']) assert.equal(lstatSync(resolve(root, name)).isSymbolicLink(), false);
  const assets = resolve(root, 'assets'), bundle = resolve(root, 'provenance.sigstore.jsonl');
  assert.equal(hashFile(bundle), receipt.bundleSha256, 'Attestation bundle changed');
  assert.equal(hashFile(resolve(assets, 'SHA256SUMS')), receipt.candidateId, 'Candidate checksum digest changed');
  assert.equal(hashFile(resolve(assets, 'context.json')), receipt.contextSha256, 'Candidate context changed');
  const names = new Set();
  assert.ok(Array.isArray(receipt.assets) && receipt.assets.length > 2);
  for (const item of receipt.assets) {
    assert.match(item.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/); assert.match(item.sha256, HASH);
    assert.ok(!names.has(item.name), 'Duplicate candidate asset'); names.add(item.name);
    const file = resolve(assets, item.name), st = lstatSync(file);
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'Candidate asset must be a regular file');
    assert.equal(st.size, item.size); assert.equal(hashFile(file), item.sha256, 'Candidate asset changed: ' + item.name);
  }
  assert.deepEqual(readdirSync(assets).sort(), [...names].sort(), 'Candidate asset set changed');
  const context = readJson(resolve(assets, 'context.json')), manifest = readJson(resolve(assets, 'release-manifest.json'));
  assert.equal(context.mode, 'candidate');
  for (const doc of [context, manifest]) {
    assert.equal(doc.repository, receipt.repository); assert.equal(doc.commit, receipt.commit);
    assert.equal(doc.run.id, receipt.runId); assert.equal(doc.run.attempt, receipt.runAttempt);
    assert.equal(doc.run.workflow, receipt.workflow);
  }
  assert.equal(manifest.version, receipt.version);
  return { root, receipt, assets, bundle, handoffSha256: hashFile(resolve(root, 'candidate.json')) };
}

export function verifyPayload(assets, candidateId, runner = execFileSync) {
  const result = JSON.parse(runner('python3', ['scripts/package-release.py', 'verify', '--for-publication', '--out', assets,
    '--context', resolve(assets, 'context.json')], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.equal(result.verified, true); assert.equal(result.candidateId, candidateId);
  return result;
}

export function seal(out, bundle, env, verify = verifyPayload) {
  const assets = resolve(out, 'assets'), result = verify(assets, env.EXPECTED_CANDIDATE_ID);
  const context = readJson(resolve(assets, 'context.json'));
  assert.equal(context.commit, env.GITHUB_SHA); assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA);
  assert.equal(context.run.id, env.GITHUB_RUN_ID); assert.equal(context.run.attempt, env.GITHUB_RUN_ATTEMPT);
  copyFileSync(bundle, resolve(out, 'provenance.sigstore.jsonl'));
  const receipt = { schemaVersion: 1, kind: 'cardano-on-evm-candidate-handoff', repository: context.repository,
    commit: result.commit, version: result.version, candidateId: result.candidateId, mode: env.RELEASE_MODE,
    runId: context.run.id, runAttempt: context.run.attempt, workflow: context.run.workflow,
    contextSha256: hashFile(resolve(assets, 'context.json')), bundleSha256: hashFile(resolve(out, 'provenance.sigstore.jsonl')),
    assets: readdirSync(assets).sort().map((name) => ({ name, sha256: hashFile(resolve(assets, name)), size: lstatSync(resolve(assets, name)).size })) };
  writeJson(resolve(out, 'candidate.json'), receipt);
  const candidate = readCandidate(out);
  return { candidateId: receipt.candidateId, handoffSha256: candidate.handoffSha256, commit: receipt.commit, version: receipt.version };
}

export function priorCandidate(repository, runId, attempt, out, { rehearsal = false, currentRun, expectedId, adapter = { api, gh } } = {}) {
  assert.match(repository, REPOSITORY); assert.match(String(runId), ID); assert.match(String(attempt), ID);
  assert.notEqual(String(runId), String(currentRun), 'Rehearsal/recovery must use a prior run');
  const run = runIdentity(adapter.api(`repos/${repository}/actions/runs/${runId}/attempts/${attempt}`), repository, runId, attempt, rehearsal);
  const jobs = adapter.api(`repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, { paginate: true }).flatMap((page) => page.jobs);
  assert.ok(jobs.some((job) => job.name === 'Verify candidate for review' && job.conclusion === 'success'), 'Prior candidate never completed download/attestation verification');
  if (rehearsal) assert.ok(jobs.some((job) => job.name === 'Approve and publish immutable candidate' && job.conclusion === 'skipped'), 'Rehearsal must not publish');
  const rows = adapter.api(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, { paginate: true }).flatMap((page) => page.artifacts);
  const artifact = findArtifact(rows, artifactName(runId, attempt));
  downloadArtifact(repository, artifact.id, artifact.digest, out, adapter);
  const expected = { repository, commit: run.head_sha, runId: String(runId), runAttempt: String(attempt) };
  if (expectedId) expected.candidateId = expectedId;
  if (rehearsal) expected.mode = 'candidate-only';
  const candidate = readCandidate(out, expected);
  verifyAttestations(candidate, adapter);
  return { candidate, artifact, run };
}

export function main(args = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = args;
  if (command === 'resolve') {
    const result = resolveNew(process.cwd(), env, readJson(env.GITHUB_EVENT_PATH));
    if (result.publish) {
      assert.equal(env.RELEASE_PUBLISH_ENABLED, 'true', 'Publication is disabled; complete operator setup first');
      priorCandidate(result.repository, env.RELEASE_REHEARSAL_RUN_ID, env.RELEASE_REHEARSAL_RUN_ATTEMPT || '1', '.local/rehearsal', { rehearsal: true, currentRun: env.GITHUB_RUN_ID });
    }
    if (result.mode === 'recover') {
      assert.match(env.RECOVERY_CANDIDATE_ID ?? '', HASH, 'Recovery requires the reviewed SHA256SUMS digest');
      const prior = priorCandidate(result.repository, env.RECOVERY_RUN_ID, env.RECOVERY_RUN_ATTEMPT, '.local/recovery', { currentRun: env.GITHUB_RUN_ID, expectedId: env.RECOVERY_CANDIDATE_ID });
      git(process.cwd(), 'merge-base', '--is-ancestor', prior.candidate.receipt.commit, env.GITHUB_SHA);
      verifyPayload(prior.candidate.assets, prior.candidate.receipt.candidateId);
      Object.assign(result, { commit: prior.candidate.receipt.commit, version: prior.candidate.receipt.version,
        artifactId: prior.artifact.id, artifactDigest: prior.artifact.digest, candidateId: prior.candidate.receipt.candidateId,
        handoffSha256: prior.candidate.handoffSha256 });
    }
    output(result);
  } else if (command === 'identity') {
    const assets = resolve(rest[0]), value = verifyPayload(assets, env.EXPECTED_CANDIDATE_ID || hashFile(resolve(assets, 'SHA256SUMS')));
    assert.equal(value.commit, env.EXPECTED_COMMIT); assert.equal(value.version, env.EXPECTED_VERSION);
    output({ candidateId: value.candidateId, commit: value.commit, version: value.version });
  } else if (command === 'seal') output(seal(resolve(rest[0]), resolve(rest[1]), env));
  else if (command === 'fetch') downloadArtifact(env.GITHUB_REPOSITORY, env.CANDIDATE_ARTIFACT_ID, env.CANDIDATE_ARTIFACT_DIGEST, resolve(rest[0]));
  else if (command === 'verify') {
    const candidate = readCandidate(resolve(rest[0]), { repository: env.GITHUB_REPOSITORY, candidateId: env.EXPECTED_CANDIDATE_ID,
      commit: env.EXPECTED_COMMIT, version: env.EXPECTED_VERSION });
    assert.equal(candidate.handoffSha256, env.EXPECTED_HANDOFF_SHA256, 'Approval handoff changed');
    verifyPayload(candidate.assets, candidate.receipt.candidateId);
    const results = verifyAttestations(candidate);
    mkdirSync('.local/release-verification', { recursive: true });
    writeJson('.local/release-verification/attestations.json', results);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
      `Candidate v${candidate.receipt.version}\n\nCommit: \`${candidate.receipt.commit}\`\n\nSHA256SUMS digest: \`${candidate.receipt.candidateId}\`\n\nHandoff digest: \`${candidate.handoffSha256}\`\n\nActions artifact ID: \`${env.CANDIDATE_ARTIFACT_ID}\`\n\nArchive digest: \`${env.CANDIDATE_ARTIFACT_DIGEST}\`\n\nAll candidate assets and attestations verified. Review the downloadable manifest, checksums, validation/security reports and provenance bundle before environment approval.\n`);
    output({ verified: true });
  } else if (command === 'consumer') {
    const candidate = readCandidate(resolve(rest[0]), { candidateId: env.EXPECTED_CANDIDATE_ID });
    assert.equal(candidate.handoffSha256, env.EXPECTED_HANDOFF_SHA256, 'Review handoff changed');
    verifyPayload(candidate.assets, candidate.receipt.candidateId);
    const manifest = readJson(resolve(candidate.assets, 'release-manifest.json'));
    const library = manifest.assets.filter((item) => item.kind === 'libraries');
    assert.equal(library.length, 1);
    const bundle = resolve('.local/downloaded-library-bundle');
    mkdirSync(bundle, { recursive: true });
    execFileSync('python3', ['-c', `import pathlib,sys,tarfile
root=pathlib.Path(sys.argv[2])
with tarfile.open(sys.argv[1], 'r:gz') as archive:
 for item in archive:
  name=pathlib.PurePosixPath(item.name)
  assert item.isfile() and not name.is_absolute() and '..' not in name.parts, 'Unexpected verified bundle entry'
  target=root.joinpath(*name.parts)
  assert not target.exists(), 'Bundle extraction would overwrite files'
  target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(archive.extractfile(item).read())
`, resolve(candidate.assets, library[0].name), bundle], { stdio: 'pipe' });
    execFileSync(process.execPath, [resolve(bundle, 'scripts/check-package-install.mjs'), '--archives', resolve(bundle, 'archives'),
      '--out', resolve('.local/release-verification/downloaded-consumer')], { stdio: 'inherit' });
  } else throw new Error('Usage: candidate.mjs resolve|identity ASSETS|seal OUT BUNDLE|fetch OUT|verify OUT|consumer OUT');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error('Release candidate gate failed: ' + error.message); process.exitCode = 1; }
}
