import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import {
  walkthroughRepositoryPaths,
  walkthroughRepositorySources,
  walkthroughRepositoryText,
  walkthroughs,
} from "./walkthrough-fixture.mjs";

const host = "127.0.0.1";
const port = Number(process.env.RVW_E2E_PORT ?? 43117);
const repositoryDemo =
  process.env.RVW_FIXTURE_MODE === "repository-demo"
    ? (await import("../../scripts/repository-demo-fixture.ts")).createRepositoryDemoFixture(
        path.resolve(import.meta.dirname, "../.."),
      )
    : null;
const pullRequestId = repositoryDemo?.pullRequestId ?? "11111111-1111-4111-8111-111111111111";
const baseOid = repositoryDemo?.baseOid ?? "a".repeat(40);
const firstHead = repositoryDemo?.commits[0]?.oid ?? "b".repeat(40);
const secondHead = repositoryDemo?.headOid ?? "c".repeat(40);
const comments = repositoryDemo ? structuredClone(repositoryDemo.comments) : [];
const activeWalkthroughs = repositoryDemo
  ? structuredClone(repositoryDemo.walkthroughs)
  : walkthroughs;
const activeViewers = new Set();
const releasedViewers = new Set();
let changeSequence = 0;
let syncStage = 0;
let themePreference = "system";
let blockedImageRequestCount = 0;
const selectedLineText = (value, startLine, endLine) =>
  value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");
const findUniqueQuotedLineRange = (quotedText, destinationText) => {
  const selected = quotedText.split("\n");
  const destination = destinationText.split("\n");
  let match = null;
  for (let index = 0; index <= destination.length - selected.length; index += 1) {
    if (!selected.every((line, offset) => destination[index + offset] === line)) continue;
    if (match) return null;
    match = { startLine: index + 1, endLine: index + selected.length };
  }
  return match;
};
const viewerIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const commit = (oid, parentOid, subject, hour) => ({
  oid,
  parentOids: [parentOid],
  subject,
  authorName: "Fixture Author",
  authoredAt: `2026-08-08T0${hour}:00:00.000Z`,
});

function currentPullRequest() {
  if (repositoryDemo) return repositoryDemo.pullRequest;
  const headOid = syncStage > 0 ? secondHead : firstHead;
  return {
    id: pullRequestId,
    host: "github.com",
    owner: "acme",
    repository: "review-repo",
    number: 7,
    url: "https://github.com/acme/review-repo/pull/7",
    localRepositoryPath: "/fixture/review-repo",
    gitCommonDir: "/fixture/review-repo/.git",
    latestTitle: syncStage > 0 ? "Fixture review updated" : "Fixture review",
    latestBody:
      syncStage > 1
        ? "The PR body was rewritten.\nAdditional review details.\n\nFinal note."
        : syncStage > 0
          ? "This is always the latest PR body."
          : "Review the fixture application.",
    latestBaseRefName: "main",
    latestHeadRefName: "feature",
    latestBaseOid: baseOid,
    latestComparisonBaseOid: baseOid,
    latestHeadOid: headOid,
    githubUpdatedAt:
      syncStage > 1
        ? "2026-08-08T03:00:00.000Z"
        : syncStage > 0
          ? "2026-08-08T02:00:00.000Z"
          : "2026-08-08T01:00:00.000Z",
    fetchedAt: "2026-08-08T02:00:00.000Z",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T02:00:00.000Z",
  };
}

function currentView() {
  if (repositoryDemo) {
    return {
      pullRequest: repositoryDemo.pullRequest,
      comparisonBaseOid: repositoryDemo.baseOid,
      headOid: repositoryDemo.headOid,
      commits: repositoryDemo.commits,
    };
  }
  const pullRequest = currentPullRequest();
  return {
    pullRequest,
    comparisonBaseOid: baseOid,
    headOid: pullRequest.latestHeadOid,
    commits:
      syncStage > 0
        ? [
            commit(firstHead, baseOid, "Add fixture function", 1),
            commit(secondHead, firstHead, "Trim fixture input", 2),
          ]
        : [commit(firstHead, baseOid, "Add fixture function", 1)],
  };
}

