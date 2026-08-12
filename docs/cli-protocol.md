# CLI protocol v1

Version 1 is the first public compatibility contract. Pre-public internal version numbers were not
released or supported; after the first public release, protocol versions only increase for breaking
changes and are never reused.

This protocol carries human review decisions from rvw's repository reading surface to an external
Agent and lets that Agent publish a commit-fixed explanation back to the human. It is not an
Agent-session, prompt, or browser-control protocol: the viewer stores durable review artifacts while
all navigation remains a human action.

Machine consumers always pass `--json` or JSON over stdin. Successful commands emit one JSON
value to stdout. Progress and diagnostics go to stderr. Errors use:

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
      "reply": "対応内容。返信しない場合は空文字列。",
      "resolve": false
    }
  ]
}
```

`pullRequest` is required. `commentUpdates` is optional and contains at most 500 items. Every item
requires `commentRef`, `reply`, and `resolve`; at least a non-blank reply or `resolve: true` is
required. Reply text is plain UTF-8 and at most 64 KiB.

A successful sync refreshes the latest GitHub PR metadata and commit head, protects that head with
an rvw ref, and applies all comment updates in one SQLite transaction. Created replies are linked to
the synchronized head commit. A successful response includes the current pull request, comparison
base, head OID, commit summaries, and `commentUpdatesApplied`.

The operation is not idempotent when it contains replies. After an uncertain result, re-read every
affected comment before retrying.

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
rvw comment list <PULL_REQUEST> --state unresolved --limit 50 --offset 0 --json
rvw comment get <COMMENT_URI> --json
rvw comment get <COMMENT_URI> --include-pr-body --json
rvw comment get <COMMENT_URI> --live --json
rvw comment reply <COMMENT_URI> --stdin --json
rvw comment resolve <COMMENT_URI> --json
rvw comment reopen <COMMENT_URI> --json
```

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
title, base branch/OID, comparison base OID, head branch/OID, GitHub update/fetch times, and local
repository path. This metadata is cached and does not require a GitHub refresh. Neither the list nor
the default get response contains `pullRequest.body`. A consumer that needs the latest successfully
synchronized PR body requests it with `comment get --include-pr-body`; only that response adds the
`pullRequest.body` string.

`comment get` returns the same top-level `comment` and `latestPlacement` keys with the complete comment
target and posts, `createdHeadOid`, and the PR's `latestHeadOid`. `latestPlacement` is rvw's
authoritative derived placement at the latest head. Consumers must not treat unequal creation/latest
OIDs as Outdated: rvw accounts for unchanged lines, renames, deletion, and PR-Markdown quoted-text
placement.

`comment get --live` performs a read-only GitHub lookup without updating the SQLite snapshot. Its
`githubState` contains `liveCheckedAt`, `staleAgainstGitHub`, and current live metadata. Without
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
  "relatedCommitOid": null
}
```

`body` is required, non-empty plain UTF-8 text of at most 64 KiB. `authorLabel` and
`relatedCommitOid` are optional and may be null. A non-null related OID must be a 40–64 digit hex
commit available to the PR. Standalone replies are not idempotent; re-read the comment before
retrying an uncertain result.

Resolved threads accept replies. A standalone or synchronized reply does not reopen a resolved
thread; state changes remain explicit. `comment reopen` reopens it, while `comment resolve` or a sync
update with `resolve: true` resolves it.

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
`rvw-ref:<referenceId>` links. Every `diagramBindings` value must name a supplied reference.

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

When a normally launched rvw viewer is running, its process exposes a database-specific Unix socket
with mode `0600` inside a per-user `0700` temporary directory. Agent CLI commands try that socket
first, so writes such as reply, resolve, Walkthrough update,
and repository attachment execute through the already-authorized rvw process instead of requiring the
Agent sandbox to open SQLite for writing. If no socket is available, commands retain the direct local
CLI behavior. That fallback is allowed only before a request is sent. If a sent request times out or
the connection closes without a valid response, the CLI reports an uncertain outcome and does not
repeat a potentially non-idempotent operation. Re-read state before retrying. Multiple viewer
processes may coexist; a follower takes over the shared socket if its current owner exits. CLI stdin
and socket request/response frames are capped at 40 MiB.

The default database directory and file are created with modes `0700` and `0600`. Existing paths are
checked with `stat`; rvw does not chmod them when owner and mode are already safe. A failed chmod on a
new path is tolerated only when the resulting owner and mode are safe. Set `RVW_DATABASE_PATH` to use
an explicitly managed database path; rvw does not chmod existing components of that path. Missing
directory/file components created by rvw use creation modes `0700` / `0600`. The socket request includes this
expected path and is dispatched only when the viewer uses the same database, otherwise the CLI safely
falls back to direct access. `rvw doctor --json` reports the active path, its source, whether rvw
manages its permissions, actual/expected permission metadata and warnings, and installed Skill status.

## Bundled Skills

`rvw skill install codex` and `rvw skill install claude` each install the same two capability-named
Skills: `rvw` for comment handling and synchronization, and `rvw-walkthrough` for publication. The
platform argument selects only the destination Skill root. Neither Skill hardcodes an Agent identity;
the current Agent may supply an accurate optional `authorLabel`.

Each rvw-managed installation records the bundled digest. Status distinguishes a clean older bundle
(`updateAvailable` and `updateRequired`), local customization (`locallyModified`), and a differing
installation with no trustworthy rvw marker (`unmanaged-difference`). None is overwritten without
an explicit forced install.

`rvw-walkthrough` constrains commit identity, code references, diagram bindings, CLI validation,
passive publication and update, and explicit destructive authorization. It deliberately leaves the
explanation's structure and emphasis to the current session and user request.

## Protocol discovery

For a comment whose target is `kind: "walkthrough"`, `rvw comment get` also returns the complete
current `walkthrough` object. This gives the Agent the explanation body and exact code references being
discussed without relying on rendered browser positions. If the Walkthrough is updated, the same
comment URI subsequently returns the updated current object.

`rvw protocol --json` returns `protocolVersion: 1`, the application version, and these capabilities:

```text
comment.list
comment.read
comment.reply
comment.resolve
comment.reopen
pullRequest.sync
walkthrough.read
walkthrough.publish
walkthrough.update
walkthrough.delete
```

Consumers must reject an unsupported protocol version or missing required capability rather than
guessing a fallback command.
