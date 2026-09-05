# Structure authoring contract

Use this contract when creating a Structure or materially replacing its current value. It supplies
defaults only where explicit instructions are silent.

## Establish subject authority

Apply inputs in this order:

1. Explicit directions from the user, caller, Pull Request body, or upstream Skill define the subject,
   review question, behavior, scope, inclusions, exclusions, must-establish facts, emphasis, and any
   factual-origin guidance.
2. Verified committed code, tests, documentation, and Pull Request context fill gaps.
3. Put hypotheses, uncertain connections, and relations that are not directly established by source or
   explicit authority in the Agent's normal response, not in the Structure.

Do not substitute a broader architecture tour for a bounded subject. A useful subject states one
PR-relevant behavior and the code entrypoint from which a reviewer can begin verifying it. A useful
scope says which direct responsibilities, dependencies, contracts, and side effects are needed to
understand that behavior and what it deliberately excludes. A data model, subsystem, or responsibility
belongs only when it clarifies that behavior; a static inventory of them is not a Structure subject.

If the request starts from a file, symbol, module, or changed source rather than a named behavior, use
that source only as the discovery entry. Identify the one concrete PR-relevant behavior requested, then
locate that behavior's factual origin. If the source participates in multiple independently triggered
behaviors, do not join them and do not create multiple Structures from this producer request. Follow an
explicitly supplied boundary; otherwise return candidate boundaries to the requester or upstream
composer.

Before authoring, test the requested shape: if the explanation becomes clearer only when its elements
are arranged as step 1, then step 2, then step 3, the subject is a path. Stop and recommend a
Walkthrough. A Structure may contain directed relationships, but direction is not a reading order. If
the subject has no factual code entrypoint and is useful only as a timeless architecture diagram, stop
without publishing a Structure.

## Select nodes as claims

Each node is a producer claim that a particular code-centered concept belongs in this subject. Prefer
symbols, modules, boundaries, contracts, persisted models, or small cohesive subsystems that a reviewer
can verify in committed code.

- Keep one level of abstraction around the stated subject. Split a node when its label joins multiple
  independent responsibilities; merge nodes that only reproduce neighboring source lines.
- Use concept nodes without anchors only when the concept is explicitly established by the authority
  inputs or is needed to connect anchored code claims. Do not use unanchored concepts to invent
  product semantics.
- `description` states the claim and its role in this subject. It is not a review finding, approval,
  recommendation, or generated summary of the whole file.
- Keep the `label` and `description` short enough that a reviewer can grasp the node's main claim at
  normal zoom. In-node scrolling preserves exceptional detail; it is a fallback, not a reason to make
  long prose the normal authoring shape.
- `kind` is a deprecated compatibility field that the viewer does not display. Do not set it in new
  Structures.
- `notation` is an optional controlled scanning aid: `plain`, `class`, `database`, `interface`,
  `component`, `external`, or `concept`. Choose it only when the familiar visual pattern helps a reviewer
  distinguish the claim. Do not infer it mechanically from legacy `kind`; omit it for the default
  `plain` card.
- Prefer the smallest meaningful multi-line anchor that verifies the node claim. Use a file anchor only
  for genuinely file-wide responsibility and a single-line range only for a line-local declaration.
- Within one file, merge overlapping or nested Node anchors unless each Node expresses a distinct,
  independently explainable code-centered responsibility. Do not represent both an entire method and
  each of its branches as overlapping Nodes; when branches are the claims, normally omit the parent
  method Node. Anchor each Node to the smallest meaningful, preferably non-overlapping range. A
  file-wide anchor will overlap most other Nodes in that file, so use it deliberately. Overlap is not
  an error, but retained overlap must support distinct responsibility claims.

Do not create giant graphs, file inventories, one node per function, inferred runtime call graphs,
dependency graphs obtained only from import syntax, or concept-only diagrams detached from code.
When following the current behavior reaches another independently triggered behavior with its own
origin, stop at the current scope. Report that adjacent behavior when it is materially relevant, but do
not author another Structure from this producer request. Do not keep expanding merely because more
static responsibilities are connected.

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
  `to` Node as its target. Choose the factual relationship that best explains the declared behavior,
  not an inverse or passive restatement chosen to move either endpoint on the canvas.
- Set `directed: true` only when `from` to `to` expresses a real direction in the claim. Do not use
  direction to force a visual reading order. The viewer may use that factual direction as one input to
  its behavior-map projection; never reverse endpoints or choose active/passive wording to manipulate
  placement.
- Add zero or more anchors that directly establish the relationship. Use multiple anchors when the
  relationship is intentionally established at several distinct code sites. An edge without anchors is
  acceptable only when the relationship follows directly from its anchored endpoints or explicit
  subject authority.
