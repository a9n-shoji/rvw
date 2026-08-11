---
name: rvw
description: Inspect, address, reply to, resolve, reopen, and synchronize rvw review comments through the local rvw CLI. Use when a request contains rvw://comment references, asks to handle feedback recorded in rvw, or asks to synchronize rvw after pushed changes. Do not use this Skill to publish implementation walkthroughs; use rvw-walkthrough for that task.
---

# rvw review comments

Use only the `rvw` CLI protocol to access rvw state. Never read or edit the SQLite database directly. Require a local Agent with access to the saved repository and rvw data directory; do not guess comment contents when either is unavailable.

## Preflight

1. Run `rvw protocol --json` and parse stdout as JSON.
2. Require `protocolVersion` 1 and every capability needed for the task.
3. Explain the exact local permission needed if the CLI, repository, or rvw data directory is blocked.

## Read comments

When the user asks for unresolved feedback without supplying individual comment references, run:

```bash
rvw comment list <PULL_REQUEST> --state unresolved --limit 50 --offset 0 --json
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
omits `pullRequest.body`. If the comment targets the PR or PR Markdown, or the thread cannot be
understood without PR-level intent, rerun `comment get` with `--include-pr-body` and read the latest
successfully synchronized body. `latestPlacement` is rvw's authoritative derived placement at the
latest head; never infer Outdated by comparing OIDs.

- For a repository-file target, inspect its recorded source OID and path even when it is Outdated.
  `exactSource.excerpt` contains the selected lines with bounded context when available, and its
  truncation fields say whether more of the exact document must be read from the repository. Treat the
  excerpt as an entry point, not a substitute for inspecting relevant surrounding code.
  `exactSource.availability` is exactly `available`, `binary`, `too-large`, or `missing`; only
  `available` has a non-null excerpt.
- For a PR-Markdown target, combine its quoted text with the latest `Pull Request.md`; request that
  body with `comment get <COMMENT_URI> --include-pr-body --json`. rvw does not retain the complete
  historical PR body; never treat `createdHeadOid` as a PR-body revision.
- For a Walkthrough target, read the complete current `walkthrough` object returned by `comment get`, including its body, source OID, diagram bindings, and code references. Whole-document comments remain attached when that Walkthrough is updated in place.

## Address comments

1. Confirm the authorized scope from the prompt and comment thread.
2. Inspect the current worktree and relevant surrounding code. Preserve unrelated user changes.
3. Implement only authorized changes and run proportionate tests.
4. Reply with concrete findings when no code change is needed.
5. Resolve only when the user requested resolution or the thread is demonstrably satisfied. A reply alone does not resolve a thread.

When feedback asks to improve the explanation rather than the code, use the `rvw-walkthrough` Skill to update the same Walkthrough URI after understanding the full thread. Do not publish a duplicate as an implicit version. Return to this Skill for any authorized reply or resolution.

To add a standalone reply, pass one JSON object through stdin:

```json
{
  "body": "Investigation result or completed change",
  "authorLabel": "Agent name",
  "relatedCommitOid": null
}
```

Run `rvw comment reply <COMMENT_URI> --stdin --json`. Set `authorLabel` to an accurate current Agent name when known; otherwise omit it. This command is not idempotent. After an uncertain failure, re-read the comment before retrying to avoid a duplicate reply.

A resolved thread accepts replies, and replying does not reopen it. Likewise, a `pr sync` reply leaves
the current state unchanged unless its update has `resolve: true`. Use `comment reopen` as a separate,
explicit state change when the user requests reopening; never assume that a reply changed the state.

Use `rvw comment resolve <COMMENT_URI> --json` and `rvw comment reopen <COMMENT_URI> --json` for explicit state changes.

## Synchronize pushed changes

Synchronize only GitHub-visible state. Complete authorized code changes, tests, commit, push, and any required PR title or body update first. Never represent uncommitted or unpushed local changes as synchronized state.

Pass one JSON object through stdin:

```json
{
  "pullRequest": "https://github.com/owner/repo/pull/123",
  "commentUpdates": [
    {
      "commentRef": "rvw://comment/uuid",
      "reply": "Change included in the pushed commit",
      "resolve": false
    }
  ]
}
```

Run `rvw pr sync --stdin --json`. Prefer this atomic path when the GitHub refresh and comment updates belong to the same operation. Successful replies are linked to the synchronized head commit. The command is not idempotent when it adds replies; re-read affected comments before retrying an uncertain result.

If rvw reports `LOCAL_STATE_INCONSISTENT`, report its reset guidance and deletion counts. Never run `rvw pr reset ... --yes` without explicit authorization because it permanently removes local comments, Walkthroughs, and retained rvw refs.
