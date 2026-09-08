# Structure authoring contract

Use this contract when creating a Structure or materially replacing its current value. It supplies
defaults only where explicit instructions are silent.

## Establish subject authority

Apply inputs in this order:

1. Explicit directions from the user, caller, Pull Request body, or upstream Skill define the subject,
   authoring role, review question, behavior or file-map boundary, scope, inclusions, exclusions,
   emphasis, and requested spatial presentation. These choices are authority over what to investigate
   and how to present it, not proof of what the code does.
2. Treat `mustEstablish`, suggested origins, relationships, invariants, and every other factual
   implementation assertion as claims to verify independently in committed code, tests,
   and source-controlled contracts. Use Pull Request context for authoring direction or attributed
   intent, not as proof of current code behavior. Never treat the caller's conclusion as its own
   evidence.
3. Put hypotheses, uncertain connections, and relations that are not directly established by source
   in the Agent's normal response, not in the Structure.

A factual assumption remains a claim to verify even when it appears inside an authoritative field.
Exact anchor validity proves only that the source location exists, not that a Node or Edge description
is semantically true. Explicit off-repository intent may control the requested subject when it is
attributed as external context, but it does not establish current code behavior. When source supports a
different answer without changing the central question or scope, use the supported answer. When an
essential claim or origin is unsupported or contradicted and resolution would change the question, role,
or boundary, do not publish it; return the conflict to the requester or upstream composer.

## Choose one authoring role

Author exactly one Structure in one of two roles. Both roles use the existing Structure schema. Do not
add a role field, file Node kind, notation, public JSON field, or deprecated compatibility mechanism.
Make the chosen role and boundary clear in the title, scope, brief, and authored claims instead.

### Behavior / review-question Structure

A useful subject states one bounded PR-relevant behavior or review question and the factual code
entrypoint from which a reviewer can begin verifying it. Its scope says which direct responsibilities,
dependencies, contracts, state ownership, and side effects are needed to answer that question and what
it deliberately excludes. A data model, subsystem, file, or responsibility belongs only when it
clarifies that behavior; a static inventory of them is not this Structure's subject.

If the request starts from a file, symbol, module, or changed source rather than a named behavior, use
that source only as the discovery entry. Identify the one concrete PR-relevant behavior requested, then
locate that behavior's factual origin. If the source participates in multiple independently triggered
behaviors, do not join them and do not create multiple Structures from this producer request. Follow an
explicitly supplied boundary; otherwise return candidate boundaries to the requester or upstream
composer.

### PR-scoped file map

A file map answers which real repository files matter to understanding a declared Pull Request or
change scope, what responsibility each has in that change, and which concrete inter-file relationships
connect them. It is a map of physical implementation locations for this review, not a repository-wide
architecture tour, a changed-files checklist, a diff recap, a generated import graph, or a claim that
impact analysis is complete.

Inspect changed files plus any unchanged caller, consumer, dependency, type or contract definition,
state owner, wiring, configuration, test, migration, or documentation file needed to understand the
change. Include a file because its responsibility or relationship matters to the declared change, not
merely because it changed or belongs to a favored file category. Conversely, do not mechanically omit
tests, configuration, migrations, documents, generated artifacts, lockfiles, or repetitive support
files: inspect their actual content and include them only when they materially establish a responsibility
or contract in scope. Do not silently omit a major changed area. Use the scope and completion response to
state what is included, what is intentionally excluded, and which local conditions, branches, exceptions,
or peripheral details remain for direct code reading.

The file map's authoring granularity is exclusive: every Node is one file. Do not mix files with
functions, concepts, invented subsystems, logical responsibilities, or a synthetic “whole PR” Node. If
the review needs a responsibility, state-ownership, contract, or side-effect map at another granularity,
that is a separate normal Structure and requires a separate producer invocation.

Before authoring, test the requested shape. Structure may direct initial attention and organize the
overview around one connected backbone, but all relationships remain available and independently
explorable even when the Viewer uses a local lens. If the meaning depends on prose between sequential stops, a required ending, or
route transitions rather than the visible relationship space, it is not a Structure. Stop and recommend a
Walkthrough. Edge direction is factual and is not the authored spatial order. If the behavior /
review-question subject has no factual code entrypoint and is useful only as a timeless architecture
diagram, stop without publishing a Structure. A file map may instead begin verification at an honestly
chosen real file without claiming it is a common runtime entrypoint, but it must still be grounded in the
declared Pull Request or change scope.

