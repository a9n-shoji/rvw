# Architecture

rvw is a human reading environment for a software repository. A Pull Request Review reads the exact
PR head and its commit range; a Repository Review reads the exact current head of the repository's GitHub
default branch. Pull Request metadata and explicitly registered GitHub Issue documents explain intent.
Diffs remain derived lenses, and changed files do not limit which repository documents can be opened,
searched, or commented on.

rvw is a local Node.js application with four boundaries:

- `domain`: pure commit/document, shared code-reference, comment, Walkthrough, and line-mapping rules.
- `application`: use cases shared by HTTP and CLI transports.
- `infrastructure`: SQLite, Git, GitHub CLI, filesystem, and subprocess adapters.
- `server`, `cli`, and `web`: transport and presentation only.

The SQLite database is user-global. One Repository Review is keyed by canonical GitHub repository,
independent from every Pull Request Review. Issue cache rows are shared by GitHub identity while
memberships and Issue-target comments belong to exactly one review. Observed PR heads and Repository Review
Review sources are retained by `refs/rvw/...` in the base repository's common Git directory.
Comments, replies, and Walkthroughs retain their exact source before the SQLite write. A failed artifact
write does not compensate that ref: PR/OID and Repository Review/OID refs are shared evidence, and the
process that created a ref cannot know that a concurrent successful artifact has not begun relying on
it. Unreferenced refs remain diagnostic data until a future explicit, exclusive GC.
The saved Git common directory and aggregate-owned current source ref are the local Repository Review binding. Every
path-based use case compares that common directory and, when available, the canonical identity parsed
from local GitHub remotes with the saved identity before any GitHub request, fetch, location update, or
mutation. Worktrees in that common directory may reuse the review, but an independent clone, a changed
canonical remote, or a replacement repository at the saved path fails closed instead of moving the
binding. Repository rename and transfer are not followed automatically; an explicit Repository Review reset at
the original binding is the boundary for recreating the aggregate. Worktree and common-directory paths
are filesystem-realpath canonicalized. Legacy saved path spellings are upgraded to realpaths on a
verified cached open. One ordered resolver chooses the GitHub remote (`origin`, then name order) for
both display and fetch, and exposes it through open, the viewer header, and doctor. Doctor classifies
40-64 digit Repository Review refs as current, artifact-referenced, unreferenced, or orphan without mutating them. The
Issue removal transaction deletes only the selected membership and its owned comments/replies.
Issue-target Comment creation performs the display/range checks in the application layer, then
rechecks that the same Review still owns the membership inside the Comment insertion transaction.
Removing a membership between those boundaries therefore wins with `ISSUE_NOT_FOUND`; the shared
cache remaining for another Review is never sufficient authorization to create the late Comment.
Background Issue refresh is separate from membership addition: after the GitHub fetch, one immediate
transaction rechecks the originating review and membership, updates only an existing shared cache row,
and cannot reinsert a membership removed while the request was in flight. Sync-error writes use the
same review-scoped guard and persist on that membership rather than the shared content row, so a
deleted review cannot make a replacement or another owner stale.
Repository Review reset deletes Repository Review comments, Walkthroughs, memberships, and the singleton review before
releasing only its `refs/rvw/repository/<repositoryReviewId>/...` namespace; PR refs and another Repository Review ID
are outside that deletion boundary, while now-unowned Issue cache rows are transactionally collected.
If ref deletion fails after DB deletion, a typed partial-success outcome reports both outcomes and the
orphan prefix. A replacement review gets a new ID, so it cannot
read or delete the orphan evidence. The browser polls the active review's
`app_meta.review_change_sequence:<kind>:<id>` value; the database-wide sequence remains a diagnostic
and compatibility counter, not the content invalidation boundary. Walkthrough invalidation uses the
exact review prefix `['walkthrough', kind, reviewId]`, which covers both summaries and all active
details without remounting pane state. There is no
persistent daemon or agent session coupling. While a viewer process is running, it exposes a
user/database-specific Unix socket inside a `0700` temporary directory as an alternate transport for
the same application service. Agent
CLI operations prefer that socket and fall back to direct local execution only before a request has
been sent and only when no socket path was explicitly configured. `RVW_AGENT_SOCKET_PATH` is
fail-closed: an unavailable or database-mismatched configured socket never falls back to SQLite. A
sent operation with an unknown outcome is never automatically repeated. Concurrent viewers for one
database acquire an atomic filesystem owner lock before listening, so one socket name is held by one
Node process; a follower takes over only after that owner exits. Transport diagnostics report the
socket, connection, database identity, selected transport, and fallback reason. Doctor also executes
a rollback-only write transaction instead of inferring writeability from Unix modes.

