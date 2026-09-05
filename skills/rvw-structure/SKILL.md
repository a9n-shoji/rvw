---
name: rvw-structure
description: Read, publish, replace in place, or explicitly delete one source-anchored relationship map through the local rvw CLI. Use when a reviewer needs to inspect the dependencies and side effects around one bounded PR-relevant behavior from a factual code entrypoint. Use rvw-review-compose when the user asks which Walkthroughs or Structures a whole review subject needs. Use rvw-walkthrough when the explanation is primarily an ordered path, and do not create a Structure for a generic static architecture or responsibility inventory.
---

# rvw Structure management

Create one review space that lets a human inspect one bounded PR-relevant behavior from a factual code
entrypoint through the responsibilities, dependencies, contracts, and side effects needed to verify
it. A Structure is a space; a Walkthrough is a path. If the clearest explanation has a required reading
order, beginning, and end, stop without publishing and recommend `rvw-walkthrough` to the requester or
upstream composer. Do not create that Walkthrough from this Skill. If there is no defensible entrypoint
and the result would be a generic static architecture, subsystem catalog, or responsibility inventory,
do not publish a Structure. These representation rejection boundaries still apply to an upstream brief.

The request may begin with a behavior or with a selected file, symbol, or changed source. For a
source-led request, first identify the concrete PR-relevant behavior in which that source participates,
then find its factual origin and map only that behavior. If the source participates in multiple
independently triggered behaviors, do not join them and do not publish separate Structures
autonomously. Follow an explicitly supplied behavior boundary; when none is established, report the
candidate boundaries to the requester or upstream composer so that they can choose the subject.

This Skill produces, updates, or deletes at most one Structure for the requested behavior. When an
Artifact brief from the user, caller, Pull Request body, or an upstream Skill supplies a subject, review
question, behavior boundary, scope, inclusions, exclusions, or emphasis, treat those choices as
authoring authority over what this Structure investigates. Treat `mustEstablish`, suggested origins,
relationships, invariants, and every other implementation assertion as claims to verify independently
in committed source and tests, not as facts or conclusions to force. The brief does not override source
exactness or the representation rejection rules above. Inspect broader Pull Request context only as
evidence, and do not mistake a valid anchor for semantic proof. When source establishes a different
answer inside the same question and scope, use that answer. When an essential claim or origin is
unsupported or contradicted and resolving it would materially change the question or boundary, do not
publish it; report the conflict to the requester or upstream composer. Do not decide the Pull Request's
Artifact count or Walkthrough / Structure mix, guarantee coverage of other review subjects, or publish
companion Artifacts.

When invoked directly without an upstream brief, derive one bounded Structure from the user's explicit
request and verified facts. Standalone Structure creation remains supported. Do not infer product
intent, invent architectural semantics, or turn related files into an exhaustive map.

Use only the `rvw` CLI protocol. Never access SQLite directly, control the viewer, open a Structure,
select a node, or claim that publication changed rvw navigation.

## Preflight

1. Run `rvw protocol --json` and parse stdout as JSON.
2. Require `protocolVersion` 4, `agent.transport`, `structure.read`, `structure.list`,
   `structure.preview`, and every one of `structure.publish`, `structure.update`, or
   `structure.delete` needed for the task.
3. Run `rvw agent status --json`. If `selectedTransport` is `unavailable`, stop and report its
   diagnostic. Otherwise use the reported transport without overriding it.
4. Require local access to the saved repository and an exact committed source OID containing every
   anchor. Never publish anchors into uncommitted code.

## Read before replacing

For an existing Structure, run:

```bash
rvw structure get '<STRUCTURE_URI>' --json
```

Read the complete current subject, source OID, nodes, edges, anchors, and Pull Request repository
location. Keep its exact `updatedAt` for any update or authorized delete. A Structure has one current
value and no local revision history.

When a publish result was not received, recover stable references with:

```bash
rvw structure list '<PULL_REQUEST>' --json
```

## Author the relationship map

When authoring or materially revising a Structure, read
[the Structure authoring contract](references/structure-authoring.md). It defines subject and scope
selection, stable identities, claims, anchors, relation labels, update boundaries, and the internal
completion check.

Prepare one complete JSON value. `sourceOid` is the single coordinate for all node and edge anchors.
Each node may have zero or one `anchor`; each edge may have zero or more `anchors`. For any anchor,
provide both positive inclusive `startLine` and `endLine`, or omit both. Use repository-relative paths.
`originNodeId` is required, its Node must have a source anchor, and every Node must be reachable from it
when relation direction is ignored. The complete Structure contains no more than 400 source anchors.

Every `--stdin` command reads until EOF. Supply the entire object and close stdin in the same
non-interactive invocation; do not start an interactive PTY and send only JSON plus a newline.

## Preview before publishing or updating

Immediately before `publish` or `update`, preview the exact Structure content that will be sent. Omit
only command metadata: `pullRequest` and `idempotencyKey` for publication, or `expectedUpdatedAt` for
an update. Keep `sourceOid`, `title`, `scope`, `originNodeId`, `nodes`, and `edges` identical:

```bash
rvw structure preview --stdin --json
```

Parse the canonical `layout` diagnostics and `warnings`. Treat `maxRows >= 8`,
`nonForwardDirectionalLinkRatio >= 0.25`, or `originOutgoingDirectionalLinkCount === 0` as authoring
smells. Reconsider whether the origin is the factual behavior entrypoint, nodes are too granular,
claims or anchors overlap or nest, multiple behaviors are mixed, the subject boundary is too broad,
or nodes merely reproduce adjacent source lines.

These are not validation failures. If the factual graph does not improve after reconsideration,
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

Let the CLI reject invalid commits, paths, ranges, identities, endpoints, origin, connectivity, size, or ownership;
never silently remove rejected graph elements. Parse the success response and report the returned
`rvw://structure/<uuid>` reference. Generate one key for the logical publication and retain it until
the result is known. After a timeout or connection loss, retry only the identical payload with that
same key; the retry returns the original Structure. Never reuse the key for changed content.
Publication is passive.

Parse any returned `warnings` as response-derived authoring feedback. They do not mean publication
failed and are not persisted graph content.

## Replace the current value

Use an in-place update only when the requested subject identity remains the same. Preserve IDs for
surviving nodes and edges even when their labels or anchors change, never recycle removed IDs for new
claims, and send the complete replacement value. rvw records retired IDs and rejects their
reintroduction even when the current value no longer contains them:

```bash
rvw structure update '<STRUCTURE_URI>' --stdin --json
```

The JSON contains the `expectedUpdatedAt` read from the current Structure plus `sourceOid`, `title`,
`scope`, `originNodeId`, `nodes`, and `edges`; it does not contain `pullRequest`. If a conflict reports
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
