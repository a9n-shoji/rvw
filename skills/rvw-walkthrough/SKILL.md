---
name: rvw-walkthrough
description: Read, publish, improve in place, or explicitly delete a commit-fixed Markdown explanation with exact code references and optional Mermaid bindings through the local rvw CLI. Use when the user asks to create, present, publish, revise, update, or remove an implementation, surrounding-code, flow, or architecture walkthrough in rvw. Do not use this Skill for rvw comment handling or PR synchronization.
---

# rvw Walkthrough management

Turn the explanation appropriate to the current request and repository into a verifiable rvw artifact. Leave the document's organization, emphasis, granularity, and use of diagrams to the current session; do not impose fixed headings or a narrative template.

Use only the `rvw` CLI protocol. Never access the SQLite database directly or control a viewer through browser automation.

## Preflight

1. Run `rvw protocol --json` and parse stdout as JSON.
2. Require `protocolVersion` 2, `agent.transport`, and the `walkthrough.read` capability plus every publish, update, or delete capability needed for the task.
3. Run `rvw agent status --json`. Read `socketPath`, `connectionResult`, `selectedDatabasePath`, `selectedTransport`, and `fallbackReason`. If `selectedTransport` is `unavailable`, stop and report the diagnostic; an explicitly configured `RVW_AGENT_SOCKET_PATH` never falls back to direct database access. Otherwise use the reported transport without overriding it.
4. Require local access to the saved repository. When a normally launched rvw viewer is running, the
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

1. Inspect the user's requested scope and the relevant committed repository state.
2. Choose one exact commit containing every referenced path. Do not publish an explanation of uncommitted code.
3. Compose the explanation in the structure best suited to the current task. Make material boundaries and uncertainty explicit.
4. Link important code claims with Markdown URLs of the form `rvw-ref:<referenceId>`.
5. Define every reference with a repository-relative path and, when useful, an inclusive line range at the chosen `sourceOid`. Prefer the smallest meaningful multi-line range that lets the reader verify a code block or flow; include the signature and relevant body instead of pointing only at its first line. Use a single-line range only for a genuinely line-local claim such as one constant or declaration. Omit both `startLine` and `endLine` when the claim concerns the file as a whole. Keep IDs unique and stable within the publication.
6. Add Mermaid only when it helps the explanation. Bind only elements that should open code. rvw renders Mermaid-supported diagram types, while interactive binding is currently guaranteed for flowchart nodes and class-diagram classes.
7. Ensure every supplied reference is used by at least one Markdown `rvw-ref:` link or a Mermaid binding whose key is an actual flowchart node or classDiagram class in the body, and ensure every link and binding names a supplied reference. Never invent a binding key merely to mark a reference as used. For a line reference, supply both `startLine` and `endLine`; for a file reference, omit both. Let the CLI reject invalid commits, paths, ranges, IDs, unused references, or bindings; never silently omit a failed reference.

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
