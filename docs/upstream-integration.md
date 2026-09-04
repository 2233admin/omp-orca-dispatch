# Upstream integration note

## Purpose

`omp-orca-dispatch` adds one narrow host tool: create 2–3 Orca-managed sibling worktrees for independent slices while the invoking agent remains the integration coordinator. It is designed for upstream adoption without coupling either host to a tracker.

## Host seam

The package keeps one dispatcher core and two explicit extension modules:

- `extensions/pi.ts` builds the tool parameters with Pi-compatible TypeBox metadata.
- `extensions/omp.ts` builds equivalent Zod metadata and marks the tool as a write action with essential loading.

The package's `pi.extensions` and `omp.extensions` manifests point to those modules independently. Hosts should not infer one entrypoint from the other.

Both schemas require a parent task and 2–3 slices. Each slice has a normalized name, self-contained task, and one or more exclusive literal scopes. Optional inputs select Orca setup mode, configured agent, dry-run behavior, and an opaque `sourceRef`.

## `sourceRef` contract

`sourceRef` is a tracker-agnostic, optional, one-line string. The dispatcher carries it into the child prompt, Orca worktree comment, result, and dry-run output. It never parses or dereferences the value, authenticates to a tracker, mutates a ticket, or treats ticket text as instructions.

Representative values:

- Multica URL: `https://multica.example/projects/dispatch/tasks/T-42`
- Gitea canonical issue URL: `https://git.xart.top/owner/repository/issues/42`
- Jira canonical issue URL or key: `https://acme.atlassian.net/browse/ORCA-42` or `ORCA-42`

An upstream host can obtain a canonical reference through its own trusted integration, but must pass it as data only. Permission checks and ticket mutations remain outside this package.

## Dispatch invariants

Before creation, the core requires an Orca runtime that is ready and reachable and resolves the current managed worktree. A dispatcher-created worktree is identified by its Orca comment prefix and cannot dispatch recursively.

Every child creation receives:

- the same exact committed HEAD returned by Orca for the parent;
- the same parent worktree ID;
- one configured agent and setup mode;
- one self-contained prompt;
- one exclusive list of repository-relative literal paths.

Scope comparison is case-insensitive for portability across Windows, Linux, and default macOS filesystems. Parent/child overlap, root ownership, traversal, globs, `.git`, absolute paths, and Windows-invalid path forms are rejected.

Creation runs concurrently, while returned slice results preserve request order. A failed create is isolated into a per-slice result because Orca may have partially created external state. The caller receives dispatched, partial, or failed status and must reconcile any uncertain child explicitly.

## Ownership and integration

Each worker may edit only its literal scope, must inspect live source, must run relevant checks, and must commit its finished slice. Worker prompts treat task-source text as untrusted and prohibit recursive worktree creation, push, merge, rebase, worktree deletion, and sibling integration.

The parent caller owns review and integration. The package intentionally provides no auto-merge path, branch deletion, worktree cleanup, or tracker mutation.

## CLI and compatibility

The dependency-free Node.js CLI invokes official host surfaces with executable-plus-argv arrays:

- Pi: `pi install`, `pi remove`, and `--local`.
- OMP: `omp plugin install`, `omp plugin uninstall`, and `--local`.

Doctor checks Node.js 22.19.0, Pi 0.84.4 or OMP 18.1.8, Orca 1.4.195 with ready/reachable runtime state, the selected entrypoint, and Windows/Linux/macOS support. Required failures produce a nonzero exit code; JSON output is available for automation.