function repositoryText(oid) {
  return [
    "export function fixture(value: string) {",
    oid === secondHead ? "  return value.trim();" : "  return value;",
    "}",
    "",
    "const stableOne = true;",
    "const stableTwo = true;",
    "const stableThree = true;",
    "const stableFour = true;",
    "const stableFive = true;",
    "const stableSix = true;",
    "const stableSeven = true;",
    "const stableEight = true;",
    'export const fixtureSearchTarget = "fixture";',
    "",
  ].join("\n");
}

function repositoryDocumentText(oid, filePath) {
  if (repositoryDemo) return repositoryDemo.repositoryDocumentAt(oid, filePath).text ?? "";
  if (filePath === "binary.bin" || filePath === "large.txt") return "";
  if (filePath === "README.md") {
    return [
      "# Orders service",
      "",
      "> A Fixture reference service for resilient order placement and asynchronous fulfillment.",
      "",
      oid === secondHead ? "Repository documentation updated." : "Repository documentation.",
      "This repository line uses a soft break.",
      "It stays inline when rendered as a Markdown file.",
      "",
      "Jump to [the request lifecycle](#request-lifecycle).",
      "",
      "![Order lifecycle](docs/order-lifecycle.svg)",
      "",
      "## Request lifecycle",
      "",
      "1. Authenticate the actor at the HTTP boundary.",
      "2. Validate and authorize the application command.",
      "3. Reserve inventory and authorize payment.",
      "4. Persist the order and its domain events in one transaction.",
      "5. Deliver events from the transactional outbox.",
      "",
      "## Local development",
      "",
      "```bash",
      "npm install",
      "npm test",
      "npm run dev",
      "```",
      "",
      "## Release readiness",
      "",
      "| Check | Status | Notes |",
      "| --- | --- | --- |",
      "| Unit tests | Ready | Fast checks cover the application and infrastructure boundaries. |",
      "| Deployment review | Pending | This intentionally long note verifies that prose in a wide Markdown table wraps at a readable column width instead of forcing the reader to scroll across one unbroken line for every row. |",
      "",
      "- [x] Unit tests",
      "- [ ] Deployment review",
      "",
      "<details>",
      "<summary>Operational details</summary>",
      "",
      "Payment reconciliation can be inspected without leaving the Markdown preview.",
      "",
      "</details>",
      "",
      "<script>window.__rvwUnsafeMarkdownExecuted = true;</script>",
      "",
      "## Operational notes",
      "",
      "The dispatcher uses `FOR UPDATE SKIP LOCKED`, so multiple workers can drain the outbox without claiming the same row. Consumers must still tolerate duplicate delivery.",
      "",
      "See [the order workflow](docs/order-workflow.md) for the complete failure model.",
      "",
      `![External telemetry](http://${host}:${port}/api/test/external-image)`,
      "",
    ].join("\n");
  }
  if (filePath === "src/new.ts") return "export const added = true;\n";
  if (filePath === "src/removed.ts") return "export const removed = true;\n";
  if (filePath in walkthroughRepositorySources || walkthroughRepositoryPaths.includes(filePath)) {
    const source = walkthroughRepositoryText(filePath);
    return filePath === "src/application/orders/create-order.ts" && oid === secondHead
      ? `${source.trimEnd()}\n\n// Updated orchestration path.\n`
      : source;
  }
  return repositoryText(oid);
}

function repositoryPathsAt(oid) {
  if (repositoryDemo) {
    return repositoryDemo.repositoryEntriesAt(oid).map((entry) => entry.path);
  }
  return [
    ...new Set([
      "README.md",
      "binary.bin",
      "large.txt",
      "src/fixture.ts",
      ...(oid === secondHead ? ["src/new.ts"] : ["src/removed.ts"]),
      ...walkthroughRepositoryPaths,
    ]),
  ];
}

function missingRepositoryDocument(ref) {
  return {
    ref,
    availability: "missing",
    text: null,
    byteLength: 0,
    entryKind: "file",
    normalizedLineEndings: false,
    oid: null,
  };
}

function unavailableRepositoryDocument(ref, availability) {
  return {
    ref,
    availability,
    text: null,
    byteLength: availability === "binary" ? 4 : 1024 * 1024 + 1,
    entryKind: "file",
    normalizedLineEndings: false,
    oid: "d".repeat(40),
  };
}

