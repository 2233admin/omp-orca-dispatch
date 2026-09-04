# Herdr dispatch backend implementation plan

## Purpose and completion target

This plan is for the engineer who will implement Gitea issue 1 in a later session. After reading it, that engineer should be able to add `backend?: "orca" | "herdr"` to the existing `orca_task_dispatch` tool without changing omitted-backend behavior, weakening the dispatch trust boundary, or guessing at Herdr lifecycle ownership.

The change is complete only when both hosts expose the same optional selector, omitted `backend` behaves exactly like `backend: "orca"`, Herdr owns each Herdr child from worktree creation through agent launch, unit and package gates pass, and the authorized two-slice live smoke check passes.

## Non-negotiable behavior

- Keep the registered tool name `orca_task_dispatch` and the Pi and OMP entrypoints.
- Normalize an omitted `backend` to `"orca"`; do not auto-detect Herdr.
- Keep the current Orca command sequence, exact parent HEAD, parent worktree linkage, setup handling, concurrency, input-order results, and result status meanings.
- Treat Herdr as a complete backend. Do not create a worktree with Orca and then attach a Herdr pane.
- Reuse the current task, source reference, slice-name, literal-scope, overlap, portability, and worker-prompt validation.
- Keep task text and `sourceRef` as untrusted data. Pass subprocess input only as executable-plus-argv values.
- Do not add recursive dispatch, automatic integration, push, merge, rebase, tracker mutation, destructive cleanup, focused-pane fallback, or arbitrary key injection.
- A dispatch call returns after a worker launch and prompt acceptance are observed. It does not wait for the worker to finish.

## Current baseline to preserve

The current dispatcher combines common validation and Orca execution in `src/dispatcher.ts`. It validates two or three slices, normalizes names, rejects unsafe or overlapping scopes, builds the worker prompt, asks Orca for ready/current-worktree state, creates all children concurrently, and uses `Promise.all` to preserve request order. A failed create is isolated into a per-slice result with `possiblePartialCreate: true`. Top-level failures use `possiblePartialCreate: false`.

`src/contracts.ts` defines the public request and host subprocess contract. `src/schema.ts` independently builds Pi TypeBox and OMP Zod metadata. `extensions/pi.ts` and `extensions/omp.ts` differ only in schema construction and OMP registration metadata. `src/index.ts` is the public export surface.

The installation CLI is dependency-free and diagnoses Node, the selected host, Orca, the host entrypoint, and the operating system. It installs the package into Pi or OMP; it does not dispatch work. Herdr must remain an optional runtime prerequisite rather than a new installer dependency.

## Backend seam

Use one small internal backend contract. The common dispatcher remains responsible for public validation, backend normalization, prompt construction, stable aggregate results, and tool registration. A backend owns runtime preflight, exact-parent resolution, command planning, per-slice lifecycle, and parsing its own responses.

The internal request passed to a backend should already be validated and should contain:

- normalized `backend`, `task`, `sourceRef`, `slices`, `setup`, `agent`, and `dryRun`;
- the invoking `cwd`;
- the host `exec` function and the caller `AbortSignal`;
- fully built slice prompts, so both backends receive the same worker contract.

The backend response should provide common parent fields, one input-ordered result per slice, and enough state for the dispatcher to compute the existing aggregate `status`, `succeeded`, `failed`, and `integrationRequired` fields. Backend-specific child identifiers may be added without removing or renaming existing Orca fields.

Do not introduce a generic lifecycle framework. Two small backend functions with a shared typed input/output are sufficient.

## File migration and implementation order

### 1. Public contracts and exports

Update `src/contracts.ts`:

- Add and export `DispatchBackend = "orca" | "herdr"`.
- Add optional `backend?: DispatchBackend` to `TaskDispatchParams`.
- Add an optional environment map to `ExecOptions` only if the live Herdr CLI requires process environment to be supplied through the host exec API. Do not use a shell prefix such as `OMP_DISPATCH_CHILD=1 herdr ...`.
- Define backend-internal request/result types here only if both backend modules need them. Do not export implementation-only types from `src/index.ts` unless consumers need them.

Update `src/index.ts` to export `DispatchBackend`. Preserve all existing exports.

### 2. Host schemas

Update `src/schema.ts`:

- Pi: add optional `Type.Union([Type.Literal("orca"), Type.Literal("herdr")])`.
- OMP: add optional `z.enum(["orca", "herdr"])`.
- Describe omission as defaulting to Orca. Do not add a third literal or accept arbitrary strings.

