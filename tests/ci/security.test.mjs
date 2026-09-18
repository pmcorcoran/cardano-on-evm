import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const advisory = 'GHSA-c96f-x56v-gq3h';
function fixture(severity = 'high') {
  return {
    audit: { auditReportVersion: 2, vulnerabilities: { 'find-my-way': { name: 'find-my-way', severity, via: [{ dependency: 'find-my-way', severity, url: `https://github.com/advisories/${advisory}` }], nodes: ['node_modules/find-my-way'] } }, metadata: { dependencies: { total: 1 }, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, [severity]: 1, total: 1 } } },
    lock: { lockfileVersion: 3, packages: { 'node_modules/find-my-way': { version: '8.2.2' } } },
    policy: { schema_version: 1, exceptions: [{ tree: 'infra/bundler', advisory, dependency: 'find-my-way', version: '8.2.2', severity, rationale: 'Fixture only: validate bounded explicit acceptance of one advisory.', owner: '@fixture-reviewer', approved_at: '2026-09-01', expires_at: '2026-10-01' }] },
    code: 1,
  };
}
function gate(data) {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-audit-policy-'));
  try {
    for (const key of ['audit', 'lock', 'policy']) writeFileSync(join(dir, `${key}.json`), typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]));
    return spawnSync('python3', ['scripts/ci/security.py', 'validate', '--audit', join(dir, 'audit.json'), '--lock', join(dir, 'lock.json'), '--exceptions', join(dir, 'policy.json'), '--tree', 'infra/bundler', '--today', '2026-09-11', '--exit-code', String(data.code)], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('valid exact 30-day risk acceptance permits existing advisory without removing it from report', () => {
  const result = gate(fixture());
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(result.stdout).findings[0];
  assert.equal(row.decision, 'excepted');
  assert.equal(row.advisory, advisory);
  assert.equal(row.exception.expires_at, '2026-10-01');
});
test('new unapproved advisories block at every severity', () => {
  for (const severity of ['low', 'moderate', 'high', 'critical']) {
    const data = fixture(severity);
    data.policy.exceptions = [];
    assert.equal(gate(data).status, 1);
  }
});
test('exception never broadens to a changed package, version, advisory or higher severity', () => {
  for (const field of ['tree', 'dependency', 'version', 'advisory', 'severity']) {
    const data = fixture();
    data.policy.exceptions[0][field] = { tree: '.', dependency: 'other-package', version: '8.2.3', advisory: 'GHSA-8988-4f7v-96qf', severity: 'moderate' }[field];
    assert.equal(gate(data).status, 1, field);
  }
  const data = fixture('critical');
  data.policy.exceptions[0].severity = 'high';
  assert.match(gate(data).stdout, /increased-severity/);
});
test('expired, future, overlong, invalid and incomplete exceptions fail', () => {
  const changes = [
    { expires_at: '2026-09-11' }, { expires_at: '2026-09-10' }, { expires_at: '2026-10-02' },
    { approved_at: '2026-09-12' }, { approved_at: '2026-09-31' }, { expires_at: 'not-a-date' },
    { expires_at: '2026-09-01T00:00:00Z' }, { owner: '' }, { owner: '@TODO' }, { rationale: 'accepted' },
    { version: '*' }, { version: '^8.2.2' }, { advisory: '*' }, { severity: 'unknown' }, { extra: 'field' },
  ];
  for (const change of changes) {
    const data = fixture();
    Object.assign(data.policy.exceptions[0], change);
    assert.equal(gate(data).status, 1, JSON.stringify(change));
  }
  for (const field of Object.keys(fixture().policy.exceptions[0])) {
    const data = fixture(); delete data.policy.exceptions[0][field]; assert.equal(gate(data).status, 1, field);
  }
  const data = fixture(); data.policy.exceptions.push(structuredClone(data.policy.exceptions[0]));
  assert.equal(gate(data).status, 1);
});
test('audit command failures, unusable reports and unknown vulnerability chains fail closed', () => {
  for (const code of [2, 127, -1]) { const data = fixture(); data.code = code; assert.equal(gate(data).status, 1); }
  for (const audit of [{}, { error: { code: 'EAI_AGAIN' } }, '{invalid', { auditReportVersion: 2, vulnerabilities: {} }]) {
    const data = fixture(); data.audit = audit; assert.equal(gate(data).status, 1);
  }
  for (const mutate of [
    d => { d.audit.metadata.vulnerabilities.total = 0; },
    d => { d.audit.vulnerabilities['find-my-way'].via = ['missing']; },
    d => { d.audit.vulnerabilities['find-my-way'].via = ['find-my-way']; },
    d => { d.audit.vulnerabilities['find-my-way'].nodes = ['node_modules/missing']; },
    d => { d.lock.packages = {}; },
    d => { d.audit.vulnerabilities['find-my-way'].via[0].url = 'https://example.invalid/advisory'; },
  ]) { const data = fixture(); mutate(data); assert.equal(gate(data).status, 1); }
});
test('zero findings only pass with valid usable output and a successful audit exit', () => {
  const data = fixture();
  data.audit.vulnerabilities = {};
  data.audit.metadata.vulnerabilities.high = 0;
  data.audit.metadata.vulnerabilities.total = 0;
  data.policy.exceptions = [];
  assert.equal(gate(data).status, 1);
  data.code = 0;
  assert.equal(gate(data).status, 0);
});

test('duplicate JSON fields and non-integer schema versions are invalid approvals', () => {
  const data = fixture();
  data.policy = '{"schema_version":1,"exceptions":[],"exceptions":[]}';
  assert.match(gate(data).stderr, /Duplicate JSON field/);
  data.policy = { schema_version: true, exceptions: [] };
  assert.equal(gate(data).status, 1);
});