function fixedStringMatches(text, query, matchCase, wholeWord) {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(escaped, matchCase ? "gu" : "giu");
  const wordCharacter = /[\p{L}\p{N}_]/u;
  const isWordCharacter = (value) => value !== undefined && wordCharacter.test(value);
  return [...text.matchAll(expression)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }))
    .filter(
      ({ start, end }) =>
        !wholeWord ||
        !(
          (isWordCharacter(text[start - 1]) && isWordCharacter(text[start])) ||
          (isWordCharacter(text[end - 1]) && isWordCharacter(text[end]))
        ),
    );
}

function document(ref, text, isVirtual = false) {
  return {
    ref,
    availability: "available",
    text,
    byteLength: Buffer.byteLength(text),
    entryKind: isVirtual ? "virtual" : "file",
    normalizedLineEndings: false,
    oid: isVirtual ? null : "d".repeat(40),
  };
}

function repositoryDocument(ref) {
  if (repositoryDemo) {
    return { ref, ...repositoryDemo.repositoryDocumentAt(ref.sourceOid, ref.path) };
  }
  if (ref.path === "binary.bin") return unavailableRepositoryDocument(ref, "binary");
  if (ref.path === "large.txt") return unavailableRepositoryDocument(ref, "too-large");
  return document(ref, repositoryDocumentText(ref.sourceOid, ref.path));
}

function hashDocument(text) {
  return createHash("sha256").update(text).digest("hex");
}

function enrichCommentTarget(target) {
  if (target.kind !== "document" || target.documentKind !== "pull-request-markdown") {
    return target;
  }
  const pullRequest = currentPullRequest();
  const markdown = `# ${pullRequest.latestTitle}\n\n${pullRequest.latestBody}`;
  const quotedText =
    target.startLine === null || target.endLine === null
      ? null
      : markdown
          .split("\n")
          .slice(target.startLine - 1, target.endLine)
          .join("\n");
  return {
    ...target,
    sourceDocumentHash: hashDocument(markdown),
    quotedText,
  };
}

const app = new Hono();
app.use("*", async (context, next) => {
  if (context.req.header("host") !== `${host}:${port}`) {
    return context.json(
      { ok: false, error: { code: "HOST_NOT_ALLOWED", message: "bad host" } },
      403,
    );
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(context.req.method)) {
    if (context.req.header("content-type")?.split(";")[0] !== "application/json") {
      return context.json(
        { ok: false, error: { code: "CONTENT_TYPE_REQUIRED", message: "json only" } },
        415,
      );
    }
    const origin = context.req.header("origin");
    if (origin && origin !== `http://${host}:${port}`) {
      return context.json(
        { ok: false, error: { code: "INVALID_ORIGIN", message: "bad origin" } },
        403,
      );
    }
  }
  await next();
});

app.use("/api/pull-requests/*", async (context, next) => {
  const requestedId = context.req.path.match(/^\/api\/pull-requests\/([^/]+)/)?.[1] ?? "";
  if (!viewerIdPattern.test(requestedId)) {
    return context.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "invalid pull request ID" } },
      400,
    );
  }
  if (requestedId !== pullRequestId) {
    return context.json(
      { ok: false, error: { code: "PULL_REQUEST_NOT_FOUND", message: "missing pull request" } },
      404,
    );
  }
  await next();
});

app.get("/api/meta/change-sequence", (context) => {
  const viewerId = context.req.header("x-rvw-viewer-id");
  if (!viewerIdPattern.test(viewerId ?? "")) {
    return context.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "invalid viewer ID" } },
      400,
    );
  }
  activeViewers.add(viewerId);
  releasedViewers.delete(viewerId);
  return context.json({ ok: true, changeSequence });
});

app.post("/api/meta/viewers/release", async (context) => {
  const { viewerId } = await context.req.json();
  if (!viewerIdPattern.test(viewerId ?? "")) {
    return context.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "invalid viewer ID" } },
      400,
    );
  }
  activeViewers.delete(viewerId);
  releasedViewers.add(viewerId);
  return context.json({ ok: true });
});

app.get("/api/preferences/theme", (context) => context.json({ ok: true, themePreference }));

app.post("/api/preferences/theme", async (context) => {
  const input = await context.req.json();
  if (!["light", "dark", "system"].includes(input.themePreference)) {
    return context.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "invalid theme" } },
      400,
    );
  }
  themePreference = input.themePreference;
  return context.json({ ok: true, themePreference });
});

