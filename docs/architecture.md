# Architecture

rvw is a human reading environment for the software produced by a pull request. Its primary code
read model is the repository snapshot at an exact Git commit. Pull Request metadata explains intent;
commit ranges and diffs are derived lenses that locate change inside that snapshot. Changed files do
not limit which repository documents can be opened, searched, or commented on.

rvw is a local Node.js application with four boundaries:

- `domain`: pure commit/document, walkthrough-reference, comment, and line-mapping rules.
- `application`: use cases shared by HTTP and CLI transports.
- `infrastructure`: SQLite, Git, GitHub CLI, filesystem, and subprocess adapters.
- `server`, `cli`, and `web`: transport and presentation only.

The SQLite database is user-global. Observed PR heads are retained by `refs/rvw/...` in the base
repository's common Git directory. The browser polls `app_meta.change_sequence`; there is no
persistent daemon or agent session coupling. While a viewer process is running, it exposes a
user/database-specific Unix socket inside a `0700` temporary directory as an alternate transport for
the same application service. Agent
CLI operations prefer that socket and fall back to direct local execution only before a request has
been sent. A sent operation with an unknown outcome is never automatically repeated. Concurrent
viewers for one database elect one socket owner and a follower takes over after that owner exits.

The viewer reads committed Git objects rather than the worktree or index. That keeps the human's
reading context stable while an external Agent edits, tests, commits, and pushes. Comments bridge the
two processes through stable references and the JSON CLI protocol; browser state, prompts, and Agent
sessions never enter the domain model.

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
The browser owns an ephemeral two-pane workspace: every document identity belongs to one pane, tabs can
move between panes, and modifier-click targets the right pane from the sidebar or the opposite pane from
within a document. Pane placement never enters SQLite or the Agent protocol. Repository Markdown uses
the same exact Git document fetch and can switch locally between source and a safe rendered preview.
The preview preserves native browser text selection while translating parser positions back to source line ranges;
it never persists DOM or layout coordinates.
The selection boundary resolves to the smallest mapped Markdown leaf, and its composer is portaled
into a React-owned declarative slot in normal document flow immediately after the selected block so
wrapped text is never covered.
Relative preview images are fetched from the same commit through a size-limited read-only endpoint.
PR Markdown, Walkthroughs, external image URLs, and paths that cannot be resolved inside the repository
render as non-fetching placeholders. Same-origin SVG asset responses carry a restrictive Content Security
Policy and sandbox so direct navigation cannot execute repository-controlled script under the viewer origin.

The bundled Skills are named by capability rather than Agent host. `rvw` handles review comments and
synchronization; `rvw-walkthrough` converts the current session's explanation into a validated,
commit-fixed publication without prescribing its document structure. Codex and Claude Code receive
the same Skill directories under their respective local Skill roots. Platform selection is a packaging
concern only and does not fork the Agent protocol or workflow instructions. Installer metadata records
the bundled digest so update availability and local customization are reported separately.

Each automatically opened browser document attaches an ephemeral viewer ID to that poll. The
owning `rvw open` process uses those IDs only to stop its HTTP listener after the final tab closes;
they are never persisted and are not part of review state or the agent CLI protocol. `--no-open`
continues to be terminal-signal managed.
