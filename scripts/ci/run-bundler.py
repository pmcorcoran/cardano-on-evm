"""Rebuild pinned Alto source and execute separate private-bundler acceptance."""
import argparse
import json
import os
from pathlib import Path
import runpy
import shutil

helpers = runpy.run_path(str(Path(__file__).parent / 'local-harness.py'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True)
    parser.add_argument('--anvil', default=os.environ.get('ANVIL_BIN', '.local/tools/foundry/anvil'))
    parser.add_argument('--forge', default=os.environ.get('FORGE_BIN', '.local/tools/foundry/forge'))
    parser.add_argument('--port-base', type=int, default=18700)
    parser.add_argument('--keep-stage', action='store_true')
    args = parser.parse_args()
    helpers['install_signals']()
    harness = helpers['Harness'](args.out, 'private-bundler-clean-source', keep_stage=args.keep_stage)
    anvil, forge = helpers['executable'](args.anvil), helpers['executable'](args.forge)
    harness.env.update(ANVIL_BIN=anvil, FORGE_BIN=forge)
    run = harness.run
    error = None
    try:
        harness.require_toolchain(anvil, forge=forge)
        harness.ports_available([args.port_base + n for n in [98, 87, 88, 97, 96]])
        run('repository-boundaries', ['npm', 'run', 'check:repository'], guarded=True)
        run('install-core', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'])
        run('install-private-runtime', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', 'infra/bundler'])
        run('install-private-build-tools', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', 'infra/bundler/build-tools'])
        run('verify-worker-patches', ['npm', 'run', 'prepare:worker', '--prefix', 'infra/bundler'], guarded=True)
        run('generated-strict-fixture-current', ['node', 'infra/bundler/scripts/export-strict-validation-fixture.mjs', '--check'], guarded=True)
        run('gateway-and-package-parser-tests', ['npm', 'test', '--prefix', 'infra/bundler'], guarded=True)
        run('fetch-pinned-preferred-source', ['node', 'infra/bundler/scripts/fetch-source.mjs'])
        run('build-pinned-preferred-source', ['node', 'infra/bundler/scripts/build-source.mjs'], guarded=True, timeout=3600)
        run('compile-contracts', ['npm', 'run', 'build:contracts'], guarded=True)
        run('compile-reference-entrypoint', ['node', 'scripts/build-entrypoint-reference.mjs'], guarded=True)
        run('build-libraries', ['npm', 'run', 'build'], guarded=True)
        run('package-and-source-local-execution', ['node', 'scripts/check-private-source.mjs', '--out', str(harness.out / 'local'), '--anvil', anvil, '--port-base', str(args.port_base)], guarded=True, timeout=1800)
        pin = json.loads((harness.stage / 'infra/bundler/upstream.json').read_text())
        manifest = harness.stage / 'infra/bundler/.local/source-build-manifest.json'
        shutil.copy2(manifest, harness.out / 'source-build-manifest.json')
        shutil.copy2(harness.stage / 'infra/bundler/.local/patch-evidence.json', harness.out / 'patch-evidence.json')
        for build in ['package', 'source']:
            shutil.copy2(harness.stage / f'infra/bundler/.local/patch-evidence-{build}.json', harness.out / f'patch-evidence-{build}.json')
        harness.report.update(sourceCommit=pin['commit'], sourceArchiveSha256=pin['sourceArchiveSha256'], separateDependencyInstall=True, sourceRebuiltThisRun=True, strictValidation='generated-parser-regression-fixture', strictExecutionPerformed=False, localExecution='basic-validation-real-Anvil-transactions', publicRpcIndependent=True)
    except BaseException as failure:
        error = failure
        raise
    finally:
        harness.finish(error)
    print(json.dumps({'allChecksPassed': True, 'report': str(harness.out / 'report.json')}))


if __name__ == '__main__':
    main()
