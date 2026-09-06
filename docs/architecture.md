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
per-batch status posts, self-event suppression, and a recovery mirror of writer ownership. The rvw
database atomically fences the active watch generation while acquiring each shared repository writer
reservation, so different task-state databases cannot overlap writers. After claim, the
task creates one immediate acknowledgement per currently unresolved affected thread and later edits that same normal post
to the final outcome. A retry of that batch restores its acknowledgement, while a later batch for the
same thread creates a new post and preserves the earlier outcome. The parent reserves subagent capacity
before intake; the driver caps in-flight claims to that capacity and polls task state to drain same-PR
follow-ups after lease release and retries after their due time. Every acknowledged lease is handed to
one fresh subagent immediately, while the parent retains only intake, state, and final-post ownership.
Separate tasks retain separate private state, while the rvw database holds one active logical watcher
generation that fences superseded states and retains old-generation writer reservations until their
exact leases release them. The event cursor remains an independent stream position.
Historical events for resolved or missing threads are durably skipped before acknowledgement. This
terminal-bound consumer is not a daemon
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
paths, ranges, endpoints, identities, presentation references/membership, and Pull Request ownership before retaining the commit.
The current value separates factual graph claims from an optional authorial spatial presentation made
of a thesis, an attention start, at most one connected exact-Edge primary backbone of 2–12 derived Nodes
and 1–16 Edges, and named comprehension Regions with stable IDs, responsibility summaries, and disjoint
Node membership. Backbone Edge membership is exact
and unordered; path, fan-out, convergence, reciprocal, and small cyclic cores share the same model.
A start-only presentation with no backbone or regions is valid when its thesis and
attention start are meaningful but no honest spatial organizer exists. Region arrays and each region's
`nodeIds` are unordered sets canonicalized by stable ID. Membership may be partial and a Region need not
form a connected induced subgraph. Legacy graph JSON without the field reads
as `presentation: null`; no `graph_json` data migration is needed. Retired Node, Edge, and Region IDs are
kept in small tombstone tables so a client that missed intermediate whole-value updates cannot mistake a
removed-then-reused identity for a surviving claim or framed chunk. Continuously present identity semantics
remain an authoring responsibility because ordinary claim and membership edits are valid. Structure is not a semantic code index and has no revision
history, comments, persisted semantic reverse index, inferred edges, or persisted coordinates. The viewer may
derive an ephemeral backlink index from explicit Node anchors in the current values. HTTP lists and reads current values;
human-confirmed delete is the only write exposed to the browser.

