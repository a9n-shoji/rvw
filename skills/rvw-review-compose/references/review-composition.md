# Review composition contract

Use this contract to decide the useful Walkthrough / Structure composition for one Pull Request or
explicitly requested review subject. A PR-wide composition always contains a PR-scoped file-map
Structure and minimizes total comprehension cost within that constraint. An explicitly bounded subject
may still need no Artifact. This contract governs the composition as a whole; the sibling producer
Skills govern each individual Artifact.

## Optimize total comprehension cost

Minimize the reviewer's total comprehension cost while reducing the number of concepts they must
internalize at one time. Include the complexity inside a surface, the cost of joining surfaces, and the
cost of coupling hidden by a false decomposition. More Artifacts, fewer Artifacts, more coverage, and
more polish are not quality by themselves.

The target is an iterative loop of small, verifiable mental models: begin with a concrete question,
inspect a small explanation, verify it in committed code, place the result among responsibilities and
dependencies, and follow the next question back into source. The target is not a complete explanation
set, a substitute for code reading, or a route that guarantees review completion.

Use this complexity budget as judgment, not a numeric hard limit:

- Every Artifact needs one central question. The file map asks where the files that matter to this
  change live, what each is responsible for, and which direct dependencies connect them. Reconsider an
  Artifact's scope when its question cannot be stated.
- Do not put multiple independent behaviors into one Artifact.
- Do not repeat the same question and explanation once as a Walkthrough and again as a Structure. The
  same path or source evidence may appear in multiple Artifacts when each uses it to answer a genuinely
  different question, such as physical file location, temporal behavior, and state ownership.
- Suspect the subject boundary before solving a giant Structure with layout or a long Walkthrough with
  formatting.
- Apart from the required PR-wide file map, do not create an Artifact for a topic that is quicker and
  clearer to verify directly in code.
- Do not pursue a "complete explanation set."
- Count the joins between surfaces as part of the reviewer's working-memory cost.
- Do not equate "minimum useful" with minimum Artifact count. Two independently useful surfaces can
  beat one overloaded surface; zero can beat both for an explicitly bounded local question. A PR-wide
  composition cannot drop its file map to obtain that economy.

## Apply the PR-wide file-map invariant

First classify the scope. A request to understand or compose the Pull Request as a whole is PR-wide. A
request naming one bounded behavior, file-local condition, or narrow review question is not PR-wide
merely because it supplies a Pull Request coordinate.

Every PR-wide composition includes at least one file-map Structure. The required thing is the map's
presence in the composition, not a fixed Artifact count, invocation order, or reading order. In a
read-only composition it remains an explicitly unproduced brief. In an authorized production run, a
valid existing same-subject map may satisfy the requirement; otherwise update it in place or publish a
new map through `rvw-structure`.

The file map answers: "Which repository files carry the responsibilities needed to understand this
change, and what concrete, source-verifiable dependencies connect them?" It is neither an architecture
overview nor a list of every changed file. Its boundary is the resulting PR software, so investigate
unchanged callers, consumers, contract or type owners, state owners, wiring, settings, tests,
migrations, and documentation when they materially locate responsibility or establish a relationship.
Do not include any of those categories mechanically, and do not turn the result into a repository-wide
import graph.

Use one real file per candidate Node and one candidate Node per path. A candidate Node has a file-level
source anchor and a short statement of that file's responsibility for understanding this PR. If a file
mixes responsibilities, say so rather than inventing a cleaner module boundary. Candidate Edges use a
short concrete predicate and identify the source evidence the producer must verify. An import proves an
import, not a runtime call, state owner, execution order, or data flow. Distinguish type use, runtime
use, registration, callback invocation, configuration, and test verification.

The composer proposes these as claims, not facts. `rvw-structure` independently verifies the final
Node/path one-to-one rule, file-level anchors, responsibilities, direct relations, Edge evidence,
`sourceOid`, origin, and connectedness. Do not introduce a new Node kind, notation, public field, or
Artifact type to mark the role.

Use one exact committed `sourceOid` for each proposed map, normally the post-change snapshot. Every
candidate path must exist at that coordinate. A deleted file cannot be anchored as if it existed at
HEAD, and a renamed file uses the path that exists at the selected `sourceOid`; do not mix before and
after anchors inside one map.