app.get("/api/test/viewers", (context) =>
  context.json({
    ok: true,
    activeViewers: [...activeViewers],
    releasedViewers: [...releasedViewers],
  }),
);

app.get("/api/test/external-image", (context) => {
  blockedImageRequestCount += 1;
  return context.body(null, 204);
});

app.get("/api/test/external-image-count", (context) =>
  context.json({ ok: true, count: blockedImageRequestCount }),
);

app.get("/api/pull-requests/:id", (context) => context.json({ ok: true, ...currentView() }));

app.post("/api/pull-requests/:id/refresh", async (context) => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (!repositoryDemo) syncStage = Math.min(syncStage + 1, 2);
  changeSequence += 1;
  return context.json({ ok: true, ...currentView(), commentUpdatesApplied: 0 });
});

app.get("/api/pull-requests/:id/tree", (context) => {
  const oid = repositoryDemo
    ? (context.req.query("oid") ?? currentView().headOid)
    : currentView().headOid;
  if (repositoryDemo) {
    return context.json({
      ok: true,
      virtual: "Pull Request.md",
      entries: repositoryDemo.repositoryEntriesAt(oid),
    });
  }
  const paths = repositoryPathsAt(oid);
  return context.json({
    ok: true,
    virtual: "Pull Request.md",
    entries: paths.map((filePath, index) => ({
      mode: "100644",
      type: "blob",
      oid: index.toString(16).padStart(40, "0"),
      size:
        filePath === "binary.bin"
          ? 4
          : filePath === "large.txt"
            ? 1024 * 1024 + 1
            : Buffer.byteLength(repositoryDocumentText(oid, filePath)),
      path: filePath,
      kind: "file",
    })),
  });
});

app.get("/api/pull-requests/:id/changed-files", (context) => {
  if (repositoryDemo) {
    const oldOid = context.req.query("oldOid");
    const newOid = context.req.query("newOid");
    return context.json({
      ok: true,
      oldOid,
      newOid,
      files: repositoryDemo.changedFiles(oldOid, newOid),
    });
  }
  const range = context.req.query("oldOid") === firstHead;
  const files = range
    ? [
        {
          kind: "modified",
          status: "M",
          similarity: null,
          oldPath: "src/fixture.ts",
          newPath: "src/fixture.ts",
        },
        {
          kind: "modified",
          status: "M",
          similarity: null,
          oldPath: "README.md",
          newPath: "README.md",
        },
      ]
    : [
        {
          kind: "modified",
          status: "M",
          similarity: null,
          oldPath: "src/fixture.ts",
          newPath: "src/fixture.ts",
        },
        {
          kind: "added",
          status: "A",
          similarity: null,
          oldPath: null,
          newPath: "src/new.ts",
        },
        {
          kind: "deleted",
          status: "D",
          similarity: null,
          oldPath: "src/removed.ts",
          newPath: null,
        },
      ];
  return context.json({
    ok: true,
    oldOid: context.req.query("oldOid"),
    newOid: context.req.query("newOid"),
    files,
  });
});

app.get("/api/pull-requests/:id/document", (context) => {
  if (context.req.query("kind") === "pull-request-markdown") {
    const pullRequest = currentPullRequest();
    const ref = { kind: "pull-request-markdown", pullRequestId };
    return context.json({
      ok: true,
      document: document(ref, `# ${pullRequest.latestTitle}\n\n${pullRequest.latestBody}`, true),
    });
  }
  const sourceOid = context.req.query("sourceOid");
  const filePath = context.req.query("path");
  const ref = { kind: "repository-file", pullRequestId, sourceOid, path: filePath };
  if (!repositoryPathsAt(sourceOid).includes(filePath)) {
    return context.json({
      ok: true,
      document: missingRepositoryDocument(ref),
    });
  }
  return context.json({ ok: true, document: repositoryDocument(ref) });
});

app.get("/api/pull-requests/:id/markdown-asset", (context) => {
  if (context.req.query("path") !== "docs/order-lifecycle.svg") {
    return context.json(
      { ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "missing asset" } },
      404,
    );
  }
  context.header("content-type", "image/svg+xml; charset=utf-8");
  return context.body(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60"><rect width="240" height="60" rx="8" fill="#1f6feb"/><text x="120" y="36" text-anchor="middle" fill="white" font-family="sans-serif" font-size="16">Order lifecycle</text></svg>',
  );
});

