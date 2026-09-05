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
as evidence without taking responsibility for PR-wide coverage, choosing an Artifact count or type mix,
or publishing a companion Artifact. If a bounded brief conflicts with the representation or cannot be
made understandable inside its exclusions, return the conflict to the requester or upstream composer.

Provide an initial route through the implementation that lowers the cost of building a mental model. Let the reviewer choose which references to open and where to explore next. Do not present the route as the full review boundary or as a substitute for the committed source.

When the requested subject is a standalone architecture, flow, or surrounding-code explanation rather than a change, treat its central responsibility, contract, or path as the center. Do not require a diff or invent a change narrative.

## Build the default reading path

1. **Identify the center.** Use the supplied subject and review question when present; do not recenter on the whole change. Otherwise derive the smallest coherent implementation question from the explicit request and verified facts. A Walkthrough should have one central path, not absorb every independently useful concept in the Pull Request. For a change, connect only the problem, visible behavior, before/after difference, concept, responsibility, or existing mechanism needed for that path. For a standalone subject, identify its central responsibility, contract, or path. When purpose is not established, describe only the verified implementation and state what remains unknown.
2. **Trace the structure.** Inspect the diff when the task concerns a change, and inspect beyond changed files whenever useful. Consider entry points, callers, callees, data producers and consumers, state transitions, persistence, external I/O, events or jobs, types and contracts, existing implementation, and tests. Stop exploring branches that do not clarify the center.
3. **Choose a comprehension order.** Prefer a causal or conceptual sequence over file or diff order. Useful sequences include external entry to internal handling, caller to callee, data creation to transformation to storage to use, old mechanism to new difference, abstraction to implementation, contract to implementation, or representative case to repeated applications.
4. **Select the minimum useful route.** Use as few steps as needed to understand the central structure. A local change may need one to three steps; a multi-layer flow may need more. Do not add steps merely to appear complete.
5. **Anchor every step.** State what to inspect, the exact file, symbol, or range, its role, what it does or what changed, how it connects to adjacent steps, and why reading it advances understanding. Prefer relationships and consequences over translating code line by line.
6. **Include unchanged code selectively.** Include a key caller, maintained contract, replaced path, downstream consumer, side-effect subscriber, model defining state meaning, or existing implementation needed to interpret a test when it materially improves orientation.
7. **Choose an intentional endpoint.** Stop after the reviewer can explain the subject's center, trace the main flow, see how it connects to the existing system, and identify useful starting points for deeper exploration.

## Adapt to the subject

- For a standalone architecture or flow, explain the central responsibility or contract and trace representative connections without manufacturing a before/after distinction.
- For a local behavior change, show the before/after behavior and the main decision point briefly; avoid a broad architecture tour.
- For a new feature or processing path, follow the user or system entry through the main processing, data, persistence, and side effects in causal order.
- For a cross-cutting change, explain the shared rule first and then show a few representative applications; do not enumerate every similar file.
- For a refactor, focus on changed responsibilities, dependencies, and contracts rather than file movement. Point to tests or invariants when preserved behavior matters.
- For a mechanical or repetitive change, explain the pattern and a small number of representative examples.
- For a data model or migration, explain data meaning, compatibility, write and read paths, migration order, and relevant application connections.
- For a UI change, consider user action, state, data retrieval, component connections, and rendered outcome rather than a component list.
- For an API or external integration, consider contract, input, transformation, internal processing, output, and error handling.
- For a test-centered change, connect the behavior being guaranteed to the implementation rather than walking through test files alone.

## Choose a visual format

Prefer ordinary Markdown for prose and Mermaid for structure or flow. Use an `html-preview` fence only
when spatial layout, an ELI5 visual hierarchy or metaphor, a UI mock, or a Before / After comparison
materially lowers the reader's comprehension cost. The Walkthrough may consist mostly or entirely of
one HTML preview when that is the clearest requested format; it remains a Markdown document.

For an interactive Mermaid code reference, put the explicit Mermaid source ID in `diagramBindings`.
The supported targets are flowchart nodes, classDiagram classes, sequenceDiagram participants and actors,
stateDiagram-v2 states, erDiagram entities, and architecture-beta services. For example, bind `C`, not
the `Controller` display alias in `participant C as Controller`, and bind `worker`, not `Worker` in
`service worker(server)[Worker]`. Do not bind sequence messages, state transitions, ER relationships,
architecture edges/groups, or Mermaid-generated sequence numbers. If Mermaid does not retain a stable
source ID for an element, leave it passive instead of deriving a key from its label or DOM order.
Bindings apply across the whole Walkthrough: if multiple Mermaid fences reuse one source ID, every match
opens the same reference. Use distinct IDs such as `orderDb` and `analyticsDb` when those elements should
open different references.

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

Prefer a connected path whose shape follows the implementation:

```markdown
Start at [the request contract](rvw-ref:request-contract) to see the new input and the boundary that
accepts it. Follow that value into [the orchestration step](rvw-ref:orchestrator), where the existing
flow now selects the new behavior. Then inspect [the unchanged consumer](rvw-ref:consumer) to see why
the produced state has this shape, and finish at [the behavior test](rvw-ref:behavior-test), which
records the observable before/after distinction. These references establish the main path; the
adjacent error handling remains a useful next exploration point.
```

This route may cross changed and unchanged code, gives each stop a reason, and remains useful without claiming completeness. Adapt its organization and length; do not copy it as a fixed template.

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
- Do not narrate code line by line when relationships, responsibility, or behavior are the useful information.

## Check before publishing

Use this checklist internally; do not reproduce it mechanically in the Walkthrough.

- [ ] Explicit instructions take priority, and defaults fill only their gaps.
- [ ] The Walkthrough answers one bounded review question and does not assume PR-wide coverage.
- [ ] Supplied inclusions, exclusions, and emphasis were preserved; `mustEstablish` claims were verified
      rather than assumed or forced.
- [ ] Adjacent subjects were reported to the caller rather than turned into companion Artifacts.
- [ ] The subject is genuinely clearer as an ordered path; otherwise no Walkthrough was published.
- [ ] The requested subject or change center can be stated briefly without unsupported intent.
- [ ] The order builds a mental model rather than mirroring file or diff order.
- [ ] Each step connects to exact code or another concrete subject and explains why it matters.
- [ ] Adjacent steps have a causal or conceptual connection.
- [ ] Necessary unchanged code is included and incidental related files are omitted.
- [ ] The depth matches the size and nature of the requested subject.
- [ ] Facts, inference, and unknowns are distinguishable.
- [ ] The output is an orientation path, not an AI review, approval plan, or completeness claim.
- [ ] The endpoint leaves clear starting points for continued exploration.
- [ ] Every file, symbol, range, link, and binding is real and valid at the selected commit.
- [ ] Any HTML preview is static, network-free, readable in both themes, pretty-printed, and used only where it improves comprehension.
- [ ] A reviewer seeing the subject for the first time gains a useful route into the committed code.
