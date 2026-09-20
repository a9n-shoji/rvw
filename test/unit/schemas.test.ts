import { describe, expect, it } from "vitest";
import {
  commentTargetSchema,
  resolveCodeReferencePlacementSchema,
  resolveCommentPlacementsSchema,
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

describe("resolveCommentPlacementsSchema", () => {
  it("accepts every comment in reviews larger than 500 threads", () => {
    const commentIds = Array.from(
      { length: 501 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    );
    expect(
      resolveCommentPlacementsSchema.safeParse({
        commentIds,
        destinations: [{ kind: "commit", oid: "a".repeat(40) }],
      }).success,
    ).toBe(true);
  });
});

describe("resolveCodeReferencePlacementSchema", () => {
  it("accepts an exact source reference and destination commit", () => {
    expect(
      resolveCodeReferencePlacementSchema.safeParse({
        sourceOid: "a".repeat(40),
        destinationOid: "b".repeat(40),
        reference: {
          id: "stable-line",
          label: "Stable line",
          path: "src/fixture.ts",
          startLine: 5,
          endLine: 5,
          description: null,
        },
      }).success,
    ).toBe(true);
  });
});
