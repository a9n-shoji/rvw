# Review composition decision evaluation

This record captures a planning-only forward evaluation of `rvw-review-compose`. It tests whether the
composer chooses bounded review surfaces adaptively from real committed repository history. It does
not treat Artifact count as a score and does not turn the cases into a production template.

The decision evaluation is intentionally separate from host acceptance. These runs stopped before
producer activation, CLI preflight, preview, or publication. They therefore do not prove that Codex or
Claude Code can invoke a sibling producer, that a producer-ready payload is valid, or that an Artifact
URI can be issued. No fake URI or persistent review object was created.

## Evaluated instruction revision

Every composition case used the same current, unmodified instruction content in a fresh Agent
context:

- `skills/rvw-review-compose/SKILL.md` Git blob
  `bbeb447491ab6b171de95ed926a110d50f7a4b5c`
- `skills/rvw-review-compose/references/review-composition.md` Git blob
  `cf022b7a03c1ff4917083eb11d466d88e73f1ed2`

The cases were evaluated on 2026-09-05. Each evaluator received the user-style subject, exact commit
or base/head range, the composer instructions, and a read-only planning override. The expected
surface type and count were withheld. Evaluators inspected the committed diff plus surrounding code
and tests, then returned the selected surfaces, ephemeral briefs, deliberate code-only entrypoints,
and whole-composition checks. The briefs below are evaluation transcripts, not schema examples or
new rvw entities.

## Evaluation rubric

A case passes when its composition:

- uses no more external representation than materially reduces comprehension cost;
- selects each surface by the shape of one central review question;
- gives each Artifact a bounded scope and explicit exclusions;
- leaves local conditions and thin adapters as exact direct-code entrypoints when that is clearer;
- avoids detailed Walkthrough / Structure overlap and keeps terminology consistent;
- preserves important cross-boundary coupling instead of producing tidy but false separation;
- treats `mustEstablish`, suggested origins, relationships, and invariants as claims for independent
  producer verification rather than pre-established conclusions; and
- avoids a fixed review template, automatic Walkthrough / Structure pairs, and fake publication.

A forced pair, duplicated mental model, hidden critical coupling, assumed implementation claim, or
fabricated URI is a failure regardless of Artifact count.

## Case 1: local presentation change

Input:

- Range: `0b2a179813cf48e91db5ed2eeccd33d14d8e1982..4ca571485719fd1cb55c9389820f40ef6cde695b`
- Subject: the complete change that makes emphasized diff text use the active theme foreground

Observed composition: no Artifact. The evaluator kept one review question: whether addition and
deletion intraline emphasis uses the active theme's standard foreground while preserving surrounding
syntax color.

Direct-code entrypoints included:

- `src/web/components/DocumentViewer.tsx:143-190` for the theme-resolving variable and local
  `[data-diff-span]` override;
- `src/web/components/DocumentViewer.tsx:2324-2347` for the `FileDiff` style wiring;
- `src/web/theme.ts:28-30` and `src/web/styles/main.css:1-2,57-62` for the `color-scheme` authority;
- `test/e2e/review-flow.spec.ts:385-450` for computed-color assertions in both themes and diff
  directions; and
- `package.json:60` for the pinned dependency whose shadow-DOM attributes are targeted.

Whole-composition assessment: implementation, dependency seam, and focused browser test answer one
local question directly. A Walkthrough would separate adjacent evidence into extra stops, while a
Structure would manufacture a relationship space with no useful exploration boundary. No relevant
state authority, lifecycle, persistence, or async behavior was omitted.

Verdict: **Pass.** Choosing zero Artifacts is the strongest economy signal in this set.

## Case 2: bundled Skill distribution boundary

Input:

- Coordinate: `e1702ec717f2c9eae88ab9debd63a7a8e7e70864`
- Explicit subject: bundled Skill distribution from the CLI entrypoint through package-root discovery,
  managed install and digest status, and package contents

Observed composition: one Walkthrough, “How the installed rvw CLI finds and manages its bundled
Skills”; no Structure. Its central question was how an installed `skill install` or `skill status`
invocation reaches package-relative assets, distinguishes bundle updates from local modifications,
and installs the packaged content.

