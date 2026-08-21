import { describe, expect, it } from "vitest";
import type { BranchCommentReviewContext } from "../../src/application/rvw-service.js";
import { formatCommentGetOutput } from "../../src/cli/comment-protocol.js";

describe("Branch Review comment protocol", () => {
  it("returns an explicit Branch context and complete Issue evidence", () => {
    const sourceOid = "a".repeat(40);
    const createdAt = "2026-08-20T00:00:00.000Z";
    const issue = {
      id: "22222222-2222-4222-8222-222222222222",
      host: "github.com" as const,
      owner: "acme",
      repository: "review-repo",
      canonicalName: "acme/review-repo",
      number: 142,
      url: "https://github.com/acme/review-repo/issues/142",
      title: "Current requirement",
      body: "Changed requirement",
      state: "OPEN" as const,
      updatedAt: createdAt,
      bodyHash: "b".repeat(64),
      fetchedAt: createdAt,
      syncError: null,
      stale: false,
    };
    const context: BranchCommentReviewContext = {
      context: { kind: "branch", repository: "acme/review-repo" },
      branchReview: {
        id: "11111111-1111-4111-8111-111111111111",
        host: "github.com",
        owner: "acme",
        repository: "review-repo",
        canonicalName: "acme/review-repo",
        localRepositoryPath: "/repo",
        gitCommonDir: "/repo/.git",
        defaultBranchName: "trunk",
        sourceOid,
        githubFetchedAt: createdAt,
        sourceSyncError: null,
        createdAt,
        updatedAt: createdAt,
      },
      comment: {
        id: "33333333-3333-4333-8333-333333333333",
        ref: "rvw://comment/33333333-3333-4333-8333-333333333333",
        branchReviewId: "11111111-1111-4111-8111-111111111111",
        createdSourceOid: sourceOid,
        resolvedAt: null,
        createdAt,
        updatedAt: createdAt,
        target: {
          kind: "issue",
          issueId: issue.id,
          issueUrl: issue.url,
          issueNumber: issue.number,
          issueTitle: issue.title,
          sourceDocumentHash: "c".repeat(64),
          quotedText: "Original requirement",
          startLine: 1,
          endLine: 1,
        },
        posts: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            commentId: "33333333-3333-4333-8333-333333333333",
            body: "Please compare the requirement.",
            relatedCommitOid: null,
            references: [],
            authorLabel: "Reviewer",
            isRoot: true,
            createdAt,
            updatedAt: createdAt,
          },
        ],
      },
      latestPlacement: { outdated: true, range: null, path: "#142" },
      exactSource: null,
      walkthrough: null,
      issue,
      githubState: { liveCheckedAt: null, staleAgainstGitHub: null, live: null },
    };

    expect(formatCommentGetOutput(context)).toMatchObject({
      ok: true,
      context: { kind: "branch", repository: "acme/review-repo" },
      branchReview: {
        repository: "acme/review-repo",
        defaultBranchName: "trunk",
        currentSourceOid: sourceOid,
      },
      comment: {
        createdSourceOid: sourceOid,
        resolved: false,
        target: {
          kind: "issue",
          sourceDocumentHash: "c".repeat(64),
          quotedText: "Original requirement",
        },
      },
      currentSourceOid: sourceOid,
      latestPlacement: { outdated: true, path: "#142" },
      issue: { bodyHash: "b".repeat(64), body: "Changed requirement" },
    });
  });
});
