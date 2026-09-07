# Parent coordination layer

Status: operator guide. The authoritative contract is
[the parent coordination layer design](designs/parent-coordination-layer.md); everything on this
page is derived from it. Dispatch keeps its existing behavior and gains a durable record. Two
stages are added around it: `collect`, which only looks, and `integrate`, which owns every check
and is the only thing in this package that can move a branch.

## The split this layer makes

`orca_task_dispatch` used to plan and create children, then stop. Everything after dispatch —
finding out who had come back, reading each diff for scope violations, running the gates,
deciding whether it could merge — was done by hand, once per round, from memory.

The new layer does not automate that judgment wholesale. It splits it:

- Conditions a machine can check exactly — membership, resolvable SHAs, scope containment,
  a clean merge, green gates on the combined tree, an unmoved target — merge themselves.
- Anything that needs a value judgment stops the **entire round** and is reported on one screen.

`collect` and `integrate` are separately invokable on purpose, so the operator can inspect before
anything moves.

## What dispatch now records

Dispatch became a ledger transaction. The ledger is an append-only JSONL log with its own schema
and its own replay, reusing the journal pattern of `src/offline.ts` (append-only, `withLock`,
last-record-wins replay) but never its file: the backlog replay rejects an unknown record kind,
so writing dispatch events into that log would corrupt it.

| Record | Written when | Carries |
| --- | --- | --- |
| `round` | **before any child is created** | the complete requested member set with each slice's owned paths, `baseHead`, and an optional `supersedes` round id |
| `dispatched` | once per successfully created child | that member's worktree identity and branch |
| `dispatch-failed` | any creation failed | the members that could not be created; the round is terminal |
| `attempt` | after gating, **before the target is touched** | the gate-policy digest, every observed member SHA, the snapshotted target SHA, and the gated candidate SHA |
| `merged` / `held` | the round outcome | for `held`, the reason |

Three properties of that table matter more than the field lists:

- **Membership is written first.** Children are created concurrently and creation can partly
  fail. Because `round` lands before the first child exists, a partial dispatch cannot shrink the
  round to whatever happened to succeed; it produces `dispatch-failed` instead.
- **Per child, only what exists at dispatch time.** Slice, owned paths, `baseHead`, worktree
  identity, branch. A child head SHA cannot exist yet and is never recorded here. `baseHead` is
  the parent's exact committed HEAD, persisted precisely because a round that lost it once
  misread an already-committed worker as stuck.
- **There is no `committed` state and no `verified` record.** "Has this child committed yet" is
  derived from git at read time, never stored. Nothing has to append a record before `integrate`
  may run, so a fresh round cannot deadlock behind a missing observation.

Only the parent appends to the ledger. A child writes code and commits; it is never handed the
ledger path and is never asked to report state the parent then trusts. That is a protocol
boundary, not a sandbox — a worker running as the same user can still reach the filesystem — but
it is the boundary that keeps the parent able to distinguish "gates passed" from "gates were
declared passed".

The log lives outside every worktree, at `~/.orca-task-dispatch/ledger/<key>.jsonl` with its lock
as the sibling `<key>.lock`. The key is a digest over the backend id plus the parent's `repoId`
and worktree id, with path separators normalized and one trailing slash stripped, and no
lowercasing — on a case-sensitive filesystem two distinct parents can differ only by case.

## Precondition: run from the parent that dispatched

Because the ledger key includes the parent worktree, `collect` and `integrate` must be run from
the same parent worktree that dispatched the round. Run elsewhere they resolve a *different*
ledger, which is empty, so the round reads as unknown rather than as failed. This is a stated
precondition of the design, not a defect: no state is shared between parents, and none is
inferred across them.

## `collect`: pure inspection, changes nothing

`collect` takes a round id, reads the ledger and git, and prints one screen. Per member it
reports:

- commits since `baseHead`,
- the changed paths of that member versus its recorded owned paths,
- cross-child path overlap,
- whether the branch has moved off `baseHead` at all.

