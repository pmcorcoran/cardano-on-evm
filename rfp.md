# Request for Proposals: Cardano-Controlled Smart Accounts on Base

Status: Draft

## 1. Objective

We seek proposals to design, implement, test, and document an open source software package that applications can integrate so their users can control a smart-contract wallet on Base using their existing Cardano wallet.

The package must include Cardano wallet enrollment, a Kernel smart account with Cardano signature validation, developer tooling, and a self-hostable private bundler. Applications must be able to use the smart-account package independently of that private bundler, choose how transactions are submitted, and configure accounts for general-purpose or restricted use.

The user's Cardano key must authorize account operations. Application backends and transaction submitters must not acquire spending authority merely by providing enrollment, submission, or gas sponsorship services. Users must not need to export their Cardano private keys or obtain a separate Ethereum signing key to control the account.

The target execution network is Base. Development and acceptance demonstrations must use Base Sepolia, with documented configuration and deployment procedures for Base mainnet.

## 2. Required deliverables

“Must” denotes a mandatory requirement. “Should” denotes a preferred capability; proposals must explain any limitations and alternatives.

### Deliverable 1: Cardano enrollment and deterministic Base account identity

Deliver a wallet integration library and backend enrollment component implementing this sequence:

1. The backend issues an unpredictable, expiring, one-time challenge bound to the application, claimed Cardano address, intended Base chain, and account configuration.
2. The user's Cardano wallet signs the challenge.
3. The backend verifies the signature and checks that the supplied public key matches the relevant key credential of the claimed Cardano address. Verifying a signature against a supplied key alone is insufficient.
4. The verified public key is used to deterministically derive the user's Base smart-account address and initialize its Cardano validator.