The target commit's own diff concerns Mermaid review UI rather than Skill distribution. Because the
user supplied a standalone explicit subject at that coordinate, the evaluator described the behavior
present in that committed tree and did not invent a claim that the commit introduced it.

Ephemeral brief summary:

- Authoring scope follows the `package.json` bin/files boundary, build-produced CLI, command dispatch,
  module-relative source discovery, destination-root selection, the bundled/installed/recorded digest
  distinction, force protection, staged replacement, and package-smoke evidence in causal order.
- It excludes individual Skill workflows, Viewer/database behavior, release publication, literal
  tarball inventory, the unrelated Mermaid change, and local status branches that remain clearer in
  code.
- `package.json:27-38` and `src/cli/main.ts:1396-1399` are candidate starting anchors, not assumed
  facts; the producer must verify them.
- Candidate claims to verify include that discovery is relative to the executing package rather than
  cwd, platform adapters change destination rather than source content, status compares three digest
  authorities, an unforced install rejects conflicts before writes, replacement has staged rollback,
  and packed global install works from an unrelated cwd.

Direct-code reading retained the status truth table and digest encoding in
`src/infrastructure/skills/skill-installer.ts`, the exact packaging mechanics in `package.json` and
`scripts/build.mjs`, and the literal package/install assertions in `scripts/package-smoke.mjs` and
`test/unit/skill-installer.test.ts`.

Whole-composition assessment: the explicit subject starts at an installed CLI invocation and depends
on the order from package boundary through discovery, classification, replacement, and packed
verification. A Structure would repeat those same relations without lowering comprehension cost,
while static inventory, branch-heavy status logic, and rollback detail remain faster to inspect
directly. The evaluator explicitly distinguished package root, destination Skill root, bundled digest,
installed digest, and recorded digest.

Verdict: **Pass.** One ordered surface is sufficient and is not paired mechanically with a Structure.
This result differs from the earlier-revision evaluation and is retained rather than relabeled to
preserve the previous expected surface.

## Supplemental case: bundled Skill authority graph

A separate fresh run inspected committed HEAD
`01841f836706b19805a4fbd5e338522ea62ee4e5` for the relationship-only question: which declarations
own the five-Skill distribution contract and which packaging, installation, status, Codex, Claude,
custom-root, and test boundaries consume or independently restate that authority.

Observed composition: one Structure, “Bundled Skill authority and distribution boundary”; no
Walkthrough. The Structure distinguishes the normative specification, executable runtime inventory,
canonical package-relative content tree, platform-specific destination roots, three-digest status
model, packaging gate, and independent test oracles. Installation has ordered implementation details,
but ordering is not necessary to answer this authority question and would duplicate the relationship
surface.

Its ephemeral brief includes the current specification, `SkillName` / `skillNames`, package-relative
source resolution, default and custom target selection, recursive content digest and install marker,
status and doctor exposure, installer and Skill-contract tests, protocol-version paths, npm package
inclusion, and package smoke. It excludes individual Skill workflows, Viewer or database behavior,
host runtime invocation mechanics, release publication, and staging details that do not change the
authority graph. `src/infrastructure/skills/skill-installer.ts:24-30` is only an origin candidate.

Direct-code reading retains the exact digest and status truth tables, target parsing, force and swap
branches, narrow test assertions, and package-smoke commands. This inspection also found that the
specification required packaged `skill status --json` checks for both custom roots while package smoke
only examined statuses returned by `skill install`. The follow-up change now invokes both packaged
status commands and validates their full status fields against the install results.

Whole-composition assessment: splitting inventory, roots, digest ownership, and verification into
separate Artifacts would hide their common authority boundary. One Structure exposes the important
joins without turning branch details into nodes. It also keeps `current` distinct from `managed` and
does not treat repeated test lists as canonical runtime authority.

Verdict: **Pass.** The current composer independently selected a Structure-only composition for a
relationship-shaped question, complementing the ordered single-surface result in Case 2 without
turning either outcome into a template.

## Case 3: stale watcher work and fenced side effects

Input:

- Range: `e28a1d3503d07063249223ae46fc84f3e530b793..65f2e9b259af3c7d9d5241eb19cdae92f5ef1426`
- Subject: the complete change that prevents stale watch tasks from producing current side effects

Observed composition: one Structure plus one Walkthrough, with thin adapters and test matrices left
for direct code reading.

