import { describe, expect, it } from "vitest";
import { gitBackedQueryBelongsToPullRequest } from "../../src/web/git-backed-query.js";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const otherPullRequestId = "22222222-2222-4222-8222-222222222222";

describe("git-backed query invalidation", () => {
  it.each([
    ["tree", pullRequestId, "a".repeat(40)],
    ["changed-files", pullRequestId, "a".repeat(40), "b".repeat(40)],
    ["diff", pullRequestId, "a".repeat(40), "b".repeat(40)],
    ["search", pullRequestId, "b".repeat(40), "needle"],
    ["structure-reference-index", pullRequestId, "b".repeat(40), "fingerprint"],
    ["mermaid-reference-peek", pullRequestId, "b".repeat(40), "reference-id"],
    [
      "document",
      {
        kind: "repository-file",
        pullRequestId,
        sourceOid: "b".repeat(40),
        path: "src/fixture.ts",
      },
    ],
    [
      "comment-placements",
      "document",
      pullRequestId,
      [],
      {
        new: {
          kind: "repository-file",
          pullRequestId,
          sourceOid: "b".repeat(40),
          path: "src/fixture.ts",
        },
        old: null,
      },
    ],
    [
      "comment-placements",
      "sidebar",
      pullRequestId,
      "b".repeat(40),
      null,
      null,
      [
        [
          "comment-id",
          {
            kind: "document",
            documentKind: "repository-file",
            sourceOid: "b".repeat(40),
            path: "src/fixture.ts",
          },
        ],
      ],
    ],
  ])("matches %j", (...queryKey) => {
    expect(gitBackedQueryBelongsToPullRequest(queryKey, pullRequestId)).toBe(true);
  });

  it.each([
    ["tree", otherPullRequestId, "a".repeat(40)],
    [
      "document",
      {
        kind: "repository-file",
        pullRequestId: otherPullRequestId,
        sourceOid: "b".repeat(40),
        path: "src/fixture.ts",
      },
    ],
    [
      "document",
      {
        kind: "pull-request-markdown",
        pullRequestId,
      },
    ],
    ["comments", pullRequestId],
    ["structures", pullRequestId],
    ["walkthrough", pullRequestId, "walkthrough-id"],
    ["walkthrough-comment-placements", "walkthrough-id"],
    [
      "comment-placements",
      "document",
      pullRequestId,
      [],
      { new: { kind: "pull-request-markdown", pullRequestId }, old: null },
    ],
    [
      "comment-placements",
      "sidebar",
      pullRequestId,
      "b".repeat(40),
      1,
      1,
      [["comment-id", { kind: "walkthrough", walkthroughId: "walkthrough-id" }]],
    ],
  ])("does not match %j", (...queryKey) => {
    expect(gitBackedQueryBelongsToPullRequest(queryKey, pullRequestId)).toBe(false);
  });
});
