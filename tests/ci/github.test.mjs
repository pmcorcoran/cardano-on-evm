import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { artifactName, downloadArtifact, findArtifact, hashFile, runIdentity, sha256, writeJson } from '../../scripts/release/github.mjs';
import { priorCandidate, readCandidate, seal } from '../../scripts/release/candidate.mjs';

const run = () => ({ id: 12, run_attempt: 1, repository: { full_name: 'fixture/kernel' }, path: '.github/workflows/release.yml', head_branch: 'main', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', event: 'workflow_dispatch' });
test('prior candidate acceptance binds repository, main, workflow, exact run attempt, completion and successful rehearsal', () => {
  assert.equal(runIdentity(run(), 'fixture/kernel', '12', '1', true).id, 12);
  for (const patch of [{ id: 13 }, { run_attempt: 2 }, { repository: { full_name: 'other/kernel' } }, { path: '.github/workflows/check.yml' }, { head_branch: 'feature' }, { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    assert.throws(() => runIdentity({ ...run(), ...patch }, 'fixture/kernel', '12', '1', true));
  }
  assert.equal(runIdentity({ ...run(), conclusion: 'failure' }, 'fixture/kernel', '12', '1', false).conclusion, 'failure', 'Recovery may inspect a completed failed publication');
});
test('expired, ambiguous, digestless or wrong candidate artifacts fail closed', () => {
  const good = { id: 12, name: artifactName('5', '1'), expired: false, digest: 'sha256:' + 'a'.repeat(64) };
  assert.equal(findArtifact([good], good.name).id, 12);
  for (const rows of [[], [good, good], [{ ...good, expired: true }], [{ ...good, digest: null }], [{ ...good, name: artifactName('5', '2') }]]) assert.throws(() => findArtifact(rows, good.name));
});
test('downloaded Actions artifact digest is checked independently before safe extraction', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'kernel-artifact-download-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const zip = resolve(root, 'fixture.zip');
  execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z: z.writestr("assets/file.txt", "expected")', zip]);
  const bytes = readFileSync(zip), digest = 'sha256:' + sha256(bytes);
  const adapter = { api: () => ({ id: 12, expired: false, digest }), gh: () => bytes };
  downloadArtifact('fixture/kernel', '12', digest, resolve(root, 'good'), adapter);
  assert.equal(readFileSync(resolve(root, 'good/assets/file.txt'), 'utf8'), 'expected');
  assert.throws(() => downloadArtifact('fixture/kernel', '12', digest, resolve(root, 'bad'), { ...adapter, gh: () => Buffer.from('altered archive') }), /checksum mismatch/);
  assert.throws(() => downloadArtifact('fixture/kernel', '12', digest, resolve(root, 'wrong'), { ...adapter, api: () => ({ id: 13, expired: false, digest }) }));
});
test('attestation payload fetch leaves only assets in the future sealed handoff root', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'kernel-artifact-seal-layout-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const zip = resolve(root, 'fixture.zip');
  const source = resolve(root, 'source'); mkdirSync(source);
  const identity = { repository: 'fixture/kernel', commit: 'a'.repeat(40), run: { id: '12', attempt: '1', workflow: 'fixture/kernel/.github/workflows/release.yml@refs/heads/main' } };
  writeJson(resolve(source, 'context.json'), { ...identity, mode: 'candidate' });
  writeJson(resolve(source, 'release-manifest.json'), { ...identity, version: '1.0.0' });
  writeFileSync(resolve(source, 'SHA256SUMS'), 'controlled frozen payload checksums');
  execFileSync('python3', ['-c', 'import pathlib,sys,zipfile\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as z:\n for p in r.iterdir(): z.write(p,p.name)', source, zip]);
  const bytes = readFileSync(zip), digest = 'sha256:' + sha256(bytes), handoff = resolve(root, 'approved-candidate');
  downloadArtifact('fixture/kernel', '12', digest, resolve(handoff, 'assets'), { api: () => ({ id: 12, expired: false, digest }), gh: () => bytes });
  assert.deepEqual(readdirSync(handoff), ['assets'], 'Transport ZIP must not become part of the candidate handoff');
  const bundle = resolve(root, 'fixture-provenance.jsonl'); writeFileSync(bundle, 'controlled mock attestation');
  const candidateId = hashFile(resolve(source, 'SHA256SUMS'));
  const result = seal(handoff, bundle, { EXPECTED_CANDIDATE_ID: candidateId, GITHUB_SHA: identity.commit, GITHUB_WORKFLOW_SHA: identity.commit,
    GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '1', RELEASE_MODE: 'candidate-only' }, (_assets, expectedId) => ({ candidateId: expectedId, commit: identity.commit, version: '1.0.0' }));
  assert.equal(result.candidateId, candidateId);
  assert.equal(readCandidate(handoff).receipt.candidateId, candidateId, 'Actual fetch → seal → strict handoff validation succeeds with mocked packaging evidence');
  assert.deepEqual(readdirSync(handoff).sort(), ['assets', 'candidate.json', 'provenance.sigstore.jsonl']);
});
test('Actions artifact traversal and symlinks cannot escape extraction root', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'kernel-artifact-traversal-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, entry] of ['../escape', '/absolute', 'assets/../../escape', 'assets\\escape'].entries()) {
    const zip = resolve(root, `fixture-${index}.zip`);
    execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z: z.writestr(sys.argv[2], "unsafe")', zip, entry]);
    const bytes = readFileSync(zip), digest = 'sha256:' + sha256(bytes);
    assert.throws(() => downloadArtifact('fixture/kernel', '12', digest, resolve(root, 'bad-' + index), { api: () => ({ id: 12, expired: false, digest }), gh: () => bytes }));
  }
  const zip = resolve(root, 'link.zip');
  execFileSync('python3', ['-c', 'import stat,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\ni=zipfile.ZipInfo("link")\ni.create_system=3\ni.external_attr=(stat.S_IFLNK|0o777)<<16\nz.writestr(i,"../escape")\nz.close()', zip]);
  const bytes = readFileSync(zip), digest = 'sha256:' + sha256(bytes);
  assert.throws(() => downloadArtifact('fixture/kernel', '12', digest, resolve(root, 'link-out'), { api: () => ({ id: 12, expired: false, digest }), gh: () => bytes }));
});

