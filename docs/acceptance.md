# Initial 0.1.0 validation

Acceptance belongs to the exact source inventory and artifact hashes in each
fresh run report. Before the initial import, identify uncommitted source by its
inventory hash. A disposable test repository must not supply a
release commit. Local output is not a published or attested GitHub release.

## Required checks

| Gate | Evidence produced |
| --- | --- |
| Frozen answers | `fixtures/address-derivation-v1/` contains generated inputs and independently frozen protocol/backend full identities, factory and preparation calldata, plus provenance and compiler/bytecode hashes |
| Input boundaries | All profile/policy variants, key subgroups, headers, namespaces, indexes and ABI lengths; malformed and unsupported configuration rejects |
| Chain separation | Equal salts/addresses/initialization/factory data for equal infrastructure; different enrollment hashes and actual operation payloads/digests |
| Enrollment/signing | Successful profiles, atomic consumption and scope/config/chain failures before signer or enrollment submission |
| Manifest integrity | Explicit current metadata, artifact identities, creation bytes, factory bindings, identity parity and chain consistency |
| Two fresh chains | Eight deployment rows: general, targets, selectors and experimental-general on 31337 and 31338; SDK/backend/factory/deployment agreement |
| Replay | Four real destination-chain rejections with controlled nonce/authorization prerequisites, validator-level failure and correctly signed positive controls |
| Infrastructure | Matching full runtime bytes and immutable values; Kernel constructor uses a controlled chain context, restored before account work |
| Packages | Six `0.1.0` tarballs; exact current exports/artifacts; installed ESM/declarations/enrollment/signing, no workspace links or Alto |
| Bundler | Installed/source-built strict parser and gateway regressions, real basic local execution and lifecycle cleanup |
| Git completeness | Ordinary add and checkout-index from a disposable Git repository preserve all source hashes/executable bits; ignored required inputs fail |

Generated wallet fixtures retain payment/stake, optional key ID, unhashed
success, hashed rejection and malformed-input controls. Wycheproof data retains
its independent source and license. Tests read frozen expectations; they do not
regenerate them to pass. The strict parser fixture uses the pinned simulation
ABI and deterministic addresses with the actual parser/worker patches.

## Reproduce

