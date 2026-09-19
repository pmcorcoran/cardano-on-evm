import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { readCandidate } from '../../scripts/release/candidate.mjs';
import { hashFile, sha256, verifyAttestations, writeJson } from '../../scripts/release/github.mjs';
import { checkReleaseState, publishCandidate, releaseAssets, releaseMarker } from '../../scripts/release/publish.mjs';

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'kernel-mocked-publication-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidateRoot = resolve(root, 'candidate'), assets = resolve(candidateRoot, 'assets'); mkdirSync(assets, { recursive: true });
  const identity = { repository: 'fixture/kernel', commit: 'a'.repeat(40), run: { id: '12', attempt: '1', workflow: 'fixture/kernel/.github/workflows/release.yml@refs/heads/main' } };
  writeJson(resolve(assets, 'context.json'), { ...identity, mode: 'candidate' });
  writeJson(resolve(assets, 'release-manifest.json'), { ...identity, version: '1.2.3' });
  writeFileSync(resolve(assets, 'source.tar.gz'), 'controlled archive bytes, not a real release');
  const assetNames = ['context.json', 'release-manifest.json', 'source.tar.gz'];
  writeFileSync(resolve(assets, 'SHA256SUMS'), assetNames.map(name => `${hashFile(resolve(assets, name))}  ${name}\n`).join(''));
  writeFileSync(resolve(candidateRoot, 'provenance.sigstore.jsonl'), 'controlled mock attestation');
  const receipt = { schemaVersion: 1, kind: 'cardano-on-evm-candidate-handoff', repository: identity.repository,
    commit: identity.commit, version: '1.2.3', candidateId: hashFile(resolve(assets, 'SHA256SUMS')), contextSha256: hashFile(resolve(assets, 'context.json')),
    bundleSha256: hashFile(resolve(candidateRoot, 'provenance.sigstore.jsonl')), runId: '12', runAttempt: '1', workflow: identity.run.workflow, mode: 'publish',
    assets: [...assetNames, 'SHA256SUMS'].sort().map(name => ({ name, sha256: hashFile(resolve(assets, name)), size: statSync(resolve(assets, name)).size })) };
  writeJson(resolve(candidateRoot, 'candidate.json'), receipt);
  const candidate = readCandidate(candidateRoot); candidate.bundleSize = statSync(candidate.bundle).size;
  let tagCommit = null, release = null, records = [], nextId = 1;
  const effects = [], fail = { upload: 0, download: false };
  const remote = {
    tagCommit: () => tagCommit, release: () => release ? structuredClone(release) : null, assets: () => records.map(({ bytes, ...item }) => structuredClone(item)),
    createTag(_tag, commit) { effects.push('createTag'); tagCommit = commit; },
    createDraft(tag, value) { effects.push('createDraft'); release = { id: 9, tag_name: tag, prerelease: false, draft: true, body: releaseMarker(value), html_url: 'https://github.com/fixture/kernel/releases/tag/' + tag }; },
    upload(_tag, item) {
      effects.push('upload:' + item.name);
      if (fail.upload && --fail.upload === 0) throw new Error('Interrupted upload');
      records.push({ id: nextId++, name: item.name, size: item.size, state: 'uploaded', bytes: readFileSync(item.path) });
    },
    download(item, out) {
      effects.push('download:' + item.name);
      const original = records.find(row => row.id === item.id), bytes = fail.download ? Buffer.from('corrupted download') : original.bytes;
      writeFileSync(out, bytes); return { ...item, size: bytes.length, sha256: sha256(bytes) };
    },
    publish() { effects.push('publish'); release.draft = false; },
  };
  const verify = (out) => { readCandidate(out, { candidateId: receipt.candidateId }); effects.push('verify'); };
  const run = (name = 'attempt', verification = verify) => publishCandidate(candidate, remote, resolve(root, name), verification);
  const seed = ({ commit = receipt.commit, draft = true, corrupt = false, unexpected = false } = {}) => {
    tagCommit = commit; remote.createDraft('v1.2.3', receipt); release.draft = draft;
    for (const item of releaseAssets(candidate)) remote.upload('v1.2.3', item);
    if (corrupt) records[0].bytes = Buffer.from('different bytes');
    if (unexpected) records.push({ id: nextId++, name: 'unexpected.txt', size: 1, state: 'uploaded', bytes: Buffer.from('x') });
    effects.length = 0;
  };
  return { root, candidate, receipt, remote, effects, fail, run, seed, records: () => records, mutateRelease: (fn) => fn(release) };
}