The Structure viewer uses a primary backbone or regions to shape canonical placement and uses any non-null
presentation for its compact authorial Guide and cues while preserving every factual Node, Edge, and direction. The Guide
shows the thesis and attention start; it does not duplicate the complete primary-backbone Edge list or a
space-starved Region graph. Graph mode shows the exact factual Node / Edge surface. Regions mode uses the
full Structure body for responsibility rectangles and direct cross-Region connections derived from factual
Edges. Region cards use the complete authorial label rather than exposing stable IDs as abbreviations.
Drilling into Graph opens a named Region lens with its full responsibility summary and exact coverage;
member Nodes and internal relations receive a dedicated visual treatment, so manual geometry never becomes
membership truth. Regions are keyboard-accessible drill-down landmarks. With
an independent pane-local Regions camera, first view / Reset keeps the Start landmark at a readable
scale while Fit frames the complete derived map without changing card geometry. Zoom and wheel/drag pan support local reading. Graph and Regions
cameras survive mode switches and tab movement independently; Region drill history snapshots both.
With `presentation: null` or a start-only presentation, it uses topology, factual direction reachable from
the entrypoint, and stable IDs—not display content—to produce the same projection. A long derived
backbone may fold deterministically across multiple serpentine rows so the canonical map uses both
dimensions and keeps region envelopes distinct. Row boundaries and the target aspect are projection
heuristics, not authored layers, reading order, or protocol state. A non-null presentation's new
session initially focuses `startNodeId`; the null case
initially focuses the origin. Both are defaults derived from the artifact, while pane-local
browser session state preserves Graph / Regions mode, focus, neighborhood depth, Home/Back navigation, Guide disclosure, node positions, and projection-specific viewports across tab
navigation and current-value updates, and moves with a Structure tab between panes. Surviving IDs keep
positions and new nodes take a non-overlapping slot near retained neighbors while the spatial organizer
is unchanged. A changed backbone endpoint adjacency or Region identity/membership rebases Node geometry to
the new canonical explanation while preserving surviving focus and its screen-space camera anchor. A
framed Region whose stable ID survives remains the active chunk lens and is refit from its current
members and derived internal-relation bounds; only a removed Region ID is pruned. Region
label/summary edits and Region array reordering do not rebase Graph Node geometry.
The Regions camera has its own canonical derived-map basis: unordered serialization and thesis/summary
edits retain it, while changes that can alter Region cards, Context components, relation routes, or
relation-label geometry reset it to the readable Start-oriented Home projection. Only explicit Fit
frames the complete map. The key and camera are viewer state, not protocol semantics.
Null and start-only presentations share one layout basis, so transitions between them and thesis- or
start-only edits preserve manual geometry; changing only the exact parallel backbone relation preserves
geometry while updating emphasis. The shared deterministic route model avoids non-endpoint Nodes and
connects every visible relation to source/target boundary ports without a clearance gap. Distinct visible
relations retain independently traceable substantive lanes whenever their routes would otherwise share
or nearly share a corridor; parallel and reciprocal relations are required examples. It places labels independently of
focus filtering for Viewer and export; at normal detail, labels are Node-disjoint and pairwise
non-overlapping, with leader-associated displaced slots when inline placement is unavailable. Backbone membership is stable
authorial salience; focus-hop proximity is session-derived attention and uses a separate visual channel.
Home activates All and frames the authorial start—or the null-presentation origin—plus its exact factual
1-hop Node bounds; the full backbone remains emphasized but does not enlarge that camera target.
1-hop and 2-hop require a focus; All exposes every Node and Edge. Semantic zoom may suppress unreadable
secondary detail only while counts, minimap, selection, Home, and All keep it explicitly recoverable.
Home and Region framing activate All so their declared targets are actually visible; a Regions-mode
card drill-down switches to Graph and Back can restore the overview together with the previous focus,
neighborhood depth, framed Region, and camera. Direct mode toggles do not create history entries. Region framing preserves focus and
membership while temporarily restoring full visual relevance to the framed members and their internal
relations. Home, local Node focus, and an explicit depth change clear that pane-session chunk lens.
Source actions always open the declared exact `sourceOid` in the chosen pane without changing
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
synchronization; `rvw-review-compose` chooses the minimum adaptive mix of Walkthrough, Structure, and
direct code reading for one Pull Request or explicit review subject; `rvw-walkthrough` turns one bounded
subject into one validated source-anchored ordered path; `rvw-structure` maps one declared PR-relevant
behavior from its code entrypoint into stable source-anchored relationships and optional authorial spatial
presentation; and `rvw-watch-comments`
keeps an external Agent task subscribed to newly created posts and fails closed on PR ownership. The
producer Skills honor a session-local upstream brief while retaining their own representation rejection
and exact-source contracts; they do not independently expand back into PR-wide composition.

The upstream brief is split by meaning rather than persisted shape. Subject, review question, purpose or
behavior boundary, scope, inclusions, exclusions, and emphasis bound the producer's investigation;
`mustEstablish`, suggested origins, relationships, invariants, and other implementation assertions remain
claims the producer verifies independently against committed source. The composer activates producers by
canonical name through each host's native Skill mechanism; host-specific user invocation sigils are not
part of the rvw protocol.

Review composition is an authoring strategy outside the domain model. Its candidate understanding units,
Artifact briefs, recommended entry, and URI summary are not persisted as a Review Set, Artifact kind,
group, or review plan. The composer uses the existing protocol-v5 Walkthrough and Structure operations;
it adds no database, URI, API, Viewer UI, protocol capability, or generic runtime sub-Skill invocation
framework. Codex and Claude Code receive the same five Skill directories under their respective local
Skill roots. Platform selection is a packaging concern only and does not fork the Agent protocol or
workflow instructions. Installer metadata records the bundled digest so update availability and local
customization are reported separately.

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
until Ctrl+C. A new runtime uses the stable default port 43117 so origin-scoped browser permissions survive
normal restarts; explicit `--port 0` opts into an ephemeral port. An omitted port reuses any active runtime,
while an explicit nonzero port must match it; otherwise the command reports a conflict instead of starting a
second server.

The React root treats a URL without `pullRequestId` as a lightweight workspace index over the
user-global database. Its paginated summary query first bounds the Pull Request rows and then aggregates
their comment and Walkthrough counts in SQLite, without reading Git objects or contacting GitHub. Selecting a saved Pull Request mounts the existing
commit-backed review screen; the index and review screen share the same ephemeral viewer heartbeat and
use the browser History API for transitions. A history traversal back into a review also restores that
entry's focused reading destination; a fresh row selection starts a fresh ephemeral review workspace.
