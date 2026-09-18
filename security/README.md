# CI security policy

`python3 scripts/ci/security.py audit --out .local/security` audits the root,
`infra/bundler`, and `infra/bundler/build-tools` lockfiles. It saves the raw npm
audit response, audit exit status, lockfile SHA-256, CycloneDX `npm sbom` output,
and lockfile-derived license inventory inputs for each tree. These are inputs to
the candidate's validation, SBOM and license assets. An audit service failure or
unusable response fails the lane; it never means zero vulnerabilities.

Every unapproved advisory/version fails policy, including low/moderate findings.
This deliberately implements the plan's requirement to block new unapproved
findings as well as its high/critical minimum. Findings stay visible when an
exception applies. `validate` evaluates saved reports for policy regression and
review; saved reports alone are not fresh release evidence.

`dependency-exceptions.json` currently has **no approved exceptions**. The
exposure descriptions in [dependency-review.md](../docs/dependency-review.md)
do not identify an authorized owner, approval date or expiry. This implementation
does not turn those historical assessments into approval. The pinned bundler's
known findings therefore block security CI and candidate finalization pending a
maintainer decision or a tested compatible dependency change.

To accept a specific finding, a maintainer must review its actual current
advisory, exact affected package/version, exposure conditions and mitigation,
then submit an ordinary reviewed PR adding one record per affected version. A
record has exactly these fields (the placeholders below are intentionally invalid):

```json
{
  "tree": "infra/bundler",
  "advisory": "GHSA-REPLACE-WITH-ID",
  "dependency": "exact-package-name",
  "version": "1.2.3",
  "severity": "high",
  "rationale": "Describe the reviewed exposure and reason for bounded acceptance.",
  "owner": "@REPLACE",
  "approved_at": "YYYY-MM-DD",
  "expires_at": "YYYY-MM-DD"
}
```

`tree` is exactly `.`, `infra/bundler` or `infra/bundler/build-tools`; package
versions are exact, with no ranges/wildcards. Dates use UTC. Expiry is exclusive
and no more than 30 days after approval; the validator rejects expired, future,
duplicate, incomplete and unknown fields. Increased severity, new advisory,
different dependency or changed version requires a new reviewed decision. Do not
automatically renew records. Weekly Dependabot PRs for all three npm trees, the
hash-locked browser requirements and GitHub Actions still run normal CI.

`python3 scripts/ci/security.py check --out .local/ci/security` additionally runs
Gitleaks against the complete fetched Git history. A source snapshot without Git
history can be inspected with `scan --root TREE --out REPORT.json`, the same
entry point used on extracted release archive contents. Scan output omits secret
values/snippets, and inline `gitleaks:allow` comments or a payload's
`.gitleaksignore` cannot suppress findings. Scan exceptions must be narrowly
reviewed in the repository's `.gitleaks.toml`; no broad allowlist is installed.
Gitleaks and actionlint Linux executables are downloaded at explicit versions,
verified against pinned release-asset SHA-256 digests and atomically extracted.

The committed scanner exceptions require **both an exact path and an exact
public value**, and apply only to the generic API-key detector. They cover:

- Three public Ed25519 seeds from [RFC 8032 §7.1](https://www.rfc-editor.org/rfc/rfc8032#section-7.1)
  in the pinned SCL test file, the public default Anvil account-zero address/key,
  and its account-one key in the existing local bundler example. Anvil's defaults are defined in the
  [pinned upstream configuration](https://github.com/foundry-rs/foundry/blob/v1.8.1/crates/anvil/src/config.rs).
- Two exact SHA-256 integrity pins for Solady WebAuthn source files in
  `vendor/sources.json`, checked by the existing vendor verifier.
- The exact existing public COSE verification-key encodings in named captures
  and the generated CIP-8 fixture. These maps contain public key parameter -2
  and no private parameter; `packages/wallet/src/cip8.ts` validates their format.
- One public address-derived request identifier and four deterministic public
  verification keys emitted by `scripts/experiments/crypto-corpus.ts`.

No whole file, directory, history range or rule is disabled. Newly captured
public data requires review before an additional exact exception. Actual scanner
regressions prove that an unrelated credential in the same path still fails,
that moving an allowed value to an unreviewed file fails, and that reports do
not reveal the synthetic credential. Configuration syntax follows the
[pinned Gitleaks documentation](https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md#configuration).

The CodeQL matrix analyzes JavaScript/TypeScript, Python and GitHub Actions using
the extended security suite. Uploading SARIF alone does not block a merge. Each
matrix cell therefore evaluates its actual SARIF with `scripts/ci/codeql.py`,
fails for security severity >=7.0 (high/critical), and records the successful gate
through the current-run evidence wrapper. Missing reports, malformed SARIF,
unknown rules and analyzer errors fail closed; suppressions and unchanged
baseline results do not waive the high/critical gate. Solidity remains covered
by the existing compilation, execution and bytecode-pin acceptance tests.

Configure the main branch ruleset to require `ci-required`, plus **Require code
scanning results → CodeQL → Security alerts: High or higher**. Require CodeQL
Errors as well. CodeQL analysis, a passing YAML lint, and this document do not
prove server-side settings have been applied. PR workflows use `pull_request`
and read-only repository contents, without version/release credentials. Only the
CodeQL job additionally requests `security-events: write` and `packages: read`
(CodeQL packs); fork tokens retain GitHub's restrictions. No `pull_request_target`
or privileged follow-up executes untrusted PR code.

Nightly Base Sepolia compatibility has a separate job/artifact and does not feed
`ci-required`; nightly security and every applicable local/candidate lane do.
Monitor failed jobs in GitHub Actions and findings in the repository Security
dashboard. A real fork PR and full candidate-only run remain mandatory remote
acceptance once the repository exists.

Verified upstream behavior and pin sources (2026-09-11):

- [Code scanning workflow options](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options)
  and [merge-protection configuration](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/set-merge-protection).
- [CodeQL analyze inputs at the pinned commit](https://github.com/github/codeql-action/blob/b96794f015dfd88f77b49b1c93e0fa7110f94c63/analyze/action.yml)
  (`ref`, `sha`, local SARIF output, processing wait) and
  [fork/Dependabot upload behavior](https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/resource-not-accessible).
- [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/),
  [npm SBOM lockfile mode](https://docs.npmjs.com/cli/v11/commands/npm-sbom/),
  [Gitleaks CLI/configuration](https://github.com/gitleaks/gitleaks), and
  [actionlint](https://github.com/rhysd/actionlint).
- Full commit pins for actions were resolved through the official repository's
  Git refs API. CodeQL's annotated `v4` tag resolved to commit
  `b96794f015dfd88f77b49b1c93e0fa7110f94c63`; the release tool digests came from
  [actionlint v1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12)
  and [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1).
