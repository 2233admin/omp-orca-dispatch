# Worktree backends

Status: selection contract for `orca_task_dispatch`. The `orca` backend is the long-standing
path in `src/dispatcher.ts` and stays the default; the `git-worktree` backend is selected
explicitly. No other tool has a backend parameter: `orca_backlog` and `orca_outbox_sync` are
unaffected.

## Why the abstraction exists

Dispatch needs exactly two things from its environment: the parent's exact committed HEAD, and a
way to create sibling worktrees anchored to it. Until now both came from one runtime. The Orca
path first calls `orca status --json` and refuses unless the envelope reports `ok`, `runtime.state
=== "ready"`, and `runtime.reachable === true`; it then calls `orca worktree current --json` for
`repoId`, the current worktree `id`, and `head`, and finally `orca worktree create` once per
slice. A machine without a running, reachable Orca runtime therefore cannot dispatch at all, even
when the repository itself is perfectly ordinary.

That is a runtime dependency, not a requirement of the feature. `git worktree add` supplies the
same primitive — an independent checkout of one commit — for anyone with git. Splitting the
environment-facing part of dispatch into a backend keeps the package usable outside this fleet
without weakening any of the safety properties, which live in validation and prompt construction
rather than in the runtime.

| | `orca` | `git-worktree` |
| --- | --- | --- |
| Default | yes | no, opt in |
| Requires | a running Orca runtime that reports ready **and** reachable | `git` on `PATH` |
| Anchor source | `orca worktree current --json` | the local repository's committed HEAD |
| Creates siblings with | `orca worktree create` | `git worktree add` |
| Audience | Orca users, who also get agent launch and worktree comments | anyone using git, including CI and other editors |

Use `orca` inside the fleet: it is the verified path and it is what existing callers already get.
Use `git-worktree` when Orca is absent, not running, or unreachable, and a plain git checkout per
slice is enough.

## Selection contract

Precedence is explicit argument, then environment, then default:

1. The optional `backend` parameter on `orca_task_dispatch`, accepting `"orca"` or
   `"git-worktree"`.
2. `ORCA_DISPATCH_BACKEND`, read from the environment when the parameter is omitted. It follows
   the same convention as `ORCA_DISPATCH_AGENT` and `ORCA_CLI_COMMAND`: an override, never a
   secret.
3. `"orca"` when neither is set.

Omitting `backend` — or passing `"orca"` — keeps the previous behavior exactly, including the tool
name `orca_task_dispatch`, its parameters, and its result shape. Existing callers need no change.

An unrecognized value is a validation error, not a silent fallback, matching how `setup` and
`agent` are validated: a typo must not quietly reroute dispatch to a different runtime. The
selected backend is reported in the result and in dry-run output so the caller can see which
runtime was used.

## Guarantees both backends preserve

These are properties of the dispatch contract, not of a runtime, so they hold identically under
either backend:

| Guarantee | Meaning |
| --- | --- |
| 2–3 slices | A request must contain exactly 2 or 3 slices; names are normalized before the uniqueness check. |
| Scope validation | Every scope is a repository-relative literal path. Globs, parent traversal, absolute paths, the repository root, `.git`, Windows-reserved names, and C0 (`U+0000`–`U+001F`) or DEL (`U+007F`) control characters are rejected. Keys are compared case-insensitively after NFC normalization, so canonically equivalent Unicode paths cannot bypass disjointness; cross-slice parent/child overlap is rejected; the first validated spelling is retained. |
| Exact committed HEAD | Every sibling is created from the same single commit resolved once for the whole request. No slice silently starts from a branch tip that moved mid-dispatch. |
| Recursion refusal | Children are marked as dispatcher-created, and dispatching again from such a child is refused. Under `orca` the marker is the `Orca task dispatch` comment prefix on the current worktree; a git backend must carry an equivalent marker and refuse on the same condition. |
| Argv-only execution | Commands run as an executable plus an argv array through `HostApi.exec`. No shell command string is ever built from task text, `sourceRef`, slice names, paths, or prompts. |
| Never auto-merge | The tool creates and launches; it does not merge, cherry-pick, rebase, push, or delete. Workers commit independently and the caller integrates. |
| Bounded and honest reporting | Calls are cancellable through the host `AbortSignal` and time-bounded, result order follows input order even though creation is concurrent, failures are reported per slice with `possiblePartialCreate`, and URL credentials are redacted from messages. |

`sourceRef` stays opaque under both backends: it is not fetched, parsed, authenticated to, or
used to infer permissions, and tracker content remains untrusted project data.

## Extra precondition of the git backend

The `git-worktree` backend refuses a request when a slice scope contains uncommitted changes in
the parent worktree.

This is not conservatism, it is a consequence of the anchoring guarantee. Siblings branch from
the committed HEAD, so anything staged or dirty in the parent is invisible to the worker that
owns that path. The worker would then edit a stale version of a file the parent has already
changed, and the caller would face a conflict at integration that neither side caused. Refusing
up front converts a silent lost-update into an actionable error: commit or stash the work in that
scope, then dispatch.

Only paths inside a declared slice scope matter. Unrelated dirty files elsewhere in the parent
worktree do not block dispatch, because no worker owns them. The `orca` backend keeps its own
existing preconditions and is unchanged by this rule.
