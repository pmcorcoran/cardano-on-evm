import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const sourcePaths = [
  'vendor/scl/test/libSCL_eip6565.t.sol',
  'vendor/scl/src/lib/Ed25519DelegationEIP7702.sol',
  'vendor/sources.json',
  'scripts/experiments/private-bundler.ts',
  'fixtures/generated-cip8.json',
  'fixtures/wallet-signatures.json',
  'fixtures/address-derivation-v1/protocol-vectors.json',
];

function fixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'kernel-secret-policy-'));
  const source = path.join(temporary, 'source');
  for (const name of sourcePaths) {
    const target = path.join(source, name);
    mkdirSync(path.dirname(target), { recursive: true });
    // Exercise the real detector on the relevant public data. Full source and
    // archive scans run in the security lane; copying unrelated large encoded
    // cryptographic vectors here makes a policy regression needlessly expensive.
    const candidates = readFileSync(name, 'utf8').split('\n').filter(line =>
      /secret\d*\s*=|assuming 0x|BUNDLER_EXECUTOR_PRIVATE_KEY:|"src\/utils\/(?:g\/)?WebAuthn\.sol"|"key":|"requestKey":|"publicKey":/.test(line));
    // Retain every distinct representative line once; corpus variations can
    // repeat the same public COSE key without adding scanner-policy coverage.
    const lines = [...new Set(candidates)];
    assert.ok(lines.length, `Missing representative public data in ${name}`);
    writeFileSync(target, lines.join('\n') + '\n');
  }
  return { temporary, source };
}

function scan(temporary, source) {
  const reportPath = path.join(temporary, 'report.json');
  const result = spawnSync('python3', ['scripts/ci/security.py', 'scan', '--root', source, '--out', reportPath], { encoding: 'utf8', timeout: 300000, detached: true });
  if (result.error && result.pid) {
    // A timed-out Python wrapper must not leave its scanner running locally.
    try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  assert.equal(result.error, undefined, result.error?.message);
  return { result, report: JSON.parse(readFileSync(reportPath, 'utf8')) };
}

function browserEvidence(extra = {}, traceName = 'reference_0-trace.zip') {
  const value = fixture();
  const keys = [...new Set([...readFileSync('fixtures/wallet-signatures.json', 'utf8')
    .matchAll(/"key":\s*"([0-9a-f]+)"/g)].map(match => match[1]))]
    .filter(key => key.startsWith('a5010102581de0') || key.startsWith('a5010102583900'));
  assert.equal(keys.length, 2, 'Require the two existing reviewed public COSE encodings');
  const body = JSON.stringify({ enrollment: { key: keys[0] }, operation: { key: keys[1] }, ...extra });
  const resource = `resources/${createHash('sha1').update(body).digest('hex')}.json`;
  const trace = path.join(value.source, 'core/browser', traceName);
  mkdirSync(path.dirname(trace), { recursive: true });
  const enrollment = path.join(value.source, 'core/reference-http-evidence',
    `enrollment-${createHash('sha256').update(body).digest('hex')}.json`);
  mkdirSync(path.dirname(enrollment), { recursive: true });
  writeFileSync(enrollment, body);
  const zip = spawnSync('python3', ['-c',
    'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as z: z.write(sys.argv[2], sys.argv[3])',
    trace, enrollment, resource], { encoding: 'utf8', timeout: 30000 });
  assert.equal(zip.status, 0, zip.stderr);
  const expanded = path.join(trace + '.contents', resource);
  mkdirSync(path.dirname(expanded), { recursive: true });
  writeFileSync(expanded, body);
  return { ...value, trace, resource };
}

test('reviewed public vectors, public COSE keys and source hashes pass the actual scanner', () => {
  const { temporary, source } = fixture();
  try {
    const { result, report } = scan(temporary, source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(report.status, 'passed');
    assert.deepEqual(report.findings, []);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('an unrelated synthetic credential in an allowlisted path still blocks and stays redacted', () => {
  const { temporary, source } = fixture();
  try {
    const sentinel = createHash('sha256').update('unrelated synthetic scanner regression credential').digest('hex');
    const target = path.join(source, sourcePaths[0]);
    writeFileSync(target, readFileSync(target, 'utf8') + `\nstring secret = "${sentinel}";\n`);
    const { result, report } = scan(temporary, source);
    assert.equal(result.status, 1);
    assert.equal(report.status, 'failed');
    assert.ok(report.findings.some(row => row.File.endsWith(sourcePaths[0])));
    assert.ok(!JSON.stringify(report).includes(sentinel));
    assert.ok(!(result.stdout + result.stderr).includes(sentinel));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('a public vector exception does not suppress that value in an unrelated file', () => {
  const { temporary, source } = fixture();
  try {
    copyFileSync(path.join(source, sourcePaths[0]), path.join(source, 'unreviewed.sol'));
    const { result, report } = scan(temporary, source);
    assert.equal(result.status, 1);
    assert.ok(report.findings.some(row => row.File.endsWith('/unreviewed.sol')));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('reviewed public fixture data passes in original and expanded browser trace archives', () => {
  for (const trace of ['reference_0-trace.zip', 'live_review_1-trace.zip', 'wallet_credential_3-trace.zip']) {
    const { temporary, source } = browserEvidence({}, trace);
    try {
      const { result, report } = scan(temporary, source);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(report.findings, []);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
});

test('an unrelated credential beside public keys blocks in nested and expanded trace evidence', () => {
  const sentinel = createHash('sha256').update('unrelated credential in nested browser evidence').digest('hex');
  const { temporary, source } = browserEvidence({ api_key: sentinel });
  try {
    const { result, report } = scan(temporary, source);
    assert.equal(result.status, 1);
    assert.ok(report.findings.some(row => row.File.includes('-trace.zip!resources/')));
    assert.ok(report.findings.some(row => row.File.includes('-trace.zip.contents/resources/')));
    assert.ok(report.findings.some(row => row.File.includes('/core/reference-http-evidence/enrollment-')));
    assert.ok(!JSON.stringify(report).includes(sentinel));
    assert.ok(!(result.stdout + result.stderr).includes(sentinel));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('public browser key exceptions do not cover an unreviewed trace name', () => {
  const { temporary, source } = browserEvidence({}, 'unreviewed_0-trace.zip');
  try {
    const { result, report } = scan(temporary, source);
    assert.equal(result.status, 1);
    assert.ok(report.findings.some(row => row.File.includes('/unreviewed_0-trace.zip!resources/')));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
