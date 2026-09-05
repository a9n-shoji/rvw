# Review composition contract

Use this contract to decide the minimum useful Walkthrough / Structure composition for one Pull
Request or explicitly requested review subject. It governs the composition as a whole; the sibling
producer Skills govern each individual Artifact.

## Optimize for mental-model load

Minimize external representation while reducing the number of concepts a reviewer must internalize at
one time. Preserve the important joins between concepts. More Artifacts, more coverage, and more polish
are not quality by themselves.

The target is a sequence of small, verifiable mental models that lead into committed code. The target
is not a complete explanation set, a substitute for code reading, or a route that guarantees review
completion.

Use this complexity budget as judgment, not a numeric hard limit:

- Every Artifact needs one central question. Reconsider its scope when that question cannot be stated.
- Do not put multiple independent behaviors into one Artifact.
- Do not express the same content once as a Walkthrough and again as a Structure.
- Suspect the subject boundary before solving a giant Structure with layout or a long Walkthrough with
  formatting.
- Do not create an Artifact for a topic that is quicker and clearer to verify directly in code.
- Do not pursue a "complete explanation set."
- Count the joins between surfaces as part of the reviewer's working-memory cost.

## Investigate the subject

Start from the explicit subject and authoring directions supplied by the user, caller, and Pull Request body.
Inspect the committed diff and enough surrounding source, tests, contracts, and documentation to
understand the resulting behavior. Do not use changed files as the review boundary.

Identify the subject-specific comprehension difficulties. They may involve state authority,
lifecycle, asynchronous boundaries, failure or rollback, persistence, side effects, contracts, or
cross-boundary interaction, but these are prompts for investigation rather than fixed categories or
required sections.

Also identify important coupling between those difficulties. In complex changes, a boundary may be
more important than either side in isolation.

## Form bounded understanding units only when useful

A candidate unit should answer one central review question, for example where a particular state gets
its authority or how one session is created and cleaned up. Derive questions from the actual subject;
do not reuse a fixed list.

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

### Walkthrough

Choose a Walkthrough when the reviewer benefits from a deliberate comprehension order: an execution
path, lifecycle, causal chain, state transition, or ordered comparison. It may include relationships
needed to understand that path, but it should not absorb independently useful ownership maps or every
concept in the Pull Request.

### Structure

Choose a Structure when the reviewer needs to explore a bounded behavior through responsibilities,
ownership, dependencies, contracts, or side effects from a factual code origin. It may contain factual
direction, but do not use it for a sequence whose meaning depends on a beginning and end.

### Direct code reading

Choose direct code reading when the question is a local branch, guard, calculation, error detail,
isolated test assertion, or implementation detail that gains little from an external representation.
An important topic does not automatically deserve an Artifact. Record useful exact entrypoints in the
final response instead of manufacturing another document.

### No duplicate surface

Orientation-level overlap is acceptable when it helps a reader locate a related surface. Detailed
duplication is not. If the reviewer would load the same claim or flow twice in different notation,
keep the clearer surface and remove the other candidate.

Never default to Walkthrough then Structure then code. Never require an Overview Walkthrough plus a
Walkthrough and Structure for every unit. Never instantiate Overview, State, Flow, Error, Test, and
Structure as fixed slots.

## Prepare an internal Artifact brief

Create a brief before handing a unit to a producer. A brief is temporary authoring context; do not send
it as a new CLI schema, persist it, publish it, or imply that rvw understands it.

Use a flexible note, not a fixed form. The fields below are prompts rather than required slots; omit
irrelevant ones and add subject-specific context when it helps enforce the boundary. Keep
`mustEstablish` limited to candidate claims needed for the central review question rather than using it as a
coverage checklist for the Pull Request.

Separate two kinds of input in every brief:

- **Authoring authority:** the subject, review question, purpose or behavior boundary, scope,
  inclusions, exclusions, and emphasis decide what the producer investigates and how the requested
  Artifact is bounded.
- **Claims to verify:** `mustEstablish`, a suggested origin, relationship, invariant, and any other
  assertion about the implementation are candidates the producer must independently verify in
  committed source, tests, or source-controlled contracts before presenting them as facts.

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
kind: walkthrough
subject: one bounded implementation subject
reviewQuestion: the question this path helps the reviewer answer
purpose: why an ordered path reduces comprehension cost
scope.include: facts and paths needed for that question
scope.exclude: adjacent concerns the producer must not absorb
mustEstablish: candidate claims the producer must independently verify and ground in source
emphasis: optional user-requested format, detail, or risk emphasis
existingArtifact: optional explicitly supplied URI for the same subject
```

A Structure brief should make these decisions explicit when relevant:

```text
kind: structure
subject: one bounded behavior
reviewQuestion: the relationship question the map helps answer
behavior: the concrete PR-relevant behavior being verified
originCandidate: possible code entrypoint for the producer to verify rather than assume
scope.include: responsibilities and relations needed for the question
scope.exclude: adjacent behaviors or inventories to omit
mustEstablish: candidate node, relation, and boundary claims to verify from source evidence
emphasis: optional user-requested detail or risk emphasis
existingArtifact: optional explicitly supplied URI for the same subject
```

Do not use the brief to override a producer's representation rejection boundary or source-exactness
contract. The producer may reject a Walkthrough that has no useful order, or a Structure that is really
an ordered path, has no factual origin, or is only a static inventory. Recompose instead of silently
broadening the scope.

## Re-evaluate the whole composition

Apply these checks after drafting and again after producer feedback.

These checks may discard or rescope an unpublished candidate. They never authorize deletion of a
published Artifact, including one created during the current composition; use the matching producer's
deletion preview and require explicit user authorization.

### Detailed overlap

Compare the central claims and code anchors across Artifacts. Remove duplicated explanation when the
second surface does not lower comprehension cost. Keep only the minimum orientation needed to reveal a
connection.

### Terminology consistency

Use the same name for the same state, boundary, responsibility, and concept across all Artifacts and
the final response. When the explanatory name differs from the code identifier, state the mapping.
Avoid making the reviewer remember a separate vocabulary for every surface.

### Missing important boundaries

Reconsider state authority, lifecycle, async behavior, failure or rollback, persistence, side effects,
contracts, and cross-boundary interaction when the subject makes them relevant. This is not a coverage
checklist and does not require an Artifact for each item. A direct-code entrypoint is a valid treatment.

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

When an existing URI is explicitly supplied, read its current value through the matching producer and
prefer an in-place same-subject update over a duplicate publication. Never rewrite an Artifact into a
different subject. Never delete an existing Artifact merely because the new composition omits it;
normal preview and explicit deletion authorization still apply.

Use only existing CLI discovery. `structure list` can enumerate Structure summaries, but there is no
general Walkthrough list command. State the resulting uncertainty instead of reading the database,
inventing identity, or publishing an unconditional "revised" duplicate.

## Completion response

Give a recommended entry rather than a mandatory review itinerary. The reviewer may start from code,
enter a Structure midway, or reverse-reference a Walkthrough. Never imply that following the suggested
order completes the review.

Briefly report the reason for the composition, created or updated URIs, and important direct-code topics
that were intentionally not externalized. This response remains ordinary Agent output and must not be
stored as a new review object.
