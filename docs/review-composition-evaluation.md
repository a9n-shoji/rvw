# Review composition decision evaluation

This record captures planning-only forward evaluations of `rvw-review-compose`. They test whether the
composer chooses bounded review surfaces adaptively from real committed repository history. They do
not treat Artifact count as a score and do not turn the cases into a production template. Historical
results remain below as calibration evidence; only a run whose recorded Skill blobs match the current
content is evidence for the current contract.

The decision evaluation is intentionally separate from host acceptance. A planning run may execute
read-only protocol and transport preflight, but it stops before producer activation, preview, or
publication. It therefore does not prove that Codex or Claude Code can invoke a sibling producer, that
a producer-ready payload is valid, or that an Artifact URI can be issued. No fake URI or persistent
review object was created.

## Current file-map composition evaluation (2026-09-08)

The implementation baseline was `2a2d9dcd4da7b227db4ebc71f297a1e45ba86787`. Fresh evaluators
re-read the final working-tree instruction content after the core-Walkthrough default was added. Its
Git-compatible content blobs were:

- `skills/rvw-review-compose/SKILL.md` Git blob
  `ab06c5f6dcef049a76104380c37b9cc32440c3dc`
- `skills/rvw-review-compose/references/review-composition.md` Git blob
  `82f8e07078aa58654e83409fa525246321fdfb52`

A fresh planning context received the whole committed change
`c45bc91f4a0cfd071c3be3622eb6418059e236ff..a2f016c5e90886cce769aa0990c6a05c7ce02ae9`
(`Fix runtime startup handoff races (#50)`). It read the current composer contract, inspected the diff,
unchanged runtime/socket/heartbeat dependencies, tests, and normative documents, and was not told an
expected Artifact count or type mix. It was prohibited from invoking a producer or reading, creating,
updating, or deleting an Artifact. Protocol v5 and direct-database transport were available, but the
evaluation deliberately stopped after read-only preflight; persisted duplicate/file-map discovery was
not performed.

The runtime composition had first been planned against the implementation-baseline blobs. After the
core-Walkthrough presumption was added, the evaluator re-read the blobs above and reran the surface
decision. The result was unchanged because this meaningful race/lifecycle change already selected one
core Walkthrough.

### Observed composition

The composer recommended one required file-map Structure, one Walkthrough, and direct code reading. It
did not recommend a normal behavior Structure. This was not a fixed two-surface answer: a candidate
ownership Structure was dropped because its useful lock and reservation relations were inseparable
from the correctness order already owned by the Walkthrough and would add another working-memory join.

The file-map brief included `src/cli/main.ts`, changed runtime/lifecycle adapters, the unchanged
`src/server/agent-socket.ts` ownership implementation, the unchanged `src/server/app.ts` heartbeat
consumer, and the two behavior tests. It supplied one file-level Node candidate per path and precise
candidate relations for independent producer verification. Documentation, changelog, browser heartbeat
senders, unrelated CLI/socket branches, and low-level timer or stale-lock detail were explicit
exclusions or direct-code boundaries. The evaluator found one coherent change area and did not split it
or connect documentation with a fictional “same PR” Edge.

The Walkthrough brief began with an open arriving after the current owner stops accepting but before it
releases ownership. It separately asked how a reused runtime keeps a slow PR lookup alive without
starting the browser deadline too early. `sequenceDiagram` and `stateDiagram-v2` were named only as
promising candidates for those two questions; every participant, order, state, transition, and guard
remained a producer claim to verify. The brief explicitly distinguished the `PendingViewer` variants
from the active-viewer map and left unbindable arrows to nearby source evidence.

Verdict: **Pass for the current recommendation contract.** The mandatory physical locating surface is
present, the behavior surface remains adaptive, unchanged source is investigated, and direct code
retains local mechanics. The result states that both Artifact briefs are unproduced, persisted map
status is unknown, and no URI exists. Committed code remains the source of truth, and producer order is
not presented as human reading order.

### Independent-area planning case

