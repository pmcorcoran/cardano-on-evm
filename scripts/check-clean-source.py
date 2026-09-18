"""Reproduce the complete core acceptance in an isolated, fresh source copy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
from source_release import write_source_archive

helpers = runpy.run_path(str(Path(__file__).parent / 'ci/local-harness.py'))
Harness, executable = helpers['Harness'], helpers['executable']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, help='Empty output directory for this run only')
    parser.add_argument('--anvil', default=os.environ.get('ANVIL_BIN', '.local/tools/foundry/anvil'))
    parser.add_argument('--python', default=os.environ.get('VALIDATION_PYTHON', sys.executable))
    parser.add_argument('--port-base', type=int, default=18500)
    parser.add_argument('--keep-stage', action='store_true', help='Retain the disposable stage for failure diagnosis')
    args = parser.parse_args()
    helpers['install_signals']()
    harness = Harness(args.out, 'core-clean-source', keep_stage=args.keep_stage)
    anvil, python = executable(args.anvil), executable(args.python)
    rpc, reference, lab, read_rpc = [args.port_base + offset for offset in [99, 74, 73, 72]]
    address_port = args.port_base + 95
    harness.env.update(LOCAL_RPC_URL=f'http://127.0.0.1:{rpc}', WALLET_LAB_PORT=str(lab), WALLET_LAB_URL=f'http://127.0.0.1:{lab}', REFERENCE_APP_URL=f'http://127.0.0.1:{reference}', REFERENCE_HTTP_URL=f'http://127.0.0.1:{reference}', BASE_SEPOLIA_RPC_URL=f'http://127.0.0.1:{read_rpc}', PUBLIC_BUNDLER_RPC_URL=f'http://127.0.0.1:{read_rpc}', BROWSER_EVIDENCE_DIR=str(harness.out / 'browser'), LOCAL_BROWSER_ONLY='1')
    harness.env['ADDRESS_DIFFERENTIAL_EVIDENCE_FILE'] = 'evidence/local/address-derivation-differential.json'
    harness.env['REVIEW_REQUESTS_DIR'] = '.local/review-requests'
    harness.env['LIVE_EVIDENCE_DIR'] = '.local/review-evidence'
    run = harness.run
    error = None
    try:
        harness.require_toolchain(anvil, python=python)
        harness.ports_available([rpc, reference, lab, read_rpc, address_port, address_port + 1])
        run('repository-boundaries', ['npm', 'run', 'check:repository'], guarded=True)
        version = json.loads((harness.stage / 'package.json').read_text())['version']
        archive = harness.out / f'cardano-on-evm-{version}-source.tar.gz'
        write_source_archive(harness.stage, harness.files, archive)
        harness.report.update(sourceArchive=archive.name, sourceArchiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest())
        run('install-core', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'])
        run('vendor-pins', ['npm', 'run', 'check:vendor'], guarded=True)
        run('coordinated-version', ['npm', 'run', 'version:check'], guarded=True)
        run('compile-contracts', ['npm', 'run', 'build:contracts'], guarded=True)
        # Exercise the actual compiler gate in the disposable checkout, then
        # restore the exact original pin bytes. Never refresh the expected pin.
        pin_path = harness.stage / 'fixtures/contract-bytecode-pins.json'
        pins = pin_path.read_bytes()
        try:
            changed = json.loads(pins)
            changed[next(iter(changed))]['creationSha256'] = '0' * 64
            pin_path.write_text(json.dumps(changed))
            run('changed-bytecode-pin-rejected', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/build-contracts.ts'], guarded=True, expected_failure='Contract bytecode pin mismatch:')
        finally:
            pin_path.write_bytes(pins)
        run('compile-reference-entrypoint', ['node', 'scripts/build-entrypoint-reference.mjs'], guarded=True)
        run('build-libraries', ['npm', 'run', 'build'], guarded=True)
        run('type-check', ['npm', 'run', 'check:types'], guarded=True)
        run('unit-tests', ['npm', 'test'], guarded=True)
        run('portable-documentation-example', ['node', 'node_modules/tsx/dist/cli.mjs', '--conditions=development', 'examples/portable-addresses.ts'], guarded=True)
        run('two-chain-address-and-replay', ['node', 'node_modules/tsx/dist/cli.mjs', '--conditions=development', 'scripts/experiments/address-two-chain.ts', '--out', str(harness.out / 'address-two-chain'), '--anvil', anvil, '--port-base', str(address_port)], guarded=True)
        run('loopback-fixture-and-public-network-denial', ['node', '--test', 'tests/ci/local-rpc.test.mjs'], guarded=True)
        # Keep block polling moving if a mined receipt becomes visible just
        # after viem observes the new block. Mixed mining still mines submitted
        # transactions immediately and adds an empty block every second.
        evm = harness.start('anvil', [anvil, '--host', '127.0.0.1', '--port', str(rpc), '--chain-id', '31337', '--hardfork', 'cancun', '--block-time', '1', '--mixed-mining'])
        harness.ready(harness.env['LOCAL_RPC_URL'], evm, chain_id=31337)
        run('infrastructure-deployment-example', ['node', 'node_modules/tsx/dist/cli.mjs', 'examples/deploy-infrastructure.ts', '--network=local', '--entrypoint-artifact=artifacts/entrypoint-reference.json', '--out=.local/example-infrastructure.json'], guarded=True)
        run('sdk-deployment-example', ['npm', 'run', 'experiment:sdk'], guarded=True)
        run('profile-authority-example', ['npm', 'run', 'experiment:policies'], guarded=True)
        run('independent-crypto-corpus', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/experiments/crypto-corpus.ts'], guarded=True)
        # Only npm's third-party dependency installation is unguarded. The
        # isolated consumer's actual ESM/declaration checks use this same guard.
        run('standalone-package-consumer', ['node', 'scripts/check-package-install.mjs', '--out', str(harness.out / 'consumer'), '--network-guard', str(harness.stage / 'scripts/ci/local-network-guard.mjs')], guarded=True)
        run('browser-fixtures', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/export-reference-browser-fixtures.ts'], guarded=True)
        run('reference-read-plan', ['node', 'scripts/ci/local-rpc-plan.mjs'], guarded=True)
        fixture_log = harness.out / 'reference-rpc.jsonl'
        fixture = harness.start('read-only-rpc', ['node', 'scripts/ci/local-rpc.mjs', '--port', str(read_rpc), '--plan', '.local/reference-rpc-plan.json', '--log', str(fixture_log)])
        harness.ready(harness.env['BASE_SEPOLIA_RPC_URL'], fixture, chain_id=84532)
        ref = harness.start('reference', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/reference-server.ts', f'--port={reference}', '--manifest=.local/reference-profile-manifest.json', '--evidence-dir=.local/reference-http-evidence'])
        wallet = harness.start('wallet-lab', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/wallet-server.ts'])
        harness.ready(harness.env['REFERENCE_APP_URL'] + '/config', ref)
        harness.ready(harness.env['WALLET_LAB_URL'], wallet)
        run('http-enrollment', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/experiments/reference-http.ts'], guarded=True)
        run('http-wallet-capture', ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/experiments/wallet-http.ts'], guarded=True)
        for name in ['reference', 'live_review', 'wallet_credential']:
            run('browser-' + name, [python, 'tests/browser/' + name + '.py'], guarded=True)
        run('browser-failure-capture-regression', [python, 'tests/browser/failure_capture.py'], guarded=True)
        reads = [json.loads(line) for line in fixture_log.read_text().splitlines()]
        if not reads or any(not value['accepted'] for value in reads):
            raise RuntimeError('Reference acceptance sent an unexpected request to the read-only fixture')
        required = {'eth_chainId', 'eth_getCode', 'eth_getBalance', 'eth_call'}
        if {value['method'] for value in reads} != required:
            raise RuntimeError('Reference acceptance did not exercise every expected read')
        for path in ['infra/bundler/node_modules', 'node_modules/@pimlico/alto']:
            if (harness.stage / path).exists():
                raise RuntimeError('Core acquired a private bundler dependency')
        harness.report.update(coreWorksWithoutPrivateBundler=True, publicRpcIndependent=True, networkIsolation='Node non-loopback TCP denied; browser external requests denied; Anvil uses an unforked local chain.', referenceFixture={'methods': sorted(required), 'acceptedRequests': len(reads), 'transactionMethodsAllowed': False}, changedBytecodePinRejected=True)
    except BaseException as failure:
        error = failure
        raise
    finally:
        harness.finish(error)
    print(json.dumps({'allChecksPassed': True, 'report': str(harness.out / 'report.json')}))


if __name__ == '__main__':
    main()
