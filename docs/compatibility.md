# Supported encodings and integration boundaries

| Area | Initial `0.1.0` behavior |
| --- | --- |
| Accounts | General, restricted targets, restricted selectors, experimental-general |
| Connectors | Explicit `lace` and `eternl` CIP-30 providers; default browser selection is Lace; no automatic provider fallback |
| Derivation | Portable for every account; chain ID binds enrollment and operations |
| Cardano credentials | Explicit payment types 0, 2, 6 and stake/reward type 14; key credentials only |
| Networks | Cardano network 0 or 1 must match the address; network 0 does not distinguish testnet deployments |
| Signatures | CIP-30 `signData`, Ed25519 CIP-8 COSE_Sign1 and COSE_Key |
| Protected headers | Canonical algorithm/address with optional matching key ID; exact bytes affect identity |
| Unsupported encodings | Hashed/detached payloads, script credentials, unknown/duplicate/nonminimal CBOR, mismatched key IDs, invalid subgroups |
| EVM authorization | EntryPoint v0.7, Kernel 0.3.3, canonical CALL and atomic batch, chain-bound operation hashes |
| Delivery | Public/private ERC-4337 and ordinary-RPC direct `handleOps`; provider admission is independent |
| Sponsorship | Optional wire fields; a hosted paymaster is not supplied |
| Recovery | No recovery product; immutable restricted profiles have no administrator or opt-out |

The browser adapter supports a CIP-30 wallet interface and explicit credential
selection. A wallet brand/version, hardware device, address shape or public
provider needs its own acceptance run. Generated signatures and browser mocks
cannot prove real-wallet behavior. Larger payment headers may exceed a provider's
verification budget even when offchain verification accepts them.

The reference server targets Base Sepolia's chain ID and requires a supplied
current manifest. Generated Base-Sepolia-shaped fixtures are undeployed,
unfunded loopback data; their RPC refuses transaction methods. Public network
addresses in `versions.json` are configuration pins, not assertions of a fresh
network check. Mainnet deployment and public-network acceptance are outside the
local initial-release validation.

The core clean-source and separate bundler harnesses record their actual
commands, toolchains, outputs and limits. See [acceptance](acceptance.md).

## Wallet acceptance coverage

| Wallet | Automated credential/format coverage | Installed extension/browser version | Real captures / Base Sepolia matrix |
| --- | --- | --- | --- |
| Lace | Generated providers: payment and stake, supported exact CIP-8 encodings and rejection cases | Not established by this Eternl change | No new real-wallet acceptance claimed |
| Eternl | Same generated-provider connector cases; all three browser suites select it alone and alongside Lace | Operator-reported Eternl 2.1.7.1, CIP-30 API 0.1.0, Chrome 153.0.0.0 on Linux | Genuine stake/payment format pairs, repeated fresh enrollment, all nine Base Sepolia routes and both onchain restriction controls verify; public/direct independence is verified |

Generated fixtures cover canonical unhashed Ed25519 COSE_Sign1/COSE_Key with
and without a matching key ID. The genuine Eternl captures on 2026-09-17 use
canonical unhashed Ed25519 COSE with no key ID: stake/reward address type 14
has 42-byte protected headers, and payment address type 0 has 70-byte headers.
Each enrollment/32-byte probe pair preserves the exact same key and header
bytes. This format check submits no transaction and does not establish provider
admission or onchain execution. The [Eternl acceptance report](eternl-acceptance.md)
records exact keys, headers, capture hashes and results separately from generated
fixtures and network evidence.
Desktop software wallets are in scope; mobile and hardware wallets are not.

Fresh enrollment is required after switching wallets. The same Cardano key can
produce different Base identities when the exact protected-header bytes differ.
No header normalization, weakened verification or automatic account migration is
provided. Wallet metadata is reported provenance; a valid signature proves
key/address ownership, not the provider's brand or installed release.
