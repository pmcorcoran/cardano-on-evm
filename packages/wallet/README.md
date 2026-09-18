# @cardano-on-evm/wallet

Initial 0.1.0 MIT-licensed CIP-30 Lace/Eternl adapters, bounded CIP-8/CBOR verification and exact
Cardano public-key/address-credential binding. Exports `connectWallet`, `connectLace`, `connectEternl`, `CardanoWalletError`,
`verifyCip8Signature`, `parseCardanoAddress`, byte/CBOR helpers and adapter types.
No private bundler, Ethereum owner key or backend attestation is required.

```ts
import { connectWallet, type CardanoWalletInjection } from '@cardano-on-evm/wallet';
const injection: CardanoWalletInjection = window.cardano ?? {};
const wallet = await connectWallet(injection, 'eternl', 0);
const addresses = await wallet.addresses('stake');
```

The application chooses the credential explicitly. There is no automatic
payment/stake fallback. Supported encoding/address limits and generated
fixture coverage are documented in the source release's `docs/compatibility.md`.
Node ESM and TypeScript declarations are included; browser bundles need no
Node wallet APIs. Ethereum operation construction belongs to the separate SDK.

`CardanoWalletId` is `'lace' | 'eternl'`. Only the explicitly selected injected
provider is enabled; there is no fallback. `connectLace(injection, network)` keeps
its existing call shape; `connectEternl` provides the equivalent convenience API.
The generic `CardanoWalletAdapter` interface remains available for other adapters.

A `ConnectedCardanoWallet` exposes `walletId`, provider `name` and `apiVersion`.
`apiVersion` describes CIP-30; collect the installed extension release separately.
`CardanoWalletError` preserves the original `cause` and standard error `code`.
When `reconnectRequired` is true, discard connection/enrollment/review state and
reconnect explicitly. A declined data signature (code 3) can be retried.

Switching wallets requires fresh enrollment. Different exact protected headers
can produce different Base identities even with the same Cardano key; automatic
account portability and migration are not provided. Generated-provider coverage
is distinct from real installed-wallet acceptance. Desktop software wallets are
in scope; mobile and hardware-wallet behavior is unverified.
