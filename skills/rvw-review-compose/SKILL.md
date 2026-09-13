---
name: rvw-review-compose
description: Analyze one Pull Request or explicit review subject and choose source-anchored rvw Walkthroughs, Structures, and direct code reading that minimize total comprehension cost. For a PR-wide composition, always include a PR-scoped file-responsibility and dependency Structure while adapting every other surface. Use when the user asks to recommend or explicitly produce an overall review composition; recommendation is non-mutating. Use the producer Skills directly for one explicitly bounded Walkthrough or Structure.
---

# rvw review composition

Compose the useful mix of rvw reading surfaces for one Pull Request or explicitly requested review
subject that minimizes the reviewer's total comprehension cost. That cost includes the complexity
inside each surface, the joins between surfaces, and the important coupling a surface choice would
hide. It is not the number of Artifacts: two independently useful surfaces can be better than one
overloaded surface, while zero can be best for an explicitly bounded local question. A PR-wide
composition is the exception: it always includes at least one PR-scoped file-map Structure, then
optimizes every other surface within that constraint. The goal is not to create a complete explanation
set or to make the reviewer feel finished; it is to let the reviewer build small mental models, verify
them in committed code, place them back among file responsibilities and dependencies, and keep
exploring.

This Skill owns PR-wide composition. `rvw-walkthrough` owns one ordered explanation path, and
`rvw-structure` owns one bounded relationship space: either a normal behavior Structure or an explicitly
briefed PR-scoped file map. A file map uses the existing Structure format; it is not a new Artifact kind
or an architecture overview. Use either producer directly when the user has already asked for one
bounded Artifact. Do not take over comment review or PR synchronization work.

Composition is session-local authoring strategy, not a product entity. Do not create a Review Set,
Review Plan, Slice, group ID, typed Artifact link, Artifact kind, URI, database row, migration, CLI
capability, HTTP API, or Viewer grouping. Never access SQLite directly or control a Viewer through
browser automation.

For every composition task, read
[the review composition contract](references/review-composition.md) before deciding the surfaces.

## Preflight

1. Run `rvw protocol --json` and parse stdout as JSON. Require `protocolVersion` 5 and
   `agent.transport`, and record the available Walkthrough and Structure capabilities, including
   `walkthrough.list` for Walkthrough discovery. Immediately
   before every producer invocation, including contextual discovery or a current-value read, require
   only the capabilities that invocation actually uses. The producer Skills perform their complete
   operation-specific checks. A contextual read may happen before the composition is selected; creation
   and update capabilities are required only after selecting that operation.
2. Run `rvw agent status --json`. If `selectedTransport` is `unavailable`, do not read or mutate an
   Artifact and report the diagnostic. This preflight result overrides the existing-URI read permission
   below: even an explicitly supplied URI cannot be read without transport. A recommendation-only
   composition may still inspect committed repository source and return source-only, unproduced briefs,
   but it must say that it did not evaluate the existing Artifact; a production request must stop before
   invoking a producer. Otherwise use the reported transport without overriding it.
3. Require local access to the saved repository and investigate committed code. Do not compose or
   publish Artifacts from uncommitted source.

## Compose before producing

First classify the requested composition outcome, then choose only the Artifact operations it permits.
A request to assess, recommend, plan, audit, or explain a composition is read-only, meaning that it
permits no Artifact mutation: return proposed surfaces and internal briefs without creating, publishing,
or updating. When transport is available, the matching producer may still perform its normal read
operation for an explicitly supplied existing URI. When existing Walkthroughs affect composition,
`rvw-walkthrough` may use `walkthrough list` and read plausible candidates; for a required PR-wide file
map, `rvw-structure` may use `structure list` and read a plausible candidate. Invoke a producer for
Artifact creation or update only when the user explicitly asks to create, publish, produce, or update
Artifacts. Supplying an existing URI or discovering a candidate authorizes contextual reading, not an
update.
When production intent is ambiguous, finish with a recommendation rather than mutate review state.

Investigate the Pull Request or requested subject, its diff, relevant surrounding code, contracts, and
tests before choosing Artifact boundaries. Identify the main comprehension difficulties and the
coupling between them. Candidate bounded understanding units are internal reasoning only; do not
persist or present them as a new rvw object.

First decide whether the request covers the Pull Request as a whole or one explicitly bounded review
subject. For a PR-wide composition, include one file-map Structure for each genuinely independent
change area needed to locate the implementation. A file map answers which files carry the relevant
responsibilities and what source-verifiable dependencies connect them. It is not a changed-file list,
repository-wide import graph, generic architecture inventory, or required first reading step. Do not
join independent areas with a relation that exists only because they share a Pull Request. A single-file
change still has a one-Node file map and needs no invented Edge. In a read-only request, include the map
as an unproduced brief; production still requires explicit authority below.

After satisfying that PR-wide invariant, choose the surface that lowers each remaining candidate unit's
comprehension cost:

