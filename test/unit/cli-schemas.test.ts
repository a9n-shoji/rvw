import { describe, expect, it } from "vitest";
import {
  commentCreateInputSchema,
  commentPostEditInputSchema,
  commentReplyInputSchema,
  commentWatchOptionsSchema,
  pullRequestSyncInputSchema,
  walkthroughPublishInputSchema,
  walkthroughUpdateInputSchema,
} from "../../src/cli/schemas.js";
import { MAX_COMMENT_BODY_BYTES } from "../../src/shared/constants.js";

describe("CLI input schemas", () => {
  it("accepts an exact repository comment target and normalizes omitted lines", () => {
    expect(
      commentCreateInputSchema.parse({
        pullRequest: "https://github.com/acme/review-repo/pull/7",
        target: {
          kind: "document",
          documentKind: "repository-file",
          sourceOid: "a".repeat(40),
          path: "src/request-handler.ts",
        },
        body: "Preserve the failure result.",
        authorLabel: "Codex",
      }),
    ).toMatchObject({
      target: { startLine: null, endLine: null },
      authorLabel: "Codex",
    });
  });

  it("rejects malformed comment creation ranges and persisted target fields", () => {
    const base = {
      pullRequest: "https://github.com/acme/review-repo/pull/7",
      body: "Review finding",
    };
    expect(
      commentCreateInputSchema.safeParse({
        ...base,
        target: {
          kind: "document",
          documentKind: "repository-file",
          sourceOid: "a".repeat(40),
          path: "src/example.ts",
          startLine: 12,
        },
      }).success,
    ).toBe(false);
    expect(
      commentCreateInputSchema.safeParse({
        ...base,
        target: {
          kind: "document",
          documentKind: "pull-request-markdown",
          startLine: 5,
          endLine: 4,
        },
      }).success,
    ).toBe(false);
    expect(
      commentCreateInputSchema.safeParse({
        ...base,
        target: {
          kind: "document",
          documentKind: "pull-request-markdown",
          sourceDocumentHash: "caller-controlled",
        },
      }).success,
    ).toBe(false);
    expect(
      commentCreateInputSchema.safeParse({
        ...base,
        target: { kind: "pull-request" },
        body: "   ",
      }).success,
    ).toBe(false);
  });

  it("accepts the pull request sync protocol shape", () => {
    expect(
      pullRequestSyncInputSchema.parse({
        pullRequest: "https://github.com/acme/review-repo/pull/7",
        commentUpdates: [
          {
            commentRef: "rvw://comment/11111111-1111-4111-8111-111111111111",
            reply: "Fixed in this commit.",
            resolve: true,
            idempotencyKey: "watch-task:batch-1:comment-1",
          },
        ],
      }),
    ).toMatchObject({ pullRequest: "https://github.com/acme/review-repo/pull/7" });
  });

  it("rejects malformed protocol input", () => {
    expect(
      pullRequestSyncInputSchema.safeParse({ pullRequest: "", commentUpdates: [] }).success,
    ).toBe(false);
    expect(commentReplyInputSchema.safeParse({ body: "" }).success).toBe(false);
    expect(
      commentPostEditInputSchema.parse({
        body: "✅ 対応しました",
        relatedCommitOid: "a".repeat(40),
      }),
    ).toEqual({ body: "✅ 対応しました", relatedCommitOid: "a".repeat(40) });
    expect(
      commentPostEditInputSchema.safeParse({ body: "Result", idempotencyKey: "not-accepted" })
        .success,
    ).toBe(false);
    expect(
      commentReplyInputSchema.safeParse({ body: "Reply", idempotencyKey: "x".repeat(201) }).success,
    ).toBe(false);
    expect(commentWatchOptionsSchema.parse({ jsonSeq: true, once: true })).toMatchObject({
      interval: 10,
      limit: 100,
    });
  });

  it("applies the UTF-8 byte limit to batch-sync replies", () => {
    const result = pullRequestSyncInputSchema.safeParse({
      pullRequest: "https://github.com/acme/review-repo/pull/7",
      commentUpdates: [
        {
          commentRef: "rvw://comment/11111111-1111-4111-8111-111111111111",
          reply: "あ".repeat(Math.floor(MAX_COMMENT_BODY_BYTES / 3) + 1),
          resolve: false,
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("65536 bytes（64 KiB）");
    }
  });

  it("accepts a commit-fixed walkthrough with typed code references", () => {
    expect(
      walkthroughPublishInputSchema.parse({
        pullRequest: "https://github.com/acme/review-repo/pull/7",
        sourceOid: "a".repeat(40),
        title: "Request flow",
        body: "Open [the handler](rvw-ref:handler).",
        diagramBindings: { Handler: "handler" },
        references: [
          {
            id: "handler",
            label: "RequestHandler.execute",
            path: "src/request-handler.ts",
            startLine: 10,
            endLine: 24,
            description: null,
          },
        ],
      }),
    ).toMatchObject({ references: [{ id: "handler", startLine: 10, endLine: 24 }] });
  });

  it("accepts a file-level walkthrough reference and normalizes omitted lines", () => {
    expect(
      walkthroughPublishInputSchema.parse({
        pullRequest: "https://github.com/acme/review-repo/pull/7",
        sourceOid: "a".repeat(40),
        title: "Composition",
        body: "Open [the composition root](rvw-ref:composition).",
        references: [
          {
            id: "composition",
            label: "Application composition root",
            path: "src/application.ts",
            description: null,
          },
        ],
      }),
    ).toMatchObject({
      references: [{ id: "composition", startLine: null, endLine: null }],
    });
  });

  it("rejects incomplete or reversed walkthrough line ranges", () => {
    const input = {
      sourceOid: "b".repeat(40),
      title: "Broken range",
      body: "Open [the handler](rvw-ref:handler).",
      references: [
        {
          id: "handler",
          label: "RequestHandler.execute",
          path: "src/request-handler.ts",
          startLine: 12,
          endLine: 28,
          description: null,
        },
      ],
    };
    expect(
      walkthroughUpdateInputSchema.safeParse({
        ...input,
        references: [{ ...input.references[0], endLine: undefined }],
      }).success,
    ).toBe(false);
    expect(
      walkthroughUpdateInputSchema.safeParse({
        ...input,
        references: [{ ...input.references[0], startLine: 29 }],
      }).success,
    ).toBe(false);
  });

  it("accepts a full in-place walkthrough replacement without a pull request selector", () => {
    expect(
      walkthroughUpdateInputSchema.parse({
        sourceOid: "b".repeat(40),
        title: "Improved request flow",
        body: "Open [the handler](rvw-ref:handler).",
        references: [
          {
            id: "handler",
            label: "RequestHandler.execute",
            path: "src/request-handler.ts",
            startLine: 12,
            endLine: 28,
            description: "Expanded after reviewer feedback",
          },
        ],
      }),
    ).toMatchObject({ title: "Improved request flow", references: [{ id: "handler" }] });
  });
});