- Preserve the relative order of surviving anchors on the same Edge across an update. The viewer uses
  the stable Edge ID plus anchor index to keep an open source action attached to its claim; replace an
  anchor in place instead of reordering unchanged entries.
- Do not publish a hypothesized or uncertain relation. Explain it separately in the Agent response so
  the map never presents an inference as a source-established fact.
- Do not encode confidence, severity, inferred risk, reviewer approval, hidden groups, or presentation
  instructions in IDs, labels, kinds, or descriptions.

## Maintain stable identity

IDs identify claims across whole-value replacements; labels are presentation.

- Choose concise semantic IDs matching `^[A-Za-z][A-Za-z0-9_-]{0,63}$` at first publication. They need
  not match a symbol exactly.
- Preserve an ID when the same claim survives an update, even if its label, description, kind, notation, anchor,
  or endpoint details change.
- Assign a new ID for a genuinely new claim. Never recycle an ID removed from this Structure for a
  different node or edge. rvw retains retired Node and Edge IDs as tombstones and rejects their
  reintroduction without retaining prior graph values.
- Give every edge its own stable ID, including parallel edges between the same endpoints.
- Use `originNodeId` for the subject's factual code entrypoint. The entrypoint is the place a reviewer
  starts verifying the declared behavior: for example an HTTP route, public API, command handler,
  worker trigger, event subscriber, composition call, or migration execution point. It is not required
  to be an HTTP/runtime boundary, but it must be an existing Node with its own exact source anchor. It
  is not persisted viewer state or a claim of architectural importance. Do not choose a central data
  structure, important-looking class, or highly connected hub merely because it seems central. When a
  request starts from a file, symbol, class, or data structure, identify the concrete behavior first
  and find where a reviewer factually starts verifying that behavior in source; do not mechanically
  reuse the requested source as origin. A data structure or contract may still be the map's central hub,
  but connectivity alone does not make it the origin.
- An origin with no outgoing unambiguous directed relation is an authoring smell: reconsider whether it
  is really the factual entrypoint. A terminal or intermediate origin is still valid when the source
  establishes it. Never increase origin out-degree by reversing an Edge, changing predicate wording,
  or otherwise distorting relation semantics for layout quality.
- Ensure every Node is reachable from the origin when direction, parallel multiplicity, and self-loops
  are ignored. A disconnected component is a different subject or an unsupported inventory, not a
  second island in the same Structure.

Use an in-place update only while the declared subject identity is unchanged. A different subject,
even inside the same Pull Request, requires a new publication.

## Inspect enough, then stop

Inspect the central implementation, direct contracts and consumers needed to verify the chosen
relationships, and representative tests when they establish important behavior. Explore beyond the
diff when the subject requires it, but stop when another branch does not clarify the declared scope.

All anchors share one exact `sourceOid`. Confirm every path exists as UTF-8 text at that commit and
every inclusive range is within its line count. Do not anchor generated descriptions to approximate,
latest-head, or working-tree locations.

## Check before publication

Use this checklist internally; do not reproduce it as the Structure description.

- [ ] The declared subject is bounded and is better represented as a space than an ordered path.
- [ ] Explicit authority controls the requested scope; verified facts fill only its gaps.
- [ ] Each node is one useful, code-centered claim at a consistent granularity.
- [ ] Each node's main claim is quickly understandable at normal zoom without relying on scrolling.
- [ ] Concept-only nodes are necessary and do not invent semantics.
- [ ] Every edge label states a precise relationship and direction is factual.
- [ ] Every edge label is a short verb or verb phrase readable at normal zoom and does not contain a
      packed condition or explanation.
- [ ] IDs are unique, semantic, and stable across updates; removed IDs are not recycled.
- [ ] `originNodeId` names the existing source-established factual code entrypoint where review of this
      behavior starts, not merely the subject's central object.
- [ ] If the origin has no outgoing unambiguous directed relation, its selection was rechecked against
      the factual behavior entrypoint.
- [ ] If layout preview reports `maxRows >= 8` or a non-forward directional link ratio of at least 25%,
      origin, granularity, behavior mix, and subject boundary were reconsidered.
- [ ] The origin Node has an exact source anchor and every Node is connected to it by declared relations.
- [ ] Every edge endpoint exists and parallel relationships have distinct IDs.
- [ ] Every path and range is exact at the single committed `sourceOid`.
- [ ] There are no unintended overlapping or nested Node anchors in one file; any retained overlap is
      justified by distinct responsibility claims.
- [ ] The graph contains at least one source anchor and no more than 400 across all nodes and edges.
- [ ] The map contains no hidden review conclusion, presentation layout, inferred confidence, or
      exhaustive-completeness claim.
- [ ] The graph is small enough that a reviewer can explore it as a coherent subject.
- [ ] The graph has no more than 50 nodes and 200 edges; a denser subject was narrowed or returned to
      the requester for composition rather than overloaded into this Structure.