`RepositoryReviewLifecycle` is the application boundary shared by CLI, HTTP, and Agent socket. It separates
open-or-create from discriminated read, synchronize, and destructive resolution policies; only reset's
destructive policy can admit a missing initial ref. Only
`repository open` and the explicit Issue-add operation may create a Repository Review. Reset, Issue removal,
comments, and synchronization require an existing aggregate; preview failures are read-only. Matching
local binding plus a network-only GitHub failure preserves cached reads. If no GitHub remote can be
resolved, cached reads and local cleanup remain available when the common directory and owned ref
still prove the binding, while synchronization and Issue addition are rejected.

On a verified remote-less cached open, the lifecycle may move `localRepositoryPath` to the current
worktree in that common directory; existing-only previews use the resolved worktree without persisting
that move. HTTP routes whose URL contains a Repository Review ID keep that expected ID through application
resolution and the final SQLite transaction. Deleting and recreating a review at the same path therefore
produces `REPOSITORY_REVIEW_NOT_FOUND` for the stale request instead of mutating the replacement.

The first aggregate insert records `initialization_state = pending` before creating its owned ref;
this lifecycle state is separate from `source_sync_error`. A crash before ref creation can therefore be
recovered by explicit Repository Review reset when the binding matches and the review namespace has no refs. A
crash after ref creation but before ready publication is completed by the next cached open after
verifying the owned ref and Git object. Normal reads wait only for the exact pending state, for at most
five seconds; a failed or otherwise unowned source
fails immediately. Initialization is create-only: when its immediate
transaction discovers a concurrently created row, it returns that row unchanged. The caller verifies
the winner's owned source, discards metadata fetched before discovering that aggregate, allocates a
generation, and only then fetches a fresh snapshot for retain-before-publish. If reset wins while initial ref creation is paused, a
later completion failure removes only the exact ref created by that attempt on a best-effort basis.
Once another opener has moved initialization to `ready`, a delayed completion is idempotent even if
the aggregate source has advanced. Exact ref creation uses Git compare-and-swap so only one concurrent
creator reports ownership. Compensation removes that ref only when the aggregate ID no longer exists;
a source mismatch alone never deletes historical evidence that comments or walkthroughs may reference.
Every existing-source attempt allocates a monotonically increasing generation before network access.
Only that generation may publish its retained OID or sync error, so an older response cannot roll back
a newer success. A default branch that moves between repository metadata and fetch is retried once as
a remote snapshot race, not reported as local-state corruption.
GitHub Issue responses are checked in both the concrete client and application boundary;
owner, repository, number, canonical name, and URL mismatch fail before cache or membership writes.
The shared cache accepts only a non-decreasing GitHub `updatedAt`; equal versions with conflicting
title/body/state fail closed. Every accepted success increments an internal cache generation, even
when wall-clock timestamps are equal; a failure may mark only its originating membership stale when
the cache generation is still current. The last membership removal collects the now-unowned shared row;
an explicit force refresh repairs an owned equal-version conflict only after two matching GitHub reads
and only while the cache generation captured before those reads remains current.
PR and Repository Review sync return per-Issue failures separately; both viewers
report a warning alongside the successfully synchronized review source instead of presenting the
entire operation as clean, limiting the top-bar detail to three Issues plus the remaining count.
A fetch failure whose originating membership was already removed is a skip, not a stale warning.
Shared Issue getters expose only cached content; membership-aware getters add `syncError` and `stale`.
Comment context reads use the owning membership, and successful `issuesToAdd` ensure operations clear
that membership's previous error without pretending it was newly added.
Destructive previews carry the active review sequence and a content-bound confirmation token. Reset,
Issue removal, and Walkthrough deletion recheck that sequence in their SQLite mutation; stale previews
return 409 with the current preview even when the final transaction, rather than the preceding service
check, detects the conflict. The rebuilt Repository Review preview rereads the current aggregate row as well as
its sequence, counts, and refs. PR reset non-destructively ensures the latest head ref and reads the
replacement commit list before its destructive SQLite transaction, then clears SQLite-owned artifacts
with that CAS and performs no fallible Git reads after it. It preserves all historical PR refs. Physical PR-ref reclamation requires a
future explicit exclusive GC; reset never races a Comment or Walkthrough writer by deleting evidence.
When browser reset succeeds
but the following open fails, the viewer reports reset as complete and
gives an explicit `rvw repository open` recovery action instead of presenting the reset itself as failed.
The same deleted-review state is used when ref cleanup returns a partial-success orphan outcome.

