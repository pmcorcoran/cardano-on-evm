---
"@cardano-on-evm/wallet": minor
"@cardano-on-evm/sdk": minor
---

Add an explicit shared CIP-30 connector and Eternl support alongside Lace.
Export wallet selection, provider and connection types and recoverable CIP-30
errors. Preserve explicit credentials, exact signature verification and the
existing Lace connector. Browser applications require fresh enrollment after
wallet changes and record reported wallet provenance without inferring brand
authenticity from a signature.