## Select nodes as claims

Each Node is a producer claim whose meaning and granularity follow the selected role.

For a behavior / review-question Structure, prefer symbols, modules, boundaries, contracts, persisted
models, or small cohesive subsystems that a reviewer can verify in committed code.

- Keep one level of abstraction around the stated subject. Split a node when its label joins multiple
  independent responsibilities; merge nodes that only reproduce neighboring source lines.
- Use concept nodes without anchors only when their description is source-supported across several
  sites but has no single exact range, or when a minimal label connects anchored code claims without
  adding semantics beyond those source-supported claims. A request may make a concept relevant to
  investigate, but does not make its implementation semantics true. Do not use unanchored concepts to
  invent product semantics.
- `description` states the claim and its role in this subject. It is not a review finding, approval, or
  recommendation.
- Keep the `label` and `description` short enough that a reviewer can grasp the node's main claim at
  normal zoom. In-node scrolling preserves exceptional detail; it is a fallback, not a reason to make
  long prose the normal authoring shape.

For a PR-scoped file map:

- One Node means exactly one repository file that exists at the Structure's `sourceOid`. Do not split
  one path across multiple Nodes and do not combine multiple paths in one Node.
- Every Node has its own source anchor for that file. Use a file-level anchor by omitting both
  `startLine` and `endLine`; do not substitute a convenient symbol range for the file identity.
- Make the file identifiable from the `label`. A basename is sufficient when unique and unambiguous;
  when basenames repeat, include enough repository-relative path context to distinguish them.
- Write a short `description` of the responsibility the file carries specifically for understanding
  this Pull Request. Do not summarize the file's entire contents or enumerate its diff. When unrelated
  or mixed responsibilities genuinely coexist in the file, say so briefly rather than polishing them
  into one fictitious responsibility. A separate behavior / review-question Structure may map the
  distinct internal responsibilities at exact ranges when that relationship has independent value.
- Do not use unanchored concepts, functions, classes, logical subsystems, or a synthetic PR Node to fill
  gaps or connect components. File granularity is expressed through the existing Node and anchor fields,
  not through a new `kind`, `notation`, or other schema convention.

The following representation rules apply in either role:

- `kind` is a deprecated compatibility field that the viewer does not display. Do not set it in new
  Structures.
- `notation` is an optional controlled scanning aid: `plain`, `class`, `database`, `interface`,
  `component`, `external`, or `concept`. Choose it only when the familiar visual pattern helps a reviewer
  distinguish the claim. Do not infer it mechanically from legacy `kind`; omit it for the default
  `plain` card.
- In a behavior / review-question Structure, prefer the smallest meaningful multi-line anchor that
  verifies the Node claim. Use a file anchor only for genuinely file-wide responsibility and a
  single-line range only for a line-local declaration.
- Within one file in a behavior / review-question Structure, merge overlapping or nested Node anchors
  unless each Node expresses a distinct,
  independently explainable code-centered responsibility. Do not represent both an entire method and
  each of its branches as overlapping Nodes; when branches are the claims, normally omit the parent
  method Node. Anchor each Node to the smallest meaningful, preferably non-overlapping range. A
  file-wide anchor will overlap most other Nodes in that file, so use it deliberately. Overlap is not
  an error, but retained overlap must support distinct responsibility claims.

Do not create giant graphs, one Node per function, inferred runtime call graphs, dependency graphs
obtained only from import syntax, or concept-only diagrams detached from code. In a behavior /
review-question Structure, do not create a file inventory. In a file map, do not turn the permitted
PR-scoped file granularity into a generic repository inventory. When following the current behavior or
file relation reaches an independently scoped subject, stop at the current boundary. Report the adjacent
subject when materially relevant, but do not author another Structure from this producer invocation. Do
not keep expanding merely because more static responsibilities or imports are connected.

## State relationships precisely

Each edge is a producer claim about how two nodes relate in this subject.

