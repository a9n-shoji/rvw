---
name: rvw
description: Create, inspect, address, reply to, edit, resolve, reopen, and synchronize rvw review comments through the local rvw CLI. Use when a request asks an Agent to record review findings in rvw, contains rvw://comment references, asks to handle feedback recorded in rvw, or asks to synchronize rvw after pushed changes. Do not use this Skill to publish implementation walkthroughs; use rvw-walkthrough for that task.
---

# rvw review comments

Use only the `rvw` CLI protocol to access rvw state. Never read or edit the SQLite database directly. Require a local Agent with access to the saved repository. A running rvw viewer can provide database access through its user-only Unix socket; require direct rvw data-directory access only when that route is unavailable. Do not guess comment contents when required access is unavailable.

## Preflight

1. Run `rvw protocol --json` and parse stdout as JSON.
2. Require `protocolVersion` 4, `agent.transport`, and every task capability needed for the task.
   Require `comment.codeReferences` whenever reading or writing typed post references.
3. Run `rvw agent status --json`. Read `socketPath`, `connectionResult`, `selectedDatabasePath`, `selectedTransport`, and `fallbackReason`. If `selectedTransport` is `unavailable`, stop and report the diagnostic; an explicitly configured `RVW_AGENT_SOCKET_PATH` never falls back to direct database access. Otherwise use the reported transport without overriding it.
4. Prefer the CLI's transparent Unix-socket route when a normally launched rvw viewer is running.
   Explain the exact local permission needed only if both the socket route and direct CLI access are
   unavailable. `RVW_DATABASE_PATH` selects an explicitly managed database path; the CLI uses a
   running viewer only when it reports that same database.

## Create comments

Create a new root thread only when the user explicitly asks to record review findings in rvw. Do not
turn an unrelated implementation task into an autonomous review or create a comment merely to narrate
your work. Require the `comment.create` capability and inspect the committed snapshot before writing.

Resolve the registered PR and its cached head without refreshing GitHub by running:

```bash
rvw comment list <PULL_REQUEST> --state all --limit 1 --offset 0 --json
```

Use `pullRequest.localRepositoryPath` to inspect the repository. For a repository target, choose the
exact committed `sourceOid`, repository-relative path, and the narrowest inclusive line range that
supports the finding. Never anchor a comment to uncommitted worktree content. Use a file-level target
when the whole file is the subject and a Pull Request target only when no document is a better anchor.

Create one thread per closed-stdin invocation:

```bash
rvw comment create --stdin --json <<'RVW_JSON'
{
  "review": { "kind": "pull-request", "pullRequest": "https://github.com/owner/repository/pull/123" },
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
RVW_JSON
```

For a whole document, omit both `startLine` and `endLine`; never supply only one. PR-Markdown targets
use `kind: "document"` with `documentKind: "pull-request-markdown"`. Walkthrough targets use
`kind: "walkthrough"` with the current Walkthrough ID. Let rvw derive mutable-document hashes, quoted
text, titles, and the creation head instead of supplying persisted target fields.

Write `body` as concise GFM Markdown when structure improves the finding. Fenced code, tables, task
lists, repository-relative links and images, and Mermaid fences render in rvw. Relative paths on a
repository target start at the target file's directory; other comment targets start at the repository
root. Use only repository paths that exist at the target commit. External images are not fetched.
Use typed references by default whenever a post makes a concrete claim about committed code and
opening the exact evidence would help the reviewer verify it. Apply this to findings, investigation
results, implemented changes, and relevant tests. Link the smallest useful range from the body as
`rvw-ref:<referenceId>`, set `relatedCommitOid` to the one exact commit containing every referenced
path, and supply the post's complete `references` array. A repository comment target already opens its
exact source; do not duplicate that target unless a separately labeled range adds navigation value.
Omit references only when the post has no useful code evidence, the evidence is not committed, or a
reference would merely repeat the target without helping the reviewer navigate.

Use unique IDs, repository-relative paths, and either both inclusive line endpoints or neither for a
file-level reference. Include a signature and the relevant body instead of pointing only at the first
line of a multi-line behavior. Every declaration must be linked from that body, and every link must be
declared. References do not carry across a thread. Let rvw validate and retain the commit; never point
at uncommitted code. Comment Mermaid remains display-only and has no node bindings.

