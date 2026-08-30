import { describe, expect, it } from "vitest";
import {
  commentCreateInputSchema,
  commentPostEditInputSchema,
  commentReplyInputSchema,
  commentWatchOptionsSchema,
  pullRequestSyncInputSchema,
  structurePublishInputSchema,
  structureUpdateInputSchema,
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

  it("accepts typed code references on comment posts and requires their exact commit", () => {
    const reference = {
      id: "handler",
      label: "RequestHandler.execute",
      path: "src/request-handler.ts",
      startLine: 10,
      endLine: 24,
      description: "Application orchestration boundary",
    };
    const relatedCommitOid = "a".repeat(40);

    expect(
      commentCreateInputSchema.parse({
        pullRequest: "https://github.com/acme/review-repo/pull/7",
        target: { kind: "pull-request" },
        body: "Open [the handler](rvw-ref:handler).",
        relatedCommitOid,
        references: [reference],
      }),
    ).toMatchObject({ relatedCommitOid, references: [{ id: "handler" }] });
    expect(
      commentReplyInputSchema.parse({
        body: "The fix is in [the handler](rvw-ref:handler).",
        relatedCommitOid,
        references: [reference],
      }),
    ).toMatchObject({ relatedCommitOid, references: [{ id: "handler" }] });
    expect(
      commentPostEditInputSchema.parse({
        body: "Re-check [the handler](rvw-ref:handler).",
        relatedCommitOid,
        references: [reference],
      }),
    ).toMatchObject({ relatedCommitOid, references: [{ id: "handler" }] });

    for (const schema of [commentCreateInputSchema, commentReplyInputSchema]) {
      const base =
        schema === commentCreateInputSchema
          ? {
              pullRequest: "https://github.com/acme/review-repo/pull/7",
              target: { kind: "pull-request" as const },
            }
          : {};
      expect(
        schema.safeParse({
          ...base,
          body: "Open [the handler](rvw-ref:handler).",
          references: [reference],
        }).success,
      ).toBe(false);
    }
    expect(
      commentPostEditInputSchema.safeParse({
        body: "Open [the handler](rvw-ref:handler).",
        references: [reference],
      }).success,
    ).toBe(true);
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

  it("accepts code references on sync replies because the synchronized head is implicit", () => {
    expect(
      pullRequestSyncInputSchema.parse({
        pullRequest: "https://github.com/acme/review-repo/pull/7",
        commentUpdates: [
          {
            commentRef: "rvw://comment/11111111-1111-4111-8111-111111111111",
            reply: "Fixed in [the source](rvw-ref:source).",
            resolve: true,
            references: [
              {
                id: "source",
                label: "Updated source",
                path: "src.txt",
                startLine: 1,
                endLine: 2,
                description: null,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ commentUpdates: [{ references: [{ id: "source" }] }] });
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

  it("normalizes a Structure graph and requires explicit directed edges", () => {
    expect(
      structurePublishInputSchema.parse({
        idempotencyKey: "structure-publish-auth-boundary",
        pullRequest: "https://github.com/acme/review-repo/pull/7",
        sourceOid: "a".repeat(40),
        title: "Authorization boundary",
        scope: "Code relationships around authorization. Analytics is excluded.",
        initialFocus: "controller",
        nodes: [
          {
            id: "controller",
            label: "JobsController",
            notation: "class",
            anchor: { path: "src/controller.ts", startLine: 2, endLine: 5 },
          },
          { id: "policy", label: "JobPolicy" },
        ],
        edges: [
          {
            id: "checks-policy",
            from: "controller",
            to: "policy",
            label: "checks",
            directed: true,
          },
        ],
      }),
    ).toMatchObject({
      initialFocus: "controller",
      nodes: [
        {
          description: null,
          kind: null,
          notation: "class",
          anchor: { startLine: 2, endLine: 5 },
        },
        { notation: "plain", anchor: null },
      ],
      edges: [{ directed: true, anchors: [] }],
    });
  });

  it("rejects invalid Structure identity, endpoints, focus, and SourceAnchor ranges", () => {
    const valid = {
      expectedUpdatedAt: "2026-08-30T00:00:00.000Z",
      sourceOid: "b".repeat(40),
      title: "Boundary",
      scope: "One bounded code relationship.",
      nodes: [
        {
          id: "entry",
          label: "Entry",
          anchor: { path: "src/entry.ts", startLine: 1, endLine: 1 },
        },
      ],
      edges: [] as Array<{
        id: string;
        from: string;
        to: string;
        label: string;
        directed?: boolean;
      }>,
    };
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        nodes: [...valid.nodes, { id: "entry", label: "Duplicate" }],
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        initialFocus: "missing",
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        edges: [{ id: "bad", from: "entry", to: "missing", label: "uses" }],
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        nodes: [{ id: "a\0b", label: "Control character" }],
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        nodes: [{ id: " leading-space", label: "Whitespace" }],
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        nodes: [
          {
            id: "entry",
            label: "Entry",
            anchor: { path: "src/entry.ts", startLine: 3 },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        expectedUpdatedAt: undefined,
      }).success,
    ).toBe(false);
    expect(
      structurePublishInputSchema.safeParse({
        pullRequest: "https://github.com/acme/review-repo/pull/7",
        sourceOid: valid.sourceOid,
        title: valid.title,
        scope: valid.scope,
        nodes: valid.nodes,
        edges: valid.edges,
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        nodes: [{ id: "entry", label: "Entry", anchor: null }],
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        nodes: [{ id: "entry", label: "Entry", notation: "server" }],
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        edges: Array.from({ length: 20 }, (_, index) => ({
          id: `edge-${index}`,
          from: "entry",
          to: "entry",
          label: `Relation ${index}`,
          directed: false,
          anchors: Array.from({ length: 20 }, () => ({ path: "src/entry.ts" })),
        })),
      }).success,
    ).toBe(false);
  });
});