- Use a short verb or verb phrase: `calls`, `constructs`, `validates`, `persists`, `loads`, `implements`,
  `emits`, `renders`, or another fact supported by the source. As a practical authoring target, keep a
  Japanese predicate around 20 full-width characters or fewer and an English predicate readable in
  one or two lines at normal zoom. State only the primary predicate; do not pack conditions, reasons,
  or result explanations into the Edge label. For example, prefer `キャッシュから読む` over
  `設定値が存在するときのみキャッシュから読み込む`. Put necessary detail in a Node description,
  Edge anchor, and the source evidence the reviewer can open. This is guidance, not a length limit.
  Avoid vague labels such as `related to`, `part of`, `connects`, or unlabeled arrows.
- Write the predicate so the claim reads naturally from the `from` Node as its actor or source to the
  `to` Node as its target. Choose the factual relationship that best explains the declared subject,
  not an inverse or passive restatement chosen to move either endpoint on the canvas.
- Set `directed: true` only when `from` to `to` expresses a real direction in the claim. Do not use
  direction to force a visual reading order. The viewer may use that factual direction as one input to
  its behavior-map projection; never reverse endpoints or choose active/passive wording to manipulate
  placement.
- Add zero or more anchors that directly establish the relationship. Use multiple anchors when the
  relationship is intentionally established at several distinct code sites. An edge without anchors is
  acceptable only when the code inside its source-supported anchored endpoints directly establishes
  the relationship; subject authority alone cannot establish it.
- In a file map, every Edge states a direct, concrete, source-verifiable relationship between the two
  represented files and has one or more anchors that establish it. Prefer predicates such as
  `calls exported function`, `uses contract`, `renders component`, `constructs and passes dependency`,
  `loads configuration`, `registers callback`, `invokes callback`, or `tests defined behavior`, shortened
  without losing the relationship kind. Do not use
  `related to`, `same PR`, `connects`, or another vague predicate merely to make the map connected.
- Anchor a file-map Edge at the specific use, wiring, implementation, contract, configuration, callback,
  or verification site that establishes its predicate. File-level Node anchors do not excuse a vague
  file-wide Edge anchor. An import establishes only an import. Do not infer a runtime call, execution
  order, data flow, state ownership, or dependency injection from import syntax alone; verify the use
  site or label the narrower import/type dependency that source actually proves.
- Preserve distinctions among type dependency, runtime dependency, registration, callback invocation,
  dependency construction/injection, configuration, and test verification. Registration and invocation
  may point in different directions and require separate Edges when both matter. A test's verification
  relation is not a production runtime call.
- Do not draw an indirect dependency as though it were direct. Include the meaningful intermediate file
  when it belongs to scope, or state the map boundary without the false Edge. If no meaningful relation
  exists in a one-file map, publish one Node and zero Edges; never add a numerical filler dependency.
- Preserve the relative order of surviving anchors on the same Edge across an update. The viewer uses
  the stable Edge ID plus anchor index to keep an open source action attached to its claim; replace an
  anchor in place instead of reordering unchanged entries.
- Do not publish a hypothesized or uncertain relation. Explain it separately in the Agent response so
  the map never presents an inference as a source-established fact.
- Do not encode confidence, severity, inferred risk, reviewer approval, hidden groups, or layout
  instructions in IDs, labels, kinds, or descriptions. Use `presentation` only for its defined
  authorial semantics.

## Author spatial presentation deliberately

`presentation` is required nullable version-5 content. Use `null` when the factual graph is clearest
with the topology-derived projection or when no defensible spatial explanation has been requested or
discovered. Never omit the field.

Keep four layers distinct. The factual graph is the origin, Nodes, exact Edges, directions, predicates,
and source anchors. Authorial presentation is only the thesis, attention start, optional exact-Edge
backbone, and named Region membership. Derived rendering includes ranks, coordinates, routes, label
placement, Region bounds, Context components, semantic zoom, and the Regions relationship view. The
reviewer session includes Graph / Regions mode, focus, framed Region, history, pan, zoom, viewport, and
manual positions. Only the first two are Structure content, and presentation never rewrites factual
truth.

For a non-null presentation:

- Write a nonblank `thesis` of 1–1000 characters that states what the whole map should help the reviewer
  understand. It may synthesize the graph's source-supported claims, but must not announce a review
  finding, approval, risk verdict, or completeness guarantee.
- Choose one current `startNodeId` as the first authorial attention anchor. It may differ from
  `originNodeId`: start says where this explanation first asks the reviewer to look, while origin says
  where source verification of the selected Structure role factually begins. For a file map, origin does
  not claim a common runtime entrypoint for all represented files. When a backbone is present, the start
  must be one of its derived endpoint Nodes; it need not belong to a region.
