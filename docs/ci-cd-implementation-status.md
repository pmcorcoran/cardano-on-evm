# CI/CD implementation

The initial `0.1.0` repository includes coordinated version checks, core and
optional bundler lanes, security and source/package inventory checks, exact
archive consumer validation, provenance and gated GitHub release workflows.
The [operator runbook](github-cicd.md) describes configuration; this file does not
claim hosted checks, repository protection or maintainer approvals exist.

Local validation stages are exported with an ordinary Git add and checkout-index
from a disposable repository. Hashes and executable bits must match the source
inventory. Source continuity, process cleanup and network-denial gates remain
active. Ignored required inputs fail before a build can hide the omission.

[Acceptance](acceptance.md) lists the complete current commands and output paths.
Actual source/artifact hashes, command statuses, eight deployment rows, four
replay controls and browser/bundler evidence belong to each new run report.
Versions stay at `0.1.0`. Public source import and release are separate operator
actions, with publication disabled by default and additional security gates.