If one Pull Request contains genuinely independent change areas, use multiple bounded file maps rather
than a fictional "same PR" Node or Edge. Conversely, do not split an area to hide a real shared contract
or dependency. Include a meaningful intermediate file instead of drawing an indirect dependency as
direct. A single-file map with one Node and no Edge is valid; never add a dependency, backbone, or Region
for number matching. For a large map, use existing presentation, backbone, and Regions only when they
express honest semantics, or split it along a meaningful boundary without losing file granularity.

The file map is available as a reference surface during reading, not prerequisite study. The reviewer
may begin from a Walkthrough, behavior Structure, file, or the map and return to the map whenever they
need to locate the current code. `originNodeId` and `presentation.startNodeId` do not impose a reading
sequence.

Record enough scope to explain the major included areas, deliberate exclusions, and details left for
direct code reading. This is a transparent authoring boundary, not a guarantee that the map exhaustively
captures impact.

## Separate recommendation from production authority

Classify the requested composition outcome before choosing an Artifact operation. Here, read-only
describes the absence of side effects; it does not prohibit an authorized contextual read:

- A request to assess, recommend, plan, audit, or explain a composition is read-only. Return proposed
  surfaces, unproduced briefs, and direct-code entrypoints without publishing or updating Artifacts. A
  matching producer may perform the normal read operation for an explicitly supplied existing URI.
  When existing Walkthroughs affect the decision, `rvw-walkthrough` may page through `walkthrough list`
  and read plausible candidates. For the required PR-wide file map, `rvw-structure` may use the existing
  `structure list` discovery contract and read a plausible candidate before deciding whether it already
  satisfies the role.
- A request to create, publish, produce, or update the selected Artifacts authorizes the corresponding
  producer handoffs, subject to each producer's full preview, identity, and mutation contract.
- An explicitly supplied Artifact URI authorizes reading it as composition context, not updating it.
  An update still needs explicit production intent and must keep the same subject.

The contextual-read permission applies only after the main Skill's transport preflight succeeds. If
transport is unavailable, its diagnostic takes precedence: do not read the URI or infer its current
contents, although a clearly labeled source-only recommendation may still be possible.
Before each producer invocation, including this contextual read, require only the capability that
invocation uses. A contextual read may precede composition selection; do not require publish or update
capabilities until the composition selects and authorizes that operation.

When intent is ambiguous, recommend without mutation. A read-only result must say that its proposals
are unproduced and must not fabricate Artifact URIs. If the required map cannot be read because transport
is unavailable, return a source-only map brief, label the existing-map check as unperformed, and do not
claim the persisted requirement is satisfied.

## Investigate the subject

Start from the explicit subject and authoring directions supplied by the user, caller, and Pull Request body.
Inspect the committed diff and enough surrounding source, tests, contracts, configuration, wiring, and
documentation to understand the resulting behavior and where it lives. Do not use changed files as the
review boundary.

Identify the subject-specific comprehension difficulties. They may involve state authority,
lifecycle, asynchronous boundaries, failure or rollback, persistence, side effects, contracts, or
cross-boundary interaction, but these are prompts for investigation rather than fixed categories or
required sections.

Also identify important coupling between those difficulties. In complex changes, a boundary may be
more important than either side in isolation.

For a PR-wide composition, keep two analyses distinct: the physical file responsibility/dependency
areas that the required map must locate, and the behavior, state, interaction, or contract questions
that may deserve a Walkthrough or normal Structure. Do not treat the file map as answering both.

## Form bounded understanding units only when useful

A candidate unit should answer one central review question, for example where a particular state gets
its authority or how one session is created and cleaned up. Derive questions from the actual subject;
do not reuse a fixed list.

The required file map is a composition-wide locating surface rather than a reason to create one
behavior unit per file. Its map or maps still need bounded, coherent central questions and honest
connectedness.

"Slice" may be used as private shorthand during reasoning, but it is not an Artifact, entity, group,
identifier, URI, CLI field, or user-visible requirement.

Do not force a clean decomposition when it would hide coupling. Keep a concern together, or explicitly
leave its boundary for direct code reading, when facts such as these make independent Artifacts
misleading:

- writers of the same state are distributed across boundaries;
- lifecycle and network behavior are inseparable;
- multiple sources of truth update each other;
- cleanup responsibility crosses components; or
- understanding one behavior would require several Artifacts to remain open at the same time.

Treat difficulty of decomposition as a meaningful property of the implementation. Do not create a
tidy but false separation.

## Choose the surface per unit

Choose by the shape of the review question, not by a desired Artifact mix.

For PR-wide work, the file-map invariant has already selected its locating surface. Use the choices
below for every additional understanding question; they must not collapse the file map and a behavior
explanation into one overloaded Artifact.

### File-map Structure

Use the required file-map Structure to locate physical implementation responsibility and direct
file-to-file dependencies for a bounded PR change area. Its Nodes are files, not functions, concepts,
subsystems, or the Pull Request. It does not replace a normal Structure whose independently useful
question concerns state ownership, contracts, or side effects within or across those files.

### Walkthrough

For a meaningful behavior change, begin with a core Walkthrough as the default candidate. It should
answer what changed and which concrete source path lets the reviewer verify the mechanism. Do not drop
it merely because a file map exists or because fewer Artifacts look simpler. Omit it when the behavior
is sufficiently local that exact direct-code reading is clearer, or when an independently justified
surface already owns the same inseparable explanation and another Walkthrough would only duplicate the
claim or add a working-memory join. This presumption does not turn Walkthrough into a required schema
slot or force one for documentation-only, relationship-only, or other changes without a meaningful
behavior path.

Choose a Walkthrough when an execution path, lifecycle, causal chain, state transition, or ordered
comparison needs prose between sequential stops, a required ending, or transitions that carry the
meaning. It may include relationships needed to understand that path, but it should not absorb
independently useful ownership maps or every concept in the Pull Request.

### Normal behavior Structure

Choose a Structure when the reviewer needs to explore a bounded behavior through responsibilities,
ownership, dependencies, contracts, or side effects from a factual code origin. It may contain factual
direction and may use an authorial thesis, attention start, optional connected exact-relation primary
backbone of at most 12 derived Nodes and 16 Edges, and stable named comprehension Regions with responsibility
summaries and disjoint membership to shape its canonical spatial overview. Presentation guides attention
and a new Viewer session's initial focus; it does not alter factual
direction or turn the Structure into a reading sequence. Do not use it for a sequence whose meaning
depends on prose between stops, route transitions, or a required ending.

### Direct code reading

Choose direct code reading when the question is a local branch, guard, calculation, error detail,
isolated test assertion, or implementation detail that gains little from an external representation.
An important topic does not automatically deserve an additional Artifact. Record useful exact
entrypoints in the final response instead of manufacturing another document. Direct reading can replace
an optional Walkthrough or behavior Structure, but not the PR-wide file map.

### No duplicate surface

Orientation-level overlap and shared source evidence are acceptable when they help a reader locate a
related surface. Detailed duplication is not. Compare the questions and explanations rather than path
strings alone. If the reviewer would load the same claim or flow twice in different notation, keep the
clearer optional surface; preserve the file map's distinct locating question.

Never default to Walkthrough then Structure then code. Never require an Overview Walkthrough plus a
Walkthrough and Structure for every unit. Never instantiate Overview, State, Flow, Error, Test, and
Structure as fixed slots. The required file map is not a first step: a reviewer may enter through it, a
Walkthrough, a normal Structure, or code.

Use these shape checks as counterexamples, not a template or required scenario list:

- A linear request → service → repository route is a Walkthrough only when causal transitions or the
  ending carry the meaning; use a Structure when the question is instead responsibility or dependency
  around the entrypoint.
- A hub/fan-out or convergence is usually a Structure when simultaneous branches and their joins are
  the useful shape. It can have a star or converging backbone, Regions, or only a start; do not invent a
  sequence.
- A cross-cutting lifecycle may justify one Walkthrough for ordered state changes and one Structure for
  independently explorable authority relationships, but only when each answers a useful question on
  its own and their shared boundary is explicit. If correctness is one inseparable ordering invariant,
  prefer one Walkthrough plus direct code.
