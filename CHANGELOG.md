# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [Unreleased]

### Added

- Selectable worktree backend for `orca_task_dispatch`: the optional `backend` parameter accepts
  `orca` or `git-worktree`, falls back to `ORCA_DISPATCH_BACKEND`, and defaults to `orca`, so
  omitting it preserves the existing behavior. The `git-worktree` backend needs only `git` and
  refuses a slice scope containing uncommitted changes, because siblings branch from the
  committed HEAD.
- `docs/worktree-backends.md` documenting why the backend seam exists, the selection contract,
  the guarantees both backends preserve, and the git backend's extra precondition.
- Tracker adapters behind a seam in `src/trackers/`: `syncTarget.kind` accepts `multica`,
  `gitea`, or `github`, and `src/offline.ts` resolves the adapter by that kind instead of naming
  a tracker. `multica` keeps its previous argv exactly, `github` plans `gh issue comment
  --body-file`, and `gitea` plans a `curl` POST to the Gitea comments API that reads the body
  from the UTF-8 file and takes the token by variable name from the executing host. The package
  still emits a plan it never executes, reads no credential, and puts no secret value in the
  emitted argv; an unknown kind is rejected rather than guessed.
- `docs/tracker-adapters.md` documenting the adapter contract, the argv each of the three
  adapters emits, the checked upstream flag support, the plan-not-execute and credential
  boundaries, and how to add a fourth adapter.

## [0.1.0] - 2026-09-04

### Added

- Portable Orca dispatch core for 2–3 concurrent, disjoint worktree slices anchored to one exact parent HEAD.
- Explicit Pi TypeBox and OMP Zod extension entrypoints and package manifests.
- Dependency-free Node.js CLI for host install, uninstall, doctor, help, version, local operation, and dry-run actions.
- Scope validation rejects all C0 (`U+0000`–`U+001F`) and DEL (`U+007F`) control characters and compares deduplication/overlap keys using NFC normalization plus case-insensitive matching while preserving the first validated scope spelling.

### Added
- Observable-contract tests, cross-platform package metadata, Gitea and GitHub CI, contributor guidance, security policy, and Apache-2.0 licensing.

[Unreleased]: https://git.xart.top/chen-qianyu/omp-orca-dispatch/compare/v0.1.0...main
[0.1.0]: https://git.xart.top/chen-qianyu/omp-orca-dispatch/releases/tag/v0.1.0
