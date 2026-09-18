import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const lanes = ['context', 'fast', 'core', 'bundler', 'security', 'codeql'];
const successful = () => Object.fromEntries(lanes.map(name => [name, { result: 'success' }]));
const check = (event, needs, candidate = false) => spawnSync('python3', ['scripts/ci/required.py', '--event', event, '--candidate', String(candidate), '--needs', JSON.stringify(needs)], { encoding: 'utf8', timeout: 30000 });
const checkBatch = cases => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'kernel-required-cases-'));
  try {
    const input = path.join(temporary, 'cases.json');
    writeFileSync(input, JSON.stringify(cases));
    const result = spawnSync('python3', ['-c', 'import json,sys; sys.path.insert(0,"scripts/ci"); import required; cases=json.load(open(sys.argv[1])); print(json.dumps([required.check(row["event"], row["candidate"], row["needs"]) for row in cases]))', input], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

for (const event of ['pull_request', 'push', 'workflow_call', 'workflow_dispatch', 'merge_group']) {
  test(`${event}: every required lane must explicitly succeed`, () => {
    assert.equal(check(event, successful()).status, 0);
    const cases = [];
    for (const lane of lanes) {
      for (const state of ['failure', 'cancelled', 'skipped', 'pending', '', null, undefined]) {
        const needs = successful();
        if (state === undefined) delete needs[lane];
        else needs[lane].result = state;
        cases.push({ event, needs, candidate: false, label: `${lane} ${state}` });
      }
    }
    const results = checkBatch(cases);
    assert.equal(results.length, cases.length);
    results.forEach((failures, index) => assert.ok(failures.length, cases[index].label));
  });
}
test('nightly requires security and all CodeQL analyses, independently of network and local lanes', () => {
  const needs = successful();
  for (const lane of ['fast', 'core', 'bundler']) needs[lane].result = 'skipped';
  needs.network = { result: 'failure' };
  assert.equal(check('schedule', needs).status, 0);
  for (const lane of ['context', 'security', 'codeql']) {
    const altered = structuredClone(needs);
    altered[lane].result = 'skipped';
    assert.equal(check('schedule', altered).status, 1);
  }
  assert.equal(check('schedule', needs, true).status, 1, 'candidate always requires complete local lanes');
});
test('unknown events and malformed needs fail closed', () => {
  for (const event of ['pull_request_target', 'workflow_run', '', 'unknown']) assert.equal(check(event, successful()).status, 1);
  for (const needs of [null, [], 'success', {}, { core: 'success' }]) assert.equal(check('pull_request', needs).status, 1);
});

test('workflow event wiring keeps full candidate/PR lanes, fork boundaries and matrix members', () => {
  const workflow = readFileSync('.github/workflows/check.yml', 'utf8');
  const block = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.match(workflow, /pull_request:\n/);
  assert.match(workflow, /push:\n    branches: \[main\]/);
  assert.match(workflow, /workflow_call:\n/);
  assert.doesNotMatch(workflow, /pull_request_target:|workflow_run:|paths(?:-ignore)?:|branches-ignore:|continue-on-error:|secrets\./);
  for (const lane of ['fast', 'core', 'bundler']) assert.match(block(lane), /if: \$\{\{ github.event_name != 'schedule' \|\| inputs.candidate \}\}/);
  for (const lane of ['security', 'codeql']) assert.doesNotMatch(block(lane), /^    if:/m);
  assert.match(block('fast'), /node: 22\.18\.0\n\s+suite: fast-node22/);
  assert.match(block('fast'), /node: 24\.x\n\s+suite: fast-node24/);
  assert.match(block('fast'), /node: 26\.8\.1\n\s+suite: fast-node26/);
  assert.match(block('codeql'), /language: \[javascript-typescript, python, actions\]/);
  assert.match(block('codeql'), /scripts\/ci\/codeql\.py/);
  assert.match(block('ci-required'), /if: \$\{\{ always\(\) \}\}/);
  assert.match(block('ci-required'), /needs: \[context, fast, core, bundler, security, codeql\]/);
  assert.match(block('ci-required'), /--context .local\/ci\/context.json --reports .local\/ci\/reports/);
  assert.match(block('network'), /!inputs.candidate && \(github.event_name == 'schedule' \|\| github.event_name == 'workflow_dispatch'\)/);
  for (const line of workflow.split('\n').filter(line => /- uses:/.test(line))) assert.match(line, /@[a-f0-9]{40}(?: |$)/);
  for (const use of workflow.split('      - uses: actions/cache@').slice(1)) assert.match(use.split('      - ')[0], /if: \$\{\{ !inputs.candidate \}\}/);
  for (const use of workflow.split('      - uses: actions/upload-artifact@').slice(1)) {
    assert.match(use.split('      - ')[0], /if: always\(\)/);
    assert.match(use.split('      - ')[0], /include-hidden-files: true/);
  }
  assert.ok(workflow.split('runs-on:').slice(1).every(part => part.startsWith(' ubuntu-24.04')));
});