test('approved candidate creates tag/draft, uploads every asset, downloads and verifies before publication', (t) => {
  const f = fixture(t), result = f.run(); assert.equal(result.published, true);
  assert.equal(result.assetsVerified, releaseAssets(f.candidate).length);
  assert.ok(f.effects.indexOf('createTag') < f.effects.indexOf('createDraft'));
  assert.ok(f.effects.indexOf('verify') > f.effects.findLastIndex(item => item.startsWith('download:')));
  assert.equal(f.effects.at(-1), 'publish');
});
test('interrupted upload remains draft and safe retry uploads only missing exact assets', (t) => {
  const f = fixture(t); f.fail.upload = 3;
  assert.throws(() => f.run('first'), /Interrupted upload/);
  assert.equal(f.remote.release().draft, true); assert.equal(f.effects.includes('publish'), false);
  const names = f.records().map(item => item.name); f.effects.length = 0;
  assert.equal(f.run('retry').published, true);
  assert.equal(f.effects.includes('createTag'), false); assert.equal(f.effects.includes('createDraft'), false);
  for (const name of names) assert.equal(f.effects.includes('upload:' + name), false);
});
test('matching already published candidate is verified without any mutation', (t) => {
  const f = fixture(t); f.seed({ draft: false }); assert.equal(f.run().alreadyPublished, true);
  assert.equal(f.effects.some(item => /^(create|upload|publish)/.test(item)), false);
});
for (const [name, seed, message] of [
  ['conflicting tag', { commit: 'b'.repeat(40) }, /Conflicting existing tag/],
  ['conflicting asset', { corrupt: true }, /Conflicting existing asset/],
  ['unexpected asset', { unexpected: true }, /Unexpected existing release asset/],
]) test(`${name} fails before remote mutation`, (t) => {
  const f = fixture(t); f.seed(seed); assert.throws(() => f.run(), message);
  assert.equal(f.effects.some(item => /^(create|upload|publish)/.test(item)), false);
});
test('different draft candidate digest and incompatible published release fail closed', (t) => {
  const f = fixture(t); f.seed(); f.mutateRelease(release => { release.body = release.body.replace(f.receipt.candidateId, 'f'.repeat(64)); });
  assert.throws(() => f.run(), /different approved candidate/);
  assert.equal(f.effects.some(item => /^(create|upload|publish)/.test(item)), false);
});
test('failed download verification never publishes the draft', (t) => {
  const f = fixture(t); f.fail.download = true;
  assert.throws(() => f.run(), /checksum mismatch/); assert.equal(f.remote.release().draft, true); assert.equal(f.effects.includes('publish'), false);
});
test('failed attestation verification never publishes the draft', (t) => {
  const f = fixture(t);
  assert.throws(() => f.run('attestation-failure', () => { throw new Error('Attestation identity mismatch'); }), /Attestation identity/);
  assert.equal(f.remote.release().draft, true); assert.equal(f.effects.includes('publish'), false);
});
test('missing existing tag cannot be silently repaired for an incompatible draft', (t) => {
  const f = fixture(t); f.seed();
  assert.throws(() => checkReleaseState(f.candidate, null, f.remote.release(), []), /no matching tag/);
});
test('starter assets, duplicate names and incomplete published releases fail safely', (t) => {
  const f = fixture(t); f.seed();
  const records = f.records().map(({ bytes, ...item }) => ({ ...item, sha256: sha256(bytes) }));
  assert.throws(() => checkReleaseState(f.candidate, f.receipt.commit, f.remote.release(), [{ ...records[0], state: 'starter' }]), /starter/);
  assert.throws(() => checkReleaseState(f.candidate, f.receipt.commit, f.remote.release(), [records[0], records[0]]), /Duplicate/);
  assert.throws(() => checkReleaseState(f.candidate, f.receipt.commit, { ...f.remote.release(), draft: false }, records.slice(1)), /new version/);
});
test('candidate asset, checksum and provenance bundle substitutions fail before remote use', (t) => {
  const f = fixture(t);
  writeFileSync(f.candidate.bundle, 'altered bundle'); assert.throws(() => readCandidate(f.candidate.root), /bundle changed/);
});
test('attestation verification requires a successful result for every final asset including SHA256SUMS', (t) => {
  const f = fixture(t), called = [];
  const verified = verifyAttestations(f.candidate, { gh(args) { called.push(args); return '[{"verificationResult":{}}]'; } });
  assert.equal(verified.length, f.receipt.assets.length); assert.ok(called.some(args => args[2].endsWith('/SHA256SUMS')));
  for (const args of called) {
    for (const flag of ['--repo', '--bundle', '--source-digest', '--source-ref', '--signer-digest', '--cert-identity', '--deny-self-hosted-runners']) assert.ok(args.includes(flag));
    // gh accepts exactly one signer identity selector. An exact certificate SAN
    // preserves the workflow restriction and also pins its ref to main.
    assert.deepEqual(args.filter(arg => ['--cert-identity', '--cert-identity-regex', '--signer-repo', '--signer-workflow'].includes(arg)), ['--cert-identity']);
    for (const [flag, value] of Object.entries({ '--repo': f.receipt.repository, '--bundle': f.candidate.bundle,
      '--source-digest': f.receipt.commit, '--source-ref': 'refs/heads/main', '--signer-digest': f.receipt.commit,
      '--cert-identity': `https://github.com/${f.receipt.workflow}` })) assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.throws(() => verifyAttestations(f.candidate, { gh() { return '[]'; } }), /no verified result/);
  assert.throws(() => verifyAttestations(f.candidate, { gh() { throw new Error('Invalid signature'); } }), /Invalid signature/);
});
