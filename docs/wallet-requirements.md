# Wallet integration requirements

Lace and Eternl share a wallet adapter without making one an implicit fallback
for the other. Applications select the wallet explicitly, and missing providers,
connection failures, network mismatches, unsupported credentials and cancelled
signing must produce clear errors. Existing Lace APIs remain available.

The reusable interface includes `CardanoWalletId`, `CardanoWalletInjection`,
`connectWallet`, and the wallet-specific connectors. Enrollment verifies the
CIP-8 signature, exact signed headers and binding between the key and the claimed
payment or stake credential. Transaction authorization remains distinct from
enrollment and bound to the intended account operation. A backend or EVM
submitter does not gain Cardano account authority.

Browser apps must display the selected wallet and intended network, handle
reconnection and stale state, and preserve the reviewed payload across signing.
Captures record known wallet identity without fabricating it for legacy records.
Both wallet-only configurations and explicit selection with both installed must
be tested. Core packages must operate independently of the private bundler.

Automated local acceptance and real-wallet/public-network acceptance are separate
claims; see [validation scope](eternl-acceptance.md). Desktop software wallets are
in scope. Mobile connections, hardware wallets, automatic account migration and
unrelated API changes require separate design and validation.