The Structure, “Shared watcher authority and fenced side effects,” asks where watcher authority lives
and which boundaries consume `(taskId, generation)` to prevent stale work while permitting exact
old-lease cleanup. Its authoring scope includes generation activation and verification, the task-local
binding, repository-writer reservation, fenced acknowledgment writes, and cleanup. It excludes the
ordered historical-event classification path. `RvwDatabase.activateCommentWatchTask` is an
`originCandidate`, and every authority, reservation, supersession, and release invariant remains a
candidate for producer verification.

The Walkthrough, “Historical event to actionable dispatch,” asks how a replayed event becomes either a
durable non-actionable skip or the only unresolved work exposed for dispatch. Its ordered scope follows
ingest, claim, fresh thread read, skip or acknowledgment, batch completion, and final pre-dispatch
verification. It treats `(taskId, generation)` as an opaque fence and excludes generation allocation,
writer ownership, post-dispatch worker behavior, and unchanged retry/cursor mechanics.

Direct-code entrypoints cover schema and CLI adapters in `src/application/agent-command-schemas.ts`
and `src/cli/main.ts`, socket/service pass-throughs, local capability/error additions, and focused unit
and latency tests. Those locations validate wiring but would not benefit from a third Artifact.

Whole-composition assessment: the Structure owns authority and responsibility relationships; the
Walkthrough owns ordered actionability and race handling. Their only deliberate orientation overlap is
the fenced acknowledgment mutation where the two concerns join. Terminology distinguishes event,
operation, lease, generation, reservation, and task-private state. The composition retains the
activation-to-local-bind crash window, verify-to-claim race, thread-read-to-write race, shared-to-local
reservation boundary, superseded-generation release, and cursor/authority independence without adding
overview, migration, transport, test, or cleanup Artifacts.

Verdict: **Pass.** Two different surfaces are justified by different central questions, and the
composition does not multiply them per internal unit.

## Calibration case: inseparable ownership and ordering

An additional fresh run inspected
`b3cea30f627c9a8aa57678b9f69e62ffc4c81966..eb1515a353ae804057748c7ad5d20952b8cd9d0f`
for the explicit subject “same-database runtime authority and existing-runtime delegation boundary.”
It selected one Walkthrough rather than the initially suspected Structure because correctness depends
on the causal winner/loser sequence: acquire socket ownership before Runtime/SQLite/HTTP construction,
wait through deferred handler readiness, delegate `viewer.open`, and exit without later takeover.

This was retained as a calibration result rather than relabeled as a relationship-only pass. Splitting
election from delegation or forcing a Structure would hide the timing invariant and make the reviewer
hold two surfaces together. The result demonstrates that the scenario labels used to choose evaluation
subjects do not override the composer's representation judgment.

The current evaluator also refused to force two broad lifecycle claims. In the target tree, Agent
socket ownership is released before HTTP and SQLite finish closing, and `viewer.open` returns a URL
without reserving a Viewer lifecycle lease before the new tab's first heartbeat. Those source-supported
limits remain direct-code review points rather than being rewritten into the candidate Walkthrough as
stronger authority guarantees. The composition passes even though those candidate implementation
claims do not.

## Adversarial brief: contradicted upstream claim

A fresh Structure-producer run received an authoritative subject and scope for cross-platform bundled
Skill distribution at `b31dfe399f71464b2ff338acaca58fc92118bedb`, plus this candidate
`mustEstablish` claim: “The installer intentionally renders different `SKILL.md` content for Codex and
Claude.” It also received `SkillInstaller.install` as a suggested origin.

The run used the current producer content:

- `skills/rvw-structure/SKILL.md` Git blob
  `51a107a8e451c3a3f23762e1f24bef62bf87a61d`
- `skills/rvw-structure/references/structure-authoring.md` Git blob
  `97c6608da874994b8cf5d15bc4a177918dec4d01`

The producer preserved the review question and scope, independently verified the origin, and rejected
the factual candidate. The shared Skill inventory and package-root source feed both platforms;
platform selection changes only the destination root, and installer/package tests compare identical
names and content. Because the source-supported answer still fits the same central question and scope,
the producer could continue with the opposite claim rather than broadening or aborting the subject. It
treated `SkillInstaller.install` as an entrypoint rather than semantic proof and did not preview or
publish the contradicted assertion.

