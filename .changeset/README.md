# Coordinated versions

Run `npm run changeset` for a public API, behavior, or documentation change that
should be included in the next release. Describe the change and select its
semantic-version impact. All six libraries form one Changesets fixed group.

`npm run version:apply` consumes changesets, creates per-package changelogs,
updates sibling dependencies, and synchronizes the workspace, lockfile, and
`versions.json`. The version workflow proposes those changes in a normal PR.
`npm run version:check` checks their consistency. No release bump is part of
installing this CI/CD system.

Changesets is used only for versioning. Packages are private to prevent registry
publication, and Changesets tagging is disabled. The separate approval-gated
workflow distributes versioned archives through GitHub Releases.
