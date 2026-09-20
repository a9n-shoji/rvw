# Walkthrough authoring guide

Use this guide when creating a Walkthrough or materially revising its explanation. Treat it as defaults for choices that explicit instructions do not settle, not as a required output template.

## Establish authority and purpose

Apply inputs in this order:

1. Follow explicit directions from the user, caller, Pull Request body, or upstream Skill. A supplied
   subject, review question, purpose, scope, inclusions, exclusions, and emphasis are authority over
   what this Walkthrough investigates and how it is bounded.
2. Treat `mustEstablish` and any suggested implementation fact, relationship, or invariant as a claim
   to verify independently in the diff, committed code, tests, documentation, and source-controlled
   contracts. Never treat the caller's conclusion as its own evidence.
3. Use only necessary inference when facts do not establish intent. Mark the inference or uncertainty
   instead of presenting it as fact.

Authority over the authoring question is not proof of its answer. A factual assumption embedded in an
authoritative field still needs source verification, and an exact source range does not establish the
semantic claim by itself. Explicit off-repository intent may control the requested purpose when it is
attributed as external context, but it does not establish current code behavior. When committed source
supports a different answer without changing the central question or scope, use the supported answer.
When an essential claim is unsupported or contradicted and resolution would change the question or
cross an exclusion, do not publish it; return the conflict to the requester or upstream composer.

Honor partial directions for the parts they cover and use this guide for the rest. Add minimal context when an instruction would otherwise leave the Walkthrough unintelligible, but do not substitute a different goal.

This guide governs one Walkthrough, not the Pull Request's Artifact composition. Use broader PR context
as evidence without claiming PR-wide coverage, choosing an Artifact count or type mix,
or publishing a companion Artifact. If a bounded brief conflicts with the representation or cannot be
made understandable inside its exclusions, return the conflict to the requester or upstream composer.

Provide an initial route through the implementation that lowers the cost of building a mental model.
Begin with a concrete situation or question and an inspectable code entry. Introduce broader
architecture and terminology only when the reader needs them to understand the code now in view; do
not make a large glossary, a repository-wide model, every changed file, or a giant overview diagram
mandatory preparation. Let the reviewer choose which references to open and where to explore next. Do
not present the route as the full review boundary or as a substitute for the committed source.

When the requested subject is a standalone architecture, flow, or surrounding-code explanation rather than a change, treat what starts the mechanism, the contract it consumes, or the data it transforms as the center. Do not require a diff or invent a change narrative.

## Build the default reading path

1. **Establish local footing.** Use the supplied question without recentering on the whole PR. Assume
   general programming and stack knowledge, but no local vocabulary, state model, or prior reading of
   the PR body, file map, or other Artifacts. Before the first code reference, give enough context that
   the reader can explain what mechanism this is, what situation is being considered, and what the
   code check will establish. Introduce a term where it is needed. Investigate missing context in
   source and available PR information; do not invent business intent or demand a large introduction.
2. **Choose what stays connected.** For behavior or data flow, identify one input, operation, record,
   event, or concrete failure, its starting conditions, and an outcome sufficient to answer the
   question. Follow the brief when supplied, while verifying its proposed case and path. A conflict
   or failure can be the main case. For a contract or local comparison, use that question directly;
   do not manufacture a UI journey or a before/after story for a standalone explanation.
3. **Investigate the actual handoffs.** Inspect relevant changed and unchanged callers, callees,
   transformations, state writes, persistence, later reads, events, jobs, and callbacks. An input can
   become a request, a differently typed record, then a displayed result: find what preserves the
   connection to this case at each transition. Registration does not prove invocation, and an import
   does not prove execution or data flow. If an essential connection cannot be established, state the
   gap and return a conflicting brief rather than making up a tidy path.
4. **Carry the case through each code stop.** Explain the received data or current state, the relevant
   condition or transformation, the resulting output or update, and how the next consumer gets it.
   Select only the facts needed at that point; do not print these as fixed headings or narrate every
   line. Give each reference a verification question and explain what it establishes about this case.
   Describing a controller, service, and repository in succession is insufficient if the reader must
   infer which result each one receives. Explain a component when the case needs it, not in a prior
   inventory. For conceptual paths, make the comparison or dependency between stops equally explicit.
5. **Preserve the real ordering.** Choose a helpful reading order, but distinguish it from execution
   order and a representative trace from a guaranteed schedule. Keep waits, concurrent work, retries,
   callbacks, and races visible in prose as well as diagrams. Mark invented example values as
   illustrative, not observed. Separate case assumptions from source-established conditions, and
   source facts from inference, test assertions, actual execution results, and unknowns.
