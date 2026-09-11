import { describe, expect, it } from "vitest";
import {
  commentCreateInputSchema,
  commentPostEditInputSchema,
  commentReplyInputSchema,
  commentWatchOptionsSchema,
  pullRequestSyncInputSchema,
  structurePublishInputSchema,
  structureUpdateInputSchema,
  walkthroughListOptionsSchema,
  walkthroughPublishInputSchema,
  walkthroughUpdateInputSchema,
} from "../../src/cli/schemas.js";
import {
  MAX_COMMENT_BODY_BYTES,
  MAX_STRUCTURE_PRIMARY_BACKBONE_EDGES,
  MAX_STRUCTURE_PRIMARY_BACKBONE_NODES,
} from "../../src/shared/constants.js";

describe("CLI input schemas", () => {
  it("normalizes Walkthrough list paging options", () => {
    expect(walkthroughListOptionsSchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(walkthroughListOptionsSchema.parse({ limit: "100", offset: "12" })).toEqual({
      limit: 100,
      offset: 12,
    });
  });

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
          primaryBackbone: {
            edgeIds: ["checks-policy"],
          },
          regions: [
            {
              id: "request-boundary",
              label: "  Request boundary  ",
              summary: "  Validates the request before authorization.  ",
              nodeIds: ["controller"],
            },
            {
              id: "policy",
              label: "Policy",
              summary: "Makes the authorization decision.",
              nodeIds: ["policy"],
            },
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
        primaryBackbone: {
          edgeIds: ["checks-policy"],
        },
        regions: [
          { id: "policy", label: "Policy", summary: "Makes the authorization decision." },
          {
            id: "request-boundary",
            label: "Request boundary",
            summary: "Validates the request before authorization.",
          },
        ],
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

  it("validates and normalizes a connected exact-Edge Structure backbone", () => {
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
        { id: "store-loop", from: "store", to: "store", label: "retries", directed: true },
      ],
      presentation: {
        thesis: "The policy hub connects the request to persistence.",
        startNodeId: "entry",
        primaryBackbone: {
          edgeIds: ["store-policy", "entry-policy-parallel", "entry-policy"],
        },
        regions: [
          {
            id: "input-effect",
            label: "Input and effect",
            summary: "Connects the request boundary to the persisted effect.",
            nodeIds: ["store", "entry"],
          },
          {
            id: "decision",
            label: "Decision",
            summary: "Makes the policy decision shared by input and persistence.",
            nodeIds: ["policy"],
          },
        ],
      },
    };
    expect(structureUpdateInputSchema.parse(valid).presentation).toMatchObject({
      startNodeId: "entry",
      primaryBackbone: {
        edgeIds: ["entry-policy", "entry-policy-parallel", "store-policy"],
      },
      regions: [
        {
          id: "decision",
          label: "Decision",
          summary: "Makes the policy decision shared by input and persistence.",
          nodeIds: ["policy"],
        },
        {
          id: "input-effect",
          label: "Input and effect",
          summary: "Connects the request boundary to the persisted effect.",
          nodeIds: ["entry", "store"],
        },
      ],
    });
    // Direction, parallel multiplicity, and region-member order do not define traversal order.
    expect(
      structureUpdateInputSchema.parse({
        ...valid,
        presentation: {
          ...valid.presentation,
          primaryBackbone: {
            edgeIds: ["store-policy", "policy-entry-reverse", "entry-policy-parallel"],
          },
        },
      }).presentation,
    ).toMatchObject({
      primaryBackbone: {
        edgeIds: ["entry-policy-parallel", "policy-entry-reverse", "store-policy"],
      },
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
        presentation: {
          ...valid.presentation,
          primaryBackbone: { edgeIds: ["entry-policy", "store-loop"] },
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: { ...valid.presentation, startNodeId: "missing" },
      }).success,
    ).toBe(false);
    // Any selected endpoint may be the authorial start, independent of Edge direction.
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: { ...valid.presentation, startNodeId: "policy" },
      }).success,
    ).toBe(true);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          primaryBackbone: { edgeIds: ["entry-policy", "entry-policy"] },
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          primaryBackbone: { edgeIds: ["entry-policy", "missing-edge"] },
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          startNodeId: "store",
          primaryBackbone: { edgeIds: ["entry-policy"] },
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: { ...valid.presentation, unexpected: true },
      }).success,
    ).toBe(false);
    // Regions and their Node memberships are unordered sets and need not be intervals of the backbone.
    expect(
      structureUpdateInputSchema.parse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [...valid.presentation.regions].reverse(),
        },
      }).presentation,
    ).toEqual(structureUpdateInputSchema.parse(valid).presentation);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [
            {
              id: "related-boundaries",
              label: "Related boundaries",
              summary: "Keeps the entry and effect together around their decision.",
              nodeIds: ["store", "entry"],
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [
            {
              id: "input",
              label: "Input",
              summary: "Introduces the request.",
              nodeIds: ["entry"],
              unexpected: true,
            },
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
            {
              label: "Obsolete branch-v5 Region",
              nodeIds: ["entry"],
            },
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
            {
              id: "missing-summary",
              label: "Missing summary",
              nodeIds: ["entry"],
            },
          ],
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
    // The obsolete v5 branch field is rejected instead of silently receiving new semantics.
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          thesis: valid.presentation.thesis,
          startNodeId: valid.presentation.startNodeId,
          primarySpine: { nodeIds: ["entry", "policy"], edgeIds: ["entry-policy"] },
          regions: valid.presentation.regions,
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [
            {
              id: "first",
              label: "First",
              summary: "Contains the first responsibility.",
              nodeIds: ["entry", "policy"],
            },
            {
              id: "second",
              label: "Second",
              summary: "Contains the second responsibility.",
              nodeIds: ["policy"],
            },
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
            {
              id: "first",
              label: "First",
              summary: "Contains the decision responsibility.",
              nodeIds: ["policy"],
            },
            {
              id: "second",
              label: "Second",
              summary: "Contains the entry and persistence responsibilities.",
              nodeIds: ["entry", "store"],
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [
            {
              id: "missing",
              label: "Missing",
              summary: "References a missing responsibility.",
              nodeIds: ["missing"],
            },
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
            valid.presentation.regions[0]!,
            { ...valid.presentation.regions[1]!, id: valid.presentation.regions[0]!.id },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [{ ...valid.presentation.regions[0], summary: "   " }],
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          ...valid.presentation,
          regions: [{ ...valid.presentation.regions[0], summary: "s".repeat(501) }],
        },
      }).success,
    ).toBe(false);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          thesis: "Start from the hub and compare its peers.",
          startNodeId: "policy",
          primaryBackbone: null,
          regions: [
            {
              id: "policies",
              label: "Policies",
              summary: "Shows how the hub relates the entry to persistence.",
              nodeIds: ["entry", "policy", "store"],
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      structureUpdateInputSchema.safeParse({
        ...valid,
        presentation: {
          thesis: "Begin at the policy hub without inventing a path or grouping.",
          startNodeId: "policy",
          primaryBackbone: null,
          regions: [],
        },
      }).success,
    ).toBe(true);
  });

  it("bounds a Structure primary backbone by derived Nodes and exact Edges", () => {
    expect(MAX_STRUCTURE_PRIMARY_BACKBONE_NODES).toBe(12);
    expect(MAX_STRUCTURE_PRIMARY_BACKBONE_EDGES).toBe(16);
    const inputWithBackbone = (nodeCount: number) => {
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
        title: "Bounded explanation backbone",
        scope: "The first-grasp backbone through one bounded relationship space.",
        originNodeId: "node-1",
        nodes,
        edges,
        presentation: {
          thesis: "Grasp this compact backbone before exploring the remaining graph.",
          startNodeId: "node-1",
          primaryBackbone: {
            edgeIds: edges.map(({ id }) => id),
          },
          regions: [],
        },
      };
    };

    expect(structureUpdateInputSchema.safeParse(inputWithBackbone(12)).success).toBe(true);
    expect(structureUpdateInputSchema.safeParse(inputWithBackbone(13)).success).toBe(false);

    const twoNodes = inputWithBackbone(2);
    const parallelEdges = Array.from({ length: 17 }, (_, index) => ({
      id: `parallel-${String(index + 1).padStart(2, "0")}`,
      from: "node-1",
      to: "node-2",
      label: `relation ${index + 1}`,
      directed: true,
    }));
    expect(
      structureUpdateInputSchema.safeParse({
        ...twoNodes,
        edges: parallelEdges.slice(0, 16),
        presentation: {
          ...twoNodes.presentation,
          primaryBackbone: { edgeIds: parallelEdges.slice(0, 16).map(({ id }) => id) },
        },
      }).success,
    ).toBe(true);
    expect(
      structureUpdateInputSchema.safeParse({
        ...twoNodes,
        edges: parallelEdges,
        presentation: {
          ...twoNodes.presentation,
          primaryBackbone: { edgeIds: parallelEdges.map(({ id }) => id) },
        },
      }).success,
    ).toBe(false);
  });
});
