"""Small shared lifecycle helper for disposable local validation lanes."""
import hashlib
import json
import os
import re
import runpy
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from source_release import write_json_report
from ci.evidence import inventory, canonical

export_source = runpy.run_path(str(Path(__file__).with_name('git-source.py')))['export_source']


def timestamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def executable(value):
    """Keep venv executable symlinks; dereferencing loses Python site-packages."""
    return str(Path(value).absolute()) if '/' in value else shutil.which(value) or value


class Harness:
    def __init__(self, out, kind, *, keep_stage=False):
        self.root = Path.cwd()
        self.out = Path(out).absolute()
        if self.out.exists() and any(self.out.iterdir()):
            raise RuntimeError('Output directory must be empty; existing evidence is never overwritten: ' + str(self.out))
        self.out.mkdir(parents=True, exist_ok=True)
        self.logs = self.out / 'logs'
        self.logs.mkdir()
        expected_source = inventory(self.root)
        self.files = [Path(item['path']) for item in expected_source]
        self.stage = Path(tempfile.mkdtemp(prefix='cardano-on-evm-' + kind + '-'))
        self.keep_stage = keep_stage
        self.children = []
        self.streams = []
        self.report = {'kind': kind, 'startedAt': timestamp(), 'allChecksPassed': False,
                       'stage': str(self.stage), 'steps': [], 'realWallet': False,
                       'publicTransactionsSent': 0, 'toolchain': {}, 'sourceFiles': expected_source,
                       'sourceInventoryHash': hashlib.sha256(canonical(expected_source)).hexdigest()}
        try:
            self.report['gitSource'] = export_source(self.root, self.stage, expected_source)
            for path in ['node_modules', 'artifacts', 'dist', 'infra/bundler/node_modules', 'infra/bundler/build-tools/node_modules', 'evidence/local', 'evidence/release', 'evidence/browser']:
                if (self.stage / path).exists():
                    raise RuntimeError('Source inventory included generated validation input: ' + path)
        except BaseException as failure:
            self.report['failure'] = str(failure)
            shutil.rmtree(self.stage)
            self.report['stageRemoved'] = True
            self.save()
            raise
        self.env = dict(os.environ)
        for name in list(self.env):
            if name.startswith(('ALTO_', 'BUNDLER_')) or any(part in name for part in ['PRIVATE_KEY', 'SUBMITTER', 'RPC_URL']) or name in ['NODE_OPTIONS', 'BROWSER_EXECUTABLE_PATH']:
                del self.env[name]
        self.env.update(BASE_SEPOLIA_RPC_URL='http://127.0.0.1:1', PUBLIC_BUNDLER_RPC_URL='http://127.0.0.1:1')
        (self.stage / 'evidence/local').mkdir(parents=True)
        (self.stage / '.local').mkdir(exist_ok=True)
        self.save()

    def save(self):
        write_json_report(self.out / 'report.json', self.report)

    def run(self, name, command, *, guarded=False, env=None, expected_failure=None, timeout=1800):
        child_env = dict(self.env)
        if env:
            child_env.update(env)
        if guarded:
            child_env['NODE_OPTIONS'] = '--import=' + str(self.stage / 'scripts/ci/local-network-guard.mjs')
            child_env['LOCAL_NETWORK_LOG'] = str(self.out / 'network-denials.jsonl')
        log = self.logs / (name + '.log')
        step = {'name': name, 'command': command, 'startedAt': timestamp(), 'log': str(log.relative_to(self.out)), 'externalNodeTcpDenied': guarded}
        self.report['steps'].append(step)
        self.save()
        with log.open('w') as stream:
            child = subprocess.Popen(command, cwd=self.stage, env=child_env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            self.children.append(child)
            try:
                code = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.stop(child)
                step['failure'] = 'Command timed out'
                self.save()
                raise
        step.update(exitCode=code, completedAt=timestamp())
        passed = code == 0
        if expected_failure:
            passed = code != 0 and expected_failure in log.read_text()
            step.update(expectedFailure=expected_failure, expectedFailureObserved=passed)
        step['passed'] = passed
        self.save()
        if not passed:
            print(log.read_text()[-12000:], flush=True)
            raise RuntimeError(name + ' failed; see ' + str(log))
        print(name + ' passed', flush=True)

    def start(self, name, command, *, guarded=True):
        env = dict(self.env)
        if guarded:
            env['NODE_OPTIONS'] = '--import=' + str(self.stage / 'scripts/ci/local-network-guard.mjs')
            env['LOCAL_NETWORK_LOG'] = str(self.out / 'network-denials.jsonl')
        stream = (self.logs / (name + '.log')).open('w')
        self.streams.append(stream)
        child = subprocess.Popen(command, cwd=self.stage, env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        self.children.append(child)
        return child

    def ports_available(self, ports):
        for port in ports:
            if not isinstance(port, int) or not 1024 <= port <= 65535:
                raise RuntimeError('Invalid local service port')
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))

    def ready(self, url, child, *, chain_id=None, timeout=120):
        # Cold TypeScript imports can exceed 20 seconds on a busy runner.
        # Bound elapsed time while still failing immediately on process exit.
        started = time.monotonic()
        deadline = started + timeout
        result = {'url': url, 'timeoutSeconds': timeout, 'ready': False}
        self.report.setdefault('serviceReadiness', []).append(result)
        try:
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise RuntimeError('Service exited before readiness: ' + url)
                try:
                    request = url
                    if chain_id is not None:
                        request = urllib.request.Request(url, data=b'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', headers={'content-type': 'application/json'})
                    with urllib.request.urlopen(request, timeout=min(1, max(.01, deadline - time.monotonic()))) as response:
                        if response.status == 200 and (chain_id is None or json.load(response).get('result') == hex(chain_id)):
                            result['ready'] = True
                            return
                except (OSError, ValueError):
                    pass
                time.sleep(min(.2, max(0, deadline - time.monotonic())))
            raise RuntimeError('Service readiness timed out: ' + url)
        finally:
            result['elapsedSeconds'] = round(time.monotonic() - started, 3)
            self.save()

    def require_toolchain(self, anvil, *, python=None, forge=None):
        tools = [('node', ['node', '--version'], 'v26.8.1'), ('npm', ['npm', '--version'], '11.19.0'), ('anvil', [anvil, '--version'], '1.8.1')]
        if forge:
            tools.append(('forge', [forge, '--version'], '1.8.1'))
        for name, command, expected in tools:
            actual = subprocess.check_output(command, text=True).strip()
            self.report['toolchain'][name] = actual
            if (name in ('node', 'npm') and actual != expected) or (name in ('anvil', 'forge') and ('Version: ' + expected not in actual or '982849d3140c01fd3b72905759581a132df7aa98' not in actual)):
                raise RuntimeError('Toolchain differs from the pinned target: ' + name)
        if python:
            locked = dict(re.findall(r'^([A-Za-z0-9_-]+)==([^\s]+)', (self.stage / 'tests/browser/requirements.txt').read_text(), re.MULTILINE))
            if locked.get('playwright') != '1.62.0' or not all(name in locked for name in ['greenlet', 'pyee', 'typing_extensions']):
                raise RuntimeError('Browser dependency lock is incomplete or changed target')
            value = json.loads(subprocess.check_output([python, '-c', 'import sys,json,importlib.metadata as m; print(json.dumps({"python":list(sys.version_info[:3]),"playwright":m.version("playwright"),"browserDependencies":{name:m.version(name) for name in json.loads(sys.argv[1])}}))', json.dumps(list(locked))], text=True))
            self.report['toolchain'].update(value)
            if value['python'][:2] != [3, 13] or value['playwright'] != '1.62.0':
                raise RuntimeError('Use Python 3.13 and Playwright 1.62.0 from tests/browser/requirements.txt')
            if value['browserDependencies'] != locked:
                raise RuntimeError('Installed browser dependencies differ from the hash-locked requirements')
            browser = subprocess.check_output([python, '-c', 'import json\nfrom playwright.sync_api import sync_playwright\nwith sync_playwright() as p:\n b=p.chromium.launch(headless=True,args=["--no-sandbox"])\n print(json.dumps({"chromiumVersion":b.version,"chromiumDefaultExecutable":p.chromium.executable_path}))\n b.close()'], text=True, env=self.env)
            self.report['toolchain'].update(json.loads(browser))
        self.save()

    @staticmethod
    def stop(child):
        # A failed direct child may still have workers in its process group.
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()

    def finish(self, error=None):
        source_error = None
        cleanup_errors = []
        for child in reversed(self.children):
            try:
                self.stop(child)
            except OSError as failure:
                cleanup_errors.append(str(failure))
        for stream in self.streams:
            stream.close()
        try:
            if inventory(self.stage) != self.report['sourceFiles']:
                raise RuntimeError('Tested source bytes or executable modes changed after the Git export')
        except Exception as failure:
            source_error = failure
            self.report['sourceContinuityFailure'] = str(failure)
        self.report['sourceUnchangedDuringValidation'] = source_error is None
        for path, destination in [('evidence/local', 'evidence/local'), ('evidence/release', 'evidence/release'), ('artifacts', 'artifacts'), ('.local/reference-http-evidence', 'reference-http-evidence')]:
            if (self.stage / path).exists():
                shutil.copytree(self.stage / path, self.out / destination, dirs_exist_ok=False)
        for source, destination in [('.local/example-infrastructure.json', 'infrastructure-deployment.json'), ('infra/bundler/.local/source-build-error.log', 'logs/alto-source-build-error.log')]:
            if (self.stage / source).exists():
                shutil.copy2(self.stage / source, self.out / destination)
        self.report.update(completedAt=timestamp(), servicesStopped=not cleanup_errors,
                           allChecksPassed=error is None and source_error is None and not cleanup_errors)
        if error or source_error:
            self.report['failure'] = str(error or source_error)
        if cleanup_errors:
            self.report['cleanupFailures'] = cleanup_errors
        if not self.keep_stage:
            shutil.rmtree(self.stage)
            self.report['stageRemoved'] = True
        else:
            self.report['stageRemoved'] = False
        self.save()
        if cleanup_errors:
            raise RuntimeError('Service cleanup failed')
        if source_error is not None and error is None:
            raise source_error


def install_signals():
    def interrupted(signum, _frame):
        raise RuntimeError('Local validation interrupted by signal ' + str(signum))
    for sig in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, interrupted)
