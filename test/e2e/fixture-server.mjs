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
const attachmentId = "37948111-1227-4cdb-a76d-dc8eb469ae5c";
const brokenAttachmentId = "11111111-2222-4333-8444-555555555555";
const attachmentUrl = `https://github.com/user-attachments/assets/${attachmentId}`;
const brokenAttachmentUrl = `https://github.com/user-attachments/assets/${brokenAttachmentId}`;
const fixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const fixtureAttachmentSvg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">',
  '<rect width="320" height="160" rx="16" fill="#0d1117"/>',
  '<path d="M52 48h216v64H52z" fill="#1f6feb" opacity=".22"/>',
  '<circle cx="88" cy="80" r="22" fill="#58a6ff"/>',
  '<path d="m78 80 7 7 14-16" fill="none" stroke="#0d1117" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>',
  '<text x="124" y="75" fill="#f0f6fc" font-family="sans-serif" font-size="18" font-weight="600">rvw attachment</text>',
  '<text x="124" y="98" fill="#8b949e" font-family="sans-serif" font-size="13">authenticated preview</text>',
  "</svg>",
].join("");
const baseOid = repositoryDemo?.baseOid ?? "a".repeat(40);
const firstHead = repositoryDemo?.commits[0]?.oid ?? "b".repeat(40);
const secondHead = repositoryDemo?.headOid ?? "c".repeat(40);
const branchReviewId = "33333333-3333-4333-8333-333333333333";
const branchIssueId = "44444444-4444-4444-8444-444444444444";
const olderBranchIssueId = "55555555-5555-4555-8555-555555555555";
const branchWalkthroughId = "66666666-6666-4666-8666-666666666666";
const branchReviewFixture = {
  id: branchReviewId,
  host: "github.com",
  owner: "acme",
  repository: "review-repo",
  canonicalName: "acme/review-repo",
  localRepositoryPath: "/fixture/review-repo",
  gitCommonDir: "/fixture/review-repo/.git",
  defaultBranchName: "trunk",
  sourceOid: secondHead,
  githubFetchedAt: "2026-08-20T00:00:00.000Z",
  sourceSyncError: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};
