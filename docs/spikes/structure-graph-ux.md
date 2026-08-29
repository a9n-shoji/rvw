# Structure Phase 0: Graph UX Spike

Date: 2026-08-29

Status: **Go for a production-contract design phase, not for promoting this renderer to production.**

## Question under test

This spike tests one question:

> Does Structure provide a reading capability that is materially different from Walkthrough plus
> Mermaid?

The working distinction is:

> Structure is a space; Walkthrough is a path.

Each fixture therefore declares a bounded subject and scope. None claims to describe “the Pull Request
structure” or “the repository architecture”. Node, edge, label, and description text remain producer
claims. An anchor makes a claim inspectable at an exact source commit; RVW does not certify the claim's
meaning.

## Scope and temporary implementation

The spike adds a fixture-only `structure-spike` reading surface to the existing document workspace. It
does not add persistence, migrations, commands, protocol, a Skill, comments, reverse lookup, groups,
durable layout, framework adapters, AI, extraction, scoring, or generic Artifact infrastructure.

The temporary code is deliberately identifiable:

- `src/web/structure-spike/` contains the spike model, fixtures, visibility rules, collapse, and layout.
- `src/web/components/StructurePanel.tsx` exposes the fixture list below Walkthrough.
- `src/web/components/StructureViewer.tsx` is the custom graph surface.
- `src/web/styles/main.css` marks the complete CSS block with `Phase 0 only`.
- `structure-spike` branches in document workspace, tabs, reading history, and the PR review screen are
  temporary integration points, not a generic document or artifact registry.
- `test/unit/structure-spike.test.ts` and `test/e2e/structure-spike.spec.ts` cover spike behavior.
- `test/fixtures/structure-spike/rails-react-page/` is illustrative Rails / React source used only to
  exercise a cross-stack code neighborhood. It is not a framework adapter or a claim about RVW's stack.
- `test/e2e/fixture-server.mjs` has an explicit Structure-only allowlist that serves the current RVW
  worktree and illustrative fixture source for the interactive preview. The synthetic Pull Request OIDs
  do not name commits in this repository, so this is preview plumbing rather than an exact-commit
  production implementation.

No dependency was added and `package.json` / `pnpm-lock.yaml` are unchanged.

## Interaction implemented

| Capability         | Spike behavior                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node focus         | A single click selects a node without opening code, shows its description on the graph, highlights incident relations, and appends to a short focus trail.                                                  |
| Node notation      | A producer may explicitly choose class, database, interface, component, external, or concept notation. The Viewer never derives notation from the opaque `kind` string.                                     |
| Source affordance  | Anchored Nodes and relation labels reuse the file tree's extension icon and selected-range change icon, plus a separate `</>` control. Normal open uses the left pane; Cmd/Ctrl + open uses the right pane. |
| Pan / zoom         | Pointer pan, wheel zoom, explicit zoom controls, fit-visible, center-focus, and node dragging are available.                                                                                                |
| Neighborhood       | 1-hop, 2-hop, and All views recompute from the current focus. A minimap and `visible / total` status keep the full extent legible.                                                                          |
| Collapse           | A focused node above degree 12 keeps the first four incoming, outgoing, and undirected relations in stable input order. Hidden relations remain listed and can be expanded.                                 |
| Spatial continuity | A simulated current-value replacement retains positions for every common Node ID and places new IDs near already positioned neighbors.                                                                      |
| Source round trip  | Module-session state retains focus, trail, viewport, positions, collapse, and current-value selection when a source tab replaces the Structure tab in a pane.                                               |
| Details sidebar    | The claim, focus trail, and full relation list are available in a toggleable sidebar. It is closed by default so the spatial surface gets the full pane width.                                              |
| Mermaid comparison | The flow-comparison fixtures can open an equivalent Walkthrough Mermaid rendering beside an explanation of the interaction it lacks.                                                                        |

The Viewer calls the existing exact-source navigation contract with the Structure `sourceOid`. In the
local E2E preview only, the fixture server maps its fake Pull Request OID to allowlisted current-worktree
RVW files so every visible source affordance is actually operable. Production must read the real Git
object named by `source_oid`; the preview mapping must not become product behavior.

The Rails / React fixture declares two Phase 0-only preview change kinds so modified and added icons can
both be evaluated against its illustrative source. Real Viewer state takes precedence and production
must derive these icons from the selected commit range; change kind must not be persisted in Structure.
The same derived state selects a Node theme and tints relation-label outlines. Normal Node outlines mix
the change color with the existing neutral line; notation decorations, hover, neighborhood, focus
surface, and focus halo all use the same Node theme. The separate exact-source `</>` affordance retains
the product accent because it represents an action, not source change state. Relation paths themselves
remain unchanged.