Verdict: **Pass.** Brief authority bounded the investigation but did not become evidence for the
answer, and an exact plausible origin did not create a confirmation loop.

## Cross-case findings

- The three primary cases produced zero, one, and two Artifacts without any fixed slot or mandatory
  pair.
- The supplemental authority case produced Structure only, while Case 2 selected Walkthrough only for
  a differently shaped question over related implementation.
- Direct code reading remained a first-class decision in every case, not a residual catch-all.
- Each proposed Artifact had one central question and named exclusions; the complex case kept its
  critical cross-surface join explicit.
- Every brief labeled `mustEstablish` and origin suggestions as candidates for producer verification.
  No evaluation claim relied on source-coordinate validity alone.
- The adversarial producer run corrected a contradicted claim while preserving its authoritative
  subject boundary.
- The calibration case rejected a cleaner-looking relationship decomposition when ordering was the
  behavior's actual invariant.

These outcomes support the current composition contract but are not a permanent golden answer. A
different composition may pass when it gives stronger source-grounded reasons and satisfies the same
rubric.

## Installed-host acceptance

An isolated acceptance run on 2026-09-05 packed commit
`01841f836706b19805a4fbd5e338522ea62ee4e5` and installed that tarball into a temporary global prefix.
The tarball contained 494 files and had npm shasum
`1feb0a932fb29b471ed1567ccbd224593069f75b`. The packaged CLI then installed the same five managed
Skills into project-local Codex and Claude Code targets. Both installer results classified every copy
as `current`, `matchesBundled`, and managed, with no local modification or available update. A
separate temporary rvw database held PR #76 and all Artifact writes; tracked repository source was not
modified.

### Codex

A fresh ephemeral Codex CLI 0.147.0 session explicitly activated `rvw-review-compose`. It loaded the
installed composer and composition reference, inspected the committed PR, and chose one Walkthrough
for the bounded claim-verification handoff because the subject depends on the order from brief through
independent producer verification to correction or recomposition. It rejected a companion Structure
as duplicate representation.

Before publication, the session loaded the complete installed `rvw-walkthrough` Skill and authoring
reference. Producer verification refined the candidate claim: an unsupported or contradicted answer
can be corrected inside the same question and scope; only an essential conflict that would change the
question or cross an exclusion returns to composition. The producer published
`rvw://walkthrough/81042ad0-7734-46a1-9203-10793649fd8e` against the exact acceptance commit. A
packaged-CLI `walkthrough get` read it back with the expected source OID, five references, five Mermaid
bindings, and the refined boundary. `structure list` remained empty. The URI belongs to the temporary
acceptance database and is evidence from this run, not a durable fixture or golden output.

Verdict: **Pass** for installed composer discovery, native producer activation, minimum-surface
selection, producer-side claim verification, publication, and post-publication readback on Codex.

### Claude Code

A fresh Claude Code 2.1.92 initialization discovered the project-local installed
`rvw-review-compose`, `rvw-walkthrough`, and `rvw-structure` entries in both its Skill inventory and
slash-command inventory. The subsequent model request returned `401 authentication_failed`, including
for a minimal control prompt, even though the CLI reported an existing `claude.ai` login. The run was
stopped without producer invocation or Artifact publication; the isolated database still contained no
Structure.

Verdict: **Blocked by host authentication** after packaged installation and native discovery. This run
does not establish Claude Code Skill-tool activation, producer handoff, publication, or readback, and
must not be reported as a cross-host execution pass. Repeat the bounded Structure case in a freshly
authenticated Claude Code environment before claiming that coverage.

## Remaining limitations

This is a small, non-statistical sample from one repository and one evaluation date. Agent decisions
are non-deterministic, and prose snapshots would make brittle CI assertions, so the observed answers
are not encoded as regex tests. Contract tests cover durable responsibility and safety boundaries;
future material authoring changes should rerun these fresh-context cases and record any failure,
contract adjustment, and complete rerun.

The installed-host run establishes the full chain on Codex and packaged Skill discovery on Claude
Code, but not the full Claude Code execution chain because of the recorded authentication failure.
Cross-host producer activation and publication therefore remain partially verified rather than
complete. A complete claim requires the blocked Claude Code case to reach Skill-tool producer
activation before mutation and post-publication `get` verification.
