# Reference application

The loopback reference app implements explicit credential selection, scoped
enrollment, prediction, preparation/funding guidance, call/batch/transfer review,
wallet authorization and public/private/direct submission status. The Cardano
wallet controls the account; the server's transaction key pays gas only.

## Run with current infrastructure

Build contracts and libraries, then supply a verified current profile manifest:

```sh
npm run dev:reference -- --manifest=.local/my-infrastructure.json.profiles.json --port=4174
```

The manifest requires fixed `portable` build metadata, current artifact bindings,
chain 84532 and `item.config` records. Missing or contradictory metadata rejects.
An unsigned infrastructure plan cannot enable the application. See
[deployment](deployment.md) for constructing and verifying these inputs.

Open `http://127.0.0.1:4174`, select Lace or Eternl (default: Lace), enter the actual installed extension
release, and connect a Cardano testnet software wallet. Enroll a profile using an
explicitly selected reward address. The reference and live-operation apps use
stake credentials; the wallet laboratory provides explicit payment/stake selection. Review permanent restrictions before using a restricted
account. General accounts expose Cardano-root administration; target and selector
profiles have no administrator or owner opt-out. A changed key/header/policy can
select another identity. Changing only the chain preserves portable addresses
when the relevant infrastructure matches, but requires chain-bound enrollment
and operation authorization.

Public mode uses the configured ERC-4337 provider. Private mode requires an
explicitly configured separate service and token file. Direct mode additionally
requires `--key-file`, `--infrastructure-manifest` and `--journal`. Its gas payer
has no Cardano-account key. The server rechecks current chain/runtime/immutable
bindings and uses a nonce lock plus the supplied durable transaction journal.

## Funding and server capabilities

Preparation, EntryPoint deposit, account transfer balance and outer submitter gas
are separate budgets. The server exposes preparation intents and state; it does
not spend operator funds on every visitor. The unsponsored operation cap is
0.0000425 test ETH; transfer, per-field gas, body, rate and concurrency limits
also apply. Fees or calls cannot silently change after the wallet review.

Host/Origin checks, bounded streamed JSON, two-hour sessions, at most 100 sessions
and 1000 tracked operations bound this local demonstration. Production hosts
supply TLS, authentication, durable sessions/operations and funding policy.
Core enrollment supports replaceable memory and SQLite stores with atomic
consumption. A timeout preserves the operation hash; inspect receipt/nonce before
retrying. Inner execution failure is distinct from a successful outer transaction.

## Evidence and application boundaries

New runtime captures default to `.local/reference-evidence`, overridable with
`--evidence-dir`. Public signatures and canonical receipt data are stored without
session tokens or private keys. Wallet ID, provider name, CIP-30 API version, installed extension release and
browser user agent are reported provenance. Signature verification establishes
key/address ownership, not wallet-brand authenticity. Legacy evidence without a
wallet ID remains unspecified.
Restarting requires fresh enrollment and the server refuses to overwrite an
already recorded authorization. These files reflect the actual supplied inputs;
no public-network or real-wallet success is presumed.

## Automated checks

The exporter creates `.local/reference-profile-manifest.json`,
`.local/reference-browser-fixtures.json`, a generated browser wallet, and four
requests in `.local/review-requests/`. Every record is generated test data using
synthetic infrastructure and public test keys. Base-Sepolia-shaped chain values
only support loopback tests. The test RPC accepts specified reads and rejects
transaction methods; the reference server rejects fixture submissions.

```sh
node node_modules/tsx/dist/cli.mjs scripts/export-reference-browser-fixtures.ts
node scripts/ci/local-rpc-plan.mjs
```

The [full core harness](acceptance.md) starts the read-only RPC and reference
server with the explicit generated manifest, feeds `REVIEW_REQUESTS_DIR` to the
browser review test, and captures logs/screenshots/traces. HTTP checks exercise
all reference profiles, repeated derivation, atomic enrollment races and origin
rejection. Browser mocks exercise review, wallet changes, declined signing,
exact payloads and malformed inputs. These tests cannot establish provider
admission or a real wallet session.

## Wallet changes

All three apps default to Lace and connect only the selected injected provider.
The extension release field starts empty and clears on a wallet switch. It must
contain the actual installed release, not CIP-30 `apiVersion` (often `1`).
Connection/signing requests disable the selector until the request completes.
Reconnecting or switching clears addresses, reference enrollment sessions and
prepared reviews; delayed results from old selections are ignored. A declined
signature can be retried. Lost access or an account change requires reconnection.
Already submitted operation hashes remain accessible through the receipt panel.

Enroll each profile afresh after a wallet switch. Even the same Cardano key can
produce a different Base account if the wallet's exact signed protected headers
change. The application does not migrate funds or normalize those signed bytes.
The live-operation laboratory checks the reported enrollment wallet ID when it is
present in the prepared request. Older requests have unspecified provenance.

For the initial format checkpoint, run `npm run dev:wallet`, open
`http://127.0.0.1:4173`, select Eternl, and sign once for Stake and once for Payment.
Each capture asks for an enrollment challenge and a 32-byte operation format
probe. These probes do not submit transactions. The server requires both
signatures to use the same key and exact protected headers before saving success.
See [Eternl acceptance](eternl-acceptance.md) for the remaining real-wallet matrix.
