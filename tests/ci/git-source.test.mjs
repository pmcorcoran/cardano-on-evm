import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../scripts/ci/git-source.py', import.meta.url));
const bootstrap = `import json,os,sys,tempfile,runpy,subprocess,hashlib
from pathlib import Path
helper=runpy.run_path(sys.argv[1]); export=helper['export_source']; inventory=helper['inventory']
with tempfile.TemporaryDirectory(prefix='kernel-git-source-test-') as work:
    root=Path(work)/'source'; root.mkdir()
    def write(path,content='fixture',mode=0o644):
        target=root/path; target.parent.mkdir(parents=True,exist_ok=True); target.write_text(content); target.chmod(mode)
    write('package.json','{"version":"0.1.0"}')
    destination=Path(work)/'checkout'
`;
function run(script) {
  const result = spawnSync('python3', ['-c', bootstrap + script, helper], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test('ordinary Git add exports pinned nested artifacts, hashes, executable bits, and excludes generated outputs', () => {
  run(`    write('.gitignore','/artifacts/\\nnode_modules/\\n.local/\\n.venv/\\n.cache/\\ntest-results/\\nplaywright-report/\\n*.sqlite*\\n')
    write('vendor/entrypoint-v07/artifacts/EntryPoint.json','pinned upstream bytecode')
    write('scripts/tool with spaces.py','#!/usr/bin/env python3\\n',0o755)
    write('packages/sdk/LICENSE','library license input')
    for path in ['artifacts/build.json','node_modules/dependency/index.js','packages/contracts/artifacts/Current.json','packages/sdk/dist/index.js','.local/output.json','.venv/tool','.cache/cache','test-results/report.json','playwright-report/index.html','scripts/state.sqlite','evidence/local/report.json']:
        write(path)
    expected=inventory(root)
    result=export(root,destination)
    assert result['ordinaryAddPassed'] is True and result['checkoutIndexVerified'] is True
    assert result['sourceFileCount']==len(expected)==5
    assert result['sourceInventoryHash']==hashlib.sha256(helper['canonical'](expected)).hexdigest()
    assert inventory(destination)==expected
    assert (destination/'scripts/tool with spaces.py').stat().st_mode & 0o111
    assert not (destination/'package.json').stat().st_mode & 0o111
    assert not (destination/'.git').exists()
    assert sorted(path.relative_to(destination).as_posix() for path in destination.rglob('*') if path.is_file())==[row['path'] for row in expected]
`);
});

test('an intentionally ignored required fixture fails without force-adding it', () => {
  run(`    write('.gitignore','artifacts/\\n')
    write('vendor/entrypoint-v07/artifacts/EntryPoint.json')
    before=inventory(root)
    try:
        export(root,destination)
    except RuntimeError as error:
        assert 'Ordinary git add omitted required source inputs' in str(error)
        assert 'vendor/entrypoint-v07/artifacts/EntryPoint.json' in str(error)
        assert '.gitignore' in str(error) and 'artifacts/' in str(error)
    else:
        raise AssertionError('Ignored source was force-added or silently omitted')
    assert inventory(root)==before and not any(destination.iterdir())
`);
});

test('nested and repository-local ignore rules are enforced without touching the real index', () => {
  run(`    write('fixtures/current.json')
    subprocess.run(['git','init','--quiet',str(root)],check=True)
    subprocess.run(['git','-C',str(root),'add','package.json'],check=True)
    index=root/'.git/index'; original=index.read_bytes()
    write('.git/info/exclude','fixtures/current.json\\n')
    os.environ['GIT_INDEX_FILE']=str(index)
    os.environ['GIT_DIR']=str(root/'.git')
    try:
        export(root,destination)
    except RuntimeError as error:
        assert 'fixtures/current.json' in str(error) and 'info/exclude' in str(error)
    else:
        raise AssertionError('Repository-local ignored fixture passed')
    assert index.read_bytes()==original
    write('.git/info/exclude','')
    write('fixtures/.gitignore','current.json\\n')
    try:
        export(root,destination)
    except RuntimeError as error:
        assert 'fixtures/.gitignore' in str(error)
    else:
        raise AssertionError('Nested ignored fixture passed')
    write('fixtures/.gitignore','')
    assert export(root,destination)['realIndexModified'] is False
    assert index.read_bytes()==original
`);
});

test('changed input expectations and reused output directories reject', () => {
  run(`    expected=inventory(root)
    write('package.json','changed')
    try:
        export(root,destination,expected)
    except RuntimeError as error:
        assert 'changed during the Git candidate copy' in str(error)
    else:
        raise AssertionError('Changed source passed')
    export(root,destination)
    before=(destination/'package.json').read_bytes()
    try:
        export(root,destination)
    except RuntimeError as error:
        assert 'destination must be empty' in str(error)
    else:
        raise AssertionError('Existing export overwritten')
    assert (destination/'package.json').read_bytes()==before
`);
});
