---
name: rvw-walkthrough
description: Read, publish, improve in place, or explicitly delete one source-anchored Markdown explanation with code references and optional Mermaid bindings through the local rvw CLI. Use when the user asks for one implementation, surrounding-code, flow, or architecture walkthrough. Use rvw-review-compose when the user asks which Walkthroughs or Structures a whole review subject needs. Do not use this Skill for rvw comment handling or PR synchronization.
---

# rvw Walkthrough management

Create one reading path that helps a reviewer build a mental model of one bounded committed change or
requested implementation subject and continue into the code. Treat the Walkthrough as orientation,
not as the code's source of truth, an exhaustive change log, a completed AI review, a review-scope
guarantee, or an approval plan.

This producer retains responsibility for representation suitability. When the requested subject has
no useful ordered reading path and is clearer as a navigable map of responsibilities and relations,
stop without publishing and recommend `rvw-structure` to the requester or upstream composer. Do not
create that Structure from this Skill. A request that starts from a file or symbol still belongs there
when it asks which concrete behavior that source participates in rather than for an authored reading
sequence.

This Skill produces, updates, or deletes at most one Walkthrough for the requested subject. When the
user, caller, Pull Request body, or an upstream Skill supplies an Artifact brief, treat its subject,
review question, purpose, scope, inclusions, exclusions, and emphasis as authoring authority over what
this Walkthrough investigates. Treat `mustEstablish` and every suggested implementation fact,
relationship, or invariant as a claim to verify independently in committed source and tests, not as an
assumed fact or a conclusion to force. These are internal authoring inputs, not new Walkthrough schema
fields. Inspect broader Pull Request context only to verify those claims and find exact source evidence;
a valid path or line range alone does not prove the prose attached to it. When source establishes a
different answer inside the same question and scope, use that answer. When an essential claim is
unsupported or contradicted and resolving it would materially change the review question or cross an
exclusion, do not publish it; report the conflict to the requester or upstream composer. Do not broaden
the Walkthrough to cover the whole Pull Request, decide the Pull Request's Artifact count or Walkthrough
/ Structure mix, guarantee other review-subject coverage, or publish companion Artifacts.

When invoked directly without an upstream brief, derive one bounded Walkthrough subject from the
user's explicit request and verified facts. Standalone Walkthrough creation remains supported. Follow
explicit instructions before any default in this Skill. Instructions may set the reading order, focus,
format, detail, scope, exclusions, assumed knowledge, design decisions to explain, or non-code evidence
to include. Apply the default authoring guide only where those instructions are silent. Add only the
minimum context needed to keep the requested Walkthrough understandable; never replace the requested
purpose with a different one.

Prefer verified repository and subject facts. Use the smallest necessary inference when facts do not establish intent, label the uncertainty, and never invent business requirements or off-repository constraints.

Leave the document's organization, emphasis, granularity, step count, and use of diagrams to the current request and subject. Do not impose fixed headings or a narrative template.

Use only the `rvw` CLI protocol. Never access the SQLite database directly or control a viewer through browser automation.

## Preflight

1. Run `rvw protocol --json` and parse stdout as JSON.
2. Require `protocolVersion` 4, `agent.transport`, and the `walkthrough.read` capability plus every publish, update, or delete capability needed for the task.
3. Require `walkthrough.htmlPreview` before publishing or updating any `html-preview` fence. If it is absent, use Markdown or Mermaid instead; never send unsupported HTML preview syntax.
4. Run `rvw agent status --json`. Read `socketPath`, `connectionResult`, `selectedDatabasePath`, `selectedTransport`, and `fallbackReason`. If `selectedTransport` is `unavailable`, stop and report the diagnostic; an explicitly configured `RVW_AGENT_SOCKET_PATH` never falls back to direct database access. Otherwise use the reported transport without overriding it.
5. Require local access to the saved repository. When a normally launched rvw viewer is running, the
   CLI can route database reads and writes through its user-only Unix socket; otherwise direct rvw data
   access is required. `RVW_DATABASE_PATH` selects an explicitly managed database; the CLI uses a
   running viewer only when it reports that same database.

## Read the current artifact

For an existing `rvw://walkthrough/<uuid>` reference, run:

```bash
rvw walkthrough get <WALKTHROUGH_URI> --json
```

Read the complete current body, source OID, diagram bindings, references, and Pull Request repository location before revising or deleting it. Walkthroughs have one current value and no local revision history.

## Prepare the artifact

