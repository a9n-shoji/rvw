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
import {
  MAX_COMMENT_BODY_BYTES,
  MAX_STRUCTURE_PRIMARY_SPINE_NODES,
} from "../../src/shared/constants.js";

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
        originNodeId: "controller",
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
        presentation: {
          thesis: "  Follow the authorization decision.  ",
          startNodeId: "controller",
          primarySpine: {
            nodeIds: ["controller", "policy"],
            edgeIds: ["checks-policy"],
          },
          regions: [
            { label: "  Request boundary  ", nodeIds: ["controller"] },
            { label: "Policy", nodeIds: ["policy"] },
          ],
        },
      }),
    ).toMatchObject({
      originNodeId: "controller",
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
      presentation: {
        thesis: "Follow the authorization decision.",
        startNodeId: "controller",
        primarySpine: {
          nodeIds: ["controller", "policy"],
          edgeIds: ["checks-policy"],
        },
        regions: [{ label: "Request boundary" }, { label: "Policy" }],
      },
    });
  });

  it("rejects invalid Structure identity, origin, connectivity, endpoints, and SourceAnchor ranges", () => {
    const valid = {
      expectedUpdatedAt: "2026-08-30T00:00:00.000Z",
      sourceOid: "b".repeat(40),
      title: "Boundary",
      scope: "One bounded code relationship.",
      originNodeId: "entry",
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
      presentation: null,
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
        originNodeId: "missing",
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
        presentation: null,
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
        nodes: [...valid.nodes, { id: "detached", label: "Detached" }],
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

  it("validates Structure presentation references, spine adjacency, regions, and region order", () => {
    const valid = {
      expectedUpdatedAt: "2026-09-05T00:00:00.000Z",
      sourceOid: "c".repeat(40),
      title: "Presented boundary",
      scope: "One bounded relationship with authorial presentation.",
      originNodeId: "entry",
      nodes: [
        { id: "entry", label: "Entry", anchor: { path: "src/entry.ts" } },
        { id: "policy", label: "Policy" },
        { id: "store", label: "Store" },
      ],
      edges: [
        { id: "entry-policy", from: "entry", to: "policy", label: "checks", directed: true },
        {
          id: "entry-policy-parallel",
          from: "entry",
          to: "policy",
          label: "authorizes",
          directed: true,
        },
        {
          id: "policy-entry-reverse",
          from: "policy",
          to: "entry",
          label: "reports",
          directed: true,
        },
        { id: "store-policy", from: "store", to: "policy", label: "persists", directed: true },
      ],
      presentation: {
        thesis: "Read from the request boundary into the persisted result.",
        startNodeId: "entry",
        primarySpine: {
          nodeIds: ["entry", "policy", "store"],
          edgeIds: ["entry-policy", "store-policy"],
        },
        regions: [
          { label: "Input", nodeIds: ["entry"] },
          { label: "Decision", nodeIds: ["policy"] },
          { label: "Effect", nodeIds: ["store"] },
        ],
      },
    };
    expect(structureUpdateInputSchema.parse(valid).presentation).toMatchObject({
      startNodeId: "entry",
      primarySpine: {
        nodeIds: ["entry", "policy", "store"],
        edgeIds: ["entry-policy", "store-policy"],
      },
    });
    expect(
      structureUpdateInputSchema.parse({
        ...valid,
        presentation: {
          ...valid.presentation,
          primarySpine: {
            ...valid.presentation.primarySpine,
            edgeIds: ["policy-entry-reverse", "store-policy"],
          },
        },
      }).presentation,
    ).toMatchObject({
      primarySpine: { edgeIds: ["policy-entry-reverse", "store-policy"] },
    });
    expect(
      structureUpdateInputSchema.safeParse({ ...valid, presentation: undefined }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: { ...valid.presentation, thesis: "   " },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: { ...valid.presentation, startNodeId: "missing" },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: { ...valid.presentation, startNodeId: "policy" },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          primarySpine: { ...valid.presentation.primarySpine, edgeIds: ["entry-policy"] },
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          primarySpine: {
            ...valid.presentation.primarySpine,
            edgeIds: ["missing-edge", "store-policy"],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          primarySpine: {
            ...valid.presentation.primarySpine,
            edgeIds: ["store-policy", "entry-policy"],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: { ...valid.presentation, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [{ label: "Discontiguous", nodeIds: ["entry", "store"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [{ label: "Input", nodeIds: ["entry"], unexpected: true }],
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: { ...valid.presentation, thesis: ` ${"t".repeat(1_000)} ` },
      }).success,
    ).toBe(true);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: { ...valid.presentation, thesis: "t".repeat(1_001) },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          primarySpine: {
            ...valid.presentation.primarySpine,
            nodeIds: ["entry", "entry"],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          primarySpine: {
            nodeIds: ["entry", "store"],
            edgeIds: ["entry-policy"],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [
            { label: "First", nodeIds: ["entry", "policy"] },
            { label: "Second", nodeIds: ["policy"] },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [
            { label: "First", nodeIds: ["policy"] },
            { label: "Second", nodeIds: ["entry", "store"] },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [{ label: "Missing", nodeIds: ["missing"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          thesis: "Start from the hub and compare its peers.",
          startNodeId: "policy",
          primarySpine: null,
          regions: [{ label: "Policies", nodeIds: ["entry", "policy", "store"] }],
        },
      }).success,
    ).toBe(true);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          thesis: "This has no authored spatial structure.",
          startNodeId: "entry",
          primarySpine: null,
          regions: [],
        },
      }).success,
    ).toBe(false);
  });

  it("caps a Structure primary spine at twelve Nodes", () => {
    expect(MAX_STRUCTURE_PRIMARY_SPINE_NODES).toBe(12);
    const inputWithSpine = (nodeCount: number) => {
      const nodes = Array.from({ length: nodeCount }, (_, index) => ({
        id: `node-${index + 1}`,
        label: `Node ${index + 1}`,
        ...(index === 0 ? { anchor: { path: "src/entry.ts" } } : {}),
      }));
      const edges = Array.from({ length: nodeCount - 1 }, (_, index) => ({
        id: `edge-${index + 1}`,
        from: `node-${index + 1}`,
        to: `node-${index + 2}`,
        label: "leads to",
        directed: true,
      }));
      return {
        expectedUpdatedAt: "2026-09-05T00:00:00.000Z",
        sourceOid: "d".repeat(40),
        title: "Bounded reading spine",
        scope: "The first-grasp backbone through one bounded relationship space.",
        originNodeId: "node-1",
        nodes,
        edges,
        presentation: {
          thesis: "Grasp this compact backbone before exploring the remaining graph.",
          startNodeId: "node-1",
          primarySpine: {
            nodeIds: nodes.map(({ id }) => id),
            edgeIds: edges.map(({ id }) => id),
          },
          regions: [],
        },
      };
    };

    expect(structureUpdateInputSchema.safeParse(inputWithSpine(12)).success).toBe(true);
    expect(structureUpdateInputSchema.safeParse(inputWithSpine(13)).success).toBe(false);
  });
});
