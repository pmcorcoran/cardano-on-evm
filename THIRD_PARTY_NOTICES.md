# Third-party source and license inventory

Original package code: [MIT](LICENSE). Vendor code retains its own license and
copyright notices; the root license does not relicense it.

| Component | Pin / evidence | License / obligations |
| --- | --- | --- |
| Kernel v3.3 | commit in `vendor/sources.json` | MIT; retain `vendor/kernel/LICENSE.txt` and source notices |
| OpenZeppelin reference inputs | 5.0.2 commit and four file hashes in `vendor/sources.json` | MIT; retain `vendor/openzeppelin-v5.0.2/LICENSE` and notices |
| Solady | Kernel submodule commit | MIT; retain `vendor/solady/LICENSE.txt` and notices |
| ExcessivelySafeCall | Kernel submodule commit | MIT SPDX in source; retain original source notice; no separate root license file in this revision |
| Smooth CryptoLib | immutable commit and file hashes | MIT; retain `vendor/scl/LICENSE`; historical audits do not cover new code |
| EntryPoint v0.7 | npm source/artifact SHA-256 and source files | **GPL-3.0**, from source SPDX and upstream license; npm package metadata says MIT but does not override those source notices |
| noble curves/hashes; scure base; viem | exact package versions and lockfile integrity | MIT; preserve shipped notices in redistributed bundles |
| TypeScript, Node types, tsx, esbuild | lockfile | preserve individual package licenses; TypeScript Apache-2.0, the others MIT |
| solc-js | 0.8.30, lockfile | retain package/compiler licenses; bundled compiler GPL-3.0; used as a build tool |
| Alto, separately installed | 0.0.21, commit and checksum-verified patches in `infra/bundler/upstream.json` | GPL-3.0-or-later; preferred source fetch/patch instructions and original license supplied; preferred-source Solidity/TypeScript rebuild and source-worker validation instructions supplied |
| C2SP/Wycheproof Ed25519 test corpus | commit and SHA-256 in `fixtures/wycheproof-provenance.json` | Apache-2.0; original dataset retained with `fixtures/LICENSE.Wycheproof`; used only in tests |

EntryPoint's GPL source and prebuilt artifact are included for local experiments.
`contracts/crypto/CheckedMul.sol` and `PrecomputedMul.sol` are MIT derivatives of
the pinned SCL multiplication files, retaining their copyright notices. Local
changes fix relative scratch-memory allocation; the precomputed variant returns
affine Y as well as X and rejects degenerate tables. Upstream originals remain
unchanged under `vendor/scl`. These changes are not covered by an audit claim.
`EightDimensional.sol` also attributes the SCL XYZZ formulas; its table
construction, exceptional-case handling and integration are new MIT code and
are unaudited.

Provide its complete corresponding source/build instructions for any binary
redistribution. The historical canonical artifact is upstream's; its exact bytecode reproduction
with the original compiler settings is not claimed. The complete imported reference EntryPoint source also includes the pinned
OpenZeppelin 5.0.2 files. `scripts/build-entrypoint-reference.mjs` rebuilds it
with the core compiler for the source-only local deployment example; this is
not a claim of exact reproduction of the older published artifact.

`licenses/dependencies.json` inventories the current lockfile package entries across
the separate core, worker and build-tool trees. Generated notice texts are in `licenses/npm`. Required supplemental texts are
publishable under `licenses/supplemental/`, with versions, upstream sources and
checksums in `licenses/supplemental.json`. Run the collector after installing all
three trees and require no installed packages without a notice. The Acorn plugin release supplies
only an MIT declaration and author metadata; those are retained with standard
MIT terms, without inventing a copyright year. Optional binaries for other
platforms remain npm-integrity pinned; the package manager supplies their
platform files. `scripts/collect-licenses.mjs` reproduces this inventory from
the installed trees. Commercial use is permitted by these
licenses subject to their notice/source and applicable copyleft obligations.

The separately locked worker now uses Fastify 5 and its MIT-licensed plugins,
OpenTelemetry 2.x and instrumentation (Apache-2.0), Sentry 10 (MIT), and
Bull's UUID 11 dependency (MIT). The Fastify instrumentation dependency name is
an npm alias for `@fastify/otel`; its original MIT notice is retained. The
Alto and Solidity source pins and licenses are unchanged. See the
[dependency review](docs/dependency-review.md) for the coordinated migration.