- Use `primaryBackbone: null` when this explanation has no compact connected relation skeleton worth
  emphasizing. Regions may still provide useful comprehension chunks.
  When a meaningful thesis and start exist but there is neither an honest backbone nor a useful named
  chunk, use the exact start-only form with `primaryBackbone: null` and `regions: []`. Do not manufacture a
  path, dummy region, or decorative grouping to satisfy a presentation template. If the thesis or start
  is not meaningful either, use `presentation: null`. A singleton file map normally uses
  `presentation: null` or this start-only form; do not invent an Edge, backbone, or one-item Region merely
  to decorate it.
- Otherwise choose one `primaryBackbone` object with 1–16 unique current Edge IDs in `edgeIds`. Treat the
  array as an unordered exact-membership set and sort it by stable Edge ID. The selected Edges must derive
  2–12 unique endpoint Nodes including `startNodeId`, and form one weakly connected graph when factual direction,
  parallel multiplicity, and self-loops are ignored. A self-loop may supplement, but cannot connect, the
  multi-Node skeleton. Select only the exact relations needed to grasp the thesis first. A path, star,
  fan-out, convergence diamond, reciprocal pair, or small cycle is valid. Do not invent an Edge, reverse
  its endpoints, change its predicate, or select every relation merely because it is available. Parallel
  or reciprocal Edge IDs may both appear only when both exact relations belong to the core. The 12-Node
  and 16-Edge caps are intentional: select the explanatory backbone instead of copying the whole factual
  graph. Use regions, narrow the behavior boundary, or choose a Walkthrough when ordered transitions and
  prose carry the explanation.
  Do not author layers or stages: visual ranks and bands are derived layout, not explanation truth.
- Add 0–12 `regions` only when named comprehension chunks clarify this subject. Give each Region a unique,
  stable ID using the same ID syntax as Nodes and Edges, a nonblank 1–100-character `label`, a concise
  1–500-character `summary`, and one or more unique current Node IDs. The summary explains what the chunk
  contributes to this Structure's thesis; it is not a generic subsystem description, architectural
  ownership claim, review conclusion, or completeness claim. Preserve a Region ID across updates while
  that comprehension chunk survives, even when its label, summary, or members change.
- A Node may be both on the backbone and in one Region, but it may not occur in more than one Region.
  Region membership may be partial: do not force the start or every graph Node into a Region, and do not
  manufacture a miscellaneous chunk. A Region need not form a connected induced subgraph when its members
  honestly constitute one comprehension chunk. Exact Node IDs, not an enclosing shape, define membership
  after a reviewer manually moves Nodes.
- Treat each `nodeIds` array and the outer `regions` array as unordered sets. Stable-sort members by Node ID
  and Regions by Region ID for canonical input; neither order expresses sequence, geometry, priority, or
  importance. Regions are authorial chunking, not new factual relations or permission to expand the
  Structure into a static inventory. Do not author Region-to-Region relations: a renderer may summarize
  only direct factual Edges crossing Region memberships.

A non-null presentation influences the overview, initial attention, and visual emphasis; a backbone and/or
regions additionally organize canonical placement. A start-only presentation retains topology-derived
geometry; it is still presentation because its thesis and attention start shape the overview and a new
Viewer session initially focuses `startNodeId`.
`originNodeId` remains separately marked as the factual source-verification start for the selected role.
The initial focus is derived from the current artifact and does not persist reviewer focus or give the
producer browser control. All Nodes, Edges, factual directions, and source actions remain available for
free exploration. Presentation never changes the graph's factual claims or hides secondary content. Do
not author coordinates, viewport, focus, manual positions, multiple routes, stepper behavior, or autoplay.

Do not omit needed factual claims, manufacture a backbone or Region, shorten a responsibility into
ambiguity, break file granularity, or otherwise change Artifact semantics merely to fit Graph or Regions
into one screen. Split genuinely independent file-map areas into separate producer invocations rather
than distorting relations, but do not split an area to hide a real shared contract or dependency. The
Viewer keeps canonical Region cards readable and provides pane-local Reset, Fit, zoom, and pan; its
camera and packing choices are derived rendering and reviewer-session state, not authoring inputs.

## Maintain stable identity

IDs identify claims across whole-value replacements; labels are presentation.