### Label density correction

The first interactive pass exposed edge-label overlap with node labels. The current pass uses a fixed,
content-neutral BFS-rank gutter and tries geometry-only label positions in a stable order while avoiding
node and previously placed label rectangles. Node cards include the producer description. Only relations
incident to the focused node put labels on the canvas; those labels wrap to multiple lines and retain the
full text instead of collapsing to `…`. Their collision boxes are estimated from the rendered text width
and line count, including the source file/change icons. When all label-safe slots are occupied,
relation-label overlap is accepted before any deliberate overlap with a Node. The E2E test asserts that
real-fixture canvas labels do not intersect visible node rectangles and that a long relation label has no
clipped overflow.

### Node notation correction

Uniform rounded rectangles made the code-centered fixtures unnecessarily hard to scan. The current pass
adds familiar diagram notation for class compartments, a database cylinder, interfaces, components,
external boundaries, and concepts. Notation is an explicit producer-authored presentation field in this
spike. It is deliberately separate from opaque `kind`: both `RvwService` and `RvwDatabase` have
`kind: "class"`, while the producer chooses class and database notation respectively. The Viewer does
not contain a `kind === "database"` or framework-name mapping.

This improves the code-neighborhood fixture, but it also exposes a production-contract question: shape
is not merely decoration once readers attach meaning to it. A production design must either define a
small stable notation vocabulary or omit semantic shapes; it should not silently accept arbitrary
strings with renderer-specific meanings.

The visual pass also found two notation-specific collisions. Component tabs overlapped the description,
and the database cylinder's top ellipse crossed its `kind` line. The spike now reserves explicit content
insets for both decorations. A later pass found the concept capsule clipping the first character of its
top `kind` line, so its left content inset now clears the capsule curve as well. Edges remain behind Node
cards, but their start and end points are calculated at the rectangular Node envelope and moved 8 px
outward; arrowheads therefore stop visibly outside the card instead of being painted underneath it. E2E
checks the notation insets and verifies that no rendered edge endpoint lies inside its source or target
Node rectangle.

### Large-graph rendering correction

Rendering the 500-node All view initially put every off-screen node and edge in one transformed layer.
That produced visible compositor flicker even though the React render sample remained constant. The
spike now preserves the semantic All set but renders only nodes within a 520 px overscan around the
viewport, plus edges whose two endpoints are in that window. Pan changes the rendered window; the
minimap continues to show the complete Structure. Per-node CSS filters and forced `will-change` were
also removed.

In one browser sample at the initial 500-node All viewport:

- semantic set: 500 nodes and 975 currently uncollapsed relations;
- rendered window: 13 nodes and 8 relations;
- eight samples over roughly one second held the same 1.30 ms render measurement;
- the earlier full-DOM pass rendered 500 nodes and 975 relations at about 9.20 ms and visibly flickered.

These numbers are diagnostic samples, not a cross-browser benchmark.

## Fixtures

### Code-centered subjects

These are the primary fixtures for the intended Structure capability. They begin at a concrete class,
type, or module and describe code dependencies and collaboration, not execution order:

1. **RvwServiceのコード依存関係** — `RvwService` constructor dependencies, the composition root,
   domain helpers, error/policy modules, and inbound HTTP / Agent adapters. A reader can move outward
   to dependencies or inward to consumers without accepting a prescribed path.
2. **document-workspace moduleの関連コード** — `ActiveDocument` and `DocumentWorkspaceState` with
   identity helpers, state mutations, the React hook, tabs, history, draft movement, and derived Viewer
   state. Shared types and fan-in are more important than any runtime sequence.
3. **GitClientの境界と依存関係** — `GitClient`, its process adapter, native Git boundary, output
   parsers, exact-source reader, retained refs, search, domain return types, and application consumers.
4. **Rails ViewとReact rootをまたぐ求人検索ページ** — an illustrative, source-backed Rails / React
   page centered on the View / DOM mount / React entry boundary. Controller, service, policy, model,
   serializer, and payload contract expand to the left; the page component and its children expand to
   the right. This fixture tests code collaboration across a web boundary, not request execution order.

These fixtures do not expose a Mermaid comparison button: adding an author-arranged equivalent would
reintroduce a reading order that their subject does not claim. The RVW fixtures begin at a concrete code
origin named in the scope. The Rails / React fixture instead begins at an unanchored boundary-contract
claim, with its two incident edge anchors providing inspectable evidence on the View and React entry.

### Flow-comparison RVW subjects

