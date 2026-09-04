# Herdr runtime contract

## Purpose and status

This document is the implementation contract for adding Herdr as an optional dispatch backend to `orca_task_dispatch`. It is for the engineer implementing and reviewing the backend in the next session. The current Orca backend remains the default and its behavior must not change.

This is a documentation artifact only. It does not mean the Herdr backend exists or has passed a live smoke test.

## Verified static baseline

The contract below was checked against Herdr `0.8.0-preview.2026-08-04-d78e3d3b5126`, its bundled protocol `19` / schema version `1`, command help, and bundled JSON Schema.

`HERDR_ENV` was unset during this inspection. No command that reads or controls the focused Herdr session was issued. In particular, no snapshot, list, current-pane, create, split, start, prompt, focus, close, or remove operation ran. Only static `--help`, command-group help, `--version`, completion generation, and `api schema --json` output were inspected.

The installed CLI remains authoritative. The implementation and live smoke must fail closed if the installed contract is incompatible with the response shapes and command options recorded here.

## Backend boundary

Herdr is a complete dispatch backend, not a terminal transport layered under Orca. For `backend: "herdr"`, Herdr owns the Git worktree, workspace, tab, pane, and agent lifecycle. Orca must not create or reconcile those resources.

The dispatcher continues to own:

- request normalization and validation;
- literal repository-relative disjoint-scope validation;
- source-reference and task-text trust boundaries;
- construction of the existing self-contained worker prompt;
- stable input-order aggregation;
- cancellation and timeout propagation;
- redaction and public result shaping.

Keep Herdr command planning, response parsing, agent-name generation, recursion-marker setup, and per-slice lifecycle isolated behind one backend seam. Do not duplicate common validation or prompt construction.

## Environment and executable guard

For every non-dry-run Herdr dispatch:

1. Require `HERDR_ENV` to equal the exact string `1` before the first Herdr subprocess.
2. Refuse when `OMP_DISPATCH_CHILD=1` before any Git or Herdr subprocess so a Herdr-created worker cannot recursively dispatch.
3. Resolve the executable as the trimmed value of `HERDR_CLI_COMMAND`, or `herdr` when unset or blank. The value is one executable path/name, never a shell fragment and never split on whitespace.
4. Invoke it only through the host executable-plus-argv API. Pass `cwd`, the request `AbortSignal`, and a finite timeout on every invocation.

A failed environment or recursion guard is a normal structured failure with `possiblePartialCreate: false`. It must not probe server status, inspect a focused pane, or invoke any Herdr command.

A Herdr dry-run must also enforce both guards. After the guards it may resolve the committed Git HEAD and render redacted argv plans, but it must not invoke Herdr or create resources.

## Exact dispatch sequence

Run these steps independently for each validated slice. Concurrent slices may execute together, but results remain in request order.

### 1. Resolve the parent commit

Resolve the exact committed parent HEAD with an argv-only Git call equivalent to:

```text
git rev-parse --verify HEAD
```

Run it with the tool context's exact parent working directory as `cwd`. Accept one non-empty commit ID only. Never interpolate the working directory, ref, slice text, or task text into a shell command.

### 2. Create the Herdr worktree

Invoke:

```text
herdr worktree create --cwd <parent-cwd> --base <exact-head> --label <slice-label> --no-focus
```

The static CLI contract supports `--workspace ID | --cwd PATH`, `--branch`, `--base`, `--path`, `--label`, and mutually exclusive focus flags. The backend must use explicit `--cwd`, `--base`, `--label`, and `--no-focus`; it must not use the UI-focused workspace or pane as implicit context.

Parse one JSON success envelope. Require `result.type == "worktree_created"` and these objects and identifiers:

- `result.workspace.workspace_id`;
- `result.tab.tab_id`;
- `result.root_pane.pane_id`;
- `result.worktree.path`.

Also retain `result.root_pane.terminal_id`, `result.worktree.branch`, and the complete identifiers needed for diagnostics. Treat every returned ID as opaque. Never derive an ID from an example, label, ordinal, or another ID.