test('bootstrap and manual recovery exercise downloaded run/artifact/handoff identity and attestation gates', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'kernel-prior-candidate-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = resolve(root, 'candidate'), assets = resolve(candidate, 'assets'); mkdirSync(assets, { recursive: true });
  const identity = { repository: 'fixture/kernel', commit: 'a'.repeat(40), run: { id: '12', attempt: '1', workflow: 'fixture/kernel/.github/workflows/release.yml@refs/heads/main' } };
  writeJson(resolve(assets, 'context.json'), { ...identity, mode: 'candidate' });
  writeJson(resolve(assets, 'release-manifest.json'), { ...identity, version: '1.0.0' });
  writeFileSync(resolve(assets, 'SHA256SUMS'), 'fixture checksums');
  writeFileSync(resolve(candidate, 'provenance.sigstore.jsonl'), 'mock cryptographic bundle');
  const receipt = { schemaVersion: 1, kind: 'cardano-on-evm-candidate-handoff', repository: identity.repository, commit: identity.commit,
    version: '1.0.0', runId: '12', runAttempt: '1', workflow: identity.run.workflow, mode: 'candidate-only',
    candidateId: hashFile(resolve(assets, 'SHA256SUMS')), contextSha256: hashFile(resolve(assets, 'context.json')),
    bundleSha256: hashFile(resolve(candidate, 'provenance.sigstore.jsonl')),
    assets: ['context.json', 'release-manifest.json', 'SHA256SUMS'].map(name => { const bytes = readFileSync(resolve(assets, name)); return { name, sha256: sha256(bytes), size: bytes.length }; }) };
  let mode = 'candidate-only', jobsPass = true, attestationPass = true, conclusion = 'success', attempt = 0;
  const exercise = (options = {}) => {
    writeJson(resolve(candidate, 'candidate.json'), { ...receipt, mode });
    const zip = resolve(root, 'fixture.zip');
    execFileSync('python3', ['-c', 'import pathlib,sys,zipfile\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as z:\n for p in r.rglob("*"):\n  if p.is_file(): z.write(p,p.relative_to(r).as_posix())', candidate, zip]);
    const bytes = readFileSync(zip), digest = 'sha256:' + sha256(bytes), artifact = { id: 34, expired: false, name: artifactName('12', '1'), digest };
    const adapter = {
      api(path) {
        if (path.endsWith('/attempts/1')) return { ...run(), conclusion };
        if (path.includes('/jobs?')) return [{ jobs: [
          { name: 'Verify candidate for review', conclusion: jobsPass ? 'success' : 'failure' },
          { name: 'Approve and publish immutable candidate', conclusion: mode === 'candidate-only' ? 'skipped' : 'success' },
        ] }];
        if (path.includes('/artifacts?')) return [{ artifacts: [artifact] }];
        if (path.endsWith('/artifacts/34')) return artifact;
        throw new Error('Unexpected GitHub request: ' + path);
      },
      gh(args) {
        if (args[0] === 'api') return bytes;
        assert.equal(args[0], 'attestation');
        if (!attestationPass) throw new Error('Attestation verification failed');
        return '[{"verificationResult":{}}]';
      },
    };
    return priorCandidate('fixture/kernel', '12', '1', resolve(root, 'download-' + ++attempt), { rehearsal: true, currentRun: '14', adapter, ...options });
  };
  assert.equal(exercise().candidate.receipt.mode, 'candidate-only');
  assert.throws(() => exercise({ currentRun: '12' }), /prior run/);
  assert.throws(() => exercise({ expectedId: 'f'.repeat(64) }), /candidateId mismatch/);
  jobsPass = false; assert.throws(() => exercise(), /never completed/); jobsPass = true;
  attestationPass = false; assert.throws(() => exercise(), /Attestation verification failed/); attestationPass = true;
  mode = 'publish'; assert.throws(() => exercise(), /must not publish/);
  conclusion = 'failure'; assert.throws(() => exercise(), /did not succeed/);
  assert.equal(exercise({ rehearsal: false, expectedId: receipt.candidateId }).candidate.receipt.candidateId, receipt.candidateId, 'Original failed publication can recover exact previously verified bytes');
});
