import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, gh, HASH, hashFile, SHA, verifyAttestations, writeJson } from './github.mjs';
import { priorCandidate, readCandidate, verifyPayload } from './candidate.mjs';

export function releaseMarker(receipt) {
  return `<!-- cardano-on-evm-candidate:${receipt.candidateId};commit:${receipt.commit};attestation:${receipt.bundleSha256} -->`;
}

export function releaseAssets(candidate) {
  return [...candidate.receipt.assets.map((item) => ({ ...item, path: resolve(candidate.assets, item.name) })),
    { name: 'provenance.sigstore.jsonl', sha256: candidate.receipt.bundleSha256,
      size: candidate.bundleSize, path: candidate.bundle }];
}

export function checkReleaseState(candidate, tagCommit, release, actualAssets) {
  const receipt = candidate.receipt;
  if (tagCommit !== null) assert.equal(tagCommit, receipt.commit, 'Conflicting existing tag; never move a release tag');
  if (release === null) {
    assert.equal(actualAssets.length, 0);
    return { createTag: tagCommit === null, createDraft: true, upload: releaseAssets(candidate), published: false };
  }
  assert.equal(tagCommit, receipt.commit, 'Existing release has no matching tag');
  assert.equal(release.tag_name, `v${receipt.version}`);
  assert.equal(release.prerelease, false, 'Incompatible existing prerelease');
  assert.equal(release.body?.split('\n')[0], releaseMarker(receipt), 'Existing release belongs to a different approved candidate');
  assert.equal(typeof release.draft, 'boolean');
  const expected = new Map(releaseAssets(candidate).map((item) => [item.name, item])), seen = new Set();
  for (const item of actualAssets) {
    assert.ok(expected.has(item.name), 'Unexpected existing release asset: ' + item.name);
    assert.ok(!seen.has(item.name), 'Duplicate existing release asset'); seen.add(item.name);
    assert.equal(item.state, 'uploaded', 'Interrupted/starter asset requires explicit operator inspection');
    assert.equal(item.sha256, expected.get(item.name).sha256, 'Conflicting existing asset: ' + item.name);
    assert.equal(item.size, expected.get(item.name).size, 'Existing asset size differs');
  }
  const upload = [...expected.values()].filter((item) => !seen.has(item.name));
  if (!release.draft) assert.equal(upload.length, 0, 'Published release is incomplete; correct it with a new version');
  return { createTag: false, createDraft: false, upload, published: !release.draft };
}

export function githubPublisher(repository, work) {
  const base = `repos/${repository}`;
  const download = (asset, path) => {
    const bytes = gh(['api', `${base}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { binary: true });
    writeFileSync(path, bytes);
    return { ...asset, sha256: hashFile(path), size: bytes.length };
  };
  return {
    tagCommit(tag) {
      let ref = api(`${base}/git/ref/tags/${tag}`, { optional: true });
      if (ref === null) return null;
      let object = ref.object;
      for (let depth = 0; object.type === 'tag' && depth < 8; depth++) object = api(`${base}/git/tags/${object.sha}`).object;
      assert.equal(object.type, 'commit', 'Tag must resolve to a commit'); assert.match(object.sha, SHA);
      return object.sha;
    },
    release(tag) { return api(`${base}/releases/tags/${tag}`, { optional: true }); },
    assets(release) { return release ? api(`${base}/releases/${release.id}/assets?per_page=100`, { paginate: true }).flat() : []; },
    download,
    createTag(tag, commit) { api(`${base}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: commit } }); },
    createDraft(tag, receipt) {
      const notes = resolve(work, 'release-notes.md');
      writeFileSync(notes, `${releaseMarker(receipt)}\n\nCardano on EVM ${tag}\n\nValidated commit: ${receipt.commit}\n\nCandidate SHA256SUMS digest: ${receipt.candidateId}\n\nInstall from the complete library bundle or the source archive. See the included installation instructions, release manifest, validation and security reports. Verify SHA256SUMS and provenance.sigstore.jsonl before use.\n`);
      gh(['release', 'create', tag, '--repo', repository, '--target', receipt.commit, '--verify-tag', '--draft', '--title', `Cardano on EVM ${tag}`, '--notes-file', notes]);
    },
    upload(tag, item) { gh(['release', 'upload', tag, item.path, '--repo', repository]); }, // Deliberately no --clobber.
    publish(tag) { gh(['release', 'edit', tag, '--repo', repository, '--draft=false']); },
  };
}