- Choose concise semantic IDs matching `^[A-Za-z][A-Za-z0-9_-]{0,63}$` at first publication. They need
  not match a symbol exactly.
- Preserve an ID when the same claim survives an update, even if its label, description, kind, notation,
  anchor, or endpoint details change.
- Assign a new ID for a genuinely new claim or comprehension chunk. Never recycle an ID removed from this
  Structure—whether it identified a Node, Edge, or Region—for a different meaning. rvw retains all three retired ID kinds
  as tombstones and rejects their reintroduction without retaining prior graph values.
  This mechanically detects disappearance followed by reuse; it cannot determine whether a continuously
  present ID was semantically repurposed, so compare the current claim/chunk before preserving it.
- Give every edge its own stable ID, including parallel edges between the same endpoints.
- In a behavior / review-question Structure, use `originNodeId` for the subject's factual code
  entrypoint. The entrypoint is the place a reviewer starts verifying the declared behavior: for example
  an HTTP route, public API, command handler,
  worker trigger, event subscriber, composition call, or migration execution point. It is not required
  to be an HTTP/runtime boundary, but it must be an existing Node with its own exact source anchor. It
  is not persisted viewer state or a claim of architectural importance. Do not choose a central data
  structure, important-looking class, or highly connected hub merely because it seems central. When a
  request starts from a file, symbol, class, or data structure, identify the concrete behavior first
  and find where a reviewer factually starts verifying that behavior in source; do not mechanically
  reuse the requested source as origin. A data structure or contract may still be the map's central hub,
  but connectivity alone does not make it the origin.
- In a file map, use `originNodeId` for one represented, source-anchored file from which a reviewer can
  honestly begin verifying this bounded set of file responsibilities and relations. It need not be a
  runtime entrypoint shared by every file, and it may legitimately be a contract, configuration,
  migration, document, or test when that matches the change. Do not select a hub solely for attractive
  layout or imply that every file executes from it. This factual evidence start remains distinct from
  `presentation.startNodeId`, which is only the author's initial attention choice.
- An origin with no outgoing unambiguous directed relation is an authoring smell for a behavior /
  review-question Structure: reconsider whether it is really the factual entrypoint. It is not by itself
  a defect in a file map, especially a valid one-Node/zero-Edge map. In either role, never increase origin
  out-degree by adding or reversing an Edge, changing predicate wording, or otherwise distorting relation
  semantics for layout quality.
- Ensure every Node is reachable from the origin when direction, parallel multiplicity, and self-loops
  are ignored. For a behavior map, a disconnected component is a different subject or an unsupported
  inventory. For a file map, genuinely independent change areas require separate file maps and separate
  producer invocations; do not connect them through a synthetic PR Node or a `same PR` Edge. Conversely,
  keep one connected map when source establishes a shared contract or dependency instead of hiding it
  through an artificial split.

Use an in-place update only while the declared subject identity is unchanged. A different subject,
even inside the same Pull Request, requires a new publication.

## Inspect enough, then stop

For a behavior / review-question Structure, inspect the central implementation, direct contracts and
consumers needed to verify the chosen relationships, and representative tests when they establish
important behavior. For a file map, inspect the changed and unchanged files needed to establish the
declared physical responsibilities and direct relations, including callers, consumers, contracts,
state owners, wiring, configuration, tests, migrations, and documents when relevant. Explore beyond the
diff when the subject requires it, but stop when another branch does not clarify the declared scope.

All anchors share one exact `sourceOid`. Confirm every path exists as UTF-8 text at that commit and
every inclusive range is within its line count. Do not anchor generated descriptions to approximate,
latest-head, or working-tree locations. Normally describe the post-change snapshot. You may inspect a
comparison source when explaining before/after behavior, but never mix anchors from multiple snapshots in
one Structure. Do not anchor a deleted file as though it existed at the selected `sourceOid`; for a rename,
use the path that exists at that source coordinate.

## Check before publication

Use this checklist internally; do not reproduce it as the Structure description.

- [ ] Exactly one authoring role was selected without adding a role field or mixing file Nodes with
      behavior, responsibility, symbol, subsystem, or concept Nodes.
- [ ] The declared subject is bounded and is better represented as a space than an ordered path.
- [ ] Explicit authority controls the requested scope; every implementation claim, suggested origin,
      relation, and invariant was independently verified rather than assumed or forced.
