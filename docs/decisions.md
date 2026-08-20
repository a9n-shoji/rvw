# Architecture decisions

## 2026-08-19: Make browser history a focused reading trail

### Problem

The document workspace keeps multiple temporary tabs and up to two panes, but every navigation was
held only in React state. A reviewer following a search result, comment, Markdown link, or Walkthrough
reference therefore could not use the browser's Back action to return to the code or explanation they
had been reading. Serializing the whole workspace into each browser entry would make Back behave like
layout undo: it could close useful tabs, move documents between panes, and restore an obsolete commit
range even though review scope is intentionally independent from document navigation.

### Choice

Treat same-page browser history as a chronological trail of the focused pane's reading destination.
Each versioned entry contains the Pull Request, active document, pane hint, line range or pane-local
scroll position. Explicit document activation, line navigation, and in-document Markdown heading
navigation push an entry. A line jump remains a semantic line locator while it is still anchored at the
applied position; once the reviewer scrolls away, the same entry becomes the actual pane scroll position.
Presentation changes, transient comment hover/focus, tab closing or movement, review-scope controls,
and automatic data refresh do not add entries.

Back and Forward activate only the recorded reading destination. If its document remains open, its
current pane ownership wins; otherwise it reopens in the recorded pane. The other pane, open-tab set,
pane sizing, and current global commit range and display controls remain untouched. Repository paths
without an exact source continue to follow the current selected commit, while exact-source and
selected-range reference policies remain part of their document target. Use manual restoration because
the reading surfaces scroll inside panes rather than the browser window. Keep the page URL limited to
the existing Pull Request route and store the ephemeral destination in namespaced, runtime-validated
`history.state`.

A full reload starts a fresh ephemeral workspace and replaces the retained current entry with that
default reading target. This preserves the established reload boundary for tab and pane placement;
Back remains the explicit action for revisiting earlier same-origin reading entries.

### Trade-offs

- Back follows the reviewer's reading order across both panes without turning browser history into a
  second workspace or review-scope model.
- A closed historical destination can reopen when explicitly revisited, but unrelated closed tabs and
  earlier pane layouts are not resurrected.
- Same-origin history entries are not independently shareable URLs. A future deep-link contract can
  project the same reading target into the URL without serializing the complete workspace.
- Raw pane scroll is less stable than a source anchor when content changes; explicit search, comment,
  reference, and Markdown heading jumps retain line locators until manual reading continues, after which
  ordinary reading falls back to the captured scroll.

## 2026-08-20: Let an external Agent task watch new rvw comment posts with a task-owned cursor

### Problem

The comment CLI supports explicit discovery and handling, but a long-lived Agent task cannot learn
about new root comments or replies without repeatedly listing every saved Pull Request. Offset-based
thread lists are not a durable event boundary, edits reorder threads, and retrying a reply after an
uncertain transport result can create duplicates. The watcher must cover all saved PRs while keeping
the existing boundary that rvw neither starts nor manages Codex or Claude sessions. It must also keep
write permission for another author's PR strictly narrower than permission for the authenticated
user's own PR.

### Choice

Add an append-only `comment_post_events` sequence for newly created root posts and replies. Migration
does not backfill existing posts, so a cursorless `rvw comment watch --json-seq` anchors at the current
position and intentionally skips existing unresolved comments. A database-scoped opaque cursor allows
replay after restart. Event rows retain only post/comment/PR identifiers and survive comment deletion;
watch marks a missing post as deleted instead of losing the sequence. The command polls every 10
seconds by default and uses RFC 7464 framing because a persistent stream cannot satisfy the ordinary
one-JSON-value stdout contract.

The external Agent task owns its cursor, pending queue, retry state, and created post IDs in a separate
task database managed by the bundled Skill's deterministic state script. Ingesting an event and
advancing its cursor is one transaction. Batch leases preserve idempotency keys across restart. After
a claim and initial thread read, create `🔎 確認中です…` immediately as one normal idempotent reply per
comment URI, record that status post ID, and suppress its own event in one task-state transaction.
Reuse the same status post for later replies in that thread. Completion or terminal failure replaces
its body instead of adding another reply. Separate tasks use separate state databases; rvw does not
impose a database-global consumer lock or store Agent execution state.

Cache the latest GitHub PR author login and head repository owner/name, and expose them in comment
context. Watch events remain minimal triggers that require a fresh comment read. The watcher
task may receive explicit startup authorization for the predicate "live PR author equals the recorded
authenticated GitHub login". Matching PRs may use `fix-and-push`; every non-matching, missing, or
conflicting identity is `investigate-and-reply`, with code and GitHub writes forbidden. A live author
and current authenticated login check is required immediately before a write. A write also requires
an exact live head repository, branch, and OID match so a fork PR cannot target the base repository by
mistake. rvw does not enforce this Agent policy or perform Git writes; the bundled Skill does.

Add optional per-reply idempotency keys to standalone replies and sync updates. A durable ledger stores
the key hash, caller-payload hash, and result post ID independently of the deletable post. The sync
fingerprint excludes its derived current head OID, so the same caller input still finds the original
reply after a concurrent head advance. Reuse for another caller payload fails; retry after result
deletion reports a permanent deleted-result error instead of recreating it. Edits, deletes, and
resolve/reopen changes do not create watch events. Add an exact post-replacement `comment.edit`
capability so the task can safely retry an uncertain edit and optionally update the related commit.
Keep protocol version 2 because both `comment.watch` and `comment.edit` are additive commands.

### Trade-offs

- The event log grows with created posts and has no Phase 2 retention policy; local comment volume is
  expected to be modest, and premature compaction would complicate cursor guarantees.
- A task that loses its separate task database cannot reconstruct skipped startup work automatically.
  This is deliberate: Agent execution state does not enter the rvw product database.
- PR author cache is null until an old saved PR is synchronized again. The policy fails closed and can
  use the live comment read before considering a write.
- Multiple independent tasks can consume the same rvw event log. A single task database serializes its
  own claims and repository writers; users should not intentionally start competing automation tasks
  with overlapping responsibility.
- Replacing the status post keeps a thread quiet but rvw does not retain the acknowledgement or an
  earlier Agent outcome as post history; the current result and Git commits remain the intended record.
- RFC 7464 requires a stream-aware consumer; ordinary CLI commands retain their single JSON response.

## 2026-08-17: Use an annotated initial release tag without fabricating a signing identity

### Problem

The first npm release needs an immutable Git tag on the reviewed `main` commit, but the maintainer
machine has no configured GPG or SSH signing identity. npm does not require a signed Git tag, and
creating an automation-only signing key during release would not prove the maintainer identity that a
signature is meant to establish.

### Choice

Create `v0.1.0` as an annotated tag on the exact remote `main` commit. Keep the existing fail-closed
release check that requires the tag to point at `HEAD`, requires `HEAD` to be reachable from
`origin/main`, and rejects a dirty checkout. Do not generate or store an ad hoc signing key. A future
maintainer signing setup may switch release tags from `git tag -a` to `git tag -s` without changing the
npm package contract.

### Trade-offs

- The initial Git tag records the release message and tagger but does not cryptographically attest the
  maintainer identity.
- Reviewed GitHub history, the exact-tag release checks, npm account 2FA, and the one-time interactive
  publish remain the independent controls for `0.1.0`.
- Future staged releases gain npm OIDC provenance; Git tag signing remains an optional, separately
  managed maintainer control.

## 2026-08-17: Publish a scoped package through reviewed staged releases

### Problem

Phase 1 intentionally kept `rvw` private while package smoke established the distribution boundary.
Moving to Phase 2 needs a package name that cannot collide with the unrelated unscoped `rvw` package,
cross-platform evidence for the installed CLI, and a release path that does not place a reusable npm
write credential in GitHub. The registry also requires a package to exist before either a Trusted
Publisher relationship or staged publishing can be configured, so an OIDC-only first publication is
not possible.

### Choice

Use the available `@a9n-shoji/rvw` package name, with control of the matching npm user or organization
scope as an external gate before the first publish. Include CHANGELOG and SECURITY alongside the
existing release contents, and run package smoke on macOS, Linux, and Windows.

Pin npm 11.19.0 as a development release tool. Keep ordinary CI read-only. A separate, manually
dispatched `publish.yml` checks out an explicit stable version tag, requires approval through the
`npm-production` GitHub Environment, verifies the package name/version/tag/CHANGELOG contract, runs all
gates, retains the exact package-smoke tarball, and sends that tarball through OIDC to `npm stage
publish`. Configure the npm trust relationship with stage-only permission; a maintainer inspects and
approves the staged artifact with 2FA.