The integration must support the Cardano wallet signing interface described in [CIP-30](https://cips.cardano.org/cip/CIP-0030), including its CIP-8 signature and key representation. The package must expose a wallet adapter interface, include a working Lace integration, and document tested wallet versions, address types, and signing limitations.

The implementation must reject expired or reused challenges, mismatched addresses or networks, invalid signatures, and unsupported encodings. Successful challenge consumption must be atomic so concurrent requests cannot reuse it. Any fallback between payment and stake credentials must be explicit and tested.

Account derivation must be reproducible in both the SDK and backend without a secret or vendor service. Document every input, including the public key, factory, implementation and validator versions, initial restrictions, and any account index or namespace. With identical derivation inputs, enrollment must return the same address across sessions. State which configuration changes produce a different address.

Deliver reusable backend handlers, a replaceable challenge-storage interface, signature fixtures, and examples for predicting an address before deployment and deploying the corresponding account. Enrollment challenges must be distinct from transaction authorizations.

### Deliverable 2: Kernel execution and a working private bundler

Deliver deployable smart contracts, a client integration, and a self-hostable private bundler that demonstrate the complete transaction path:

1. The application constructs a requested account operation.
2. The Cardano wallet signs the operation authorization.
3. The private bundler submits the operation to EntryPoint.
4. The Kernel account invokes its Cardano validator, which verifies the signature onchain against the enrolled public key.
5. The account applies its configured restrictions and executes the authorized call.

Use [Kernel](https://github.com/zerodevapp/kernel) and its modular account interfaces. Proposals must identify and pin compatible Kernel, EntryPoint, SDK, and bundler versions, with verified deployment addresses and reproducible build instructions.

The validator must bind authorization to the actual operation and its execution context, including the account, chain, EntryPoint, and nonce. A submitter must be unable to change the authorized call or reuse the authorization for another account or operation. A backend attestation must not replace onchain verification of the user's Cardano authorization.

The private bundler may extend an existing open source implementation. Deliver its source or pinned upstream source with all modifications, reproducible deployment configuration, operating instructions, and transaction-status integration. Any changes to standard admission or simulation rules must be documented and configurable.

### Deliverable 3: Independence from the private bundler

The smart contracts, account factory, enrollment components, and core SDK must work without installing or running the supplied private bundler. Account identity and authorization must not depend on a particular bundler endpoint, operator, API key, proprietary service, or bundler-issued credential.

Provide separate transaction-submission adapters for these modes:

| Mode | Required behavior |
| --- | --- |
| Private bundler | Submit through the delivered self-hosted service. |
| Public bundler | Submit through an independently operated public ERC-4337 bundler using supported standard interfaces. |
| Direct submission | Submit an authorized operation through a normal Base RPC connection without a running bundler service or bundler RPC endpoint. |

For direct submission, an acceptable approach is a funded transaction submitter calling EntryPoint's `handleOps` with the signed operation. Document the submitter's role, gas funding, account prefunding or sponsorship, and receipt handling. This path retains EntryPoint and account validation; “without a bundler service” does not remove the need for an onchain transaction or gas payment. See the [ERC-4337 EntryPoint execution flow](https://eips.ethereum.org/EIPS/eip-4337#required-entrypoint-contract-functionality).

Applications must be able to create accounts for each supported mode. Switching submission adapters for a compatible deployed account must preserve its address, Cardano ownership, balances, and restrictions.

Public-bundler compatibility must be demonstrated, including account deployment and subsequent execution, against at least one named public service on Base Sepolia. Supply its configuration and observed results. Public admission depends on validation rules and resource limits, including those in [ERC-7562](https://eips.ethereum.org/EIPS/eip-7562); configurable RPC URLs alone do not establish compatibility.

Proposals must explain how Cardano signature verification will meet those constraints. If different account configurations support different modes, provide a compatibility matrix and explain portability limits. Public support must retain Cardano-controlled authorization. Unresolved feasibility must be identified in the proposal and resolved at the first milestone; a private-only implementation does not satisfy this deliverable.

Gas sponsorship may be provided as an optional module. Use of a particular paymaster must not be a prerequisite for account ownership or operation.

### Deliverable 4: General-purpose and configurable restricted accounts

Implementers must be able to create either:

- **General-purpose accounts:** users can authorize arbitrary supported contract calls, transfers, and batches, subject to normal protocol constraints.
- **Restricted accounts:** implementers select configurable policies that limit permitted actions, with a documented interface for adding policies.

Deliver working restricted-account examples for allowed contract addresses and function selectors. Proposals should describe support for additional policies such as transfer or spending limits, permitted recipients, and time windows.

Account restrictions must be enforced onchain across every enabled execution path, including public bundlers and direct submission. Frontend checks, private-bundler admission rules, and paymaster sponsorship policies do not establish an account restriction.

Document who can install, update, or remove each restriction and whether a user can opt out. Explain how root authorization, upgrades, module changes, batches, and any enabled delegatecall or executor paths interact with the policy. A profile described as enforcing a restriction must prevent its circumvention through those paths within its stated authority model.

Account creation must make the selected policy and administrative powers explicit. Any application-controlled administrative role must be optional and documented, including its effect on user control.

### Deliverable 5: Configurable and, where feasible, modular private bundler

Deliver a private bundler that implementers can configure for their application. At minimum, expose configuration for network and EntryPoint selection, RPC providers, admission and access rules, gas and fee limits, submission credentials, and logging.

The bundler should provide documented extension points for admission policies, simulation settings, queueing and scheduling, gas estimation, transaction submission and retries, optional sponsorship integration, and metrics. Prefer configuration or replaceable components that applications can adapt without modifying the core bundler or smart-account contracts.

Demonstrate an application-specific admission rule and its replacement or reconfiguration. Explain which components are modular, which require upstream changes, and the maintenance cost of any fork. Where modularity is impractical, the proposal must identify the limitation and propose a supported customization approach.

Changes to bundler policy must not grant spending authority or weaken the account's onchain signature and policy checks.

## 3. Open source package and developer experience

The final delivery must include:

- A public source repository with an open source license permitting commercial integration, modification, redistribution, and self-hosting. State the proposed license and all dependency licensing obligations; MIT or Apache-2.0 is preferred for newly developed code.
- Versioned Solidity contracts and a TypeScript SDK with documented APIs for enrollment, address derivation, account creation, operation construction, signing, submission, and status retrieval.
- Reusable backend components and independently deployable bundler infrastructure, with clear package boundaries and replaceable service interfaces.
- A reference application demonstrating enrollment, an asset transfer, a contract call, submission-mode selection, and general-purpose and restricted account configurations.
- Deployment scripts, dependency lockfiles, environment templates, automated checks, and instructions for reproducing a release from a clean checkout.
- Integration and operations documentation covering funding, error handling, wallet/account changes, upgrades, supported versions, extension points, and troubleshooting.

Required functionality must be available from the delivered source. Third-party hosted endpoints may be selected by implementers, with their fees and operational requirements documented.

## 4. Verification and acceptance

Acceptance requires executable tests and reproducible demonstrations, with test results and relevant Base Sepolia transaction receipts. The following checks are mandatory:

| Area | Acceptance evidence |
| --- | --- |
| Enrollment | A real Cardano wallet signature enrolls the correct key; expired, replayed, concurrently reused, tampered, and address-mismatched challenges are rejected. |
| Account identity | Independent SDK and backend derivation agree, repeated enrollment is stable, and deployment produces the predicted account with the expected owner and configuration. |
| Signature validation | Valid operations execute; incorrect keys, altered operations, invalid encodings, nonce replay, and cross-account or cross-chain reuse fail. |
| Private bundler | A complete enrollment-to-execution demonstration passes through the delivered bundler, EntryPoint, validator, and Kernel account. |
| Public bundler | A named public service accepts both deployment and later operations for a documented Cardano-controlled account configuration. |
| Direct submission and portability | With the supplied private bundler stopped, a compatible deployed account executes through public and direct adapters while retaining its address, ownership, and policies. Include a direct deployment example. |
| Account policies | General-purpose calls and batches succeed; restricted accounts accept allowed actions and reject prohibited actions across supported submission modes, including attempts to bypass policy through enabled alternate execution or administration paths. |
| Bundler customization | An application changes or replaces an admission policy without modifying account contracts; account authorization remains enforced. |
| Reproducibility | A developer can build, test, deploy, and run the documented examples from the delivered repository. |

Report measured deployment gas, signature-validation gas, and total transaction gas for first and subsequent operations. Include representative calls and batches, test conditions, and any bundler-specific limits. Estimates from an isolated signature verifier do not replace full-path measurements.

Deliver a threat model and a record of security review and resolved findings, with particular attention to cryptographic verification, enrollment binding, replay protection, policy enforcement, and administrative authority. Identify unaudited dependencies and any remaining issues. Proposals must separately state the scope and cost of any independent audit; an external audit is not implied by passing functional tests.

## 5. Proposal response requirements

Proposals must include:

1. An architecture and package breakdown mapped to Deliverables 1–5, marking each requirement as supported, proposed, or subject to feasibility work.
2. The selected technologies and versions, reused open source projects, licensing, and expected upstream modifications.
3. A concrete plan for public-bundler compatibility, direct submission, Cardano signature verification, deterministic account derivation, and policy enforcement.
4. Supported Cardano wallets and account/address types, planned compatibility testing, and known limitations.
5. A milestone schedule, staffing plan, itemized budget, and ongoing operating and maintenance costs.
6. The test and security-review approach, relevant prior work, and post-delivery maintenance and handover commitments.
7. Clearly priced optional work, such as additional wallet adapters, paymasters, advanced policies, recovery, or key rotation.

## 6. Delivery milestones and evaluation

Proposals should organize delivery around these milestones:

1. **Feasibility and architecture:** real-wallet signature proof, deterministic address design, measured verification cost, and evidence that the proposed public and direct submission paths are viable.
2. **Core package:** enrollment, validator, Kernel integration, SDK, and general-purpose and restricted account examples.
3. **Submission infrastructure:** private bundler, customization interfaces, public and direct adapters, and integration demonstrations.
4. **Release and handover:** acceptance evidence, security-review findings and fixes, documentation, reproducible release, and maintenance handover.

Evaluation will prioritize demonstrated compliance with the five deliverables, user control, independence from any particular bundler or vendor, integration quality, measured performance, maintainability, and total cost. Proposals must distinguish implemented and tested capabilities from assumptions and future work.
