# Architecture

rvw is a human reading environment for the software produced by a pull request. Its primary code
read model is the repository snapshot at an exact Git commit. Pull Request metadata explains intent;
commit ranges and diffs are derived lenses that locate change inside that snapshot. Changed files do
not limit which repository documents can be opened, searched, or commented on.

rvw is a local Node.js application with four boundaries:

- `domain`: pure commit/document, shared source-anchor, comment, Walkthrough, Structure, and line-mapping rules.
- `application`: use cases shared by HTTP and CLI transports.
- `infrastructure`: SQLite, Git, GitHub CLI, filesystem, and subprocess adapters.
- `server`, `cli`, and `web`: transport and presentation only.

The SQLite database is user-global by default. Observed PR heads are retained by `refs/rvw/...` in the base
repository's common Git directory. The browser polls `app_meta.change_sequence`; there is no
persistent daemon or agent session coupling. While a database-scoped viewer runtime is running, it exposes a
user/database-specific Unix socket inside a `0700` temporary directory as an alternate transport for
the same application service and for the internal `viewer.open` lifecycle request. A later `rvw open`
resolves its requested Pull Request through that owner and opens another URL on the same HTTP origin;
it does not construct another Runtime, SQLite connection, or HTTP server. Different explicitly selected
database paths have separate socket identities and may run independently. Agent
CLI operations prefer that socket and fall back to direct local execution only before a request has
been sent and only when no socket path was explicitly configured. `RVW_AGENT_SOCKET_PATH` is
fail-closed: an unavailable or database-mismatched configured socket never falls back to SQLite. A
sent operation with an unknown outcome is never automatically repeated. Concurrent starters for one
database compete for an atomic filesystem owner lock before Runtime and HTTP initialization, so only
the winner can become the runtime. A loser delegates its open request to the winner and exits instead
of becoming a second owner. If that owner is already stopping, the loser retries election after the
owner releases its lock; the next lock winner alone initializes Runtime. A later invocation recovers a dead-PID lock and stale socket by
exact inode. Shutdown stops accepting socket requests, drains HTTP, and closes Runtime/SQLite before
removing the socket and releasing the owner lock, so a new runtime cannot start while the old one is
still draining. Transport diagnostics report the
socket, connection, database identity, selected transport, and fallback reason. Doctor also executes
a rollback-only write transaction instead of inferring writeability from Unix modes.

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

New root posts and replies also append a database-wide event sequence. A long-running external Agent
task may consume that sequence with an opaque database-scoped cursor through `rvw comment watch`.
rvw retains minimal event identifiers independently of deletable posts and owns only ordering and
replay. The bundled Skill's task-local state script atomically owns its cursor, queue, leases, retries,
per-batch status posts, self-event suppression, and repository-writer serialization. After claim, the
task creates one immediate acknowledgement per affected thread and later edits that same normal post
to the final outcome. A retry of that batch restores its acknowledgement, while a later batch for the
same thread creates a new post and preserves the earlier outcome. The parent reserves subagent capacity
before intake; the driver caps in-flight claims to that capacity and polls task state to drain same-PR
follow-ups after lease release and retries after their due time. Every acknowledged lease is handed to
one fresh subagent immediately, while the parent retains only intake, state, and final-post ownership.
Separate tasks may consume the same log with separate state. This terminal-bound consumer is not a daemon
and rvw never starts it. A durable
reply-idempotency ledger makes an exact caller-payload retry safe without introducing Agent session
identity into comments.

Walkthroughs cross the same one-way CLI boundary in the other direction. An Agent can publish a
Markdown explanation fixed to one commit, with validated file references and optional inclusive line
ranges, plus optional Mermaid-node bindings. SQLite stores one current explanation per stable Walkthrough
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

Structures cross the same one-way CLI boundary as a separate domain. An Agent declares a bounded
PR-relevant behavior and factual code entrypoint as stable-ID nodes and edges fixed to one exact source commit. SQLite keeps one
current graph JSON value per stable Structure ID; publication and whole-value replacement validate all
paths, ranges, endpoints, focus, identities, and Pull Request ownership before retaining the commit.
The graph is a set of producer claims, not a semantic code index. It has no revision history, comments,
groups, persisted semantic reverse index, inferred edges, or persisted coordinates. The viewer may
derive an ephemeral backlink index from explicit Node anchors in the current values. HTTP lists and reads current values;
human-confirmed delete is the only write exposed to the browser.

