# Security policy

This is unaudited smart-account and cryptographic software. Local tests do not
establish production safety or public-chain acceptance. Review the
[threat model and limitations](docs/security.md), [dependency review](docs/dependency-review.md),
and [deployment guidance](docs/deployment.md) before using it with funds.

## Report a vulnerability privately

On the hosted repository, use **Security → Advisories → Report a vulnerability**
when private vulnerability reporting is enabled. Hosted setup is still future
work; a policy file alone does not enable that channel.

If that option is unavailable, ask @pmcorcoran for a private contact method using
a public issue or comment containing only the contact request. Do not include
exploit details, keys, tokens, signatures, personal information, or affected
operator identities in that request. No project security email is configured.
Wait for a private channel before sharing sensitive information.

A useful private report identifies affected versions or commits, the violated
security boundary, impact, and a minimal reproduction using generated test keys
and a local chain. Never send wallet seed phrases or private keys. Coordinate
disclosure and fixes with the maintainer; no response-time guarantee is offered.

## Supported source and fixes

Before the first public release, report problems against the current source and
the coordinated `0.1.0` package line. No version is designated production-ready.
Security fixes will target the current maintained source; older snapshots have
no promised backport window. Follow the release notes for compatibility changes.

Every severity of npm finding is evaluated across the core, optional bundler and
source build tools. The dependency exceptions file is currently empty. CI also
runs secret scanning and CodeQL; successful scans are not a security audit.
Do not bypass a failed security check to publish a release.
