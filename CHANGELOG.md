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