Set `authorLabel` to an accurate current Agent name when known; otherwise omit it. Creation is not
idempotent. After an uncertain failure, page through unresolved comments, fetch plausible candidates
with `comment get`, and compare the complete root body and exact target before retrying. Report every
created `rvw://comment/<uuid>` reference to the user.

## Manage Issue documents

Add or remove an Issue membership only when the user explicitly requests that review-level change.
Issue membership is independent for each Pull Request Review and Branch Review; never copy or remove
the same Issue in another review. Add with `rvw pr issue add` or `rvw branch issue add`.

Removal is destructive because Issue-target RVW comments and replies owned by that review are deleted
with the membership. First run `rvw pr issue remove ... --json` or
`rvw branch issue remove ... --json` without `--yes`, report the returned Issue number/title and whole,
range, and reply counts, and stop unless the human explicitly authorizes those exact deletions. Only
then repeat with `--yes`. These commands never edit or close the GitHub Issue itself.

A Branch Review stays bound to one Git common directory. Another worktree from that same clone may
reuse it and become the current local path. An independent clone of the same canonical GitHub
repository is rejected rather than silently replacing the saved path and retained-object store. To
use that independent clone, first obtain explicit authorization for the destructive Branch Review
reset, inspect its deletion preview, reset it, and then open the Branch Review from the new clone.
The local GitHub remote must also match the saved canonical repository. A remote change, repository
rename, or organization transfer is not followed automatically; use the same explicit reset/recreate
boundary from the original binding. Do not retry a `REPOSITORY_MISMATCH` as a sync failure.

Branch reset and Issue-removal previews/execution, `branch comments`, and `branch sync` are
existing-only. `BRANCH_REVIEW_NOT_FOUND` means they created no review row or retained ref. Only
`branch open` and an explicit `branch issue add` may create the singleton. Branch evidence belongs to
the returned Branch Review ID, not only to owner/repository. If reset reports that SQLite deletion
succeeded but review-owned refs remain, report the orphan prefix and repair details; creating a new
review neither cleans nor inherits those refs.

## Read comments

When the user asks for unresolved feedback without supplying individual comment references, run:

```bash
rvw comment list <PULL_REQUEST> --state unresolved --limit 50 --offset 0 --json
```

For one Branch Review, discover comments with:

```bash
rvw branch comments --repository <PATH> --state unresolved --json
```

The default state is `unresolved`; use `--state resolved` or `--state all` only when the request needs
those threads. Require the `comment.list` capability before discovery. Continue with
`--offset <nextOffset>` while the page has `hasMore: true`; never assume the first page is complete.
Each item contains a bounded root-post preview, post count, target summary, and service-derived
`latestPlacement`, but omits replies, exact target evidence, and source excerpts. Run `comment get`
for every listed thread that you will inspect or address; never act from the preview alone. Collect
the URIs from every page before replying, resolving, or reopening because those writes can reorder or
remove entries from later offset pages.

Run the following for every supplied `rvw://comment/<uuid>` reference:

```bash
rvw comment get <COMMENT_URI> --json
```

Use `pullRequest.localRepositoryPath` as the repository to inspect or modify. Read the latest PR title,
base/head branch names and OIDs, the exact target, all posts, `createdHeadOid`, `latestHeadOid`,
`latestPlacement`, and `exactSource` before deciding what the comment requests. The default response
omits `pullRequest.body`. Group the fetched comments by Pull Request. If any comment in a group targets
the PR or PR Markdown, or any thread in that group cannot be understood without PR-level intent, rerun
`comment get` for exactly one representative URI in that group with `--include-pr-body`. Reuse that
latest successfully synchronized body for every comment from the same Pull Request; never request the
same PR body once per comment. When supplied references span multiple Pull Requests, fetch the body at
most once for each group that needs it. `latestPlacement` is rvw's authoritative derived placement at
the latest head; never infer Outdated by comparing OIDs.