The Structure viewer uses topology, factual direction reachable from the entrypoint, and stable IDs—not
display content—to produce an initial layout. Pane-local
browser session state preserves focus, neighborhood depth, node positions, and viewport across tab
navigation and current-value updates, and moves with a Structure tab between panes. Surviving IDs keep
positions and new nodes take a non-overlapping slot near retained neighbors. 1-hop and 2-hop require a
focus; All shows every Node and Edge. The bounded MVP does not collapse or cull relations based on ID or
degree. Source actions always open the declared exact `sourceOid` in the chosen pane without changing
the global commit range.
The browser owns an ephemeral two-pane workspace: every document identity may appear once per pane, tabs
can move between panes, ordinary document-opening clicks target the left pane, and modifier-click targets
the right pane regardless of focus or origin. Pane placement never enters SQLite or the Agent protocol. Repository Markdown uses
the same exact Git document fetch and can switch locally between source and a safe rendered preview.
The preview preserves native browser text selection while translating parser positions back to source line ranges;
it never persists DOM or layout coordinates.
The selection boundary resolves to the smallest mapped Markdown leaf, and its composer is portaled
into a React-owned declarative slot in normal document flow immediately after the selected block so
wrapped text is never covered.
Relative preview and comment images are fetched from their resolved exact commit through a size-limited
read-only endpoint. PR Markdown, Walkthrough bodies, external image URLs, and paths that cannot be resolved inside the repository
render as non-fetching placeholders. Same-origin SVG asset responses carry a restrictive Content Security
Policy and sandbox so direct navigation cannot execute repository-controlled script under the viewer origin.

The bundled Skills are named by capability rather than Agent host. `rvw` handles review comments and
synchronization; `rvw-walkthrough` converts the current session's explanation into a validated,
source-anchored path without prescribing its document structure; `rvw-structure` maps a declared
PR-relevant behavior from its code entrypoint into stable source-anchored relationships;
`rvw-watch-comments` keeps an
external Agent task subscribed to newly created posts and fails closed on PR ownership. Codex and Claude Code receive
the same Skill directories under their respective local Skill roots. Platform selection is a packaging
concern only and does not fork the Agent protocol or workflow instructions. Installer metadata records
the bundled digest so update availability and local customization are reported separately.

Each browser document attaches an ephemeral viewer ID to that poll. The database runtime uses those IDs
only to stop its HTTP listener after the final tab closes; they are never persisted and are not part of
review state or the public Agent CLI protocol. By default, the first parent `rvw open` process starts the
runtime worker in the background, opens the browser after readiness, waits for the first viewer heartbeat,
and then returns control to the terminal. Later opens use the runtime socket and same HTTP origin, holding an
operation reservation while resolving the Pull Request and then a bounded startup reservation until the
returned URL sends its first heartbeat. This prevents a prior
final-tab grace timer from invalidating the new URL. The process remains a browser-owned runtime rather than
a persistent daemon. `--foreground` explicitly owns a terminal-attached runtime and conflicts with an
existing owner. `--no-open` disables only browser launch: it reuses an active runtime or starts a
signal-managed one when none exists. When reusing a browser-managed runtime, the CLI holds a viewer lease
until Ctrl+C. An explicit nonzero port must match an active runtime; otherwise the command reports a conflict
instead of starting a second server.

The React root treats a URL without `pullRequestId` as a lightweight workspace index over the
user-global database. Its paginated summary query first bounds the Pull Request rows and then aggregates
their comment and Walkthrough counts in SQLite, without reading Git objects or contacting GitHub. Selecting a saved Pull Request mounts the existing
commit-backed review screen; the index and review screen share the same ephemeral viewer heartbeat and
use the browser History API for transitions. A history traversal back into a review also restores that
entry's focused reading destination; a fresh row selection starts a fresh ephemeral review workspace.
