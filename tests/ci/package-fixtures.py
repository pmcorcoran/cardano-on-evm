"""Controlled packaging gate fixtures; never evidence of a real release run.

The package bytes and suite outcomes here are deliberately synthetic. Behavioral
installation of the real six built libraries is a separate acceptance command.
"""
import argparse
import copy
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from ci import evidence
from source_release import write_archive, write_json_report, write_source_archive
from release.archive import read_archive, records, check_package, CONTRACTS
spec = importlib.util.spec_from_file_location('package_release', ROOT / 'scripts/package-release.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class PackagingFixtures(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cardano-packaging-gate-fixture-')
        self.base = Path(self.temporary.name)
        self.root, self.evdir, self.out = self.base / 'source', self.base / 'evidence', self.base / 'candidate'
        self.root.mkdir()
        self.oldenv = dict(os.environ)
        os.environ.update(GITHUB_REPOSITORY='fixture/packaging', GITHUB_RUN_ID='987654321', GITHUB_RUN_ATTEMPT='1', GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_WORKFLOW_REF='fixture/packaging/.github/workflows/release.yml@refs/heads/main')
        self.put(self.root / 'package.json', {'name': 'disposable-packaging-fixture', 'version': '2.3.4'})
        self.put(self.root / 'README.md', 'Synthetic fixture, not acceptance or publication evidence.')
        self.put(self.root / 'scripts/check-package-install.mjs', '// Controlled consumer fixture only\n')
        for name in packaging.PACKAGES:
            package = self.root / 'packages' / name
            self.put(package / 'package.json', {'name': '@cardano-on-evm/' + name, 'version': '2.3.4'})
            self.put(package / 'LICENSE', 'fixture')
            self.put(package / 'README.md', 'fixture')
        subprocess.run(['git', 'init', '--quiet', '--initial-branch=main'], cwd=self.root, check=True)
        subprocess.run(['git', 'add', '.'], cwd=self.root, check=True)
        subprocess.run(['git', '-c', 'user.name=Packaging fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Controlled fixture only'], cwd=self.root, check=True)
        self.context = evidence.init(self.root, self.evdir, 'candidate')
        self.args = argparse.Namespace(root=self.root, out=self.out, context=self.evdir / 'context.json', evidence_dir=self.evdir)
        (self.out / 'assets').mkdir(parents=True)
        (self.out / 'archives').mkdir()
        self.state = {'schemaVersion': 1, 'phase': 'prepared', 'version': '2.3.4',
                      'contextSha256': evidence.digest(self.args.context),
                      **{key: self.context[key] for key in ['commit', 'repository', 'sourceInventoryHash', 'run']},
                      'packages': [], 'payloads': [], 'buildLogs': []}
        self.make_payloads()
        for suite in evidence.PREPACK_SUITES:
            paths = []
            if suite == 'security':
                for tree in packaging.TREES:
                    for kind in ['audit', 'sbom', 'licenses']:
                        path = f'security/npm-{tree}-{kind}.json'
                        self.put(self.evdir / path, {'controlledFixture': True})
                        paths.append(path)
                self.put(self.evdir / 'security/dependency-audit.json', {'controlledFixture': True})
                paths.append('security/dependency-audit.json')
            self.report(suite, paths)
        consumer = {'schemaVersion': 1, 'kind': 'isolated-installed-core-packages', 'prebuiltArchives': True,
                    'allChecksPassed': True, 'packages': self.state['packages'], 'controlledFixture': True,
                    'result': {'standardNodeEsm': True, 'sixLibrariesImported': True, 'installedDeclarationsTypecheck': True,
                               'allProjectDependenciesLocal': True, 'projectRegistryRequests': 0,
                               'workspaceLinksUsed': False, 'privateBundlerInstalled': False}}
        self.put(self.evdir / 'consumer/package-install.json', consumer)
        self.report('package-consumer', ['consumer/package-install.json'])
        write_json_report(self.out / 'prepare.json', self.state)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.oldenv)
        self.temporary.cleanup()

    @staticmethod
    def put(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(value, (dict, list)):
            write_json_report(path, value)
        else:
            path.write_text(value)

    def add(self, path, kind):
        self.state['payloads'].append(packaging.asset(path, kind))

    def report(self, suite, paths):
        log = f'logs/{suite}.log'
        self.put(self.evdir / log, 'Controlled fixture outcome; no real workflow or security result.\n')
        toolchain = {'node': 'v22.18.0' if suite == 'fast-node22' else 'v24.13.0' if suite == 'fast-node24' else 'v26.8.1',
                     'npm': '11.19.0', 'python': '3.13.5', 'solc': '0.8.30+commit.73712a01.Emscripten.clang',
                     'anvil': 'anvil Version: 1.8.1', 'forge': 'forge Version: 1.8.1', 'playwright': '1.62.0'}
        report = {'schemaVersion': 1, 'kind': 'validation-report', 'suite': suite, 'controlledFixture': True,
                  'contextSha256': evidence.digest(self.args.context),
                  **{key: self.context[key] for key in ['commit', 'repository', 'sourceInventoryHash', 'run']},
                  'startedAt': evidence.now(), 'completedAt': evidence.now(), 'toolchain': toolchain, 'status': 'success',
                  'commands': [{'argv': ['controlled-outcome-fixture', suite], 'exitCode': 0, 'log': log}],
                  'evidence': [{'path': rel, 'sha256': evidence.digest(self.evdir / rel), 'size': (self.evdir / rel).stat().st_size} for rel in sorted([log, *paths])]}
        self.put(self.evdir / 'reports' / (suite + '.json'), report)

    def make_payloads(self):
        inventory = evidence.inventory(self.root)
        archive = self.out / 'assets/cardano-on-evm-2.3.4-source.tar.gz'
        write_source_archive(self.root, evidence.source_files(self.root), archive)
        self.add(archive, 'source')
        bundle = self.base / 'bundle'
        for name in packaging.PACKAGES:
            stage = self.base / 'packages' / name
            files = {'package/package.json': {'name': '@cardano-on-evm/' + name, 'version': '2.3.4'},
                     'package/LICENSE': 'fixture', 'package/README.md': 'fixture'}
            if name == 'contracts':
                records_fixture = []
                for contract in CONTRACTS:
                    artifact = {'contractName': contract, 'sourceName': 'contracts/Fixture.sol', 'abi': [],
                                'bytecode': '0x6000', 'deployedBytecode': '0x6001', 'immutableReferences': {}}
                    artifact_path = 'artifacts/' + contract + '.json'
                    files['package/' + artifact_path] = artifact
                    # put() uses the same JSON writer as the archive fixture.
                    self.put(stage / 'package' / artifact_path, artifact)
                    records_fixture.append({'name': contract, 'source': 'contracts/Fixture.sol', 'artifact': artifact_path,
                                            'artifactSha256': evidence.digest(stage / 'package' / artifact_path),
                                            'creationSha256': hashlib.sha256(bytes.fromhex('6000')).hexdigest(),
                                            'runtimeTemplateSha256': hashlib.sha256(bytes.fromhex('6001')).hexdigest()})
                source_text = '// Synthetic packaging gate source only\n'
                files['package/contracts/Fixture.sol'] = source_text
                files.update({'package/index.js': 'export {};', 'package/index.d.ts': 'export {};',
                              'package/manifest.json': {'package': '@cardano-on-evm/contracts', 'version': '2.3.4',
                                'addressDerivationMode': 'portable', 'compiler': 'controlled fixture', 'contractsSha256': '0' * 64,
                                'buildSha256': '0' * 64, 'compilerInputIdentity': [], 'settings': {}, 'kernelSettings': {},
                                'artifacts': records_fixture, 'sources': [{'file': 'contracts/Fixture.sol', 'sha256': hashlib.sha256(source_text.encode()).hexdigest()}],
                                'versions': {}, 'audited': False}})
            else:
                files.update({'package/dist/index.js': 'export {};', 'package/dist/index.d.ts': 'export {};'})
            for rel, value in files.items(): self.put(stage / rel, value)
            filename = f'cardano-on-evm-{name}-2.3.4.tgz'
            archive = self.out / 'archives' / filename
            write_archive(stage, files, archive)
            self.state['packages'].append({'name': '@cardano-on-evm/' + name, 'version': '2.3.4', 'filename': filename,
                                           'sha256': evidence.digest(archive), 'size': archive.stat().st_size, 'files': records(read_archive(archive))})
            (bundle / 'archives').mkdir(parents=True, exist_ok=True)
            shutil.copy2(archive, bundle / 'archives' / filename)
        for rel in ['scripts/check-package-install.mjs']:
            (bundle / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.root / rel, bundle / rel)
        self.put(bundle / 'package-index.json', {'schemaVersion': 1, 'version': '2.3.4', 'packages': self.state['packages']})
        self.put(bundle / 'INSTALL.md', packaging.bundle_instructions('2.3.4'))
        self.put(bundle / 'install.mjs', packaging.install_script())
        archive = self.out / 'assets/cardano-on-evm-2.3.4-libraries.tar.gz'
        write_archive(bundle, [p.relative_to(bundle) for p in bundle.rglob('*') if p.is_file()], archive)
        self.add(archive, 'libraries')
        for kind in ['contracts', 'security']:
            stage = self.base / kind
            self.put(stage / (kind + '.json'), {'controlledFixture': True})
            archive = self.out / 'assets' / f'cardano-on-evm-2.3.4-{kind}.tar.gz'
            write_archive(stage, [Path(kind + '.json')], archive)
            self.add(archive, kind)
        for kind in ['sbom', 'licenses']:
            for tree in packaging.TREES:
                path = self.out / 'assets' / f'cardano-on-evm-2.3.4-{tree}-{kind}.json'
                self.put(path, {'controlledFixture': True})
                self.add(path, kind)
        shutil.copy2(self.args.context, self.out / 'assets/context.json')
        write_json_report(self.out / 'assets/source-inventory.json', inventory)
        self.add(self.out / 'assets/context.json', 'context')
        self.add(self.out / 'assets/source-inventory.json', 'source-inventory')
        self.state['payloads'].sort(key=lambda item: item['name'])

    def mock_scan(self):
        reports = evidence.verify(self.args.context, self.evdir / 'reports', evidence.PREPACK_SUITES + ['package-consumer'], candidate=True)
        packaging.stage_validation(self.args, self.state, reports)
        details = {'schemaVersion': 1, 'kind': 'candidate-archive-scan', 'controlledFixture': True,
                   'contextSha256': evidence.digest(self.args.context), 'payloads': self.state['payloads'], 'allChecksPassed': True,
                   'archiveFiles': {item['name']: records(read_archive(self.out / 'assets' / item['name'])) for item in self.state['payloads'] if item['name'].endswith('.tar.gz')}}
        self.put(self.evdir / 'archive/scan.json', details)
        self.report('archive-scan', ['archive/scan.json'])
        self.state['phase'] = 'scanned'
        write_json_report(self.out / 'prepare.json', self.state)

    def test_contract_package_rejects_artifacts_sources_and_metadata_outside_current_allowlists(self):
        archive = self.out / 'archives/cardano-on-evm-contracts-2.3.4.tgz'
        original = read_archive(archive)
        self.assertEqual(check_package(original, 'contracts', '2.3.4')['version'], '2.3.4')
        for path in ['package/artifacts/Unexpected.json', 'package/contracts/unreviewed.sol', 'package/vendor/unreviewed/source.sol']:
            changed = copy.deepcopy(original)
            changed[path] = {'data': b'{}'}
            with self.assertRaisesRegex(ValueError, 'allowlist|source files differ'):
                check_package(changed, 'contracts', '2.3.4')
        for patch in [{'addressDerivationMode': 'unknown'}, {'extraArtifactSet': {}}, {'addressDerivationMode': None}]:
            changed = copy.deepcopy(original)
            manifest = json.loads(changed['package/manifest.json']['data'])
            manifest.update(patch)
            changed['package/manifest.json']['data'] = json.dumps(manifest).encode()
            with self.assertRaisesRegex(ValueError, 'current portable artifacts'):
                check_package(changed, 'contracts', '2.3.4')
        changed = copy.deepcopy(original)
        changed['package/artifacts/Kernel.json']['data'] += b' '
        with self.assertRaisesRegex(ValueError, 'artifact identity differs'):
            check_package(changed, 'contracts', '2.3.4')

    def test_prepare_rejects_successful_build_and_pack_source_mutations(self):
        original = evidence.inventory(self.root)
        actual_output, actual_build = subprocess.check_output, packaging.run_build
        for mutation in ['unchanged', 'build-bytes', 'build-executable', 'pack-bytes']:
            with self.subTest(mutation=mutation):
                args = copy.copy(self.args)
                args.out = self.base / ('prepare-' + mutation)
                builds, packs, stages = [], [], []

                def controlled_build(command, stage, log):
                    stages.append(stage)
                    script = 'pass'
                    if command == ['npm', 'run', 'build']:
                        # Controlled generated outputs; all inventoried source
                        # files remain byte-for-byte identical unless requested.
                        for name in packaging.PACKAGES:
                            shutil.copytree(self.base / 'packages' / name / 'package', stage / 'packages' / name, dirs_exist_ok=True)
                        for name in ['build.json', 'contracts.json', 'package-build.json']:
                            self.put(stage / 'artifacts' / name, {'controlledFixture': True})
                        if mutation == 'build-bytes':
                            script = "from pathlib import Path; Path('package.json').write_text('{}')"
                        elif mutation == 'build-executable':
                            script = "from pathlib import Path; Path('scripts/check-package-install.mjs').chmod(0o755)"
                    # Exercise the real successful-command wrapper; a zero exit
                    # code must not authorize changed staged source.
                    actual_build([sys.executable, '-c', script], stage, log)
                    builds.append(command)

                def controlled_output(command, **kwargs):
                    if command == ['node', '--version']: return 'v26.8.1\n'
                    if command == ['npm', '--version']: return '11.19.0\n'
                    if command[:2] == ['npm', 'pack']:
                        name = command[3].split('/')[-1]
                        filename = f'cardano-on-evm-{name}-2.3.4.tgz'
                        shutil.copy2(self.out / 'archives' / filename, Path(command[5]) / filename)
                        packs.append(name)
                        if mutation == 'pack-bytes' and name == packaging.PACKAGES[-1]:
                            (Path(kwargs['cwd']) / 'README.md').write_text('Packing changed staged source')
                        return json.dumps([{'filename': filename}])
                    return actual_output(command, **kwargs)

                with patch.object(packaging, 'version', return_value='2.3.4'), patch.object(packaging, 'run_build', side_effect=controlled_build), patch.object(subprocess, 'check_output', side_effect=controlled_output):
                    if mutation == 'unchanged':
                        packaging.prepare(args)
                        self.assertEqual(evidence.json_load(args.out / 'prepare.json')['phase'], 'prepared')
                    else:
                        phase = 'packaging' if mutation == 'pack-bytes' else 'build'
                        with self.assertRaisesRegex(ValueError, 'source bytes or executable modes changed during candidate ' + phase):
                            packaging.prepare(args)
                        self.assertFalse((args.out / 'prepare.json').exists())
                self.assertEqual(len(builds), 3)
                self.assertEqual(len(packs), 0 if mutation.startswith('build-') else 6)
                self.assertTrue(all(not stage.exists() for stage in stages))
                self.assertEqual(evidence.inventory(self.root), original)

    def test_complete_controlled_candidate_verifies_without_checkout_or_same_attempt(self):
        self.mock_scan()
        packaging.finalize(self.args)
        os.environ['GITHUB_RUN_ATTEMPT'] = '2'
        result = packaging.verify_assets(self.out / 'assets', self.args.context)
        self.assertTrue(result['verified'])
        self.assertFalse(result['attestationsVerified'])
        self.assertFalse(result['published'])
        self.assertEqual(result['version'], '2.3.4')
        sums = (self.out / 'assets/SHA256SUMS').read_text()
        self.assertNotIn('  SHA256SUMS\n', sums)
        self.assertIn('  release-manifest.json\n', sums)

    def test_published_asset_integrity_outlives_candidate_freshness(self):
        self.mock_scan()
        packaging.finalize(self.args)
        class Later(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime.now(tz) + timedelta(days=2)
        with patch.object(evidence, 'datetime', Later):
            self.assertTrue(packaging.verify_assets(self.out / 'assets', self.args.context)['verified'])
            with self.assertRaisesRegex(ValueError, 'expired'):
                packaging.verify_assets(self.out / 'assets', self.args.context, for_publication=True)

    def test_packager_rejects_missing_failed_stale_and_identity_mismatched_prepack_reports(self):
        path = self.evdir / 'reports/core.json'
        original = path.read_bytes()
        path.unlink()
        with self.assertRaises(FileNotFoundError): packaging.checked_reports(self.args, evidence.PREPACK_SUITES)
        path.write_bytes(original)
        variants = [{'status': 'failure'}, {'contextSha256': '0' * 64}, {'commit': '0' * 40}, {'sourceInventoryHash': '0' * 64}, {'startedAt': '2000-01-01T00:00:00Z'}, {'run': {**self.context['run'], 'attempt': '2'}}, {'allChecksPassed': True}]
        for variant in variants:
            value = json.loads(original)
            if 'allChecksPassed' in variant: value = variant  # old historical schema
            else: value.update(variant)
            self.put(path, value)
            with self.assertRaises((ValueError, KeyError)):
                packaging.checked_reports(self.args, evidence.PREPACK_SUITES)
        path.write_bytes(original)
        self.put(self.root / 'README.md', 'changed source')
        with self.assertRaisesRegex(ValueError, 'inventory changed'): packaging.checked_reports(self.args, evidence.PREPACK_SUITES)

    def test_finalization_rejects_missing_final_consumer_and_scan_and_mismatched_archives(self):
        with self.assertRaises(FileNotFoundError): packaging.finalize(self.args)
        self.mock_scan()
        consumer = evidence.json_load(self.evdir / 'consumer/package-install.json')
        consumer['packages'][0]['sha256'] = '0' * 64
        self.put(self.evdir / 'consumer/package-install.json', consumer)
        self.report('package-consumer', ['consumer/package-install.json'])
        with self.assertRaisesRegex(ValueError, 'exact candidate tarballs'): packaging.finalize(self.args)

    def test_finalization_rejects_workspaces_registry_and_repacking(self):
        self.mock_scan()
        path = self.evdir / 'consumer/package-install.json'
        original = evidence.json_load(path)
        variants = [('prebuiltArchives', False), ('workspaceLinksUsed', True), ('projectRegistryRequests', 1), ('privateBundlerInstalled', True), ('installedDeclarationsTypecheck', False)]
        for key, value in variants:
            report = copy.deepcopy(original)
            if key == 'prebuiltArchives': report[key] = value
            else: report['result'][key] = value
            self.put(path, report)
            self.report('package-consumer', ['consumer/package-install.json'])
            with self.assertRaises(ValueError): packaging.finalize(self.args)

    def test_altered_payload_changed_intermediate_and_unexpected_assets_fail(self):
        self.mock_scan()
        intermediate = self.out / 'archives' / self.state['packages'][0]['filename']
        original = intermediate.read_bytes()
        intermediate.write_bytes(original + b'changed')
        with self.assertRaisesRegex(ValueError, 'Intermediate tarball changed'): packaging.finalize(self.args)
        intermediate.write_bytes(original)
        packaging.finalize(self.args)
        payload = self.out / 'assets/cardano-on-evm-2.3.4-source.tar.gz'
        original = payload.read_bytes()
        payload.write_bytes(original + b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'): packaging.verify_assets(self.out / 'assets', self.args.context)
        payload.write_bytes(original)
        self.put(self.out / 'assets/unreviewed.json', {})
        with self.assertRaisesRegex(ValueError, 'Unexpected/missing'): packaging.verify_assets(self.out / 'assets', self.args.context)

    def test_scan_payload_mismatch_and_stale_copied_evidence_fail(self):
        self.mock_scan()
        scan = evidence.json_load(self.evdir / 'archive/scan.json')
        scan['payloads'][0]['sha256'] = '0' * 64
        self.put(self.evdir / 'archive/scan.json', scan)
        self.report('archive-scan', ['archive/scan.json'])
        with self.assertRaisesRegex(ValueError, 'final payloads'): packaging.finalize(self.args)


if __name__ == '__main__':
    unittest.main()
