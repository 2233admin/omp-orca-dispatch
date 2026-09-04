# omp-orca-dispatch

Portable Pi and Oh My Pi extension for safe parallel dispatch into Orca-managed worktrees.

## Install, diagnose, and use

OMP:
```sh
npx --yes omp-orca-dispatch@0.1.0 install --host omp
npx --yes omp-orca-dispatch@0.1.0 doctor --host omp
omp
```

Pi:
```sh
npx --yes omp-orca-dispatch@0.1.0 install --host pi
npx --yes omp-orca-dispatch@0.1.0 doctor --host pi
pi
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

The command creates siblings concurrently from the parent worktree's exact committed HEAD. Each worker receives one self-contained task and an exclusive literal path scope. Workers commit independently; the caller reviews and integrates them. The extension never auto-merges.

## Requirements

| Component | Minimum | Notes |
| --- | ---: | --- |
| Node.js | 22.19.0 | Runs the package CLI and tests |
| Pi | 0.84.4 | Loads the Pi TypeBox entrypoint |
| Oh My Pi | 18.1.8 | Loads the OMP Zod entrypoint |
| Orca | 1.4.195 | Must be running, ready, and reachable |
| OS | Windows, Linux, macOS | Scope validation follows the strict common path subset |

Run `orca-task-dispatch doctor --host pi|omp` after upgrades. `doctor --json` emits stable machine-readable checks and exits nonzero when any required check fails.

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

## Dispatch contract

A request must contain exactly 2 or 3 independent slices. Slice names are normalized before uniqueness checks. Every scope is a repository-relative literal file or directory path; globs, parent traversal, repository root ownership, `.git`, absolute paths, Windows-reserved names, and cross-slice parent/child overlap are rejected. Comparisons are case-insensitive so a plan remains disjoint on Windows and default macOS filesystems as well as Linux.

All `orca worktree create` calls receive the same exact HEAD returned by `orca worktree current --json`, the same parent worktree ID, and argv-only arguments. Result order follows input order even though creation is concurrent. Failed creates are reported per slice with possible-partial-create status and redacted URL credentials.

A dispatcher-created child is marked in Orca metadata. Calling the tool again from such a child is refused. Worker prompts require exclusive ownership, treat tracker content as untrusted project data, forbid recursive dispatch and sibling integration, and require a commit plus verification evidence.

## Tracker-agnostic `sourceRef`

`sourceRef` is an optional, opaque, one-line label carried into Orca comments, worker prompts, dry-run output, and results. The extension does not fetch, parse, authenticate to, mutate, or infer permissions from it. Tracker content remains untrusted project data.

Examples:

- Multica: `https://multica.example/projects/dispatch/tasks/T-42`
- Gitea: `https://git.xart.top/chen-qianyu/omp-orca-dispatch/issues/42`
- Jira: `https://acme.atlassian.net/browse/ORCA-42` or `ORCA-42`

Use the canonical URL when available so humans can trace the originating work item. `sourceRef` does not grant ticket integration and does not change the no-auto-merge rule.

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
