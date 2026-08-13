---
name: rvw
description: Inspect, address, reply to, resolve, reopen, and synchronize rvw review comments through the local rvw CLI. Use when a request contains rvw://comment references, asks to handle feedback recorded in rvw, or asks to synchronize rvw after pushed changes. Do not use this Skill to publish implementation walkthroughs; use rvw-walkthrough for that task.
---

# rvw review comments

Use only the `rvw` CLI protocol to access rvw state. Never read or edit the SQLite database directly. Require a local Agent with access to the saved repository. A running rvw viewer can provide database access through its user-only Unix socket; require direct rvw data-directory access only when that route is unavailable. Do not guess comment contents when required access is unavailable.

## Preflight

1. Run `rvw protocol --json` and parse stdout as JSON.
2. Require `protocolVersion` 2, `agent.transport`, and every task capability needed for the task.
3. Run `rvw agent status --json`. Read `socketPath`, `connectionResult`, `selectedDatabasePath`, `selectedTransport`, and `fallbackReason`. If `selectedTransport` is `unavailable`, stop and report the diagnostic; an explicitly configured `RVW_AGENT_SOCKET_PATH` never falls back to direct database access. Otherwise use the reported transport without overriding it.
4. Prefer the CLI's transparent Unix-socket route when a normally launched rvw viewer is running.
   Explain the exact local permission needed only if both the socket route and direct CLI access are
   unavailable. `RVW_DATABASE_PATH` selects an explicitly managed database path; the CLI uses a
   running viewer only when it reports that same database.

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
omits `pullRequest.body`. Group the fetched comments by Pull Request. If any comment in a group targets
the PR or PR Markdown, or any thread in that group cannot be understood without PR-level intent, rerun
`comment get` for exactly one representative URI in that group with `--include-pr-body`. Reuse that
latest successfully synchronized body for every comment from the same Pull Request; never request the
same PR body once per comment. When supplied references span multiple Pull Requests, fetch the body at
most once for each group that needs it. `latestPlacement` is rvw's authoritative derived placement at
the latest head; never infer Outdated by comparing OIDs.

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
  "body": "Investigation result or completed change",
  "authorLabel": "Agent name",
  "relatedCommitOid": null
}
RVW_JSON
```

Set `authorLabel` to an accurate current Agent name when known; otherwise omit it. This command is not idempotent. After an uncertain failure, re-read the comment before retrying to avoid a duplicate reply.

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
      "reply": "Change included in the pushed commit",
      "resolve": false
    }
  ]
}
RVW_JSON
```

Prefer this atomic path when the GitHub refresh and comment updates belong to the same operation. Successful replies are linked to the synchronized head commit. The command is not idempotent when it adds replies; re-read affected comments before retrying an uncertain result.

If the saved checkout is dirty but a clean worktree in the same Git common directory exists, pass
`--repository <PATH>`. Inspect every reported dirty entry before deciding whether untracked files are
irrelevant; only then may you explicitly pass `--allow-untracked`. Never use that option to ignore
tracked changes. A clean local PR branch that is merely behind GitHub is acceptable and rvw will not
move its checkout. To change only the saved worktree path without starting a viewer, use
`rvw pr attach <PULL_REQUEST> --repository <PATH> --json`.

If rvw reports `LOCAL_STATE_INCONSISTENT`, report its reset guidance and deletion counts. Never run `rvw pr reset ... --yes` without explicit authorization because it permanently removes local comments, Walkthroughs, and retained rvw refs.
