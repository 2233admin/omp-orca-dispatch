# omp-orca-dispatch

Portable Pi and Oh My Pi extension for safe parallel dispatch into Orca-managed worktrees.

## Install, diagnose, and use

> **The published-package route does not work yet.** `omp-orca-dispatch` is not on the public
> npm registry — `npx --yes omp-orca-dispatch@0.1.0 …` fails with `E404`. Install from a
> checkout until a registry publish lands.

From a checkout:
```sh
git clone https://github.com/2233admin/omp-orca-dispatch.git
cd omp-orca-dispatch
npm ci
npm run build
node bin/orca-task-dispatch.mjs install --host omp --path .   # links this checkout
node bin/orca-task-dispatch.mjs doctor  --host omp
omp
```

`--path` links the checkout through `omp plugin install <dir>`. It is verified for `--host omp`
only; Pi's directory-install syntax is unverified, so `--host pi --path` is refused rather than
guessed. Pi therefore needs a published package.

Once published, the same commands are available without a checkout:
```sh
npx --yes omp-orca-dispatch@<version> install --host omp
npx --yes omp-orca-dispatch@<version> doctor  --host omp
```

Then ask the host to call `orca_task_dispatch` with 2–3 slices:
```json
{
  "task": "Implement issue 42 end-to-end",
  "sourceRef": "https://git.example.test/acme/widget/issues/42",
  "slices": [
    { "name": "core", "task": "Implement the core behavior", "scope": ["src/core"] },
    { "name": "docs", "task": "Document the behavior", "scope": ["README.md", "docs"] }
  ]
}
```

The command creates siblings concurrently from the parent worktree's exact committed HEAD. Each worker receives one self-contained task and an exclusive literal path scope. Workers commit independently. Dispatch itself never merges: integration is a separate, explicitly invoked stage described in [parent coordination](docs/parent-coordination.md).

## Requirements

| Component | Minimum | Notes |
| --- | ---: | --- |
| Node.js | 22.19.0 | Runs the package CLI and tests |
| Pi | 0.84.4 | Loads the Pi TypeBox entrypoint |
| Oh My Pi | 18.1.8 | Loads the OMP Zod entrypoint |
| Orca | 1.4.195 | Must be running, ready, and reachable; required by the `orca` backend only |
| OS | Windows, Linux, macOS | Scope validation follows the strict common path subset |

Run `orca-task-dispatch doctor --host pi|omp` after upgrades. `doctor --json` emits stable machine-readable checks and exits nonzero when any required check fails.

## Backends

Dispatch needs the parent's exact committed HEAD and a way to create siblings from it. Two
backends supply that: `orca`, which requires a running, ready, and reachable Orca runtime, and
`git-worktree`, which needs only `git` and makes the package usable outside an Orca fleet. Select
one with the optional `backend` parameter or the `ORCA_DISPATCH_BACKEND` environment variable.

`orca` remains the default, so omitting `backend` changes nothing for existing users. Both
backends preserve the same guarantees — 2–3 slices, scope validation, exact committed HEAD,
recursion refusal, argv-only execution, and no auto-merge. See
[worktree backends](docs/worktree-backends.md) for the selection contract and the git backend's
extra precondition on uncommitted changes.

## Installation CLI

```text
orca-task-dispatch install [--host pi|omp] [--local] [--dry-run]
orca-task-dispatch uninstall [--host pi|omp] [--local] [--dry-run]
orca-task-dispatch doctor [--host pi|omp] [--json]
orca-task-dispatch help
orca-task-dispatch version
```

The default host is `omp`. `--local` maps to the host's supported project-local mode: `pi install/remove --local` or `omp plugin install/uninstall --local`. `--dry-run` prints the exact executable and argv array without spawning a process. The CLI never constructs a shell command string. On Windows it uses native executables and can invoke Pi's standard npm shim through its JavaScript entrypoint.

The package manifests select the host-specific modules explicitly:

- `extensions/pi.ts` registers TypeBox parameters for Pi.
- `extensions/omp.ts` registers Zod parameters plus OMP `approval: "write"` and `loadMode: "essential"` metadata.

## Tools

Both entrypoints register the same three tools:

| Tool | Purpose |
| --- | --- |
| `orca_task_dispatch` | Creates 2–3 sibling worktrees from the parent's exact committed HEAD and launches one worker per disjoint scope. |
| `orca_backlog` | Records work locally so it survives tracker downtime — `enqueue`, `claim`, `complete`, `bind`, `ack`, `list` against an append-only per-repository log — and never contacts the tracker. |
| `orca_outbox_sync` | Turns completed backlog items into an executable tracker-write plan (issue reference, UTF-8 body file, exact argv), holding no credential and performing no write itself. |

`orca_outbox_sync` takes no parameters: its reachability probe reads the tracker base URL from
`MULTICA_SERVER_URL` only, never from a tool argument. See the
[offline backlog and outbox contract](docs/offline-backlog-contract.md) for the state machine,
locking scope, and sync-record details.

## Dispatch contract

A request must contain exactly 2 or 3 independent slices. Slice names are normalized before uniqueness checks. Every scope is a repository-relative literal file or directory path; globs, parent traversal, repository root ownership, `.git`, absolute paths, Windows-reserved names, cross-slice parent/child overlap, and C0 (`U+0000`–`U+001F`) or DEL (`U+007F`) control characters are rejected. Scope keys are compared case-insensitively after NFC normalization so canonically equivalent Unicode paths cannot bypass disjointness checks; the first validated scope spelling is retained in the returned slice.

All `orca worktree create` calls receive the same exact HEAD returned by `orca worktree current --json`, the same parent worktree ID, and argv-only arguments. Result order follows input order even though creation is concurrent. Failed creates are reported per slice with possible-partial-create status and redacted URL credentials.

A dispatcher-created child is marked in Orca metadata. Calling the tool again from such a child is refused. Worker prompts require exclusive ownership, treat tracker content as untrusted project data, forbid recursive dispatch and sibling integration, and require a commit plus verification evidence.

## Parent coordination: collect and integrate

Dispatch writes an append-only ledger before it creates any child, recording the round's complete
member set, each slice's owned paths, and the parent's exact committed HEAD. Two stages read it.

`collect <roundId>` is pure inspection: it prints commits since the base, changed paths versus
owned paths, and cross-child overlap for every member, and it appends no record, resolves no gate
policy, and moves no branch.

`integrate <roundId>` owns every check. It takes a round id rather than a caller-assembled child
list, snapshots each member's SHA, enforces the recorded scope before merging, gates the combined
tree once in an isolated integration worktree under the parent-owned policy at
`.orca-task-dispatch/gates.json`, and only then advances the target by a guarded, serialized
`git merge --ff-only`. Everything else holds the entire round with the target untouched, and a
held round is terminal — it is recovered by a superseding round, never revived in place. Both
stages must run from the same parent worktree that dispatched the round.

See [parent coordination](docs/parent-coordination.md) for the ledger record set, the exact
ordered `integrate` steps, the gate policy format, and crash recovery.

## Tracker-agnostic `sourceRef`

`sourceRef` is an optional, opaque, one-line label carried into Orca comments, worker prompts, dry-run output, and results. The extension does not fetch, parse, authenticate to, mutate, or infer permissions from it. Tracker content remains untrusted project data.

Examples:

- Multica: `https://multica.example/projects/dispatch/tasks/T-42`
- Gitea: `https://git.xart.top/chen-qianyu/omp-orca-dispatch/issues/42`
- Jira: `https://acme.atlassian.net/browse/ORCA-42` or `ORCA-42`

Use the canonical URL when available so humans can trace the originating work item. `sourceRef` does not grant ticket integration and does not relax any integration gate.

## Development

```sh
npm ci
npm run check
npm run test:coverage
npm run build
npm run package:dry-run
```

The test suite exercises validation, security boundaries, concurrent dispatch, failure reporting, both host schemas, both entrypoints, CLI argument construction, and compatibility metadata. See [upstream integration](docs/upstream-integration.md) for host-maintainer integration details, [CONTRIBUTING](CONTRIBUTING.md) for patches, and [SECURITY](SECURITY.md) for vulnerability reporting.

Licensed under Apache-2.0.