- A local guard, calculation, or code question remains direct reading even when it belongs to a large PR.
- An explicitly bounded local subject may legitimately produce zero, one, or several Artifacts. A
  PR-wide composition produces one or more file maps and only the additional Artifacts justified by its
  actual comprehension questions. Split independent file maps by honest relationship boundaries, and
  split other surfaces by comprehension question rather than changed file, subsystem, or Artifact kind.
- A user-requested spatial emphasis is authorial authority over what to foreground after verification;
  it does not turn a temporal explanation into a Structure or authorize renderer/session fields.

## Prepare an internal Artifact brief

Create a brief before handing a unit to a producer. A brief is temporary authoring context; do not send
it as a new CLI schema, persist it, publish it, or imply that rvw understands it.

Use a flexible note, not a public form. Every brief identifies its Artifact role, central question,
scope and exclusions, claims to verify, shared facts and terminology, and the explanation another
surface owns and should not be duplicated. The examples below are prompts rather than a CLI schema; omit
irrelevant optional detail and add subject-specific context when it helps enforce the boundary. Keep
`mustEstablish` limited to candidate claims needed for the central review question rather than using it
as a coverage checklist for the Pull Request.

Separate two kinds of input in every brief:

- **Authoring authority:** the Artifact role, subject, review question, purpose or behavior boundary, scope,
  inclusions, exclusions, emphasis, and requested spatial presentation decide what the producer
  investigates, how the Artifact is bounded, and how verified claims should first be presented.
- **Claims to verify:** `mustEstablish`, a suggested origin, relationship, invariant, and any other
  assertion about the implementation are candidates the producer must independently verify in
  committed source, tests, or source-controlled contracts before presenting them as facts.
- **Composition coordination:** pass the source-supported facts and terminology established so far, plus
  the question or explanation another Artifact owns. Shared context prevents vocabulary drift and
  duplication, but it does not exempt a producer from verifying a claim it will publish.

Authority over the question is not proof of its answer. A factual assumption embedded in a scope or
purpose is still a claim to verify. Explicit user-provided product intent or an off-repository
constraint may control the authoring goal, but attribute it as external context; never present it as
behavior established by committed code. The composer's prior inspection may identify useful candidate
claims, but it is not evidence the producer may simply reuse. Independent verification here is an
epistemic boundary, not a requirement to start another Agent or runtime.

`mustEstablish` means claims the producer must attempt to verify and establish from committed source.
It is not a list of facts the producer may assume or conclusions it must force. Verifying that an
anchor exists and its range is valid does not by itself verify the semantic claim attached to it. If
source supports a different answer without changing the central question or scope, the producer should
state that source-supported answer. If an essential target is unsupported or contradicted such that
the question or boundary must change, it must not publish the claim; it returns the conflict to the
composer for recomposition.

A Walkthrough brief should make these decisions explicit when relevant:

```text
role: walkthrough
subject: one bounded implementation subject
reviewQuestion: the question this path helps the reviewer answer
purpose: why an ordered path reduces comprehension cost
scope.include: facts and paths needed for that question
scope.exclude: adjacent concerns the producer must not absorb
mustEstablish: candidate claims the producer must independently verify and ground in source
diagramQuestion: optional relationship, state, ordering, interaction, or branch question that a diagram could make easier to answer
diagramCandidate: optional promising diagram family, never a requirement or an assertion that its participants, states, transitions, branches, or ordering exist
shared: source-supported facts and terminology to keep consistent
doNotDuplicate: question or explanation another surface already owns
emphasis: optional user-requested format, detail, or risk emphasis
existingArtifact: optional explicitly supplied URI for the same subject
```

A file-map Structure brief should make these decisions explicit when relevant:

```text
role: structure:file-map
subject: one bounded PR change area and its physical implementation location
reviewQuestion: which files carry the responsibilities needed to understand this area and what direct dependencies connect them
originCandidate: a real file from which source verification of this limited relation set could begin, not an assumed common runtime entrypoint
scope.include: changed and unchanged files materially needed to locate responsibility, ownership, contracts, wiring, configuration, or verification
scope.exclude: incidental changed files, repository-wide inventory, independent areas, and details left to direct code
mustEstablish: candidate file responsibilities, one-file-per-Node paths, direct Edge predicates, evidence, boundaries, and source-coordinate claims for independent verification
shared: source-supported facts and terminology to keep consistent
doNotDuplicate: behavior, sequence, state, or contract explanation another surface owns
presentation: optional semantic presentation request; never a fake backbone or Region added to make the map look complete
existingArtifact: optional supplied or structure-list-discovered same-subject candidate
```