No host-entrypoint branching belongs in `extensions/pi.ts` or `extensions/omp.ts`; both must continue registering the same dispatcher with host-specific schema metadata.

### 3. Extract the Orca backend without changing it

Move Orca-only context loading, plan construction, create-response parsing, command constants, and per-slice execution from `src/dispatcher.ts` to `src/orca-backend.ts`. Keep argv ordering and timeout values unchanged during this extraction.

Retain in `src/dispatcher.ts`:

- shared validation, redaction, prompt construction, and result serialization;
- backend normalization;
- recursive-child refusal;
- backend selection and aggregate result construction;
- `registerOrcaTaskDispatch`, including the public tool name and existing registration metadata flow.

Perform this as a behavior-preserving extraction before adding the Herdr branch. The existing Orca tests must pass after the extraction with no expectation changes except import locations for deliberately internal helpers.

### 4. Add the Herdr backend

Create `src/herdr-backend.ts`. Keep all Herdr command planning, response parsing, unique agent naming, recursion-marker setup, timeout policy, and partial-state tracking in this module.

The backend lifecycle is:

1. Check `process.env.HERDR_ENV === "1"` before any Herdr invocation. On failure, return a normal structured failure with `possiblePartialCreate: false`; do not probe a focused Herdr session.
2. Resolve the executable from `HERDR_CLI_COMMAND`, otherwise use `herdr`.
3. Resolve the invoking repository's exact committed HEAD with an argv-only Git call from the explicit parent `cwd`. Use the verified commit value as every slice's base. Do not use a branch name, a UI-focused pane, or ambient Herdr cwd.
4. Build all slice plans before creating resources. Each create call must carry explicit parent cwd, exact base commit, normalized slice label, and no-focus behavior.
5. Run independent slice lifecycles concurrently. Preserve input order by awaiting the mapped promises as an array.
6. Parse the create JSON as an untrusted response. Require the documented workspace ID, worktree ID/path, and root pane ID. Treat every ID as opaque. Do not synthesize an ID or substitute a focused/current pane when a field is absent.
7. Generate a unique Herdr agent name that satisfies `[a-z][a-z0-9_-]{0,31}`. Keep the caller's validated `agent` value as the requested Herdr agent kind; the default remains `omp`. Include a collision-resistant suffix because agent names are unique across live agents. Unit tests should inject or otherwise stabilize the suffix rather than weakening production uniqueness.
8. Start the agent in the returned root pane by explicit pane ID. Supply `OMP_DISPATCH_CHILD=1` through the live CLI's supported environment mechanism so a child cannot dispatch again. Never interpolate an environment assignment into shell text.
9. Use the create response's explicit identifiers for every later command. Start and prompt with bounded subprocess timeouts and the caller's `AbortSignal`.
10. Send the existing self-contained slice prompt as one argv element. Observe Herdr's launch/readiness and prompt-accepted/working transition. Do not use a mode that waits for the agent's completed turn.
11. Return `status: "dispatched"` only after the worktree exists, the requested agent is ready in the returned pane, and prompt acceptance or the working transition has been observed.

The installed Herdr binary is authoritative for flag names and JSON field names. Before coding command planners, run `herdr --help`, `herdr worktree`, and `herdr agent` from a Herdr-managed pane with `HERDR_ENV=1`. Capture the supported create, environment, start, prompt, and timeout forms in focused tests. If the installed CLI cannot pass an inherited environment value without shell concatenation, stop and raise that as an upstream blocker; do not add a shell fallback.

### 5. Dispatch selection and results

In `validateTaskDispatch`, normalize `backend` once and reject any non-`orca`/`herdr` runtime value. Select the backend only after common input validation.

Add `backend` to dry-run and real top-level results. Add it to each slice result where doing so helps reconciliation. Preserve existing fields:

- Orca success: `worktreeId`, `worktreePath`, and `agentTerminalHandle` remain unchanged.
- Herdr success: report opaque `workspaceId`, `worktreeId`, `worktreePath`, `rootPaneId`, and `agentName` using stable, documented names.
- Dry run: report the selected executable and a redacted argv plan; replace the prompt with its character count as today.
- Failure: include a redacted message, `possiblePartialCreate`, slice name, scope, backend, lifecycle stage, and any identifiers already returned before failure.

Keep aggregate semantics:

- `dispatched`: every prompt was accepted;
- `partial`: at least one prompt was accepted and at least one slice failed;
- `failed`: no prompt was accepted;
- `integrationRequired`: true when at least one slice reached `dispatched`, matching current behavior.