Bootstrap only `0.1.0` by publishing the same smoke-tested tarball interactively with 2FA from a clean
tag checkout. Do not create a long-lived automation token. Immediately configure the stage-only
Trusted Publisher and disallow traditional publish tokens. Document the exact operator sequence and
forward-fix policy in `docs/releasing.md`.

### Trade-offs

- The first release lacks OIDC provenance because npm cannot trust a package before it exists. A
  temporary CI publish token would add provenance but would weaken the no-reusable-write-secret
  boundary during the most sensitive release.
- Manual workflow dispatch and staged approval add two deliberate human actions to each release.
- Stable releases are supported by the initial workflow; prereleases need an explicit future decision
  about their dist-tag instead of silently moving `latest`.
- The scoped package installs as `@a9n-shoji/rvw`, while its executable remains the short `rvw` command.

## 2026-08-18: Let an authorized Agent create ordinary rvw comment threads

### Problem

The Agent comment protocol could discover, read, reply to, resolve, and reopen existing feedback, but
only the browser could create a root thread. An Agent explicitly asked to review a committed snapshot
therefore had no durable way to record a newly discovered concern in the same rvw reading context. A
Walkthrough was not an appropriate substitute: it is an implementation explanation, not review
feedback, and publishing one would give the finding the wrong lifecycle and presentation.

### Choice

Add the single-item `rvw comment create --stdin --json` command and advertise the additive
`comment.create` capability without advancing protocol version 2. The command resolves a registered
Pull Request, accepts the existing PR, PR-Markdown, exact repository document, or Walkthrough target
shapes, and delegates to the same application-level validation used by browser comment creation.

An Agent-created comment is an ordinary unresolved thread with an optional accurate `authorLabel`.
It has no Agent-only state, priority, category, automatic resolution, or hidden session link. Creation
is passive with respect to the viewer and is not batched. The bundled Skill permits it only when the
user explicitly asks the Agent to record review findings. Because creation is not idempotent, an
uncertain outcome must be checked through `comment list` before retrying.

### Trade-offs

- Findings from an authorized Agent can enter the same durable review loop as human findings without
  adding an in-app Agent runtime or chat surface.
- The display label communicates authorship but is not an authenticated identity; rvw continues to
  rely on the local caller's authorization boundary.
- Single-item creation is more verbose for large reviews, but it avoids a partial-success batch
  contract and makes every durable thread intentional.
- A poor review request can still produce noisy comments. Skill instructions constrain when to
  create them, while the data model deliberately does not classify or suppress Agent feedback.

## 2026-08-13: Anchor ranges beginning at the first PR commit to the comparison base

### Problem

The Web viewer received the synchronized comparison-base OID but discarded it when deriving the old
side of a commit range. It always used the first parent of the earliest selected commit. After a feature
branch merges the current base branch, `git merge-base` advances to the merged base tip and
`comparisonBase..head` starts with the merge commit. The merge commit's first parent is still the older
feature tip, so using it makes a PR-wide diff show the base-branch changes while omitting feature changes
that predate the merge. The result can be much larger than GitHub's PR diff and answer a different
question.

An intermediate merge commit initially appears to have the same problem. However, a merge of history
reachable from the current base necessarily advances the comparison base to at least that merged base
commit, placing the merge at the beginning of the current PR commit list or before it. A merge that
remains in the middle therefore brings in history absent from the current synchronized base; hiding that
side would incorrectly remove changes that are part of the PR.

### Alternatives

- Continue using the earliest selected commit's first parent for every range.
- Use the second parent of every merge commit as the old side.
- Use the synchronized comparison base when selection starts at the first current PR commit, and retain
  first-parent semantics for later range starts.

### Choice

When the earliest selected commit is `commits[0]`, the viewer uses `comparisonBaseOid` as the old OID.
This applies both to the PR-wide shortcut and to a shorter range that begins at the first listed commit.
For a range beginning later in the list, the viewer continues to use the earliest selected commit's
first parent, including for an intermediate merge.

Cover the boundary with a browser regression and real-Git integration histories. One history merges the
current base into the feature and verifies that base-only changes do not enter the PR-wide diff. A
diverged-current-base history leaves the old merge in the middle and verifies that its first-parent
delta remains visible.

This supersedes the unconditional first-parent conversion in the 2026-08-09 inclusive commit-range
decision; the picker and its inclusive selection model otherwise remain unchanged.

### Trade-offs

- PR-wide changed files and document diffs now match the synchronized GitHub comparison even when the
  first listed commit is a merge-back commit.
- A custom selection starting at the first listed commit uses a boundary that may not be that commit's
  first parent, but it consistently represents the beginning of the current PR history.
- Intermediate merges can still produce a large delta when they contain history absent from the current
  base. That size is intentional because those changes are part of the selected commit and current PR.

## 2026-08-11: Start public protocol compatibility at version 1

### Problem

The machine protocol advanced through several breaking revisions while rvw had one user and remained
private and unpublished. Those internal numbers reached version 9, but no npm release, public
repository consumer, installed bundled Skill, or `rvw` executable on the user's PATH depended on them.
Carrying the internal number into the first public release would make the compatibility history appear
older than the public contract it represents.

### Choice

Label the current machine contract as protocol version 1 before creating the public repository or
publishing a package. This is a compatibility-epoch reset, not a rollback to the schema that happened
to use version 1 during private development. Treat every pre-public protocol number as an unsupported
internal draft, and update the executable, bundled Skills, contract tests, and public documentation
together.

After the first public release, protocol versions increase monotonically for breaking changes and are
never reset or reused. Capabilities remain independently required so consumers reject a version that
does not provide the operations they need.

### Trade-offs

- Historical private commits and design notes can mention versions 2 through 9; they are not public
  compatibility promises.
- Any forgotten pre-public consumer would reject the new CLI until updated, but the local executable
  and both supported Skill locations were checked before this reset and contained no installed client.
- The first public package can use package version 0.1.0 and protocol version 1 without implying that
  package and protocol versions advance together.

## 2026-08-11: Bundle npm runtime dependencies into the CLI artifact

### Problem

Switching maintainers and CI to pnpm protects the development install, but the published package still
declared a runtime dependency tree. Every `npm install --global` would independently resolve and fetch
that tree under npm's lifecycle-script and release-selection behavior, so the distributed CLI did not
inherit the reviewed pnpm lockfile or its supply-chain policies.

### Choice

Bundle every non-Node runtime module into `dist/cli.mjs`. Fail the build if esbuild leaves any external
import other than a Node built-in. The web assets were already bundled, so move all direct packages to
`devDependencies` and publish no runtime `dependencies`. Generate separate CLI and web third-party
notices from their actual module graphs.

Strengthen package smoke to create the tarball with `pnpm pack`, install that exact local artifact with
`npm install --global --offline` using an empty cache and temporary prefix, verify that the installed
package has no nested runtime dependency tree, and run `rvw doctor` from the global binary.

### Trade-offs

- The tarball and source map grow because CLI dependencies are embedded, but installation no longer
  resolves mutable runtime packages.
- A dependency security fix requires rebuilding and releasing rvw; consumers cannot receive a patched
  transitive dependency without an rvw release.
- Native dependencies would need a separate cross-platform artifact decision. The current runtime graph
  is JavaScript-only, and the build gate prevents silently externalizing a future package.

## 2026-08-11: Use pnpm with fail-closed dependency installation

### Problem

The development and CI dependency install trusted every dependency lifecycle script by default. A
compromised direct or transitive package could therefore execute code immediately during install, and
the repository had no policy for newly published versions, trust-evidence downgrade, exotic transitive
sources, or a lockfile proposed under weaker settings. Those defaults are too permissive for a CLI that
will later be distributed through the public npm registry.

### Choice

Use pnpm 11 as the development package manager, pinned with an exact version and registry integrity in
`package.json`. Commit `pnpm-lock.yaml` and keep the single root package; `pnpm-workspace.yaml` is the
project security configuration, not a monorepo boundary.

Dependency installation fails for every unreviewed build script. Approvals are version-specific, with
only the currently required esbuild version approved initially. Resolution rejects versions published
within the last 72 hours, missing publication time, trust-evidence downgrade, and exotic transitive
sources. CI re-applies these checks to lockfile entries rather than treating a contributor-edited
lockfile as trusted. Running a project script with stale dependencies fails instead of silently
installing. The migration detected that `@pierre/theme@2.0.0`, required by the currently used
`@pierre/diffs@1.3.5` API, had lost the provenance evidence present on earlier theme releases. The
1.2.x diffs API does not contain the active-line and reveal methods used by the viewer. Keep both
versions exact and add a trust-policy exclusion for theme 2.0.0 only. The reviewed npm artifact has
registry signatures and its manifest matches theme 2.0.0 in upstream's `diffs-v1.3.5` tag; the lockfile
pins its integrity. A future version remains blocked unless it restores trust evidence or receives its
own reviewed exception.