A second fresh context inspected merged PR #24 over
`f471b77112fcfc4ba540f8649c7a9717c0bd658a..0f43f131b70d227dbd76bec7d07218e3395ad442`
without an expected Artifact count. It found two independently implemented product changes: batch-local
watch acknowledgements and browser reply-draft preservation. Their shared Pull Request and normal
comment domain do not create a direct implementation dependency, so the composer prepared two separate
file-map briefs instead of one connected graph.

A read-only Structure-authoring audit then produced one separate content candidate for each brief:

- [watch acknowledgement file map](examples/structures/pr24-watch-batch-file-map.json), with five files
  covering durable batch operations, the unchanged auto-ack consumer, its Skill contract, and focused
  unit verification; and
- [reply-draft file map](examples/structures/pr24-reply-draft-file-map.json), with six files covering the
  client state owner, its React consumers/reset boundary, and focused unit/browser verification.

This was content-only evaluation in one audit context, not two native producer invocations. It preserves
one output per brief and checks the split, but it does not establish installed-host sequential handoff.

The two maps share the same post-change `sourceOid` but no file, Node, or Edge. Each includes changed and
unchanged source, uses only direct evidenced relations inside its own boundary, and explicitly leaves
the compact CI-history setup and broad documentation to direct code instead of connecting them through
an invented “same PR” relation. Both passed the current Structure content schema, exact-source checks,
and CLI preview; each retained the truthful zero-outgoing-origin diagnostic because its state-owner file
is a valid source-verification start, not a fabricated common runtime entrypoint.

For the remaining surfaces, the composer selected two core Walkthroughs: one for the
retry-versus-later-batch acknowledgement sequence, and one for the external reply → change-sequence
refetch → Markdown remount → external snapshot/focus restoration path. It rejected an initially
plausible normal Structure: the file map already locates the App → DocumentViewer → CommentThread →
draft-store ownership wiring, while the remaining comprehension cost is the concrete causal redraw
path. A finer ownership Structure would repeat the map without replacing that path. CI demo-history
setup, one review-scope readiness assertion, and low-level retry/migration predicates remain direct-code
checks. No producer or evaluation published an Artifact.

### Scenario coverage

The following matrix distinguishes generated examples from static contract or existing runtime
evidence. It is not an Artifact-count golden test.

| Requested case                             | Evidence in this revision                                                                                                                                                                                                                                                                      | Level/result                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1. Single-file small change                | A fresh Structure-producer run and [tracked file-map example](examples/structures/single-file-map.json) independently chose one file-level Node, zero Edges, and `presentation: null` for `eb28386c`; the local typography Walkthrough chose no diagram.                                       | Generated, schema/source/preview checked; pass.                                               |
| 2. Multi-file behavior change              | The current runtime composition separates physical location, temporal behavior, and direct code. The [same-change trio](examples/review-composition/review-composition-trio.md) separately demonstrates file map, Walkthrough, and normal Structure where each question has independent value. | Planning plus exact-source fixtures; pass.                                                    |
| 3. Async/race                              | The [runtime handoff Walkthrough](examples/walkthroughs/runtime-handoff-lifecycle.json) keeps owner drain/retry uncertainty rather than drawing an always-successful serial trace.                                                                                                             | Fresh generation and qualitative/source review; pass.                                         |
| 4. Lifecycle/state                         | The [review-bootstrap example](examples/walkthroughs/review-bootstrap-lifecycle.json) labels aggregate UI state as explanatory and partial; the runtime example distinguishes explicit pending variants from active lease ownership.                                                           | Fresh generation and browser render; pass.                                                    |
| 5. Conditional branch                      | The [Hide Whitespace example](examples/walkthroughs/hide-whitespace-decision.json) uses a flowchart for the one-sided guard and compare/restore data path.                                                                                                                                     | Fresh generation, Chromium Mermaid render, and focused unit tests; pass.                      |
| 6. Multiple diagram families               | Runtime handoff uses sequence for cross-process interaction and state for reservation expiry, without redrawing one question twice.                                                                                                                                                            | Fresh generation and browser render; pass.                                                    |
| 7. Important dependency outside the diff   | The file-map fixture includes unchanged `src/cli/main.ts`; the fresh runtime brief includes unchanged socket ownership and heartbeat-consumer files.                                                                                                                                           | Exact-source fixture plus planning result; pass.                                              |
| 8. Independent change areas                | PR #24 produced separate [watch](examples/structures/pr24-watch-batch-file-map.json) and [reply-draft](examples/structures/pr24-reply-draft-file-map.json) maps from one exact source coordinate, with changed and unchanged context in each and no cross-area file or relation.               | Fresh composer planning plus separate content authoring, schema/source/preview checked; pass. |
| 9. Config/document/migration-centered      | The singleton documentation map uses the document as the verification origin and adds no runtime entrypoint. The same rule applies to configuration and migrations when they own the scoped change.                                                                                            | Fresh document generation and preview; pass for document shape.                               |
| 10. Rename/delete                          | Contract tests require the selected `sourceOid` path, post-rename name, and no deleted-HEAD anchor; existing integration tests exercise exact Git rename/source resolution.                                                                                                                    | Contract and source-runtime coverage; no new rename/delete producer generation.               |
| 11. Recommendation/update/transport safety | The fresh planning run remained unproduced despite available transport. Static contracts preserve contextual-read-only authority, existing-map reuse/update preference, operation-specific capability checks, and fail-closed unavailable transport.                                           | Planning plus contract tests; no live update or forced transport-failure publication attempt. |