app.get("/api/pull-requests/:id/diff", (context) => {
  const oldOid = context.req.query("oldOid");
  const newOid = context.req.query("newOid");
  const oldPath = context.req.query("oldPath");
  const newPath = context.req.query("newPath");
  const oldDocument =
    oldPath && repositoryPathsAt(oldOid).includes(oldPath)
      ? repositoryDocument({
          kind: "repository-file",
          pullRequestId,
          sourceOid: oldOid,
          path: oldPath,
        })
      : null;
  const newDocument =
    newPath && repositoryPathsAt(newOid).includes(newPath)
      ? repositoryDocument({
          kind: "repository-file",
          pullRequestId,
          sourceOid: newOid,
          path: newPath,
        })
      : null;
  return context.json({ ok: true, diff: { old: oldDocument, new: newDocument } });
});

app.get("/api/pull-requests/:id/search", (context) => {
  const oid = context.req.query("oid");
  const query = context.req.query("q") ?? "";
  const matchCase = context.req.query("matchCase") === "true";
  const wholeWord = context.req.query("wholeWord") === "true";
  const pullRequest = currentPullRequest();
  const documents = [
    {
      document: { kind: "pull-request-markdown", pullRequestId },
      path: "Pull Request.md",
      text: `# ${pullRequest.latestTitle}\n\n${pullRequest.latestBody}`,
    },
    ...repositoryPathsAt(oid).map((filePath) => ({
      document: {
        kind: "repository-file",
        pullRequestId,
        sourceOid: oid,
        path: filePath,
      },
      path: filePath,
      text: repositoryDocumentText(oid, filePath),
    })),
  ];
  const results = documents.flatMap(({ document: documentRef, path: filePath, text }) =>
    text.split("\n").flatMap((lineText, index) => {
      const matches = fixedStringMatches(lineText, query, matchCase, wholeWord);
      return matches.length > 0
        ? [
            {
              document: documentRef,
              path: filePath,
              line: index + 1,
              text: lineText,
              matches,
            },
          ]
        : [];
    }),
  );
  return context.json({
    ok: true,
    results,
    matchCount: results.reduce((count, result) => count + result.matches.length, 0),
    truncated: false,
    limits: { queryBytes: 1024, resultCount: 500, stdoutBytes: 8388608 },
  });
});

app.get("/api/pull-requests/:id/comments", (context) => context.json({ ok: true, comments }));

app.get("/api/pull-requests/:id/walkthroughs", (context) =>
  context.json({
    ok: true,
    walkthroughs: activeWalkthroughs.map((walkthrough) => ({
      id: walkthrough.id,
      pullRequestId: walkthrough.pullRequestId,
      sourceOid: walkthrough.sourceOid,
      title: walkthrough.title,
      authorLabel: walkthrough.authorLabel,
      referenceCount: walkthrough.references.length,
      createdAt: walkthrough.createdAt,
    })),
  }),
);

app.get("/api/pull-requests/:id/walkthroughs/:walkthroughId", (context) => {
  const walkthrough = activeWalkthroughs.find(
    (candidate) => candidate.id === context.req.param("walkthroughId"),
  );
  return walkthrough
    ? context.json({ ok: true, walkthrough })
    : context.json(
        { ok: false, error: { code: "NOT_FOUND", message: "missing walkthrough" } },
        404,
      );
});

app.post("/api/fixture/walkthroughs/:walkthroughId/update", async (context) => {
  const walkthrough = activeWalkthroughs.find(
    (candidate) => candidate.id === context.req.param("walkthroughId"),
  );
  if (!walkthrough) {
    return context.json(
      { ok: false, error: { code: "NOT_FOUND", message: "missing walkthrough" } },
      404,
    );
  }
  const input = await context.req.json();
  walkthrough.title = input.title;
  walkthrough.body = input.body;
  walkthrough.references[0].label = input.referenceLabel;
  for (const comment of comments) {
    if (comment.target.kind === "walkthrough" && comment.target.walkthroughId === walkthrough.id) {
      comment.target.walkthroughTitle = walkthrough.title;
    }
  }
  changeSequence += 1;
  return context.json({ ok: true, walkthrough });
});

