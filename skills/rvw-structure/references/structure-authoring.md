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

Do not substitute a broader architecture tour for a bounded subject. A useful subject can be stated as
one code-centered responsibility, boundary, contract, data model, or subsystem. A useful scope says
what the map includes and, when ambiguity is likely, what it deliberately excludes.

Before authoring, test the requested shape: if the explanation becomes clearer only when its elements
are arranged as step 1, then step 2, then step 3, the subject is a path. Stop and recommend a
Walkthrough. A Structure may contain directed relationships, but direction is not a reading order.

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
- `kind` is an optional producer label for scanning, not a controlled ontology. Use a short factual
  noun such as `service`, `contract`, `store`, `command`, or `view`; omit it when it adds no signal.
- Prefer the smallest meaningful multi-line anchor that verifies the node claim. Use a file anchor only
  for genuinely file-wide responsibility and a single-line range only for a line-local declaration.

Do not create giant graphs, file inventories, one node per function, inferred runtime call graphs,
dependency graphs obtained only from import syntax, or concept-only diagrams detached from code.

## State relationships precisely

Each edge is a producer claim about how two nodes relate in this subject.

- Use a short verb or verb phrase: `calls`, `constructs`, `validates`, `persists`, `loads`, `implements`,
  `emits`, `renders`, or another fact supported by the source. Avoid vague labels such as `related to`,
  `part of`, `connects`, or unlabeled arrows.
- Set `directed: true` only when `from` to `to` expresses a real direction in the claim. Do not use
  direction to force a visual reading order.
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
- Preserve an ID when the same claim survives an update, even if its label, description, kind, anchor,
  or endpoint details change.
- Assign a new ID for a genuinely new claim. Never recycle an ID removed from this Structure for a
  different node or edge. Because rvw stores only the current value, this is a producer authoring
  convention checked against the producer's prior value, not a runtime tombstone invariant.
- Give every edge its own stable ID, including parallel edges between the same endpoints.
- Use `initialFocus` for the subject's most useful entry concept, or `null` when no single node is the
  natural center. It is not persisted viewer state.

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
- [ ] `initialFocus` names an existing node or is `null`.
- [ ] Every edge endpoint exists and parallel relationships have distinct IDs.
- [ ] Every path and range is exact at the single committed `sourceOid`.
- [ ] The map contains no hidden review conclusion, presentation layout, inferred confidence, or
      exhaustive-completeness claim.
- [ ] The graph is small enough that a reviewer can explore it as a coherent subject.
- [ ] The graph has no more than 50 nodes and 200 edges; a denser subject has been split rather than
      relying on the viewer to hide relations.
