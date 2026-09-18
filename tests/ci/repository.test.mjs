import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve('scripts/check-repository.py');
const ignore = resolve('.gitignore');
const bootstrap = `import sys,runpy,tempfile,subprocess,shutil
from pathlib import Path
module=runpy.run_path(sys.argv[1]); check=module['check_repository']; candidates=module['publication_candidates']
with tempfile.TemporaryDirectory(prefix='repository-policy-test-') as directory:
    root=Path(directory)/'source'; root.mkdir()
    def write(name,value='fixture'):
        p=root/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(value); return p
    def git(*args):
        return subprocess.run(['git','-C',str(root),*args],check=True,capture_output=True)
    shutil.copyfile(sys.argv[2],root/'.gitignore')
    write('README.md','# Fixture\\n\\n[Answer](fixtures/answer.json)\\n')
    write('fixtures/answer.json','{}\\n')
    required={'.gitignore','README.md','fixtures/answer.json'}
`;
function run(body) {
  const result = spawnSync('python3', ['-c', bootstrap + body, script, ignore], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('ordinary publication excludes operator files while preserving examples, locks, pins and notices', () => {
  run(`    git('init','--quiet')
    excluded=['submitter.env','infra/bundler/operator.env.backup','docs/.env.local','wallet.key.json','wallet.pem','wallet.p12','wallet.pfx','wallet.jks','wallet.keystore','wallet.skey.json','keystore.json','private-key.json','id_ed25519','wallet.age','wallet.kdbx','.vscode/settings.json','.agents/note.md','.codex/config.toml','AGENTS.md','docs/.history/note.md','evidence/local/report.json','evidence/release/build.json','scripts/__pycache__/cache.pyc','infra/bundler/.local/report.json']
    included=['.env.example','service.env.example','infra/bundler/config/service.env.sample','package-lock.json','infra/bundler/package-lock.json','infra/bundler/build-tools/package-lock.json','fixtures/frozen.json','vendor/entrypoint-v07/artifacts/EntryPoint.json','vendor/kernel/LICENSE.txt','licenses/supplemental/notice.txt','.editorconfig','.gitattributes','SECURITY.md','CONTRIBUTING.md','CODE_OF_CONDUCT.md']
    for name in excluded+included: write(name)
    paths=set(candidates(root))
    assert not paths.intersection(excluded),paths.intersection(excluded)
    assert set(included)<=paths,set(included)-paths
    report=check(root,required); assert report['status']=='passed',report
    git('add','--all')
    before=(root/'.git/index').read_bytes()
    assert check(root,required)['status']=='passed'
    assert before==(root/'.git/index').read_bytes()
`);
});

test('Git/inventory drift, ignored or deleted required inputs, and force-added local files fail', () => {
  run(`    git('init','--quiet')
    assert check(root,required)['status']=='passed'
    p=write('unreviewed-policy.toml'); assert any('missing from release inventory' in x for x in check(root,required)['errors']); p.unlink()
    with (root/'.gitignore').open('a') as f: f.write('\\nfixtures/answer.json\\n')
    report=check(root,required); assert any('omitted by Git' in x for x in report['errors']); assert any('Missing required' in x for x in report['errors'])
    shutil.copyfile(sys.argv[2],root/'.gitignore')
    (root/'fixtures/answer.json').unlink(); assert any('Missing required' in x for x in check(root,required)['errors'])
    write('fixtures/answer.json')
    write('submitter.env','SYNTHETIC_OPERATOR_VALUE=not-a-secret'); git('add','-f','submitter.env')
    before=(root/'.git/index').read_bytes()
    assert any('Prohibited' in x and 'submitter.env' in x for x in check(root,required)['errors'])
    assert before==(root/'.git/index').read_bytes()
`);
});

test('Markdown file, fragment, reference and HTML links are checked outside code examples', () => {
  run(`    write('docs/Guide (one).md',('# Heading with @code@\\n\\n## Repeated\\n## Repeated\\n').replace('@',chr(96)))
    good='# Fixture\\n\\n[good](<docs/Guide (one).md#heading-with-code>)\\n[duplicate](<docs/Guide (one).md#repeated-1>)\\n[reference][guide]\\n[shortcut]\\n[guide]: <docs/Guide (one).md>\\n[shortcut]: fixtures/answer.json\\n\\n@[inline](missing.md)@\\n\\n@@@md\\n[fenced](missing.md)\\n@@@\\n\\n    [indented](missing.md)\\n'
    good=good.replace('@',chr(96))
    write('README.md',good)
    report=check(root,required); assert report['status']=='passed',report
    for link in ['[bad](absent.md)','[bad](<docs/Guide (one).md#absent>)','[missing][undefined]','<a href="absent.md">bad</a>','- list\\n    - [bad](absent.md)','- list\\n    [bad](absent.md)','[private](.local/report.md)']:
        write('.local/report.md','# Private')
        write('README.md',good+'\\n'+link+'\\n')
        report=check(root,required); assert report['status']=='failed',(link,report)
`);
});

test('ordinary Git export preserves pinned CRLF bytes despite default LF attributes', () => {
  run(`    helper=runpy.run_path(str(Path(sys.argv[1]).parent/'ci/git-source.py'))
    write('.gitattributes','* text=auto eol=lf\\nfixtures/** -text\\nvendor/** -text\\n')
    frozen=root/'fixtures/answer.json'; frozen.write_bytes(b'{"frozen":true}\\r\\n')
    destination=Path(directory)/'export'
    result=helper['export_source'](root,destination)
    assert result['ordinaryAddPassed'] and result['checkoutIndexVerified']
    assert (destination/'fixtures/answer.json').read_bytes()==frozen.read_bytes()
    assert not (root/'.git').exists()
`);
});

test('required vendored inputs and supplemental notices must be published with their pinned bytes', () => {
  run(`    import hashlib,json
    digest=hashlib.sha256(b'fixture').hexdigest()
    write('vendor/kernel/LICENSE.txt')
    write('vendor/sources.json',json.dumps([{'name':'kernel','files':{'LICENSE.txt':digest}}]))
    write('licenses/supplemental/notice.txt')
    write('licenses/supplemental.json',json.dumps([{'file':'licenses/supplemental/notice.txt','sha256':digest}]))
    assert check(root,required)['status']=='passed'
    write('vendor/kernel/LICENSE.txt','changed'); assert any('vendor checksum mismatch' in x for x in check(root,required)['errors'])
    (root/'vendor/kernel/LICENSE.txt').unlink(); assert any('Missing required pinned vendor' in x for x in check(root,required)['errors'])
    write('vendor/kernel/LICENSE.txt')
    write('licenses/supplemental/notice.txt','changed'); assert any('notice checksum mismatch' in x for x in check(root,required)['errors'])
    (root/'licenses/supplemental/notice.txt').unlink(); assert any('Missing required supplemental' in x for x in check(root,required)['errors'])
`);
});
