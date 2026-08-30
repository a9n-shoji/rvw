# Structure producer evaluation

This record captures the production authoring trial performed while implementing Structure. The
examples were authored from a fresh inspection of repository commit
`e1702ec717f2c9eae88ab9debd63a7a8e7e70864`; they were not copied from the Phase 0 spike fixtures.
They are complete Structure update values, so a caller can add a Pull Request reference for a publish
request. Automated tests parse the production schema and verify every anchor against that exact Git
object.

## Generated Structures

### Agent transport boundary

- Example: [agent-transport-boundary.json](examples/structures/agent-transport-boundary.json)
- Result: six nodes and six edges represented the CLI selection, socket client, validation, schemas,
  dispatch, and diagnostic policy at one consistent boundary level, beginning at the CLI service-call
  entrypoint.
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
claims of the same subject.
