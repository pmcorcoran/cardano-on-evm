# Lace and Eternl validation

The wallet package exposes explicit Lace and Eternl connectors through the
shared CIP-30 adapter. See [wallet compatibility](compatibility.md),
[SDK usage](sdk.md), and [wallet requirements](wallet-requirements.md).
Desktop software wallets are supported within the documented address/signing
constraints. Mobile and hardware-wallet acceptance are separate work.

## Reproducible local checks

Run the [complete acceptance procedure](acceptance.md). Connector unit tests
exercise both wallets, including provider selection, network/address checks,
signature attribution and connection errors. The browser suites exercise each
wallet alone and explicit selection with both installed. HTTP capture tests
check exact signed headers, wallet provenance and legacy requests whose wallet
identity was unspecified.

The clean-source harness generates fresh wallet fixtures and runs browser,
enrollment, account-policy, and local-chain controls. Its reports identify the
source inventory, tool versions, command outcomes and fixture provenance.
Generated signatures and mocked browser providers do not prove acceptance by
an installed wallet extension or a public RPC provider.

## Separate operator acceptance

A real-wallet review requires an operator-controlled desktop wallet, a separately
funded transaction submitter, current deployment manifests and explicit consent
for test-network transactions. Never export the Cardano private key. Record:

- Wallet/browser versions and stake/payment address types, with exact CIP-8
  protected headers and credential association verified independently.
- Fresh enrollment and repeated identity derivation, verifying the selected
  wallet and intended chain/account configuration before signing.
- General, target-allowlist and selector-allowlist profiles through direct,
  application-adapter and private-bundler submission: nine authorized operations.
- Invalid-signature and forbidden-call controls, nonces, receipts, counter/balance
  changes, gas, and bundler restart/cleanup behavior.

Use the tools described in [deployment](deployment.md), [reference app](reference-app.md),
and [operations](operations.md). Keep operator captures and identifying details
in private local storage. Share only deliberately reviewed, sanitized evidence.
Prior private operator reports are not bundled as public acceptance evidence and
are not substitutes for validating changed source. The repository's local CI
performs no public-network transactions.