### Reader-model assessment

The runtime result lets a reviewer begin at the real socket handoff test or acquisition loop rather than
memorizing the file map. The file map remains available to place that code among lock ownership,
reservation adaptation, lifecycle state, heartbeat consumption, and test responsibility. The
Walkthrough carries only the interaction and deadline models that are expensive to reconstruct from
source. Low-level cleanup, port, timeout, and browser-header questions retain exact code destinations
and a reason to inspect them. A reviewer can therefore explain the central behavior, identify who owns
each state, vary a stopping/timeout condition, and continue into source without holding all surfaces in
working memory.

This is a qualitative authoring judgment. Schema validity, exact anchors, Mermaid rendering, and test
passes do not independently establish it.

### Current limitations

No current installed-host native producer handoff, existing-Artifact discovery/update, publication,
idempotency recovery, URI readback, or human reading session was authorized. The rename/delete case is
contract/source-runtime coverage rather than a fresh producer generation. The producer examples and
validation records in the Structure and Walkthrough evaluation documents cover lower-level authoring
outputs; they do not convert these planning runs into production acceptance.

## Historical forward evaluation (2026-09-07)

Three withheld-outcome cases were rerun after the authored-spatial-Structure and contextual-read
contract changes. Every case used a separate fresh high-effort Agent context. The evaluators were told
the user-style subject and exact coordinate, read the complete then-current composer Skill and reference,
and were explicitly prohibited from reading this evaluation record. Expected surface type and count
were withheld. The then-current instruction content was:

- `skills/rvw-review-compose/SKILL.md` Git blob
  `7308a332ff3371635609f30f36160c9cb5902da1`
- `skills/rvw-review-compose/references/review-composition.md` Git blob
  `a86141086911abcd5e7e01b19fbb8c48d83627bc`

These are source-only composition evaluations. They did not authorize producer invocation or
Artifact mutation. The complex case successfully preflighted protocol v5 and the direct-database
transport through the repository-built CLI. The deliberately isolated local and relationship cases
did not have `rvw` on `PATH`; they reported that limitation and returned unproduced source-only
recommendations rather than fabricating a URI or treating preflight as successful.

### Historical case A: local presentation change

Input:

- Range: `0b2a179813cf48e91db5ed2eeccd33d14d8e1982..4ca571485719fd1cb55c9389820f40ef6cde695b`
- Subject: the complete change that makes emphasized diff text use the active theme foreground