app.delete("/api/pull-requests/:id/walkthroughs/:walkthroughId", (context) => {
  const walkthroughIndex = activeWalkthroughs.findIndex(
    (candidate) => candidate.id === context.req.param("walkthroughId"),
  );
  if (walkthroughIndex < 0) {
    return context.json(
      { ok: false, error: { code: "NOT_FOUND", message: "missing walkthrough" } },
      404,
    );
  }
  const [walkthrough] = activeWalkthroughs.splice(walkthroughIndex, 1);
  const associatedComments = comments.filter(
    (comment) =>
      comment.target.kind === "walkthrough" && comment.target.walkthroughId === walkthrough.id,
  );
  const associatedCommentIds = new Set(associatedComments.map((comment) => comment.id));
  const postCount = associatedComments.reduce((count, comment) => count + comment.posts.length, 0);
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    if (associatedCommentIds.has(comments[index].id)) comments.splice(index, 1);
  }
  changeSequence += 1;
  return context.json({
    ok: true,
    deleted: {
      id: walkthrough.id,
      ref: walkthrough.ref,
      pullRequestId,
      counts: {
        comments: associatedComments.length,
        posts: postCount,
        references: walkthrough.references.length,
      },
    },
  });
});

app.get("/api/comments/:id/placement", (context) => {
  const comment = comments.find((item) => item.id === context.req.param("id"));
  if (!comment) {
    return context.json(
      { ok: false, error: { code: "COMMENT_NOT_FOUND", message: "missing comment" } },
      404,
    );
  }
  if (comment.target.kind === "pull-request") {
    return context.json({ ok: true, placement: { outdated: false, range: null, path: null } });
  }
  if (comment.target.kind === "walkthrough") {
    const walkthrough = activeWalkthroughs.find(
      (candidate) => candidate.id === comment.target.walkthroughId,
    );
    if (
      !walkthrough ||
      (context.req.query("walkthroughId") && context.req.query("walkthroughId") !== walkthrough.id)
    ) {
      return context.json({ ok: true, placement: { outdated: true, range: null, path: null } });
    }
    if (comment.target.startLine === null) {
      return context.json({ ok: true, placement: { outdated: false, range: null, path: null } });
    }
    const range =
      comment.target.sourceDocumentHash === hashDocument(walkthrough.body)
        ? { startLine: comment.target.startLine, endLine: comment.target.endLine }
        : findUniqueQuotedLineRange(comment.target.quotedText, walkthrough.body);
    return context.json({
      ok: true,
      placement: range
        ? { outdated: false, range, path: null }
        : { outdated: true, range: null, path: null },
    });
  }
  const targetPath =
    comment.target.documentKind === "pull-request-markdown"
      ? "Pull Request.md"
      : comment.target.path;
  const requestedKind = context.req.query("kind");
  const requestedPath = context.req.query("path");
  const kindMatches = requestedKind === "commit" || requestedKind === comment.target.documentKind;
  const pathMatches = !requestedPath || requestedPath === targetPath;
  let range =
    comment.target.startLine === null
      ? null
      : { startLine: comment.target.startLine, endLine: comment.target.endLine };
  let targetOutdated = false;
  if (comment.target.documentKind === "pull-request-markdown" && range) {
    const pullRequest = currentPullRequest();
    const markdown = `# ${pullRequest.latestTitle}\n\n${pullRequest.latestBody}`;
    if (comment.target.sourceDocumentHash !== hashDocument(markdown)) {
      range = comment.target.quotedText
        ? findUniqueQuotedLineRange(comment.target.quotedText, markdown)
        : null;
      targetOutdated = range === null;
    }
  }
  return context.json({
    ok: true,
    placement: {
      outdated: !kindMatches || !pathMatches || targetOutdated,
      range: !kindMatches || !pathMatches || targetOutdated ? null : range,
      path: targetPath,
    },
  });
});