Partial Herdr resources require reconciliation even when `integrationRequired` remains false. Express that through per-slice `possiblePartialCreate` and returned IDs rather than changing the established meaning of `integrationRequired`.

Update the tool label and description to mention Orca or Herdr dispatch while retaining the registered name.

## Cancellation and partial-state rules

Pass the same caller `AbortSignal` and a finite timeout to the Git preflight and every Herdr subprocess. Keep separate bounded limits for preflight/create, agent start/readiness, and prompt acceptance; do not use one unbounded end-to-end wait.

Track each slice's stage and acquired identifiers locally. The irreversible boundary begins when worktree creation is invoked:

- Failure before invoking create: `possiblePartialCreate: false`.
- Timeout, abort, nonzero exit, malformed JSON, or missing identifiers after create starts: `possiblePartialCreate: true`.
- Failure after a valid create response: return all validated identifiers acquired so far.

Cancellation stops or aborts only the helper invocation through the host subprocess API. After cancellation, do not send keys, close panes, kill agents, remove worktrees, or issue compensating cleanup. Herdr resources may outlive the helper and must remain available for explicit parent inspection.

Redact credentials in stderr, stdout-derived errors, JSON parse errors, dry-run displays, and returned messages. Never return an entire raw Herdr response. `sourceRef`, task text, prompt text, scope paths, executable overrides, and Herdr response strings must not become shell syntax.

## Recursion boundary

Add a common early refusal when `OMP_DISPATCH_CHILD=1`, before either backend performs runtime discovery or creates a child. Keep the existing Orca comment-prefix check as defense for existing Orca-created children and compatibility with children that do not carry the marker.

Herdr must set the marker in the child agent's inherited environment. A caller-provided task or source reference cannot override or remove it. Do not rely on agent prompt wording as the only recursion control.

## Test migration and additions

### Common dispatcher tests

Keep common observable-contract coverage in `tests/dispatcher.test.ts`:

- omitted backend normalizes to `orca`;
- explicit `orca` selects the identical Orca path;
- invalid backend values fail before runtime calls;
- slice bounds, name normalization, unsafe scopes, Unicode/case overlap, agent validation, prompt trust language, redaction, and recursive refusal remain covered;
- top-level and per-slice results identify the selected backend without dropping existing fields.

Add a test proving `OMP_DISPATCH_CHILD=1` refuses both backends before Git, Orca, or Herdr calls. Restore the process environment in `finally` so the suite remains isolated.

### Orca regression tests

Keep or move the existing Orca behavior cases to `tests/orca-backend.test.ts` when extracting the module. Assert observable behavior, not source layout:

- omitted and explicit Orca requests use the same status/current/create argv sequence;
- all creates receive the same exact HEAD and parent worktree ID;
- setup, agent, prompt, comment, cwd, signal, and timeout are forwarded as before;
- creates overlap in time while results retain input order;
- malformed/nonzero creates produce isolated, redacted partial failures;
- the current Orca recursive-comment refusal still happens before creation;
- Orca dry-run output and result fields remain byte-for-byte compatible apart from the additive `backend` field.

### Herdr backend tests

Add `tests/herdr-backend.test.ts` with a recording `HostApi.exec` fake. Cover:

1. Missing or non-`1` `HERDR_ENV` yields a structured failure and zero Herdr calls.
2. `HERDR_CLI_COMMAND` overrides only the executable; every task, prompt, scope, base, label, ID, and marker remains a distinct argv or environment value.
3. Git resolves one exact HEAD and every create uses that commit, explicit parent cwd, slice label, and no-focus.
4. Two creates run concurrently and returned slice order matches input order even when completion order is reversed.
5. Opaque IDs returned by create are used unchanged for agent start and prompt; no command targets current/focused state.
6. Generated agent names are valid, unique, bounded, and reported; the requested agent kind is passed separately.
7. The child receives `OMP_DISPATCH_CHILD=1` through the supported environment mechanism.
8. Agent start/readiness and prompt acceptance have finite timeouts and receive the original `AbortSignal`.
9. Prompt dispatch returns after launch/working acknowledgment and does not wait for worker completion.
10. Abort before create reports no partial create; abort or timeout during/after create reports possible partial state and retained identifiers.
11. Nonzero exits, invalid JSON, non-object JSON, and missing workspace/worktree/root-pane identifiers fail closed.
12. No failure path emits close, kill, key-send, remove, or delete commands.
13. Credential-bearing URLs in command output and malformed-response messages are redacted.
14. Herdr dry run creates no resources, preserves input order, and exposes only redacted argv plans.