Create the release-shaped tarball with `pnpm pack`, then install that exact artifact with
`npm install --global` into a temporary empty prefix and run `rvw doctor` from the installed binary.
Keep the npm CLI for that consumer-facing install and the future OIDC trusted-publishing job. Pin every
GitHub Action to a full commit SHA. The separate distribution decision will determine whether runtime
dependencies can be bundled so package consumers do not resolve an independent dependency tree during
install.

### Trade-offs

- A legitimate release can be selected only after the waiting period; an urgent exact-version
  exception requires an intentional reviewed change.
- Adding or updating a package with a build script fails until its exact version is reviewed and
  approved.
- pnpm's stricter dependency layout can reveal undeclared dependency access that npm hoisting had
  hidden; the full test and package-smoke suites are the compatibility gate.
- Contributors need the pinned pnpm major. The committed package-manager metadata and CI bootstrap keep
  its version deterministic.
- pnpm secures maintainer and CI installation, but does not by itself secure the dependency tree
  installed by an npm consumer; bundling and trusted publishing remain separate controls.

## 2026-08-11: Map rendered Markdown selection to source-line comments

### Problem

Repository Markdown and Walkthroughs are primarily read in rendered form, but line comments were only
available in source/code views and Walkthrough feedback could only target the whole document. Persisting
browser ranges, DOM paths, or Mermaid SVG elements would make anchors depend on renderer output. Requiring
stable block IDs in authored Markdown would avoid that dependency, but would also impose a new document
syntax and would not match the existing PR-body policy for mutable, revisionless text.

### Choice

Use Markdown parser source positions as a one-way mapping from native browser text selection to an
inclusive source-line range. Decorate rendered leaf text with its source line, keep native selection and
copy behavior, and show a nearby comment action after selection. Store only the normal document identity
and source range; never store a DOM path, visual line, browser range, generated HTML, or SVG node.

For immutable repository Markdown, the target remains the exact Git document and source lines. For the
latest PR body and mutable Walkthrough body, store a normalized document hash and the exact quoted lines.
When the hash changes, re-anchor only if those quoted lines occur exactly once as a contiguous range in
the current document; otherwise report Outdated and retain the original quote. Whole-document comments
continue to target the stable document identity and never become Outdated. A Mermaid comment targets the
entire original fenced code block, not a node or the generated SVG.

This supersedes the whole-Walkthrough-only and mandatory stable-AST-block-ID parts of the 2026-08-09
Walkthrough publication decision. Walkthroughs still have one current value and no version selector or
retained full revision; their stable ID, passive Agent boundary, exact code references, and explicit
delete authorization remain unchanged. Because Walkthrough comment targets now expose source hash,
quoted text, and nullable line fields, the strict JSON protocol advances to version 9.

### Trade-offs

- A reviewer can comment where they read without introducing renderer-specific persisted state.
- Source-line granularity can include Markdown punctuation or adjacent source content represented by one
  rendered node; the visible affordance labels the resulting source range explicitly.
- Quote matching conservatively refuses ambiguous or edited text and exposes that loss as Outdated.
- Mermaid feedback is block-level in Phase 1; node-level feedback would need a separate stable authored ID
  contract rather than generated SVG identity.
- Mutable documents retain only a bounded quote and hash, not a hidden revision history.

## 2026-08-10: Keep review scope independent from document navigation

### Problem

Walkthrough references, repository Markdown links, and code-comment targets can identify an exact
source commit, but opening them previously replaced the global commit range with that single commit.
A reviewer reading the full Pull Request could therefore lose their review scope merely by following
evidence or reopening a comment target. Those navigation paths also changed global display and tree
modes even though the controls describe the repository-wide review context, not one tab.

### Choice

Treat document navigation as passive with respect to review scope. A Walkthrough reference is resolved
against its retained exact `sourceOid + path` before changing the document workspace; repository
Markdown links and code-comment targets likewise open their exact-source document identity without
changing the selected commit range, full/diff mode, diff style, or file-tree mode. A Walkthrough source
renders its fixed snapshot in global full mode and uses the selected global comparison in diff mode, so
it remains switchable between stacked and split. Repository Markdown links and code-comment targets
instead retain exact-source full text within their pane even when the global control remains in diff
mode. When that source differs from the selected destination commit, the viewer shows both short OIDs.

If the exact document cannot be fetched or is no longer displayable, leave the current tabs and panes
untouched and show a short-lived status chip in the originating Walkthrough. Missing commits and paths
are reported as broken links; transport and unexpected failures are reported as load failures. Resolve
concurrent requests independently per target pane, and discard a delayed result if newer navigation has
already changed that pane. Publication still validates and retains every reference, so broken links are
an explicit recovery path for inconsistent or externally damaged local Git state.

### Trade-offs

- Following evidence or reopening a comment target no longer destroys the reviewer’s PR-wide or
  multi-commit context.
- Walkthrough diff mode intentionally applies the current review range as a lens over its referenced
  path; Markdown and comment navigation preserve exact historical content without moving global scope.
- Reference navigation performs one document availability read before opening the tab; full mode then
  reuses that cached exact document.
- Broken and temporarily unavailable references are distinguished in place and do not silently open a
  different commit or path.

## 2026-08-10: Return complete review context through the Agent comment CLI

### Problem

The copied-comment workflow let an Agent read a known URI, but could not discover unresolved feedback.
The read response also omitted the cached PR intent, branch metadata, rvw's conservative latest
placement, and the target source text. Consumers therefore needed extra Git/GitHub calls and could
incorrectly approximate Outdated by comparing creation and head OIDs. The bundled Skill also left the
state of a resolved thread after a reply implicit.

### Alternatives

- Keep URI-only handoff and require the user to copy every desired thread.
- Return complete repository files with every comment.
- Add discovery plus bounded, exact context while keeping source expansion explicit.

### Choice

Protocol v8 adds `comment.list`. It takes a registered PR reference, defaults to unresolved threads,
and can explicitly select resolved or all threads. Results are paginated with a default of 50 and a
maximum of 100. Each item contains a target summary, post count, a 512-byte root-post preview, and
rvw's service-derived latest placement. The query does not load replies, exact target evidence, or
source excerpts. Agents call `comment get` for each thread they inspect or address.

`comment get` returns the latest cached PR title, base/head branches and OIDs, comparison base,
timestamps, local repository path, latest placement, and an exact-source excerpt for repository-file
targets. The default response and `comment list` omit the PR body; `comment get --include-pr-body`
adds the latest cached body when the review task needs PR-level intent. Excerpts include the selected
range with up to 20 surrounding lines, or the beginning of a file-level target, capped at 200 lines
and 64 KiB with explicit truncation fields. The exact OID/path remains available for reading the
complete surrounding repository. Outdated remains derived by rvw; consumers never infer it from OID
inequality.

Replies remain independent of resolution state. Resolved threads accept replies and stay resolved
until an explicit reopen. The Skill documents that behavior and shows `authorLabel` in its standalone
reply example.

### Trade-offs

- An Agent can start from a PR-level request without a manually copied URI list.
- Cached PR intent can be requested together with placement and target evidence without network
  access, while routine reads avoid attaching the full body.
- List placement may run Git mapping for up to the requested page size and is intentionally richer
  than a raw DB query.
- Pagination keeps discovery complete while bounding one response and its placement work. Concurrent
  comment updates can reorder an offset-based page, so Agents should re-list before final resolution.
- Bounded excerpts avoid unbounded JSON/token cost but still require a repository read for truncated
  files and broader architectural context.
- Protocol v8 consumers must adopt the new capability and response fields together.

## 2026-08-10: Let Walkthrough references target a file or an inclusive line range

### Problem

Requiring every Walkthrough reference to carry a line range makes file-wide architecture and
composition claims pretend to have a precise line anchor. At the same time, navigation only emphasized
the first line of a valid multi-line reference, which made the existing range contract look like a
single-line locator and encouraged Agents to publish overly narrow references.

### Choice

A Walkthrough reference always identifies an exact `sourceOid + path` and may additionally identify an
inclusive line range. `startLine` and `endLine` are either both present or both absent. Equal values mean
one line; different values mean the complete inclusive range; absent values mean the file as a whole.
The viewer highlights the full supplied range and does not select a line for a file-level reference.

