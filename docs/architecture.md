# Architecture

rvw is a human reading environment for a software repository. A Pull Request Review reads the exact
PR head and its commit range; a Branch Review reads the exact current head of the repository's GitHub
default branch. Pull Request metadata and explicitly registered GitHub Issue documents explain intent.
Diffs remain derived lenses, and changed files do not limit which repository documents can be opened,
searched, or commented on.

rvw is a local Node.js application with four boundaries:

- `domain`: pure commit/document, shared code-reference, comment, Walkthrough, and line-mapping rules.
- `application`: use cases shared by HTTP and CLI transports.
- `infrastructure`: SQLite, Git, GitHub CLI, filesystem, and subprocess adapters.
- `server`, `cli`, and `web`: transport and presentation only.

The SQLite database is user-global. One Branch Review is keyed by canonical GitHub repository,
independent from every Pull Request Review. Issue cache rows are shared by GitHub identity while
memberships and Issue-target comments belong to exactly one review. Observed PR heads and Branch
Review sources are retained by `refs/rvw/...` in the base repository's common Git directory. The
saved Git common directory and aggregate-owned current source ref are the local Branch binding. Every
path-based use case compares that common directory and, when available, the canonical identity parsed
from local GitHub remotes with the saved identity before any GitHub request, fetch, location update, or
mutation. Worktrees in that common directory may reuse the review, but an independent clone, a changed
canonical remote, or a replacement repository at the saved path fails closed instead of moving the
binding. Repository rename and transfer are not followed automatically; an explicit Branch reset at
the original binding is the boundary for recreating the aggregate. The
Issue removal transaction deletes only the selected membership and its owned comments/replies.
Branch reset deletes Branch comments, Walkthroughs, memberships, and the singleton review before
releasing only its `refs/rvw/branch/<branchReviewId>/...` namespace; PR refs, another Branch Review ID,
and shared Issue cache are outside that deletion boundary. If ref deletion fails after DB deletion,
the error reports both outcomes and the orphan prefix. A replacement review gets a new ID, so it cannot
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

`BranchReviewLifecycle` is the application boundary shared by CLI, HTTP, and Agent socket. It separates
open-or-create, cached/existing reads, synchronize-existing, and destructive-existing policies. Only
`branch open` and the explicit Issue-add operation may create a Branch Review. Reset, Issue removal,
comments, and synchronization require an existing aggregate; preview failures are read-only. Matching
local binding plus a network-only GitHub failure preserves cached reads. If no GitHub remote can be
resolved, cached reads and local cleanup remain available when the common directory and owned ref
still prove the binding, while synchronization and Issue addition are rejected.

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
Branch context. Routing uses the stable local Pull Request / Branch Review ID; the GitHub URL or
canonical repository remains a separate display value. A reset-and-recreate therefore starts a new
Branch context even when its repository text is identical, while casing changes cannot split one
context. A long-running external Agent
task may consume that sequence with an opaque database-scoped cursor through `rvw comment watch`.
rvw retains minimal event identifiers independently of deletable posts and owns only ordering and
replay. The bundled Skill's task-local state script atomically owns its cursor, queue, leases, retries,
per-batch status posts, self-event suppression, and repository-writer serialization. After claim, the
task creates one immediate acknowledgement per affected thread and later edits that same normal post
to the final outcome. A retry of that batch restores its acknowledgement, while a later batch for the
same thread creates a new post and preserves the earlier outcome. Branch Review batches are always
read-only investigation: they receive one final idempotent reply, never reserve a repository write key,
and never auto-resolve. Their worker result carries an explicit Branch context, not a fabricated Pull
Request URL. The final reply uses the operation's stable idempotency key; its returned post ID is stored
as a durable suppression before the lease completes. Completion also marks an already-ingested pending
self-event completed, so either ingest ordering and a retry after process restart avoid a new batch.
The parent reserves subagent capacity
before intake; the driver caps in-flight claims to that capacity and polls task state to drain same-PR
follow-ups after lease release and retries after their due time. Every acknowledged lease is handed to
one fresh subagent immediately, while the parent retains only intake, state, and final-post ownership.
Separate tasks may consume the same log with separate state. This terminal-bound consumer is not a daemon
and rvw never starts it. A durable
reply-idempotency ledger makes an exact caller-payload retry safe without introducing Agent session
identity into comments.

Walkthroughs cross the same one-way CLI boundary in the other direction. An Agent can publish a
Markdown explanation to a Pull Request or Branch Review, fixed to one commit with validated file
references and optional inclusive line ranges, plus optional Mermaid-node bindings. A publish or
update may explicitly add same-repository Issues without creating a semantic relation. SQLite stores
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
text is never covered. Issue document identity excludes the Branch source OID: refreshes replace query
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
synchronization and read-only Branch Review investigation; `rvw-walkthrough` converts the current session's explanation into a validated,
commit-fixed publication without prescribing its document structure; `rvw-watch-comments` keeps an
external Agent task subscribed to newly created posts. It fails closed on PR ownership before any
authorized fix-and-push, and categorically disables remote writes for Branch Reviews. Codex and Claude Code receive
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