When `comment get` returns `context.kind: "branch"`, use the canonical `context.repository`,
`branchReview.localRepositoryPath`, `defaultBranchName`, `currentSourceOid`, the comment's
`createdSourceOid`, target kind, and `latestPlacement`. Branch Review comment
access authorizes investigation and an RVW reply only: do not edit code, commit, push, create a Pull
Request, synchronize a PR, change the default branch, or update/close/reopen a GitHub Issue. Read the
returned exact source, current Walkthrough, or Issue body as applicable. For an Issue target, compare
the returned current body hash with the target's creation hash only as evidence; treat
`latestPlacement.outdated` as authoritative and retain the exact quote/range in the investigation.
Branch replies
are never auto-resolved.

Create Branch Review comments with an explicit review context such as
`{"review":{"kind":"branch","repository":"owner/repository"},"target":{"kind":"branch"},
"body":"Investigation question"}`. Issue targets use `kind: "issue"` and an `issue` reference such
as `#142`; they never write to GitHub Issue discussion or metadata.

For every post, read its own `relatedCommitOid` and `references`. Treat each `rvw-ref:` declaration as
evidence at that exact post commit, not as a target that moves with the thread or latest head.

When the task needs to distinguish the cached snapshot from current GitHub state, use
`rvw comment get <COMMENT_URI> --live --json`. Read `githubState.staleAgainstGitHub` and live metadata;
this lookup is read-only and does not make the cached PR current. Without `--live`, null live fields mean
GitHub was not checked.

- For a repository-file target, inspect its recorded source OID and path even when it is Outdated.
  `exactSource.excerpt` contains the selected lines with bounded context when available, and its
  truncation fields say whether more of the exact document must be read from the repository. Treat the
  excerpt as an entry point, not a substitute for inspecting relevant surrounding code.
  `exactSource.availability` is exactly `available`, `binary`, `too-large`, or `missing`; only
  `available` has a non-null excerpt.
- For a PR-Markdown target, combine its quoted text with the latest `Pull Request.md`; request that
  body through the group's single representative `comment get <COMMENT_URI> --include-pr-body --json`
  call if it has not already been loaded. rvw does not retain the complete historical PR body; never
  treat `createdHeadOid` as a PR-body revision.
- For a Walkthrough target, read the complete current `walkthrough` object returned by `comment get`, including its body, source OID, diagram bindings, and code references. Whole-document comments remain attached when that Walkthrough is updated in place.

## Address comments

1. Confirm the authorized scope from the prompt and comment thread.
2. Inspect the current worktree and relevant surrounding code. Preserve unrelated user changes.
3. Implement only authorized changes and run proportionate tests.
4. Reply with concrete findings when no code change is needed.
5. Resolve only when the user requested resolution or the thread is demonstrably satisfied. A reply alone does not resolve a thread.

When feedback asks to improve the explanation rather than the code, use the `rvw-walkthrough` Skill to update the same Walkthrough URI after understanding the full thread. Do not publish a duplicate as an implicit version. Return to this Skill for any authorized reply or resolution.

Every `--stdin` command reads until EOF before parsing JSON. Supply the complete object and close stdin in the same non-interactive invocation. Prefer an execution API that accepts stdin and closes it after writing; in a shell, use a quoted heredoc. Never start the command in an interactive PTY and send only JSON plus a newline because a newline is not EOF.

To add a standalone reply, use one closed-stdin invocation:

```bash
rvw comment reply '<COMMENT_URI>' --stdin --json <<'RVW_JSON'
{
  "body": "The guard now returns the validated failure from [the request boundary](rvw-ref:guard), with [a regression test](rvw-ref:test).",
  "authorLabel": "Agent name",
  "relatedCommitOid": "0123456789abcdef0123456789abcdef01234567",
  "references": [
    {
      "id": "guard",
      "label": "Request validation guard",
      "path": "src/request-handler.ts",
      "startLine": 18,
      "endLine": 24
    },
    {
      "id": "test",
      "label": "Failure regression test",
      "path": "test/request-handler.test.ts",
      "startLine": 41,
      "endLine": 55
    }
  ],
  "idempotencyKey": "task-stable-key-for-this-exact-reply"
}
RVW_JSON
```

Set `authorLabel` to an accurate current Agent name when known; otherwise omit it. `idempotencyKey` is
optional for ordinary interactive work and required for automated or resumable workflows. Reuse a key
only for the same comment and exact caller payload. If the original post was deleted, retry fails
without recreating it. Without a key, an uncertain failure still requires re-reading the comment before
retrying to avoid a duplicate reply.

