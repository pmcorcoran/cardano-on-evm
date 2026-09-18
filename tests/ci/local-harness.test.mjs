import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../scripts/ci/local-harness.py', import.meta.url));
const bootstrap = `import json,os,sys,tempfile,runpy,hashlib,socket,subprocess,time
from pathlib import Path
helper=runpy.run_path(sys.argv[1]); Harness=helper['Harness']
with tempfile.TemporaryDirectory(prefix='kernel-harness-test-') as work:
    os.chdir(work)
    Path('package.json').write_text('{"version":"0.1.0"}')
`;

test('local harness preserves source bytes, records command failures and refuses evidence reuse', () => {
  const script = bootstrap + `    out=Path(work)/'.local/run'
    h=Harness(out,'regression')
    original=Path('package.json').read_bytes()
    assert h.report['sourceFiles']==[{'path':'package.json','sha256':hashlib.sha256(original).hexdigest(),'executable':False}]
    assert h.report['gitSource']['ordinaryAddPassed'] is True and h.report['gitSource']['checkoutIndexVerified'] is True
    h.run('expected-pin-failure',[sys.executable,'-c','import sys; print("Pinned bytecode changed"); sys.exit(1)'],expected_failure='Pinned bytecode changed')
    try:
        h.run('unexpected-failure',[sys.executable,'-c','raise RuntimeError("regression fixture")'])
    except RuntimeError as error:
        h.finish(error)
    else:
        raise AssertionError('Failure became success')
    report=json.loads((out/'report.json').read_text())
    assert report['allChecksPassed'] is False and report['stageRemoved'] is True
    assert report['steps'][0]['exitCode']==1 and report['steps'][0]['expectedFailureObserved'] is True
    assert report['steps'][1]['exitCode']!=0 and report['steps'][1]['passed'] is False
    assert Path('package.json').read_bytes()==original
    before=(out/'report.json').read_bytes()
    try:
        Harness(out,'regression')
    except RuntimeError as error:
        assert 'never overwritten' in str(error)
    else:
        raise AssertionError('Reused evidence output accepted')
    assert (out/'report.json').read_bytes()==before
`;
  const result = spawnSync('python3', ['-c', script, helper], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('staged source content and executable-bit mutation cannot pass acceptance', () => {
  const script = bootstrap + `    for mode in ['bytes','executable']:
        h=Harness(Path(work)/('.local/'+mode),'mutation')
        target=h.stage/'package.json'
        if mode=='bytes': target.write_text('{"version":"9.9.9"}')
        else: target.chmod(0o755)
        h.run('success-does-not-authorize-source-mutation',[sys.executable,'-c','pass'])
        try:
            h.finish()
        except RuntimeError as error:
            assert 'source bytes or executable modes changed' in str(error)
        else:
            raise AssertionError('Mutated tested source passed')
        report=json.loads((h.out/'report.json').read_text())
        assert report['allChecksPassed'] is False and report['sourceUnchangedDuringValidation'] is False
        assert not h.stage.exists()
    h=Harness(Path(work)/'.local/restored','restored')
    target=h.stage/'package.json'; original=target.read_bytes()
    target.write_text('temporary negative-test mutation'); target.write_bytes(original)
    h.finish()
    assert json.loads((h.out/'report.json').read_text())['allChecksPassed'] is True
`;
  const result = spawnSync('python3', ['-c', script, helper], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('a copy race fails and preserves diagnostic evidence without keeping the stage', () => {
  const script = bootstrap + `    from unittest.mock import patch
    import shutil
    copy=shutil.copy2
    def changed(source,destination,*args,**kwargs):
        result=copy(source,destination,*args,**kwargs)
        if Path(source).name=='package.json': Path(destination).write_text('{"version":"9.9.9"}')
        return result
    out=Path(work)/'.local/copy-race'
    with patch.object(shutil,'copy2',changed):
        try:
            Harness(out,'copy-race')
        except RuntimeError as error:
            assert 'changed during the Git candidate copy' in str(error)
        else:
            raise AssertionError('Copy race passed')
    report=json.loads((out/'report.json').read_text())
    assert report['allChecksPassed'] is False and report['stageRemoved'] is True
    assert not Path(report['stage']).exists()
`;
  const result = spawnSync('python3', ['-c', script, helper], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('local harness failure closes a real service and removes its disposable stage', () => {
  const script = bootstrap + `    out=Path(work)/'.local/run'
    h=Harness(out,'cleanup')
    listener=socket.socket(); listener.bind(('127.0.0.1',0)); port=listener.getsockname()[1]; listener.close()
    child=h.start('http',[sys.executable,'-m','http.server',str(port),'--bind','127.0.0.1'],guarded=False)
    try:
        h.ready('http://127.0.0.1:'+str(port),child)
    finally:
        h.finish(RuntimeError('intentional acceptance failure'))
    assert child.poll() is not None
    assert not h.stage.exists()
    connection=socket.socket(); connection.settimeout(1)
    assert connection.connect_ex(('127.0.0.1',port)) != 0
    connection.close()
    report=json.loads((out/'report.json').read_text())
    assert report['servicesStopped'] is True and report['allChecksPassed'] is False
`;
  const result = spawnSync('python3', ['-c', script, helper], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('service readiness has a bounded deadline, accepts delayed startup, and fails on process exit', () => {
  const script = bootstrap + `    h=Harness(Path(work)/'.local/readiness','readiness')
    listener=socket.socket(); listener.bind(('127.0.0.1',0)); port=listener.getsockname()[1]; listener.close()
    child=h.start('delayed-http',[sys.executable,'-c',"import time,http.server; time.sleep(.75); http.server.HTTPServer(('127.0.0.1',"+str(port)+"),http.server.SimpleHTTPRequestHandler).serve_forever()"],guarded=False)
    url='http://127.0.0.1:'+str(port)
    try:
        try:
            h.ready(url,child,timeout=.2)
        except RuntimeError as error:
            assert 'readiness timed out' in str(error)
        else:
            raise AssertionError('A service passed before it was listening')
        short=h.report['serviceReadiness'][-1]
        assert short['ready'] is False and short['elapsedSeconds'] < 3
        h.ready(url,child)
        delayed=h.report['serviceReadiness'][-1]
        assert delayed['ready'] is True and delayed['timeoutSeconds']==120
        exited=h.start('exited',[sys.executable,'-c','raise SystemExit(7)'],guarded=False)
        exited.wait(timeout=10)
        try:
            h.ready(url,exited)
        except RuntimeError as error:
            assert 'exited before readiness' in str(error)
        else:
            raise AssertionError("An exited process passed another service's health check")
        assert h.report['serviceReadiness'][-1]['ready'] is False
    finally:
        h.finish()
    assert child.poll() is not None and not h.stage.exists()
`;
  const result = spawnSync('python3', ['-c', script, helper], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
