# Pi plugin reference

## Purpose

This note compares maintained Pi/OMP extension sources with `omp-orca-dispatch` before the next dispatcher smoke test. It focuses on tool registration, schemas, subprocesses, package metadata, host adaptation, result rendering, and cancellation.

## Confidence and source boundary

Primary evidence was read from the locally installed OMP package (`@oh-my-pi/pi-coding-agent` 18.1.10), the locally installed Pi extension under `~/.pi/agent/extensions`, and first-party Pi/OMP source URLs. GitHub/raw-content fetches were not retried after connection/certificate failures; therefore the upstream observations below are limited to the named source pages and the locally read files. No behavior is inferred from articles or third-party summaries.

## Reference sources

### 1. Pi extension API and examples

- **Source:** [Pi extension documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) and [extension examples index](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/README.md).
- **Why representative:** This is the host-owned contract for an extension factory, `registerTool`, `pi.on`, tool execution, progress updates, errors, and abort handling.
- **Observed patterns:** A tool declares `name`, `label`, `description`, and a TypeBox `parameters` schema. The documented execution shape includes a tool-call id, parsed parameters, an abort signal, an update callback, and context. The docs distinguish throwing from returning a normal result for tool failure, and recommend passing the supplied signal to abort-aware operations. The examples index identifies `hello.ts` as minimal registration, `subagent/` as subprocess/streaming work, `timed-confirm.ts` as signal-aware UI, and `sandbox/` as cancellation-aware process execution.

### 2. Pi `subagent` example

- **Source:** [upstream `subagent` extension](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts).
- **Why representative:** It is the closest first-party example to this package's subprocess fan-out concern.
- **Observed patterns:** The tool supports single, parallel, and sequential child execution; bounds parallel work; streams intermediate updates; tracks usage; truncates child output; and handles cancellation by terminating child work. These are examples of behavior to study, not an API promise for OMP.

### 3. OMP minimal extension and injected schema API

