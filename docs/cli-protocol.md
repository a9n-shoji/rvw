# CLI protocol v4

Version 1 is the first public compatibility contract. Pre-public internal version numbers were not
released or supported; after the first public release, protocol versions only increase for breaking
changes and are never reused. Version 2 added the invariant that every declared Walkthrough reference
must be reachable from its Markdown body or Mermaid bindings. Version 3 adds post-level typed code
references to comment create, reply, edit, get, and synchronized replies, and advertises
`comment.codeReferences`. It also keeps the additive
`agent.transport`, `comment.create`, `comment.watch`, and `comment.edit` capabilities. Optional
idempotency keys are additive fields and do not change existing callers. Version 4 adds required
nullable `lastModifiedBy` provenance to comment-post output so consumers can distinguish trusted
Agent and human write channels.

This protocol carries human review decisions from rvw's repository reading surface to an external
Agent, lets an explicitly authorized Agent record review findings, and lets that Agent publish a
commit-fixed explanation back to the human. It is not an
Agent-session, prompt, or browser-control protocol: the viewer stores durable review artifacts while
all navigation remains a human action.

Machine consumers always pass `--json` or JSON over stdin. Commands using `--stdin` read the single
JSON value until EOF; a trailing newline does not terminate input. Process callers must close stdin
after writing, and shell callers should use a pipe, quoted heredoc, or input redirection instead of
typing JSON into an already-running interactive command. Successful commands emit one JSON value to
stdout. The long-running `comment watch` command is the only exception: it requires `--json-seq` and
emits RFC 7464 JSON text sequences. Progress and diagnostics go to stderr. Errors use:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "suggestions": []
  }
}
```

The authoritative schemas live beside the CLI commands in `src/cli` and are covered by contract
tests. This document describes the same public contract so consumers do not need to inspect the
implementation.

The protocol exposes `pullRequest.sync` instead of review-version submission. The Agent batch
command is:

```bash
rvw pr sync --stdin --json [--repository <PATH>] [--allow-untracked]
```

Its stdin value is:

```json
{
  "pullRequest": "https://github.com/owner/repository/pull/123",
  "commentUpdates": [
    {
      "commentRef": "rvw://comment/00000000-0000-4000-8000-000000000000",
      "reply": "対応内容は [the handler](rvw-ref:handler) で確認できます。",
      "resolve": false,
      "references": [
        {
          "id": "handler",
          "label": "RequestHandler.execute",
          "path": "src/request-handler.ts",
          "startLine": 10,
          "endLine": 24,
          "description": null
        }
      ],
      "idempotencyKey": "stable-key-for-this-exact-update"
    }
  ]
}
```

`pullRequest` is required. `commentUpdates` is optional and contains at most 500 items. Every item
requires `commentRef`, `reply`, and `resolve`; optional `references` holds post-level code references,
and optional `idempotencyKey` is 1–200 characters. At least
a non-blank reply or `resolve: true` is required. Reply text is UTF-8 GFM Markdown source and at most
64 KiB.

A successful sync refreshes the latest GitHub PR metadata and commit head, protects that head with
an rvw ref, validates every reply reference against that exact synchronized head, and applies all
comment updates in one SQLite transaction. Created replies and their references are linked to the
synchronized head commit. A successful response includes the current pull request, comparison
base, head OID, commit summaries, and `commentUpdatesApplied`.

An exact retry of an update carrying the same idempotency key returns its existing reply. Reusing the
key for another comment or caller payload fails. The derived synchronized head is not part of that
caller payload, so a concurrent head advance does not invalidate an exact retry. If the original post
was deleted, retry fails without recreating it. An update without a key remains non-idempotent; after
an uncertain result, re-read the affected comment before retrying.

By default sync inspects the saved `localRepositoryPath`. `--repository <PATH>` selects another
worktree from the same Git common directory without first changing the saved path. Tracked dirty
entries always block sync. Untracked entries block it unless the caller has inspected them and
explicitly passes `--allow-untracked`; the error contains the inspected repository path and complete
porcelain status entries. A clean PR branch that is simply behind the GitHub head is accepted: rvw
fetches the PR head into an internal ref without changing the worktree checkout. A head on the last
synchronized GitHub history is also accepted after a force-push. A local-only commit that belongs to
neither the current nor last synchronized GitHub history is rejected.

To update only the saved worktree without launching a viewer, use:

```bash
rvw pr attach <PULL_REQUEST> --repository <PATH> --json
```

## Comment commands

```bash
rvw comment create --stdin --json
rvw comment list <PULL_REQUEST> --state unresolved --limit 50 --offset 0 --json
rvw comment watch [--after <CURSOR>] [--interval 10] --json-seq
rvw comment get <COMMENT_URI> --json
rvw comment get <COMMENT_URI> --include-pr-body --json
rvw comment get <COMMENT_URI> --live --json
rvw comment reply <COMMENT_URI> --stdin --json
rvw comment edit <COMMENT_URI> --post <POST_ID> --stdin --json
rvw comment resolve <COMMENT_URI> --json
rvw comment reopen <COMMENT_URI> --json
```

`comment create` records one new unresolved thread for a registered Pull Request. Its stdin value is:

```json
{
  "pullRequest": "https://github.com/owner/repository/pull/123",
  "target": {
    "kind": "document",
    "documentKind": "repository-file",
    "sourceOid": "0123456789abcdef0123456789abcdef01234567",
    "path": "src/request-handler.ts",
    "startLine": 18,
    "endLine": 24
  },
  "body": "This branch drops the failure result before it reaches [the caller](rvw-ref:caller).",
  "relatedCommitOid": "0123456789abcdef0123456789abcdef01234567",
  "references": [
    {
      "id": "caller",
      "label": "Request caller",
      "path": "src/request-caller.ts",
      "startLine": 30,
      "endLine": 38,
      "description": "The caller that loses the result"
    }
  ],
  "authorLabel": "Agent name"
}
```

`pullRequest`, `target`, and `body` are required. `authorLabel`, `relatedCommitOid`, and `references`
are optional. `authorLabel` and `relatedCommitOid` may be `null`.
`pullRequest` is a saved PR's full URL or a number that is unique across saved PRs. `body` is non-blank
UTF-8 GFM Markdown source of at most 64 KiB. The viewer sanitizes raw HTML, preserves soft line
breaks, and supports repository-relative links and images plus display-only Mermaid. A comment post
may use `rvw-ref:<referenceId>` links backed by its own typed `references`; Mermaid node bindings and
Markdown source-range targets remain Walkthrough-only. The target is one of:

```json
{ "kind": "pull-request" }
```

```json
{
  "kind": "document",
  "documentKind": "pull-request-markdown",
  "startLine": 2,
  "endLine": 4
}
```

```json
{
  "kind": "document",
  "documentKind": "repository-file",
  "sourceOid": "0123456789abcdef0123456789abcdef01234567",
  "path": "src/request-handler.ts",
  "startLine": 18,
  "endLine": 24
}
```

```json
{
  "kind": "walkthrough",
  "walkthroughId": "00000000-0000-4000-8000-000000000000",
  "startLine": 5,
  "endLine": 8
}
```

Omitting both line fields creates a whole-document target and normalizes both values to `null`.
Supplying only one line, reversing the range, selecting a line outside the document, naming an
unavailable commit or path, or selecting a Walkthrough from another PR is rejected. File-wide
comments are accepted for binary and oversized entries, but line comments require displayable text.
PR-Markdown hashes and quoted lines, Walkthrough titles and quoted lines, and the creation head are
derived by the same application service used by the viewer; callers do not supply those persisted
values.

Comment references reuse the Walkthrough reference shape: an ID, label, repository-relative path,
nullable description, and either both ends of an inclusive line range or neither for a file-level
reference. A post may declare at most 200 references. Every declared reference must be linked from
that post's Markdown body, and every `rvw-ref:` link must name a declaration. Paths and line ranges are
validated as displayable UTF-8 documents at `relatedCommitOid`; therefore a non-empty `references`
array requires a non-null related commit. The commit is retained by rvw. References belong to one
post, not its thread, and do not inherit from another root or reply.

Success returns `{ "ok": true, "comment": ... }`, including the root post and stable
`rvw://comment/<uuid>` reference. Creation is passive: it does not open or navigate a viewer. The
operation is not idempotent. After an uncertain result, list the PR's comments and verify whether the
same target and body already exist before retrying.