The bundled schema requires the `worktree_created` result to contain `workspace`, `tab`, `root_pane`, and `worktree`. A worktree object has no separate public worktree ID; its stable public identity for this integration is the returned path plus its owning workspace ID.

### 3. Create a marker-bearing agent pane

`worktree create` has no environment-variable option, while `pane split` does. Therefore, do not launch the worker in the returned root pane. Create a dedicated child pane targeted from that exact root pane:

```text
herdr pane split --pane <root-pane-id> --direction down --cwd <worktree-path> --env OMP_DISPATCH_CHILD=1 --no-focus
```

Require `result.type == "pane_info"` and read the new pane only from `result.pane.pane_id`. Verify the returned pane's `workspace_id` and `tab_id` match the worktree-create response before using it. Retain its `terminal_id` for the public compatibility result.

The split direction is deliberately fixed so command planning and tests are deterministic. No command may focus either pane.

### 4. Start the agent

Generate an implementation-owned live agent name that satisfies `[a-z][a-z0-9_-]{0,31}` and is unique for the dispatch. Use a fixed lowercase prefix, a bounded normalized slice fragment, and a locally generated collision-resistant suffix. The name is not a Herdr resource ID and must never be used to predict pane, tab, or workspace IDs.

Invoke:

```text
herdr agent start <agent-name> --kind <supported-kind> --pane <agent-pane-id> --timeout <bounded-ms>
```

For the ticket's required smoke, `<supported-kind>` is `omp`. The static CLI advertises `omp` as supported. `agent start` requires an existing shell pane and waits until the expected agent is detected in that same pane and is interactive-ready. Its default is 30 seconds; accepted values are greater than 3,000 ms and at most 300,000 ms. Keep the backend timeout finite and within that range.

Require `result.type == "agent_started"`. Confirm `result.agent.pane_id` equals the requested agent pane, `result.agent.name` equals the generated name, and `result.agent.interactive_ready` is true. Retain the returned `argv` for internal diagnostics only; do not expose secrets.

### 5. Submit the worker prompt and observe work start

Send the existing self-contained slice prompt as one argv element:

```text
herdr agent prompt <agent-name> <prompt> --wait --until working --timeout <bounded-ms>
```

`--until working` is required. Plain `--wait` waits for the first settled `idle`, `done`, or `blocked` state and can accidentally turn dispatch into a completion wait. A prompt starting from a non-working state must show a lifecycle change within five seconds or Herdr reports `agent_prompt_stalled`; the enclosing timeout must also be finite.

Require `result.type == "agent_prompted"`, the same agent name and pane ID, and an observed `working` state. Once that state is observed, return the slice as dispatched. Do not wait for worker completion.

## JSON, exit, and argv contract

Every Herdr invocation uses this shape:

```text
HostApi.exec(executable, argv[], { cwd, signal, timeout })
```

The parser must:

- require exit code zero before accepting stdout;
- parse exactly one JSON object from stdout;
- require the operation-specific `result.type` discriminator;
- validate every required nested object and identifier before the next lifecycle step;
- reject empty identifiers, wrong result types, malformed JSON, and mismatched workspace/tab/pane/agent relationships;
- redact credential-bearing URLs from stderr, parse errors, and returned messages.

Static Herdr guidance records server errors as JSON on stderr with exit status `1` and syntax errors with exit status `2`. Treat either as a failed operation. Never recover by switching to a shell, retrying against the focused session, guessing an ID, or sending keys.

Task text, `sourceRef`, slice names, scopes, labels, worktree paths, agent names, and prompts must each remain distinct argv elements. Do not concatenate a command line, invoke a shell, or place untrusted task text in an environment variable.

## Cancellation, timeout, and partial state

Thread the original `AbortSignal` and a bounded timeout through Git resolution and every Herdr subprocess. Cancellation stops only the helper subprocess invocation. It must not send keys, close panes, stop agents, remove worktrees, or otherwise control resources after the interrupted call.

Track the last fully parsed creation stage per slice:

| Last completed stage | `possiblePartialCreate` | Evidence to return |
| --- | --- | --- |
| Guards or parent HEAD only | `false` | Backend, slice, redacted failure |
| Worktree create invoked but no valid response | `true` | Backend, slice, operation name; IDs may be unknown |
| Worktree response parsed | `true` | Workspace, tab, root-pane IDs and worktree path |
| Agent pane parsed | `true` | Prior IDs plus agent-pane and terminal IDs |
| Agent start parsed | `true` | Prior IDs plus agent name and returned agent identity |
| Prompt observed `working` | not a failure | Complete dispatched result |

Any timeout, abort, malformed response, relationship mismatch, or nonzero exit after creation starts is a per-slice failure. Leave all possible resources intact for explicit parent reconciliation. There is no automatic close, remove, branch deletion, merge, rebase, push, or agent termination.

Aggregate concurrent slice outcomes with stable input order. Preserve the existing overall meanings: all dispatched is `dispatched`, none dispatched is `failed`, and a mix is `partial`. `integrationRequired` is true exactly when at least one slice dispatched.

## Public result compatibility

Add `backend: "orca" | "herdr"` to dry-run, overall, and per-slice details. Omitted input normalizes to `orca`, and the Orca command sequence and result values remain byte-for-byte compatible apart from the additive backend discriminator.

For Herdr slices, preserve existing keys and add backend-specific identifiers without relabeling unlike resources:

- `worktreeId`: `null`, because the verified Herdr contract exposes no public worktree ID;
- `worktreePath`: `result.worktree.path`;
- `agentTerminalHandle`: the dedicated agent pane's returned `terminal_id`;
- `herdrWorkspaceId`, `herdrTabId`, `herdrRootPaneId`, `herdrAgentPaneId`, and `herdrAgentName`: exact returned/generated values;
- `scope`, `name`, `status`, `message`, and `possiblePartialCreate`: unchanged meanings.

At the overall level, keep existing fields. For Herdr, `parentWorktreeId` remains present as `null`; add `parentCwd` only if the shared public contract explicitly approves exposing it. Never substitute a Herdr workspace ID into an Orca worktree-ID field.

Dry-run output must show the selected backend, exact base HEAD, slice order, scopes, generated labels and agent names, and executable-plus-argv plans. Replace prompt content with a length marker, as the existing backend does. It must not claim resource IDs or successful dispatch.

## Security and ownership invariants

- Reuse the existing scope validator and worker prompt without weakening either.
- Treat ticket text, `sourceRef`, parent task text, and slice text as untrusted data.
- Pass `OMP_DISPATCH_CHILD=1` only through `pane split --env` into the dedicated agent pane.
- Use explicit IDs from the same creation chain and `--no-focus` for every focus-capable operation.
- Never inspect or control a focused pane as fallback behavior.
- Do not grant tracker, repository, network, shell, or host permissions.
- Workers edit only assigned literal scopes, commit their slice, and report exact checks.
- Workers do not recursively dispatch, integrate siblings, push, merge, rebase, remove worktrees, or delete branches.
- The parent coordinator alone reviews and integrates child commits. No auto-merge or automatic cleanup is added.

## Required implementation tests

Focused tests must prove:

1. The `HERDR_ENV` and recursion guards run before every Herdr/Git call as specified.
2. Every command uses executable-plus-argv execution and preserves malicious-looking text as one inert argument.
3. Worktree creation receives exact parent `cwd`, exact committed HEAD, slice label, and `--no-focus`.
4. Returned workspace, tab, root-pane, agent-pane, terminal, and agent identifiers are parsed and relationship-checked, never predicted.
5. The dedicated pane receives `OMP_DISPATCH_CHILD=1`, the returned worktree path, and `--no-focus`.
6. Agent naming is valid, bounded, collision-resistant, and testable through an injected suffix source.
7. Agent start is bounded and must become interactive-ready in the requested pane.
8. Prompt submission waits only for `working`, is bounded, and never waits for completion.
9. Guard, Git, create, split, start, prompt, timeout, abort, malformed JSON, wrong discriminator, mismatched identity, and stderr-redaction paths return the correct partial-state evidence.
10. Concurrent results preserve input order and existing aggregate status semantics.
11. Dry-run makes no Herdr call and reports only redacted plans.
12. The default and explicit Orca paths retain the existing command sequence and result contract.