The bundled `rvw-walkthrough` Skill asks Agents to prefer the smallest meaningful multi-line block for
code-flow claims, reserve single-line ranges for genuinely line-local claims, and use file-level
references for file-wide structure. Commit and UTF-8 document validation remains mandatory in all cases,
and supplied line ranges must still exist in the exact snapshot.

This supersedes the mandatory line-range and first-line-only highlighting parts of the 2026-08-09
Walkthrough publication decision. Its commit fixation, passive publication, and human-controlled
navigation boundaries remain in force. Because saved Walkthrough references can now return nullable
line fields, the JSON protocol advances to version 6.

### Trade-offs

- References now express their real evidence granularity instead of inventing a line anchor.
- Existing range-based publications remain valid and migrate without changes.
- Consumers must handle nullable line fields and distinguish opening a file from jumping to a range.
- File-level references verify a document boundary, not a stable symbol or block within that document.

## 2026-08-10: Persist the UI theme outside the viewer origin

### Problem

Each `rvw open` viewer binds to an automatically assigned localhost port. Browser storage is scoped by
origin, so a theme selected for one Pull Request is not available when another viewer starts on a
different port.

### Alternatives

- Use only browser storage and require the user to select a theme for every port.
- Reuse one fixed port and long-running server for every viewer.
- Store the preference in rvw's existing OS-user-scoped SQLite database.

### Choice

Store one `light`, `dark`, or `system` theme preference in the existing SQLite `app_meta` table and
expose it through the local same-origin HTTP API. A new viewer reads this setting before rendering the
React application, regardless of its Pull Request or port. Per-origin browser storage remains a fast
initial-paint cache and a temporary fallback when the shared setting cannot be read; SQLite is the
source of truth.

Theme selection applies immediately in the current viewer and then writes the shared preference. A
write failure is shown through the existing error notice instead of claiming cross-viewer persistence.
The preference is global presentation state, is not part of a Pull Request, and does not advance the
review change sequence.

### Trade-offs

- Theme selection follows the OS user across repositories, Pull Requests, and automatically assigned
  viewer ports.
- Viewer startup performs one small local request before the application renders.
- Already-open viewers do not automatically change when another viewer selects a theme; newly opened
  viewers and reloads use the latest successful setting.
- If the shared DB is temporarily unavailable, the current origin can still render from its browser
  cache and reports the API failure after the application loads.

## 2026-08-10: Keep one current Walkthrough per stable ID

### Problem

Immutable Walkthrough publications force an Agent to create a second artifact whenever reviewer
feedback reveals that an explanation is unclear. The old and revised copies then remain side by side,
the reviewer must decide which one is current, and whole-document feedback stays attached to the less
useful copy. This is especially awkward for the intended loop where an Agent reads a reaction and
improves how it explains the same implementation.

Walkthrough comments do not target Markdown lines, rendered blocks, or Mermaid elements. Their anchor is
already the Walkthrough as a whole, so preserving every body and reference revision does not protect a
finer-grained comment location. Unnecessary or duplicate artifacts also need a deliberate removal path.

### Alternatives

- Keep publications immutable and ask Agents to publish a new copy for every revision.
- Add Walkthrough revisions, history, diffing, and a version selector.
- Replace the current value in place under a stable ID without storing history.
- Permit deletion only when no comments exist, leaving cleanup of reviewed duplicates cumbersome.
- Confirm associated feedback counts and delete the Walkthrough, references, comments, and posts
  together.

### Choice

A Walkthrough has one current title, body, source commit, reference set, diagram-binding set, and author
label under one stable `rvw://walkthrough/<uuid>`. The Agent protocol can read that current object and
replace it completely after applying feedback. The ID, URI, `createdAt`, and whole-document comment
targets remain stable; rvw stores no previous value, update sequence, or Walkthrough version selector.
Publish and update validate the same commit, path, line, Markdown-link, and diagram-binding invariants
and remain passive with respect to browser state.

Deletion requires an explicit confirmation. The preview reports reference, comment, and post counts;
the confirmed operation deletes them with the Walkthrough in one SQLite transaction. The viewer uses a
native confirmation, and the Agent CLI requires `--yes` plus explicit user authorization. Retained Git
commit refs are not removed individually because another Walkthrough or comment may share the commit;
reset remains their cleanup boundary.

This supersedes the immutability and no-update/delete parts of the 2026-08-09 Walkthrough decisions.
Their stable whole-document anchor, passive publication, exact source validation, and human-controlled
navigation choices remain in force.

### Trade-offs

- Feedback can improve the same explanation without cluttering the sidebar with artificial revisions.
- A Walkthrough comment always resolves with the current explanation, not a historical body that the
  commenter originally saw.
- Update is a full replacement, so Agents must read the current artifact and resubmit every reference;
  CLI validation prevents partial reference drift.
- With no revision history, a mistaken update cannot be restored by rvw. Git still preserves code, but
  not prior explanatory prose.
- Confirmed deletion invalidates copied Walkthrough and attached comment URIs and is intentionally
  irreversible.

## 2026-08-10: Name bundled Skills by capability, not Agent host

### Problem

The first installer shipped separate `rvw-codex` and `rvw-claude` definitions. Their protocol and
workflow constraints were almost identical, while Walkthrough publication was embedded beside comment
handling and synchronization. That made the Agent host look like a product capability, duplicated
instructions, and loaded publication details into ordinary comment work.

Moving Walkthrough publication into its own Skill creates another risk: prescribing headings,
explanation order, or diagram choice in the Skill would override the current session's understanding of
the user's request and repository context.

### Alternatives

- Keep separate Codex and Claude Code Skills and duplicate the Walkthrough section in both.
- Keep one platform-specific Skill per Agent host but move detailed publication guidance to shared docs.
- Install the same capability-named Skills on both hosts, separating comment work from Walkthrough
  publication and constraining only the artifact contract.
- Put all CLI operations in one shared `rvw` Skill.

### Choice

Ship two platform-independent Skill directories: `rvw` for reading and addressing comments and
synchronizing pushed state, and `rvw-walkthrough` for publishing commit-fixed explanations. Codex and
Claude Code use the exact same contents under their respective Skill roots; the install platform selects
only the destination directory. Optional author labels are supplied accurately by the running Agent
rather than hardcoded in the Skill.

The Walkthrough Skill defines source-commit, reference, binding, validation, immutability, and passive
navigation requirements. It deliberately does not define a document template, required sections,
explanation order, or preferred diagram. Those choices remain with the current session and user request.

### Trade-offs

- One source of Skill instructions prevents platform drift and makes capability triggers clearer.
- Ordinary comment work does not load the Walkthrough publication contract.
- Installer status now reports two Skills per selected platform, and an install manages both together.
- Host-specific guidance cannot be added by casually forking Skill contents; genuine host differences
  must remain packaging concerns or be documented as an explicit exception.
- Existing `rvw-codex` or `rvw-claude` directories are not silently deleted because they may contain
  local changes; users upgrading an earlier development install must remove those legacy directories
  after reviewing them.

## 2026-08-09: Anchor Walkthrough comments to the immutable document

### Problem

A rendered Walkthrough is useful precisely because Markdown and Mermaid are transformed into a richer
reading surface. That transformation means a visual row, DOM node, or SVG element is not a stable
comment anchor. Source line numbers would also make the reviewer reason about Markdown syntax while
reading Preview.

### Alternatives

- Do not allow comments on Walkthroughs.
- Store rendered DOM or Mermaid SVG positions.
- Reuse Markdown source line numbers in Preview.
- Start with whole-Walkthrough comments, and require explicit stable AST block IDs before adding
  paragraph-level comments.

### Choice

Phase 1 comments may target an immutable Walkthrough ID as a whole document. The viewer places the
composer and its threads beside the rendered explanation, without claiming that a rendered paragraph
maps to a source line. `rvw comment get` includes the complete target Walkthrough so an external Agent
receives the exact body, source commit, diagram bindings, and code references under discussion.

Rendered positions are never persisted. Paragraph-level comments remain possible only after the
publication format gains explicit stable block IDs derived from the Markdown AST.

### Trade-offs

- Comments remain stable across theme, width, Mermaid renderer, and browser changes.
- The first interaction is sufficient for requests about the explanation as a whole.
- Reviewers cannot yet attach a thread to one rendered paragraph or diagram edge.
- The comment protocol adds a Walkthrough target and advances to version 4.

## 2026-08-09: Keep one document identity while allowing two reading panes

### Problem

Walkthrough references make cross-file navigation fast, but replacing the explanation with each source
forces repeated tab switching. The same friction appears when comparing a caller with its definition or
reading a Markdown design document beside its implementation. Duplicating arbitrary editors or making
pane layout persistent review state would add a larger workspace model than the reading task needs.

### Alternatives

