"""Build a candidate from current GitHub evidence; never publish or create a tag.

prepare creates intermediate packs. scan first freezes validation reports (except
its own report), then scans every payload including nested archives. finalize
ships the scan report/evidence as loose assets, avoiding a scan/archive hash cycle.
SHA256SUMS hashes payloads and release-manifest.json, never itself; its hash is the
candidate identity approved by the separate GitHub publication workflow.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from ci import evidence
from source_release import digest, source_files, write_archive, write_json_report, write_source_archive
from release.archive import PACKAGES, check_package, extract_for_scan, no_residue, read_archive, records, safe_name

TREES = ['root', 'bundler', 'bundler-build-tools']


def fail(message):
    raise ValueError(message)


def require(condition, message):
    if not condition:
        fail(message)


def asset(path, kind):
    return {'name': Path(path).name, 'kind': kind, 'sha256': digest(path), 'size': Path(path).stat().st_size}


def payloads(out):
    return sorted(p.name for p in (out / 'assets').iterdir())


def checked_reports(args, suites):
    context = evidence.load_context(args.context)
    evidence.check_source(context, args.root)
    return context, evidence.verify(args.context, Path(args.evidence_dir) / 'reports', suites, candidate=True)


def bound_path(directory, report, relative):
    path = evidence.safe_evidence_path(directory, relative)
    matching = [entry for entry in report['evidence'] if entry['path'] == relative]
    require(len(matching) == 1 and matching[0]['sha256'] == digest(path), 'Required output is not bound to its suite: ' + relative)
    return path


def version(root):
    result = subprocess.check_output(['node', str(root / 'scripts/release/version.mjs'), 'check', '--root', str(root)], text=True)
    return json.loads(result)['version']


def checked_state(args, phase):
    out = Path(args.out)
    state = evidence.json_load(out / 'prepare.json')
    require(state.get('schemaVersion') == 1 and state.get('phase') == phase, 'Wrong packaging phase; use a fresh candidate after failure')
    context = evidence.load_context(args.context)
    for key in ['commit', 'repository', 'sourceInventoryHash', 'run']:
        require(state.get(key) == context[key], 'Prepared candidate identity changed: ' + key)
    require(state.get('contextSha256') == digest(args.context), 'Prepared candidate context changed')
    require(payloads(out) == sorted(item['name'] for item in state['payloads']), 'Unexpected/missing candidate payload')
    for item in state['payloads']:
        require(asset(out / 'assets' / item['name'], item['kind']) == item, 'Candidate payload changed: ' + item['name'])
    for item in state['buildLogs']:
        require(digest(out / item['path']) == item['sha256'], 'Build log changed')
    for item in state['packages']:
        require(digest(out / 'archives' / item['filename']) == item['sha256'], 'Intermediate tarball changed')
    return state


def run_build(command, stage, log):
    with log.open('w') as stream:
        completed = subprocess.run(command, cwd=stage, stdout=stream, stderr=subprocess.STDOUT)
    if completed.returncode:
        fail('Candidate clean build failed: ' + ' '.join(command) + '; log: ' + str(log))


def install_script():
    return """import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const index = JSON.parse(readFileSync(resolve(root, 'package-index.json'), 'utf8'));
const destination = resolve(process.argv[2] ?? '.');
const manifestPath = resolve(destination, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const localPackages = Object.fromEntries(index.packages.map((p) => [p.name, 'file:' + resolve(root, 'archives', p.filename)]));
manifest.dependencies = { ...manifest.dependencies, ...localPackages };
manifest.overrides = { ...manifest.overrides, ...localPackages };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
  '--@cardano-on-evm:registry=http://127.0.0.1:9/'],
  { cwd: destination, stdio: 'inherit' });
"""


def bundle_instructions(release):
    return f"""# Cardano on EVM {release} library bundle

