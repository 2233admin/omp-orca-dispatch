# Offline backlog and outbox contract

Status: implemented in `src/offline.ts`, registered by both host entrypoints. No code in
`src/dispatcher.ts` changed for this feature.

## Why a separate module

`orca_task_dispatch` is deliberately tracker-agnostic: it does not fetch, parse, authenticate
to, mutate, or infer permissions from `sourceRef`. Its tests cover that boundary, and its only
external dependency is the `orca` CLI, so it carries no credential surface.

Putting tracker API calls inside that tool would break all three properties at once. The offline
capability therefore lands in a new module (`src/offline.ts`) with its own tool registrations.
Dependency direction is one-way: dispatch results can be handed to the backlog by the caller;
the dispatcher never learns that the backlog exists.

## What offline can and cannot mean

A tracker task's existence, assignee, and runtime registration live server-side. When the
control plane is unreachable a machine cannot legitimately *claim* a tracker task: claiming
requires server-side accounting, otherwise two machines can claim the same ticket. The
per-task `.task_lock` / `.task_owner` files observed in a Multica workspace are host-local
locks and do not prevent cross-machine double claims.

So offline operation is scoped to:

| Capability | Offline? |
| --- | --- |
| Start work from a locally recorded intent | yes |
| Keep completed work and its evidence durable | yes |
| Flush that evidence to the tracker once reachable | on reconnect |
| Claim a new tracker-owned task | **no** — needs server-side accounting |

A local intent is never presented as a tracker task. Promoting one into a ticket is a human
decision; see "No automatic ticket creation".

## Tool surface

Two tools, split on the credential boundary rather than bundled behind one action enum, so
host approval metadata stays meaningful.

### `orca_backlog` — local only, no network

| Action | Effect |
| --- | --- |
| `enqueue` | Record a work item: `title`, optional `sourceRef`, optional `syncTarget`, optional `scope[]` |
| `claim` | Mark an item in progress by this host; refuses an item already claimed by another host |
| `complete` | Attach evidence (commits, verification output) and mark done. A completed item with a `syncTarget` becomes an outbox candidate; it is **not** synced |
| `bind` | Attach a concrete `syncTarget` to a `pending-triage` item, returning it to `completed`. This is the only exit from `pending-triage` |
| `ack` | Record that the caller executed a sync record: takes the item id plus the tracker-returned issue/comment id, and moves the item to `synced`. This is the only transition into `synced` |
| `list` | Report items filtered by state |

`ack` is deliberately separate from `complete`: `complete` states that the work is done, while
`ack` states that the tracker write landed. Collapsing them would let a queued-but-unwritten
item look synced.

State lives in one JSONL file per repository under a package-neutral state root
(`~/.orca-task-dispatch/backlog`, overridable by a host entrypoint), appended
under an exclusive lock. Append-only: `claim`, `complete`, and `ack` write new records rather
than rewriting history, so a crash mid-write cannot corrupt earlier entries.

### `orca_outbox_sync` — plans the tracker write, never performs it

The package stays credential-free. This tool does **not** hold a tracker token, does not read
one from the environment, and does not invoke the tracker CLI. It converts completed-but-unsynced
items into an executable plan and hands that plan back to the caller.

For each completed item:

1. No explicit `syncTarget` → leave it `pending-triage` and report it. Never guess a reference.
2. Otherwise emit a **sync record**: the issue reference, the comment body written to a UTF-8
   temp file, and the exact argv to run — for Multica,
   `["issue", "comment", "add", "<ref>", "--content-file", "<path>"]`.
3. Return every sync record plus a reachability observation. Nothing is marked synced yet.

The host or agent executes the argv with whatever credentials it already holds, then calls
`orca_backlog ack` with the tracker-returned ids so the item is recorded as `synced`. An item
stays queued until that acknowledgement arrives, so a failed or skipped execution is never
mistaken for a successful write.