The viewer reads committed Git objects rather than the worktree or index. That keeps the human's
reading context stable while an external Agent edits, tests, commits, and pushes. Comments bridge the
two processes through stable references and the JSON CLI protocol: an authorized Agent can create an
ordinary unresolved thread or act on an existing one through the same application validation used by
the browser. Post bodies remain UTF-8 Markdown source in SQLite and render as sanitized GFM with soft
line breaks, repository-relative links and images, and strict display-only Mermaid diagrams. Link and
image resolution uses the post's related commit, repository target, current Walkthrough source, or
thread creation head in that order. A post may additionally own validated `rvw-ref:` links backed by
typed paths and optional line ranges at its exact related commit. Comment Markdown still has neither
source-position targets nor Mermaid-node bindings. Walkthroughs reuse the same code-reference model
and renderer while adding their document mapping and diagram bindings. Browser state, prompts, and
Agent sessions never enter the domain model.

New root posts and replies also append a database-wide event sequence with an explicit Pull Request or
Repository Review context. Routing uses the stable local Pull Request / Repository Review ID; the GitHub URL or
canonical repository remains a separate display value. A reset-and-recreate therefore starts a new
Repository Review context even when its repository text is identical, while casing changes cannot split one
context. When the first protocol-v4 PR event opens a v3 task database, legacy URL-keyed rows for that
same URL are transactionally re-keyed to the actual PR UUID; pending batches merge, while conflicting
in-flight leases are quarantined rather than double-claimed. If restart claims a legacy pending lease
before another event arrives, auto-ack derives the stable UUID from membership-aware `comment get` results
and transactionally re-keys the active lease before posting acknowledgements or exposing it to a worker.
A long-running external Agent
task may consume that sequence with an opaque database-scoped cursor through `rvw comment watch`.
rvw retains minimal event identifiers independently of deletable posts and owns only ordering and
replay. The bundled Skill's task-local state script atomically owns its cursor, queue, leases, retries,
per-batch status posts, self-event suppression, and repository-writer serialization. After claim, the
task creates one immediate acknowledgement per affected thread and later edits that same normal post
to the final outcome. A retry of that batch restores its acknowledgement, while a later batch for the
same thread creates a new post and preserves the earlier outcome. Repository Review batches are always
read-only investigation: they receive one final idempotent reply, never reserve a repository write key,
and never auto-resolve. Their worker result carries an explicit Repository Review context, not a fabricated Pull
Request URL. The final reply uses the operation's stable idempotency key; its returned post ID is stored
as a durable suppression before the lease completes. Completion also marks an already-ingested pending
self-event completed, so either ingest ordering and a retry after process restart avoid a new batch.
The parent reserves subagent capacity
before intake; the driver caps in-flight claims to that capacity and polls task state to drain same-PR
follow-ups after lease release and retries after their due time. Every acknowledged lease is handed to
one fresh subagent immediately, while the parent retains only intake, state, and final-post ownership.
Separate tasks may consume the same log with separate state. This terminal-bound consumer is not a daemon
and rvw never starts it. A durable database-wide reply-idempotency ledger shared by PR and Repository Review posts
makes an exact caller-payload retry safe without introducing Agent session identity into comments.
Reusing a public key for another review kind or payload is a conflict.