- Keep one viewer pane and rely on tabs.
- Allow an unlimited number of editor groups with independently duplicated documents.
- Always force Walkthrough references into a fixed second pane.
- Allow at most two panes, keep one tab identity per document, and let the human choose placement.

### Choice

The browser owns an ephemeral workspace with one pane by default and at most two horizontal panes.
Every open document identity belongs to exactly one pane. A tab can move by drag and drop or the pane
header's `...` menu; sidebar `Cmd` / `Ctrl`+click targets the right pane, while the same interaction
within a document targets the opposite pane. A normal click reuses the document's current pane or the
focused pane for a new document. The second pane disappears when it has no tabs.

Pane assignment, focus, drag state, and Markdown Source / Preview choice are presentation state only.
They are not stored in SQLite, included in comments, or exposed through the Agent CLI. Repository
Markdown preview renders the exact fetched Git text without raw HTML, resolves heading links, and loads
relative images from the same commit through a size-limited endpoint. It does not replace the source view
needed for line comments.

The sidebar boundary and the divider between two document panes are pointer-resizable with minimum
reading widths. Divider positions remain ephemeral browser state, support keyboard adjustment, and
reset to their defaults on double click or reload.

### Trade-offs

- Walkthrough and source, caller and definition, or Markdown and code can remain visible together.
- One identity prevents confusing duplicate tabs that show the same commit and path in both panes.
- Two panes preserve usable width for code and diagrams; more complex comparison layouts remain out of
  scope.
- Resizable boundaries let the human give a diagram, prose, or wide source file the space it needs
  without turning layout into durable review state.
- Reload clears pane placement and preview selection, matching the existing ephemeral tab model.
- Line comments require Source mode because rendered Markdown no longer has a stable one-to-one visual
  line surface; file comments remain available in Preview.

## 2026-08-09: Let Agents publish explanations, but let only humans navigate them

### Problem

An Agent can explain an implementation with file paths and line numbers, but plain chat references
are awkward to verify against a large repository. Automatically opening every cited file would be
equally disruptive: it would let the Agent control the reviewer's tabs and reading order, turn an
explanation into live session state, and make it difficult to keep the explanation visible while
checking only the claims that matter.

Language-server-backed symbol graphs could generate some relationships automatically, but they do not
capture why an implementation was structured a certain way, require substantial language-specific
infrastructure, and would expand Phase 1 beyond repository reading.

### Alternatives

- Keep Agent explanations in chat and make humans copy paths into rvw.
- Let the Agent drive the active rvw browser tab while it explains.
- Add an in-app Ask/chat surface that opens references from its responses.
- Generate all explanations and graphs inside rvw through LSP or semantic indexing.
- Accept a commit-fixed explanation artifact through the existing Skill and CLI boundary, then make
  every navigation action explicitly human-controlled.

### Choice

An external Agent may publish a Markdown Walkthrough containing typed code references and Mermaid
node bindings. The artifact is fixed to one available Git commit; rvw validates every path, line range,
and parsed `rvw-ref:` link against that exact snapshot. The list endpoint returns only display metadata;
the immutable body and references are loaded when its tab is opened. The viewer renders the explanation
in an ordinary document tab with an inline-reference treatment, a reference index, and diagrams whose
bound nodes are selectable.

Publishing is passive. It never opens a browser, activates a tab, changes the selected commit, or
scrolls a viewer. Only a human click or keyboard action opens an exact source document and highlights
the referenced line. That source opens in rvw's document workspace, so the Walkthrough and previously
opened code remain available and the human may place them side by side. The explanation and diagram are Agent claims; committed code is the
inspectable source of truth.

The protocol is CLI + Skill only (`rvw walkthrough publish --stdin --json`). There is no write HTTP
endpoint, in-app prompt, Agent launch, or browser-state protocol. Markdown raw HTML is not rendered;
Mermaid uses strict security settings and only validated node-to-reference bindings become actions.

### Trade-offs

- Humans can sample and verify an Agent explanation without surrendering their reading order.
- Walkthroughs make cross-file architecture explanations much easier to inspect while remaining
  independent of an Agent session.
- Agents must provide exact commit, path, and line data, and stale or malformed references are rejected
  at publication time.
- Diagrams describe the Agent's interpretation rather than a mechanically complete call graph.
- Phase 1 stores immutable publications and does not provide update/delete, semantic indexing, LSP, or
  automatically generated symbol usage graphs.

## 2026-08-09: Treat the resulting repository as the review surface

### Problem

Code review tools commonly make the changed-file diff the boundary of the review. That is efficient
for locating edits, but an AI-generated change can be locally plausible while conflicting with an
unchanged caller, test, configuration file, document, or architectural convention. Showing a better
diff does not by itself help the human reconstruct the software that exists after the change.

At the other extreme, an Agent IDE can expose the whole repository while coupling code reading to an
AI chat, editable worktree, and live Agent session. That makes the Agent the center of the workflow and
turns human review state into session context.

### Alternatives

- Limit rvw to changed files and expandable diff context.
- Add repository context only to prompts so the Agent can review its own change more accurately.
- Become an Agent IDE with chat, editing, execution, and session management beside the diff.
- Treat the selected commit's repository as the primary human reading surface and keep Agent execution
  behind the Skill and CLI boundary.

### Choice

The review object is the software produced by the selected commit, together with the latest Pull
Request intent and the commits that produced it. Full files, all files, fixed-string search, document
tabs, and comments on unchanged code are core review capabilities. Changed files and commit-range diffs
locate edits inside that repository; they do not restrict where the user may navigate or comment.

The human owns understanding and judgment. An external Agent performs authorized implementation work
and receives the resulting comments through stable `rvw://comment/<uuid>` references and the JSON CLI
protocol. rvw does not add AI chat, launch an Agent, edit code, or use the live worktree as its reading
model.

### Trade-offs

- Reviewers can inspect effects outside the patch and preserve a coherent reading set across Agent
  iterations.
- rvw needs a repository tree, full-document loading, search, tabs, and exact commit identity in
  addition to a diff renderer.
- Phase 1 asks the human to discover relationships through paths and fixed-string search; it does not
  add semantic search, LSP, or a code graph.
- Handoff is less immediate than an embedded chat, but review records remain independent of a model,
  Agent session, and mutable worktree.

## 2026-08-09: Use one path-aware VS Code icon resolver across document surfaces

### Problem

The file tree, search groups, document tabs, and rendered-file headers each showed a generic file
glyph. Replacing only one surface would make the same path look unrelated as users move through the
review workflow, while copying filename rules into each component would let them drift.

### Choice

Use the MIT-licensed `@pierre/vscode-icons` source SVGs and Complete-tier filename/extension
associations behind one browser-side resolver. Exact filenames take precedence over the longest
matching extension suffix. File tree rows, search groups, document tabs, and viewer headers all use
the resolver; folders use the matching closed/open icons. Unknown extensions, symlinks, and
submodules retain explicit fallbacks. SVG source is bundled locally and checked before trusted inline
rendering, so the UI does not depend on a CDN.

### Trade-offs

- A path now has the same language or tooling icon throughout the UI, including light and dark themes.
- The package adds a small pinned runtime dependency and roughly 100 KiB of unpacked source assets.
- Updating the icon package can change associations and colors, so resolver and representative UI
  tests guard the intended precedence and placements.
- Inline SVG preserves the icon set's duo-tone styling, but requires treating the pinned package as a
  trusted build input and rejecting active SVG content.

## 2026-08-09: Make full-text search a realtime collapsible sidebar tool

### Problem

The existing full-text search was a submit form at the bottom of Files. Results were a flat list,
opening one forced Full mode, and there was no way to control case, whole-word matching, group large
result sets, or navigate to the matching line. File-name filtering and repository-content search also
looked like one tool despite having different scope and semantics.

### Choice

Search becomes a third independent collapsible sidebar stack beside Files and Comments. A 250 ms
debounce replaces explicit submit. Fixed-string search remains the only search language, with
case-sensitive and whole-word toggles and VS Code-like case-insensitive substring defaults. The API
returns every match range on each matched line; the 500-result safety limit continues to count lines,
while UI totals and file badges count occurrences. Results group by file and support one global
expand/collapse action.

Opening a result preserves the global Full / Changes and stacked / split state. Full view scrolls to
the line directly; Changes expands collapsed destination-side context before scrolling. Files with no
change continue to use the existing local full-text fallback. `Cmd+Shift+F` / `Ctrl+Shift+F` opens the
Search stack and focuses its input.

### Trade-offs

- Search is clearly separated from file-name filtering and can remain visible with Files and Comments.
- Live search adds requests while typing, bounded by debounce, query/result/stdout limits, and canceled
  stale browser requests.
