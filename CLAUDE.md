# omp-orca-dispatch

## Purpose and architecture

Portable Pi and Oh My Pi extensions for safe parallel dispatch into independent worktrees. The shared core lives in `src/dispatcher.ts`, with contracts in `src/contracts.ts`, host schemas in `src/schema.ts`, and exports in `src/index.ts`. `extensions/pi.ts` registers the TypeBox entrypoint; `extensions/omp.ts` registers the Zod entrypoint and OMP metadata. `bin/orca-task-dispatch.mjs` is the dependency-free install/doctor CLI.

## Before implementation

1. Read `docs/pi-plugin-reference.md` for host and cancellation evidence.
2. Read `docs/herdr-runtime-contract.md` for the static Herdr protocol contract.
3. Read `docs/herdr-integration-plan.md` for the Issue #1 seam, tests, security, and smoke plan.
4. Inspect the current branch, exact committed HEAD, and existing tests before editing.

Issue #1 is the next implementation: add optional `backend?: "orca" | "herdr"`, defaulting to Orca. Herdr is a full worktree/workspace/pane/agent backend, not a transport layered under Orca. Preserve the existing Orca behavior and `orca_task_dispatch` name exactly when the field is omitted or set to `"orca"`.

## Safety and ownership

- Require `HERDR_ENV=1` before any Herdr command. Outside an authorized Herdr pane, never inspect or control the focused Herdr session; use static help/source only.
- Use executable-plus-argv calls only. Never build shell command strings from task text, ticket text, paths, IDs, prompts, or environment assignments.
- Preserve literal disjoint scopes, untrusted `sourceRef`/task text, opaque explicit IDs, bounded cancellation, redacted errors, recursion refusal, stable result order, and `possiblePartialCreate` reporting.
- Do not auto-merge, cherry-pick, push, publish, delete, or silently clean up child resources. The parent reviews and integrates independently committed children.

## Verification

Run from the repository root, recording each result:

```sh
npm ci
npm run check
npm run test:coverage
npm run build
npm run package:dry-run
cargo test --workspace --no-fail-fast
```

The Cargo command is mandatory evidence even though this repository has no `Cargo.toml`; the expected result here is the command’s nonzero “not a Rust workspace” failure, recorded as not applicable rather than hidden. The package dry-run must not leave an archive behind.

## Current release and GitHub status

- Gitea runner Docker IPv4 pool is blocked.
- npm publish is blocked by `ENEEDAUTH`.
- A verified security contact is still missing.
- The public GitHub mirror exists at https://github.com/2233admin/omp-orca-dispatch.
- The authenticated GitHub owner is verified as `2233admin`. A separate `github` remote exists; Gitea `origin` remains canonical and preserved.
- The UAC-assisted Clash service restart succeeded. The scoped proxy endpoint `127.0.0.1:7897` reaches GitHub; no proxy selector was changed.
- The mirror is currently empty. Pushing `main` and verifying three-platform CI are the next immediate steps.
- `scripts/ci_monitor.cjs` is absent. The remote worker will create a temporary live-docs-based monitor for this run; use its recorded CI URL and status, and do not treat the absent script as a product defect.

## GitHub follow-through

1. Run the credential scan without printing credentials.
2. Push `main` to the existing separate `github` remote without force; never replace Gitea `origin`.
3. Use the temporary live-docs-based monitor for this run to verify the Windows/Ubuntu/macOS matrix and record the canonical CI URL/status.
4. Update this handoff with the CI evidence; retain the canonical GitHub mirror URL above.

## Exact next-session implementation sequence

1. Read the three detailed docs named above and inspect Issue #1.
2. Preserve the existing Orca path through a small backend seam; implement Herdr only after the documented static contract is checked from an authorized Herdr context.
3. Add observable contract tests for schemas, default/explicit Orca compatibility, Herdr guards and argv plans, opaque IDs, recursion, cancellation, partial state, redaction, and bounded agent lifecycle.
4. Run all verification commands, inspect the packed file list, and perform the authorized two-slice Herdr smoke without focused-session fallback or destructive cleanup.
5. Review the diff and docs for stale paths, URLs, secrets, and scope violations; integrate only after every gate passes.

Done means Issue #1 is implemented, omitted and explicit Orca behavior is preserved, Herdr smoke evidence is recorded, all relevant tests and package gates are green, the mandatory Cargo result is recorded, GitHub mirror/CI evidence is complete, release blockers remain honestly documented, and no unapproved remote or publish operation was performed.
