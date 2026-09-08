# Structure producer evaluation

## PR-scoped file-map evaluation (2026-09-08)

This section evaluates the new file-map authoring role without changing the Structure schema or
publishing into a reviewer environment. The implementation baseline was
`2a2d9dcd4da7b227db4ebc71f297a1e45ba86787`. The first implementation fixtures were authored with:

- `skills/rvw-structure/SKILL.md` Git blob
  `e1dd9c60f72180da1a8dbe0142f1e47dd70a1390`
- `skills/rvw-structure/references/structure-authoring.md` Git blob
  `6c25d6dbe2dab38be8703f32c840d0439df1770a`

After audit, the Skill clarified that a file map rejects a _generic repository-wide_ responsibility
inventory, not its own PR-scoped responsibility descriptions. A fresh singleton rerun and the PR #24
independent-area audit re-read the resulting final content:

- `skills/rvw-structure/SKILL.md` Git-compatible content blob
  `f8cf78e287d6824c869ea3e5be4353cbd0d20bd7`
- `skills/rvw-structure/references/structure-authoring.md` Git blob
  `6c25d6dbe2dab38be8703f32c840d0439df1770a`

The earlier fixtures remain exact-source examples and automated regression inputs; they are not
relabeled as fresh producer generations under the final Skill blob.

The principal examples use main-line commit
`f9416d959dbb79f95dd75d96bafeb6156155f5c8` (`Add adaptive review composition skill (#76)`) so
their anchors remain inspectable from the current history:

- [PR file map](examples/structures/review-composition-file-map.json) asks where the bounded
  composer/producer handoff is implemented. Each Node is one repository file with a file-level anchor;
  the unchanged `src/cli/main.ts` is included because it constructs the Skill installer that exposes
  install/status, while unrelated changed metadata, release notes, and evaluation surfaces are named as
  exclusions rather than silently omitted. Every Edge has a specific use, verification, or distribution
  anchor. The map does not claim complete impact coverage.
- [Behavior/authority Structure](examples/structures/review-composition-authority.json) asks who owns
  scope, independent semantic verification, representation rejection, and recomposition. It deliberately
  uses several responsibility Nodes in the same files at exact line ranges. This is independently useful
  from, and cannot substitute for, the physical file map.
- [Single-file map](examples/structures/single-file-map.json) uses main-line commit
  `eb28386c007eb77b9028e720b5b1532013a8f0bb` and represents a documentation-only change as one real
  file, zero Edges, and `presentation: null`. It does not invent a runtime entrypoint, dependency,
  backbone, or Region. A fresh context using the final blob independently re-derived this shape,
  validated the one changed path against its first parent, and passed content schema and CLI preview.
- [Watch acknowledgement map](examples/structures/pr24-watch-batch-file-map.json) and
  [reply-draft map](examples/structures/pr24-reply-draft-file-map.json) use the same PR #24 head
  `0f43f131b70d227dbd76bec7d07218e3395ad442` but share no represented file or relation. The first maps
  batch-operation state, its unchanged auto-ack consumer, the Skill contract, and focused tests. The
  second maps the client draft owner, unchanged change-sequence/render/reset consumers, and focused tests. Direct
  source inspection found no material implementation dependency joining the two; broad documentation
  and compact CI-history mechanics remain explicit direct-code boundaries.

Automated example checks parsed all five values with the production protocol-v5 schema, required each
`sourceOid` to resolve to a commit in the local Git object store, read every path from the named Git object, checked every line
range, enforced one unique file-level path per file-map Node, required specific Edge evidence, and
distinguished the behavior Structure's finer-grained Nodes. The built CLI preview accepted both
implementation multi-file Structures without warnings. It accepted both PR #24 maps and the singleton
with the expected diagnostic that a zero-outgoing origin needs a role-aware verification check; that
warning did not cause a fabricated Edge. The preview outputs were five columns / three rows for the
composition file map, four / two for the authority Structure, and one / one for the singleton. After the
reply-draft map gained one verified App-to-viewer wiring Edge during final audit, the two PR #24 results
were three columns / three rows and four columns / three rows respectively.