- Occurrence totals can exceed the 500 matched-line limit; truncated state explicitly says the visible
  total is incomplete.
- Whole-word boundaries use Git filtering for repository files and equivalent Unicode-aware matching
  for returned highlights and `Pull Request.md`; unusual locale-specific case folding may still differ.

## 2026-08-09: Allow post editing and reply deletion while preserving the thread anchor

### Problem

Accidental comments and replies need correction without forcing users to resolve a thread that no
longer represents a real discussion. At the same time, unrestricted root deletion would orphan
replies and invalidate copied `rvw://comment/<uuid>` references without a reliable way to know whether
an Agent still holds them.

### Choice

Root and reply posts may be edited. Reply posts may be physically deleted individually. The root post
remains the thread and URI anchor while any reply exists, so root deletion is rejected until all replies
are removed. A thread containing only its root may be physically deleted, with a confirmation that
copied references will stop resolving. Post identity records `is_root` explicitly so equal timestamps
cannot change which post anchors the thread. Editing and deletion do not introduce another comment
state; the only states remain unresolved and resolved.

### Trade-offs

- Users can correct text and remove individual mistaken replies in the same place they review it.
- Remaining replies always retain a root anchor and stable thread reference.
- Post history is no longer immutable; an Agent holding previously read content can become stale until
  it resolves the comment again.
- A copied reference can become invalid after the final reply is removed and the root thread is then
  deleted; Phase 1 does not persist clipboard history, so the confirmation is the available safeguard.

## 2026-08-09: Expose inclusive commit ranges in the top bar

### Problem

The destination commit was in the application header while the comparison-boundary selector lived in
the document-tab row. Both affected every open repository document, and the boundary commit itself was
not included in the diff, so placement and wording implied a narrower and less intuitive scope than the
actual behavior. A second full-width row would fix the hierarchy but spend scarce vertical space.

### Alternatives

- Put the raw old- and new-OID selectors next to each other.
- Remove range selection and always compare the destination with its first parent.
- Keep multi-commit review, but expose the first included commit instead of the excluded Git boundary.

### Choice

The top bar contains PR identity plus a horizontally compact review-scope group: one inclusive commit
range picker, Full / Changes, and diff style. GitHub sync and local-state rebuild move into a
right-aligned `...` overflow menu. The document-tab row contains document navigation only.

The picker treats selected commits as one contiguous set instead of exposing separate destination and
start selectors. A click selects one commit; dragging across rows or Shift-clicking selects the inclusive
range in one gesture. PR-wide and latest-only shortcuts cover the common presets. Internally rvw converts
the earliest selected commit to its first parent and uses the latest selected commit as the destination
for the existing old-OID/new-OID APIs. The closed picker shows the range summary and count, and gives the
latest-head selection a high-contrast `最新` badge.

### Trade-offs

- One commit remains one click and any contiguous multi-commit range is one drag gesture.
- Users select only commits included in the review; the excluded Git boundary is no longer UI vocabulary.
- Every repository-wide control has one clear home without increasing the header height; at narrow
  widths the PR heading is hidden before controls.
- Merge commits continue to use the first-parent boundary, matching the existing range behavior.

## 2026-08-09: Couple changed files to the global commit range and fall back locally

### Problem

A repository-wide review can open files that are absent from the currently selected diff. Returning an
empty diff makes those files unreadable, while changing the global comparison mode to Full surprises the
user and also changes the context of other open tabs. A separate changed-tree comparison can answer a
different question, but duplicates the global range model in a file-local location.

### Alternatives

- Keep the changed-files tree coupled to the global commit range.
- Change the global comparison mode to Full whenever the active file has no diff.
- Show an unavailable state for files without a diff.
- Keep the two comparison selections independent and derive a per-file effective display mode.

### Choice

The changed-files tree, tab change-status icons, and central viewer all use the one global commit range.
The sidebar has no subordinate comparison selector. Opening a file from the changed-files tree switches
the viewer to Changes without changing the selected range. When the active document has no content
change in that range, it fetches and shows the latest selected commit's full text and labels the header
`差分なし · 全文表示`.
`Pull Request.md` follows the same rule for every non-full mode because it has no historical base-side PR
document; opening or returning to that tab never mutates the global display mode.

The app shell is bounded to the viewport and delegates vertical scrolling to the sidebar and central
viewer. Closing an in-app document tab from its explicit close button does not require confirmation.
The app does not handle `Cmd+W` / `Ctrl+W` because browsers reserve it for closing their own tab, and it
does not introduce a less conventional replacement shortcut. A persistent `beforeunload` guard asks for
browser-native confirmation before the browser tab is actually closed, reloaded, or navigated away.

### Trade-offs

- Review context stays stable while every head-side file remains readable.
- The file list cannot intentionally show a different range from the viewer, but there is one range model
  to understand and no file-local control that affects repository-wide state.
- Closing an in-app document tab requires its visible close button, while `beforeunload` guards the
  browser tab itself.
- Browser vendors control the `beforeunload` message and may suppress it without prior user interaction;
  rvw cannot provide custom alert text.
- The page itself no longer scrolls vertically; users scroll the two work areas independently.

## 2026-08-09: Manage opened documents as tabs and sidebar tools as collapsible stacks

### Problem

The viewer can browse the whole repository, but replacing the central document on every file,
search-result, or comment navigation loses the user's working set. The mutually exclusive Files /
Comments sidebar also forces unnecessary mode switching while reviewing related code and comments.

### Alternatives

- Keep a single replace-in-place document and mutually exclusive sidebar modes.
- Use a continuous multi-file diff stream for all navigation.
- Persist a separate comparison mode and viewer state for every open document tab.
- Keep a browser-local document tab set, while making Files and Comments independently collapsible
  sidebar stacks and keeping comparison mode global.

### Choice

The browser keeps an ephemeral, de-duplicated tab for each document identity (`Pull Request.md` or
repository path). File-tree, file-search, full-text-search, and comment-target navigation all open
or activate the same tab. Tabs can be closed, overflow horizontally, and are also available from a
compact open-tabs list. Files and Comments are rendered together as independently collapsible
sidebar stacks. Tabs use compact labels for navigation, while the embedded code/diff header remains
the source for the exact path, addition/deletion totals, and file-comment action. Global review-scope
and diff-style controls live in the top bar, leaving the tab row for navigation only.

The selected commit remains above the entire tab set. Switching commits preserves open
paths but rebinds them to the selected commit. Comparison mode and split / stacked style remain
shared viewer state; they are intentionally not stored per tab. Tabs and stack expansion are
browser-only UI state and are not exposed to the Agent CLI or persisted as review data.

### Trade-offs

- Repository-wide review keeps a useful working set without adopting a continuous diff stream.
- Comments can remain visible while their target document is opened.
- Commit switching has one clear document world for all tabs.
- A path absent from another commit can remain open and show the normal unavailable state.
- Reloading the viewer clears the tab set and stack expansion state.
- A tab label and file header both identify a document, but intentionally at different levels: the
  tab may truncate for navigation density, while the file header preserves full context and totals.
- The tab strip has less horizontal room for documents, so tabs overflow earlier; the existing
  horizontal scroll and open-tabs menu provide the fallback without consuming more vertical space.

## 2026-08-09: Replace review versions with commits and commit ranges

### Problem

The explicit review-version capture workflow duplicated Git history and required users to decide
when a GitHub state should become a version. In practice this added an extra action, a second naming
system, and a second history selector without enough review value. Commit subjects already describe
the submitted changes, and a contiguous commit range represents the same code comparison more
directly.

Keeping PR title/body history inside those versions also coupled mutable GitHub text to immutable Git
objects. Historical PR-body browsing was judged uncommon compared with the cost it imposed on the
data model and UI.

### Alternatives

- Keep explicit review versions and improve their labels with commit subjects.
- Generate one review version per commit.
- Keep review versions internally but hide them from the UI.
- Use commits for code history, keep only the latest PR title/body, and retain minimal source text on
  PR-body comments for conservative Outdated placement.

### Choice

Git commits are the sole code-history units exposed by rvw. The viewer selects a destination commit
and, for custom diffs, the first commit included in the range. Internally the pair remains
`start.parentOid -> destinationOid`. The UI has no
review-version selector, capture action, sequence, summary, or previous-version comparison.

PR title and body are a latest-only virtual document. A successful open/refresh/sync replaces the
cached values. rvw does not provide PR-body history or bind PR text to commits. PR-body line comments
store the source document hash and selected text, not a full document revision; they are conservatively
repositioned in the latest text or shown as Outdated. GitHub's own edit history remains the escape hatch
for historical PR-text investigation.

