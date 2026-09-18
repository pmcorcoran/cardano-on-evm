import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = resolve('scripts/ci/evidence.py');
const python = process.env.PYTHON ?? 'python3';
function invoke(root, args, env = {}) {
  return spawnSync(python, [script, '--root', root, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000,
  });
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'kernel-evidence-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"name":"evidence-test","version":"0.1.0","private":true}\n');
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/input.mjs'), 'export const value = 1;\n');
  const out = join(root, '.local/run');
  const context = join(out, 'context.json'), reports = join(out, 'reports');
  assert.equal(invoke(root, ['init', '--out', out, '--mode', 'local']).status, 0);
  return { root, out, context, reports };
}
function produce(f, suite = 'example', command = [process.execPath, '-e', 'console.log("real command executed")']) {
  return invoke(f.root, ['run', '--context', f.context, '--suite', suite, '--out', f.out, '--', ...command]);
}
function verify(f, extra = []) {
  return invoke(f.root, ['verify', '--context', f.context, '--reports', f.reports, '--suites', 'example', ...extra]);
}
function changeReport(f, change) {
  const path = join(f.reports, 'example.json'), report = JSON.parse(readFileSync(path));
  change(report); writeFileSync(path, JSON.stringify(report));
}
test('current command evidence verifies; same-suite overwrite and local release promotion fail', t => {
  const f = fixture(t);
  assert.equal(produce(f).status, 0);
  assert.equal(verify(f).status, 0);
  assert.notEqual(produce(f).status, 0);
  assert.notEqual(verify(f, ['--candidate']).status, 0);
});
test('missing suites and failed commands cannot pass verification', t => {
  const f = fixture(t);
  assert.notEqual(verify(f).status, 0);
  assert.equal(produce(f, 'example', [process.execPath, '-e', 'process.exit(7)']).status, 7);
  assert.notEqual(verify(f).status, 0);
  assert.equal(JSON.parse(readFileSync(join(f.reports, 'example.json'))).commands[0].exitCode, 7);
});
test('logs altered after completion are rejected', t => {
  const f = fixture(t); assert.equal(produce(f).status, 0);
  writeFileSync(join(f.out, 'logs/example.log'), 'replacement log');
  assert.match(verify(f).stderr, /missing or changed/);
});
test('context regeneration does not let copied historical reports pass', t => {
  const f = fixture(t); assert.equal(produce(f).status, 0);
  const newer = join(f.root, '.local/new-run');
  assert.equal(invoke(f.root, ['init', '--out', newer]).status, 0);
  writeFileSync(f.context, readFileSync(join(newer, 'context.json')));
  assert.notEqual(verify(f).status, 0);
});
test('source edits and executable bit changes invalidate current-run evidence', t => {
  const f = fixture(t); assert.equal(produce(f).status, 0);
  chmodSync(join(f.root, 'scripts/input.mjs'), 0o755);
  assert.match(verify(f).stderr, /inventory changed/);
  chmodSync(join(f.root, 'scripts/input.mjs'), 0o644);
  writeFileSync(join(f.root, 'scripts/input.mjs'), 'export const value = 2;\n');
  assert.match(verify(f).stderr, /inventory changed/);
});
test('builds/caches/current and historical release reports cannot make the inventory hash itself', t => {
  const f = fixture(t); assert.equal(produce(f).status, 0);
  for (const dir of ['node_modules/demo', 'dist', 'artifacts', 'packages/contracts/artifacts', 'packages/sdk/dist', 'evidence/release', 'evidence/local', 'licenses/npm']) {
    mkdirSync(join(f.root, dir), { recursive: true });
    writeFileSync(join(f.root, dir, 'generated.json'), '{"historical":true}');
  }
  assert.equal(verify(f).status, 0);
  mkdirSync(join(f.root, 'fixtures'), { recursive: true });
  writeFileSync(join(f.root, 'fixtures/pin.json'), '{}');
  assert.match(verify(f).stderr, /inventory changed/);
});
test('source links and evidence links fail closed', t => {
  const f = fixture(t); assert.equal(produce(f).status, 0);
  const log = join(f.out, 'logs/example.log');
  const content = readFileSync(log); rmSync(log); writeFileSync(join(f.root, '.local/copied.log'), content);
  symlinkSync('../copied.log', log);
  assert.notEqual(verify(f).status, 0);
  symlinkSync('/etc/passwd', join(f.root, 'scripts/link'));
  assert.match(invoke(f.root, ['inventory']).stderr, /special file/);
});
for (const [name, edit] of [
  ['commit', r => { r.commit = '1'.repeat(40); }],
  ['inventory', r => { r.sourceInventoryHash = '1'.repeat(64); }],
  ['run attempt', r => { r.run.attempt = '2'; }],
  ['empty commands', r => { r.commands = []; }],
  ['unrecorded command log', r => { r.commands[0].log = 'missing.log'; }],
  ['boolean exit status', r => { r.commands[0].exitCode = false; }],
  ['boolean schema version', r => { r.schemaVersion = true; }],
  ['stale timestamp', r => { r.startedAt = '2020-01-01T00:00:00Z'; }],
  ['future timestamp', r => { r.completedAt = '2999-01-01T00:00:00Z'; }],
  ['missing evidence', r => { r.evidence = []; }],
  ['traversal', r => { r.evidence[0].path = '../outside'; }],
  ['toolchain omitted', r => { r.toolchain = {}; }],
]) {
  test(`rejects malformed or mismatched report: ${name}`, t => {
    const f = fixture(t); assert.equal(produce(f).status, 0);
    changeReport(f, edit); assert.notEqual(verify(f).status, 0);
  });
}
test('duplicate JSON fields are rejected instead of selecting the last status', t => {
  const f = fixture(t); assert.equal(produce(f).status, 0);
  const path = join(f.reports, 'example.json');
  writeFileSync(path, readFileSync(path, 'utf8').replace('"status": "success"', '"status":"failure","status":"success"'));
  assert.match(verify(f).stderr, /Duplicate JSON key/);
});
test('boolean context schema and inventory versions are rejected', t => {
  const f = fixture(t);
  const original = JSON.parse(readFileSync(f.context));
  for (const field of ['schemaVersion', 'inventoryVersion']) {
    writeFileSync(f.context, JSON.stringify({ ...original, [field]: true }));
    assert.notEqual(produce(f).status, 0);
  }
});
test('a command that mutates source cannot produce success even when it exits zero', t => {
  const f = fixture(t);
  const r = produce(f, 'example', [process.execPath, '-e', 'require("fs").writeFileSync("scripts/input.mjs", "changed")']);
  assert.notEqual(r.status, 0);
  const report = JSON.parse(readFileSync(join(f.reports, 'example.json')));
  assert.equal(report.commands[0].exitCode, 0); assert.equal(report.status, 'failure');
});
test('GitHub evidence requires real clean committed inputs, not supplied commit strings', t => {
  const f = fixture(t), out = join(f.root, '.local/github');
  const env = { GITHUB_REPOSITORY: 'fixture/example', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'push', GITHUB_WORKFLOW_REF: 'fixture/example/.github/workflows/release.yml@refs/heads/main' };
  assert.notEqual(invoke(f.root, ['init', '--out', out, '--mode', 'candidate'], env).status, 0);
  function git(...args) { const r = spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); }
  git('init', '-q'); git('add', 'package.json', 'scripts');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Controlled test fixture');
  assert.equal(invoke(f.root, ['init', '--out', out, '--mode', 'candidate'], env).status, 0);
  assert.equal(JSON.parse(readFileSync(join(out, 'context.json'))).mode, 'candidate');
  writeFileSync(join(f.root, 'package.json'), '{"name":"changed"}');
  assert.notEqual(invoke(f.root, ['init', '--out', join(f.root, '.local/changed'), '--mode', 'candidate'], env).status, 0);
});
test('inventoried output locations are rejected before creating recursive context files', t => {
  const f = fixture(t);
  assert.match(invoke(f.root, ['init', '--out', join(f.root, 'docs/reports')]).stderr, /outside inventoried source/);
});
test('candidate toolchain gates reject substituted Node, npm, Solidity, browser and execution targets', () => {
  const code = `
import importlib.util,sys
spec=importlib.util.spec_from_file_location('evidence',sys.argv[1]); e=importlib.util.module_from_spec(spec); spec.loader.exec_module(e)
versions={'node':'v26.8.1','npm':'11.19.0','solc':'0.8.30+commit.73712a01.Emscripten.clang','python':'3.13.5','anvil':'anvil Version: 1.8.1','forge':'forge Version: 1.8.1','playwright':'1.62.0'}
for suite in ['core','bundler','package-consumer','security','codeql-actions','archive-scan','fast-node26']:
 e.check_toolchain({'suite':suite,'toolchain':versions})
for field,bad,suite in [('node','v26.8.2','core'),('npm','11.18.0','bundler'),('solc','0.8.31+commit.other','package-consumer'),('python','3.12.0','core'),('anvil','anvil Version: 1.7.1','core'),('forge','forge Version: 1.7.1','bundler'),('playwright','1.61.0','core'),('node','v22.18.1','fast-node22'),('node','v25.0.0','fast-node24')]:
 try: e.check_toolchain({'suite':suite,'toolchain':{**versions,field:bad}})
 except ValueError: continue
 raise AssertionError('Substituted target was accepted: '+field)
`;
  const result = spawnSync(python, ['-c', code, script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test('expired candidate contexts fail before any missing report could be mistaken for success', t => {
  const f = fixture(t), context = JSON.parse(readFileSync(f.context));
  Object.assign(context, { mode: 'candidate', commit: '1'.repeat(40), repository: 'fixture/example', createdAt: '2020-01-01T00:00:00Z',
    run: { id: '123', attempt: '1', event: 'push', workflow: 'fixture/example/.github/workflows/release.yml@refs/heads/main' } });
  writeFileSync(f.context, JSON.stringify(context));
  const code = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('evidence',sys.argv[1]); e=importlib.util.module_from_spec(spec); spec.loader.exec_module(e)
try: e.verify(sys.argv[2],sys.argv[3],['core'],candidate=True)
except ValueError as error:
 assert 'expired after 24 hours' in str(error),str(error)
else: raise AssertionError('Expired candidate passed')`;
  const result = spawnSync(python, ['-c', code, script, f.context, f.reports], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
