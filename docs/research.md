# Protocol and upstream design references

These references explain the protocol and dependency boundaries. Exact reusable
source/compiler pins are in `versions.json` and `vendor/sources.json`; configured
addresses and provider links do not imply a new network acceptance run. No
independent audit of this package is claimed.

- [CIP-30](https://cips.cardano.org/cip/CIP-0030), `signData`: Ed25519,
  COSE_Sign1/COSE_Key; payment credential for payment addresses and stake for
  reward addresses; raw, un-hashed payload and empty external AAD. Network ID 0
  does not distinguish Cardano testnets. API version is not wallet release version.
- [CIP-8](https://cips.cardano.org/cip/CIP-0008): signature structure and headers.
- [CIP-19](https://cips.cardano.org/cip/CIP-0019): address types and credentials.
- [Kernel v3.3 source](https://github.com/zerodevapp/kernel/tree/v3.3): root
  validation uses the module interface. A real root hook makes Kernel require
  `executeUserOp` wrapping. `execute`, upgrades and module administration allow
  EntryPoint/self; a restricted design must gate wrapped calldata and prevent
  self-call/delegatecall/module bypasses. This needs executable adversarial tests.
- [ERC-7562](https://eips.ethereum.org/EIPS/eip-7562): maximum validation gas
  500000; storage, opcode, call and code access rules also apply. A verifier gas
  number alone does not establish bundler admission.
- [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337): retain EntryPoint validation
  in direct mode. SDK operation hashing must use the pinned EntryPoint version,
  not assume the evolving EIP's latest hash format.
- [FreshCryptoLib](https://github.com/rdubois-crypto/FreshCryptoLib): upstream
  marks this experimental project deprecated and unaudited, points to
  [Smooth CryptoLib](https://github.com/get-smooth/crypto-lib). Inspect maintained
  Ed25519/SHA-512 code and its exact audit scope before selecting it.
- [Pimlico public endpoint](https://docs.pimlico.io/references/bundler/public-endpoint):
  `https://public.pimlico.io/v2/84532/rpc`, no API key documented for prototypes,
  provider-specific rate limits apply. Read-only connectivity and real account admission remain
  separate checks. Optional testnet paymaster support cannot become an ownership
  dependency. Production prices/quotas require current provider terms.
- [Alto self-hosting](https://docs.pimlico.io/references/bundler/self-host):
  `safe-mode` requires a tracing RPC; disabling it bypasses offchain rules and
  must never be presented as public ERC-7562 acceptance. OP Stack has chain-specific
  gas handling. Upstream/npm license is GPL-3.0-or-later; keep separate from MIT SDK.

Rejected assumptions: P-256/RIP-7212 is not Ed25519; a backend signature is not
Cardano verification; a configurable public URL is not provider acceptance;
generated keys are not evidence of a real Lace signing session.