6. **Stop where the model becomes usable.** Use the smallest route that reaches the chosen outcome;
   do not force a full UI-to-storage-to-UI tour. Summarize a shared rule only after establishing the
   concrete connections that support it. Finish with a meaningful condition to change and the code
   that could confirm its effect, so the reader can continue exploring without a related-file list.

Explain design choices through consequences supported by source or an attributed constraint: which
caller or consumer would change, which check would be duplicated, or which saved value could disagree.
Do not justify moving or grouping code solely with abstract module labels. If the evidence is missing,
leave that judgment open. Concrete explanation need not be a line-by-line translation.

## Adapt to the subject

- For a standalone architecture or flow, explain what starts the mechanism or which contract is consumed and trace representative connections without manufacturing a before/after distinction.
- For a local behavior change, show the before/after behavior and the main decision point briefly; avoid a broad architecture tour.
- For a new feature or processing path, follow the user or system entry through the main processing, data, persistence, and side effects in causal order.
- For a cross-cutting change, explain the shared rule first and then show a few representative applications; do not enumerate every similar file.
- For a refactor, show which callers, checks, writes, or consumed contracts change, rather than only file movement. Point to tests or invariants when preserved behavior matters.
- For a mechanical or repetitive change, explain the pattern and a small number of representative examples.
- For a data model or migration, explain data meaning, compatibility, write and read paths, migration order, and relevant application connections.
- For a UI change, consider user action, state, data retrieval, component connections, and rendered outcome rather than a component list.
- For an API or external integration, consider contract, input, transformation, internal processing, output, and error handling.
- For a test-centered change, connect the behavior asserted by the test to the implementation rather
  than walking through test files alone.

## Deepen at real boundaries

Vary a condition of the established case when explaining failure, retry, re-entry, cancellation,
race, existing data, compatibility, cleanup, permission, lifecycle, or state-update timing. State what
stays the same until the divergence, which condition changes the route, what no longer happens, what
happens instead, and where it rejoins or ends, selecting only the distinctions that matter. A failure
can be the central case rather than an obligatory later chapter. Do not enumerate all branches or
isolate “error handling,” “lifecycle,” and “tests” from the case whose behavior they qualify.

Place a relevant test beside the behavior or boundary it helps the reader inspect instead of saving all
tests for a final inventory. Keep these claims separate: a test exists; it was executed; that execution
passed; and the asserted property is generally guaranteed. Report only the claims supported by the
available source and execution evidence. Likewise distinguish stated intent, source-established fact,
necessary inference, and unknown intent or behavior.

## Choose a visual format

Use Mermaid as a standard explanatory tool when several relationships, actors, states, conditions,
branches, interactions, or lifecycle transitions would otherwise have to be reconstructed in working
memory from prose. A diagram is unnecessary when a constant, wording change, or local condition is
clearer in a short sentence and exact code. Rendering successfully proves only that the syntax is
accepted; every element and relation remains an authorial claim that must agree with committed source.

### Choose the notation by its question

- Use a `flowchart` when the question is which condition selects a branch, where control diverges or
  joins, or how data or processing is transformed. Do not use one merely as a generic box-and-arrow
  canvas for state, actor interaction, or type relationships. Distinguish control flow, data flow,
  dependency, and the reviewer's suggested reading direction rather than making one arrow mean all of
  them.
- Use `stateDiagram-v2` when the question concerns the states of one identified subject, who owns that
  state, the event that changes it, the guard that permits a transition, or its relevant side effect.
  Distinguish a state explicitly represented in code from an explanatory abstraction over conditions;
  do not imply that an enum or complete state machine exists when it does not. State the scope of a
  partial diagram, and use start or end markers only when they have a real lifecycle meaning. Function
  call order alone is not a state transition.
- Use a `sequenceDiagram` when the question concerns who calls or signals whom, request and response
  order, waiting, callback propagation, subscription, cancellation, background work, or a race. Verify
  each participant, message, order, condition, wait, callback, response, and concurrency claim. Separate
  a representative trace from an order that always holds; source statement order does not establish
  asynchronous completion order, and multiple participants do not establish parallel execution. Keep
  callback registration and invocation as distinct events. Use `alt`, `opt`, `loop`, or `par` only when
  the distinction is necessary and source-established, and do not erase a central race or failure by
  drawing only a serial success path.
- Use `erDiagram`, `classDiagram`, or another notation that the current rvw Mermaid renderer safely
  supports when data or contract relationships are the actual question. Do not infer relation,
  direction, or cardinality from common design practice; verify it in source or a maintained contract.

Different diagram types may appear in one Walkthrough when they answer different questions, such as a
sequence diagram for a stale-response race and a state diagram for which result remains current. Do not
repeat the same explanation in several notations merely to add visual variety.

### Put a small diagram where it becomes useful