### Schema, entrypoint, package, and CLI tests

Update `tests/schema.test.ts` to assert that both schemas expose optional `backend` with exactly `orca` and `herdr`, while `task` and `slices` remain the only required top-level fields. Keep both entrypoint metadata tests.

Keep `tests/package.test.ts` compatibility assertions. Add Herdr package metadata only if the project establishes a supported minimum version; do not invent one. The existing `files` allowlist already includes `src`, `dist`, and `docs`, so the new backend and documentation will be packed after build.

Do not make `bin/orca-task-dispatch.mjs`, its declaration file, or `tests/cli.test.ts` depend on Herdr. The CLI installs and diagnoses host/plugin compatibility, not a selected dispatch invocation. If maintainers later add backend-specific doctor behavior, it should be an explicit optional mode and must not make existing Orca diagnosis regress.

## Documentation and release updates

The implementation session should update these shared surfaces after code tests pass:

- `README.md`: optional backend request example, Herdr runtime prerequisites, ownership, no-focus behavior, cancellation, partial-state reconciliation, and unchanged no-auto-merge policy.
- `docs/upstream-integration.md`: backend seam, additive result fields, host compatibility, and why Herdr owns the entire lifecycle.
- `SECURITY.md`: `HERDR_ENV` guard, explicit opaque IDs, argv-only execution, recursion marker, non-destructive cancellation, and no focused-session fallback.
- `.env.example`: `HERDR_CLI_COMMAND` and the recursion marker as dispatcher-owned rather than user configuration.
- `CHANGELOG.md`: one Unreleased entry for the optional backend.

Do not add Herdr as an npm dependency. Do not make the installer launch, configure, or mutate Herdr.

## Verification gates

Run from the repository root after implementation:

```sh
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run package:dry-run
```

Also run the repository-mandated workspace command and record its exact result:

```sh
cargo test --workspace --no-fail-fast
```

Inspect the packed file list to confirm the compiled Herdr module and updated documentation are included and no archive was left in the repository.

## Authorized live smoke verification

Run the live smoke only from an authorized Orca-managed parent for this repository, at a clean committed HEAD, and from a Herdr-managed pane where `HERDR_ENV=1`. Do not run it from a dispatcher-created child.

1. Record `git rev-parse HEAD` and clean `git status --short`.
2. Verify Orca is ready/reachable and record the current Orca worktree identity required by the ticket.
3. Record the caller's Herdr workspace/tab/pane identifiers and current focus without changing focus.
4. Invoke the installed package's registered `orca_task_dispatch` tool exactly once with `backend: "herdr"`, `agent: "omp"`, `setup: "skip"`, `dryRun: false`, and two documentation-only slices with disjoint literal scopes.
5. Assert the returned slice names remain in request order and both report the selected backend plus opaque workspace, worktree, root-pane, and agent identifiers.
6. Query each child only by its returned identifiers. Verify the two worktrees have the same recorded parent HEAD, each agent occupies its returned pane, and each prompt was accepted into launch/working lifecycle without waiting for task completion.
7. Confirm the caller's focused pane/tab did not change.
8. Confirm each child changed only its assigned scope, committed independently, and reported verification evidence before integration.

If the call aborts or fails, save the structured result and returned identifiers. Inspect and reconcile those resources explicitly. Do not trigger automatic removal, close panes, send arbitrary keys, or delete worktrees as part of the dispatcher failure path.

## Next-session parent coordinator gate

The next-session parent coordinator must:

1. Review this plan together with the sibling documentation artifact and the focused implementation tests.
2. Integrate the backend implementation without copying this slice's commit over unrelated sibling changes.
3. Confirm every worker commit changed only its assigned scope.
4. Verify the default and explicit Orca paths remain compatible before accepting Herdr behavior.
5. Run all npm gates, the mandated Cargo workspace command, packed-file inspection, and the authorized two-slice live smoke.
6. Review security evidence for argv-only execution, `HERDR_ENV` gating, opaque explicit IDs, recursion refusal, bounded cancellation, redaction, no-focus behavior, and retained partial resources.
7. Update the shared README, upstream integration note, security policy, environment example, and changelog.
8. Do not merge or publish until all compatibility, security, and live-smoke criteria pass.

## Out of scope

Herdr UI changes, arbitrary pane control, transport-only hybrid ownership, cross-session orchestration, tracker API access, auto-merge, push, branch deletion, silent resource cleanup, and changing Orca as the default backend are not part of issue 1.