- For a meaningful behavior change, treat one core Walkthrough as the default way to establish what
  changes and how to verify it in code. Omit it only when the behavior is so local that exact direct
  code is clearer, or when another independently justified surface already owns the same inseparable
  explanation and a Walkthrough would only duplicate it or add a working-memory join. This is a
  rebuttable default, not a mandatory slot for every Pull Request.
- Use a Walkthrough when ordered execution, causality, lifecycle, or a comprehension sequence needs
  prose between stops, a required ending, or transitions that carry the meaning.
- Use a normal behavior Structure when responsibility, ownership, dependency, contract, or side-effect
  relationships around one factual code entrypoint are the essential shape. Its optional presentation
  may set initial attention, emphasize one connected exact-relation backbone, and identify stable named
  comprehension Regions with responsibility summaries while keeping the complete graph directly
  reachable. Region array order is not authorial semantics. Do not omit an independently useful behavior
  Structure merely because the file map exists.
- Direct the reviewer to code without creating an Artifact when the question is local, conditional,
  implementation-specific, or already clearer in source.
- Create no additional surface when it would merely restate another Artifact or add a join the reviewer
  must keep in working memory. This can remove an optional Walkthrough or behavior Structure, but it
  does not remove the PR-wide file map; narrow or split the map instead if its boundary is poor.

Never require a Walkthrough and Structure as a pair. Never require an overview Artifact, one Artifact
per candidate unit, or fixed Overview / State / Flow / Error / Test / Structure sections. A simple,
explicitly bounded subject may need one Walkthrough, one behavior Structure, or no Artifact. A PR-wide
composition may consist only of its small file map plus direct code reading, or may add useful
Walkthroughs and behavior Structures; it is never a fixed three-Artifact template. Artifact count is not
a quality measure, and "minimum useful" never means "fewest Artifacts." Compare total comprehension
cost. Split when one surface would overload two independently useful questions; merge or drop optional
surfaces when the reviewer would need multiple surfaces open just to understand one inseparable
invariant.

Before invoking a producer, prepare an internal Artifact brief with a single subject and review
question, explicit role (`walkthrough`, `file-map Structure`, or `behavior Structure`), scope and
exclusions, any requested spatial presentation, and the candidate claims that the Artifact must verify.
Also state the verified facts and terminology it should share with the composition and which question or
explanation another surface already owns so the producer does not duplicate it. For a Walkthrough,
identify any central relationship, state, ordering, or branching question that a diagram could help the
reviewer answer, and optionally name a promising diagram family. Treat every proposed participant,
state, order, transition, or branch as a candidate for producer verification, not a forced diagram
claim. Keep the brief's authoring bounds separate from its claims-to-verify; the composer's analysis does
not turn an implementation claim into a fact. The role and brief are authoring context, not public JSON,
a new Structure field, or rvw schema. Follow the detailed brief contract in the reference.

For each selected Artifact in an authorized production run, activate the installed sibling by its
canonical name through the current host's native Skill mechanism, then follow that producer's complete
Skill and authoring reference. In a read-only composition, keep the brief unproduced:

- `rvw-walkthrough` for one Walkthrough brief.
- `rvw-structure` for one file-map or behavior Structure brief.

In Codex, activate the named entry from the available Skill inventory. In Claude Code, invoke the named
Skill with the Skill tool. In both hosts, load the full producer instructions before any Artifact
operation.

Do not treat `$name`, `/name`, or another host's user-facing syntax as a cross-host invocation
protocol. If the selected producer is unavailable or disabled in the current session, stop before any
Artifact operation and report that installation or host-configuration problem; do not imitate the
producer contract from this Skill.

Pass the subject, review question, purpose or behavior boundary, scope, inclusions, exclusions, and
emphasis as authoring authority: they control what the producer investigates, not what the code must
say. For a Structure, also pass any requested thesis, semantic attention-start concept, connected
exact-relation visual backbone, and named comprehension chunks to consider as Regions as presentation
authority over verified claims. Describe a new backbone by the relationship claims it should emphasize
and a new Region by the chunk's meaning, responsibility, and contribution to the thesis. The composer
does not assign protocol IDs for a new Structure. The Structure producer builds the verified graph,
resolves the attention-start concept to one current Node ID, resolves the backbone claims to exact
current Edge IDs, resolves each accepted chunk to exact Node membership, and assigns each new Region a
fresh ID that becomes stable across same-chunk updates. Refer to raw IDs only when they came from an
existing Structure read. A suggested factual origin remains a separate claim to verify and is not
automatically the attention start. A requested backbone must resolve to a compact connected exact Edge
set with the start among its derived endpoint Nodes. A requested Region needs a concise statement of how
its chunk contributes to the thesis and which responsibility concepts seem to belong together; the
producer decides the exact unordered disjoint Node membership. Never require the start or every Node to
belong to a Region, interpret Region array order as guidance, or request authored Region-to-Region
relations; the Viewer derives cross-Region connections only from verified factual Edges.
When a meaningful thesis and start exist but no honest backbone or useful named chunk does, request the
exact start-only form rather than a fake backbone, dummy region, or decorative grouping.
Do not request authored layers or stages; spatial ranks remain renderer-derived.
Pass `mustEstablish`, a suggested origin, relationship, invariant, and every other implementation
assertion as claims to verify independently in committed source and tests. Do not reimplement the
producer's source, format, preview, identity, concurrency, publish, update, or delete contracts here,
and do not invent a generic sub-Skill invocation framework. If a producer rejects the requested
representation or reports that an essential claim is unsupported or contradicted, return that result
to composition and revise the brief, choose a better surface, or direct the reviewer to code; never
make the producer broaden the subject or force the claim to compensate.