What `collect` does **not** do is the whole point of having it:

- it appends no ledger record,
- it resolves no gate policy and runs no gate,
- it touches no git state — no branch, no index, no worktree.

So an out-of-scope path or an overlap shown by `collect` is a report, never enforcement. Scope is
enforced later, by `integrate`. Running `collect` is never a prerequisite for `integrate`, and
skipping it changes no outcome.

## `integrate <roundId>`: the only stage that moves anything

`integrate` takes a **round id** and never a caller-assembled child list, so an integration
request always covers exactly the set that was dispatched together. It trusts no earlier record's
SHAs; it re-snapshots and verifies what it is about to merge.

The order is fixed, and each step has exactly one failure outcome — the round is `held`, the
reason is recorded, and the target is untouched:

| Step | Action | Holds when |
| --- | --- | --- |
| a | Require one `dispatched` record for every requested member | any member is missing one, or the round has `dispatch-failed` |
| b | Snapshot the target branch SHA and every member's branch SHA in one pass | a member is unresolvable, or still resolves to `baseHead`, meaning that child has not committed |
| c | Resolve and validate the gate policy and compute its digest | any policy problem at all (see below); nothing has been created or written yet |
| d | **Scope enforcement, pre-merge:** diff `baseHead..memberSha` per member against its recorded owned paths | any changed path falls outside that member's owned paths |
| e | Create a fresh isolated integration worktree at the **snapshotted target SHA** and merge the whole round there | any cross-child conflict |
| f | Run every gate **once, on the combined tree, in that worktree** | any gate fails or exceeds its `timeoutMs` |
| g | Append `attempt` with the policy digest, all member SHAs, the snapshotted target SHA, and the gated candidate SHA | — this record is durable *before* the target is touched |
| h | Advance the target by a guarded, serialized fast-forward, then append `merged` | the tree is dirty, the target SHA no longer equals the snapshot, the candidate is not a descendant, or `git merge --ff-only` fails |

Two details in that sequence are deliberate and easy to get wrong when reading quickly:

- The integration worktree is created at the **snapshotted target SHA, not at `baseHead`**, so a
  target that legitimately advanced since dispatch can still be advanced. `baseHead` is used only
  to compute each member's own commit range and diff.
- The gate runs **once, on the combined tree**. Per-child green does not imply the batch is
  green: ownership measures scope, not compatibility, so two children can touch disjoint paths,
  pass individually, and still break a shared contract together. Gating only the combined tree is
  what makes an automatic merge defensible at all.

### How the target is advanced

Under the ledger lock, in the recorded parent worktree: require the tree clean, re-read the target
SHA, require it to still equal the snapshotted value, require the candidate to be a descendant,
then run `git merge --ff-only <candidateSHA>`.

Not `git update-ref`, which would leave a checked-out worktree out of sync with its index. This is
a guarded serialized fast-forward, not an atomic primitive: a changed target, a dirty tree, or a
non-descendant candidate aborts with the target untouched and the round `held`, and the operator
reruns against the new target.

### It merges automatically when, and only when, all of these hold

1. Every requested member of the round has a `dispatched` record.
2. Every member's branch resolves, and none is still at `baseHead`.
3. The gate policy is present, parseable, schema-valid, of a supported `schemaVersion`, and
   entirely in bounds.
4. Every member's `baseHead..memberSha` diff stays inside that member's recorded owned paths.
5. The whole round merges into the fresh integration worktree without conflict.
6. Every gate exits zero within its timeout on the combined tree.
7. At update time the parent tree is clean, the target SHA still equals the snapshot, and the
   candidate is a descendant of it.

### It holds the whole round when any of these is true

A missing `dispatched` record, a `dispatch-failed` round, an unresolvable member, a member still
at `baseHead`, any gate-policy problem, a pre-merge scope violation, a cross-child conflict, a
combined-tree gate failure or timeout, a dirty parent tree, a target that moved between snapshot
and update, or a non-descendant candidate.