1. **コメント監視フロー** — from an ordinary comment write through the database-wide post event
   sequence, CLI framing, external watch driver, task-local state, capacity, acknowledgement, worker,
   and final edit. It includes a feedback cycle because the final reply is itself another normal event.
2. **Walkthrough公開フロー** — from the authoring Skill through CLI input, application validation,
   reference validation, SQLite replacement, and viewer refresh.
3. **文書と2ペインのナビゲーション** — from an explicit code/source affordance through document
   identity, workspace pane routing, navigation target, exact source, and reading-history restoration.

These three are retained as comparison controls. Authoring them exposed that a causal lifecycle is
usually better owned by Walkthrough; they are not the primary evidence for adding Structure.

The fixtures use current repository paths and line ranges where practical. They intentionally mix
source-anchored claims with concept claims, long labels, cycles, fan-in, fan-out, and shared contracts.
All anchor paths and ranges are checked against the repository by the unit test.

### Synthetic subjects

- 20 stable nodes;
- 100 stable nodes;
- 500 stable nodes.

Each combines linear areas, fan-out, fan-in, shared dependencies, cycles, and a disconnected tail. The
current-value fixture removes two IDs and adds two new stable IDs to exercise continuity. Synthetic
claims exist only for rendering and interaction measurement; they are not architecture examples.

## Walkthrough Mermaid comparison

### コメント監視フロー

Mermaid communicates the author's lifecycle sequence compactly. It is the better surface when the
reader accepts that sequence as the question. Structure is materially different when the reader starts
at the ordered event log, moves upstream to the write transaction, downstream to cursor paging, or
follows the final-edit cycle without losing the original graph position. Focus, neighborhood density,
relation Inspector, and source round trips make the subject queryable rather than merely zoomable.

### 文書と2ペインのナビゲーション

Mermaid is effective for presenting the intended navigation contract in one overview. Structure is
stronger for questions such as “what consumes the source affordance?”, “which state preserves the
origin tab?”, and “where is exact-source selection decided?”. The same node can be entered from those
different questions, and opening source does not discard the graph session.

### Walkthrough公開フロー

This is the weakest differentiator. Much of the subject is a causal publishing path, so Walkthrough is
naturally good at it. Structure helps only where validation, persistence, CLI, and refresh become
shared/fan-in boundaries. If future real subjects look mostly like this fixture, improving Walkthrough
Mermaid would be preferable to adding a Structure artifact.

## Viewer UX findings

- **Start anywhere:** yes. Node selection, descriptions on the cards, the optional details sidebar, and
  recentering make arbitrary entry practical.
- **Understand local relations:** yes for 1-hop and 2-hop. Relation labels must remain close to the
  focused node in the Inspector; an All view alone is not understandable.
- **Return from source:** yes in the tested browser session. The focused Node ID and its positions remain
  when the Structure tab is reselected, and Cmd/Ctrl opens exact source in the other pane.
- **Know where you are at 100+:** conditionally yes. Focus status, trail, local density, minimap, and
  viewport culling work together. A raw 500-node All view remains an overview/navigation surface, not a
  readable diagram.
- **Explore more freely than Mermaid:** clearly yes for the four code-centered subjects because class
  consumers, dependencies, shared helpers, cross-stack contracts, and related symbols can be entered in
  either direction. The advantage is weak for the mostly linear publish subject.
- **Survive updates:** yes for the simulated session-local replacement. Stable IDs, not labels or array
  positions, carry orientation.
- **Long labels:** workable for focused relations after multi-line rendering and collision placement.
  Edge labels cannot all be permanently visible, so focus-driven disclosure remains essential rather
  than an optional polish.

## Producer ergonomics findings

- A declared subject and one-sentence scope were natural for the six RVW fixtures and the additional
  illustrative Rails / React fixture. The code-centered scopes were more precise because a named class,
  type, module, or explicit cross-stack boundary provided a concrete center. “Repository architecture”
  would have been substantially harder and was not needed.
- Concept nodes were useful and not exceptional: the ordered event sequence, document identity, pane
  routing rule, and current-value refresh boundary are meaningful claims without being single symbols.
- Node boundaries were reasonably stable when each node stated one structural claim. Combining the CLI,
  application, and persistence into one “watch service” node immediately made relations less useful.
- Edge labels were the highest-cost authoring decision. Verb phrases such as “appends event in the same
  transaction” were clearer than taxonomy names, but deciding the exact level of detail took more effort
  than choosing `kind`.
- Multiple node sources were wanted occasionally. Splitting distinct responsibilities into nodes, or
  putting the evidence for a relation on the edge, handled the real fixtures without changing the
  zero-or-one primary node-anchor rule.