- **Source URL:** [OMP `hello.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/examples/extensions/hello.ts).
- **Local path:** `C:/Users/Administrator/node_modules/@oh-my-pi/pi-coding-agent/examples/extensions/hello.ts:1-31`.
- **Why representative:** It is a maintained, host-owned minimal OMP extension and shows the smallest complete registration/result path.
- **Observed patterns:** The factory receives `ExtensionAPI`; the extension obtains `const z = pi.zod`; `registerTool` supplies name/label/description and `z.object(...)`; `execute` returns text content plus structured `details`; and logging goes through `pi.logger.debug(...)`. The local source uses OMP's injected schema builder rather than importing a schema package.

### 4. OMP custom-tool discovery, rendering, and dependency package

- **Source URLs:** [custom-tools examples README](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/examples/custom-tools/README.md), [with-deps manifest](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/examples/extensions/with-deps/package.json), and [with-deps extension](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/examples/extensions/with-deps/index.ts).
- **Local paths:**
  - `C:/Users/Administrator/node_modules/@oh-my-pi/pi-coding-agent/examples/custom-tools/README.md:5-20,41-104`
  - `C:/Users/Administrator/node_modules/@oh-my-pi/pi-coding-agent/examples/extensions/with-deps/package.json:1-17`
  - `C:/Users/Administrator/node_modules/@oh-my-pi/pi-coding-agent/examples/extensions/with-deps/index.ts:1-36`
- **Why representative:** Together these sources cover OMP's discovered tool directory shape, custom result rendering, state-oriented details, package-local dependencies, and explicit error results.
- **Observed patterns:** The README requires `subdirectory/index.ts` for custom-tool discovery and documents direct `omp --tool` execution or copying a tool folder into `~/.omp/agent/tools/`. Its factory pattern uses `pi.zod`, returns `content` plus `details`, and permits `renderCall`/`renderResult` with a distinct partial-result state. The `with-deps` package declares `type: module`, an `omp.extensions` entrypoint, and its own dependency; its tool returns `isError: true` with explanatory text for invalid input and a normal text result otherwise.

### 5. Locally installed Orca Pi status extension

- **Local path:** `C:/Users/Administrator/.pi/agent/extensions/orca-agent-status.ts:1-15,137-210,309-363`.
- **Public source URL:** none is declared in the file or its local metadata; this is included as local deployment evidence only.
- **Why representative:** It is a real Pi extension in the current installation and demonstrates adaptation around host/runtime differences rather than a generic sample.
- **Observed patterns:** The extension avoids a package-specific type import because Pi and OMP publish types under different package names; detects OMP runtime; keeps a single latest pending post instead of an unbounded queue; uses warn-once parsing; and posts status asynchronously so event handlers do not wait on the receiver. It gates ownership by PID, registers lifecycle/tool events, and uses a WSL-specific `curl.exe` fallback for host loopback. These are deployment-specific choices, not dispatcher APIs.

## Comparison with `omp-orca-dispatch`

| Concern | Reference pattern | This package | Assessment |
| --- | --- | --- | --- |
| Tool registration | Pi and OMP factories call the host's `registerTool` with name, label, description, schema, and executor. | Shared `registerOrcaTaskDispatch` registers `orca_task_dispatch`; `extensions/pi.ts:1-9` and `extensions/omp.ts:1-12` provide explicit adapters. | Already correct. |
| Schema ownership | Pi examples use TypeBox; OMP examples use injected `pi.zod`; schemas describe arguments and constrain values. | `src/schema.ts:6-32` builds TypeBox parameters; `src/schema.ts:50-68` builds equivalent OMP/Zod parameters; validation is repeated in `src/dispatcher.ts:163-208`. | Already correct; keep the two host schema constructors. |
| Subprocess execution | Pi `subagent` delegates child processes and terminates them on cancellation. | `HostApi.exec` accepts argv arrays, `cwd`, `signal`, and timeout (`src/contracts.ts:1-12,39-42`); `execJson` forwards them and rejects non-zero/invalid JSON (`src/dispatcher.ts:75-98`). | Already correct for this tool's Orca CLI boundary. |
| Cancellation | Upstream examples pass the signal to abort-aware work and clean up child work. | The executor receives the host signal and forwards it to context loading and each create call (`src/dispatcher.ts:321-355`). | Adopt before next smoke: include an aborted-signal scenario in the smoke harness and record whether the host `exec` actually kills the Orca command. No implementation change is implied by this note. |
| Result/error shape | OMP custom tools return text plus details; the dependency example uses explicit `isError: true`; Pi docs describe throw-based failure semantics. | `ToolResult` is text content plus structured details (`src/contracts.ts:14-17`); dispatcher returns JSON status/details for success, partial, dry-run, and failure (`src/dispatcher.ts:93-98,335-381`). | Already correct for a machine-readable dispatcher result; do not add host-specific `isError` or renderer fields without a host contract. |
| Partial fan-out | A multi-child Pi example reports progress and preserves child outcomes. | Child creation runs with `Promise.all`, preserves request order, and returns per-slice `failed`/`possiblePartialCreate` state (`src/dispatcher.ts:351-375`). | Already correct; smoke should inspect both all-success and one-failure result rendering. |
| Human-facing rendering | OMP custom tools may supply `renderCall`/`renderResult` and distinguish partial state. | The dispatcher emits JSON text and details; no TUI renderer seam is exposed. | Intentionally not applicable: the package is a cross-host orchestration boundary, not a stateful interactive custom tool. |
| Package entrypoints | OMP package examples use an `omp.extensions` manifest entry and can carry package-local dependencies. | `package.json:35-73` defines the bin, `./pi` and `./omp` exports, and separate `pi.extensions`/`omp.extensions`; `package.json:74-102` defines check/build scripts and optional host peers. | Already correct; retain explicit host entrypoints and optional peers. |
| Installation/discovery | OMP documents `--extension`, discovered extension directories, and `subdirectory/index.ts` for custom tools. | `docs/upstream-integration.md:7-16,52-59` documents the two manifests and the CLI's host-specific install/remove commands. | Adopt before next smoke: exercise both package installation commands in a clean temporary project if the smoke test covers packaging; do not conflate extension and custom-tool discovery. |
| Host adaptation | Local status extension uses runtime detection, ownership gating, and asynchronous latest-only delivery. | Pi and OMP adapters differ only where schemas and metadata differ; OMP adds `approval: "write"` and `loadMode: "essential"` (`extensions/omp.ts:5-12`). | Already correct for the current API boundary; deployment-specific event/runtime work remains outside the dispatcher. |
| Session/state reconstruction | OMP custom tools use `onSession` and details for branching/state recovery. | Dispatch is one request with no persisted tool state; returned details describe one operation. | Intentionally not applicable. |

## Recommendations before the next smoke

### Adopt before the next smoke

1. **Cancellation evidence:** add one smoke scenario that supplies an already-aborted or mid-flight `AbortSignal` to the registered executor and records the observed host `exec` termination. This is the only reference-backed behavior not exercised by the current documentation comparison.
2. **Package-path evidence:** if the smoke exercises installation, run both documented host paths (`pi` and `omp`) against the package's separate entrypoints. Check that the loaded tool name is `orca_task_dispatch`, rather than assuming one host manifest implies the other.
3. **Partial-result evidence:** exercise one successful and one failed child command and assert the returned JSON includes ordered per-slice results and `possiblePartialCreate` for the failed create. The dispatcher already implements this; the smoke should prove the observable contract.

### Already correct

- One shared dispatcher core with explicit Pi and OMP adapters.
- Host-native schema construction with equivalent constraints and descriptive fields.
- argv-array subprocess calls with `cwd`, timeout, signal forwarding, non-zero handling, JSON parsing, and redaction.
- Structured text-plus-details results covering dry-run, dispatched, partial, and failed outcomes.
- Explicit package exports/manifests, optional host peer dependencies, and documented host-specific CLI installation paths.

### Intentionally not applicable

- OMP `renderCall`/`renderResult`: this package returns a cross-host machine-readable result and does not own a TUI.
- OMP `onSession` state reconstruction: dispatch has no session-owned mutable state.
- A package-local dependency installer or custom-tool directory layout: this package is distributed through its `pi`/`omp` extension manifests and has no OMP custom-tool entry.
- Runtime-specific status posting, PID ownership, WSL loopback workarounds, or tracker mutation: those belong to the host/deployment integration, not the Orca dispatch contract.