`comment list` discovers saved threads for one registered PR. `--state` accepts `unresolved`,
`resolved`, or `all` and defaults to `unresolved`. `--limit` defaults to 50 and accepts 1 through 100;
`--offset` defaults to 0. The response page contains `offset`, `limit`, `returned`, `total`, `hasMore`,
and nullable `nextOffset`. Consumers continue with `--offset <nextOffset>` while `hasMore` is true.
They collect all desired URIs before mutating thread state because replies and state changes can
reorder or remove entries from later offset pages.

Each list item has the common `{ comment, latestPlacement }` shape. Its `comment` is a bounded summary:
URI, resolved value, timestamps, a target summary, post count, and the root post's first 512 UTF-8
bytes with `bodyTruncated`. Repository target summaries omit the source OID, and PR-Markdown summaries
omit the source hash and quoted text. The list does not load or return replies or source excerpts;
consumers read every URI they inspect or address with `comment get`.

Both list and get return the latest successfully synchronized PR URL, owner, repository, number,
nullable author login, title, base branch/OID, comparison base OID, head branch/OID, GitHub update/fetch times, and local
repository path. This metadata is cached and does not require a GitHub refresh. Neither the list nor
the default get response contains `pullRequest.body`. A consumer that needs the latest successfully
synchronized PR body requests it with `comment get --include-pr-body`; only that response adds the
`pullRequest.body` string.