- Graph modeling was natural for shared dependencies, cycles, fan-in, and alternate entry questions. It
  was less natural for a single causal sequence; that content should remain a Walkthrough.
- Code-centered authoring made edge direction easier to state: “imports”, “constructs”, “implements”,
  “owns”, and “consumes” were more stable than lifecycle wording. The main remaining judgment is whether
  a helper deserves its own Node or only relation evidence.
- Opaque `kind` strings helped scanning but were not needed for layout, collapse, visibility, or any other
  Viewer behavior.
- Familiar node notation reduced the cost of distinguishing concrete classes, the SQLite boundary,
  interfaces, modules/components, and callers. Choosing notation was easy for these fixtures, but it is
  an additional producer decision and must remain explicit rather than inferred from `kind`.
- The Rails / React exercise exposed a natural concept node: the DOM mount contract has no single primary
  source, while the View and React entry each provide evidence on an incident relation. This preserved
  the zero-or-one primary node-anchor rule without pretending that either side alone owns the boundary.
- A full web-page subject easily slips back into Walkthrough if its edges are written as request steps.
  Centering the declared subject at the View / React boundary and labeling code collaboration—assigns,
  serializes to, exposes, parses, mounts, and passes props—made the same source useful as a Structure.

This is still one repository and one producer exercise. A future design phase should run at least one
fixture-authoring trial by someone who did not implement the Viewer before treating the producer cost as
settled.

## Graph and layout selection

The spike uses React HTML nodes on a transformed world with SVG relation paths. The default deterministic
BFS-rank layout uses stable node input order, fixed row/column strides, and fixed rank gutters. The Rails
/ React fixture also exercises a Phase 0-only bidirectional orientation: incoming relations from
`initialFocus` receive negative ranks on the left, outgoing relations receive positive ranks on the
right, and ties retain stable input order. It does not inspect edge labels, node kinds, or frameworks.
The layout selector is fixture metadata, not a proposed Structure artifact field. No graph library was
added.

Reasons:

- the uncertain part was focus/neighborhood/source/collapse behavior, not an exhaustive layout engine;
- the repository already has Mermaid for authored diagrams, so reusing Mermaid would weaken the test;
- pan, zoom, dragging, dynamic replacement, and 500-node viewport culling required only a small custom
  surface for this phase;
- avoiding a new dependency keeps the temporary implementation removable and the lazy Structure chunk
  at about 22.7 kB raw / 8.0 kB gzip.

Constraints learned:

- the deterministic layout is intentionally coarse and does not optimize edge crossings;
- reciprocal and parallel relations need distinct lanes even when Nodes retain fixed positions. The
  spike assigns a perpendicular offset from the unordered Node-ID pair and stable Edge-ID order; it does
  not inspect direction labels, kinds, descriptions, or inferred importance;
- direction-derived left/right orientation works well for a producer-declared boundary, but fitting five
  visible ranks into one pane makes text too small; local 1-hop/2-hop exploration and pan remain necessary;
- multi-line collision placement is sufficient for focused relations, not for globally displaying every
  label;
- viewport culling is required for the 500-node All view;
- a production renderer should compare dedicated graph libraries using these exact fixtures and
  interactions, but library adoption should not precede the artifact contract.

## Spatial continuity findings

`reconcileStructureLayout` copies positions for common Node IDs exactly. New nodes take the average of
already positioned neighbors plus a deterministic ID-derived offset; disconnected additions use the
new graph's fallback layout. Removed IDs disappear without relayout of survivors.

The unit test checks every retained node in the 20-node update. The browser E2E also observes
`node-000` at `80.00,80.00` before and after the current-value replacement. This is enough to preserve a
session mental map for additive changes. It is not a general constraint solver: a large update can put
new nodes in crowded positions, and manual node drags are not durably saved.

## Collapse findings

The spike rule is:

1. collapse only when focused degree is greater than 12;
2. partition relations by incoming, outgoing, and undirected/self;
3. retain the first four in each partition using stable fixture input order;
4. expose every hidden relation in the Inspector and make expansion reversible.

The code-centered `RvwService` fixture exercises this rule with 13 incident relations. Its initial
presentation retains four incoming consumers and four outgoing dependencies; the remaining five
relations stay visible in the Inspector and can be expanded. This is a more representative collapse
case than the synthetic hub because every relation is a real code claim.

It is content-neutral: label, description, kind, notation, framework, and inferred importance are never
read. It also makes the trade-off visible instead of pretending to select important relations.

Two limitations matter for production:

- input order must be a declared stable contract; inserting or reordering earlier edges changes the
  collapsed presentation even when IDs are stable;
- hiding focused incident relations does not necessarily hide their neighbor nodes if those nodes remain
  connected through another visible relation. “collapsed relation” and “collapsed branch” are different
  contracts and should not be conflated.

For production, lexical Edge ID order is more update-stable unless producer-authored presentation order
is made an explicit field/contract. The spike should not silently define that choice.

## Go / No-Go decision

**Decision: Go to a production-contract design phase. Do not promote the spike renderer or its fixture
document kind directly.**

Evidence for Go:

- the four code-centered subjects are materially easier to enter from a reader's own question than an
  author-arranged diagram: “what does this class depend on?”, “who consumes this type?”, and “where is
  this boundary implemented?” can begin at different Nodes in the same space. The Rails / React boundary
  additionally lets the reader expand toward either backend data assembly or frontend component use;
- node click, local relation movement, reversible collapse, pan/zoom, and source round trips keep the
  reader inside one exploration session;
- 500 nodes can remain in the semantic space while only a manageable neighborhood is drawn;
- stable IDs preserve common-node positions across a current-value replacement;
- the real subjects could be modeled without Viewer semantics, framework rules, multiple primary node
  anchors, or an invented importance score;
- the flow fixtures act as a useful No-Go control: when the subject is mainly a causal sequence,
  Walkthrough remains the better artifact.

Conditions and No-Go signals for the next phase:

- do not proceed if independent producers cannot define subject/scope and verb relations consistently;
- do not proceed if real usage mostly resembles the linear publish fixture;
- do not proceed if a production layout needs semantic filtering to remain usable;
- keep Walkthrough Mermaid interaction improvement as the fallback for author-led diagrams;
- consider stronger document/workspace navigation primitives if source round trips, rather than graph
  exploration, prove to be the only durable benefit.

## Contract questions before production

If Structure advances, change or clarify the proposed contract before implementation:

1. Store `source_oid`, `title`, and `scope` once outside `graph_json`; keep only `initialFocus`, `nodes`,
   and `edges` in the JSON value. Do not duplicate fields.
2. Define Structure source navigation as exact `source_oid` navigation. Do not silently inherit
   Walkthrough's latest-head resolution without an explicit product decision.
3. Require unique, non-empty stable Node and Edge IDs and validate every endpoint. IDs must not be derived
   from labels.
4. Keep `initialFocus` optional and singular, and explicitly state that it is a viewport/selection origin,
   not importance or reading order.
5. Validate SourceAnchor line coordinates as an all-or-none pair with positive `startLine <= endLine`.
   A node keeps zero or one primary anchor; an edge may keep an ordered anchor list.
6. Decide whether edge array order is durable producer-authored presentation order or whether collapse
   uses stable Edge ID order. The Viewer must not infer meaning.
7. Define current-value replacement as an atomic graph value with stable IDs. Do not persist layout in
   Phase 1 unless real sessions demonstrate a cross-session need.
8. Define whether collapse hides relations only or whole branches. The spike implements relation collapse.
9. Preserve the existing left/right document navigation contract and add a permanent Structure document
   type directly if needed; do not introduce generic Artifact repositories or renderer registries solely
   for this feature.
10. Decide whether producer-authored node notation belongs in the graph contract. If retained, define a
    small stable vocabulary independently from opaque `kind`; never infer it from framework or class names.
11. Do not add producer-authored layout or a `layout` value to the artifact contract based on this sample.
    First compare renderer-selected bidirectional orientation against dedicated graph layout engines;
    any default must remain content-neutral and must preserve stable IDs during current-value updates.
12. Derive file extension and change-status icons from SourceAnchor paths and the active commit range.
    Do not add file type or change kind to the Structure graph value.

## Verification

- Unit tests validate fixture groups, code-centered non-linear neighborhoods, explicit notation independent
  of `kind`, IDs, endpoints, anchors, content-neutral collapse, neighborhood behavior, retained positions,
  and 500-node layout/filter cost.
- E2E covers code-centered class/dependency exploration, the Rails View / React boundary expanding to
  both sides, source navigation from its illustrative `.erb` file, node focus, 1-hop/2-hop expansion,
  label/node non-overlap, notation decoration insets, edge endpoints outside Node rectangles, normal-left
  and Cmd/Ctrl-right source navigation, focus restoration, Mermaid comparison, reversible collapse,
  update continuity, zoom, fixture isolation, and 20/100/500-node rendering.
- Production build and strict TypeScript checks pass. Existing large-chunk warnings remain unrelated; the
  Structure surface is lazy-loaded and introduces no dependency.