Walkthroughs cross the same one-way CLI boundary in the other direction. An Agent can publish a
Markdown explanation to a Pull Request or Repository Review, fixed to one commit with validated file
references and optional inclusive line ranges, plus optional Mermaid-node bindings. A publish or
update may explicitly add up to 50 same-repository Issues through the addition-only `issuesToAdd` field
without creating a semantic relation. Each reference is limited to 256 characters; Repository Review
requests require a verified canonical remote before Issue fetches begin. SQLite stores
one current explanation per stable Walkthrough
ID without revision history. The CLI can read and replace that value in place; the HTTP API remains read-only except for a
human-confirmed delete action. Whole-document comments keep targeting the stable ID across updates. Rendered
Markdown text selection maps parser source positions to inclusive source-line comments; those comments retain a
document hash and exact quote, re-anchor only on a unique current match, and otherwise appear Outdated. Mermaid
feedback targets the complete source fence rather than generated SVG nodes. Deletion removes the Walkthrough and
its attached feedback together. Publication and update do not
include viewer state and cannot navigate a browser. The React viewer treats a
Walkthrough as another document tab, and only a human action opens the referenced exact Git document.
Inline references and bound Mermaid nodes remain interactive, but the viewer does not duplicate the
complete reference set in a side or bottom index.
Publish and update return an enumerable application result envelope containing the saved Walkthrough
and an explicit `issuesAdded` array populated from membership rows actually inserted in the same
transaction. The CLI serializes the same envelope whether it calls the service directly or through the
Agent socket.
The browser owns an ephemeral two-pane workspace: every document identity may appear once per pane, tabs
can move between panes, ordinary document-opening clicks target the left pane, and modifier-click targets
the right pane regardless of focus or origin. Pane placement never enters SQLite or the Agent protocol. Repository Markdown uses
the same exact Git document fetch and can switch locally between source and a safe rendered preview.
The preview preserves native browser text selection while translating parser positions back to source line ranges;
it never persists DOM or layout coordinates.
The selection boundary resolves to the smallest mapped Markdown leaf, and its composer is portaled
into a stable imperative host in normal document flow immediately after the selected block so wrapped
text is never covered. Issue document identity excludes the Repository Review source OID: refreshes replace query
data without remounting the composer. Drafts record the Issue body hash; a changed body preserves text
and focus but blocks the old range until the human selects a range in the current body. Persisted
whole-Issue comments remain current across body updates because they target the stable Issue identity;
persisted range comments become Outdated when that body hash changes.
Removing an Issue membership invalidates only that Issue's composer generation and deleted threads'
reply drafts, so a late unmount cannot resurrect them and unrelated document drafts remain available.
Relative preview and comment images are fetched from their resolved exact commit through a size-limited
read-only endpoint. PR Markdown, Walkthrough bodies, external image URLs, and paths that cannot be resolved inside the repository
render as non-fetching placeholders. Same-origin SVG asset responses carry a restrictive Content Security
Policy and sandbox so direct navigation cannot execute repository-controlled script under the viewer origin.

The bundled Skills are named by capability rather than Agent host. `rvw` handles review comments and
synchronization and read-only Repository Review investigation; `rvw-walkthrough` converts the current session's explanation into a validated,
commit-fixed publication without prescribing its document structure; `rvw-watch-comments` keeps an
external Agent task subscribed to newly created posts. It fails closed on PR ownership before any
authorized fix-and-push, and categorically disables remote writes for Repository Reviews. Codex and Claude Code receive
the same Skill directories under their respective local Skill roots. Platform selection is a packaging
concern only and does not fork the Agent protocol or workflow instructions. Installer metadata records
the bundled digest so update availability and local customization are reported separately.

Each automatically opened browser document attaches an ephemeral viewer ID to that poll. The
per-viewer worker uses those IDs only to stop its HTTP listener after the final tab closes; they are
never persisted and are not part of review state or the agent CLI protocol. By default, the parent
`rvw open` process starts that worker in the background, opens the browser after the worker reports
readiness, waits for the first viewer heartbeat, and then returns control to the terminal. This is a
browser-owned worker rather than a persistent daemon. `--foreground` and `--no-open` remain
terminal-signal managed.