Every observed PR head is protected by an immutable `refs/rvw/pr/<number>/commits/oid-<oid>` ref. The
`oid-` prefix keeps the component valid under Git's ref-name rules. This keeps comment source commits
available across server restarts and force-pushes. Reopening a stored PR
is local-first; GitHub synchronization is a separate operation so cached review state remains readable
when the network or PR is unavailable.

The Agent batch command is `rvw pr sync --stdin --json`. It validates GitHub-visible state, protects
the current head, refreshes current PR metadata, applies replies/resolutions, and relates replies to the
current head commit. It is not idempotent in Phase 1.

### Trade-offs

- The user model and repository-document references become substantially smaller.
- Commit messages and ranges are available without duplicated labels or manual capture.
- PR-body changes are not reviewable as a local history and are not part of code comparisons.
- A PR-body comment can lose inline placement after an edit, although its selected source text remains
  visible in the comment target.
- Exact historical PR-wide comparison bases are not preserved as separate versions; the current
  synchronized merge base defines `PR全体`.
- Force-pushed source commits remain readable through rvw refs, but they are not mixed into the current
  PR commit selector.

## 2026-08-08: Stop an automatically opened server with its last viewer tab

### Problem

The original Phase 1 lifecycle kept every `rvw open` process alive until Ctrl+C, even after its
browser tab had been closed. This leaves easy-to-forget local processes and SQLite connections.

### Alternatives

- Keep terminal-only Ctrl+C/SIGTERM management.
- Trust only `beforeunload`/`pagehide` notification from the browser.
- Add a WebSocket or daemon-level server registry.
- Track ephemeral tab leases through the existing change-sequence poll, with a best-effort close
  notification and timeout fallback.

### Choice

Automatically opened viewers use per-document, non-persistent IDs. The existing one-second poll
renews a server-local lease, and `pagehide` sends a best-effort release. The server stops after the
last release plus a reload grace period, or after a longer lease timeout if release was lost.
Multiple tabs are counted independently. Timer lateness consistent with machine suspend renews
leases instead of causing a false shutdown. `--no-open` remains signal-managed, and auto-shutdown
does not start until at least one viewer has connected.

This intentionally replaces the original `Ctrl+C`-only step in section 18.1. The source
specification has been updated to make the new lifecycle normative.

### Trade-offs

- Normal tab close stops the process promptly without a daemon or persistent session model.
- Reload needs a short grace period, so shutdown is not instantaneous.
- Browser crashes and lost beacons are detected only after the longer lease timeout.
- Viewer IDs remain transport-only and do not violate the boundary against live viewer state in
  the review/Agent core.

## 2026-08-11: Delete a root comment as the whole thread

### Problem

Requiring every reply to be deleted before the root comment made accidental or obsolete threads
unnecessarily tedious to remove. The database already owns replies beneath the comment through
foreign-key cascade, so the restriction added UI steps without protecting independent records.

### Choice

Deleting the root comment deletes the complete thread, including every reply, target, and copied
`rvw://comment/<uuid>` anchor. The confirmation explicitly reports when replies will also be removed.
Reply posts remain individually deletable, while attempting to delete the root through the reply-post
endpoint remains invalid. This supersedes the root-preservation restriction in the 2026-08-09 post
editing and reply deletion decision.

### Trade-offs

- One confirmation removes a complete unwanted discussion and all of its dependent records.
- Copied comment references stop resolving immediately after deletion.
- A mistaken root deletion removes useful replies as well, so the action remains destructive and
  explicitly confirmed.

## 2026-08-12: Keep typed Walkthrough links but remove the duplicate Code references index

### Problem

Walkthrough references appeared both where the explanation used them and in a persistent side or
bottom `Code references` list. The duplicated list consumed a large part of narrow and two-pane
layouts even when users navigated only through the explanation itself.

### Choice

Keep the reference model, CLI schema, validation, `rvw-ref:` inline buttons, and bound Mermaid-node
navigation unchanged. Remove only the complete reference index beside/below the Walkthrough and the
reference-count badge in the sidebar. Walkthrough content uses the full reading width.

### Trade-offs

- Links remain contextual and verifiable without a second navigation surface.
- File-level references that an Agent declares but never links in the body are no longer directly
  discoverable in the viewer; Agents should link references that matter to the explanation.
- Protocol v1 and stored Walkthrough data remain compatible.

## 2026-08-12: Route Agent CLI operations through the running rvw process when available

### Problem

Sandboxed Agents can read an explicitly selected SQLite database yet still be unable to reply,
resolve, update a Walkthrough, or change a repository path because the OS user-data directory is not
writable from the sandbox. Requiring broader direct DB access weakens isolation.

### Choice

A normally launched viewer exposes a per-user Unix socket with mode `0600`. CLI commands try this
transport first and dispatch to the same `RvwService` instance used by HTTP; if no socket exists they
retain direct local execution. An explicit `RVW_DATABASE_PATH` is included as the expected database
identity: a matching viewer handles it, while a mismatch is rejected before dispatch and falls back to
direct access. Fallback is limited to failures before request transmission. After transmission, a
timeout, disconnect, or malformed response is reported as an uncertain outcome and is never repeated
automatically. Destructive confirmation and the same Zod command schemas are enforced at socket
dispatch, not only in the CLI presentation layer. Concurrent viewers use one owner and follower
takeover for the shared socket. A `0700` per-user parent directory protects the bind-to-chmod window
before the socket itself reaches `0600`. The socket is a local transport only: it
does not add an Agent session, browser control, prompt exchange, or in-app AI feature.

The default DB directory and file are chmodded only when newly created. Existing paths are checked by
`stat` for exact `0700` / `0600` modes and current-user ownership. A failed chmod on a new path is
accepted only when the resulting stat is already safe; unsafe existing or newly created paths produce
an explicit error. Existing caller-managed `RVW_DATABASE_PATH` values are never chmodded by rvw;
missing components use secure creation modes, and doctor reports actual/recommended metadata without
turning a caller-managed warning into an automatic mutation.

### Trade-offs

- Agent writes can succeed without granting the Agent direct write access to the user-data directory.
- A viewer (or `rvw open --no-open`) must be running for the socket path; direct CLI behavior remains
  the fallback.
- The transport is intentionally local and user-scoped, not a persistent cross-user daemon. A 40 MiB
  frame cap matches accepted batched CLI input, while connection count and idle time remain bounded.

## 2026-08-12: Make PR synchronization worktree-explicit and accept behind-only branches

### Problem

The saved main checkout could contain unrelated untracked nested worktrees while a PR worktree was
clean. Sync rejected the saved checkout without identifying its path or entries. It also rejected a
clean local PR branch that was simply one commit behind an already-updated GitHub head.

### Choice

`pr sync --repository <path>` may select any worktree in the saved Git common directory, and
`pr attach` changes the saved path without launching a viewer. Dirty errors include the inspected path
and all porcelain entries. Tracked changes always block; untracked entries block unless the caller
explicitly passes `--allow-untracked` after inspection. rvw does not special-case directory names.

When the checked-out PR branch differs from GitHub head, rvw fetches the GitHub head into an internal
ref and accepts the state if local HEAD is an ancestor of either the current GitHub head or the last
synchronized GitHub head. The latter permits a force-push without misclassifying the previously
GitHub-visible commit as local-only. It never changes the worktree checkout; commits belonging to
neither GitHub history still block synchronization.

For reads that must distinguish the cached snapshot from current GitHub state,
`comment get --live` performs a read-only lookup and reports an explicit stale comparison without
updating SQLite. The default response reports null live fields rather than implying it contacted
GitHub.

### Trade-offs

- Unrelated untracked files are never silently ignored, while a clean PR worktree can be selected.
- Callers receive enough evidence to choose safely between cleanup, another worktree, and the explicit
  untracked exception.
- Behind-only synchronization reflects GitHub-visible state without updating the developer's branch.

## 2026-08-12: Anchor Markdown selection to source leaves and place composers in document flow

### Problem

Selections inside table cells and nested Markdown could resolve to a parent spanning several source
lines. The absolutely positioned composer could also cover a visually wrapped line that represented
one source line, making the target hard to read while writing a comment.

### Choice

Selection boundaries prefer the nearest parser-decorated source leaf before considering broader
ancestors. Markdown and table cells explicitly preserve native text selection. The action remains near
the selection, but the Markdown transform declaratively inserts a React-owned portal slot after the
selected semantic block and renders the composer in normal flow. Lists and tables receive the slot as
a valid sibling rather than an imperative child/sibling mutation. Code/diff file headers use the renderer's sticky-header support below the tab
strip, and the commit picker shows authored date/time beside the short SHA.