Verify SHA256SUMS and GitHub artifact attestations before extracting release
archives, following the release runbook in the source archive. This bundle
contains all six libraries. Node >=22.18.0 is required (candidate tests use
26.8.1); npm installs ordinary third-party dependencies from its normal registry.
No @cardano-on-evm package is published to or fetched from a registry.

In a fresh application directory, create package.json with `npm init -y`, then
run `node /absolute/path/to/this/bundle/install.mjs /absolute/path/to/application`.
Install all six together; installing only the SDK archive cannot satisfy sibling
dependencies. The installer adds local file dependencies and matching root npm
overrides for all six packages, so transitive siblings also resolve locally.
Keep the archives available for later `npm ci` from the app lock.
The scoped registry is deliberately unavailable so a missing sibling fails.

Rerun the exact-tarball ESM, declaration, enrollment, and signing acceptance test:

    node scripts/check-package-install.mjs --archives archives --out /tmp/cardano-consumer-{release}

This command never rebuilds or repacks a supplied archive. It creates a fresh
consumer, checks every tarball's npm integrity, rejects workspace links, denies
project registry requests, and verifies Alto is absent. `--offline` additionally
requires ordinary third-party packages to be present in npm's local cache.
Use a fresh --out directory for each run. Output package-install.json records the
six archive hashes; compare them with package-index.json and the release manifest.

