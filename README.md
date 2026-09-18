# Cardano on EVM

The initial `0.1.0` release provides portable Kernel accounts controlled by a
Cardano key. General, restricted with target or selector policies, and
experimental-general profiles share independent SDK/backend derivation and
chain-bound enrollment and operation authorization. Account salts and addresses
are independent of chain ID when all address-affecting infrastructure and
creation bytes match. See [address derivation](docs/address-derivation.md).

Six packages provide wallet/CIP-8 verification, protocol encodings, enrollment,
the SDK, submission adapters, and current contract artifacts. Public/private
ERC-4337 and ordinary-RPC direct submission use the same Cardano authorization.
Core packages install and work independently of the optional Alto service.

```sh
npm ci --ignore-scripts
npm run check:repository
npm run check:vendor
npm run version:check
npm run build:contracts
npm run build
npm run check:types
npm test
npm run test:ci
```

The [clean-source validation](docs/acceptance.md) builds from files selected by
an ordinary Git add in a disposable repository, deploys every profile on two
fresh local chains, checks replay rejection, installs six exact tarballs, and
runs HTTP/browser checks. Its generated data is explicitly test data. No
real-wallet or public-network acceptance is implied by local results.

The [reference application](docs/reference-app.md) requires a current profile
manifest. [Deployment](docs/deployment.md) explains generating infrastructure,
preparing a verified key, and funding accounts. General accounts allow
Cardano-root administration; restricted accounts have immutable policies with
no administrator or owner opt-out. Review [policy authority](docs/policies.md)
and the [security limitations](docs/security.md) before integration.

- [Architecture](docs/architecture.md), [SDK](docs/sdk.md), and [protocol bytes](docs/protocol.md)
- [Supported wallet encodings and submission boundaries](docs/compatibility.md)
- [Validation and output artifacts](docs/acceptance.md), [release notes](docs/release-notes-0.1.0.md)
- [Operations](docs/operations.md), [handover](docs/handover.md), [requirements](docs/requirements.md)
- [Optional private bundler](infra/bundler/README.md), [dependency review](docs/dependency-review.md)
- [GitHub CI and release workflow](docs/github-cicd.md), [contributing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md), [code of conduct](CODE_OF_CONDUCT.md)
- [Version and upstream pins](versions.json), [licenses](THIRD_PARTY_NOTICES.md)

Original project code is MIT licensed. Vendored licenses apply independently.
Cryptographic additions and complete account integration have no independent
audit. GitHub release publication and public-chain operation require separate
operator setup and authorization.
