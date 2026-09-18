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
      /secret\d*\s*=|assuming 0x|BUNDLER_EXECUTOR_PRIVATE_KEY:|"src\/utils\/(?:g\/)?WebAuthn\.sol"|"key":|"requestKey":/.test(line));
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