`comment get` returns the same top-level `comment` and `latestPlacement` keys with the complete comment
target and posts, `createdHeadOid`, and the PR's `latestHeadOid`. Each complete post includes its
`relatedCommitOid`, `references`, and nullable `lastModifiedBy` (`human` or `agent`). The value records
the trusted local entry point of the latest write and is output-only; callers do not supply it.
`latestPlacement` is rvw's
authoritative derived placement at the latest head. Consumers must not treat unequal creation/latest
OIDs as Outdated: rvw accounts for unchanged lines, renames, deletion, and PR-Markdown quoted-text
placement.

`comment get --live` performs a read-only GitHub lookup without updating the SQLite snapshot. Its
`githubState` contains `liveCheckedAt`, `staleAgainstGitHub`, and current live metadata including the
author login. Without
`--live`, all three values are `null`, making it explicit that the response only reflects the last
successful synchronization. `--include-pr-body` controls both cached and live body inclusion.

For repository targets, `exactSource` contains the exact source OID, path, availability, and a bounded
excerpt. A line/range target receives up to 20 context lines on either side; a file target starts at
line 1. Excerpts are capped at 200 lines and 64 KiB and expose `truncatedBefore`, `truncatedAfter`, and
`truncatedByBytes`. Consumers use the local repository path and exact OID to read more context when a
truncation flag is true or the task needs broader context. `availability` has exactly these values:

- `available`: the exact entry can be represented as text (a submodule is represented by its OID),
  and `excerpt` is present.
- `binary`: the entry contains a NUL byte or is not valid UTF-8; `excerpt` is `null`.
- `too-large`: the entry exceeds the 1 MiB text-document limit; `excerpt` is `null`.
- `missing`: the path does not exist at the exact source OID; `excerpt` is `null`.

