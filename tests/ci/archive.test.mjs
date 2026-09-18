import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const python = (code) => execFileSync('python3', ['-c', code], { env: { ...process.env, PYTHONPATH: resolve('scripts') }, encoding: 'utf8' });

test('archive policy rejects traversal, duplicates, symlinks, SDK runtime residue and unexpected files', () => {
  assert.match(python(`
import io, tarfile, json, zipfile, tempfile, hashlib
from release.archive import read_archive, read_zip, check_package, no_residue, extract_for_scan
def archive(names):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w:gz') as tar:
        for name, kind in names:
            info=tarfile.TarInfo(name)
            if kind=='link': info.type=tarfile.SYMTYPE; info.linkname='outside'
            else: info.size=1
            tar.addfile(info,io.BytesIO(b'x') if kind!='link' else None)
    return out.getvalue()
for names in [[('../escape','file')],[('/absolute','file')],[('one','file'),('one','file')],[('link','link')]]:
    try: read_archive(archive(names)); raise AssertionError('accepted unsafe archive')
    except ValueError: pass
for path in ['package/node_modules/@pimlico/alto/run.js','package/.env','package/keys/private.pem','package/cache.sqlite','package/.local/state']:
    try: no_residue(path); raise AssertionError('accepted residue')
    except ValueError: pass
files={p:{'data':b'x'} for p in ['package/package.json','package/LICENSE','package/README.md','package/dist/index.js','package/dist/index.d.ts','package/start-worker.sh']}
files['package/package.json']['data']=json.dumps({'name':'@cardano-on-evm/sdk','version':'2.3.4'}).encode()
try: check_package(files,'sdk','2.3.4'); raise AssertionError('accepted unexpected SDK file')
except ValueError: pass
files.pop('package/start-worker.sh')
files['package/package.json']['data']=json.dumps({'name':'@cardano-on-evm/sdk','version':'2.3.4','dependencies':{'innocent-alias':'npm:@pimlico/alto@0.0.21'}}).encode()
try: check_package(files,'sdk','2.3.4'); raise AssertionError('accepted Alto alias')
except ValueError: pass
zipdata=io.BytesIO()
with zipfile.ZipFile(zipdata,'w') as zipped: zipped.writestr('../escape','bad')
try: read_zip(zipdata.getvalue()); raise AssertionError('accepted ZIP traversal')
except ValueError: pass
zipdata=io.BytesIO()
with zipfile.ZipFile(zipdata,'w') as zipped: zipped.writestr('.env','secret fixture')
data=zipdata.getvalue()
with tempfile.TemporaryDirectory() as directory:
    try:
        extract_for_scan({'trace.zip':{'data':data,'sha256':hashlib.sha256(data).hexdigest(),'size':len(data),'executable':False}},directory)
        raise AssertionError('nested ZIP residue was not inspected')
    except ValueError: pass
print('negative archive cases passed')
`), /negative archive cases passed/);
});

test('deterministic source archives derive another version and use the shared source inventory', () => {
  assert.match(python(`
import tempfile,json,hashlib
from pathlib import Path
from source_release import source_files,write_source_archive
from ci.evidence import source_files as shared_source_files
from release.archive import read_archive
assert source_files is shared_source_files
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)
    (root/'package.json').write_text(json.dumps({'name':'fixture','version':'2.3.4'}))
    (root/'.changeset').mkdir(); (root/'.changeset/config.json').write_text('{}')
    (root/'artifacts').mkdir(); (root/'artifacts/build.json').write_text('generated')
    (root/'evidence/release').mkdir(parents=True); (root/'evidence/release/old.json').write_text('historical')
    (root/'README.md').write_text('fixture')
    first=root/'first.tar.gz'; second=root/'second.tar.gz'
    write_source_archive(root,list(source_files(root)),first)
    write_source_archive(root,list(source_files(root)),second)
    assert first.read_bytes()==second.read_bytes()
    files=read_archive(first)
    assert set(files)=={'cardano-on-evm-2.3.4/package.json','cardano-on-evm-2.3.4/README.md','cardano-on-evm-2.3.4/.changeset/config.json'}
    (root/'README.md').write_text('altered')
    write_source_archive(root,list(source_files(root)),second)
    assert first.read_bytes()!=second.read_bytes()
print('versioned source archive passed')
`), /versioned source archive passed/);
});