Run from the root with the pinned toolchain. Choose empty output directories
and free ports for every rerun.

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix infra/bundler
npm ci --ignore-scripts --prefix infra/bundler/build-tools
python3.13 -m venv .local/validation-venv
.local/validation-venv/bin/python -m pip install --require-hashes -r tests/browser/requirements.txt
.local/validation-venv/bin/python -m playwright install --with-deps chromium
node scripts/install-foundry.mjs
npm run check:repository
npm run check:vendor
npm run version:check
npm run build:contracts
node scripts/build-entrypoint-reference.mjs
npm run build
npm run check:types
npm test
npm run test:ci
python3 scripts/ci/actionlint.py
node scripts/check-package-install.mjs --out .local/acceptance/consumer --network-guard scripts/ci/local-network-guard.mjs
python3 scripts/check-clean-source.py --out .local/acceptance/core --python .local/validation-venv/bin/python --port-base 22500
python3 scripts/ci/run-bundler.py --out .local/acceptance/bundler --port-base 22700
python3 scripts/ci/security.py audit --out .local/acceptance/audit
python3 scripts/ci/git-source.py --out .local/acceptance/public-source --report .local/acceptance/git-export.json
python3 scripts/ci/security.py scan --root .local/acceptance/public-source --out .local/acceptance/secrets.json
```

These commands use a local Python environment and Playwright's own browser
installation. Full validation targets Linux with Python 3.13, Node 26.8.1,
npm 11.19.0 and Foundry 1.8.1; see the [toolchain runbook](github-cicd.md).
The fast CI matrix also exercises Node 22.18 and 24.x. Core staging uses the Git-selected
export, compiles source, tests a deliberately corrupted bytecode pin, runs the
documentation example, two-chain matrix, local authority/crypto checks, exact
package consumer, HTTP and browser tests. Network denial, process cleanup,
source continuity, vendor pins and failure reports remain required.

Parser coverage and real basic local execution are separate claims. A complete
strict local execution is not inferred from their combination. Local generated
wallets, read-only RPC fixtures and unforked Anvil do not establish real-wallet,
public-provider or public-chain acceptance. New cryptography remains unaudited.

## Final output

With the commands above, `.local/acceptance/core/` contains the source archive,
current compiled artifacts in `artifacts/`, and six tested package tarballs in
`consumer/archives/`. The contracts tarball includes its manifest and source.
`report.json`, the build reports, and `consumer/package-install.json` record
source, compiler, artifact and package hashes with versions read from metadata.
Recheck the exact final tarballs in another isolated consumer:

```sh
node scripts/check-package-install.mjs --archives .local/acceptance/core/consumer/archives --out .local/acceptance/consumer-final --network-guard scripts/ci/local-network-guard.mjs
```

Inspect the actual reports for completed commands and nonzero failures. Final
acceptance requires every listed gate, verified checksums and all eight
onchain deployment rows; directory names alone prove nothing. CI release
publication has additional security and maintainer gates in the
[operator guide](github-cicd.md).

## TypeScript migration compatibility

The root and Alto source build tools use TypeScript **7.0.2**. Public packages
also support TypeScript **5.9.2** consumers. For a compiler change, repeat clean
installation, contract generation, type checking, builds, unit/CI regressions
and repository/vendor checks on Node **22.18.0**, **24.21.0**, and **26.8.1**.
Also run `node node_modules/typescript/bin/tsc --noEmit --skipLibCheck false`.
Preserve the emitted-output comparison against a fresh baseline and review every
compiler-generated JavaScript/declaration difference for API and runtime parity.

Build six archives once, then use the `--archives` command above on all three
runtimes. Each invocation requires six consumers: TypeScript **5.9.2/7.0.2**
with Node declarations **22.18.0/24.3.1/26.6.1**. Compare the six archive hashes
across all **18** results. Require `allChecksPassed`, all six distinct
`consumerChecks`, verified compiler/declaration versions, separate logs/lockfiles,
library declaration checking and every existing ESM/export/enrollment/signing/SQLite
check. Both compilers use the original consumer's five unmodified TypeScript
5.9.2 host libraries (DOM, iterables, worker imports and ScriptHost), with every
file hash recorded and checked across combinations. This retains browser types
without the old Node 24.3.1/new DOM `URLPattern` collision; it is not a claim of
compatibility with TypeScript 7's default DOM library in that combination. The
root retains its TypeScript 7 ES2022/DOM coverage. Repeat from the standalone
bundle as well. Root package-build and Alto
source-build manifests record the actual compilers; Alto includes effective
module resolution, Node types, root/output directories and the unchanged ESNext
settings. Confirm native compiler installation/execution on Linux ARM64 locally
and Linux x64 in CI after `npm ci --ignore-scripts`.

Require a fresh Alto rebuild with all nine creation/runtime bytecode comparisons,
resolvable emitted JavaScript imports and CLI startup. Execute installed/source
worker regressions on all three runtimes. Run the full clean-source procedure,
including browsers/local chains, fresh three-tree all-severity audits and
`node scripts/collect-licenses.mjs`. The original source pins, vendored files,
Solidity settings, frozen fixtures and public API expectations remain fixed.
See [dependency review](dependency-review.md) for the source-only yargs patch.

## Eternl support acceptance

The [wallet validation guide](eternl-acceptance.md) describes desktop-wallet
requirements and the separate operator acceptance scope. Parameterized connector tests retain both Lace and Eternl behavior; each
browser suite covers each wallet alone and each selected with both installed.
The clean-source harness includes exact-header wallet capture HTTP checks,
reported provenance for both wallets, and legacy requests with unspecified IDs.
The pending Changeset records the coordinated public API change for the next
reviewed release.

A real-wallet/public-chain acceptance claim additionally requires genuine
stake/payment captures and the nine-operation Base Sepolia route matrix. Keep
operator evidence private unless deliberately sanitized for sharing. Installed
wallet/browser versions, exact signatures/headers, requests, receipts, nonces,
balance/counter deltas, gas and restriction controls must be recorded. Generated
signatures and historical artifacts do not substitute for those runs. Routine
local acceptance does not perform public-network transactions.