### Trade-offs

- A single nested line remains a single-line target even when its parent spans multiple source lines.
- Opening a composer shifts following content instead of overlaying the selected document.
- Composer placement follows semantic Markdown blocks rather than exact browser-wrapped visual lines.

## 2026-08-12: Distinguish bundled Skill updates from local customization

### Problem

A plain current-bundle versus installed-directory comparison can detect a difference but cannot tell
whether rvw shipped a newer Skill or the user intentionally customized the installed copy. Calling
both cases `updateRequired` encourages an unsafe forced replacement. Recursively hashing an arbitrary
installed tree also allowed an unreadable or symlinked asset to make all of `doctor` fail.

### Choice

Each successful rvw install writes an ignored `.rvw-install.json` marker containing the bundled
digest. Status compares the current bundle, installed content, and recorded digest to report a clean
managed update, local modification, or an unmanaged difference separately. Symlinks are hashed as
links rather than followed, inspection has entry/byte bounds, and an inspection failure is returned as
status instead of aborting every doctor check. Replacement still requires explicit `--force` for any
difference.

### Trade-offs

- Installs made before the marker existed cannot be retroactively classified as updates; they are
  reported honestly as unmanaged differences until reinstalled.
- Local edits remain protected even when a newer bundle also exists.
- The marker is installer metadata, not part of the Skill content digest or Agent instructions.

## 2026-08-13: Require every Walkthrough reference to be reachable

### Problem

After removing the duplicate `Code references` index, a reference declared in a Walkthrough but used
by neither its Markdown body nor a Mermaid binding has no viewer interaction that can open it. The
declaration still reaches an Agent through the CLI, which can make an explanation appear grounded even
though the human cannot discover or verify that reference from the rendered artifact.

### Choice

Require every supplied reference ID to appear in at least one parsed Markdown `rvw-ref:` link or as a
`diagramBindings` value whose key is an actual flowchart node or classDiagram class in the Markdown
body. Keep the existing inverse validation that every link and binding names a supplied reference.
Apply the bidirectional rule to both publish and in-place update before persistence; a phantom binding
does not make a reference reachable.

This rejects an input shape accepted by public protocol version 1, so advance the machine protocol and
both bundled Skills to version 2.

### Trade-offs

- Every stored reference is reachable from the Walkthrough surface that gives it explanatory context.
- Agents must remove speculative declarations or add the intended inline link or diagram binding.
- Existing stored Walkthroughs remain readable; only a later complete update must satisfy the stronger
  validation rule.

## 2026-08-13: Return the terminal after the first viewer connects

### Problem

An automatically opened viewer already uses browser-tab leases to decide when its local server should
stop, but the invoking `rvw open` process still occupied the terminal for the entire session. Closing
the browser controlled the useful lifetime, so keeping the shell attached added friction without
providing additional ownership.

### Choice

Make ordinary `rvw open` start a detached, per-viewer worker. The worker reports readiness over a
private parent-child channel; the parent then opens the browser and waits for the first viewer
heartbeat before returning control to the terminal. Browser launch failure, worker failure, or a
30-second initial-heartbeat timeout terminates the worker and remains a foreground error. After the
handshake, the existing viewer leases own shutdown and the worker stops after the last tab closes.

Keep `--foreground` as the explicit terminal-attached form and keep `--no-open` terminal-attached
because it has no browser lease that can establish ownership. Do not add a persistent daemon or a
cross-session process registry.

### Trade-offs

- The normal command frees the shell while browser tabs retain the lifecycle users already observe.
- Waiting for the first heartbeat prevents a silently orphaned worker when the browser cannot load the
  viewer.
- The implementation adds a bounded startup handshake and one short-lived worker process per open
  viewer.
- Users who need terminal-coupled diagnostics or Ctrl+C ownership can select `--foreground`.

## 2026-08-13: Keep the Mermaid comment composer mounted while typing

### Problem

The Mermaid fence renderer was created inside the Walkthrough render path and its composer draft lived
in the parent viewer state. Each character rebuilt the ReactMarkdown custom-renderer subtree, replaced
the textarea DOM, and returned the caret to the start. Typing `aiueo` could therefore produce `oeuia`.

### Choice

Use a module-stable Mermaid `pre` renderer and keep the diagram draft in a dedicated composer component
inside the selected diagram subtree. Pass the submitted body explicitly to the mutation instead of
sharing the selection/header draft. Normal React element identity is sufficient once the renderer type
and draft-owning component are stable, so do not add JSON signatures or callback-ref layers around the
Markdown tree. The E2E contract retains the original textarea DOM reference across input and checks
both the caret position and character order.

### Trade-offs

- Diagram typing no longer redraws Mermaid or loses browser selection state.
- Opening a different diagram intentionally mounts a fresh empty draft; cancelling or successfully
  submitting still removes it.
- The viewer carries a small context boundary for Mermaid rendering, while the Markdown protocol and
  stored comment model remain unchanged.

## 2026-08-13: Make explicit Agent sockets fail closed and elect one process atomically

### Problem

An explicitly configured Agent socket expressed operator intent but a missing, refused, or
database-mismatched connection still opened SQLite directly. Diagnostics did not reveal the selected
transport or fallback reason. Concurrent viewer takeover also relied on probing and unlinking the
socket alone, leaving a race in which separate Node processes could both believe they should own the
same name. Unix permission metadata did not prove that the selected database could accept a write.

### Choice

Supersede the fallback part of the 2026-08-12 Agent transport decision for
`RVW_AGENT_SOCKET_PATH`: explicit configuration is required and returns
`AGENT_SOCKET_UNAVAILABLE` without direct-database fallback. Keep pre-send fallback only for the
implicit database-derived socket. Add `rvw agent ping/status` and include socket path, connection
result, expected and remote database, owner PID, selected transport/database, and fallback reason in
diagnostics. Doctor reports the same transport inspection and a rollback-only write transaction.

Publish a `0600` owner lock with an atomic hard-link operation before probing, unlinking, or binding the
socket. A live or unreadable owner lock blocks takeover; after a dead owner, exact inode checks protect
both stale-lock removal and cleanup. Only the lock holder can listen, and followers retry after release.

### Trade-offs

- A misspelled explicit socket fails visibly instead of silently operating on a database the caller did
  not authorize as a fallback.
- Implicit operation remains convenient when no viewer is running and still exposes why it chose direct
  database access.
- PID liveness is local-process evidence rather than a durable lease, so exact inode identity remains
  necessary for safe stale cleanup.

## 2026-08-18: Render comment posts as context-bound Markdown without structured references

### Problem

Agent-created comments benefit from lists, code, tables, diagrams, and links to the evidence behind a
finding. Rendering post bodies as pre-wrapped plain text discards that structure. Reusing the complete
repository or Walkthrough renderer would also import semantics that comments do not have: Markdown
source-range targets, `rvw-ref:` declarations, interactive Mermaid bindings, and an independent
document identity.

Adding a `plain` / `markdown` format column would preserve the exact appearance of every existing post,
but it would add a migration and permanent dual rendering behavior before public release. Disabling
all context-bound features would keep rendering small but make Agent comments harder to verify against
the committed repository.

### Choice

Treat every existing and new post body as UTF-8 GFM Markdown source without changing the database or
CLI schema. Convert soft line breaks to visible breaks so ordinary historical text retains its current
line structure, sanitize allowlisted raw HTML, and keep editing as the original Markdown source.

Resolve repository links and relative images against an exact commit selected from the post's related
commit, repository target, current Walkthrough source, or thread creation head. Use the target file's
directory as the relative base for repository comments and the repository root for other targets.
Fetch only repository-relative images through the existing size-limited same-origin asset endpoint;
external images remain placeholders.

Extract the strict Mermaid rendering surface shared by Walkthroughs and comments. Comment Mermaid is
display-only, lazy while outside the viewport, and has no node binding or generated-SVG comment target.
Do not add comment-body source mapping or `rvw-ref:` support. Replies continue to target the enclosing
thread, while typed exact code references remain a Walkthrough capability.

### Trade-offs

- Existing posts containing Markdown punctuation may render differently, although ordinary text and
  line breaks remain readable without a data migration.
- Agent comments can carry inspectable repository evidence and compact diagrams without becoming
  standalone Walkthrough documents.
- Walkthrough comments follow the current Walkthrough source commit; a related commit on an individual
  post overrides that moving context.
- Large or numerous diagrams still have a rendering cost, reduced by collapsed-thread behavior,
  viewport deferral, and serialized Mermaid rendering.
- Adding typed references later would require an explicit post-level persistence and edit-validation
  design instead of silently accepting `rvw-ref:` syntax now.