`exactSource` is `null` for PR, PR-Markdown, and Walkthrough targets. PR-Markdown targets contain a
source document hash and optional quoted text; rvw does not retain the full historical PR body.
Walkthrough targets include the complete current Walkthrough separately.

A standalone reply accepts:

```json
{
  "body": "調査結果または対応内容",
  "authorLabel": "Agent name",
  "relatedCommitOid": null,
  "idempotencyKey": "stable-key-for-this-exact-reply"
}
```

`body` is required, non-empty UTF-8 GFM Markdown source of at most 64 KiB. `authorLabel` and
`relatedCommitOid` are optional and may be null. `idempotencyKey` is optional and 1–200 characters.
A non-null related OID must be a 40–64 digit hex commit available to the PR. An exact retry with the
same key returns the existing post; reuse for another payload fails. Without a key, re-read the
comment before retrying an uncertain result.

Replies accept the same optional `references` array as creation. When references are present,
`relatedCommitOid` must be non-null and the body, declarations, commit, paths, and lines must satisfy
the shared validation above. References are part of the idempotent caller payload.

`comment edit` replaces one existing post identified within its thread:

```json
{
  "body": "✅ 対応しました\n\n変更内容と検証結果。",
  "relatedCommitOid": "0123456789abcdef0123456789abcdef01234567",
  "references": []
}
```

`body` has the same 64 KiB GFM contract as a reply. Omitting `relatedCommitOid` preserves the post's
current association, null clears it, and a non-null value must be an available commit for the PR.
Omitting `references` preserves the current set; supplying it replaces the complete set. The resulting
body, related commit, and reference set are validated together, so clearing a related commit also
requires removing all `rvw-ref:` links and supplying an empty reference array.
The operation is an exact replacement: retrying the same edit may advance `updatedAt` again but does
not create another post. Success returns `{ "ok": true, "post": ... }`.

Resolved threads accept replies. A standalone or synchronized reply does not reopen a resolved
thread; state changes remain explicit. `comment reopen` reopens it, while `comment resolve` or a sync
update with `resolve: true` resolves it.

### Continuous watch

`rvw comment watch --json-seq` watches new root comments and replies across all PRs saved in the
selected rvw database. A cursorless invocation emits a `ready` frame anchored at the current event
position and does not replay existing unresolved comments. Each subsequent `comment-posted` frame
contains an opaque database-scoped cursor plus `sequence`, `postId`, `commentRef`, `pullRequestUrl`,
`createdAt`, and `deleted`. It is a minimal trigger; consumers must
run `comment get` for complete context. Edits, deletions, resolve, and reopen do not create new events.
An existing event survives post deletion and is then returned with `deleted: true`.

Persist the `ready` or event cursor outside the reviewed repository. Resume with `--after <CURSOR>`;
a cursor from another database, beyond the current event sequence, or otherwise invalid fails. The default poll interval is 10 seconds
and accepts 1 through 300 seconds. `--once` drains the currently available page and exits, primarily
for protocol tests and recovery tools. Independent tasks may consume the log with separate cursors.

rvw does not start an Agent, store its queue, or authorize code changes. The external task owns
batching, retries, and self-event suppression. The bundled `rvw-watch-comments` Skill supplies a
task-local SQLite state tool for atomic cursor ingestion, batch leases, and one status post per affected
comment URI in each batch. After a claim and successful thread read, it immediately creates
`🔎 確認中です…`, suppresses that reply's watch event, and edits the same post to the final outcome.
A retry of the same batch restores that post; a later batch for the same thread creates a new one and
leaves the earlier outcome unchanged. It requires explicit
startup authorization before an authenticated user's own PR can be fixed and pushed, and verifies the
live head repository, branch, and OID so fork PRs cannot target the base repository accidentally.
Another or unknown author remains code/GitHub read-only.