For a file-map brief, pass the bounded change area, candidate files and file responsibilities, candidate
direct relationships, deliberate exclusions, and a candidate real file from which source verification
could begin. Do not describe that origin as a common runtime entrypoint, assign one Node to several
files, split one file across Nodes, infer runtime behavior from an import, or ask the producer to connect
independent areas. The Structure producer independently verifies the final files, predicates, evidence,
origin, and connectedness under its file-map authoring contract.

For a Walkthrough diagram question, describe the phenomenon the reviewer should understand, such as an
older response arriving after a newer request. A suggestion that `sequenceDiagram` may fit is useful;
an unverified assertion that particular calls are concurrent or always ordered is not. The Walkthrough
producer chooses the final diagram type, scope, syntax, and supported bindings after inspecting source.

Do not dispatch producer handoffs as a batch. Start with the independently useful Artifact whose
verified answer most constrains the remaining composition. After each producer result, use the actual
source-supported answer and terminology to re-evaluate every unpublished brief for overlap, changed
scope, and hidden coupling; then drop, revise, or invoke the next producer. A successful producer may
refine a candidate claim without rejecting the representation, so recomposition is not limited to
errors. Never publish an Artifact whose usefulness depends entirely on a later producer establishing
another brief.
The required file map does not force investigation order, producer invocation order, or human reading
order. Invoke it first only when its verified answer genuinely constrains the remaining composition.

## Existing Artifacts

When the user or caller supplies an existing Artifact URI and transport is available, have the matching
producer read its current value and skip an unnecessary list. When no Walkthrough URI is supplied and
existing work affects composition, have `rvw-walkthrough` page through `walkthrough list`; follow
`hasMore` / `nextOffset` whenever an exhaustive no-match decision is needed, then read every plausible
candidate with `walkthrough get`. A title alone is not evidence of the Artifact's subject, boundary, or
current contents. Prefer an authorized in-place update for the verified same subject over a duplicate
publication; use a new Walkthrough for a different bounded subject. Do not publish a duplicate
"revision" by default.

For a PR-wide file map, have `rvw-structure` use `structure list` to inspect candidate summaries and
read a plausible current map before publishing another one. Prefer a still-valid same-subject map at
the selected source, then an authorized in-place update, over a duplicate publication. In an authorized
production run, publish a new one only when no verified candidate fits or the subject is genuinely
different. List and get are separate reads rather than a
fixed snapshot, and neither read grants update or delete authority. If transport is unavailable, the
preflight diagnostic wins and the read cannot occur. Never rewrite an Artifact into a different subject
or delete one merely because the new composition omits it; normal preview and explicit deletion
authorization still apply. Use only these CLI discovery operations—never SQLite, internal file paths,
remembered URIs, or invented identity.

## Finish as a composition

Before finalizing, check the whole composition for detailed overlap, terminology drift, missing
important boundaries, over-fragmentation, and cross-boundary risk. Drop or rescope an unpublished
optional candidate when it does not lower total comprehension cost. For a PR-wide composition, confirm
that every necessary independent change area has an honest file map, without inventing connectivity or
claiming impact completeness. Never delete any published Artifact,
including one created during this composition, without the matching producer's normal deletion preview
and the user's explicit authorization.

Report in the normal Agent response:

- why this composition minimizes total comprehension cost rather than merely Artifact count;
- a recommended first entry, without claiming a mandatory or complete review plan;
- every reused, created, or updated `rvw://walkthrough/<uuid>` and `rvw://structure/<uuid>` URI, or an
  explicit statement that the recommendation was read-only and remains unproduced;
- what each file map includes, what it deliberately excludes, and what remains for direct code reading,
  with a brief reason; and
- any required file map that remains unmet, with the exact source, authority, capability, transport, or
  representation reason. Never fabricate a Node, Edge, anchor, or URI to make the requirement appear met.

The response is not a persistent Artifact. State that the committed code remains the source of truth
and leave the reviewer free to enter through a file map, a behavior Structure, a Walkthrough, or code in
another order.