`ack` accepts only an item id, the tracker-returned issue reference, and the tracker-returned
comment id. It exposes no state field — a caller cannot assert `synced` directly. The tool
rejects the call when the item's latest record is not `completed`, when the supplied issue
reference differs from the one stored on that item, or when the comment id is empty. The state
transition is computed by the tool, never supplied by the caller.

Repeating an `ack` for an item already `synced` is idempotent: the tool re-reports the stored
external ids and appends nothing when they match, and fails when they differ rather than
overwriting the recorded write.

`claim` and `complete` carry the same discipline, so a replay cannot silently rewrite state:

- `claim` on an item this host already claimed is idempotent — it appends nothing and re-reports
  the existing claim. `claim` on an item claimed by a different host id is refused, and `claim`
  on an item already `completed` or `synced` is refused.
- `complete` is accepted only when the item's latest record is `claimed` **by the calling host**.
  Completing an unclaimed, foreign-claimed, or already-completed item is refused.
- A repeated `complete` never merges or overwrites evidence: identical evidence is idempotent,
  differing evidence fails and requires an explicit new item.

Every one of these transitions needs a test. The state table alone looks complete while an
implementation that skips the guards would still mis-write.

Rationale: the alternatives are worse. Reading a token inside the package gives it a credential
surface it currently does not have, and the tests that assert the security boundary would have to
be rewritten. Invoking the tracker CLI without a token merely produces a tool that always fails.

A controlled `MULTICA_SYNC_CMD` adapter — an operator-configured argv prefix the tool would
execute — is deliberately **rejected**: it reintroduces execution (and therefore inherited ambient
credentials) into the package while hiding which binary runs, and it cannot be covered by the
argv-only tests.

## `sourceRef` is not a tracker target

`sourceRef` keeps the meaning the dispatch tool gives it: an opaque, one-line traceability
label that may be a Multica URL, a Gitea issue URL, a Jira key, or a chat reference. It is never
parsed and never used to build a command — feeding a Jira URL to `multica issue comment add`
would produce a broken invocation.

A tracker write therefore requires a separate, explicitly typed `syncTarget`:
`{ kind: "multica", issueRef }`. Any other `kind` is rejected, because no other tracker's argv is
implemented. An item may carry a `sourceRef` for provenance, a `syncTarget` for writing, both, or
neither.

## Reachability

Measured, not assumed. A TCP probe is insufficient: on one fleet host `100.80.110.105:3010`
answered a TCP connect test while HTTP returned `000` immediately, and the LAN address for the
same service returned `401`.

- HTTP status `401` (or any HTTP response) means **reachable** — the service is healthy and
  merely wants credentials.
- No HTTP response (`000`, connect refused, timeout) means **unreachable**.

Implemented as `probeTracker(baseUrl)`. `orca_outbox_sync` reads the endpoint from `MULTICA_SERVER_URL` only. It is
deliberately not a tool parameter: a caller-supplied URL would let a model aim the probe at an
arbitrary internal host, making the tool an SSRF primitive. Only a base URL is ever read, never
a token. The plan is produced either way, so items can be queued with no network at all.

## Proxy hygiene

An observed fleet outage had this root cause chain: `NO_PROXY` contained the shell-style
wildcard `192.168.*`, which Go's `net/http` proxy resolver does not honour (it accepts IPs,
CIDRs, and domain suffixes); the internal address therefore went to the proxy named by
`HTTP_PROXY`; that proxy pointed at a port with no listener. Eight agent runtimes stayed
offline as a result.

Consequently, when this module executes a tracker or local CLI it must bypass the ambient
proxy for internal addresses explicitly, rather than depend on the host's `NO_PROXY` being
written in a form the callee's HTTP stack understands.

## No automatic ticket creation