app.post("/api/comments", async (context) => {
  const input = await context.req.json();
  const now = new Date().toISOString();
  const id = randomUUID();
  const target =
    input.target.kind === "walkthrough"
      ? (() => {
          const walkthrough = activeWalkthroughs.find(
            (candidate) => candidate.id === input.target.walkthroughId,
          );
          const startLine = input.target.startLine ?? null;
          const endLine = input.target.endLine ?? null;
          return {
            ...input.target,
            walkthroughTitle: walkthrough?.title ?? "Walkthrough",
            sourceDocumentHash:
              walkthrough && startLine !== null && endLine !== null
                ? hashDocument(walkthrough.body)
                : null,
            quotedText:
              walkthrough && startLine !== null && endLine !== null
                ? selectedLineText(walkthrough.body, startLine, endLine)
                : null,
            startLine,
            endLine,
          };
        })()
      : enrichCommentTarget(input.target);
  const comment = {
    id,
    ref: `rvw://comment/${id}`,
    pullRequestId,
    createdHeadOid: currentPullRequest().latestHeadOid,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    target,
    posts: [
      {
        id: randomUUID(),
        commentId: id,
        body: input.body,
        relatedCommitOid: input.relatedCommitOid ?? null,
        references: input.references ?? [],
        authorLabel: input.authorLabel,
        isRoot: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  comments.push(comment);
  changeSequence += 1;
  return context.json({ ok: true, comment }, 201);
});

app.post("/api/comments/:id/posts", async (context) => {
  const input = await context.req.json();
  const comment = comments.find((item) => item.id === context.req.param("id"));
  const now = new Date().toISOString();
  const post = {
    id: randomUUID(),
    commentId: comment.id,
    body: input.body,
    relatedCommitOid: input.relatedCommitOid,
    references: input.references ?? [],
    authorLabel: input.authorLabel,
    isRoot: false,
    createdAt: now,
    updatedAt: now,
  };
  comment.posts.push(post);
  comment.updatedAt = post.createdAt;
  changeSequence += 1;
  return context.json({ ok: true, post }, 201);
});

app.patch("/api/comments/:id/posts/:postId", async (context) => {
  const input = await context.req.json();
  const comment = comments.find((item) => item.id === context.req.param("id"));
  const post = comment?.posts.find((item) => item.id === context.req.param("postId"));
  if (!post) {
    return context.json(
      { ok: false, error: { code: "COMMENT_POST_NOT_FOUND", message: "missing post" } },
      404,
    );
  }
  const now = new Date().toISOString();
  post.body = input.body;
  if (input.references !== undefined) post.references = input.references;
  post.updatedAt = now;
  comment.updatedAt = now;
  changeSequence += 1;
  return context.json({ ok: true, post });
});

app.delete("/api/comments/:id/posts/:postId", (context) => {
  const comment = comments.find((item) => item.id === context.req.param("id"));
  const postIndex =
    comment?.posts.findIndex((item) => item.id === context.req.param("postId")) ?? -1;
  if (!comment || postIndex < 0) {
    return context.json(
      { ok: false, error: { code: "COMMENT_POST_NOT_FOUND", message: "missing post" } },
      404,
    );
  }
  if (comment.posts[postIndex].isRoot) {
    return context.json(
      {
        ok: false,
        error: {
          code: "COMMENT_DELETE_NOT_ALLOWED",
          message: "root post cannot be deleted as a reply",
        },
      },
      409,
    );
  }
  const [post] = comment.posts.splice(postIndex, 1);
  comment.updatedAt = new Date().toISOString();
  changeSequence += 1;
  return context.json({ ok: true, deleted: { commentId: comment.id, postId: post.id } });
});

for (const action of ["resolve", "reopen"]) {
  app.post(`/api/comments/:id/${action}`, (context) => {
    const comment = comments.find((item) => item.id === context.req.param("id"));
    comment.resolvedAt = action === "resolve" ? new Date().toISOString() : null;
    comment.updatedAt = new Date().toISOString();
    changeSequence += 1;
    return context.json({ ok: true, comment });
  });
}

app.delete("/api/comments/:id", (context) => {
  const index = comments.findIndex((item) => item.id === context.req.param("id"));
  if (index < 0) {
    return context.json(
      { ok: false, error: { code: "COMMENT_NOT_FOUND", message: "missing comment" } },
      404,
    );
  }
  const comment = comments[index];
  comments.splice(index, 1);
  changeSequence += 1;
  return context.json({ ok: true, deleted: { id: comment.id, ref: comment.ref } });
});

const staticRoot = path.resolve("dist/web");
app.use("*", serveStatic({ root: staticRoot }));
const index = readFileSync(path.join(staticRoot, "index.html"), "utf8");
app.get("*", (context) => context.html(index));

serve({ fetch: app.fetch, hostname: host, port });
