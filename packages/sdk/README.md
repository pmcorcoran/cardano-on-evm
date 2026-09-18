# @cardano-on-evm/sdk

Initial 0.1.0 MIT-licensed SDK for Cardano-controlled Kernel accounts. Exports
`enrollCardanoAccount`, `httpEnrollmentTransport`, `accountFromVerifiedKey`,
`accountFactory`, `accountPreparation`, `constructOperation`, `signOperation`,
`connectWallet`, `connectLace`, `connectEternl`, `CardanoWalletError`, wallet
provider/adapter/selection types and protocol helpers/types.

General, restricted target/selector, and experimental-general accounts always
use portable derivation. Matching addresses require matching infrastructure,
creation bytes and identity inputs. Chain ID remains required for enrollment
and operation signing. `CardanoAccount.config` is a frozen, read-only
`ResolvedAccountConfig`; use current named artifacts from
`@cardano-on-evm/contracts` and verified factory addresses when configuring it.

Enrollment compares the backend's complete independent identity prediction.
Signing snapshots the reviewed operation and configuration, checks the enrolled
wallet credential and network, and verifies the returned CIP-8 authorization.
Unsupported configuration fields reject before the wallet signer is invoked.
Permanent restricted profiles have no administrator, policy replacement, key
rotation or upgrade escape; applications must present those powers clearly.

Transport is separate: use `@cardano-on-evm/submission` for public/private ERC-4337
or ordinary-RPC direct submission. Installing this SDK never installs Alto.
The six local tarballs are installed together by the source release's isolated
consumer command. See `docs/sdk.md` and runnable `apps/reference` in that release.

Select Lace or Eternl explicitly through `connectWallet(injection, walletId, 0)`.
Discard enrollment and prepared reviews when switching wallets or reconnecting;
keep submitted operation hashes available for receipt checks. The same Cardano
key may yield a different Base identity when signed protected headers differ.
Wallet brand, extension release and CIP-30 API version are reported provenance;
cryptographic verification proves key/address ownership, not wallet brand.
See `docs/eternl-acceptance.md` for automated versus real-wallet acceptance status.