These checks establish schema validity, exact source coordinates, the authored example invariants, and
projection compatibility. They do not mechanically prove that each responsibility sentence or Edge
predicate is the best semantic account of the source; those claims were reviewed qualitatively against
the cited code. The PR #24 pair was authored as separate content candidates in one audit context, not as
two installed-host producer invocations. No installed-host producer activation, existing-Artifact
discovery/update, publication, URI readback, or human Viewer interaction was performed for these
examples. Historical behavior-only producer trials remain below and are not evidence for this
instruction revision.

## Historical behavior-Structure trial

This record captures the production authoring trial performed while implementing Structure. The
examples were authored from a fresh inspection of repository commit
`e1702ec717f2c9eae88ab9debd63a7a8e7e70864`; they were not copied from the Phase 0 spike fixtures.
They are complete protocol-v5 Structure content/preview values, including required nullable
`presentation`. A caller adds `pullRequest` and `idempotencyKey` to publish one, or
`expectedUpdatedAt` to update an existing Structure in place. Automated tests parse the production
schema and verify every anchor against that exact Git object.

After the protocol-v5 presentation contract was tightened to an explicit attention start, an optional
connected exact-Edge backbone, and stable named exact-membership Regions with responsibility summaries, all three values were run through the built
production `structure preview --stdin --json` path again. They passed without warnings: Agent transport
reported 5 columns with at most 2 rows, Markdown source mapping reported 4 columns with at most 2 rows,
and Skill distribution reported 3 columns with at most 2 rows. These preview metrics deliberately
describe factual topology diagnostics; they do not freeze the Viewer's presentation-aware coordinates
or region packing as protocol semantics.

## Generated Structures

### Agent transport boundary

- Example: [agent-transport-boundary.json](examples/structures/agent-transport-boundary.json)
- Result: six nodes and six edges represented the CLI selection, socket client, validation, schemas,
  dispatch, and diagnostic policy at one consistent boundary level, beginning at the CLI service-call
  entrypoint.
- Presentation observation: the thesis names the boundary, the path-shaped exact-Edge primary backbone prioritizes the
  CLI-to-dispatch backbone, and two disjoint regions place transport diagnostics beside the client
  segment and operation schemas beside validation/dispatch. Their summaries state how those chunks
  contribute to the boundary thesis. No Edge direction or predicate was changed to obtain canonical
  placement; its Edge array carries membership rather than reading order.
- Scope/granularity observation: excluding socket ownership and viewer lifecycle kept the subject a
  relationship space. Adding those lifecycle operations made the graph turn into a startup sequence
  and would be better handled by a Walkthrough.
- Concept-node observation: no unanchored concept node was needed; the transport policy was directly
  anchored to `inspectAgentTransport`.
- Edge-label observation: labels such as `attempts through`, `gates`, and `probes with` remained useful
  without implying visual order.

### Markdown source mapping

- Example: [markdown-source-mapping.json](examples/structures/markdown-source-mapping.json)
- Result: six nodes and seven edges exposed how the source-map plugin entrypoint establishes one shared
  source-position contract used by decoration, highlights, comment placement, and selection recovery.
- Scope/granularity observation: function-level nodes were appropriate because each represented a
  distinct mapping responsibility around one contract; splitting helpers such as `overlaps` or
  `addClass` would only mirror implementation detail.
- Concept-node observation: no concept-only node was necessary. `Markdown source positions` was an
  anchored type-level claim.
- Edge-label observation: repeated `runs` labels were precise for composition edges, while data use
  required different labels (`reads decorated leaves from`, `locates blocks with`).
- Source-led observation: beginning from the changed source-map plugin file did not make that file the
  Structure subject. Inspection first identified the concrete source-position mapping behavior and its
  plugin entrypoint; the resulting map then included only responsibilities participating in that
  behavior. Unrelated uses of the same Markdown utilities remained outside the Structure.
- Presentation observation: this fan-out/convergence space uses one nonlinear exact-relation backbone.
  The selected branch and convergence Edges jointly expose how plugin composition meets the shared source-position
  contract without manufacturing one linear route. Three stable named chunks retain the composition,
  rendered-coordinate, and independently usable review-interaction boundaries without assigning a
  reading order to the Region array.

### Bundled Skill distribution boundary