- [ ] A behavior / review-question Structure has one factual entrypoint and a consistent code-centered
      granularity; concept-only Nodes are necessary and do not invent semantics.
- [ ] In a file map, every Node is one unique path that exists at `sourceOid`, has a file-level anchor,
      has a label that identifies the file, and briefly states its honest PR-specific responsibility.
- [ ] A file map includes changed and unchanged files only when they matter to the declared change,
      identifies intentional exclusions and direct-code-reading boundaries, and is neither a changed-files
      list nor a generic repository inventory.
- [ ] Every Node's main claim is quickly understandable at normal zoom without relying on scrolling.
- [ ] Every Edge label states a short, precise relationship and its direction is factual rather than a
      layout instruction.
- [ ] Every file-map Edge represents a direct inter-file relation with specific source evidence; imports
      are not overclaimed, type/runtime/registration/invocation/configuration/test relations remain
      distinct, and indirect relations are not presented as direct.
- [ ] A one-file map with no meaningful inter-file dependency has one Node and zero Edges; no dummy Edge,
      dependency, backbone, or Region was created.
- [ ] `presentation` is present; `null` is intentional, or its thesis states a source-consistent spatial
      explanation without a review conclusion or completeness claim.
- [ ] A non-null presentation explicitly includes a current attention start, `primaryBackbone` (object or
      `null`), and `regions` (possibly empty). When `primaryBackbone` is non-null, the start belongs to it;
      the start need not belong to a Region.
- [ ] It uses a connected exact-Edge backbone or useful named Regions when either is honest; the
      start-only form is used only for a meaningful thesis and start when neither is honest. No fake
      backbone, dummy Region, decorative grouping, distorted relation, omitted fact, or broken file
      granularity was introduced for layout.
- [ ] A non-null primary backbone contains 1–16 stable-sorted unique current Edge IDs, derives 2–12
      endpoint Nodes including `startNodeId`, and is weakly connected without changing factual Edge
      direction.
- [ ] Every Region has a unique stable ID, a concise label and thesis-relevant responsibility summary,
      stable-sorted current unique Node IDs, and no Node belongs to multiple Regions. The Region array is
      stable-sorted by ID; neither array carries authorial order.
- [ ] Unassigned Nodes are intentional, no miscellaneous Region was manufactured for total coverage, and
      no authored Region relation duplicates or contradicts the factual graph.
- [ ] Presentation describes at most one visual backbone and useful spatial groupings without coordinates,
      multiple routes, hidden content, static repository inventory, stepper behavior, or autoplay.
- [ ] IDs are unique, semantic, and stable across updates; removed IDs are not recycled.
- [ ] For a behavior map, `originNodeId` names the source-established factual entrypoint where behavior
      verification begins; for a file map, it names the real file where verification of this bounded file
      relation set can honestly begin without claiming a shared runtime entrypoint.
- [ ] `originNodeId` remains distinct from `presentation.startNodeId`; neither was selected merely for
      centrality or attractive layout.
- [ ] A zero-outgoing origin warning triggered a factual-entrypoint recheck for a behavior map but did not
      cause a file map, especially a singleton, to invent or reverse an Edge.
- [ ] If layout preview reports `maxRows >= 8` or a non-forward directional link ratio of at least 25%,
      origin, granularity, subject mix, and boundary were reconsidered without changing facts.
- [ ] The origin Node has an exact source anchor and every Node is connected to it by declared relations;
      independent file-map areas were split into separate invocations rather than joined fictitiously,
      while real shared contracts or dependencies were retained.
- [ ] Every Edge endpoint exists and parallel relationships have distinct IDs.
- [ ] Every path and range is exact at the single committed `sourceOid`; renamed paths use the name at
      that coordinate and deleted paths are not anchored into a snapshot where they do not exist.
- [ ] In a behavior map, there are no unintended overlapping or nested Node anchors in one file; any
      retained overlap is justified by distinct responsibility claims.
- [ ] The graph contains at least one source anchor and no more than 400 across all Nodes and Edges.
- [ ] The map contains no hidden review conclusion, raw layout coordinates, inferred confidence, or
      exhaustive-completeness claim.
- [ ] The graph is small enough that a reviewer can explore it as a coherent subject.
- [ ] The graph has no more than 50 Nodes and 200 Edges; a denser subject was narrowed or returned to the
      requester for composition rather than overloaded into this Structure.