Holds are **all-or-nothing per round**. One held member refuses the entire round, and the target
is either fully advanced or completely unchanged. Rounds this design was written for are paired
slices — a code slice and its documentation slice — so landing half a round leaves code without
its docs, or docs describing code that is not there. It also keeps crash recovery simple.

## Gate policy: `.orca-task-dispatch/gates.json`

The gate definition is **parent-owned**. It lives in the parent checkout, at
`.orca-task-dispatch/gates.json`, and a child can neither define nor weaken it. That is the whole
reason worker-signed receipts were rejected: a receipt lets the party being verified define its
own acceptance, and says nothing about the combined tree.

```json
{
  "schemaVersion": 1,
  "gates": [
    { "name": "check", "argv": ["npm", "run", "check"], "env": "inherit", "timeoutMs": 900000 },
    { "name": "build", "argv": ["npm", "run", "build"], "env": "none", "timeoutMs": 300000 }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | Currently `1`. An unsupported value holds the round; it is never guessed or migrated. |
| `gates[].name` | string | Identifies the gate in the ledger reason and on screen. |
| `gates[].argv` | non-empty string array | Executable plus arguments. Never a shell string, and never assembled from task text, `sourceRef`, paths, ids, or prompts. |
| `gates[].env` | `"inherit"` \| `"none"` | Whether the gate sees the parent environment or a clean one. |
| `gates[].timeoutMs` | integer, `1000`–`1800000` | Per-gate bound. Exceeding it is a gate **failure**, not a retry. |

There is deliberately **no `cwd` field**. Every gate runs in the isolated integration worktree,
which is the only tree that represents the combined result. A gate that ran in the parent
checkout would test the unchanged target and prove nothing.

The policy digest is `sha256` over `JSON.stringify` with object keys sorted and no insignificant
whitespace, and it is recorded with each `attempt`, so an attempt records which policy actually
gated it.

Every policy problem resolves to one outcome — the round is `held`, the reason is recorded, and
**neither a candidate nor the target is created or mutated**:

- the file is missing,
- it is unparseable,
- it is schema-invalid, including an empty `argv`,
- `schemaVersion` is unsupported,
- any `timeoutMs` is out of bounds.

Because the policy resolves at step c, these holds happen before the integration worktree exists
and before any `attempt` record is written. A gate that *fails or times out* is different: that
happens at step f, on a real combined tree, and is a gate failure rather than a policy problem.

## Why a held round is terminal

A `held` round is terminal. It is never revived in place. Recovery is a **new** round that
supersedes it, carrying the repaired children's new SHAs and referencing the superseded round id.

The reason is that every SHA in an `attempt` is pinned. Reviving a held round in place would
reinterpret those pins against different content: the same round id would come to mean a
different tree, and the ledger would no longer be an audit trail of what was actually verified.
A superseding round keeps each pinned set immutable and makes the repair itself a first-class,
recorded event.

Practically: fix the child, have it commit, dispatch a superseding round, integrate that.

## Crash recovery

A git merge and a ledger append cannot commit atomically, so this layer reconciles instead of
pretending otherwise. On startup the ledger is reconciled against git ancestry:

- An `attempt` with no outcome record is decided by testing its recorded candidate SHA against
  the target's ancestry. If the target contains that candidate, the merge landed and only the
  append was lost, so `merged` is recorded. Otherwise nothing landed and the round is `held`.
- A child worktree matching a requested member that has no `dispatched` record means that member
  was not created, and the round is `held`.

This is decidable only because step g persists the candidate and target SHAs *before* any target
move. A rerun after a crash neither double-merges nor reports a merged child as outstanding.

## What this layer still refuses

- It does not push, cherry-pick, rebase, force-update, delete a branch, or clean up a child
  worktree. `integrate` advances one target by fast-forward and nothing else.
- It holds no credential and executes no tracker command.
- It builds no shell command string; every gate and every git operation is an executable plus an
  argv array.
- It adds no runtime dependency.
- It accepts no gate definition, no verification receipt, and no state report from a child.
