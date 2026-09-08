---
name: rvw-structure
description: Read, publish, replace in place, or explicitly delete one source-anchored relationship map with optional authorial spatial presentation through the local rvw CLI. Use for either one bounded PR-relevant behavior or review question, or one PR-scoped file map whose Nodes are repository files and whose Edges are verified inter-file relations. Use rvw-review-compose when the user asks which Walkthroughs or Structures a whole review subject needs. Use rvw-walkthrough when ordered prose and transitions are the explanation, and do not create a Structure for a generic repository-wide architecture or responsibility inventory.
---

# rvw Structure management

Create one freely explorable review space in exactly one of these authoring roles:

- A **behavior / review-question Structure** maps one bounded PR-relevant behavior from a factual code
  entrypoint through the responsibilities, dependencies, contracts, and side effects needed to verify it.
- A **PR-scoped file map** maps the physical implementation locations needed to understand a declared
  change scope: one Node is one real repository file, and each Edge is a concrete, source-verifiable
  relation between two represented files.

Both roles use the existing Structure shape; do not add a role field, Node kind, notation, or other
public schema to distinguish them. State the selected role and boundary through the title, scope, brief,
and authored claims. Do not mix file-granularity Nodes with symbol, responsibility, concept, subsystem,
or whole-PR Nodes in one file map. A Structure is a freely explorable spatial explanation whose complete factual graph remains
available; a Walkthrough makes ordered prose and transitions the artifact. A Structure may name an
attention start, emphasize at most
one connected exact-relation visual backbone of at most 12 derived Nodes and 16 Edges, and identify stable,
named comprehension Regions with concise responsibility summaries, but it remains freely explorable and
is never a stepper or autoplay. Region array order is not authorial semantics. A path, hub,
fan-out, convergence, reciprocal pair, or small cyclic skeleton can be the backbone. When a meaningful thesis
and attention start exist but neither an honest backbone nor a useful comprehension region does, an exact
start-only presentation is valid: topology still supplies the geometry while presentation supplies the
overview, initial attention, and initial focus for a new Viewer session. If the clearest
explanation needs a required reading order because prose between sequential stops, a required ending, or
route transitions carry the meaning, stop without publishing and recommend `rvw-walkthrough` to the
requester or upstream composer. Do not create that Walkthrough from this Skill. For a behavior map, do
not publish when there is no defensible factual entrypoint and the result would be a generic static architecture,
subsystem catalog, or responsibility inventory. In that case, do not publish a Structure.
A file map does not require one runtime
entrypoint common to every file, but it must remain grounded in a specific Pull Request or declared
change scope and may not become a repository-wide architecture diagram, changed-files listing, import
graph, or generic repository-wide responsibility inventory. These representation rejection boundaries still apply to an
upstream brief.
Do not author backbone layers or stages; the Viewer derives visual ranks from the connected relation set.

For a behavior / review-question Structure, the request may begin with a behavior or with a selected file,
symbol, or changed source. For a source-led request, first identify the concrete PR-relevant behavior in
which that source participates, then find its factual origin and map only that behavior. If the source
participates in multiple independently triggered behaviors, do not join them and do not publish separate Structures autonomously.
Follow an explicitly supplied behavior boundary; when none is established,
report the candidate boundaries to the requester or upstream composer so that they can choose the subject.

For a file map, investigate the changed files and the unchanged callers, consumers, dependencies, type or
contract definitions, state owners, wiring, configuration, tests, migrations, and documents needed to
understand the declared change. Include only files whose PR-specific responsibility or relation matters to
that understanding. Do not mechanically include every changed file or exclude a file because of its
category, and do not expand to the repository's complete dependency graph. State what the map includes,
what it intentionally excludes, and what is left to direct code reading. If the relevant files form
genuinely independent relation sets, do not connect them with a fabricated whole-PR Node or a vague Edge.
Return the need for separate file-map invocations to the requester or upstream composer. Conversely, do
not split a map merely to hide a real shared contract or dependency.

This Skill produces, updates, or deletes at most one Structure for the selected role and subject. When an
Artifact brief from the user, caller, Pull Request body, or an upstream Skill supplies a subject, review
question, authoring role, behavior boundary, file-map boundary, scope, inclusions, exclusions, emphasis,
or requested spatial presentation, treat those choices as authoring authority over what this Structure
investigates and how it presents verified claims. Treat `mustEstablish`, suggested origins,
relationships, invariants, and every other implementation assertion as claims to verify independently
in committed source and tests, not as facts or conclusions to force. The brief does not override source
exactness or the representation rejection rules above. Inspect broader Pull Request context only as
evidence, and do not mistake a valid anchor for semantic proof. When source establishes a different
answer inside the same question and scope, use that answer. When an essential claim or origin is
unsupported or contradicted and resolving it would materially change the question, role, or boundary, do not publish
it; report the conflict to the requester or upstream composer. Do not decide the Pull Request's
Artifact count or Walkthrough / Structure mix, guarantee coverage of other review subjects, or publish
companion Artifacts.