const branchIssueFixtures = [
  {
    id: branchIssueId,
    host: "github.com",
    owner: "acme",
    repository: "review-repo",
    canonicalName: "acme/review-repo",
    number: 142,
    url: "https://github.com/acme/review-repo/issues/142",
    title: "Stabilize the request path",
    body: [
      "# Stabilize the request path",
      "",
      "Inspect the default-branch implementation.",
      "",
      "| Authenticated evidence | External reference |",
      "| --- | --- |",
      `| ![Issue attachment](${attachmentUrl}) | ![External planning diagram](https://example.com/diagram.png) |`,
    ].join("\n"),
    state: "OPEN",
    updatedAt: "2026-08-20T00:00:00.000Z",
    bodyHash: "1".repeat(64),
    fetchedAt: "2026-08-20T00:00:00.000Z",
    syncError: null,
    stale: false,
  },
  {
    id: olderBranchIssueId,
    host: "github.com",
    owner: "acme",
    repository: "review-repo",
    canonicalName: "acme/review-repo",
    number: 19,
    url: "https://github.com/acme/review-repo/issues/19",
    title: "Document recovery",
    body: "# Document recovery\n\nKeep the cached reading surface available offline.",
    state: "CLOSED",
    updatedAt: "2026-08-19T00:00:00.000Z",
    bodyHash: "2".repeat(64),
    fetchedAt: "2026-08-20T00:00:00.000Z",
    syncError: "offline fixture",
    stale: true,
  },
  {
    id: "99999999-9999-4999-8999-999999999999",
    host: "github.com",
    owner: "acme",
    repository: "review-repo",
    canonicalName: "acme/review-repo",
    number: 77,
    url: "https://github.com/acme/review-repo/issues/77",
    title: "Exercise Branch Review mutations",
    body: "# Exercise Branch Review mutations\n\nCover Issue additions and reset as durable browser flows.",
    state: "OPEN",
    updatedAt: "2026-08-20T00:00:00.000Z",
    bodyHash: "3".repeat(64),
    fetchedAt: "2026-08-20T00:00:00.000Z",
    syncError: null,
    stale: false,
  },
];
const branchWalkthroughFixture = {
  id: branchWalkthroughId,
  ref: `rvw://walkthrough/${branchWalkthroughId}`,
  branchReviewId,
  sourceOid: secondHead,
  title: "Current request flow",
  body: [
    "# Current request flow",
    "",
    "Start with [the implementation](rvw-ref:implementation).",
    "",
    "```mermaid",
    "flowchart LR",
    "  implementation[Implementation] --> result[Result]",
    "```",
  ].join("\n"),
  authorLabel: "Fixture Agent",
  diagramBindings: { implementation: "implementation" },
  references: [
    {
      id: "implementation",
      label: "Request implementation",
      path: "src/fixture.ts",
      startLine: 1,
      endLine: 3,
      description: null,
    },
  ],
  createdAt: "2026-08-20T00:00:00.000Z",
};
const branchWalkthroughCommentId = "77777777-7777-4777-8777-777777777777";
const branchWalkthroughCommentFixture = {
  id: branchWalkthroughCommentId,
  ref: `rvw://comment/${branchWalkthroughCommentId}`,
  branchReviewId,
  createdSourceOid: secondHead,
  resolvedAt: null,
  createdAt: "2026-08-20T01:00:00.000Z",
  updatedAt: "2026-08-20T01:00:00.000Z",
  target: {
    kind: "walkthrough",
    walkthroughId: branchWalkthroughId,
    walkthroughTitle: branchWalkthroughFixture.title,
    sourceDocumentHash: createHash("sha256").update(branchWalkthroughFixture.body).digest("hex"),
    quotedText: "Start with [the implementation](rvw-ref:implementation).",
    startLine: 3,
    endLine: 3,
  },
  posts: [
    {
      id: "88888888-8888-4888-8888-888888888888",
      commentId: branchWalkthroughCommentId,
      body: "Confirm this entry point against the exact default-branch source.",
      relatedCommitOid: null,
      references: [],
      authorLabel: "Branch Reviewer",
      isRoot: true,
      createdAt: "2026-08-20T01:00:00.000Z",
      updatedAt: "2026-08-20T01:00:00.000Z",
    },
  ],
};
const branchCodeCommentFixture = {
  id: "77777777-7777-4777-8777-777777777778",
  ref: "rvw://comment/77777777-7777-4777-8777-777777777778",
  branchReviewId,
  createdSourceOid: secondHead,
  resolvedAt: null,
  createdAt: "2026-08-20T01:10:00.000Z",
  updatedAt: "2026-08-20T01:10:00.000Z",
  target: {
    kind: "document",
    documentKind: "repository-file",
    sourceOid: secondHead,
    path: "src/fixture.ts",
    startLine: 2,
    endLine: 2,
  },
  posts: [
    {
      id: "88888888-8888-4888-8888-888888888889",
      commentId: "77777777-7777-4777-8777-777777777778",
      body: "Verify the default-branch trimming behavior at its exact source.",
      relatedCommitOid: secondHead,
      references: [],
      authorLabel: "Branch Reviewer",
      isRoot: true,
      createdAt: "2026-08-20T01:10:00.000Z",
      updatedAt: "2026-08-20T01:10:00.000Z",
    },
  ],
};
const branchResolvedCommentFixture = {
  id: "77777777-7777-4777-8777-777777777779",
  ref: "rvw://comment/77777777-7777-4777-8777-777777777779",
  branchReviewId,
  createdSourceOid: secondHead,
  resolvedAt: "2026-08-20T01:25:00.000Z",
  createdAt: "2026-08-20T01:20:00.000Z",
  updatedAt: "2026-08-20T01:25:00.000Z",
  target: { kind: "branch" },
  posts: [
    {
      id: "88888888-8888-4888-8888-888888888890",
      commentId: "77777777-7777-4777-8777-777777777779",
      body: "The default-branch scope is confirmed.",
      relatedCommitOid: null,
      references: [],
      authorLabel: "Branch Reviewer",
      isRoot: true,
      createdAt: "2026-08-20T01:20:00.000Z",
      updatedAt: "2026-08-20T01:20:00.000Z",
    },
  ],
};
let branchReview;
let branchIssues;
let branchWalkthroughs;
let branchCommentContexts;

function resetBranchFixture() {
  branchReview = structuredClone(branchReviewFixture);
  branchIssues = structuredClone(branchIssueFixtures.slice(0, 2));
  branchWalkthroughs = [structuredClone(branchWalkthroughFixture)];
  branchCommentContexts = [
    {
      comment: structuredClone(branchWalkthroughCommentFixture),
      latestPlacement: { outdated: false, range: { startLine: 3, endLine: 3 }, path: null },
    },
    {
      comment: structuredClone(branchCodeCommentFixture),
      latestPlacement: {
        outdated: false,
        range: { startLine: 2, endLine: 2 },
        path: "src/fixture.ts",
      },
    },
    {
      comment: structuredClone(branchResolvedCommentFixture),
      latestPlacement: { outdated: false, range: null, path: null },
    },
  ];
}

resetBranchFixture();
const comments = repositoryDemo ? structuredClone(repositoryDemo.comments) : [];
const pullRequestIssues = repositoryDemo ? structuredClone(repositoryDemo.issues) : [];
const originalWalkthroughs = structuredClone(walkthroughs);
const activeWalkthroughs = repositoryDemo
  ? structuredClone(repositoryDemo.walkthroughs)
  : walkthroughs;