The accompanying source archive supports `npm ci --ignore-scripts`,
`npm run build:contracts`, and `npm run build` from the extracted checkout.
See its README and CI/CD runbook for full local validation and toolchain setup.
"""


def prepare(args):
    root, out, evdir = Path(args.root).resolve(), Path(args.out).resolve(), Path(args.evidence_dir).resolve()
    context, reports = checked_reports(args, evidence.PREPACK_SUITES)
    evidence.out_allowed(root, out)
    require(not out.exists() or not any(out.iterdir()), 'Candidate output already exists; never reuse stale output')
    require(subprocess.check_output(['node', '--version'], text=True).strip() == 'v26.8.1', 'Release builds require Node 26.8.1')
    require(subprocess.check_output(['npm', '--version'], text=True).strip() == '11.19.0', 'Release builds require npm 11.19.0')
    release = version(root)
    (out / 'assets').mkdir(parents=True)
    (out / 'archives').mkdir()
    (out / 'logs').mkdir()
    state = {'schemaVersion': 1, 'phase': 'preparing', 'version': release, 'contextSha256': digest(args.context),
             **{key: context[key] for key in ['commit', 'repository', 'sourceInventoryHash', 'run']},
             'packages': [], 'payloads': [], 'buildLogs': []}
    def add(path, kind):
        state['payloads'].append(asset(path, kind))
    inventory = evidence.inventory(root)
    with tempfile.TemporaryDirectory(prefix='cardano-on-evm-package-source-') as temporary:
        stage = Path(temporary) / 'source'
        stage.mkdir()
        for item in inventory:
            destination = stage / item['path']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / item['path'], destination)
        require(evidence.inventory(stage) == inventory, 'Source changed during clean snapshot copy')
        source_archive = out / 'assets' / f'cardano-on-evm-{release}-source.tar.gz'
        write_source_archive(stage, source_files(stage), source_archive)
        add(source_archive, 'source')
        for name, command in [('npm-ci', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']),
                              ('contracts', ['npm', 'run', 'build:contracts']), ('libraries', ['npm', 'run', 'build'])]:
            log = out / 'logs' / (name + '.log')
            run_build(command, stage, log)
            state['buildLogs'].append({'path': 'logs/' + log.name, 'sha256': digest(log)})
        require(evidence.inventory(stage) == inventory, 'Staged source bytes or executable modes changed during candidate build')
        for name in PACKAGES:
            packed = subprocess.check_output(['npm', 'pack', '--workspace', '@cardano-on-evm/' + name,
                                              '--pack-destination', str(out / 'archives'), '--json', '--ignore-scripts'], cwd=stage, text=True)
            pack = json.loads(packed)[0]
            filename = f'cardano-on-evm-{name}-{release}.tgz'
            require(pack['filename'] == filename, 'Unexpected npm pack filename')
            path = out / 'archives' / filename
            entries = read_archive(path)
            check_package(entries, name, release)
            # Compare every archive byte with the clean build, not npm's file list.
            for member, entry in entries.items():
                built = stage / 'packages' / name / member.removeprefix('package/')
                require(built.is_file() and digest(built) == entry['sha256'], 'Packed file differs from clean build: ' + member)
            state['packages'].append({'name': '@cardano-on-evm/' + name, 'version': release, 'filename': filename,
                                      'sha256': digest(path), 'size': path.stat().st_size, 'files': records(entries)})
        contracts_dir = Path(temporary) / 'contract-build'
        for rel in ['artifacts/build.json', 'artifacts/contracts.json', 'artifacts/package-build.json', 'packages/contracts/manifest.json']:
            destination = contracts_dir / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(stage / rel, destination)
        contract_archive = out / 'assets' / f'cardano-on-evm-{release}-contracts.tar.gz'
        write_archive(contracts_dir, [p.relative_to(contracts_dir) for p in contracts_dir.rglob('*') if p.is_file()], contract_archive)
        add(contract_archive, 'contracts')
        bundle = Path(temporary) / 'bundle'
        (bundle / 'archives').mkdir(parents=True)
        for item in state['packages']:
            shutil.copy2(out / 'archives' / item['filename'], bundle / 'archives' / item['filename'])
        for rel in ['scripts/check-package-install.mjs']:
            (bundle / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(stage / rel, bundle / rel)
        write_json_report(bundle / 'package-index.json', {'schemaVersion': 1, 'version': release, 'packages': state['packages']})
        (bundle / 'INSTALL.md').write_text(bundle_instructions(release))
        (bundle / 'install.mjs').write_text(install_script())
        library_archive = out / 'assets' / f'cardano-on-evm-{release}-libraries.tar.gz'
        write_archive(bundle, [p.relative_to(bundle) for p in bundle.rglob('*') if p.is_file()], library_archive)
        add(library_archive, 'libraries')
        security = next(report for report in reports if report['suite'] == 'security')
        audits = Path(temporary) / 'audits'
        for tree in TREES:
            for kind in ['sbom', 'licenses']:
                src = bound_path(evdir, security, f'security/npm-{tree}-{kind}.json')
                evidence.json_load(src)
                destination = out / 'assets' / f'cardano-on-evm-{release}-{tree}-{kind}.json'
                shutil.copy2(src, destination)
                add(destination, kind)
            bound_path(evdir, security, f'security/npm-{tree}-audit.json')
        bound_path(evdir, security, 'security/dependency-audit.json')
        for item in security['evidence']:
            rel = item['path']
            if rel.startswith('security/'):
                destination = audits / rel
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(bound_path(evdir, security, rel), destination)
        security_archive = out / 'assets' / f'cardano-on-evm-{release}-security.tar.gz'
        write_archive(audits, [p.relative_to(audits) for p in audits.rglob('*') if p.is_file()], security_archive)
        add(security_archive, 'security')
        # Packages and the bundled consumer must still derive from the same
        # source snapshot archived before the build, including executable modes.
        require(evidence.inventory(stage) == inventory, 'Staged source bytes or executable modes changed during candidate packaging')
    evidence.check_source(context, root)
    shutil.copy2(args.context, out / 'assets' / 'context.json')
    write_json_report(out / 'assets' / 'source-inventory.json', inventory)
    add(out / 'assets' / 'context.json', 'context')
    add(out / 'assets' / 'source-inventory.json', 'source-inventory')
    state['phase'] = 'prepared'
    state['payloads'].sort(key=lambda item: item['name'])
    write_json_report(out / 'prepare.json', state)
    print(json.dumps({'phase': state['phase'], 'archives': str(out / 'archives'), 'assets': str(out / 'assets'), 'version': release, 'releaseEligible': False}))


def check_consumer(evdir, reports, packages):
    wrapper = next(report for report in reports if report['suite'] == 'package-consumer')
    report = evidence.json_load(bound_path(evdir, wrapper, 'consumer/package-install.json'))
    require(report.get('kind') == 'isolated-installed-core-packages' and report.get('allChecksPassed') is True and not report.get('failure'), 'Final consumer checks did not pass')
    require(report.get('prebuiltArchives') is True, 'Final consumer must use exact prebuilt archives')
    result = report.get('result', {})
    for key in ['standardNodeEsm', 'sixLibrariesImported', 'installedDeclarationsTypecheck', 'allProjectDependenciesLocal']:
        require(result.get(key) is True, 'Incomplete isolated consumer result: ' + key)
    require(result.get('projectRegistryRequests') == 0 and result.get('workspaceLinksUsed') is False and result.get('privateBundlerInstalled') is False, 'Consumer used registry/workspace/private bundler packages')
    keys = ['name', 'version', 'filename', 'sha256']
    expected = sorted(({key: item[key] for key in keys} for item in packages), key=lambda item: item['name'])
    actual = sorted(({key: item[key] for key in keys} for item in report.get('packages', [])), key=lambda item: item['name'])
    require(actual == expected, 'Consumer did not test all six exact candidate tarballs')
    return report


def stage_validation(args, state, reports):
    out, evdir = Path(args.out), Path(args.evidence_dir)
    with tempfile.TemporaryDirectory(prefix='cardano-on-evm-validation-') as temporary:
        stage = Path(temporary)
        shutil.copy2(args.context, stage / 'context.json')
        shutil.copy2(out / 'assets/source-inventory.json', stage / 'source-inventory.json')
        paths = set()
        for report in reports:
            paths.add('reports/' + report['suite'] + '.json')
            paths.update(item['path'] for item in report['evidence'])
        for rel in sorted(paths):
            source = evidence.safe_evidence_path(evdir, rel)
            destination = stage / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        for item in state['buildLogs']:
            destination = stage / 'packaging' / item['path']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(out / item['path'], destination)
        path = out / 'assets' / f"cardano-on-evm-{state['version']}-validation.tar.gz"
        write_archive(stage, [p.relative_to(stage) for p in stage.rglob('*') if p.is_file()], path)
    state['payloads'].append(asset(path, 'validation'))
    state['payloads'].sort(key=lambda item: item['name'])


def scan(args):
    out, evdir, root = Path(args.out), Path(args.evidence_dir), Path(args.root)
    context, reports = checked_reports(args, evidence.PREPACK_SUITES + ['package-consumer'])
    state = checked_state(args, 'prepared')
    check_consumer(evdir, reports, state['packages'])
    stage_validation(args, state, reports)
    scan_out = evdir / 'archive'
    require(not scan_out.exists(), 'Archive scan output exists; start a new candidate')
    scan_out.mkdir(parents=True)
    result = {'schemaVersion': 1, 'kind': 'candidate-archive-scan', 'contextSha256': digest(args.context),
              'payloads': state['payloads'], 'archiveFiles': {}, 'allChecksPassed': False}
    with tempfile.TemporaryDirectory(prefix='cardano-on-evm-archive-scan-') as temporary:
        expanded = Path(temporary)
        budget = [0, 0]
        for item in state['payloads']:
            path = out / 'assets' / item['name']
            if item['name'].endswith(('.tar.gz', '.tgz')):
                files = read_archive(path)
                result['archiveFiles'][item['name']] = records(files)
                extract_for_scan(files, expanded / (item['name'] + '.contents'), budget=budget)
            else:
                no_residue(item['name'])
                shutil.copy2(path, expanded / item['name'])
        completed = subprocess.run([sys.executable, str(root / 'scripts/ci/security.py'), 'scan', '--root', str(expanded), '--out', str(scan_out / 'gitleaks.json')])
        require(completed.returncode == 0, 'Final archive secret scan failed')
    # Neither staging nor a scanner may change the bytes that were just scanned.
    for item in state['payloads']:
        require(asset(out / 'assets' / item['name'], item['kind']) == item, 'Payload changed during scan')
    evidence.check_source(context, root)
    result['allChecksPassed'] = True
    write_json_report(scan_out / 'scan.json', result)
    state['phase'] = 'scanned'
    write_json_report(out / 'prepare.json', state)
    print(json.dumps({'scannedPayloads': len(state['payloads']), 'report': str(scan_out / 'scan.json')}))


def finalize(args):
    out, evdir = Path(args.out), Path(args.evidence_dir)
    context, reports = checked_reports(args, evidence.FINAL_SUITES)
    state = checked_state(args, 'scanned')
    check_consumer(evdir, reports, state['packages'])
    scan_wrapper = next(report for report in reports if report['suite'] == 'archive-scan')
    details = evidence.json_load(bound_path(evdir, scan_wrapper, 'archive/scan.json'))
    require(details.get('kind') == 'candidate-archive-scan' and details.get('allChecksPassed') is True and details.get('contextSha256') == digest(args.context), 'Archive scan is incomplete or mismatched')
    require(details.get('payloads') == state['payloads'], 'Archive scan did not cover the final payloads')
    items = list(state['payloads'])
    wrapper_path = out / 'assets/archive-scan-report.json'
    shutil.copy2(evdir / 'reports/archive-scan.json', wrapper_path)
    items.append(asset(wrapper_path, 'archive-scan-report'))
    scan_files = []
    for index, entry in enumerate(scan_wrapper['evidence']):
        src = bound_path(evdir, scan_wrapper, entry['path'])
        name = f'archive-scan-evidence-{index}-{src.name}'
        shutil.copy2(src, out / 'assets' / name)
        items.append(asset(out / 'assets' / name, 'archive-scan-evidence'))
        scan_files.append({'path': entry['path'], 'asset': name})
    manifest = {'schemaVersion': 1, 'kind': 'cardano-on-evm-release', 'version': state['version'],
                **{key: context[key] for key in ['commit', 'repository', 'sourceInventoryHash', 'run']},
                'contextSha256': digest(args.context), 'packages': state['packages'],
                'requiredSuites': evidence.FINAL_SUITES,
                'toolchain': {report['suite']: report['toolchain'] for report in reports},
                'assets': sorted(items, key=lambda item: item['name']), 'scanEvidence': scan_files,
                'attestations': {'required': True, 'repository': context['repository'], 'workflowRef': context['run']['workflow'], 'commit': context['commit'], 'subjects': 'Every asset listed in SHA256SUMS, plus SHA256SUMS itself'},
                'approvalRequired': True, 'publiclyPublished': False}
    write_json_report(out / 'assets/release-manifest.json', manifest)
    sums = {item['name']: item['sha256'] for item in items}
    sums['release-manifest.json'] = digest(out / 'assets/release-manifest.json')
    (out / 'assets/SHA256SUMS').write_text(''.join(sums[name] + '  ' + name + '\n' for name in sorted(sums)))
    verified = verify_assets(out / 'assets', args.context, for_publication=True)
    state['phase'] = 'finalized'
    state['candidateId'] = verified['candidateId']
    write_json_report(out / 'prepare.json', state)
    print(json.dumps(verified))


def verify_assets(assets, context_path, *, for_publication=False):
    """Verify downloaded bytes without rebuilding/repacking or trusting a worktree."""
    assets = Path(assets).resolve()
    context = evidence.load_context(context_path)
    manifest = evidence.json_load(assets / 'release-manifest.json')
    require(manifest.get('schemaVersion') == 1 and manifest.get('kind') == 'cardano-on-evm-release', 'Invalid release manifest')
    for key in ['commit', 'repository', 'sourceInventoryHash', 'run']:
        require(manifest.get(key) == context[key], 'Candidate identity mismatch: ' + key)
    require(manifest.get('contextSha256') == digest(context_path) == digest(assets / 'context.json'), 'Candidate context mismatch')
    require(manifest.get('requiredSuites') == evidence.FINAL_SUITES, 'Candidate suite list was weakened')
    wanted = {}
    for line in (assets / 'SHA256SUMS').read_text().splitlines():
        parts = line.split('  ')
        require(len(parts) == 2 and evidence.HEX64.fullmatch(parts[0]), 'Malformed SHA256SUMS')
        name = parts[1]
        require(safe_name(name).name == name and name not in wanted and name != 'SHA256SUMS', 'Invalid/recursive checksum entry')
        wanted[name] = parts[0]
    expected_names = {item['name'] for item in manifest['assets']} | {'release-manifest.json'}
    require(len(expected_names) == len(manifest['assets']) + 1, 'Duplicate manifest assets')
    require(set(wanted) == expected_names, 'Checksum asset list differs from manifest')
    require({p.name for p in assets.iterdir()} == expected_names | {'SHA256SUMS'}, 'Unexpected/missing release assets')
    for name, checksum in wanted.items():
        require((assets / name).is_file() and not (assets / name).is_symlink() and digest(assets / name) == checksum, 'Asset checksum mismatch: ' + name)
    for item in manifest['assets']:
        require(asset(assets / item['name'], item['kind']) == item, 'Manifest asset differs: ' + item['name'])
    grouped = {}
    for item in manifest['assets']:
        grouped.setdefault(item['kind'], []).append(item)
    for kind in ['source', 'libraries', 'contracts', 'validation', 'security', 'context', 'source-inventory', 'archive-scan-report']:
        require(len(grouped.get(kind, [])) == 1, 'Missing/duplicate required asset: ' + kind)
    require(len(grouped.get('sbom', [])) == 3 and len(grouped.get('licenses', [])) == 3, 'All three dependency trees require SBOMs and license inventories')
    inventory = evidence.json_load(assets / 'source-inventory.json')
    require(hashlib.sha256(evidence.canonical(inventory)).hexdigest() == context['sourceInventoryHash'], 'Source inventory differs')
    source = read_archive(assets / grouped['source'][0]['name'])
    prefix = 'cardano-on-evm-' + manifest['version'] + '/'
    require(all(name.startswith(prefix) for name in source), 'Unexpected source archive prefix')
    actual = [{'path': name.removeprefix(prefix), 'sha256': item['sha256'], 'executable': item['executable']} for name, item in sorted(source.items())]
    require(actual == inventory, 'Source archive differs from validated inventory')
    library = read_archive(assets / grouped['libraries'][0]['name'])
    expected_library = {'scripts/check-package-install.mjs', 'INSTALL.md', 'install.mjs', 'package-index.json'}
    expected_library.update('archives/' + item['filename'] for item in manifest['packages'])
    require(set(library) == expected_library, 'Unexpected/missing library bundle contents')
    for rel in ['scripts/check-package-install.mjs']:
        require(prefix + rel in source and library[rel]['sha256'] == source[prefix + rel]['sha256'], 'Bundle verification input differs from validated source: ' + rel)
    require(library['install.mjs']['data'] == install_script().encode() and library['INSTALL.md']['data'] == bundle_instructions(manifest['version']).encode(), 'Bundle installation instructions differ from the reviewed format')
    index = json.loads(library['package-index.json']['data'])
    require(index.get('version') == manifest['version'] and index.get('packages') == manifest['packages'], 'Package index differs from release manifest')
    require(sorted(item['name'] for item in manifest['packages']) == sorted('@cardano-on-evm/' + name for name in PACKAGES), 'Candidate must contain all six libraries')
    for item in manifest['packages']:
        archive = library['archives/' + item['filename']]
        require(archive['sha256'] == item['sha256'] and archive['size'] == item['size'] and item['version'] == manifest['version'], 'Library archive differs from manifest')
        files = read_archive(archive['data'])
        check_package(files, item['name'].split('/')[1], manifest['version'])
        require(records(files) == item['files'], 'Package content inventory differs')
    with tempfile.TemporaryDirectory(prefix='cardano-on-evm-verify-evidence-') as temporary:
        directory = Path(temporary)
        validation = read_archive(assets / grouped['validation'][0]['name'])
        for name, item in validation.items():
            no_residue(name)
            destination = directory / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(item['data'])
        require(digest(directory / 'context.json') == digest(context_path), 'Validation archive has different context')
        shutil.copy2(assets / grouped['archive-scan-report'][0]['name'], directory / 'reports/archive-scan.json')
        require(len({item['path'] for item in manifest['scanEvidence']}) == len(manifest['scanEvidence']), 'Duplicate scan evidence path')
        for entry in manifest['scanEvidence']:
            require(entry['asset'] in {item['name'] for item in grouped.get('archive-scan-evidence', [])}, 'Invalid scan evidence asset')
            destination = evidence.safe_evidence_path(directory, entry['path'])
            require(not destination.exists(), 'Scan evidence cannot overwrite validation evidence')
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(assets / entry['asset'], destination)
        reports = evidence.verify(context_path, directory / 'reports', evidence.FINAL_SUITES, candidate=True, require_fresh=for_publication)
        check_consumer(directory, reports, manifest['packages'])
        require(manifest['toolchain'] == {report['suite']: report['toolchain'] for report in reports}, 'Manifest toolchain differs from evidence')
        scan_wrapper = next(report for report in reports if report['suite'] == 'archive-scan')
        scan = evidence.json_load(bound_path(directory, scan_wrapper, 'archive/scan.json'))
        scanned_assets = [item for item in manifest['assets'] if item['kind'] not in {'archive-scan-report', 'archive-scan-evidence'}]
        require(scan.get('allChecksPassed') is True and scan.get('contextSha256') == digest(context_path) and scan.get('payloads') == scanned_assets, 'Final payloads lack matching archive scan')
        for name, expected in scan.get('archiveFiles', {}).items():
            require(name in wanted and records(read_archive(assets / name)) == expected, 'Archive file inventory differs: ' + name)
        require(set(scan.get('archiveFiles', {})) == {item['name'] for item in scanned_assets if item['name'].endswith(('.tar.gz', '.tgz'))}, 'Some archives were not scanned')
    return {'version': manifest['version'], 'commit': manifest['commit'], 'candidateId': digest(assets / 'SHA256SUMS'), 'assets': str(assets), 'verified': True, 'publicationFreshnessEnforced': for_publication, 'approvalRequired': True, 'attestationsVerified': False, 'published': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='.')
    sub = parser.add_subparsers(dest='operation', required=True)
    for name in ['prepare', 'scan', 'finalize', 'verify']:
        command = sub.add_parser(name)
        command.add_argument('--out', required=True, help='Candidate directory (contains assets/ and intermediate archives/)')
        command.add_argument('--context', required=True, help='Expected immutable validation context')
        command.add_argument('--evidence-dir', required=name != 'verify')
        if name == 'verify':
            command.add_argument('--for-publication', action='store_true', help='Also enforce current candidate evidence freshness before publication')
    args = parser.parse_args()
    for name in ['root', 'out', 'context', 'evidence_dir']:
        if getattr(args, name, None):
            setattr(args, name, Path(getattr(args, name)).resolve())
    if args.operation == 'verify':
        print(json.dumps(verify_assets(args.out / 'assets' if (args.out / 'assets').is_dir() else args.out, args.context, for_publication=args.for_publication)))
    else:
        globals()[args.operation](args)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Release packaging gate failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