The Skill also bundles one aggregate preflight, a cursor-resolving RFC 7464 driver, an empty-to-non-empty
pending waiter, and an auto-ack command. The normal driver polls once per second and invokes auto-ack
immediately after durable ingestion, so the status marker needs no Agent shell round trip. Unexpected
watch exits reconnect from the state cursor with bounded exponential backoff; protocol frames, ingest,
and acknowledgement failures have distinct nonzero driver exits. These helpers remain external Skill
processes and do not move Agent runtime or task state into rvw. Before an initial connection or
reconnect, the driver drains eligible pending work left between a durable ingest and an interrupted
acknowledgement. Auto-ack is capped by the subagent capacity reserved by the parent, and a short-period
task-state pump drains same-PR follow-ups after lease release and retryable batches after their due time
without waiting for another watch event or reconnect. Before spawning rvw, the driver atomically acquires
one process-owner lock beside the canonical task-state path. A concurrent driver for that state exits
without starting another watcher. The lock is released on graceful shutdown, and a later driver reclaims
it only when the recorded owner process no longer exists.

## Walkthrough lifecycle

Walkthroughs expose one current value under a stable URI. rvw does not keep Walkthrough revisions or
provide a version selector. Whole-document comments target the stable Walkthrough ID and therefore stay
attached when its current content is replaced. Source-line comments keep their original exact quote and
rvw reports them at the unique matching range in the current body, or as Outdated when no unique range exists.

Read an existing Walkthrough before updating or deleting it:

```bash
rvw walkthrough get <WALKTHROUGH_URI> --json
```

The response contains the complete current Walkthrough and its Pull Request, including the local
repository path needed to inspect referenced code.

### Publish

```bash
rvw walkthrough publish --stdin --json
```

The stdin value is:

```json
{
  "pullRequest": "https://github.com/owner/repository/pull/123",
  "sourceOid": "0123456789abcdef0123456789abcdef01234567",
  "title": "Request flow",
  "body": "Start at [the handler](rvw-ref:handler), then inspect the [composition root](rvw-ref:composition).",
  "authorLabel": "Agent name",
  "diagramBindings": {
    "Handler": "handler",
    "Store": "repository"
  },
  "references": [
    {
      "id": "handler",
      "label": "RequestHandler.execute",
      "path": "src/request-handler.ts",
      "startLine": 10,
      "endLine": 24,
      "description": "Application orchestration boundary"
    },
    {
      "id": "repository",
      "label": "PostgresRequestRepository.insert",
      "path": "src/postgres-request-repository.ts",
      "startLine": 18,
      "endLine": 31,
      "description": null
    },
    {
      "id": "composition",
      "label": "Application composition root",
      "path": "src/application.ts",
      "description": "File-wide dependency wiring"
    }
  ]
}
```

`pullRequest`, `sourceOid`, `title`, `body`, and one or more references are required. `sourceOid`
must be a 40–64 digit hex commit available to the saved pull request. Reference IDs and Mermaid node
IDs use `[A-Za-z][A-Za-z0-9_-]{0,63}`. Every repository-relative path must be an available UTF-8
document at that commit. A reference may omit both `startLine` and `endLine` to target the whole file;
otherwise both are required and define an existing inclusive single-line or multi-line range. Omitted
input fields are normalized to `null`, and saved references always return both fields as numbers or `null`. Markdown uses
`rvw-ref:<referenceId>` links. Every `diagramBindings` value must name a supplied reference, and its
key must identify a node or class that actually occurs in a flowchart or classDiagram fence. Every
supplied reference must be used by at least one Markdown or HTML `rvw-ref:` link or valid diagram binding. Unused or
phantom-bound references are rejected because the viewer has no separate reference index.

A fenced code block whose language is exactly `html-preview` is rendered as a static HTML/CSS visual.
HTML previews remain part of the Markdown `body`; no alternate Walkthrough format or persistence shape
is added. They may contain `rvw-ref:<referenceId>` links, which participate in the same declared/used
reference validation as Markdown links. Repository images use repository-root-relative paths fixed to
`sourceOid`. JavaScript, event handlers, frames, forms, external resources, network-capable CSS, and
internal `data-rvw-source-*` attributes are rejected with a Walkthrough line number. Consumers must
require the additive `walkthrough.htmlPreview` capability before publishing this fence syntax.

