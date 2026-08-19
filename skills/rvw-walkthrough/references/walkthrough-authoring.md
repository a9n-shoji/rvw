# Walkthrough authoring guide

Use this guide when creating a Walkthrough or materially revising its explanation. Treat it as defaults for choices that explicit instructions do not settle, not as a required output template.

## Establish authority and purpose

Apply inputs in this order:

1. Follow explicit directions from the user, caller, Pull Request body, or upstream Skill.
2. Fill gaps with facts verified in the diff, committed code, tests, documentation, and available Pull Request context.
3. Use only necessary inference when facts do not establish intent. Mark the inference or uncertainty instead of presenting it as fact.

Honor partial directions for the parts they cover and use this guide for the rest. Add minimal context when an instruction would otherwise leave the Walkthrough unintelligible, but do not substitute a different goal.

Provide an initial route through the implementation that lowers the cost of building a mental model. Let the reviewer choose which references to open and where to explore next. Do not present the route as the full review boundary or as a substitute for the committed source.

When the requested subject is a standalone architecture, flow, or surrounding-code explanation rather than a change, treat its central responsibility, contract, or path as the center. Do not require a diff or invent a change narrative.

## Build the default reading path

1. **Identify the center.** For a change, compress the problem addressed, externally visible behavior change, main before/after difference, new concept or responsibility, and connection to an existing mechanism into one central explanation. For a standalone subject, identify its central responsibility, contract, or path. When purpose is not established, describe only the verified implementation and state what remains unknown.
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
- Do not center the output on AI review findings or suggested improvements.
- Do not claim the Walkthrough is sufficient, exhaustive, or evidence that the change can be approved.
- Do not invent business intent or external constraints.
- Do not force every subject into the same headings, number of steps, or prose structure.
- Do not narrate code line by line when relationships, responsibility, or behavior are the useful information.

## Check before publishing

Use this checklist internally; do not reproduce it mechanically in the Walkthrough.

- [ ] Explicit instructions take priority, and defaults fill only their gaps.
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
- [ ] A reviewer seeing the subject for the first time gains a useful route into the committed code.
