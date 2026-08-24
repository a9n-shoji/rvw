import { describe, expect, it } from "vitest";
import {
  commentTargetSchema,
  createCommentSchema,
  viewerReleaseSchema,
} from "../../src/server/schemas.js";

describe("commentTargetSchema", () => {
  it.each([
    { kind: "pull-request" },
    {
      kind: "walkthrough",
      walkthroughId: "70000000-0000-4000-8000-000000000001",
    },
    {
      kind: "document",
      documentKind: "pull-request-markdown",
      startLine: 1,
      endLine: 1,
    },
    {
      kind: "document",
      documentKind: "repository-file",
      sourceOid: "a".repeat(40),
      path: "src/fixture.ts",
      startLine: 1,
      endLine: 1,
    },
  ])("accepts $kind $documentKind targets", (target) => {
    expect(commentTargetSchema.safeParse(target).success).toBe(true);
  });
});

describe("createCommentSchema", () => {
  const pullRequestId = "11111111-1111-4111-8111-111111111111";
  const repositoryReviewId = "22222222-2222-4222-8222-222222222222";

  it.each([
    { pullRequestId, target: { kind: "pull-request" }, body: "PR finding" },
    { repositoryReviewId, target: { kind: "repository" }, body: "Repository finding" },
    {
      repositoryReviewId,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: "a".repeat(40),
        path: "src/fixture.ts",
        startLine: null,
        endLine: null,
      },
      body: "Repository code finding",
    },
  ])("accepts matching review and target kinds", (input) => {
    expect(createCommentSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    { repositoryReviewId, target: { kind: "pull-request" }, body: "invalid" },
    { pullRequestId, target: { kind: "repository" }, body: "invalid" },
    {
      repositoryReviewId,
      target: {
        kind: "document",
        documentKind: "pull-request-markdown",
        startLine: null,
        endLine: null,
      },
      body: "invalid",
    },
  ])("rejects mismatched review and target kinds", (input) => {
    expect(createCommentSchema.safeParse(input).success).toBe(false);
  });
});

describe("viewerReleaseSchema", () => {
  it("accepts UUID viewer IDs and rejects arbitrary values", () => {
    expect(
      viewerReleaseSchema.safeParse({
        viewerId: "44444444-4444-4444-8444-444444444444",
      }).success,
    ).toBe(true);
    expect(viewerReleaseSchema.safeParse({ viewerId: "not-a-viewer" }).success).toBe(false);
  });
});