A normal behavior Structure brief should make these decisions explicit when relevant:

```text
role: structure:behavior
subject: one bounded behavior
reviewQuestion: the relationship question the map helps answer
behavior: the concrete PR-relevant behavior being verified
originCandidate: possible code entrypoint for the producer to verify rather than assume
scope.include: responsibilities and relations needed for the question
scope.exclude: adjacent behaviors or inventories to omit
mustEstablish: candidate node, relation, and boundary claims to verify from source evidence
shared: source-supported facts and terminology to keep consistent
doNotDuplicate: file-location or ordered explanation another surface already owns
emphasis: optional user-requested detail or risk emphasis
presentation: optional requested thesis, semantic attention-start concept, relationship claims to consider for at most one connected exact-relation visual backbone, and semantic comprehension chunks to consider as Regions; never protocol IDs for a new Structure, raw coordinates, authored Region relations, or reviewer state
existingArtifact: optional explicitly supplied URI for the same subject
```

For a new Structure, describe presentation semantically rather than drafting its protocol payload.
State a meaningful thesis and semantic attention-start concept; describe the verified relationship
claims that should be considered for one compact backbone, and each comprehension chunk's meaning,
responsibility, and contribution to the thesis. The composer does not choose a new `startNodeId`,
`edgeIds`, `nodeIds`, or Region `id`. The Structure producer owns graph identity: after building and
verifying the graph, it resolves the attention-start concept to one current Node ID, backbone claims to
exact current Edge IDs, and accepted chunk concepts to exact Node membership. It assigns each new Region
a fresh ID, preserves that ID while the same chunk survives, enforces size/connectivity/disjointness,
and normalizes unordered sets. A suggested factual origin is a separate candidate claim to verify; it
does not become the attention start automatically. Raw IDs may be cited only when they came from an
existing Structure read; surviving IDs must remain attached to the same claim or chunk, and retired
Node, Edge, or Region IDs must not be recycled.

The resulting `primaryBackbone` may be one honest backbone or `null`, and Regions may be empty, partial,
and unordered. The start need not be a Region member. Do not request a miscellaneous Region for coverage
or an authored Region-to-Region relation; direct factual Edges remain the only relationship truth. If a
meaningful thesis and start exist but the verified shape has neither an honest backbone nor useful named
comprehension chunks, request the exact start-only form with `primaryBackbone: null` and `regions: []`;
topology supplies its geometry, while presentation still supplies attention, overview, and initial focus
for a new Viewer session. Otherwise do not invent a fake backbone, dummy Region, or decorative grouping.
Use `presentation: null` when no meaningful authorial presentation remains. Never request authored layers
or stages; the Viewer derives spatial ranks.
Do not put one-screen fit, Graph / Regions mode, Region relationship arrows, card packing, focus, framing,
history, Reset / Fit, pan, zoom, or viewport into the brief. Those are derived rendering or pane-local
reviewer-session concerns, and the producer must not alter verified claims or manufacture presentation
semantics to control them.

Do not use the brief to override a producer's representation rejection boundary or source-exactness
contract. The producer may reject a Walkthrough that has no useful order, a normal Structure that is
really an ordered prose or transition path or has no factual behavior origin, or a purported file map
that is a generic static inventory without a bounded PR/change scope and verified file relations. A
file map does not need one common runtime entrypoint; its required origin is the real file from which a
reviewer can begin verifying that limited file relation set. Recompose instead of silently broadening
the scope or manufacturing a connection.

## Re-evaluate the whole composition

Apply these checks after drafting and again after producer feedback.

These checks may discard or rescope an unpublished candidate. They never authorize deletion of a
published Artifact, including one created during the current composition; use the matching producer's
deletion preview and require explicit user authorization.

