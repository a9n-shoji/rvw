---
name: rvw-structure
description: Read, publish, replace in place, or explicitly delete a source-anchored relationship map through the local rvw CLI. Use when the user asks to map the stable structure around a bounded code-centered subject. Use rvw-walkthrough instead when the explanation is primarily an ordered path or flow.
---

# rvw Structure management

Create a review space that lets a human inspect a bounded subject through explicit nodes and
relationships. A Structure is a space; a Walkthrough is a path. Prefer a Structure for code-centered
dependency, ownership, contract, data-model, or subsystem relationships. If the clearest explanation
has a required reading order, beginning, and end, stop and recommend `rvw-walkthrough` instead.

Follow explicit subject, scope, inclusion, exclusion, and emphasis instructions from the user, caller,
Pull Request body, or upstream Skill. Fill only their gaps with verified committed code and tests. Do
not infer product intent, invent architectural semantics, or turn related files into an exhaustive map.

Use only the `rvw` CLI protocol. Never access SQLite directly, control the viewer, open a Structure,
select a node, or claim that publication changed rvw navigation.

## Preflight

1. Run `rvw protocol --json` and parse stdout as JSON.
2. Require `protocolVersion` 4, `agent.transport`, `structure.read`, and every one of
   `structure.publish`, `structure.update`, or `structure.delete` needed for the task.
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
location. A Structure has one current value and no local revision history.

## Author the relationship map

When authoring or materially revising a Structure, read
[the Structure authoring contract](references/structure-authoring.md). It defines subject and scope
selection, stable identities, claims, anchors, relation labels, update boundaries, and the internal
completion check.

Prepare one complete JSON value. `sourceOid` is the single coordinate for all node and edge anchors.
Each node may have zero or one `anchor`; each edge may have zero or more `anchors`. For any anchor,
provide both positive inclusive `startLine` and `endLine`, or omit both. Use repository-relative paths.

Every `--stdin` command reads until EOF. Supply the entire object and close stdin in the same
non-interactive invocation; do not start an interactive PTY and send only JSON plus a newline.

## Publish

```bash
rvw structure publish --stdin --json <<'RVW_JSON'
{
  "pullRequest": "https://github.com/owner/repo/pull/123",
  "sourceOid": "0123456789abcdef0123456789abcdef01234567",
  "title": "Request policy boundary",
  "scope": "The committed request policy and the code contracts it directly depends on; transport setup and UI callers are excluded.",
  "initialFocus": "request-policy",
  "nodes": [
    {
      "id": "request-policy",
      "label": "RequestPolicy",
      "description": "Owns the allow/deny decision.",
      "kind": "service",
      "anchor": { "path": "src/request-policy.ts", "startLine": 8, "endLine": 34 }
    },
    {
      "id": "policy-input",
      "label": "PolicyInput",
      "description": "Committed input contract consumed by RequestPolicy.",
      "kind": "contract",
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

Let the CLI reject invalid commits, paths, ranges, identities, endpoints, focus, size, or ownership;
never silently remove rejected graph elements. Parse the success response and report the returned
`rvw://structure/<uuid>` reference. Publication is passive.

## Replace the current value

Use an in-place update only when the requested subject identity remains the same. Preserve IDs for
surviving nodes and edges even when their labels or anchors change, never recycle removed IDs for new
claims, and send the complete replacement value:

```bash
rvw structure update '<STRUCTURE_URI>' --stdin --json
```

The JSON contains `sourceOid`, `title`, `scope`, `initialFocus`, `nodes`, and `edges`; it does not
contain `pullRequest`. If the subject itself changed, publish a new Structure rather than rewriting the
old identity. Updating is passive and retains no previous Structure value.

## Delete only with explicit authorization

First inspect the exact deletion preview:

```bash
rvw structure delete '<STRUCTURE_URI>' --json
```

Only after the user explicitly authorizes deleting that exact Structure after reviewing the reported
node, edge, and source-anchor counts, run:

```bash
rvw structure delete '<STRUCTURE_URI>' --yes --json
```

Never infer deletion permission from a request to revise, replace, or republish. Retained commit refs
may be shared by other review state and remain managed by `rvw pr reset`.