// The adapter allows real failure ordering to be tested without publishing anything.
export function publishCandidate(candidate, remote, work, verifyDownloaded) {
  mkdirSync(work, { recursive: true });
  const tag = `v${candidate.receipt.version}`;
  let release = remote.release(tag), assets = remote.assets(release);
  const existing = resolve(work, 'existing'); mkdirSync(existing, { recursive: true });
  // Check names before they can become paths; fetch every existing byte before any mutation.
  const names = new Set(releaseAssets(candidate).map((item) => item.name));
  for (const item of assets) assert.ok(names.has(item.name), 'Unexpected existing release asset: ' + item.name);
  const downloaded = assets.map((item) => remote.download(item, resolve(existing, item.name)));
  const plan = checkReleaseState(candidate, remote.tagCommit(tag), release, downloaded);
  if (plan.createTag) remote.createTag(tag, candidate.receipt.commit);
  assert.equal(remote.tagCommit(tag), candidate.receipt.commit, 'Tag changed before draft creation');
  if (plan.createDraft) remote.createDraft(tag, candidate.receipt);
  for (const item of plan.upload) remote.upload(tag, item);
  release = remote.release(tag); assets = remote.assets(release);
  const downloadedRoot = resolve(work, 'downloaded'), downloadedAssets = resolve(downloadedRoot, 'assets');
  mkdirSync(downloadedAssets, { recursive: true });
  const expected = new Map(releaseAssets(candidate).map((item) => [item.name, item]));
  assert.deepEqual(assets.map((item) => item.name).sort(), [...expected.keys()].sort(), 'Required release uploads are missing or duplicated');
  const final = assets.map((item) => {
    const target = item.name === 'provenance.sigstore.jsonl' ? resolve(downloadedRoot, item.name) : resolve(downloadedAssets, item.name);
    const result = remote.download(item, target);
    assert.equal(result.sha256, expected.get(item.name).sha256, 'Downloaded release asset checksum mismatch: ' + item.name);
    return result;
  });
  checkReleaseState(candidate, remote.tagCommit(tag), release, final);
  copyFileSync(resolve(candidate.root, 'candidate.json'), resolve(downloadedRoot, 'candidate.json'));
  verifyDownloaded(downloadedRoot); // Full packaged evidence + EVERY subject's cryptographic attestation.
  const lastRelease = remote.release(tag), lastAssets = remote.assets(lastRelease);
  assert.equal(remote.tagCommit(tag), candidate.receipt.commit, 'Tag changed during verification');
  assert.equal(lastRelease.id, release.id, 'Draft identity changed during verification');
  assert.equal(lastRelease.body, release.body, 'Draft candidate identity changed during verification');
  assert.equal(lastRelease.draft, release.draft, 'Draft state changed during verification');
  assert.deepEqual(lastAssets.map((item) => ({ id: item.id, name: item.name, size: item.size, state: item.state })).sort((a, b) => a.name.localeCompare(b.name)),
    assets.map((item) => ({ id: item.id, name: item.name, size: item.size, state: item.state })).sort((a, b) => a.name.localeCompare(b.name)), 'Release assets changed during verification');
  if (!plan.published) remote.publish(tag);
  const published = remote.release(tag);
  assert.equal(published.draft, false, 'GitHub did not confirm publication');
  return { tag, commit: candidate.receipt.commit, candidateId: candidate.receipt.candidateId,
    assetsVerified: final.length, published: true, alreadyPublished: plan.published, url: published.html_url };
}

export function main(args = process.argv.slice(2), env = process.env) {
  assert.equal(args[0], 'publish');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Publication is only supported inside the approved GitHub job');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.RELEASE_PUBLISH_ENABLED, 'true', 'Publication is disabled');
  assert.match(env.RELEASE_APPROVED_CANDIDATE_ID ?? '', HASH);
  const candidate = readCandidate(resolve(args[1]), { repository: env.GITHUB_REPOSITORY,
    candidateId: env.RELEASE_APPROVED_CANDIDATE_ID, commit: env.EXPECTED_COMMIT, version: env.EXPECTED_VERSION });
  assert.equal(candidate.handoffSha256, env.EXPECTED_HANDOFF_SHA256, 'Approval handoff changed');
  candidate.bundleSize = statSync(candidate.bundle).size;
  // Recheck after the approval wait. Expired candidate evidence must be rebuilt and approved again.
  verifyPayload(candidate.assets, candidate.receipt.candidateId); verifyAttestations(candidate);
  priorCandidate(env.GITHUB_REPOSITORY, env.RELEASE_REHEARSAL_RUN_ID, env.RELEASE_REHEARSAL_RUN_ATTEMPT || '1', '.local/publish-rehearsal', { rehearsal: true, currentRun: env.GITHUB_RUN_ID });
  const work = resolve('.local/publication');
  const result = publishCandidate(candidate, githubPublisher(env.GITHUB_REPOSITORY, work), work, (out) => {
    const downloaded = readCandidate(out, { candidateId: candidate.receipt.candidateId });
    assert.equal(downloaded.handoffSha256, candidate.handoffSha256);
    verifyPayload(downloaded.assets, downloaded.receipt.candidateId);
    writeJson(resolve(work, 'attestations.json'), verifyAttestations(downloaded));
  });
  writeJson(resolve(work, 'result.json'), result);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `Published [${result.tag}](${result.url}) from \`${result.commit}\`, candidate \`${result.candidateId}\`, after downloaded checksums and attestations passed.\n`);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error('Publication stopped; no conflicting asset will be replaced: ' + error.message); process.exitCode = 1; }
}