The body is limited to 256 KiB, and a publication may contain at most 200 references. A successful
publication protects `sourceOid` with rvw's immutable commit ref. The response contains the saved
Walkthrough and its `rvw://walkthrough/<uuid>` reference. Publication is
not a viewer command: it does not open a browser, activate a document, choose a commit, or change any
tab or scroll position. The human later chooses which inline reference or bound diagram node to open;
the viewer does not duplicate all references in a side or bottom index.

### Update in place

```bash
rvw walkthrough update <WALKTHROUGH_URI> --stdin --json
```

Update accepts the same `sourceOid`, `title`, `body`, `diagramBindings`, and `references` fields as
publication, but does not accept `pullRequest`: the stable URI already identifies it. The input is a
complete replacement rather than a patch. Omitting `authorLabel` preserves the current value; a string
or `null` replaces it. Commit, document, line, Markdown-link, and diagram-binding validation is identical
to publication.

Success returns the updated Walkthrough with the same ID, URI, and `createdAt`. No previous body,
reference set, source OID, or update revision is retained. Existing whole-Walkthrough comments resolve
to the current body and references; line comments are re-anchored from their bounded quoted text or reported
Outdated. Updating remains passive and does not control a viewer.

### Delete

```bash
rvw walkthrough delete <WALKTHROUGH_URI> --json
rvw walkthrough delete <WALKTHROUGH_URI> --yes --json
```

The first form returns `WALKTHROUGH_DELETE_CONFIRMATION_REQUIRED`, the current Walkthrough, and counts
for references, comments, and posts that would be removed. The confirmed form permanently deletes the
Walkthrough, its references, and those comments and posts. Copied Walkthrough and comment URIs stop
resolving. Deletion does not remove the retained Git commit ref because other review state may share it;
`rvw pr reset` remains the ref cleanup boundary.

## Local transport and database path

When a normally launched rvw viewer is running, its database-scoped runtime exposes a Unix socket
with mode `0600` inside a per-user `0700` temporary directory. Agent CLI commands try that socket
first, so writes such as comment creation, reply, resolve, Walkthrough update,
and repository attachment execute through the already-authorized rvw process instead of requiring the
Agent sandbox to open SQLite for writing. Without `RVW_AGENT_SOCKET_PATH`, a connection failure before
request transmission may fall back to the selected direct database. When `RVW_AGENT_SOCKET_PATH` is
explicit, that socket is required: connection failure or database mismatch returns
`AGENT_SOCKET_UNAVAILABLE` and never opens SQLite as a fallback. If a sent request times out or the
connection closes without a valid response, the CLI reports an uncertain outcome and does not repeat
a potentially non-idempotent operation. Re-read state before retrying.

`rvw agent ping --json` tests socket connectivity and exits 2 unless the socket answers. `rvw agent
status --json` reports the transport that normal commands would select and exits 2 only when an
explicit socket makes the transport unavailable. Both expose `socketPath`, `socketPathSource`,
`connectionResult`, `expectedDatabasePath`, `socketDatabasePath`, `socketOwnerPid`,
`selectedTransport`, `selectedDatabasePath`, `fallbackReason`, and any OS-level `connectionDetails`.
The non-JSON output shows the same diagnostic fields. The same socket also carries the private
`viewer.open` lifecycle request used by `rvw open`; it is not an Agent command or advertised capability.
An atomic owner lock is acquired before Runtime, SQLite, or HTTP initialization. Exactly one runtime may
serve a database path, while different database paths may have independent owners. A concurrent loser
delegates its requested Pull Request to the owner and exits; if the owner is stopping, it retries ownership
after the old lock is released rather than waiting only for a disappearing socket. A successful `viewer.open`
holds an operation reservation while resolving the Pull Request, then starts a bounded viewer reservation
until the returned URL sends its first heartbeat;
`--no-open` consumes that reservation itself and heartbeats until Ctrl+C. Shutdown stops socket request
acceptance, drains HTTP, closes Runtime/SQLite, and only then removes the socket and releases ownership.
A later invocation may remove an exact stale lock/socket whose recorded owner PID is dead. CLI stdin and
socket request/response frames are capped at 40 MiB.