1. Inspect the explicit instructions and relevant committed repository state. Determine whether the request explains a change or a standalone implementation, flow, or architecture subject. Use available Pull Request context when it contains authoring directions or establishes purpose.
2. When explicit instructions leave authoring choices unresolved, read [the authoring guide](references/walkthrough-authoring.md). Apply its workflow, adaptation rules, anti-patterns, example, and completion check only as defaults for those choices.
3. Choose one exact commit containing every referenced path and range. Treat it as the coordinate where the references are guaranteed to exist and the viewer's fallback if latest-head mapping is uncertain, not as a request to keep normal viewing historical. Do not publish an explanation of uncommitted code.
4. For a change-focused Walkthrough, inspect the diff and enough surrounding code to identify the requested subject's center and connections. Only when no bounded subject was supplied may the change itself establish that center. For a standalone subject, inspect its central responsibility, contract, entry points, and connections without inventing a before/after story. Include unchanged callers, callees, contracts, models, or tests when they materially reduce the reader's exploration cost; do not include them merely because they are related.
5. Compose the smallest useful reading path for the requested subject in the order that best builds the mental model, rather than file order or diff order. Connect each step to concrete code, explain why it comes next, expose meaningful uncertainty, and leave useful starting points for exploration beyond the Walkthrough.
6. Generate the completed Walkthrough in one pass unless the user explicitly requests an interactive process. Do not ask for approval of an intermediate review plan.
7. Link important code claims with `rvw-ref:<referenceId>`; use Markdown links in prose and `<a href="rvw-ref:<referenceId>">` links inside HTML previews.
8. Define every reference with a repository-relative path and, when useful, an inclusive line range at the chosen `sourceOid`. Prefer the smallest meaningful multi-line range that lets the reader verify a code block or flow; include the signature and relevant body instead of pointing only at its first line. Use a single-line range only for a genuinely line-local claim such as one constant or declaration. Omit both `startLine` and `endLine` when the claim concerns the file as a whole. Keep IDs unique and stable within the publication.
9. Add Mermaid only when it helps the explanation. Bind only the source-identified node-like elements listed below that should open code; leave edge-like elements passive.
10. Use `html-preview` only when spatial layout, an ELI5 visual, a UI mock, or a visual comparison materially lowers comprehension cost. Follow the HTML visual rules in the authoring guide; do not generate JavaScript or network resources.
11. Ensure every supplied reference is used by at least one Markdown or HTML `rvw-ref:` link or a Mermaid binding whose key is an actual supported node-like element in the body: a flowchart node, classDiagram class, sequenceDiagram participant/actor, stateDiagram-v2 state, erDiagram entity, or architecture-beta service. Use the explicit source ID rather than its display label. `diagramBindings` is Walkthrough-global: reusing one source ID in multiple Mermaid fences binds every match to the same reference, so use distinct source IDs when the references should differ. Messages, transitions, relationships, architecture edges/groups, and other edge-like elements are not binding targets. Ensure every link and binding names a supplied reference, and never invent a binding key merely to mark a reference as used. For a line reference, supply both `startLine` and `endLine`; for a file reference, omit both. Let the CLI reject invalid commits, paths, ranges, IDs, unused references, or bindings; never silently omit a failed reference.

## Send JSON without interactive input

Every `--stdin` command reads until EOF before parsing JSON. Supply the complete object and close stdin in the same non-interactive invocation. Prefer an execution API that accepts stdin and closes it after writing; in a shell, use a quoted heredoc as shown below. Never start the command in an interactive PTY and send only JSON plus a newline: a newline is not EOF, so the command will keep waiting.

## Publish

Pass exactly one JSON object and close stdin. This shell form closes it at the heredoc delimiter:

```bash
rvw walkthrough publish --stdin --json <<'RVW_JSON'
{
  "pullRequest": "https://github.com/owner/repo/pull/123",
  "sourceOid": "0123456789abcdef0123456789abcdef01234567",
  "title": "Request flow",
  "body": "Start at [the handler](rvw-ref:handler), then inspect the [composition root](rvw-ref:composition).",
  "diagramBindings": { "Handler": "handler" },
  "references": [
    {
      "id": "handler",
      "label": "RequestHandler.execute",
      "path": "src/request-handler.ts",
      "startLine": 10,
      "endLine": 24,
      "description": "Application orchestration boundary"
    },
    {
      "id": "composition",
      "label": "Application composition root",
      "path": "src/application.ts",
      "description": "File-wide dependency wiring"
    }
  ]
}
RVW_JSON
```

Set the optional `authorLabel` to an accurate current Agent name when known; otherwise omit it.

Parse the successful response and report the returned `rvw://walkthrough/<uuid>` reference. Publication is passive: never claim it opened rvw, activated a document, selected a commit, or changed a tab or scroll position. The human chooses which Walkthrough and code references to open and when.

## Improve an existing Walkthrough

Use an in-place update when the user or a Walkthrough comment asks for a clearer or more accurate explanation. Read the current artifact first, incorporate the feedback, and send a complete replacement object containing `sourceOid`, `title`, `body`, `diagramBindings`, and every reference. Omit `authorLabel` to preserve it, or set it accurately to a string or `null`. Supply the object and close stdin in the same non-interactive invocation, using the same execution-API or quoted-heredoc pattern as publication. Run:

```bash
rvw walkthrough update '<WALKTHROUGH_URI>' --stdin --json
```

The successful response keeps the same Walkthrough ID and URI. rvw does not create or retain a previous Walkthrough version. Whole-document comments stay attached to the same identity and resolve to the current body and references. Updating is passive and must not be described as browser navigation.

## Delete an unnecessary Walkthrough

Deletion permanently removes the Walkthrough, its references, and every comment and reply attached to it. First run the command without `--yes` and inspect the returned counts:

```bash
rvw walkthrough delete <WALKTHROUGH_URI> --json
```

Only after the user explicitly authorizes deleting that exact Walkthrough and the reported associated feedback, run:

```bash
rvw walkthrough delete <WALKTHROUGH_URI> --yes --json
```

Never infer deletion authorization from a request to revise, replace, or republish an explanation. Retained Git commit refs may be shared by other review state and remain managed by `rvw pr reset`.