Before posting a code-related outcome, identify the exact committed evidence and apply the typed
reference defaults above. Set a non-null `relatedCommitOid` and send that reply's complete
`references` array. References are part of the idempotent payload. A conclusion about intent,
permissions, unavailable evidence, or another non-code subject may omit them.

To replace a post whose ID you obtained from rvw, require `comment.edit` and use:

```bash
rvw comment edit '<COMMENT_URI>' --post '<POST_ID>' --stdin --json <<'RVW_JSON'
{
  "body": "✅ 対応しました\n\nChange and validation summary.",
  "relatedCommitOid": "0123456789abcdef0123456789abcdef01234567"
}
RVW_JSON
```

This is an exact replacement, so retrying the same edit after an uncertain transport result is safe.
Omit `relatedCommitOid` to preserve the current association, pass null to clear it, or pass an
available PR commit to replace it. Edit only a post the current task was explicitly authorized to
change; automated watchers must use the status post ID recorded in their task-local state.
Omit `references` to preserve the current set; otherwise send the complete replacement set. Ensure the
replacement body uses every retained reference. To clear a related commit, also remove its links and
send `references: []`.

A resolved thread accepts replies, and replying does not reopen it. Likewise, a `pr sync` reply leaves
the current state unchanged unless its update has `resolve: true`. Use `comment reopen` as a separate,
explicit state change when the user requests reopening; never assume that a reply changed the state.

Use `rvw comment resolve <COMMENT_URI> --json` and `rvw comment reopen <COMMENT_URI> --json` for explicit state changes.

## Synchronize pushed changes

Synchronize only GitHub-visible state. Complete authorized code changes, tests, commit, push, and any required PR title or body update first. Never represent uncommitted or unpushed local changes as synchronized state.

Pass one JSON object and close stdin in the same invocation:

```bash
rvw pr sync --stdin --json <<'RVW_JSON'
{
  "pullRequest": "https://github.com/owner/repo/pull/123",
  "commentUpdates": [
    {
      "commentRef": "rvw://comment/uuid",
      "reply": "The pushed commit handles [the missing failure branch](rvw-ref:result) and covers it in [the regression test](rvw-ref:test).",
      "resolve": false,
      "references": [
        {
          "id": "result",
          "label": "Failure branch",
          "path": "src/request-handler.ts",
          "startLine": 18,
          "endLine": 24
        },
        {
          "id": "test",
          "label": "Failure regression test",
          "path": "test/request-handler.test.ts",
          "startLine": 41,
          "endLine": 55
        }
      ],
      "idempotencyKey": "task-stable-key-for-this-exact-update"
    }
  ]
}
RVW_JSON
```

Prefer this atomic path when the GitHub refresh and comment updates belong to the same operation.
Successful replies are linked to the synchronized head commit. Give each automated or resumable
update a stable `idempotencyKey`; an exact retry returns the existing reply. Without keys, re-read
affected comments before retrying an uncertain result. A later GitHub head advance does not change the
identity of the original caller payload.

Apply the same code-evidence default to synchronized replies. Include `rvw-ref:` links and the complete
`references` array whenever the reply makes concrete claims about the pushed implementation or tests;
omit `relatedCommitOid` because rvw validates and fixes those references to the synchronized GitHub
head. Do not attach references when `reply` is blank.

If the saved checkout is dirty but a clean worktree in the same Git common directory exists, pass
`--repository <PATH>`. Inspect every reported dirty entry before deciding whether untracked files are
irrelevant; only then may you explicitly pass `--allow-untracked`. Never use that option to ignore
tracked changes. A clean local PR branch that is merely behind GitHub is acceptable and rvw will not
move its checkout. To change only the saved worktree path without starting a viewer, use
`rvw pr attach <PULL_REQUEST> --repository <PATH> --json`.

If rvw reports `LOCAL_STATE_INCONSISTENT`, report its reset guidance and deletion counts. Never run `rvw pr reset ... --yes` without explicit authorization because it permanently removes local comments, Walkthroughs, and retained rvw refs.