Observed composition: no Artifact. The evaluator kept one direct-code question: how the host
foreground variable and injected shadow-DOM selector override syntax-token colors for intraline
additions and deletions while following the active light or dark theme.

The exact entrypoints covered the theme-resolving variables and injected selectors in
`src/web/components/DocumentViewer.tsx`, the preference and `themeType` boundary in
`src/web/app/PullRequestReviewScreen.tsx`, `color-scheme` ownership in `src/web/theme.ts` and
`src/web/styles/main.css`, and the two-theme computed-color assertions in
`test/e2e/review-flow.spec.ts`. The evaluator retained the `@pierre/diffs` DOM-selector dependency,
custom-property inheritance into shadow DOM, and system-theme resolution as direct review risks.

Verdict: **Pass.** A Walkthrough would split adjacent implementation evidence into artificial stops;
a Structure would manufacture a relationship space for a local CSS and DOM contract.

### Historical case B: five-Skill distribution authority

Input:

- Coordinate: `01841f836706b19805a4fbd5e338522ea62ee4e5`
- Explicit subject: which declarations own the five-Skill distribution contract and which packaging,
  installation, status, Codex, Claude, custom-root, and test boundaries consume or independently
  restate that authority

Observed composition: one unproduced Structure; no Walkthrough. Its central question was which
declarations own the exact five bundled Skill identities and how the surrounding package, platform,
installation, status, documentation, and test boundaries consume or restate them.

The Structure brief used `skillNames` in `src/infrastructure/skills/skill-installer.ts` only as an
origin candidate. It asked the producer to verify runtime enumeration, the separately restated
`SkillName` type, broad `package.json` subtree inclusion, common content with platform-specific
destination roots, CLI and doctor consumers, custom target roots, and independent test/documentation
lists. Requested presentation described an authority thesis, runtime-enumeration attention start, one
compact exact-relation backbone, and comprehension chunks for executable identity, platform routing,
and independent packaging or contract restatements; it supplied no protocol IDs.

Direct code retained status classification, staged install and rollback, CLI argument parsing,
literal package contents, and exact test assertions. The evaluator also found a source-supported gap
at the historical target coordinate: its specification required packaged `skill status --json`
coverage while its package smoke only inspected install responses. The current tree already contains
the follow-up status invocation and parity assertion; the historical finding was not rewritten into a
pass.

Verdict: **Pass for composition; target implementation gap retained.** One explorable authority map
has lower join cost than an ordered explanation, and the evaluator did not confuse package inclusion,
runtime identity, destination platform, or test restatement.

### Historical case C: stale watcher work and fenced side effects

Input:

- Range: `e28a1d3503d07063249223ae46fc84f3e530b793..65f2e9b259af3c7d9d5241eb19cdae92f5ef1426`
- Subject: the complete change that prevents stale watch tasks from producing current side effects

Observed composition: one unproduced Walkthrough; no Structure. Its central question was how a newer
logical watch prevents the old task's cursor, queued events, and leases from creating new
acknowledgements, delegation, or repository writes while work already delegated or holding the exact
reservation can reach its documented completion and release boundary.

The bounded path followed explicit activation and durable generation binding, repeated authority
verification, fresh thread-state actionability, transactionally fenced acknowledgement writes, the
last pre-dispatch verification, atomic shared writer reservation, and exact-owner release. It kept
physical uniqueness constraints, schema/CLI/socket forwarding, cursor and process-lock mechanics, and
adapter fixtures as direct code. Candidate claims remained independently verifiable and explicitly
included the non-cancellation boundary for already delegated or reserved work.

The evaluator considered and rejected a separate authority Structure. Unlike the 2026-09-05 result
below, it concluded that the relevant ownership relationships are inseparable from the ordering that
closes each race; a second surface would duplicate those facts and make the timing invariant harder to
hold together.

Verdict: **Pass.** The changed answer was retained rather than forced toward the historical
Structure-plus-Walkthrough composition. One temporal explanation plus exact direct-code boundaries
minimizes total comprehension cost for this wording of the subject.