In an authorized production run, invoke producers sequentially rather than batching all briefs. Begin
with an Artifact that is independently useful and whose verified answer most constrains the other
candidates. After every producer result—including a successful publication that refines a claim—replace
the composer's hypothesis with the actual source-supported answer and terminology, then run the checks
below over all remaining unpublished briefs. Drop or revise them before the next handoff. Never publish
one surface only because a later surface is expected to make it useful.
The required file map does not force this sequence to start with the map. Produce it first only when its
verified answer most constrains the remaining briefs, and never present production order as human
reading order.

### Detailed overlap

Compare the central questions and explanations across Artifacts. Shared paths and source anchors are not
duplication when the file map uses them to locate implementation while another surface explains
behavior, state, interaction, or contract. Remove repeated explanation when the second surface does not
lower comprehension cost. Keep only the minimum orientation needed to reveal a connection.

### Terminology consistency

Use the same name for the same state, boundary, responsibility, and concept across all Artifacts and
the final response. When the explanatory name differs from the code identifier, state the mapping.
Avoid making the reviewer remember a separate vocabulary for every surface.

### Missing important boundaries

Reconsider state authority, lifecycle, async behavior, failure or rollback, persistence, side effects,
contracts, and cross-boundary interaction when the subject makes them relevant. This is not a coverage
checklist and does not require an Artifact for each item. A direct-code entrypoint is a valid treatment.
For the file map, separately recheck whether a major changed area, unchanged caller or consumer,
contract owner, state owner, wiring, configuration, migration, documentation, or test is necessary to
locate the implementation. Include it only when source establishes that relevance, and report major
deliberate exclusions rather than implying exhaustive impact coverage.

### Over-fragmentation

Small Artifacts are not useful if the reviewer must constantly move among five or six of them to answer
one question. Merge closely coupled candidates, cut scope differently, or replace them with one surface
plus direct code reading. If two Artifacts must always be viewed simultaneously, question whether they
are independent units at all.

### Cross-boundary risk

For every major connection, examine the output or state produced on one side against the input,
authority, or lifecycle on the other. Do not make each unit internally tidy while omitting the coupling
that determines behavior. Put the boundary into an existing Artifact only when it belongs to that
Artifact's central question; otherwise name an exact direct-code check in the final response.

## Existing-Artifact boundary

When an existing URI is explicitly supplied and transport is available, read its current value through
the matching producer and skip an unnecessary list. When no Walkthrough URI is supplied and existing
work affects the decision, have `rvw-walkthrough` page through `walkthrough list`, following `hasMore`
and `nextOffset` for exhaustive discovery, and read each plausible candidate with `walkthrough get`.
Never choose a same-subject update by title alone. For the required file map, use `structure list` to
inspect candidate summaries, then have `rvw-structure` read a plausible map and independently verify its
subject, source coordinate, file responsibilities, relations, and boundary before treating it as
satisfying the current composition. Reuse a valid current Artifact. In an authorized production run,
update a stale same-subject Artifact in place; publish a new one only when no verified candidate fits or
the subject is genuinely different. List and get are separate reads rather than a fixed snapshot, and
neither grants mutation authority. If transport is unavailable, the main Skill's preflight diagnostic
wins and the read cannot occur. Never rewrite an Artifact into a different subject or delete one merely
because the new composition omits it; normal preview and explicit deletion authorization still apply.
Use only public list/get commands, never SQLite, internal file paths, remembered URIs, or invented
identity.

## Completion response

Give a recommended entry rather than a mandatory review itinerary. The reviewer may start from code,
the file map, a normal Structure, or a Walkthrough. Never imply that file-map existence makes it required
pre-study or that following the suggested order completes the review.

Briefly report:

- why the composition lowers total comprehension cost within the PR-wide file-map constraint;
- every reused, created, or updated Artifact URI, or that the recommendation remains unproduced;
- what each file map includes and deliberately excludes;
- important details left for direct code reading and why source is clearer; and
- any required file map left unmet, with the exact source, authority, capability, transport, or
  representation reason.

Never fabricate a file, relation, anchor, or URI to make the invariant appear satisfied. This response
remains ordinary Agent output and must not be stored as a new review object.