Treat one diagram as one central question. Place it at the point where the reader needs that relation,
state, sequence, or branch; do not front-load one architecture diagram containing every file, actor,
state, branch, and error. If labels become sentences or important elements become unreadably small,
narrow the scope, change the abstraction level, or split the explanation along genuinely different
questions. The surrounding prose should identify what matters, why it matters, what conditions or
exceptions the diagram omits, and which code verifies it instead of reading every box and arrow aloud.

### Connect diagrams to exact code

Mermaid rendering support is broader than rvw's element-binding support. For an interactive code
reference, put the explicit Mermaid source ID in `diagramBindings`. The supported binding targets are
flowchart nodes, classDiagram classes, sequenceDiagram participants and actors, stateDiagram-v2 states,
erDiagram entities, and architecture-beta services. For example, bind `C`, not the `Controller` display
alias in `participant C as Controller`, and bind `worker`, not `Worker` in
`service worker(server)[Worker]`.

Do not bind sequence messages, state transitions, ER relationships, architecture edges/groups, or
Mermaid-generated sequence numbers. A participant or state binding does not prove the arrows connected
to it. Put `rvw-ref:` links to the exact message, transition, guard, relationship, or ordering evidence
in nearby Markdown. If Mermaid does not retain a stable source ID for an element, leave it passive
instead of deriving a key from its label or DOM order.

Bindings apply across the whole Walkthrough: if multiple Mermaid fences reuse one source ID, every
match opens the same reference. Reuse an ID only when sharing that reference is intentional. Use
distinct IDs such as `orderDb` and `analyticsDb` when similar elements should open different references.

Use an `html-preview` fence only when spatial layout, an ELI5 visual hierarchy or metaphor, a UI mock,
or a Before / After comparison materially lowers the reader's comprehension cost. The Walkthrough may
consist mostly or entirely of one HTML preview when that is the clearest requested format; it remains a
Markdown document.

Keep HTML visuals static and self-contained:

- Author an HTML fragment only: do not include `<!doctype>`, `<html>`, `<head>`, or `<body>`.
  Put `<style>` directly inside the `html-preview` fence before the visual markup.
- Write HTML and CSS only. Never add JavaScript, event handlers, forms, frames, external stylesheets,
  fonts, images, or other network resources.
- Use inline `<svg>` for vector art. Use `<img src="docs/image.png">` only for an existing image at the
  Walkthrough `sourceOid`; resolve the path from the repository root, not from a Markdown file.
- Use theme variables such as `--rvw-bg`, `--rvw-fg`, `--rvw-muted`, `--rvw-border`, and `--rvw-accent`
  when practical, while allowing an intentional self-contained theme when the subject needs it.
- Put `rvw-ref:<referenceId>` on important code claims inside `<a href="...">` elements. HTML links
  participate in the same declared/used reference validation as Markdown links.
- Add `data-rvw-commentable` to cards, flow nodes, comparison panes, or other visual groups that a
  reviewer may need to question. Images, SVGs, figures, tables, sections, articles, asides, and details
  are commentable automatically.
- Give non-text visuals a visible caption or a meaningful `aria-label` so both the reviewer and a later
  Agent session can recover what the visual represents from the Markdown source.
- Pretty-print the HTML. Keep each semantic element on its own source line when practical so comments
  map to useful Walkthrough line ranges. Never minify authored HTML.
- Do not add decoration merely because HTML is available. For an ELI5 request, reduce prose and favor
  visual hierarchy, metaphor, Before / After, or flow only where it clarifies the verified subject.

Example:

````markdown
```html-preview
<style>
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card { padding: 16px; border: 1px solid var(--rvw-border); border-radius: 8px; }
</style>

<div class="cards">
  <section class="card" data-rvw-commentable>
    <h2>Before</h2>
    <p>Each screen decides.</p>
  </section>
  <section class="card" data-rvw-commentable>
    <h2>After</h2>
    <p><a href="rvw-ref:gateway">AuthGateway</a> decides once.</p>
  </section>
</div>
```
````

## Keep the review boundary clear

Do not turn the Walkthrough into an exhaustive bug list, style critique, security or performance review, improvement backlog, final approval decision, or guarantee that every risk was checked. Mention an important constraint, hazardous assumption, or deliberate tradeoff only when the reader needs it to understand the implementation, and frame it as a property to inspect rather than a review finding.

Do not pause for approval of an intermediate review plan unless the user explicitly requests an interactive workflow. Investigate and produce the completed Walkthrough in the same run.

## Compare weak and useful routes

Avoid a file inventory that paraphrases the diff:

```markdown
1. `request.ts` was changed.
2. `service.ts` was added.
3. `service.test.ts` was updated.
```

Avoid a review-findings list that replaces orientation:

```markdown
- Potential bug: the handler may reject an input.
- Style issue: the service is too large.
- Recommendation: rewrite the persistence layer.
```

The following is a hypothetical example, not a claim about an rvw feature or an executed result.
The reference names stand for code the producer would have to inspect before publication:

```markdown
A reviewer has selected two documents to export. Export saves a job that a worker can read later;
it does not create the archive during the request. Follow this one selection until the worker can
retrieve it. The two documents and job J are illustrative values.

At [the request check](rvw-ref:request), verify that both selected document IDs are accepted before
any job is saved. [The enqueue call](rvw-ref:enqueue) saves those IDs in job J and returns J's ID to
the caller. The selected IDs have now become persisted job input, not archive contents.
[The worker read](rvw-ref:worker) reloads J by that ID; check that it uses the saved document IDs.
This read can happen later, so the returned job ID does not prove an archive already exists.

Change one document to an ineligible status. The request check now rejects this same selection before
enqueue, so no J is saved on this path; inspect [the rejection test](rvw-ref:reject-test) for that
assertion. If the next question is what happens when a document disappears after enqueue, begin at
the worker read, where the saved IDs are used against the documents that still exist.
```

Adapt the length and form to the subject. This example preserves one selection across input, saved
job, and later read; general descriptions of request, queue, and worker would leave those connections
for the reader to supply. A small local condition can be clearer in a few sentences with no diagram.

## Avoid these anti-patterns

- Do not paraphrase the diff or list files in repository order.
- Do not stop at an abstract summary that cannot lead the reader into specific code.
- Do not bury the main path in every potentially related file.
- Do not expand one bounded subject into PR-wide coverage or publish companion Artifacts for adjacent
  subjects.
- Do not center the output on AI review findings or suggested improvements.
- Do not claim the Walkthrough is sufficient, exhaustive, or evidence that the change can be approved.
- Do not invent business intent or external constraints.
- Do not force every subject into the same headings, number of steps, or prose structure.
- Do not narrate code line by line when relationships, state changes, or behavior are the useful information.
- Do not make a broad glossary, file tour, or giant architecture diagram a prerequisite for the first
  code verification.
- Do not default every visual question to a flowchart or add a diagram where prose and code are clearer.
- Do not tidy away a state, branch, race, failure, or asynchronous uncertainty that the source retains.
- Do not restate the same explanation in prose and several diagrams; let each surface do distinct work.

## Check before publishing

Use this checklist internally; do not reproduce it mechanically in the Walkthrough.

- [ ] Explicit instructions take priority, and defaults fill only their gaps.
- [ ] The Walkthrough answers one bounded review question and does not assume PR-wide coverage.
- [ ] Supplied inclusions, exclusions, and emphasis were preserved; `mustEstablish` claims were verified
      rather than assumed or forced.
- [ ] Adjacent subjects were reported to the caller rather than turned into companion Artifacts.
- [ ] The subject is genuinely clearer as an ordered path; otherwise no Walkthrough was published.
- [ ] The requested subject or change center can be stated briefly without unsupported intent.
- [ ] Before the first code link, a new reader can explain the mechanism, situation, and reason for
      checking that code without reading another Artifact or the PR body.
- [ ] The order builds a mental model rather than mirroring file or diff order.
- [ ] For a behavioral path, the same case remains identifiable across transformations, saved state,
      later reads, and async handoffs; each stop explains what changed and why the next code matters.
- [ ] For a conceptual path, the comparison or dependency between stops is explicit without a forced
      execution story.
- [ ] Necessary unchanged code is included and incidental related files are omitted.
- [ ] The depth matches the size and nature of the requested subject.
- [ ] Facts, inference, and unknowns are distinguishable.
- [ ] Important variants name a changed condition, divergence, changed effect, and rejoin or endpoint
      relative to the established case, without becoming a fixed checklist.
- [ ] Claims about test existence, execution, pass status, and guarantees remain distinct.
- [ ] Every diagram answers one useful question with an appropriate notation, readable scope, and
      source-supported elements and relations; a diagram-free local explanation remains diagram-free.
- [ ] Bindable node-like elements use exact supported source IDs, while passive messages, transitions,
      and relations have nearby `rvw-ref:` evidence when they carry important claims.
- [ ] The output is an orientation path, not an AI review, approval plan, or completeness claim.
- [ ] At the endpoint, changing one condition lets the reader identify a likely divergence and code
      to inspect; a generic instruction to explore more does not suffice.
- [ ] Every file, symbol, range, link, and binding is real and valid at the selected commit.
- [ ] Any HTML preview is static, network-free, readable in both themes, pretty-printed, and used only where it improves comprehension.
- [ ] A reviewer seeing the subject for the first time gains a useful route into the committed code.
