# Tracker adapters

Status: seam contract for the outbox. The adapters live in `src/trackers/`; `src/offline.ts`
consumes them and names no tracker. `orca_task_dispatch`, `src/dispatcher.ts`, and the worktree
backends in `src/backends/` are untouched by this seam — `docs/worktree-backends.md` covers that
separate abstraction.

## Why the seam exists

`orca_outbox_sync` turns completed backlog items into an executable tracker write. Until now the
tracker was hardcoded in four places inside `src/offline.ts`: `SyncTarget` was
`{ kind: "multica"; issueRef }`, `parseBacklogParams` rejected every other `kind`, `planSync`
emitted `command: "multica"`, and the argv it built was Multica's
`issue comment add … --content-file` spelling.

Nothing about the outbox is Multica-specific. The durable part is the state machine — queue,
claim, complete, plan, `ack` — and the credential boundary. Only the last step, "which executable
with which argv posts this comment", is tracker-shaped. Leaving that inlined made the whole
capability unusable for anyone not running Multica, which is nearly every external user, while the
README advertises the tool as tracker-agnostic.

So the tracker-facing step becomes an adapter, exactly as the environment-facing step of dispatch
became a backend.

## Contract

```ts
export type TrackerId = "multica" | "gitea" | "github";

/** One executable-plus-argv invocation. Adapters never build shell command strings. */
export type PlannedTrackerCommand = { command: string; args: string[] };

export type TrackerAdapter = {
  readonly id: TrackerId;
  /** Argv that posts the contents of `bodyFile` as a comment on `issueRef`. */
  planComment(issueRef: string, bodyFile: string): PlannedTrackerCommand;
};

/** Every selectable tracker, keyed by the public `syncTarget.kind` value. */
export const TRACKER_ADAPTERS: Record<TrackerId, TrackerAdapter>;
export const TRACKER_IDS: TrackerId[];
export function resolveTracker(kind: unknown): TrackerAdapter;
```

`SyncTarget` widens to `{ kind: TrackerId; issueRef: string }`.

One method, deliberately. Commenting on an issue that already exists is the only tracker write the
outbox performs — it never creates, closes, labels, assigns, or reads tickets (see "No automatic
ticket creation" in `docs/offline-backlog-contract.md`) — so a wider interface would consist
entirely of methods no caller can reach.

Two arguments, both produced by the module rather than by a caller: `issueRef` comes from the
item's stored `syncTarget`, and `bodyFile` is the temp path `planSync` already wrote the UTF-8 body
to. An adapter receives no body text, no host API, and no execution capability. It is a pure argv
builder, which is what makes each adapter fully testable by inspecting its return value.

`src/offline.ts` names no tracker after the change: it calls `resolveTracker(syncTarget.kind)` and
asks the adapter for the argv. `resolveTracker` throws for an unrecognized id, listing
`TRACKER_IDS`, rather than defaulting — guessing would post a comment to the wrong tracker out of a
reference belonging to another, which is exactly the failure mode that keeps `sourceRef` unparsed
and is unrecoverable from inside this package. `parseBacklogParams` rejects an unknown `kind` at
the boundary for the same reason.

## Reference validation shared by every adapter

`normalizeIssueRef` trims the reference, rejects an empty one, and rejects one starting with `-`.
Argv-only execution has no quoting layer, so a leading dash would be read as an option by every
executable below instead of as an issue reference. It is refused rather than escaped, because the
correct escape differs per CLI and a wrong guess would silently change the meaning of the command.
Beyond that, `issueRef` is substituted into argv and never rewritten.

## The three adapters

| `kind` | `command` | `args` |
| --- | --- | --- |
| `multica` | `multica` | `["issue", "comment", "add", "<ref>", "--content-file", "<bodyFile>"]` |
| `github` | `gh` | `["issue", "comment", "<ref>", "--body-file", "<bodyFile>"]` |
| `gitea` | `curl` | the Gitea API POST below |

Every adapter passes the body as a file path — never inline in argv, never on stdin. The reason is
recorded in the offline contract: comment bodies on this fleet are largely Chinese, and stdin
piping mangles non-ASCII bytes on Windows. A file path also keeps argv bounded and readable in a
host approval prompt however long the evidence block is.

### `multica`

Byte-identical to the pre-seam behavior, including argument order. Existing items and existing
plans are unaffected by the widening. `--content-file` is the flag the previous implementation
already used, and the Multica CLI documents the Windows stdin problem.

### `github`

`gh issue comment <ref> --body-file <bodyFile>`. The published `gh issue comment` manual documents
`{<number> | <url>}` as the target and `-F, --body-file <file>` as "Read body text from file", so
both a bare issue number and a full issue URL are valid references. A bare number resolves against
the repository of the executing working directory — the caller's own checkout. This package never
names a repository on the caller's behalf and never passes `-R`.

### `gitea`

Gitea's own CLI is not usable here. Checked against tea `main` (`cmd/comments/add.go`,
`cmd/comments/body.go`): `tea comments add <index> [<body>]` resolves its body from the positional
argument, from `-d/--description`, or from piped stdin, and registers no file option. Inline argv
and stdin are both closed to this seam — `planComment` receives only a path, and stdin is the exact
route that mangles non-ASCII bytes on Windows — so the adapter posts to the Gitea API with `curl`
instead and lets curl read the body straight out of the UTF-8 file:

```text
curl --fail-with-body --silent --show-error
     --request POST
     --variable %GITEA_TOKEN
     --expand-header "Authorization: token {{GITEA_TOKEN}}"
     --variable body@<bodyFile>
     --expand-json "{\"body\":\"{{body:json}}\"}"
     --url <base>/api/v1/repos/<owner>/<repo>/issues/<index>/comments
```

Why each part is there:

- `--variable %GITEA_TOKEN` imports the value from the *executing host's* environment. Only the
  variable name reaches the argv; see "Credentials stay with the host" below.
- `--variable body@<bodyFile>` plus `{{body:json}}` makes curl read and JSON-escape the file
  itself, so a non-ASCII body never passes through stdin, a shell, or a JSON string this package
  assembled by hand.
- `--fail-with-body` turns an API rejection into a nonzero exit while still printing the server's
  message, so a caller cannot `ack` a comment the server refused.
- Variables and the `--expand-` prefix require curl 8.3.0 or newer, which is where both were
  introduced.

Accepted `issueRef` forms:

- A canonical issue URL, `https://host/{owner}/{repo}/issues/{index}`, which carries the server
  and needs no environment lookup. Exactly four path segments are accepted: a Gitea served under a
  URL subpath is refused, because the extra segments cannot be told apart from an owner and
  guessing would file the comment on the wrong repository.
- A short `owner/repo#42` or `owner/repo/issues/42`, which names a repository but no server. The
  base URL then comes from `GITEA_SERVER_URL`, validated as an absolute `http:`/`https:` URL with
  trailing slashes trimmed. Unset, it is an error naming the variable, never a guessed host.

`owner` and `repo` are percent-encoded into the API path.

## The package emits a plan and never executes it

`orca_outbox_sync` returns sync records. It does not spawn a tracker CLI or `curl`, and no adapter
can: an adapter is handed no `HostApi` and no environment beyond the base-URL lookup above.

The caller executes each record's argv with the credentials it already holds, then reports the
outcome through `orca_backlog ack`, the only transition into `synced`. An item whose argv was never
run, or whose run failed, stays `completed`: nothing in this package can mistake a skipped write
for a successful one.

This is also why the seam builds plans instead of being a configurable executor. An
operator-configured argv prefix that the tool would run — the rejected `MULTICA_SYNC_CMD` idea in
`docs/offline-backlog-contract.md` — reintroduces execution, and therefore inherited ambient
credentials, into the package, hides which binary runs, and cannot be covered by argv-only tests.
Per-tracker adapters give the same reach with none of that: the set of executables is closed,
declared in source, and asserted by tests.

## Credentials stay with the host

The rule is precise: **no secret value ever appears in an emitted argv.** An adapter may name the
environment variable that holds a credential so the executing host substitutes it; it never reads,
resolves, embeds, or logs the value.

- No adapter reads a token, keyring entry, `.netrc`, or credential file. The only environment value
  any adapter reads is `GITEA_SERVER_URL`, and a base URL is not a credential.
- `GITEA_TOKEN` appears in argv only as a curl variable *name*; curl resolves it at execution time
  on the host. A plan, a log line, and a tool result therefore contain no token, and a plan
  captured in a backlog record stays safe to display.
- No adapter emits a URL with embedded credentials, a cookie, or a password flag.
- `multica` and `gh` authenticate entirely through their own stored login (`multica`'s configured
  server, `gh auth login`), which already resolves credentials for the user who runs them.
- An emitted plan is safe to show in an approval prompt: an executable name, subcommand words, an
  issue reference or API URL, flags, a variable name, and a temp file path.

`MULTICA_SERVER_URL` remains what it was — a base URL for the reachability probe, never a token.
Adapters do not participate in that probe.

## Adding a fourth adapter

1. Add the id to the `TrackerId` union in `src/trackers/types.ts`.
2. Add `src/trackers/<id>.ts` exporting one `TrackerAdapter` whose `planComment` calls
   `normalizeIssueRef` and returns the executable plus argv for that tracker's "comment on an
   existing issue" operation, with the body passed as a file path.
3. Register it in `TRACKER_ADAPTERS` in `src/trackers/index.ts` so `resolveTracker` finds it.
   Do not edit `src/offline.ts`: if a new tracker needs a change there, the seam is wrong.
4. Widen both host schemas in `src/schema.ts` — the TypeBox `kind` literal and the Zod `kind`
   enum — so Pi and OMP accept the same set. Host parity is asserted by tests; widening one host
   only would leave the other rejecting a valid `syncTarget`.
5. Add tests: the exact `command` and `args` for a fixed `issueRef`/`bodyFile` pair, presence in
   the registry under its id, rejection of an empty and a `-`-leading reference, both host schemas
   accepting the new kind, and an unknown kind still being rejected.
6. Add a row to the table above, a subsection recording which flags were checked against upstream,
   and a CHANGELOG entry.

Rules a new adapter must not break: the body travels as a UTF-8 file, not stdin and not inline
argv; the plan is an executable plus an argv array, never a shell string assembled from task text,
evidence, paths, or a reference; no credential is read and no secret value is emitted; `issueRef`
is validated and substituted, never parsed into something new or defaulted; and the plan appends
one comment and mutates nothing else.

## `sourceRef` is still not a tracker target

Unchanged by this seam, and worth repeating because the widened `kind` set now overlaps with the
trackers a `sourceRef` may point at. `sourceRef` is an opaque one-line traceability label — a
Multica URL, a Gitea issue URL, a Jira key, a chat reference — that is never parsed and never used
to build a command. A tracker write always requires a separate, explicitly typed `syncTarget`. An
item may carry one, the other, both, or neither.