When invoked directly without an upstream brief, derive one bounded Structure in the role established by
the user's explicit request and verified facts. Standalone Structure creation remains supported. Do not
infer product intent, invent architectural semantics, or turn related files into an exhaustive map.

Use only the `rvw` CLI protocol. Never access SQLite directly, control the viewer, open a Structure,
select a node, or claim that publication changed rvw navigation.

## Preflight

1. Run `rvw protocol --json` and parse stdout as JSON.
2. Require `protocolVersion` 5, `agent.transport`, and `structure.presentation` so version-5 current
   values can be parsed. Require only the operation capabilities the task uses: `structure.read` for
   `get`, `structure.list` for listing or uncertain-publication recovery, `structure.preview` before
   publish or update, and the corresponding `structure.publish`, `structure.update`, or
   `structure.delete` capability for each requested mutation.
3. Run `rvw agent status --json`. If `selectedTransport` is `unavailable`, stop and report its
   diagnostic. Otherwise use the reported transport without overriding it.
4. Require local access to the saved repository and an exact committed source OID containing every
   anchor. Never publish anchors into uncommitted code.

## Read before replacing

For an existing Structure, run:

```bash
rvw structure get '<STRUCTURE_URI>' --json
```

Read the complete current subject, source OID, presentation, nodes, edges, anchors, and Pull Request repository
location. Keep its exact `updatedAt` for any update or authorized delete. A Structure has one current
value and no local revision history.

When a publish result was not received, recover stable references with:

```bash
rvw structure list '<PULL_REQUEST>' --json
```

## Author the relationship map

When authoring or materially revising a Structure, read
[the Structure authoring contract](references/structure-authoring.md). It defines subject and scope
selection for both authoring roles, stable identities, claims, anchors, spatial presentation, update
boundaries, and the internal completion check.

Prepare one complete JSON value. `sourceOid` is the single coordinate for all node and edge anchors.
Each node may have zero or one `anchor`; each edge may have zero or more `anchors`. For any anchor,
provide both positive inclusive `startLine` and `endLine`, or omit both. Use repository-relative paths.
`originNodeId` and `presentation` are required; use `presentation: null` when no authorial spatial
semantics are justified. A non-null presentation includes `thesis`, `startNodeId`, `primaryBackbone`, and
`regions` explicitly; `primaryBackbone` may be `null` and `regions` may be empty under the authoring contract.
Stable-sort the backbone's exact Edge IDs, each Region's unordered Node membership, and the Region array
by stable ID.
Do not add authored layer, stage, coordinate, rank, or route fields.
The origin Node must have a source anchor, and every Node must be reachable from it when relation direction
is ignored. The complete Structure contains no more than 400 source anchors.

Every `--stdin` command reads until EOF. Supply the entire object and close stdin in the same
non-interactive invocation; do not start an interactive PTY and send only JSON plus a newline.

## Preview before publishing or updating

Immediately before `publish` or `update`, preview the exact Structure content that will be sent. Omit
only command metadata: `pullRequest` and `idempotencyKey` for publication, or `expectedUpdatedAt` for
an update. Keep `sourceOid`, `title`, `scope`, `originNodeId`, `presentation`, `nodes`, and `edges` identical:

```bash
rvw structure preview --stdin --json
```

Parse the presentation-independent topology `layout` diagnostics and `warnings`. Treat `maxRows >= 8` or
`nonForwardDirectionalLinkRatio >= 0.25` as authoring smells in either role. For a behavior / review-question
Structure, also treat `originOutgoingDirectionalLinkCount === 0` as a reason to recheck whether the origin
is the factual behavior entrypoint. For a file map, the origin identifies where source verification of the
bounded file relations can begin; it is not promised to be a shared runtime entrypoint or to have an
outgoing directed relation. A one-file map with no meaningful inter-file relation must contain one Node
and zero Edges, so that warning is expected and must not cause a dummy dependency, reversed relation, or
decorative Edge. In all cases reconsider granularity, overlapping claims or anchors, mixed subjects, and
an over-broad boundary when the other diagnostics expose them.

