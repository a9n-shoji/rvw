# Structure authoring contract

Use this contract when creating a Structure or materially replacing its current value. It supplies
defaults only where explicit instructions are silent.

## Establish subject authority

Apply inputs in this order:

1. Explicit directions from the user, caller, Pull Request body, or upstream Skill define the subject,
   scope, inclusions, exclusions, and emphasis.
2. Verified committed code, tests, documentation, and Pull Request context fill gaps.
3. Put hypotheses, uncertain connections, and relations that are not directly established by source or
   explicit authority in the Agent's normal response, not in the Structure.

Do not substitute a broader architecture tour for a bounded subject. A useful subject states one
PR-relevant behavior and the code entrypoint from which a reviewer can begin verifying it. A useful
scope says which direct responsibilities, dependencies, contracts, and side effects are needed to
understand that behavior and what it deliberately excludes. A data model, subsystem, or responsibility
belongs only when it clarifies that behavior; a static inventory of them is not a Structure subject.

If the request starts from a file, symbol, module, or changed source rather than a named behavior, use
that source only as the discovery entry. Identify the concrete PR-relevant behavior it participates in,
then locate that behavior's factual origin. A source that participates in multiple independently
triggered behaviors yields separate Structures; it does not justify a combined module inventory.

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
- `kind` is a deprecated compatibility field that the viewer does not display. Do not set it in new
  Structures.
- `notation` is an optional controlled scanning aid: `plain`, `class`, `database`, `interface`,
  `component`, `external`, or `concept`. Choose it only when the familiar visual pattern helps a reviewer
  distinguish the claim. Do not infer it mechanically from legacy `kind`; omit it for the default
  `plain` card.
- Prefer the smallest meaningful multi-line anchor that verifies the node claim. Use a file anchor only
  for genuinely file-wide responsibility and a single-line range only for a line-local declaration.

Do not create giant graphs, file inventories, one node per function, inferred runtime call graphs,
dependency graphs obtained only from import syntax, or concept-only diagrams detached from code.
When following the current behavior reaches another independently triggered behavior with its own
origin, stop and author that behavior as a separate Structure if it is review-relevant. Do not keep
expanding merely because more static responsibilities are connected.

## State relationships precisely

Each edge is a producer claim about how two nodes relate in this subject.

- Use a short verb or verb phrase: `calls`, `constructs`, `validates`, `persists`, `loads`, `implements`,
  `emits`, `renders`, or another fact supported by the source. Avoid vague labels such as `related to`,
  `part of`, `connects`, or unlabeled arrows.
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
  is not persisted viewer state or a claim of architectural importance.
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
- [ ] Concept-only nodes are necessary and do not invent semantics.
- [ ] Every edge label states a precise relationship and direction is factual.
- [ ] IDs are unique, semantic, and stable across updates; removed IDs are not recycled.
- [ ] `originNodeId` names the existing source-established Node where review of this behavior starts.
- [ ] The origin Node has an exact source anchor and every Node is connected to it by declared relations.
- [ ] Every edge endpoint exists and parallel relationships have distinct IDs.
- [ ] Every path and range is exact at the single committed `sourceOid`.
- [ ] The graph contains at least one source anchor and no more than 400 across all nodes and edges.
- [ ] The map contains no hidden review conclusion, presentation layout, inferred confidence, or
      exhaustive-completeness claim.
- [ ] The graph is small enough that a reviewer can explore it as a coherent subject.
- [ ] The graph has no more than 50 nodes and 200 edges; a denser subject has been split rather than
      relying on the viewer to hide relations.