- Example: [skill-distribution-boundary.json](examples/structures/skill-distribution-boundary.json)
- Result: six nodes and seven edges connected the Skill CLI entrypoint to bundle discovery, status
  comparison, atomic install, package inclusion, and the package smoke test.
- Scope/granularity observation: the individual behavior of the three bundled Skills at the evaluated
  commit was excluded. Including their workflows would mix distribution mechanics with unrelated
  authoring domains.
- Concept-node observation: `Published Skill assets` is not an abstract architecture placeholder; it
  is anchored to the package file list. No unanchored concepts were required.
- Edge-label observation: multiple anchors were useful for `supplies assets to` because the claim is
  jointly established by the publisher and bundle locator.
- Presentation observation: `null` deliberately keeps this graph as a topology-derived comparison case.

## Presentation dogfood criteria

Start evaluation with a source-consistent thesis and attention start, then add the smallest honest
combination of one optional connected exact-Edge primary backbone and stable named Regions. A start-only presentation
is valid when its thesis and start add useful authorial orientation but no honest spatial organizer exists;
it deliberately keeps topology-derived canonical geometry. Multiple authored routes make priority
ambiguous and drift toward Walkthrough; one connected relation skeleton instead supports path, hub,
fan-out, convergence, reciprocal, and small cyclic shapes. A graph may still use regions without a
backbone when no exact relation set deserves privileged emphasis, or remain start-only when no named chunks are honest.
For each dogfood subject, compare the non-null presentation with the same factual
graph set to `null` and record:

- whether a reviewer can state the behavior, the exact-relation backbone to grasp first, and the meaning of each region
  after an initial scan, without mistaking derived visual ranks for runtime order or architectural importance;
- whether the start is current and belongs to a non-null backbone, every selected exact Edge is current,
  the derived 2–12 Node skeleton is weakly connected, region membership is disjoint, and backbone Edge /
  Region / region-member array order is not treated as semantic;
- whether an organizer-bearing presentation improves canonical placement, while a start-only presentation
  keeps null-equivalent topology geometry and still improves overview, initial focus at `startNodeId`, cues,
  and export;
- whether every off-backbone and unassigned Node, every Edge and direction, free focus/pan/zoom/drag, and every
  source action remain available and understandable;
- whether the thesis and Region labels/summaries synthesize source-supported authorial orientation instead
  of becoming review conclusions, completeness claims, generic subsystem categories, decorative group names,
  or an authored second relation graph;
- whether cross-Region connections shown by a renderer are explainable by direct factual Edges, remain
  truthful with parallel/reciprocal relations, and do not imply a transitive or authored Region relation;
- whether an author can produce a valid presentation without coordinates, relabeling factual Edges for
  layout, or expanding the bounded behavior into an inventory.

A trial fails the product boundary if sequential prose is required to explain transitions, reviewers
expect autoplay, the presentation hides evidence, or the map is useful only as a static architecture
catalog. Route those subjects to Walkthrough, a deliberate start-only presentation, or
`presentation: null` according to whether a thesis and attention start add real value; do not add another route or authored layer.

## Producer contract adjustments

The trial confirmed that behavior, entrypoint, and scope must be declared before graph expansion,
stable IDs must identify claims rather than labels, and relationship labels should use factual verbs.
Behavior-led requests can establish these directly; source-led requests first reverse-discover the
concrete behavior and its factual origin from the selected code without widening the artifact into a
file or module inventory.
It also exposed two rejection boundaries: “viewer startup from command to browser connection” was a
required ordered flow and belongs in a Walkthrough, while a timeless subsystem responsibility catalog
had no PR-review stopping condition and does not belong in Structure.

The production Skill therefore makes the Structure/Walkthrough choice explicit, requires a factual
entrypoint for new authoring, permits unanchored concept nodes only under declared authority, treats all
anchors as claims at one exact commit, and requires in-place updates to retain IDs only for surviving
claims of the same subject. Its presentation contract adds one source-consistent thesis, one attention
start, at most one connected exact-Edge primary backbone, and named comprehension Regions without adding
raw layout or reviewer-session state. Regions carry stable identities, concise responsibility summaries,
and unordered disjoint membership; outer array order is not presentation semantics. It permits
start-only presentation rather than manufacturing
a backbone, region, or geometry claim where none is honest.