const activeViewers = new Set();
const releasedViewers = new Set();
let changeSequence = 0;
let syncStage = 0;
let themePreference = "system";
let blockedImageRequestCount = 0;
let imageTextRequestCount = 0;
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
  const body =
    syncStage > 1
      ? "The PR body was rewritten.\nAdditional review details.\n\nFinal note."
      : syncStage > 0
        ? "This is always the latest PR body."
        : "Review the fixture application.";
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
    latestBody: [
      body,
      "",
      "## Visual evidence",
      "",
      "| Authenticated attachment | Broken attachment | External reference |",
      "| --- | --- | --- |",
      `| ![Private attachment](${attachmentUrl}) | ![Broken attachment](${brokenAttachmentUrl}) | ![External PR image](http://${host}:${port}/api/test/external-image) |`,
    ].join("\n"),
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
  if (/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(filePath)) return "";
  if (filePath === "docs/hybrid.md") {
    return "# Hybrid document\n\nThe renamed image is now Markdown.\n";
  }
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
      "assets/modified.png",
      "assets/broken.png",
      "assets/too-large.png",
      "assets/unsupported.png",
      ...(oid === baseOid
        ? ["assets/deleted.png", "assets/old-name.png", "assets/hybrid.png"]
        : []),
      ...(oid === baseOid ? [] : ["assets/added.png", "assets/new-name.png", "docs/hybrid.md"]),
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
  if (target.kind === "issue") {
    const number = Number(String(target.issue).match(/(?:^#|\/issues\/)(\d+)$/)?.[1]);
    const issue = pullRequestIssues.find(
      (candidate) =>
        candidate.id === target.issue ||
        candidate.url === target.issue ||
        candidate.number === number,
    );
    if (!issue) return null;
    const startLine = target.startLine ?? null;
    const endLine = target.endLine ?? null;
    return {
      kind: "issue",
      issueId: issue.id,
      issueUrl: issue.url,
      issueNumber: issue.number,
      issueTitle: issue.title,
      sourceDocumentHash: issue.bodyHash,
      quotedText:
        startLine === null || endLine === null
          ? null
          : selectedLineText(issue.body, startLine, endLine),
      startLine,
      endLine,
    };
  }
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

function branchWalkthroughSummaries() {
  return branchWalkthroughs.map((walkthrough) => ({
    id: walkthrough.id,
    branchReviewId: branchReview.id,
    sourceOid: walkthrough.sourceOid,
    title: walkthrough.title,
    authorLabel: walkthrough.authorLabel,
    referenceCount: walkthrough.references.length,
    createdAt: walkthrough.createdAt,
  }));
}

function findBranchIssue(reference) {
  const number = Number(String(reference).match(/(?:^#|\/issues\/)(\d+)$/)?.[1]);
  return branchIssues.find(
    (issue) => issue.id === reference || issue.url === reference || issue.number === number,
  );
}

function enrichBranchCommentTarget(target) {
  const startLine = target.startLine ?? null;
  const endLine = target.endLine ?? null;
  if (target.kind === "branch") return target;
  if (target.kind === "issue") {
    const issue = findBranchIssue(target.issue);
    if (!issue) return null;
    return {
      kind: "issue",
      issueId: issue.id,
      issueUrl: issue.url,
      issueNumber: issue.number,
      issueTitle: issue.title,
      sourceDocumentHash: issue.bodyHash,
      quotedText:
        startLine === null || endLine === null
          ? null
          : selectedLineText(issue.body, startLine, endLine),
      startLine,
      endLine,
    };
  }
  if (target.kind === "walkthrough") {
    const walkthrough = branchWalkthroughs.find(
      (candidate) => candidate.id === target.walkthroughId,
    );
    if (!walkthrough) return null;
    const quotedText =
      startLine === null || endLine === null
        ? null
        : selectedLineText(walkthrough.body, startLine, endLine);
    return {
      kind: "walkthrough",
      walkthroughId: walkthrough.id,
      walkthroughTitle: walkthrough.title,
      sourceDocumentHash: quotedText === null ? null : hashDocument(walkthrough.body),
      quotedText,
      startLine,
      endLine,
    };
  }
  return { ...target, startLine, endLine };
}

function branchCommentPlacement(target) {
  if (target.kind === "branch") return { outdated: false, range: null, path: null };
  if (target.kind === "issue") {
    const issue = branchIssues.find((candidate) => candidate.id === target.issueId);
    const current =
      issue !== undefined &&
      (target.startLine === null || issue.bodyHash === target.sourceDocumentHash);
    return current
      ? {
          outdated: false,
          range:
            target.startLine === null
              ? null
              : { startLine: target.startLine, endLine: target.endLine },
          path: `#${target.issueNumber}`,
        }
      : { outdated: true, range: null, path: `#${target.issueNumber}` };
  }
  if (target.kind === "walkthrough") {
    const walkthrough = branchWalkthroughs.find(
      (candidate) => candidate.id === target.walkthroughId,
    );
    if (!walkthrough) return { outdated: true, range: null, path: null };
    if (target.startLine === null) return { outdated: false, range: null, path: null };
    const range =
      target.sourceDocumentHash === hashDocument(walkthrough.body)
        ? { startLine: target.startLine, endLine: target.endLine }
        : findUniqueQuotedLineRange(target.quotedText, walkthrough.body);
    return range
      ? { outdated: false, range, path: null }
      : { outdated: true, range: null, path: null };
  }
  return {
    outdated: target.sourceOid !== branchReview.sourceOid,
    range:
      target.sourceOid === branchReview.sourceOid && target.startLine !== null
        ? { startLine: target.startLine, endLine: target.endLine }
        : null,
    path: target.path,
  };
}

function findFixtureComment(id) {
  return (
    comments.find((comment) => comment.id === id) ??
    branchCommentContexts.find(({ comment }) => comment.id === id)?.comment ??
    null
  );
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

app.use("/api/branch-reviews/*", async (context, next) => {
  if (context.req.path === "/api/branch-reviews/open") {
    await next();
    return;
  }
  const requestedId = context.req.path.match(/^\/api\/branch-reviews\/([^/]+)/)?.[1] ?? "";
  if (!viewerIdPattern.test(requestedId)) {
    return context.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "invalid branch review ID" } },
      400,
    );
  }
  if (!branchReview || requestedId !== branchReview.id) {
    return context.json(
      { ok: false, error: { code: "BRANCH_REVIEW_NOT_FOUND", message: "missing branch review" } },
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
  return context.json({ ok: true, changeSequence, reviewChangeSequence: changeSequence });
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

app.post("/api/test/reset-branch-review", (context) => {
  resetBranchFixture();
  changeSequence += 1;
  return context.json({ ok: true, branchReviewId: branchReview.id });
});

app.post("/api/test/refresh-branch-review", async (context) => {
  const input = await context.req.json();
  if (typeof input.sourceOid === "string") {
    branchReview.sourceOid = input.sourceOid;
    branchReview.updatedAt = new Date().toISOString();
  }
  if (typeof input.issueNumber === "number" && typeof input.issueBody === "string") {
    const issue = branchIssues.find((candidate) => candidate.number === input.issueNumber);
    if (!issue) {
      return context.json(
        { ok: false, error: { code: "ISSUE_NOT_FOUND", message: "missing issue" } },
        404,
      );
    }
    issue.body = input.issueBody;
    issue.bodyHash = hashDocument(input.issueBody);
    issue.updatedAt = new Date().toISOString();
    issue.fetchedAt = issue.updatedAt;
  }
  changeSequence += 1;
  return context.json({ ok: true, branchReview, issues: branchIssues, changeSequence });
});

app.post("/api/test/update-branch-walkthrough", async (context) => {
  const input = await context.req.json();
  const walkthrough = branchWalkthroughs.find(
    (candidate) => candidate.id === (input.walkthroughId ?? branchWalkthroughId),
  );
  if (!walkthrough) {
    return context.json(
      { ok: false, error: { code: "WALKTHROUGH_NOT_FOUND", message: "missing walkthrough" } },
      404,
    );
  }
  if (typeof input.title === "string") walkthrough.title = input.title;
  if (typeof input.body === "string") walkthrough.body = input.body;
  if (typeof input.sourceOid === "string") walkthrough.sourceOid = input.sourceOid;
  if (Array.isArray(input.references)) walkthrough.references = structuredClone(input.references);
  if (input.diagramBindings && typeof input.diagramBindings === "object") {
    walkthrough.diagramBindings = structuredClone(input.diagramBindings);
  }
  changeSequence += 1;
  return context.json({ ok: true, walkthrough, changeSequence });
});

app.get("/api/test/image-text-request-count", (context) =>
  context.json({ ok: true, count: imageTextRequestCount }),
);

app.get("/api/pull-requests/:id", (context) => context.json({ ok: true, ...currentView() }));

app.get("/api/pull-requests/:id/issues", (context) =>
  context.json({ ok: true, issues: pullRequestIssues }),
);

app.get("/api/pull-requests/:id/issues/:issueId", (context) => {
  const issue = pullRequestIssues.find(
    (candidate) => candidate.id === context.req.param("issueId"),
  );
  return issue
    ? context.json({ ok: true, issue })
    : context.json(
        { ok: false, error: { code: "ISSUE_NOT_FOUND", message: "missing issue" } },
        404,
      );
});

app.delete("/api/pull-requests/:id/issues/:issueId", async (context) => {
  const issueIndex = pullRequestIssues.findIndex(
    (candidate) => candidate.id === context.req.param("issueId"),
  );
  if (issueIndex < 0) {
    return context.json(
      { ok: false, error: { code: "ISSUE_NOT_FOUND", message: "missing issue" } },
      404,
    );
  }
  const issue = pullRequestIssues[issueIndex];
  const issueComments = comments.filter(
    (comment) => comment.target.kind === "issue" && comment.target.issueId === issue.id,
  );
  const counts = {
    issueWholeComments: issueComments.filter((comment) => comment.target.startLine === null).length,
    issueRangeComments: issueComments.filter((comment) => comment.target.startLine !== null).length,
    replies: issueComments.reduce(
      (total, comment) => total + comment.posts.filter((post) => !post.isRoot).length,
      0,
    ),
  };
  const input = await context.req.json();
  if (!input.yes) {
    return context.json(
      {
        ok: false,
        error: { code: "RESET_CONFIRMATION_REQUIRED", message: "confirmation required" },
        issue,
        counts,
        confirmationRequired: true,
      },
      409,
    );
  }
  pullRequestIssues.splice(issueIndex, 1);
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    if (comments[index].target.kind === "issue" && comments[index].target.issueId === issue.id) {
      comments.splice(index, 1);
    }
  }
  changeSequence += 1;
  return context.json({ ok: true, issue, deleted: counts });
});

app.get("/api/branch-reviews/:id", (context) =>
  context.json({
    ok: true,
    branchReview,
    issues: branchIssues,
    walkthroughs: branchWalkthroughSummaries(),
  }),
);

app.post("/api/branch-reviews/open", (context) => {
  const fromCache = branchReview !== null;
  if (!branchReview) {
    const now = new Date().toISOString();
    branchReview = {
      ...structuredClone(branchReviewFixture),
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
  }
  return context.json({ ok: true, branchReview, fromCache });
});

app.post("/api/branch-reviews/:id/sync", (context) =>
  context.json({ ok: true, branchReview, issues: branchIssues, issueResults: [] }),
);

app.post("/api/branch-reviews/:id/reset", async (context) => {
  const retainedRefs = [`refs/rvw/branch/${branchReview.id}/commits/oid-${branchReview.sourceOid}`];
  const counts = {
    branchReview: 1,
    issueMemberships: branchIssues.length,
    issueComments: branchCommentContexts.filter(({ comment }) => comment.target.kind === "issue")
      .length,
    codeComments: branchCommentContexts.filter(({ comment }) => comment.target.kind === "document")
      .length,
    reviewComments: branchCommentContexts.filter(({ comment }) => comment.target.kind === "branch")
      .length,
    walkthroughComments: branchCommentContexts.filter(
      ({ comment }) => comment.target.kind === "walkthrough",
    ).length,
    posts: branchCommentContexts.reduce((total, { comment }) => total + comment.posts.length, 0),
    walkthroughs: branchWalkthroughs.length,
    gitRefs: retainedRefs.length,
  };
  const input = await context.req.json();
  if (!input.yes) {
    return context.json(
      {
        ok: false,
        error: { code: "RESET_CONFIRMATION_REQUIRED", message: "confirmation required" },
        branchReview,
        counts,
        retainedRefs,
        confirmationRequired: true,
      },
      409,
    );
  }
  const deletedBranchReview = branchReview;
  branchReview = null;
  branchIssues = [];
  branchWalkthroughs = [];
  branchCommentContexts = [];
  changeSequence += 1;
  return context.json({
    ok: true,
    branchReview: deletedBranchReview,
    deleted: counts,
    removedRefs: retainedRefs,
  });
});

app.post("/api/branch-reviews/:id/issues", async (context) => {
  const input = await context.req.json();
  const number = Number(String(input.issue).match(/(?:^#|\/issues\/)(\d+)$/)?.[1]);
  const fixture = branchIssueFixtures.find((issue) => issue.number === number);
  if (!fixture) {
    return context.json(
      { ok: false, error: { code: "GITHUB_ISSUE_ERROR", message: "missing fixture issue" } },
      404,
    );
  }
  const existing = branchIssues.find((issue) => issue.id === fixture.id);
  if (existing) {
    return context.json({ ok: true, branchReview, issue: existing, added: false });
  }
  const issue = structuredClone(fixture);
  branchIssues.unshift(issue);
  changeSequence += 1;
  return context.json({ ok: true, branchReview, issue, added: true });
});

app.delete("/api/branch-reviews/:id/issues/:issueId", async (context) => {
  const issueIndex = branchIssues.findIndex(
    (candidate) => candidate.id === context.req.param("issueId"),
  );
  if (issueIndex < 0) {
    return context.json(
      { ok: false, error: { code: "ISSUE_NOT_FOUND", message: "missing issue" } },
      404,
    );
  }
  const issue = branchIssues[issueIndex];
  const issueComments = branchCommentContexts.filter(
    ({ comment }) => comment.target.kind === "issue" && comment.target.issueId === issue.id,
  );
  const counts = {
    issueWholeComments: issueComments.filter(({ comment }) => comment.target.startLine === null)
      .length,
    issueRangeComments: issueComments.filter(({ comment }) => comment.target.startLine !== null)
      .length,
    replies: issueComments.reduce(
      (total, { comment }) => total + comment.posts.filter((post) => !post.isRoot).length,
      0,
    ),
  };
  const input = await context.req.json();
  if (!input.yes) {
    return context.json(
      {
        ok: false,
        error: { code: "RESET_CONFIRMATION_REQUIRED", message: "confirmation required" },
        issue,
        counts,
        confirmationRequired: true,
      },
      409,
    );
  }
  branchIssues.splice(issueIndex, 1);
  branchCommentContexts = branchCommentContexts.filter(
    ({ comment }) => comment.target.kind !== "issue" || comment.target.issueId !== issue.id,
  );
  changeSequence += 1;
  return context.json({ ok: true, issue, deleted: counts });
});

app.get("/api/branch-reviews/:id/tree", (context) =>
  context.json({
    ok: true,
    entries: repositoryPathsAt(secondHead).map((filePath) => ({
      mode: "100644",
      type: "blob",
      oid: "d".repeat(40),
      size: Buffer.byteLength(repositoryDocumentText(secondHead, filePath), "utf8"),
      path: filePath,
      kind: "file",
    })),
  }),
);

app.get("/api/branch-reviews/:id/document", (context) => {
  const kind = context.req.query("kind");
  if (kind === "issue-markdown") {
    const issue = branchIssues.find((candidate) => candidate.id === context.req.query("issueId"));
    if (!issue) {
      return context.json(
        { ok: false, error: { code: "ISSUE_NOT_FOUND", message: "missing issue" } },
        404,
      );
    }
    return context.json({
      ok: true,
      document: {
        ref: { kind, branchReviewId: branchReview.id, issueId: issue.id },
        availability: "available",
        text: issue.body,
        byteLength: Buffer.byteLength(issue.body, "utf8"),
        entryKind: "virtual",
        normalizedLineEndings: false,
        oid: null,
      },
    });
  }
  const filePath = context.req.query("path");
  const text = repositoryDocumentText(secondHead, filePath);
  return context.json({
    ok: true,
    document: {
      ref: {
        kind: "repository-file",
        branchReviewId: branchReview.id,
        sourceOid: secondHead,
        path: filePath,
      },
      availability: "available",
      text,
      byteLength: Buffer.byteLength(text, "utf8"),
      entryKind: "file",
      normalizedLineEndings: false,
      oid: "d".repeat(40),
    },
  });
});

app.get("/api/branch-reviews/:id/markdown-asset", (context) => {
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

app.get("/api/branch-reviews/:id/search", (context) => {
  const query = context.req.query("q") ?? "";
  const matchCase = context.req.query("matchCase") === "true";
  const wholeWord = context.req.query("wholeWord") === "true";
  const results = repositoryPathsAt(secondHead).flatMap((filePath) =>
    repositoryDocumentText(secondHead, filePath)
      .split("\n")
      .flatMap((line, index) => {
        const matches = fixedStringMatches(line, query, matchCase, wholeWord);
        return matches.length === 0
          ? []
          : [
              {
                document: {
                  kind: "repository-file",
                  branchReviewId: branchReview.id,
                  sourceOid: secondHead,
                  path: filePath,
                },
                path: filePath,
                line: index + 1,
                text: line,
                matches,
              },
            ];
      }),
  );
  return context.json({
    ok: true,
    results,
    matchCount: results.reduce((total, result) => total + result.matches.length, 0),
    truncated: false,
    limits: { queryBytes: 1024, resultCount: 500, stdoutBytes: 8388608 },
  });
});

app.get("/api/branch-reviews/:id/comments", (context) =>
  context.json({
    ok: true,
    comments: branchCommentContexts.map(({ comment }) => ({
      comment,
      latestPlacement: branchCommentPlacement(comment.target),
    })),
  }),
);

app.get("/api/branch-reviews/:id/walkthroughs/:walkthroughId", (context) => {
  const walkthrough = branchWalkthroughs.find(
    (candidate) => candidate.id === context.req.param("walkthroughId"),
  );
  return walkthrough
    ? context.json({ ok: true, walkthrough })
    : context.json(
        { ok: false, error: { code: "WALKTHROUGH_NOT_FOUND", message: "missing walkthrough" } },
        404,
      );
});

app.delete("/api/branch-reviews/:id/walkthroughs/:walkthroughId", (context) => {
  const walkthroughIndex = branchWalkthroughs.findIndex(
    (candidate) => candidate.id === context.req.param("walkthroughId"),
  );
  if (walkthroughIndex < 0) {
    return context.json(
      { ok: false, error: { code: "WALKTHROUGH_NOT_FOUND", message: "missing walkthrough" } },
      404,
    );
  }
  const [walkthrough] = branchWalkthroughs.splice(walkthroughIndex, 1);
  const associatedComments = branchCommentContexts.filter(
    ({ comment }) =>
      comment.target.kind === "walkthrough" && comment.target.walkthroughId === walkthrough.id,
  );
  const postCount = associatedComments.reduce(
    (count, { comment }) => count + comment.posts.length,
    0,
  );
  branchCommentContexts = branchCommentContexts.filter(
    ({ comment }) =>
      comment.target.kind !== "walkthrough" || comment.target.walkthroughId !== walkthrough.id,
  );
  changeSequence += 1;
  return context.json({
    ok: true,
    deleted: {
      id: walkthrough.id,
      ref: walkthrough.ref,
      branchReviewId,
      counts: {
        comments: associatedComments.length,
        posts: postCount,
        references: walkthrough.references.length,
      },
    },
  });
});

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
  files.push(
    {
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "assets/modified.png",
      newPath: "assets/modified.png",
    },
    {
      kind: "added",
      status: "A",
      similarity: null,
      oldPath: null,
      newPath: "assets/added.png",
    },
    {
      kind: "deleted",
      status: "D",
      similarity: null,
      oldPath: "assets/deleted.png",
      newPath: null,
    },
    {
      kind: "renamed",
      status: "R100",
      similarity: 100,
      oldPath: "assets/old-name.png",
      newPath: "assets/new-name.png",
    },
    {
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "assets/too-large.png",
      newPath: "assets/too-large.png",
    },
    {
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "assets/unsupported.png",
      newPath: "assets/unsupported.png",
    },
  );
  if (context.req.query("oldOid") === baseOid) {
    files.push({
      kind: "renamed",
      status: "R100",
      similarity: 100,
      oldPath: "assets/hybrid.png",
      newPath: "docs/hybrid.md",
    });
  }
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
  if (context.req.query("kind") === "issue-markdown") {
    const issue = pullRequestIssues.find(
      (candidate) => candidate.id === context.req.query("issueId"),
    );
    if (!issue) {
      return context.json(
        { ok: false, error: { code: "ISSUE_NOT_FOUND", message: "missing issue" } },
        404,
      );
    }
    const ref = { kind: "issue-markdown", pullRequestId, issueId: issue.id };
    return context.json({ ok: true, document: document(ref, issue.body, true) });
  }
  const sourceOid = context.req.query("sourceOid");
  const filePath = context.req.query("path");
  if (/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(filePath ?? "")) {
    imageTextRequestCount += 1;
  }
  const ref = { kind: "repository-file", pullRequestId, sourceOid, path: filePath };
  if (!repositoryPathsAt(sourceOid).includes(filePath)) {
    return context.json({
      ok: true,
      document: missingRepositoryDocument(ref),
    });
  }
  return context.json({ ok: true, document: repositoryDocument(ref) });
});

app.on(["GET", "HEAD"], "/api/pull-requests/:id/markdown-asset", (context) => {
  const sourceOid = context.req.query("sourceOid");
  const filePath = context.req.query("path");
  if (filePath === "docs/order-lifecycle.svg") {
    context.header("content-type", "image/svg+xml; charset=utf-8");
    return context.req.method === "HEAD"
      ? context.body(null)
      : context.body(
          '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60"><rect width="240" height="60" rx="8" fill="#1f6feb"/><text x="120" y="36" text-anchor="middle" fill="white" font-family="sans-serif" font-size="16">Order lifecycle</text></svg>',
        );
  }
  if (filePath === "assets/too-large.png") {
    return context.json(
      { ok: false, error: { code: "FILE_TOO_LARGE", message: "too large" } },
      413,
    );
  }
  if (filePath === "assets/unsupported.png") {
    return context.json(
      { ok: false, error: { code: "UNSUPPORTED_IMAGE", message: "unsupported" } },
      415,
    );
  }
  if (
    !filePath ||
    !sourceOid ||
    filePath === "assets/broken.png" ||
    !repositoryPathsAt(sourceOid).includes(filePath) ||
    !/\.(?:png|jpe?g|gif|webp|avif)$/i.test(filePath)
  ) {
    return context.json(
      { ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "missing asset" } },
      404,
    );
  }
  context.header("content-type", "image/png");
  context.header("cache-control", "private, max-age=31536000, immutable");
  context.header("x-content-type-options", "nosniff");
  context.header("cross-origin-resource-policy", "same-origin");
  return context.req.method === "HEAD" ? context.body(null) : context.body(fixturePng);
});

app.get("/api/pull-requests/:id/github-attachment", (context) => {
  if (context.req.query("url") !== attachmentUrl) {
    return context.json(
      { ok: false, error: { code: "GITHUB_ERROR", message: "attachment unavailable" } },
      502,
    );
  }
  context.header("content-type", "image/svg+xml; charset=utf-8");
  context.header("cache-control", "private, max-age=31536000, immutable");
  context.header("x-content-type-options", "nosniff");
  context.header("content-disposition", "inline");
  context.header("cross-origin-resource-policy", "same-origin");
  context.header(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox",
  );
  return context.body(fixtureAttachmentSvg);
});

app.get("/api/branch-reviews/:id/github-attachment", (context) => {
  if (context.req.query("url") !== attachmentUrl) {
    return context.json(
      { ok: false, error: { code: "GITHUB_ERROR", message: "attachment unavailable" } },
      502,
    );
  }
  context.header("content-type", "image/svg+xml; charset=utf-8");
  context.header("cache-control", "private, max-age=31536000, immutable");
  context.header("x-content-type-options", "nosniff");
  context.header("content-disposition", "inline");
  context.header("cross-origin-resource-policy", "same-origin");
  context.header(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox",
  );
  return context.body(fixtureAttachmentSvg);
});

app.get("/api/pull-requests/:id/diff", (context) => {
  const oldOid = context.req.query("oldOid");
  const newOid = context.req.query("newOid");
  const oldPath = context.req.query("oldPath");
  const newPath = context.req.query("newPath");
  if (
    [oldPath, newPath].some((filePath) =>
      /\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(filePath ?? ""),
    )
  ) {
    imageTextRequestCount += 1;
  }
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

app.post("/api/fixture/walkthroughs/:walkthroughId/reset", (context) => {
  const walkthrough = activeWalkthroughs.find(
    (candidate) => candidate.id === context.req.param("walkthroughId"),
  );
  const original = originalWalkthroughs.find(
    (candidate) => candidate.id === context.req.param("walkthroughId"),
  );
  if (!walkthrough || !original) {
    return context.json(
      { ok: false, error: { code: "NOT_FOUND", message: "missing walkthrough" } },
      404,
    );
  }
  Object.assign(walkthrough, structuredClone(original));
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
  const comment = findFixtureComment(context.req.param("id"));
  if (!comment) {
    return context.json(
      { ok: false, error: { code: "COMMENT_NOT_FOUND", message: "missing comment" } },
      404,
    );
  }
  if (comment.branchReviewId) {
    if (context.req.query("branchReviewId") !== comment.branchReviewId) {
      return context.json({
        ok: true,
        placement: { outdated: true, range: null, path: null },
      });
    }
    if (
      (context.req.query("kind") === "repository-file" && !context.req.query("sourceOid")) ||
      (context.req.query("kind") === "commit" && !context.req.query("oid"))
    ) {
      return context.json(
        { ok: false, error: { code: "INVALID_INPUT", message: "missing placement source" } },
        400,
      );
    }
    if (comment.target.kind === "issue" && context.req.query("kind") !== "commit") {
      const matches =
        context.req.query("kind") === "issue-markdown" &&
        context.req.query("issueId") === comment.target.issueId;
      return context.json({
        ok: true,
        placement: matches
          ? branchCommentPlacement(comment.target)
          : { outdated: true, range: null, path: null },
      });
    }
    return context.json({ ok: true, placement: branchCommentPlacement(comment.target) });
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
  if (comment.target.kind === "issue") {
    const issue = pullRequestIssues.find((candidate) => candidate.id === comment.target.issueId);
    const destinationMatches =
      context.req.query("kind") === "commit" ||
      (context.req.query("kind") === "issue-markdown" &&
        context.req.query("issueId") === comment.target.issueId);
    const current =
      destinationMatches &&
      issue !== undefined &&
      (comment.target.startLine === null || issue.bodyHash === comment.target.sourceDocumentHash);
    return context.json({
      ok: true,
      placement: current
        ? {
            outdated: false,
            range:
              comment.target.startLine === null
                ? null
                : {
                    startLine: comment.target.startLine,
                    endLine: comment.target.endLine,
                  },
            path: `#${comment.target.issueNumber}`,
          }
        : { outdated: true, range: null, path: `#${comment.target.issueNumber}` },
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
  if (input.branchReviewId) {
    if (!branchReview || input.branchReviewId !== branchReview.id) {
      return context.json(
        {
          ok: false,
          error: { code: "BRANCH_REVIEW_NOT_FOUND", message: "missing branch review" },
        },
        404,
      );
    }
    const target = enrichBranchCommentTarget(input.target);
    if (!target) {
      return context.json(
        { ok: false, error: { code: "INVALID_INPUT", message: "missing comment target" } },
        400,
      );
    }
    const comment = {
      id,
      ref: `rvw://comment/${id}`,
      branchReviewId: branchReview.id,
      createdSourceOid: branchReview.sourceOid,
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
    branchCommentContexts.push({ comment, latestPlacement: branchCommentPlacement(target) });
    changeSequence += 1;
    return context.json({ ok: true, comment }, 201);
  }
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
  if (!target) {
    return context.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "missing comment target" } },
      400,
    );
  }
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
  const comment = findFixtureComment(context.req.param("id"));
  if (!comment) {
    return context.json(
      { ok: false, error: { code: "COMMENT_NOT_FOUND", message: "missing comment" } },
      404,
    );
  }
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
  const comment = findFixtureComment(context.req.param("id"));
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
  const comment = findFixtureComment(context.req.param("id"));
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
    const comment = findFixtureComment(context.req.param("id"));
    if (!comment) {
      return context.json(
        { ok: false, error: { code: "COMMENT_NOT_FOUND", message: "missing comment" } },
        404,
      );
    }
    comment.resolvedAt = action === "resolve" ? new Date().toISOString() : null;
    comment.updatedAt = new Date().toISOString();
    changeSequence += 1;
    return context.json({ ok: true, comment });
  });
}

app.delete("/api/comments/:id", (context) => {
  const index = comments.findIndex((item) => item.id === context.req.param("id"));
  const branchIndex = branchCommentContexts.findIndex(
    ({ comment }) => comment.id === context.req.param("id"),
  );
  if (index < 0 && branchIndex < 0) {
    return context.json(
      { ok: false, error: { code: "COMMENT_NOT_FOUND", message: "missing comment" } },
      404,
    );
  }
  const comment =
    index >= 0
      ? comments.splice(index, 1)[0]
      : branchCommentContexts.splice(branchIndex, 1)[0].comment;
  changeSequence += 1;
  return context.json({ ok: true, deleted: { id: comment.id, ref: comment.ref } });
});

const staticRoot = path.resolve("dist/web");
app.use("*", serveStatic({ root: staticRoot }));
const index = readFileSync(path.join(staticRoot, "index.html"), "utf8");
app.get("*", (context) => context.html(index));

serve({ fetch: app.fetch, hostname: host, port });