## Required live smoke

Run this only in the next session from an authorized Herdr-managed parent where `HERDR_ENV=1`, this repository is the current clean worktree, and HEAD is committed.

Invoke the registered package tool exactly once with:

- `backend: "herdr"`;
- `agent: "omp"`;
- `setup: "skip"`;
- `dryRun: false`;
- two independent documentation-only slices with disjoint literal scopes.

Record and verify:

- both Herdr worktrees were created from the same parent HEAD;
- each response chain used its returned workspace, tab, root-pane, agent-pane, terminal, and agent identifiers;
- each child pane inherited `OMP_DISPATCH_CHILD=1` and opened at its returned worktree path;
- both agents became interactive-ready and each prompt reached `working`;
- neither creation nor dispatch changed UI focus;
- the parent result preserved input order and set `backend: "herdr"`;
- workers changed only assigned scopes, committed, and reported exact checks;
- any failure or abort reported retained partial resources for explicit reconciliation and did not delete them.

Do not use the focused session as implicit evidence. Capture command results and compare explicit IDs and the parent HEAD.

## Next-session parent integration gate

The parent coordinator may integrate the Herdr backend only after all of these are true:

1. Review this contract and the sibling implementation plan together; resolve any conflict against the installed CLI help and bundled API schema before coding.
2. Review focused Herdr tests and confirm the existing Orca path is unchanged.
3. Run the authorized two-slice live smoke above and retain its exact result and child evidence.
4. Confirm every documentation worker and implementation worker changed only its assigned scope and committed its work.
5. Update the shared request type, both host schemas, dispatcher seam, package documentation, security guidance, and release notes as one coherent compatibility change.
6. Run typecheck, unit tests, coverage, build, package dry-run, the repository-required full workspace test command, and the live smoke. Record exact commands and outcomes.
7. Do not merge, publish, push, mutate the ticket, or clean up child resources until compatibility, redaction, recursion, partial-state, no-focus, and no-auto-merge criteria all pass.

## Slice verification record

Observed while preparing this artifact:

- `herdr --version` -> `herdr 0.8.0-preview.2026-08-04-d78e3d3b5126`.
- `herdr worktree create --help` exposed `--workspace`, `--cwd`, `--branch`, `--base`, `--path`, `--label`, `--focus`, and `--no-focus`.
- `herdr pane split --help` exposed explicit pane targeting, `--cwd`, `--env KEY=VALUE`, and `--no-focus`.
- `herdr agent start --help` exposed `omp`, a required existing pane, and a 30,000 ms default / 300,000 ms maximum readiness timeout.
- `herdr agent prompt --help` exposed `--wait`, repeatable `--until`, finite timeout support, the five-second stalled-prompt rule, and lifecycle values `idle`, `working`, `blocked`, `done`, and `unknown`.
- `herdr api schema --json` reported protocol `19`, schema version `1`, the request/result discriminators and required nested objects used above.
- The environment guard inspection printed no `HERDR_ENV` value, so live Herdr inspection and control were intentionally not performed.
- `npm ci` installed the locked dependencies without changing the documented contract.
- `npm run check` passed typecheck and all 18 unit tests.
- `npm run test:coverage` passed all 18 tests with aggregate line coverage `87.86%`, branch coverage `75.13%`, and function coverage `88.68%`.
- `npm run build` completed successfully.
- `npm run package:dry-run` completed successfully and produced the planned package name `omp-orca-dispatch-0.1.0.tgz` without writing a tarball.
- The repository-required `cargo test --workspace --no-fail-fast` was executed and exited `101` because this repository contains no `Cargo.toml`; it is not a Rust workspace.