Preview validates the machine shape, graph-wide invariants, presentation, and derived layout only. It
does not read `sourceOid` or resolve anchor paths and ranges. Independently confirm every anchor against
that committed source before treating a successful preview as ready; publish and update perform the
source-aware validation when a write is requested.

These diagnostics deliberately ignore authorial presentation geometry, so reverse spatial reading does
not count as a reversed factual relation. They are not validation failures. If the factual graph does not improve after reconsideration,
publish or update it and explain why the warning remains when useful. Never change factual edge
direction, the factual origin, predicate wording, or a node responsibility claim merely to improve a
layout score. Do not implement or invoke a separate Skill-side layout preview.

## Publish

```bash
rvw structure publish --stdin --json <<'RVW_JSON'
{
  "idempotencyKey": "task-stable-key-for-this-structure-publication",
  "pullRequest": "https://github.com/owner/repo/pull/123",
  "sourceOid": "0123456789abcdef0123456789abcdef01234567",
  "title": "Request policy boundary",
  "scope": "The committed request policy and the code contracts it directly depends on; transport setup and UI callers are excluded.",
  "originNodeId": "request-policy",
  "presentation": {
    "thesis": "The request decision is grounded in one committed input contract.",
    "startNodeId": "policy-input",
    "primaryBackbone": {
      "edgeIds": ["request-policy-consumes-policy-input"]
    },
    "regions": [
      {
        "id": "decision-contract",
        "label": "Decision contract",
        "summary": "Connects the committed policy input to the allow/deny decision.",
        "nodeIds": ["policy-input", "request-policy"]
      }
    ]
  },
  "nodes": [
    {
      "id": "request-policy",
      "label": "RequestPolicy",
      "description": "Owns the allow/deny decision.",
      "notation": "class",
      "anchor": { "path": "src/request-policy.ts", "startLine": 8, "endLine": 34 }
    },
    {
      "id": "policy-input",
      "label": "PolicyInput",
      "description": "Committed input contract consumed by RequestPolicy.",
      "notation": "interface",
      "anchor": { "path": "src/types.ts", "startLine": 3, "endLine": 12 }
    }
  ],
  "edges": [
    {
      "id": "request-policy-consumes-policy-input",
      "from": "request-policy",
      "to": "policy-input",
      "label": "consumes",
      "directed": true,
      "anchors": [{ "path": "src/request-policy.ts", "startLine": 10, "endLine": 15 }]
    }
  ]
}
RVW_JSON
```

Let the CLI reject invalid commits, paths, ranges, identities, endpoints, origin, presentation, connectivity, size, or ownership;
never silently remove rejected graph elements. Parse the success response and report the returned
`rvw://structure/<uuid>` reference. Generate one key for the logical publication and retain it until
the result is known. After a timeout or connection loss, retry only the identical payload with that
same key; the retry returns the original Structure. Never reuse the key for changed content.
Publication is passive.

Parse any returned `warnings` as response-derived authoring feedback. They do not mean publication
failed and are not persisted graph content.

## Replace the current value

Use an in-place update only when the requested subject identity remains the same. Preserve IDs for
surviving Nodes and Edges even when their labels or anchors change, and preserve a Region ID while the
same comprehension chunk survives. Never recycle removed Node, Edge, or Region IDs for new claims or
chunks, and send the complete replacement value. rvw records all three retired ID kinds and rejects their reintroduction even
when the current value no longer contains them:

```bash
rvw structure update '<STRUCTURE_URI>' --stdin --json
```

The JSON contains the `expectedUpdatedAt` read from the current Structure plus `sourceOid`, `title`,
`scope`, `originNodeId`, `presentation`, `nodes`, and `edges`; it does not contain `pullRequest`. If a conflict reports
that the current value changed, read it again and reconcile instead of retrying the stale replacement.
If the subject itself changed, publish a new Structure rather than rewriting the old identity. Updating
is passive and retains no previous Structure value.

## Delete only with explicit authorization

First inspect the exact deletion preview:

```bash
rvw structure delete '<STRUCTURE_URI>' --json
```

Only after the user explicitly authorizes deleting that exact Structure after reviewing the reported
node, edge, and source-anchor counts, run:

```bash
rvw structure delete '<STRUCTURE_URI>' --yes --expected-updated-at '<PREVIEW_UPDATED_AT>' --json
```

Never infer deletion permission from a request to revise, replace, or republish. Retained commit refs
may be shared by other review state and remain managed by `rvw pr reset`.
