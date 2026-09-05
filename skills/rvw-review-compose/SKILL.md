---
name: rvw-review-compose
description: Analyze one Pull Request or explicit review subject and choose the minimum useful mix of source-anchored rvw Walkthroughs, Structures, and direct code reading, creating Artifacts only when they lower comprehension cost. Use when the user asks rvw to recommend or produce an overall review composition. Use the producer Skills directly for one explicitly bounded Walkthrough or Structure.
---

# rvw review composition

Compose the smallest useful set of rvw reading surfaces for one Pull Request or explicitly requested
review subject. Reduce how many concepts a reviewer must internalize at once without hiding important
coupling. The goal is not to create a complete explanation set or to make the reviewer feel finished;
it is to let the reviewer build small mental models and enter the committed code at the right points.

This Skill owns PR-wide composition. `rvw-walkthrough` owns one ordered explanation path, and
`rvw-structure` owns one bounded relationship space. Use either producer directly when the user has
already asked for one bounded Artifact. Do not take over comment review or PR synchronization work.

Composition is session-local authoring strategy, not a product entity. Do not create a Review Set,
Review Plan, Slice, group ID, typed Artifact link, Artifact kind, URI, database row, migration, CLI
capability, HTTP API, or Viewer grouping. Never access SQLite directly or control a Viewer through
browser automation.

For every composition task, read
[the review composition contract](references/review-composition.md) before deciding the surfaces.

## Preflight

1. Run `rvw protocol --json` and parse stdout as JSON. Require `protocolVersion` 4 and
   `agent.transport`, and record the available Walkthrough and Structure capabilities. After selecting
   the composition and before invoking a producer, require only the capabilities that its chosen
   operation actually uses; the producer Skills perform their complete operation-specific checks.
2. Run `rvw agent status --json`. If `selectedTransport` is `unavailable`, stop before Artifact reads
   or writes and report the diagnostic. Otherwise use the reported transport without overriding it.
3. Require local access to the saved repository and investigate committed code. Do not compose or
   publish Artifacts from uncommitted source.

## Compose before producing

Investigate the Pull Request or requested subject, its diff, relevant surrounding code, contracts, and
tests before choosing Artifact boundaries. Identify the main comprehension difficulties and the
coupling between them. Candidate bounded understanding units are internal reasoning only; do not
persist or present them as a new rvw object.

For each candidate unit, choose exactly the surface that lowers its comprehension cost:

- Use a Walkthrough when ordered execution, causality, lifecycle, or a comprehension sequence is the
  essential shape.
- Use a Structure when responsibility, ownership, dependency, contract, or side-effect relationships
  around one factual code entrypoint are the essential shape.
- Direct the reviewer to code without creating an Artifact when the question is local, conditional,
  implementation-specific, or already clearer in source.
- Create no new surface when an Artifact would merely restate another Artifact or add a join the
  reviewer must keep in working memory.

Never require a Walkthrough and Structure as a pair. Never require an overview Artifact, one Artifact
per candidate unit, or fixed Overview / State / Flow / Error / Test / Structure sections. A simple
subject may need one Walkthrough, one Structure, or no Artifact. Artifact count is not a quality
measure.

Before invoking a producer, prepare an internal Artifact brief with a single subject and review
question, explicit scope and exclusions, and the candidate claims that the Artifact must verify. Keep
the brief's authoring bounds separate from its claims-to-verify; the composer's analysis does not turn
an implementation claim into a fact. The brief is authoring context, not public JSON or rvw schema.
Follow the detailed brief contract in the reference.

For each selected Artifact, activate the installed sibling by its canonical name through the current
host's native Skill mechanism, then follow that producer's complete Skill and authoring reference:

- `rvw-walkthrough` for one Walkthrough brief.
- `rvw-structure` for one Structure brief.

In Codex, activate the named entry from the available Skill inventory. In Claude Code, invoke the named
Skill with the Skill tool. In both hosts, load the full producer instructions before any Artifact
operation.

Do not treat `$name`, `/name`, or another host's user-facing syntax as a cross-host invocation
protocol. If the selected producer is unavailable or disabled in the current session, stop before any
Artifact operation and report that installation or host-configuration problem; do not imitate the
producer contract from this Skill.

Pass the subject, review question, purpose or behavior boundary, scope, inclusions, exclusions, and
emphasis as authoring authority: they control what the producer investigates, not what the code must
say. Pass `mustEstablish`, a suggested origin, relationship, invariant, and every other implementation
assertion as claims to verify independently in committed source and tests. Do not reimplement the
producer's source, format, preview, identity, concurrency, publish, update, or delete contracts here,
and do not invent a generic sub-Skill invocation framework. If a producer rejects the requested
representation or reports that an essential claim is unsupported or contradicted, return that result
to composition and revise the brief, choose a better surface, or direct the reviewer to code; never
make the producer broaden the subject or force the claim to compensate.

## Existing Artifacts

When the user or caller supplies an existing Artifact URI, have the matching producer read its current
value before deciding whether the same subject should be updated. Do not publish a duplicate
"revision" by default. `structure list` may be used within its existing contract to recover an
uncertain publication or inspect candidate Structure summaries. There is no general Walkthrough
discovery contract: when an existing Walkthrough URI was not supplied, do not claim exhaustive
duplicate detection, read SQLite, or add a discovery protocol.

## Finish as a composition

Before finalizing, check the whole composition for detailed overlap, terminology drift, missing
important boundaries, over-fragmentation, and cross-boundary risk. Drop or rescope an unpublished
candidate when it does not lower total comprehension cost. Never delete any published Artifact,
including one created during this composition, without the matching producer's normal deletion preview
and the user's explicit authorization.

Report in the normal Agent response:

- why this composition is the minimum useful one;
- a recommended first entry, without claiming a mandatory or complete review plan;
- every created or updated `rvw://walkthrough/<uuid>` and `rvw://structure/<uuid>` URI; and
- important topics intentionally left for direct code reading, with a brief reason.

The response is not a persistent Artifact. State that the committed code remains the source of truth
and leave the reviewer free to enter through a Structure, a Walkthrough, or code in another order.
