import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function sarif(score = '5.0', results = true) {
  return { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL', rules: [{ id: 'js/test', properties: { tags: ['security'], 'security-severity': score } }] } }, invocations: [{ executionSuccessful: true }], results: results ? [{ ruleId: 'js/test', baselineState: 'unchanged', suppressions: [{ kind: 'external', status: 'accepted' }] }] : [] }] };
}
function gate(document) {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-codeql-policy-'));
  try {
    if (document !== undefined) writeFileSync(join(dir, 'result.sarif'), typeof document === 'string' ? document : JSON.stringify(document));
    const child = spawnSync('python3', ['scripts/ci/codeql.py', '--sarif', dir, '--out', join(dir, 'policy.json')], { encoding: 'utf8' });
    return { code: child.status, report: JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('CodeQL blocks all high/critical results even unchanged/suppressed findings', () => {
  for (const score of ['7', '8.9', '9', '10']) {
    const result = gate(sarif(score));
    assert.equal(result.code, 1);
    assert.equal(result.report.findings.length, 1);
  }
  assert.equal(gate(sarif('6.9')).code, 0);
  assert.equal(gate(sarif('10', false)).code, 0, 'executed rules with no results are valid');
});
test('CodeQL fails on absent/malformed output, unknown rules and unusable severity', () => {
  for (const value of [undefined, '{invalid', {}, { version: '2.1.0', runs: [] }, sarif('NaN'), sarif('Infinity'), sarif('-1'), sarif('11'), sarif(null), sarif(true)]) assert.equal(gate(value).code, 1);
  const duplicate = JSON.stringify(sarif('9')).replace('"results":[', '"results":[],"results":[');
  assert.equal(gate(duplicate).code, 1, 'duplicate JSON fields are unusable analyzer output');
  const invalid = sarif();
  invalid.runs[0].tool.driver.rules = [];
  invalid.runs[0].results = [];
  assert.equal(gate(invalid).code, 1);
  invalid.runs[0].results = [{ ruleId: 'missing' }];
  assert.equal(gate(invalid).code, 1);
});
test('CodeQL execution errors never become empty success', () => {
  const failed = sarif('1.0', false);
  failed.runs[0].invocations[0].executionSuccessful = false;
  assert.equal(gate(failed).code, 1);
  failed.runs[0].invocations = [{ executionSuccessful: true, toolExecutionNotifications: [{ level: 'error' }] }];
  assert.equal(gate(failed).code, 1);
  failed.runs[0].tool.driver.name = 'other';
  assert.equal(gate(failed).code, 1);
});

function queryPackSarif(score = '8.0', results = true) {
  const document = sarif(score, results), run = document.runs[0];
  run.tool.extensions = [{ name: 'codeql/javascript-queries', rules: run.tool.driver.rules }, { name: 'codeql/javascript-all' }];
  run.tool.driver.rules = [];
  for (const result of run.results) result.rule = { id: result.ruleId, index: 0, toolComponent: { index: 0 } };
  return document;
}
test('CodeQL query-pack SARIF uses extension rules and retains the severity gate', () => {
  assert.equal(gate(queryPackSarif('8.0')).report.findings.length, 1);
  assert.equal(gate(queryPackSarif('8.0')).code, 1);
  assert.equal(gate(queryPackSarif('6.9')).code, 0);
  assert.equal(gate(queryPackSarif('8.0', false)).code, 0);
  const collision = queryPackSarif('8.0');
  collision.runs[0].tool.driver.rules = sarif('1.0').runs[0].tool.driver.rules;
  assert.equal(gate(collision).code, 1, 'a driver rule with the same ID must not hide the extension finding');
});
test('CodeQL rejects inconsistent or missing extension rule references', () => {
  for (const mutate of [
    r => { r.rule.toolComponent.index = 99; },
    r => { r.rule.toolComponent.index = true; },
    r => { r.rule.toolComponent.index = -2; },
    r => { r.rule.toolComponent.name = 'wrong-pack'; },
    r => { r.rule.index = 99; },
    r => { r.ruleIndex = 99; },
    r => { r.rule.id = 'missing'; },
    r => { r.ruleId = 'missing'; },
    r => { delete r.rule; },
  ]) {
    const document = queryPackSarif(); mutate(document.runs[0].results[0]);
    assert.equal(gate(document).code, 1);
  }
  const mismatch = queryPackSarif();
  mismatch.runs[0].tool.extensions[0].rules.push({ id: 'js/other', properties: { 'security-severity': '1' } });
  mismatch.runs[0].results[0].rule.index = 1;
  assert.match(gate(mismatch).report.error, /identity mismatch/);
  const failed = queryPackSarif('8', false);
  failed.runs[0].invocations[0].executionSuccessful = false;
  assert.equal(gate(failed).code, 1);
});