The default database directory and file are created with modes `0700` and `0600`. Existing paths are
checked with `stat`; rvw does not chmod them when owner and mode are already safe. A failed chmod on a
new path is tolerated only when the resulting owner and mode are safe. Set `RVW_DATABASE_PATH` to use
an explicitly managed database path; rvw does not chmod existing components of that path. Missing
directory/file components created by rvw use creation modes `0700` / `0600`. The socket request includes this
expected path and is dispatched only when the viewer uses the same database. `rvw doctor --json`
reports the active path, its source, whether rvw manages its permissions, actual/expected permission
metadata and warnings, a real write-transaction probe, Agent transport connectivity, and installed
Skill status.

## Bundled Skills

`rvw skill install codex` and `rvw skill install claude` each install the same three capability-named
Skills: `rvw` for comment creation, handling, and synchronization, `rvw-walkthrough` for publication,
and `rvw-watch-comments` for continuous new-post intake. The
platform argument selects only the destination Skill root. Neither Skill hardcodes an Agent identity;
the current Agent may supply an accurate optional `authorLabel`.

`rvw-watch-comments` documents the complete state-script stdin/stdout contract. Its driver derives
`--after` from task state, its auto-ack reuses each batch operation's idempotency key and status post
only when that batch is retried, accepts the current runtime's accurate `--author-label` for the
acknowledgement/final post, and hands every acknowledged lease to one fresh subagent in the
same parent scheduling turn. The parent never substitutes direct processing. Each subagent handoff uses
an absolute JSON result path rather than relying on relayed completion text. Subagent outcomes carry
`body`, `relatedCommitOid`, a complete `references` array, and `pushStatus`. The Skill uses typed
references by default for concrete code behavior, implemented
changes, and relevant tests when an exact committed range adds navigation value. Investigation-only
outcomes may cite their evidence commit without claiming that a change was pushed.

Each rvw-managed installation records the bundled digest. Status distinguishes a clean older bundle
(`updateAvailable` and `updateRequired`), local customization (`locallyModified`), and a differing
installation with no trustworthy rvw marker (`unmanaged-difference`). None is overwritten without
an explicit forced install.

`rvw-walkthrough` constrains commit identity, code references, diagram bindings, CLI validation,
passive publication and update, and explicit destructive authorization. It treats the explanation as
a first reading path for building a mental model of a change or requested implementation subject,
follows explicit authoring instructions first, and uses a flexible default guide only for unspecified
choices. It deliberately avoids a fixed template, an exhaustive review boundary, and AI-review conclusions.

## Protocol discovery

For a comment whose target is `kind: "walkthrough"`, `rvw comment get` also returns the complete
current `walkthrough` object. This gives the Agent the explanation body and exact code references being
discussed without relying on rendered browser positions. If the Walkthrough is updated, the same
comment URI subsequently returns the updated current object.

`rvw protocol --json` returns `protocolVersion: 4`, the application version, and these capabilities:

```text
agent.transport
comment.create
comment.list
comment.watch
comment.read
comment.reply
comment.edit
comment.codeReferences
comment.resolve
comment.reopen
pullRequest.sync
walkthrough.read
walkthrough.publish
walkthrough.update
walkthrough.delete
walkthrough.htmlPreview
```

Consumers must reject an unsupported protocol version or missing required capability rather than
guessing a fallback command.