The module never creates tickets. Duplicate suppression belongs to the tracker — the Multica
CLI's `issue create` already refuses an active duplicate unless `--allow-duplicate` is passed —
and deciding whether an item deserves a ticket needs semantic judgement this module does not
have. Items without an explicit `syncTarget` surface as `pending-triage`.

## Execution rules

- Every CLI invocation goes through `HostApi.exec(command, args, options)` with an argv array.
  Task text, scope entries, and `sourceRef` are never interpolated into a shell string.
- Non-ASCII comment bodies are written to a UTF-8 file and passed with the tracker CLI's
  `--content-file` flag. The Multica CLI documents that stdin piping mangles non-ASCII bytes on
  Windows, and fleet content is largely Chinese.
- Timeouts and abort signals follow the existing dispatcher constants.

## Host parity

Both entrypoints register both tools, each with its own schema builder:

- `extensions/omp.ts` — Zod parameters via `createOmpParameters`-style builders, plus
  `approval: "write"` and `loadMode: "essential"`.
- `extensions/pi.ts` — TypeBox parameters via `createPi*` builders.

Adding the tools to one entrypoint only would leave the other host without the capability, so
tests must assert both registrations, matching how the dispatch tool is already covered.

## State machine and locking

Item states: `queued → claimed → completed → synced`, plus the terminal-until-triaged
`pending-triage` for a completed item that carries no `syncTarget`.

The log is append-only; current state is the **last record for that item id** after a full
replay. `claim` and `complete` append a new record instead of rewriting an earlier one, so a
torn write can only truncate the newest line — replay ignores a trailing partial line and the
prior state survives.

Because state is derived, `claim` is a read-modify-append and needs mutual exclusion. The rule:

- Acquire an exclusive lock on a sibling `<log>.lock` file, replay the log, verify the item is
  still `queued`, append the claim, release. A claim on an item whose latest record is already
  `claimed` by a different host id is refused.
- Locking is process-level and host-local. On POSIX use an `flock`-style advisory lock; on
  Windows use an exclusive file open (`wx`) with bounded retry, since advisory locks are not
  available there. The implementation must pick one primitive per platform explicitly rather
  than assume `fs` calls are atomic across processes.

**Scope of the guarantee.** This prevents two processes on the *same host* from claiming one
item. It does **not** prevent two hosts from claiming the same item, because the log is local
and unshared. Cross-host exclusivity requires server-side accounting and is therefore out of
scope — the same reason offline claiming of tracker-owned tasks is out of scope. Any claim
record includes a host id so a later reconciliation can detect a collision, but detection is
not prevention, and the docs must not claim otherwise.

## Repository identity

The log is keyed by the **repository root**, found by walking up from the working directory to
the nearest `.git` (a file in a worktree, a directory in a clone). Keying on the raw working
directory would give every subdirectory of one checkout its own log and silently defeat the
claim guarantee, since two processes in sibling directories would never see each other.

Outside a repository the backlog refuses rather than falling back to the working directory: a
silent fallback would downgrade the repository-scoped guarantee without telling the caller.

## Path and argv discipline

No tool parameter accepts a filesystem path. The log location is derived by the module from the
repository identity plus the host state directory; a caller cannot redirect it, and the sync
record's temp-file path is produced by the module rather than supplied. This keeps both hosts on
one code path and removes a traversal surface.

Every external invocation goes through `HostApi.exec(command, args, options)` with an argv
array — the same abstraction the dispatcher already uses for `orca`, which is what makes the
package host-agnostic. No tool builds a shell string, and no tool shells out directly, so OMP
and Pi cannot drift into two behaviours.

## Decided

- **Publish path.** GitHub release is the interim distribution: the repository is the source of
  truth and installs run from a checkout. The README's `npx --yes omp-orca-dispatch@<version>`
  path is *not* usable today — the public npm registry returns 404 for this name — so the README
  must stop presenting it as the install route until a registry publish happens. Publishing to
  npm or an internal registry remains a follow-up gated on CI and registry credentials, not a
  design question.
