# Contributing

Start with the [architecture](docs/architecture.md), [requirements](docs/requirements.md),
and [security limitations](docs/security.md). Discuss changes to account authority,
derivation, public APIs, or supported wallets before changing their behavior.
Report vulnerabilities through the [security policy](SECURITY.md). Follow the
[code of conduct](CODE_OF_CONDUCT.md).

## Set up

Core development supports Node 22.18 or later. Full acceptance uses Node 26.8.1,
npm 11.19.0, Python 3.13, hash-locked Playwright, and pinned Foundry 1.8.1.
Run from the checkout root:

```sh
npm ci --ignore-scripts
npm run check:repository
npm run build:contracts
npm run check:types
npm test
npm run test:ci
npm run check:vendor
npm run version:check
python3 scripts/ci/actionlint.py
```

Build contracts before type checking: the portable-address example imports the
generated contracts package. This build also checks the frozen bytecode pins.

The optional bundler has independent runtime and build-tool lockfiles. Install
it only when working on that service:

```sh
npm ci --ignore-scripts --prefix infra/bundler
npm ci --ignore-scripts --prefix infra/bundler/build-tools
npm run prepare:worker --prefix infra/bundler
npm test --prefix infra/bundler
python3 scripts/ci/security.py audit --out .local/contributor-audit
```

Use [acceptance instructions](docs/acceptance.md) for clean source, isolated
package installation, browser tests, and local-chain execution. These tests
create their own unforked local chains. Public-chain transactions require
separate operator authorization and are not part of routine CI.

## Changes and review

Keep changes focused and describe the behavior before and after the change.
Include the commands actually run, their outcomes, and any environment failures.
Test changed behavior on current source; historical reports are not validation.
Add a Changeset when a public package change needs a release note, keeping the
six package versions coordinated. See the [release runbook](docs/github-cicd.md).

Preserve frozen fixtures, compiler settings, vendored bytes, licenses, account
addresses and public APIs unless an explicitly reviewed change requires otherwise.
Do not regenerate expected bytecode or fixtures just to make tests pass.
Dependency updates must keep the three lockfiles coherent, pass every-severity
audits, and retain notices. Bundler major-version migrations require the
[dependency validation procedure](docs/dependency-review.md).

Keep operator environments, keys, generated evidence, and local editor/agent
state outside the publication set. Store local reports under `.local/`; describe
reproducible commands in public documentation instead of linking to those reports.
`npm run check:repository` rejects inventory drift, missing required inputs and
broken local links. New root policy/configuration files must be deliberately
included in `scripts/ci/evidence.py` and pass this check.