### Historical cross-case result

The three independent cases selected zero Artifacts, one Structure, and one Walkthrough. They cover
the required small-local, relationship-centered, and state/lifecycle/async shapes without a fixed
surface template. Each result named one central question, explicit exclusions, direct-code evidence,
and important coupling. No result treated a suggested origin or `mustEstablish` claim as proof, and no
result invented an Artifact URI.

Verdict: **Pass for that planning contract.** This remains a small qualitative sample, not a
golden surface-count test. Installed-host producer activation is a separate acceptance boundary. The
2026-09-05 installed-host record below used older Skill blobs and is historical evidence only; it is
not current native-activation proof. The current packaged attempt and its approval boundary are
recorded next.

## Historical installed-host acceptance attempt (2026-09-07)

An isolated installed-host attempt used exact pushed commit
`79d4414f222b99125a3e400d122fa0716d433211`. Packaging and setup passed:

- `npm pack` produced a 4,271,581-byte tarball with 495 entries and SHA-1
  `99fbbec5ae258a1c4935e1244d29c2e78f0bc58d`.
- The tarball-installed CLI reported rvw `0.5.0`, and the host Codex CLI was exactly `0.147.0`.
- The packaged CLI installed all five Skills into the detached worktree's `.codex/skills` root. A
  packaged `skill status` read reported every Skill as `current`, managed, matching the bundled
  content, not locally modified, and with no update available or required.
- A caller-managed temporary database was initialized, PR #77 was refreshed and attached to the
  detached `79d4414` worktree, and its recorded head was `79d4414f222b99125a3e400d122fa0716d433211`.
- Packaged `rvw protocol --json` reported protocol v5 with the required Structure capabilities, and
  `rvw agent status --json` selected `direct-database` for the temporary database.
- `rvw structure list 77 --json` reported zero Structures before the attempted host activation.

The production prompt explicitly requested native activation of `rvw-review-compose`, sequential
handoff to `rvw-structure`, preview, and exactly one publication for the bounded relationship question
about factual graph, authorial presentation, derived rendering, reviewer session state, and their
identity or revision boundaries. The outer execution approval gate rejected `codex exec` before Codex
launched because the run would send repository content to OpenAI and authorize Artifact publication.
The rejection was not retried or bypassed.

Consequently, this attempt produced no producer activation, preview, publication, Artifact URI, or
`structure get` readback. A final `structure list` still contained exactly zero Structures, the Codex
final-output directory remained empty, and no rvw or Codex process remained. The temporary evidence is
retained under `/private/tmp/rvw-accept-79d4414.DxgW1X`; its detached worktree has no tracked changes
and only the expected untracked `.codex/` installation and runtime files. The main worktree also had no
tracked write from the attempt. This is evidence that packaged installation, protocol negotiation, PR
attachment, and direct-database setup work; it is **not current native Skill activation, sequential
producer handoff, preview/publish, URI, or readback proof**.

Follow-up commit `78558dda6df85ae1de559076dac4c767412bee52` changes only
`docs/implementation-spec.md` and `test/unit/protocol-version.test.ts`. The recorded composer
Skill blobs remain identical at that commit: `7308a332ff3371635609f30f36160c9cb5902da1` for `SKILL.md`
and `a86141086911abcd5e7e01b19fbb8c48d83627bc` for `review-composition.md`. It therefore does not
invalidate the planning results above or convert this blocked installed-host attempt into activation
evidence.

## Historical baseline instruction revision (2026-09-05)

Every composition case used the same then-current, unmodified instruction content in a fresh Agent
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

Verdict: **Pass.** The then-current composer independently selected a Structure-only composition for a
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

The then-current evaluator also refused to force two broad lifecycle claims. In the target tree, Agent
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

These outcomes support that composition contract but are not a permanent golden answer. A
different composition may pass when it gives stronger source-grounded reasons and satisfies the same
rubric.

## 2026-09-05 installed-host acceptance (historical)

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
