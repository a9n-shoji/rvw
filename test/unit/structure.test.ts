import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import {
  projectStructure,
  projectTopologyStructure,
  simpleStructureTopology,
  STRUCTURE_REGION_PADDING_BOTTOM,
  STRUCTURE_REGION_PADDING_TOP,
  STRUCTURE_REGION_PADDING_X,
  structureAuthoringWarnings,
} from "../../src/domain/structure-projection.js";
import { formatStructureUri, parseStructureUri } from "../../src/domain/structure-uri.js";
import {
  deriveLocalStructureGraph,
  deriveLocalStructureLayout,
  initialStructureLayout,
  reconcileDerivedLocalStructureLayout,
  reconcileStructureLayout,
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
  STRUCTURE_MAX_EDGE_LANE_OFFSET,
  structureEdgeRouteOffsets,
  structureNeighborhood,
  visibleStructureGraph,
} from "../../src/web/structure-graph.js";
import { createContractStructures } from "../fixtures/contract/contract-structures.mjs";

function expectNoNodeOverlap(positions: Readonly<Record<string, { x: number; y: number }>>): void {
  const entries = Object.entries(positions);
  for (const [index, [leftId, left]] of entries.entries()) {
    for (const [rightId, right] of entries.slice(index + 1)) {
      const overlap = !(
        left.x + STRUCTURE_NODE_WIDTH <= right.x ||
        right.x + STRUCTURE_NODE_WIDTH <= left.x ||
        left.y + STRUCTURE_NODE_HEIGHT <= right.y ||
        right.y + STRUCTURE_NODE_HEIGHT <= left.y
      );
      expect(overlap, `${leftId} overlaps ${rightId}`).toBe(false);
    }
  }
}

function structureLayoutExtent(positions: Readonly<Record<string, { x: number; y: number }>>): {
  width: number;
  height: number;
} {
  const points = Object.values(positions);
  return {
    width:
      Math.max(...points.map(({ x }) => x + STRUCTURE_NODE_WIDTH)) -
      Math.min(...points.map(({ x }) => x)),
    height:
      Math.max(...points.map(({ y }) => y + STRUCTURE_NODE_HEIGHT)) -
      Math.min(...points.map(({ y }) => y)),
  };
}

function presentationBoxesOverlap(
  left: { left: number; top: number; right: number; bottom: number },
  right: { left: number; top: number; right: number; bottom: number },
): boolean {
  return !(
    left.right <= right.left ||
    right.right <= left.left ||
    left.bottom <= right.top ||
    right.bottom <= left.top
  );
}

function structureWithHub(): Structure {
  const nodes = Array.from({ length: 15 }, (_, index) => ({
    id: index === 0 ? "hub" : `node-${String(index).padStart(2, "0")}`,
    label: index === 0 ? "Hub" : `Node ${index}`,
    description: index % 2 === 0 ? "semantic text" : null,
    kind: index % 3 === 0 ? "opaque-kind" : null,
    notation: "plain" as const,
    anchor: null,
  }));
  return {
    id: "70000000-0000-4000-8000-000000000001",
    ref: "rvw://structure/70000000-0000-4000-8000-000000000001",
    pullRequestId: "pr-1",
    sourceOid: "a".repeat(40),
    title: "Hub relationships",
    scope: "A bounded test graph.",
    originNodeId: "hub",
    presentation: null,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${String(14 - index).padStart(2, "0")}`,
      from: "hub",
      to: node.id,
      label: index % 2 === 0 ? "calls" : "contains important words",
      directed: true,
      anchors: [],
    })),
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function structureWithPresentation(): Structure {
  const node = (id: string, label: string) => ({
    id,
    label,
    description: null,
    kind: null,
    notation: "plain" as const,
    anchor: null,
  });
  return {
    id: "70000000-0000-4000-8000-000000000091",
    ref: "rvw://structure/70000000-0000-4000-8000-000000000091",
    pullRequestId: "pr-1",
    sourceOid: "9".repeat(40),
    title: "Presented behavior",
    scope: "A graph with an authored spatial presentation.",
    originNodeId: "origin",
    presentation: {
      thesis: "Requests move through one observable backbone while details remain explorable.",
      startNodeId: "receive",
      primaryBackbone: {
        edgeIds: ["receive-decide", "decide-respond"],
      },
      regions: [
        {
          id: "input",
          label: "Input",
          summary: "Request ingress responsibilities.",
          nodeIds: ["receive", "input-detail"],
        },
        {
          id: "policy",
          label: "Policy",
          summary: "Decision policy responsibilities.",
          nodeIds: ["policy-detail"],
        },
        {
          id: "output",
          label: "Output",
          summary: "Response construction responsibilities.",
          nodeIds: ["respond", "output-detail"],
        },
      ],
    },
    nodes: [
      node("origin", "Factual origin"),
      node("receive", "Receive"),
      node("decide", "Decide"),
      node("respond", "Respond"),
      node("input-detail", "Input detail"),
      node("policy-detail", "Policy detail"),
      node("output-detail", "Output detail"),
      node("related-detail", "Related detail"),
      node("disconnected", "Disconnected detail"),
    ],
    edges: [
      {
        id: "origin-receive",
        from: "origin",
        to: "receive",
        label: "enters",
        directed: true,
        anchors: [],
      },
      {
        id: "receive-decide",
        from: "receive",
        to: "decide",
        label: "validates",
        directed: true,
        anchors: [],
      },
      {
        id: "decide-respond",
        from: "decide",
        to: "respond",
        label: "produces",
        directed: true,
        anchors: [],
      },
      {
        id: "receive-input-detail",
        from: "receive",
        to: "input-detail",
        label: "parses",
        directed: true,
        anchors: [],
      },
      {
        id: "decide-policy-detail",
        from: "decide",
        to: "policy-detail",
        label: "consults",
        directed: true,
        anchors: [],
      },
      {
        id: "respond-output-detail",
        from: "respond",
        to: "output-detail",
        label: "formats",
        directed: true,
        anchors: [],
      },
      {
        id: "output-related-detail",
        from: "output-detail",
        to: "related-detail",
        label: "records",
        directed: true,
        anchors: [],
      },
    ],
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}

function terminalHubStructure(): Structure {
  const ids = [
    "source",
    "root",
    "handler",
    "loop",
    "command",
    "coordinator",
    "initialize",
    "mutate",
    "read",
    "validate",
    "publish",
    "inspect",
    "hub",
  ];
  const link = (from: string, to: string) => ({
    id: `${from}-${to}`,
    from,
    to,
    label: `${from} to ${to}`,
    directed: true,
    anchors: [],
  });
  return {
    ...structureWithHub(),
    originNodeId: "hub",
    nodes: ids.map((id) => ({
      id,
      label: id,
      description: `${id} responsibility`,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    })),
    edges: [
      link("source", "root"),
      link("root", "handler"),
      link("root", "loop"),
      link("root", "command"),
      link("root", "coordinator"),
      link("handler", "initialize"),
      link("handler", "read"),
      link("loop", "mutate"),
      link("loop", "read"),
      link("loop", "validate"),
      link("command", "publish"),
      link("command", "inspect"),
      link("coordinator", "validate"),
      link("initialize", "hub"),
      link("mutate", "hub"),
      link("read", "hub"),
      link("validate", "hub"),
      link("publish", "hub"),
      link("inspect", "hub"),
    ],
  };
}

function directedStructure(
  originNodeId: string,
  nodeIds: readonly string[],
  links: readonly (readonly [from: string, to: string])[],
): Structure {
  return {
    ...structureWithHub(),
    originNodeId,
    nodes: nodeIds.map((id) => ({
      id,
      label: id,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    })),
    edges: links.map(([from, to], index) => ({
      id: `edge-${index}`,
      from,
      to,
      label: "calls",
      directed: true,
      anchors: [],
    })),
  };
}

function partiallyGroupedChain(
  nodeCount: number,
  regions: readonly { id: string; nodeIndexes: readonly number[] }[],
): Structure {
  const nodeIds = Array.from(
    { length: nodeCount },
    (_, index) => `node-${String(index).padStart(2, "0")}`,
  );
  const structure = directedStructure(
    nodeIds[0]!,
    nodeIds,
    nodeIds.slice(1).map((nodeId, index) => [nodeIds[index]!, nodeId]),
  );
  structure.presentation = {
    thesis: "Authored Regions expose a bounded factual Context chain.",
    startNodeId: nodeIds[0]!,
    primaryBackbone: {
      edgeIds: structure.edges.slice(0, Math.min(11, structure.edges.length)).map(({ id }) => id),
    },
    regions: regions.map(({ id, nodeIndexes }) => ({
      id,
      label: id,
      summary: `Authored ${id} comprehension chunk.`,
      nodeIds: nodeIndexes.map((index) => nodeIds[index]!),
    })),
  };
  return structure;
}

function fullStackPresentedStructure(): Structure {
  const edgeSpecs = [
    ["detail-route-authenticates", "order-detail-route", "detail-actor-auth"],
    ["detail-route-validates-id", "order-detail-route", "detail-params"],
    ["detail-route-executes-query", "order-detail-route", "get-order-query"],
    ["detail-auth-scopes-query", "detail-actor-auth", "get-order-query"],
    ["detail-params-supply-query", "detail-params", "get-order-query"],
    ["detail-query-loads-read-model", "get-order-query", "order-read-repository"],
    ["detail-repository-queries-view", "order-read-repository", "orders-read-model"],
    ["detail-query-presents-result", "get-order-query", "order-response-presenter"],
    ["detail-query-maps-not-found", "get-order-query", "order-not-found"],
    ["detail-presenter-returns-contract", "order-response-presenter", "order-detail-contract"],
    ["detail-not-found-returns-contract", "order-not-found", "order-detail-contract"],
    ["detail-response-enters-client", "order-detail-contract", "order-api-client"],
    ["detail-client-provides-hook-result", "order-api-client", "order-detail-query-hook"],
    ["detail-hook-uses-cache", "order-detail-query-hook", "order-query-cache"],
    ["detail-hook-provides-page-state", "order-detail-query-hook", "order-detail-page"],
    ["detail-page-renders-summary", "order-detail-page", "order-summary-card"],
    ["detail-page-renders-items", "order-detail-page", "order-line-items"],
    ["detail-page-renders-status", "order-detail-page", "order-status-badge"],
    ["detail-hook-renders-error", "order-detail-query-hook", "order-detail-error"],
  ] as const;
  const nodeIds = [...new Set(edgeSpecs.flatMap(([, from, to]) => [from, to]))];
  const structure = directedStructure(
    "order-detail-route",
    nodeIds,
    edgeSpecs.map(([, from, to]) => [from, to]),
  );
  structure.edges = edgeSpecs.map(([id, from, to]) => ({
    id,
    from,
    to,
    label: id,
    directed: true,
    anchors: [],
  }));
  structure.presentation = {
    thesis: "The response crosses backend, contract, query state, and rendering boundaries.",
    startNodeId: "order-detail-route",
    primaryBackbone: {
      edgeIds: [
        "detail-auth-scopes-query",
        "detail-client-provides-hook-result",
        "detail-hook-provides-page-state",
        "detail-not-found-returns-contract",
        "detail-params-supply-query",
        "detail-presenter-returns-contract",
        "detail-query-loads-read-model",
        "detail-query-maps-not-found",
        "detail-query-presents-result",
        "detail-repository-queries-view",
        "detail-response-enters-client",
        "detail-route-authenticates",
        "detail-route-executes-query",
        "detail-route-validates-id",
      ],
    },
    regions: [
      {
        id: "http-boundary",
        label: "HTTP boundary",
        summary: "Authentication and request parameters enter through the route.",
        nodeIds: ["detail-actor-auth", "detail-params", "order-detail-route"],
      },
      {
        id: "read-and-present",
        label: "Read and present",
        summary: "The query loads data and selects a response representation.",
        nodeIds: [
          "get-order-query",
          "order-not-found",
          "order-read-repository",
          "order-response-presenter",
          "orders-read-model",
        ],
      },
      {
        id: "shared-response",
        label: "Shared response",
        summary: "The contract crosses the backend and client boundary.",
        nodeIds: ["order-api-client", "order-detail-contract"],
      },
      {
        id: "react-rendering",
        label: "React rendering",
        summary: "The query hook fans out into page rendering responsibilities.",
        nodeIds: [
          "order-detail-error",
          "order-detail-page",
          "order-detail-query-hook",
          "order-line-items",
          "order-query-cache",
          "order-status-badge",
          "order-summary-card",
        ],
      },
    ],
  };
  return structure;
}

describe("Structure domain presentation rules", () => {
  it("round-trips stable Structure URIs", () => {
    const id = "70000000-0000-4000-8000-000000000001";
    expect(formatStructureUri(id)).toBe(`rvw://structure/${id}`);
    expect(parseStructureUri(formatStructureUri(id))).toBe(id);
    expect(() => parseStructureUri("rvw://structure/not-a-uuid")).toThrow(/URI/);
  });

  it("uses a non-null presentation as a deterministic, collision-free spatial composition", () => {
    const structure = structureWithPresentation();
    const layout = initialStructureLayout(structure);
    expect(Object.keys(layout).sort()).toEqual(structure.nodes.map(({ id }) => id).sort());
    expectNoNodeOverlap(layout);

    const regionBounds = structure.presentation!.regions.map((region) => ({
      left: Math.min(...region.nodeIds.map((nodeId) => layout[nodeId]!.x)),
      top: Math.min(...region.nodeIds.map((nodeId) => layout[nodeId]!.y)),
      right: Math.max(...region.nodeIds.map((nodeId) => layout[nodeId]!.x + STRUCTURE_NODE_WIDTH)),
      bottom: Math.max(
        ...region.nodeIds.map((nodeId) => layout[nodeId]!.y + STRUCTURE_NODE_HEIGHT),
      ),
    }));
    for (const [index, left] of regionBounds.entries()) {
      for (const right of regionBounds.slice(index + 1)) {
        expect(
          left.right <= right.left ||
            right.right <= left.left ||
            left.bottom <= right.top ||
            right.bottom <= left.top,
        ).toBe(true);
      }
    }
    expect(Math.abs(layout["related-detail"]!.x - layout["output-detail"]!.x)).toBeLessThanOrEqual(
      STRUCTURE_NODE_WIDTH + 72,
    );

    const shuffled = initialStructureLayout({
      ...structure,
      nodes: [...structure.nodes].reverse(),
      edges: [...structure.edges].reverse(),
    });
    expect(shuffled).toEqual(layout);
  });

  it("keeps the full contract Structure in compact, coherent Region chunks", () => {
    const structure = createContractStructures({
      pullRequestId: "pr-1",
      baseOid: "a".repeat(40),
      firstHead: "b".repeat(40),
    })[0] as Structure;
    const layout = initialStructureLayout(structure);
    const points = Object.values(layout);
    const totalBounds = {
      left: Math.min(...points.map(({ x }) => x)),
      top: Math.min(...points.map(({ y }) => y)),
      right: Math.max(...points.map(({ x }) => x + STRUCTURE_NODE_WIDTH)),
      bottom: Math.max(...points.map(({ y }) => y + STRUCTURE_NODE_HEIGHT)),
    };
    const regionBounds = structure.presentation!.regions.map((region) => {
      const members = region.nodeIds.map((nodeId) => layout[nodeId]!);
      return {
        id: region.id,
        left: Math.min(...members.map(({ x }) => x)),
        top: Math.min(...members.map(({ y }) => y)),
        right: Math.max(...members.map(({ x }) => x + STRUCTURE_NODE_WIDTH)),
        bottom: Math.max(...members.map(({ y }) => y + STRUCTURE_NODE_HEIGHT)),
      };
    });

    expectNoNodeOverlap(layout);
    expect(totalBounds.right - totalBounds.left).toBeLessThanOrEqual(1_600);
    expect(totalBounds.bottom - totalBounds.top).toBeLessThanOrEqual(850);
    for (const bounds of regionBounds) {
      expect(bounds.right - bounds.left, `${bounds.id} width`).toBeLessThan(
        STRUCTURE_NODE_WIDTH * 3,
      );
      expect(bounds.bottom - bounds.top, `${bounds.id} height`).toBeLessThanOrEqual(
        STRUCTURE_NODE_HEIGHT * 3,
      );
    }
    for (const [index, left] of regionBounds.entries()) {
      for (const right of regionBounds.slice(index + 1)) {
        expect(
          left.right + STRUCTURE_REGION_PADDING_X <= right.left - STRUCTURE_REGION_PADDING_X ||
            right.right + STRUCTURE_REGION_PADDING_X <= left.left - STRUCTURE_REGION_PADDING_X ||
            left.bottom + STRUCTURE_REGION_PADDING_BOTTOM <=
              right.top - STRUCTURE_REGION_PADDING_TOP ||
            right.bottom + STRUCTURE_REGION_PADDING_BOTTOM <=
              left.top - STRUCTURE_REGION_PADDING_TOP,
          `${left.id} and ${right.id} overlap`,
        ).toBe(true);
      }
    }

    const reordered = initialStructureLayout({
      ...structure,
      nodes: [...structure.nodes].reverse(),
      edges: [...structure.edges].reverse(),
      presentation: {
        ...structure.presentation!,
        primaryBackbone: structure.presentation!.primaryBackbone
          ? { edgeIds: [...structure.presentation!.primaryBackbone.edgeIds].reverse() }
          : null,
        regions: [...structure.presentation!.regions].reverse().map((region) => ({
          ...region,
          nodeIds: [...region.nodeIds].reverse(),
        })),
      },
    });
    expect(reordered).toEqual(layout);
  });

  it("uses the empty cell in a three-member Region for its multi-boundary hub", () => {
    const structure = createContractStructures({
      pullRequestId: "pr-1",
      baseOid: "a".repeat(40),
      firstHead: "b".repeat(40),
    })[0] as Structure;
    const layout = initialStructureLayout(structure);
    const application = structure.presentation!.regions.find(
      ({ id }) => id === "application-coordination",
    )!;
    const memberPoints = application.nodeIds.map((nodeId) => layout[nodeId]!);
    const hub = layout.hub!;

    expect(new Set(memberPoints.map(({ x }) => x))).toHaveLength(2);
    expect(new Set(memberPoints.map(({ y }) => y))).toHaveLength(2);
    expect(new Set(memberPoints.map(({ x, y }) => `${x}:${y}`))).toHaveLength(3);
    expect(hub.x).toBe(Math.max(...memberPoints.map(({ x }) => x)));
    expect(hub.y).toBe(Math.max(...memberPoints.map(({ y }) => y)));
  });

  it.each([
    {
      name: "path",
      nodeIds: ["start", "a", "b", "end"],
      links: [
        ["start", "a"],
        ["a", "b"],
        ["b", "end"],
      ] as const,
    },
    {
      name: "star",
      nodeIds: ["start", "a", "b", "c", "d", "e", "f", "g", "h"],
      links: ["a", "b", "c", "d", "e", "f", "g", "h"].map((nodeId) => ["start", nodeId] as const),
    },
    {
      name: "diamond",
      nodeIds: ["start", "left", "right", "end"],
      links: [
        ["start", "left"],
        ["start", "right"],
        ["left", "end"],
        ["right", "end"],
      ] as const,
    },
    {
      name: "reciprocal",
      nodeIds: ["start", "peer"],
      links: [
        ["start", "peer"],
        ["peer", "start"],
      ] as const,
    },
  ])("projects a $name backbone as a deterministic connected 2D skeleton", ({ nodeIds, links }) => {
    const structure = directedStructure("start", nodeIds, links);
    structure.presentation = {
      thesis: "The exact relations form the explanation core.",
      startNodeId: "start",
      primaryBackbone: { edgeIds: structure.edges.map(({ id }) => id).reverse() },
      regions: [
        {
          id: "core",
          label: "Core",
          summary: "The exact relationship backbone.",
          nodeIds: [...nodeIds].reverse(),
        },
      ],
    };
    const layout = initialStructureLayout(structure);
    expect(Object.keys(layout).sort()).toEqual([...nodeIds].sort());
    expectNoNodeOverlap(layout);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: structure.edges.map((edge) => ({
          ...edge,
          from: edge.to,
          to: edge.from,
        })),
        presentation: {
          ...structure.presentation,
          primaryBackbone: {
            edgeIds: [...structure.presentation.primaryBackbone!.edgeIds].reverse(),
          },
          regions: structure.presentation.regions.map((region) => ({
            ...region,
            nodeIds: [...region.nodeIds].reverse(),
          })),
        },
      }),
    ).toEqual(layout);
    if (nodeIds.length > 4) {
      const points = Object.values(layout);
      const width = Math.max(...points.map(({ x }) => x)) - Math.min(...points.map(({ x }) => x));
      const height = Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y));
      expect(width / Math.max(1, height)).toBeLessThan(3);
    }
  });

  it("folds the full exact-relation backbone into a readable compact 2D map", () => {
    const structure = fullStackPresentedStructure();
    const layout = initialStructureLayout(structure);
    const points = Object.values(layout);
    const left = Math.min(...points.map(({ x }) => x));
    const right = Math.max(...points.map(({ x }) => x + STRUCTURE_NODE_WIDTH));
    const top = Math.min(...points.map(({ y }) => y));
    const bottom = Math.max(...points.map(({ y }) => y + STRUCTURE_NODE_HEIGHT));
    const width = right - left;
    const height = bottom - top;
    const referenceFitScale = Math.min(1.25, (1_440 - 72) / width, (900 - 88) / height);

    expect(structure.nodes).toHaveLength(17);
    expect(structure.presentation!.primaryBackbone!.edgeIds).toHaveLength(14);
    expectNoNodeOverlap(layout);
    expect(width / height).toBeLessThanOrEqual(2.6);
    expect(height / width).toBeGreaterThanOrEqual(0.38);
    expect(referenceFitScale).toBeGreaterThanOrEqual(0.55);

    const backboneEdgeIds = new Set(structure.presentation!.primaryBackbone!.edgeIds);
    const backboneNodeIds = new Set(
      structure.edges.flatMap((edge) => (backboneEdgeIds.has(edge.id) ? [edge.from, edge.to] : [])),
    );
    const backbonePoints = [...backboneNodeIds].map((nodeId) => layout[nodeId]!);
    const backboneHeight =
      Math.max(...backbonePoints.map(({ y }) => y + STRUCTURE_NODE_HEIGHT)) -
      Math.min(...backbonePoints.map(({ y }) => y));
    expect(backboneHeight).toBeGreaterThan(400);

    const regionBounds = structure.presentation!.regions.map((region) => ({
      left:
        Math.min(...region.nodeIds.map((nodeId) => layout[nodeId]!.x)) - STRUCTURE_REGION_PADDING_X,
      right:
        Math.max(...region.nodeIds.map((nodeId) => layout[nodeId]!.x + STRUCTURE_NODE_WIDTH)) +
        STRUCTURE_REGION_PADDING_X,
      top:
        Math.min(...region.nodeIds.map((nodeId) => layout[nodeId]!.y)) -
        STRUCTURE_REGION_PADDING_TOP,
      bottom:
        Math.max(...region.nodeIds.map((nodeId) => layout[nodeId]!.y + STRUCTURE_NODE_HEIGHT)) +
        STRUCTURE_REGION_PADDING_BOTTOM,
    }));
    for (const [index, current] of regionBounds.entries()) {
      for (const other of regionBounds.slice(index + 1)) {
        expect(presentationBoxesOverlap(current, other)).toBe(false);
      }
    }

    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
        presentation: {
          ...structure.presentation!,
          primaryBackbone: {
            edgeIds: [...structure.presentation!.primaryBackbone!.edgeIds].reverse(),
          },
          regions: structure.presentation!.regions.map((region) => ({
            ...region,
            nodeIds: [...region.nodeIds].reverse(),
          })),
        },
      }),
    ).toEqual(layout);
  });

  it("prioritizes relation continuity among rank-band packings with acceptable extents", () => {
    const nodeIds = Array.from({ length: 6 }, (_, index) => `step-${index}`);
    const structure = directedStructure(
      nodeIds[0]!,
      nodeIds,
      nodeIds.slice(1).map((nodeId, index) => [nodeIds[index]!, nodeId]),
    );
    structure.presentation = {
      thesis: "The short factual sequence should remain easy to trace when it folds.",
      startNodeId: nodeIds[0]!,
      primaryBackbone: { edgeIds: structure.edges.map(({ id }) => id) },
      regions: [],
    };
    const layout = initialStructureLayout(structure);
    const extent = structureLayoutExtent(layout);
    const relationSpan = structure.edges.reduce(
      (total, { from, to }) =>
        total +
        Math.abs(layout[from]!.x - layout[to]!.x) +
        Math.abs(layout[from]!.y - layout[to]!.y),
      0,
    );

    expectNoNodeOverlap(layout);
    expect(Math.max(extent.width / extent.height, extent.height / extent.width)).toBeLessThan(1.2);
    expect(relationSpan).toBeLessThanOrEqual(1_900);
  });

  it.each([
    { nodeCount: 12, maximumWidth: 1_700, maximumHeight: 900, minimumFitScale: 0.8 },
    { nodeCount: 50, maximumWidth: 3_100, maximumHeight: 1_950, minimumFitScale: 0.4 },
  ])(
    "keeps a $nodeCount-Node Region-external Context chain bounded",
    ({ nodeCount, maximumWidth, maximumHeight, minimumFitScale }) => {
      const structure = partiallyGroupedChain(nodeCount, [
        { id: "authored-start", nodeIndexes: [0] },
      ]);
      const layout = initialStructureLayout(structure);
      const { width, height } = structureLayoutExtent(layout);
      const referenceFitScale = Math.min(1.25, (1_440 - 72) / width, (900 - 88) / height);

      expect(Object.keys(layout).sort()).toEqual(structure.nodes.map(({ id }) => id).sort());
      expectNoNodeOverlap(layout);
      expect(width).toBeLessThanOrEqual(maximumWidth);
      expect(height).toBeLessThanOrEqual(maximumHeight);
      expect(Math.max(width / height, height / width)).toBeLessThanOrEqual(2);
      expect(referenceFitScale).toBeGreaterThanOrEqual(minimumFitScale);

      expect(
        initialStructureLayout({
          ...structure,
          nodes: [...structure.nodes].reverse(),
          edges: [...structure.edges].reverse(),
          presentation: {
            ...structure.presentation!,
            primaryBackbone: {
              edgeIds: [...structure.presentation!.primaryBackbone!.edgeIds].reverse(),
            },
            regions: [...structure.presentation!.regions].reverse().map((region) => ({
              ...region,
              nodeIds: [...region.nodeIds].reverse(),
            })),
          },
        }),
      ).toEqual(layout);
    },
  );

  it("packs multiple Region-external Context components without splitting authored chunks", () => {
    const structure = partiallyGroupedChain(12, [
      { id: "entry", nodeIndexes: [0, 1] },
      { id: "decision", nodeIndexes: [6, 7] },
    ]);
    const layout = initialStructureLayout(structure);
    const { width, height } = structureLayoutExtent(layout);
    const regionEnvelopes = structure.presentation!.regions.map((region) => {
      const points = region.nodeIds.map((nodeId) => layout[nodeId]!);
      return {
        left: Math.min(...points.map(({ x }) => x)) - STRUCTURE_REGION_PADDING_X,
        top: Math.min(...points.map(({ y }) => y)) - STRUCTURE_REGION_PADDING_TOP,
        right:
          Math.max(...points.map(({ x }) => x + STRUCTURE_NODE_WIDTH)) + STRUCTURE_REGION_PADDING_X,
        bottom:
          Math.max(...points.map(({ y }) => y + STRUCTURE_NODE_HEIGHT)) +
          STRUCTURE_REGION_PADDING_BOTTOM,
      };
    });

    expectNoNodeOverlap(layout);
    expect(width).toBeLessThanOrEqual(1_300);
    expect(height).toBeLessThanOrEqual(900);
    expect(Math.max(width / height, height / width)).toBeLessThanOrEqual(1.5);
    expect(presentationBoxesOverlap(regionEnvelopes[0]!, regionEnvelopes[1]!)).toBe(false);
    const authoredNodeIds = new Set(
      structure.presentation!.regions.flatMap(({ nodeIds }) => nodeIds),
    );
    for (const contextNodeId of structure.nodes
      .map(({ id }) => id)
      .filter((nodeId) => !authoredNodeIds.has(nodeId))) {
      const point = layout[contextNodeId]!;
      const nodeEnvelope = {
        left: point.x,
        top: point.y,
        right: point.x + STRUCTURE_NODE_WIDTH,
        bottom: point.y + STRUCTURE_NODE_HEIGHT,
      };
      expect(regionEnvelopes.some((region) => presentationBoxesOverlap(nodeEnvelope, region))).toBe(
        false,
      );
    }
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
        presentation: {
          ...structure.presentation!,
          primaryBackbone: {
            edgeIds: [...structure.presentation!.primaryBackbone!.edgeIds].reverse(),
          },
          regions: [...structure.presentation!.regions].reverse().map((region) => ({
            ...region,
            nodeIds: [...region.nodeIds].reverse(),
          })),
        },
      }),
    ).toEqual(layout);
  });

  it("packs many Region-external Context leaves around an authored hub", () => {
    const leafIds = Array.from(
      { length: 49 },
      (_, index) => `leaf-${String(index).padStart(2, "0")}`,
    );
    const structure = directedStructure(
      "hub",
      ["hub", ...leafIds],
      leafIds.map((nodeId) => ["hub", nodeId]),
    );
    structure.presentation = {
      thesis: "The hub exposes many independent factual policies.",
      startNodeId: "hub",
      primaryBackbone: null,
      regions: [
        {
          id: "coordination",
          label: "Coordination",
          summary: "The authored coordination responsibility.",
          nodeIds: ["hub"],
        },
      ],
    };
    const layout = initialStructureLayout(structure);
    const { width, height } = structureLayoutExtent(layout);
    const hub = layout.hub!;
    const regionEnvelope = {
      left: hub.x - STRUCTURE_REGION_PADDING_X,
      top: hub.y - STRUCTURE_REGION_PADDING_TOP,
      right: hub.x + STRUCTURE_NODE_WIDTH + STRUCTURE_REGION_PADDING_X,
      bottom: hub.y + STRUCTURE_NODE_HEIGHT + STRUCTURE_REGION_PADDING_BOTTOM,
    };

    expectNoNodeOverlap(layout);
    expect(width).toBeLessThanOrEqual(2_500);
    expect(height).toBeLessThanOrEqual(1_400);
    expect(Math.max(width / height, height / width)).toBeLessThanOrEqual(2);
    expect(Math.min((1_440 - 72) / width, (900 - 88) / height)).toBeGreaterThanOrEqual(0.55);
    for (const nodeId of leafIds) {
      const point = layout[nodeId]!;
      expect(
        presentationBoxesOverlap(regionEnvelope, {
          left: point.x,
          top: point.y,
          right: point.x + STRUCTURE_NODE_WIDTH,
          bottom: point.y + STRUCTURE_NODE_HEIGHT,
        }),
      ).toBe(false);
    }
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
        presentation: {
          ...structure.presentation,
          regions: structure.presentation.regions.map((region) => ({
            ...region,
            nodeIds: [...region.nodeIds].reverse(),
          })),
        },
      }),
    ).toEqual(layout);
  });

  it("packs sixteen short Region-external branches as bounded Context compounds", () => {
    const branchCount = 16;
    const branchLength = 3;
    const branchNodeIds = Array.from({ length: branchCount }, (_, branchIndex) =>
      Array.from(
        { length: branchLength },
        (_, nodeIndex) =>
          `branch-${String(branchIndex).padStart(2, "0")}-${String(nodeIndex).padStart(2, "0")}`,
      ),
    );
    const links = branchNodeIds.flatMap((nodeIds) => [
      ["hub", nodeIds[0]!] as const,
      ...nodeIds.slice(1).map((nodeId, index) => [nodeIds[index]!, nodeId] as const),
    ]);
    const structure = directedStructure("hub", ["hub", ...branchNodeIds.flat()], links);
    structure.presentation = {
      thesis: "Independent factual branches remain locally coherent around coordination.",
      startNodeId: "hub",
      primaryBackbone: null,
      regions: [
        {
          id: "coordination",
          label: "Coordination",
          summary: "The authored coordination responsibility.",
          nodeIds: ["hub"],
        },
      ],
    };
    const layout = initialStructureLayout(structure);
    const { width, height } = structureLayoutExtent(layout);

    expectNoNodeOverlap(layout);
    expect(width).toBeLessThanOrEqual(3_000);
    expect(height).toBeLessThanOrEqual(1_650);
    expect(Math.max(width / height, height / width)).toBeLessThanOrEqual(2);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
      }),
    ).toEqual(layout);
  });

  it("keeps backbone geometry stable when an exact parallel relation changes but adjacency does not", () => {
    const structure = directedStructure(
      "start",
      ["start", "middle", "end"],
      [
        ["start", "middle"],
        ["middle", "end"],
        ["middle", "start"],
      ],
    );
    structure.presentation = {
      thesis: "The core crosses the middle responsibility.",
      startNodeId: "start",
      primaryBackbone: { edgeIds: ["edge-0", "edge-1"] },
      regions: [],
    };
    const first = initialStructureLayout(structure);
    const substituted = initialStructureLayout({
      ...structure,
      presentation: {
        ...structure.presentation,
        primaryBackbone: { edgeIds: ["edge-2", "edge-1"] },
      },
    });
    expect(substituted).toEqual(first);
  });

  it("keeps backbone geometry stable when exact parallel multiplicity changes but adjacency does not", () => {
    const structure = directedStructure(
      "start",
      ["start", "a", "b", "c", "x", "y"],
      [
        ["start", "a"],
        ["start", "b"],
        ["start", "c"],
        ["a", "x"],
        ["c", "x"],
        ["b", "y"],
      ],
    );
    structure.presentation = {
      thesis: "Parallel relation identity does not create a second spatial adjacency.",
      startNodeId: "start",
      primaryBackbone: { edgeIds: structure.edges.map(({ id }) => id) },
      regions: [],
    };
    const first = initialStructureLayout(structure);
    const parallelEdge = {
      ...structure.edges[3]!,
      id: "parallel-a-x",
      label: "also calls",
    };
    const withParallel: Structure = {
      ...structure,
      edges: [...structure.edges, parallelEdge],
      presentation: {
        ...structure.presentation,
        primaryBackbone: {
          edgeIds: [...structure.presentation.primaryBackbone!.edgeIds, parallelEdge.id],
        },
      },
    };

    expect(initialStructureLayout(withParallel)).toEqual(first);
  });

  it("keeps the legacy topology projection unchanged for a null presentation", () => {
    const structure = structureWithHub();
    expect(projectStructure(structure)).toEqual(
      projectStructure({
        originNodeId: structure.originNodeId,
        nodes: structure.nodes,
        edges: structure.edges,
      }),
    );
  });

  it("uses topology-derived canonical geometry when presentation declares only thesis and start", () => {
    const structure = directedStructure(
      "entry",
      ["entry", "hub", "policy-a", "policy-b", "policy-c"],
      [
        ["entry", "hub"],
        ["hub", "policy-a"],
        ["hub", "policy-b"],
        ["hub", "policy-c"],
      ],
    );
    const topologyProjection = projectTopologyStructure(structure);
    structure.presentation = {
      thesis: "The hub coordinates independent policies without one honest path or grouping.",
      startNodeId: "hub",
      primaryBackbone: null,
      regions: [],
    };

    const presentedProjection = projectStructure(structure);
    expect(presentedProjection).toEqual(topologyProjection);
    const layout = initialStructureLayout(structure);
    expect(Object.keys(layout).sort()).toEqual(structure.nodes.map(({ id }) => id).sort());
    expectNoNodeOverlap(layout);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
      }),
    ).toEqual(layout);
  });

  it("falls back safely when persisted Region membership no longer resolves to a Node", () => {
    const structure = directedStructure("entry", ["entry", "next"], [["entry", "next"]]);
    const topologyProjection = projectTopologyStructure(structure);
    structure.presentation = {
      thesis: "A stale stored Region must not make projection throw.",
      startNodeId: "entry",
      primaryBackbone: null,
      regions: [
        {
          id: "stale",
          label: "Stale",
          summary: "No current member remains.",
          nodeIds: ["removed-node"],
        },
      ],
    };

    expect(projectStructure(structure)).toEqual(topologyProjection);
  });

  it("keeps factual authoring diagnostics independent from a reverse explanation backbone", () => {
    const structure = directedStructure(
      "consumer",
      ["contract", "consumer"],
      [["consumer", "contract"]],
    );
    structure.presentation = {
      thesis: "Read the contract before the consumer that depends on it.",
      startNodeId: "contract",
      primaryBackbone: {
        edgeIds: ["edge-0"],
      },
      regions: [],
    };

    const projection = projectStructure(structure);
    expect(projection.positionsByNodeId.get("contract")!.x).toBeLessThan(
      projection.positionsByNodeId.get("consumer")!.x,
    );
    expect(projection.diagnostics.nonForwardDirectionalLinkCount).toBe(1);
    const factualDiagnostics = projectTopologyStructure(structure).diagnostics;
    expect(factualDiagnostics.nonForwardDirectionalLinkCount).toBe(0);
    expect(structureAuthoringWarnings(factualDiagnostics)).toEqual([]);
  });

  it("grows an unassigned branch from each newly placed topology ancestor", () => {
    const structure = directedStructure(
      "root",
      ["root", "z-parent", "m-child", "a-grandchild"],
      [
        ["root", "z-parent"],
        ["z-parent", "m-child"],
        ["m-child", "a-grandchild"],
      ],
    );
    structure.presentation = {
      thesis: "The branch remains explorable from its authored starting point.",
      startNodeId: "root",
      primaryBackbone: null,
      regions: [
        {
          id: "starting-point",
          label: "Starting point",
          summary: "The authored point from which the unassigned branch grows.",
          nodeIds: ["root"],
        },
      ],
    };

    const layout = initialStructureLayout(structure);
    const distance = (left: string, right: string): number =>
      Math.hypot(layout[left]!.x - layout[right]!.x, layout[left]!.y - layout[right]!.y);
    expect(distance("a-grandchild", "root")).toBeGreaterThan(
      distance("a-grandchild", "m-child") * 2,
    );
    expectNoNodeOverlap(layout);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
      }),
    ).toEqual(layout);
  });

  it("keeps an ungrouped backbone Node out of a neighboring region envelope", () => {
    const regionNodeIds = Array.from(
      { length: 9 },
      (_, index) => `region-node-${String(index).padStart(2, "0")}`,
    );
    const structure = directedStructure(
      "A",
      ["A", "X", "B", ...regionNodeIds],
      [["A", "X"], ["X", "B"], ...regionNodeIds.map((nodeId) => ["X", nodeId] as const)],
    );
    structure.presentation = {
      thesis: "The middle policies form their own chunk between the boundary Nodes.",
      startNodeId: "A",
      primaryBackbone: {
        edgeIds: ["edge-0", "edge-1"],
      },
      regions: [
        { id: "before", label: "Before", summary: "Before the policies.", nodeIds: ["A"] },
        {
          id: "policies",
          label: "Policies",
          summary: "The policy responsibilities around the unassigned backbone Node.",
          nodeIds: regionNodeIds,
        },
        { id: "after", label: "After", summary: "After the policies.", nodeIds: ["B"] },
      ],
    };

    const layout = initialStructureLayout(structure);
    const regionBounds = structure.presentation.regions.map((region) => ({
      left:
        Math.min(...region.nodeIds.map((nodeId) => layout[nodeId]!.x)) - STRUCTURE_REGION_PADDING_X,
      top:
        Math.min(...region.nodeIds.map((nodeId) => layout[nodeId]!.y)) -
        STRUCTURE_REGION_PADDING_TOP,
      right:
        Math.max(...region.nodeIds.map((nodeId) => layout[nodeId]!.x + STRUCTURE_NODE_WIDTH)) +
        STRUCTURE_REGION_PADDING_X,
      bottom:
        Math.max(...region.nodeIds.map((nodeId) => layout[nodeId]!.y + STRUCTURE_NODE_HEIGHT)) +
        STRUCTURE_REGION_PADDING_BOTTOM,
    }));
    const xBox = {
      left: layout.X!.x,
      top: layout.X!.y,
      right: layout.X!.x + STRUCTURE_NODE_WIDTH,
      bottom: layout.X!.y + STRUCTURE_NODE_HEIGHT,
    };
    const overlaps = (
      left: { left: number; top: number; right: number; bottom: number },
      right: { left: number; top: number; right: number; bottom: number },
    ): boolean =>
      !(
        left.right <= right.left ||
        right.right <= left.left ||
        left.bottom <= right.top ||
        right.bottom <= left.top
      );

    for (const [index, bounds] of regionBounds.entries()) {
      for (const other of regionBounds.slice(index + 1)) {
        expect(overlaps(bounds, other)).toBe(false);
      }
    }
    expect(overlaps(xBox, regionBounds[1]!)).toBe(false);
    expectNoNodeOverlap(layout);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
      }),
    ).toEqual(layout);
  });

  it.each([
    { policyCount: 16, maximumAspectRatio: 1.6 },
    { policyCount: 49, maximumAspectRatio: 1.4 },
  ])(
    "packs a region-only hub with $policyCount policies into a bounded 2D surface",
    ({ policyCount, maximumAspectRatio }) => {
      const policyIds = Array.from(
        { length: policyCount },
        (_, index) => `policy-${String(index).padStart(2, "0")}`,
      );
      const structure = directedStructure(
        "hub",
        ["hub", ...policyIds],
        policyIds.map((policyId) => ["hub", policyId] as const),
      );
      structure.presentation = {
        thesis: "The hub coordinates a set of peer policies.",
        startNodeId: "hub",
        primaryBackbone: null,
        regions: [
          {
            id: "policies",
            label: "Policies",
            summary: "The peer policies coordinated by the hub.",
            nodeIds: ["hub", ...policyIds],
          },
        ],
      };

      const layout = initialStructureLayout(structure);
      const points = Object.values(layout);
      const width =
        Math.max(...points.map(({ x }) => x + STRUCTURE_NODE_WIDTH)) -
        Math.min(...points.map(({ x }) => x));
      const height =
        Math.max(...points.map(({ y }) => y + STRUCTURE_NODE_HEIGHT)) -
        Math.min(...points.map(({ y }) => y));
      expect(Math.max(width / height, height / width)).toBeLessThanOrEqual(maximumAspectRatio);
      expectNoNodeOverlap(layout);
      expect(
        initialStructureLayout({
          ...structure,
          nodes: [...structure.nodes].reverse(),
          edges: [...structure.edges].reverse(),
        }),
      ).toEqual(layout);
    },
  );

  it("places cross-region attachment Nodes on neighboring chunk boundaries", () => {
    const firstRegion = ["a-linked", "b-first", "c-first", "d-first"];
    const secondRegion = ["a-second", "b-second", "c-second", "z-linked"];
    const structure = directedStructure(
      "a-linked",
      [...firstRegion, ...secondRegion],
      [["a-linked", "z-linked"]],
    );
    structure.presentation = {
      thesis: "The handoff keeps two chunks connected without turning them into a sequence.",
      startNodeId: "a-linked",
      primaryBackbone: null,
      regions: [
        {
          id: "first-chunk",
          label: "First chunk",
          summary: "The first side of the direct handoff.",
          nodeIds: firstRegion,
        },
        {
          id: "second-chunk",
          label: "Second chunk",
          summary: "The second side of the direct handoff.",
          nodeIds: secondRegion,
        },
      ],
    };

    const layout = initialStructureLayout(structure);
    const center = (nodeIds: readonly string[]) => ({
      x: nodeIds.reduce((sum, nodeId) => sum + layout[nodeId]!.x, 0) / nodeIds.length,
      y: nodeIds.reduce((sum, nodeId) => sum + layout[nodeId]!.y, 0) / nodeIds.length,
    });
    const firstCenter = center(firstRegion);
    const secondCenter = center(secondRegion);
    const towardSecond = (nodeId: string): number =>
      layout[nodeId]!.x * (secondCenter.x - firstCenter.x) +
      layout[nodeId]!.y * (secondCenter.y - firstCenter.y);
    expect(towardSecond("a-linked")).toBe(
      Math.max(...firstRegion.map((nodeId) => towardSecond(nodeId))),
    );
    expect(towardSecond("z-linked")).toBe(
      Math.min(...secondRegion.map((nodeId) => towardSecond(nodeId))),
    );
    expectNoNodeOverlap(layout);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
        presentation: {
          ...structure.presentation,
          regions: structure.presentation.regions.map((region) => ({
            ...region,
            nodeIds: [...region.nodeIds].reverse(),
          })),
        },
      }),
    ).toEqual(layout);
  });

  it("packs twelve unordered, directly related Regions into a bounded 2D surface", () => {
    const nodeIds = [
      "hub",
      ...Array.from({ length: 47 }, (_, index) => `node-${String(index).padStart(2, "0")}`),
    ];
    const structure = directedStructure(
      "hub",
      nodeIds,
      nodeIds.slice(1).map((nodeId) => ["hub", nodeId] as const),
    );
    structure.presentation = {
      thesis: "The hub coordinates twelve independent policy chunks.",
      startNodeId: "hub",
      primaryBackbone: null,
      regions: Array.from({ length: 12 }, (_, regionIndex) => ({
        id: `region-${String(regionIndex).padStart(2, "0")}`,
        label: `Region ${regionIndex}`,
        summary: `Policy chunk ${regionIndex}.`,
        nodeIds: nodeIds.slice(regionIndex * 4, regionIndex * 4 + 4),
      })),
    };

    const layout = initialStructureLayout(structure);
    const bounds = structure.presentation.regions.map((region) => ({
      left:
        Math.min(...region.nodeIds.map((nodeId) => layout[nodeId]!.x)) - STRUCTURE_REGION_PADDING_X,
      top:
        Math.min(...region.nodeIds.map((nodeId) => layout[nodeId]!.y)) -
        STRUCTURE_REGION_PADDING_TOP,
      right:
        Math.max(...region.nodeIds.map((nodeId) => layout[nodeId]!.x + STRUCTURE_NODE_WIDTH)) +
        STRUCTURE_REGION_PADDING_X,
      bottom:
        Math.max(...region.nodeIds.map((nodeId) => layout[nodeId]!.y + STRUCTURE_NODE_HEIGHT)) +
        STRUCTURE_REGION_PADDING_BOTTOM,
    }));
    const overlaps = (
      left: { left: number; top: number; right: number; bottom: number },
      right: { left: number; top: number; right: number; bottom: number },
    ): boolean =>
      !(
        left.right <= right.left ||
        right.right <= left.left ||
        left.bottom <= right.top ||
        right.bottom <= left.top
      );
    for (const [index, current] of bounds.entries()) {
      for (const other of bounds.slice(index + 1)) expect(overlaps(current, other)).toBe(false);
    }
    for (const [regionIndex, region] of structure.presentation.regions.entries()) {
      const members = new Set(region.nodeIds);
      for (const nodeId of nodeIds) {
        if (members.has(nodeId)) continue;
        const point = layout[nodeId]!;
        expect(
          overlaps(bounds[regionIndex]!, {
            left: point.x,
            top: point.y,
            right: point.x + STRUCTURE_NODE_WIDTH,
            bottom: point.y + STRUCTURE_NODE_HEIGHT,
          }),
        ).toBe(false);
      }
    }
    const width =
      Math.max(...bounds.map(({ right }) => right)) - Math.min(...bounds.map(({ left }) => left));
    const height =
      Math.max(...bounds.map(({ bottom }) => bottom)) - Math.min(...bounds.map(({ top }) => top));
    expect(Math.max(width / height, height / width)).toBeLessThanOrEqual(2.1);
    expectNoNodeOverlap(layout);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
        presentation: {
          ...structure.presentation,
          regions: [...structure.presentation.regions]
            .reverse()
            .map((region) => ({ ...region, nodeIds: [...region.nodeIds].reverse() })),
        },
      }),
    ).toEqual(layout);
  });

  it.each([
    {
      name: "fan-out",
      nodeIds: ["hub", "a", "b", "c", "d"],
      links: [
        ["hub", "a"],
        ["hub", "b"],
        ["hub", "c"],
        ["hub", "d"],
      ] as const,
    },
    {
      name: "convergence",
      nodeIds: ["start", "left", "right", "sink"],
      links: [
        ["start", "left"],
        ["start", "right"],
        ["left", "sink"],
        ["right", "sink"],
      ] as const,
    },
  ])("keeps directly adjacent Regions near for $name", ({ nodeIds, links }) => {
    const structure = directedStructure(nodeIds[0]!, nodeIds, links);
    structure.presentation = {
      thesis: "Direct factual adjacency, not an authored Region order, shapes the chunks.",
      startNodeId: nodeIds[0]!,
      primaryBackbone: null,
      regions: nodeIds.map((nodeId) => ({
        id: `region-${nodeId}`,
        label: nodeId,
        summary: `${nodeId} responsibility.`,
        nodeIds: [nodeId],
      })),
    };
    const layout = initialStructureLayout(structure);
    const pairKey = (left: string, right: string): string => [left, right].sort().join("|");
    const directPairs = new Set(links.map(([left, right]) => pairKey(left, right)));
    const distance = (left: string, right: string): number =>
      Math.abs(layout[left]!.x - layout[right]!.x) + Math.abs(layout[left]!.y - layout[right]!.y);
    const directDistances = links.map(([left, right]) => distance(left, right));
    const unrelatedDistances = nodeIds.flatMap((left, leftIndex) =>
      nodeIds
        .slice(leftIndex + 1)
        .flatMap((right) => (directPairs.has(pairKey(left, right)) ? [] : [distance(left, right)])),
    );

    expectNoNodeOverlap(layout);
    expect(
      directDistances.reduce((sum, value) => sum + value, 0) / directDistances.length,
    ).toBeLessThanOrEqual(
      unrelatedDistances.reduce((sum, value) => sum + value, 0) / unrelatedDistances.length,
    );
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
        presentation: {
          ...structure.presentation,
          regions: [...structure.presentation.regions].reverse(),
        },
      }),
    ).toEqual(layout);
  });

  it("uses only direct Region adjacency and leaves an unassigned bridge explicit", () => {
    const structure = directedStructure(
      "a",
      ["a", "bridge-left", "bridge-right", "c"],
      [
        ["a", "bridge-left"],
        ["bridge-left", "bridge-right"],
        ["bridge-right", "c"],
      ],
    );
    structure.presentation = {
      thesis: "The unassigned bridge stays visible between two authored chunks.",
      startNodeId: "a",
      primaryBackbone: null,
      regions: [
        { id: "a-region", label: "A", summary: "First chunk.", nodeIds: ["a"] },
        { id: "c-region", label: "C", summary: "Second chunk.", nodeIds: ["c"] },
      ],
    };
    const withBridge = initialStructureLayout(structure);
    const withoutBridge = initialStructureLayout({ ...structure, edges: [] });

    expect({
      x: withBridge.c!.x - withBridge.a!.x,
      y: withBridge.c!.y - withBridge.a!.y,
    }).toEqual({
      x: withoutBridge.c!.x - withoutBridge.a!.x,
      y: withoutBridge.c!.y - withoutBridge.a!.y,
    });
    expectNoNodeOverlap(withBridge);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
        presentation: {
          ...structure.presentation,
          regions: [...structure.presentation.regions].reverse(),
        },
      }),
    ).toEqual(withBridge);
  });

  it("keeps every relation in the selected neighborhood", () => {
    const structure = structureWithHub();
    expect(structureNeighborhood(structure, "node-01", 1)).toEqual(new Set(["node-01", "hub"]));
    expect(structureNeighborhood(structure, "node-01", 2).size).toBe(structure.nodes.length);
    const visible = visibleStructureGraph(structure, "hub", 1);
    expect(visible.nodeIds.size).toBe(structure.nodes.length);
    expect(visible.edgeIds.size).toBe(structure.edges.length);
    expect(visibleStructureGraph(structure, "hub", "all")).toEqual(visible);
  });

  it("places a structurally unique hub inside a large Region independently of its stable ID", () => {
    const leafIds = Array.from(
      { length: 16 },
      (_, index) => `leaf-${String(index).padStart(2, "0")}`,
    );
    const buildStructure = (hubId: string): Structure => {
      const structure = directedStructure(
        hubId,
        [hubId, ...leafIds],
        leafIds.map((leafId) => [hubId, leafId]),
      );
      structure.presentation = {
        thesis: "One coordinator relates every responsibility in this comprehension chunk.",
        startNodeId: hubId,
        primaryBackbone: null,
        regions: [
          {
            id: "large-region",
            label: "Large Region",
            summary: "The coordinator and its factual responsibilities.",
            nodeIds: [...structure.nodes].reverse().map(({ id }) => id),
          },
        ],
      };
      return structure;
    };
    const earlyHubStructure = buildStructure("a-hub");
    const lateHubStructure = buildStructure("z-hub");
    const earlyLayout = initialStructureLayout(earlyHubStructure);
    const lateLayout = initialStructureLayout(lateHubStructure);
    const points = Object.values(earlyLayout);

    expect(earlyLayout["a-hub"]).toEqual(lateLayout["z-hub"]);
    expect(earlyLayout["a-hub"]!.x).toBeGreaterThan(Math.min(...points.map(({ x }) => x)));
    expect(earlyLayout["a-hub"]!.x).toBeLessThan(Math.max(...points.map(({ x }) => x)));
    expect(earlyLayout["a-hub"]!.y).toBeGreaterThan(Math.min(...points.map(({ y }) => y)));
    expect(earlyLayout["a-hub"]!.y).toBeLessThan(Math.max(...points.map(({ y }) => y)));
    expectNoNodeOverlap(earlyLayout);
    expect(
      initialStructureLayout({
        ...earlyHubStructure,
        nodes: [...earlyHubStructure.nodes].reverse(),
        edges: [...earlyHubStructure.edges].reverse(),
      }),
    ).toEqual(earlyLayout);
  });

  it("embeds a large Region-internal backbone chain without grid-spanning jumps", () => {
    const chainNodeIds = [
      "kilo",
      "alpha",
      "zulu",
      "bravo",
      "yankee",
      "charlie",
      "xray",
      "delta",
      "whiskey",
      "echo",
      "victor",
      "foxtrot",
    ];
    const structure = directedStructure(
      chainNodeIds[0]!,
      chainNodeIds,
      chainNodeIds.slice(1).map((nodeId, index) => [chainNodeIds[index]!, nodeId]),
    );
    const backboneEdges = [...structure.edges];
    structure.edges.push({
      id: "auxiliary-chord",
      from: chainNodeIds[0]!,
      to: chainNodeIds.at(-1)!,
      label: "also informs",
      directed: true,
      anchors: [],
    });
    structure.presentation = {
      thesis: "The exact flow remains locally traceable inside one large Region.",
      startNodeId: chainNodeIds[0]!,
      primaryBackbone: { edgeIds: backboneEdges.map(({ id }) => id).reverse() },
      regions: [
        {
          id: "chain",
          label: "Chain",
          summary: "One authored end-to-end flow.",
          nodeIds: [...chainNodeIds].sort().reverse(),
        },
      ],
    };
    const layout = initialStructureLayout(structure);
    const relationSpans = backboneEdges.map(
      ({ from, to }) =>
        Math.abs(layout[from]!.x - layout[to]!.x) + Math.abs(layout[from]!.y - layout[to]!.y),
    );

    expect(Math.max(...relationSpans)).toBeLessThanOrEqual(STRUCTURE_NODE_WIDTH + 64);
    expectNoNodeOverlap(layout);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
        presentation: {
          ...structure.presentation,
          primaryBackbone: {
            edgeIds: [...structure.presentation.primaryBackbone!.edgeIds].reverse(),
          },
          regions: structure.presentation.regions.map((region) => ({
            ...region,
            nodeIds: [...region.nodeIds].reverse(),
          })),
        },
      }),
    ).toEqual(layout);
  });

  it("keeps branch and convergence roles stable in a large Region", () => {
    const branchIds = Array.from(
      { length: 9 },
      (_, index) => `branch-${String(index).padStart(2, "0")}`,
    );
    const buildStructure = (sourceId: string, sinkId: string): Structure => {
      const structure = directedStructure(
        sourceId,
        [sourceId, ...branchIds, sinkId],
        branchIds.flatMap((branchId) => [
          [sourceId, branchId] as const,
          [branchId, sinkId] as const,
        ]),
      );
      structure.presentation = {
        thesis: "A source branches into policies that converge at one result.",
        startNodeId: sourceId,
        primaryBackbone: null,
        regions: [
          {
            id: "decision",
            label: "Decision",
            summary: "One branching and converging responsibility.",
            nodeIds: [...structure.nodes].reverse().map(({ id }) => id),
          },
        ],
      };
      return structure;
    };
    const first = buildStructure("a-source", "z-sink");
    const renamed = buildStructure("z-source", "a-sink");
    const firstLayout = initialStructureLayout(first);
    const renamedLayout = initialStructureLayout(renamed);

    expect(firstLayout["a-source"]).toEqual(renamedLayout["z-source"]);
    expect(firstLayout["z-sink"]).toEqual(renamedLayout["a-sink"]);
    expectNoNodeOverlap(firstLayout);
  });

  it("derives an undirected local induced graph without hidden Nodes or fabricated Edges", () => {
    const structure = directedStructure(
      "center",
      ["center", "left", "right", "convergence", "hidden", "hidden-tail"],
      [
        ["left", "center"],
        ["center", "right"],
        ["left", "right"],
        ["left", "convergence"],
        ["right", "convergence"],
        ["convergence", "hidden"],
        ["hidden", "hidden-tail"],
      ],
    );
    const local = deriveLocalStructureGraph(structure, "center", 1)!;

    expect(local.nodes.map(({ id }) => id)).toEqual(["center", "left", "right"]);
    expect(local.edges.map(({ id }) => id)).toEqual(["edge-0", "edge-1", "edge-2"]);
    expect(local.nodeIds).toEqual(new Set(["center", "left", "right"]));
    expect(local.edgeIds).toEqual(new Set(["edge-0", "edge-1", "edge-2"]));
    expect(deriveLocalStructureGraph(structure, "missing", 1)).toBeNull();
    expect(
      deriveLocalStructureGraph(
        {
          ...structure,
          nodes: [...structure.nodes].reverse(),
          edges: [...structure.edges].reverse(),
        },
        "center",
        1,
      ),
    ).toEqual(local);
  });

  it("compresses only local whitespace while preserving direction, order, and the center anchor", () => {
    const structure = directedStructure(
      "center",
      ["center", "left", "right", "convergence", "hidden", "hidden-tail"],
      [
        ["left", "center"],
        ["center", "right"],
        ["left", "right"],
        ["left", "convergence"],
        ["right", "convergence"],
        ["convergence", "hidden"],
        ["hidden", "hidden-tail"],
      ],
    );
    const fullPositions = {
      center: { x: 1_000, y: 1_000 },
      left: { x: -2_000, y: 1_000 },
      right: { x: 4_000, y: 1_000 },
      convergence: { x: 4_000, y: 4_000 },
      hidden: { x: 1_000, y: 2_000 },
      "hidden-tail": { x: 1_000, y: 3_000 },
    };
    const local = deriveLocalStructureLayout(structure, "center", 2, fullPositions)!;
    const depthOne = deriveLocalStructureLayout(structure, "center", 1, fullPositions)!;

    expect(Object.keys(local.positions).sort()).toEqual(["center", "convergence", "left", "right"]);
    expect(local.positions.center).toEqual(fullPositions.center);
    expect(depthOne.positions.center).toEqual(fullPositions.center);
    expect(local.positions.left!.x).toBeLessThan(local.positions.center!.x);
    expect(local.positions.center!.x).toBeLessThan(local.positions.right!.x);
    expect(local.positions.convergence!.y).toBeGreaterThan(local.positions.right!.y);
    expect(structureLayoutExtent(local.positions).width).toBeLessThan(1_000);
    expect(structureLayoutExtent(local.positions).height).toBeLessThan(500);
    expectNoNodeOverlap(local.positions);
    expect(
      deriveLocalStructureLayout(structure, "center", 2, {
        ...fullPositions,
        hidden: { x: -90_000, y: 80_000 },
        "hidden-tail": { x: 70_000, y: -60_000 },
      }),
    ).toEqual(local);
    expect(
      deriveLocalStructureLayout(
        {
          ...structure,
          nodes: [...structure.nodes].reverse(),
          edges: [...structure.edges].reverse(),
        },
        "center",
        2,
        fullPositions,
      ),
    ).toEqual(local);
  });

  it("repairs local collisions without inverting the full layout's horizontal or vertical order", () => {
    const structure = directedStructure(
      "center",
      ["center", "left", "above"],
      [
        ["center", "left"],
        ["center", "above"],
      ],
    );
    const fullPositions = {
      center: { x: 0, y: 0 },
      left: { x: -240, y: 100 },
      above: { x: 100, y: -100 },
    };
    const local = deriveLocalStructureLayout(structure, "center", 1, fullPositions)!;

    expect(local.positions.center).toEqual(fullPositions.center);
    expect(local.positions.left!.x).toBeLessThan(local.positions.center!.x);
    expect(local.positions.left!.y).toBeGreaterThan(local.positions.center!.y);
    expect(local.positions.above!.x).toBeGreaterThan(local.positions.center!.x);
    expect(local.positions.above!.y).toBeLessThan(local.positions.center!.y);
    expectNoNodeOverlap(local.positions);
    expect(
      deriveLocalStructureLayout(
        {
          ...structure,
          nodes: [...structure.nodes].reverse(),
          edges: [...structure.edges].reverse(),
        },
        "center",
        1,
        fullPositions,
      ),
    ).toEqual(local);
  });

  it("aligns missing local fallback positions to the retained center coordinate system", () => {
    const structure = directedStructure(
      "center",
      ["left", "center", "right"],
      [
        ["left", "center"],
        ["center", "right"],
      ],
    );
    const local = deriveLocalStructureLayout(structure, "center", 1, {
      center: { x: 1_000, y: 1_000 },
      left: { x: 0, y: 1_000 },
    })!;

    expect(local.positions.center).toEqual({ x: 1_000, y: 1_000 });
    expect(local.positions.left!.x).toBeLessThan(local.positions.center!.x);
    expect(local.positions.right!.x).toBeGreaterThan(local.positions.center!.x);
    expectNoNodeOverlap(local.positions);
  });

  it("derives a dense 50-Node local layout within a bounded unit-test budget", () => {
    const nodeIds = Array.from(
      { length: 50 },
      (_, index) => `node-${String(index).padStart(2, "0")}`,
    );
    const links = [
      ...nodeIds.slice(1).map((nodeId) => [nodeIds[0]!, nodeId] as const),
      ...nodeIds.flatMap((nodeId, index) =>
        Array.from(
          { length: 3 },
          (_, offset) => [nodeId, nodeIds[(index + offset + 1) % 50]!] as const,
        ),
      ),
    ];
    const structure = directedStructure(nodeIds[0]!, nodeIds, links);
    const fullPositions = Object.fromEntries(
      nodeIds.map((nodeId, index) => [
        nodeId,
        { x: (index % 10) * 600, y: Math.floor(index / 10) * 300 },
      ]),
    );
    const startedAt = performance.now();
    const local = deriveLocalStructureLayout(structure, nodeIds[0]!, 2, fullPositions)!;
    const elapsed = performance.now() - startedAt;

    expect(local.graph.nodes).toHaveLength(50);
    expectNoNodeOverlap(local.positions);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("retains surviving reviewer positions and places only new Nodes when a local graph changes", () => {
    const original = directedStructure("center", ["center", "left"], [["center", "left"]]);
    const previousLayout = deriveLocalStructureLayout(original, "center", 1, {
      center: { x: 600, y: 400 },
      left: { x: 300, y: 400 },
    })!;
    const previous = {
      ...previousLayout.positions,
      center: { x: 777, y: 333 },
      left: { x: 300, y: 444 },
    };
    const updated = directedStructure(
      "center",
      ["center", "left", "new-neighbor"],
      [
        ["center", "left"],
        ["center", "new-neighbor"],
      ],
    );
    const derived = deriveLocalStructureLayout(updated, "center", 1, {
      center: { x: 600, y: 400 },
      left: { x: 300, y: 400 },
      "new-neighbor": { x: 900, y: 400 },
    })!;
    const reconciled = reconcileDerivedLocalStructureLayout(derived, previous);

    expect(reconciled.center).toEqual(previous.center);
    expect(reconciled.left).toEqual(previous.left);
    expect(reconciled["new-neighbor"]).toBeDefined();
    expectNoNodeOverlap(reconciled);
    expect(
      reconcileDerivedLocalStructureLayout(derived, {
        ...previous,
        removed: { x: -1_000, y: -1_000 },
      }),
    ).toEqual(reconciled);
  });

  it("uses current local positions as the continuity basis across depth and center changes", () => {
    const structure = directedStructure(
      "a",
      ["a", "b", "c", "d", "e"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["d", "e"],
      ],
    );
    const fullPositions = {
      a: { x: 0, y: 0 },
      b: { x: 360, y: 0 },
      c: { x: 720, y: 0 },
      d: { x: 1_080, y: 0 },
      e: { x: 1_440, y: 0 },
    };
    const initialLocal = deriveLocalStructureLayout(structure, "b", 1, fullPositions)!;
    const reviewerPositions = {
      ...initialLocal.positions,
      a: { x: 90, y: 330 },
      b: { x: 510, y: 210 },
      c: { x: 880, y: 390 },
    };

    const depthTarget = deriveLocalStructureLayout(structure, "b", 2, fullPositions)!;
    const depthPositions = reconcileDerivedLocalStructureLayout(depthTarget, reviewerPositions);
    expect(depthPositions.a).toEqual(reviewerPositions.a);
    expect(depthPositions.b).toEqual(reviewerPositions.b);
    expect(depthPositions.c).toEqual(reviewerPositions.c);
    expect(depthPositions.d).toBeDefined();
    expectNoNodeOverlap(depthPositions);

    const centerTarget = deriveLocalStructureLayout(structure, "c", 1, fullPositions)!;
    const centerPositions = reconcileDerivedLocalStructureLayout(centerTarget, reviewerPositions);
    expect(centerPositions.b).toEqual(reviewerPositions.b);
    expect(centerPositions.c).toEqual(reviewerPositions.c);
    expect(centerPositions.d).toBeDefined();
    expect(centerPositions.a).toBeUndefined();
    expectNoNodeOverlap(centerPositions);
  });

  it("preserves common Node positions across current-value replacement", () => {
    const structure = structureWithHub();
    const initial = initialStructureLayout(structure);
    const moved = { ...initial, hub: { x: 777, y: 333 } };
    const updated: Structure = {
      ...structure,
      updatedAt: "2026-08-30T00:01:00.000Z",
      nodes: [
        ...structure.nodes.filter((node) => node.id !== "node-14"),
        {
          id: "node-new",
          label: "New",
          description: null,
          kind: null,
          notation: "plain",
          anchor: null,
        },
      ],
      edges: [
        ...structure.edges.filter((edge) => edge.to !== "node-14"),
        {
          id: "edge-new",
          from: "hub",
          to: "node-new",
          label: "uses",
          directed: true,
          anchors: [],
        },
      ],
    };
    const reconciled = reconcileStructureLayout(updated, moved);
    expect(reconciled.hub).toEqual({ x: 777, y: 333 });
    expect(reconciled["node-01"]).toEqual(initial["node-01"]);
    expect(reconciled["node-new"]).toBeDefined();
    expect(reconciled["node-14"]).toBeUndefined();
  });

  it("keeps a branched topology collision-free in topology-derived ranks", () => {
    const base = structureWithHub();
    const siblings = Array.from({ length: 11 }, (_, index) => ({
      id: `sibling-${String(index).padStart(2, "0")}`,
      label: `Sibling ${index}`,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    }));
    const structure: Structure = {
      ...base,
      originNodeId: "root",
      nodes: [
        {
          id: "root",
          label: "Root",
          description: null,
          kind: null,
          notation: "plain",
          anchor: null,
        },
        ...siblings,
        {
          id: "third-rank",
          label: "Third rank",
          description: null,
          kind: null,
          notation: "plain",
          anchor: null,
        },
      ],
      edges: [
        ...siblings.map((node) => ({
          id: `edge-${node.id}`,
          from: "root",
          to: node.id,
          label: "contains",
          directed: true,
          anchors: [],
        })),
        {
          id: "edge-third-rank",
          from: siblings[0]!.id,
          to: "third-rank",
          label: "contains",
          directed: true,
          anchors: [],
        },
      ],
    };
    const layout = initialStructureLayout(structure);
    expectNoNodeOverlap(layout);
    expect(siblings.every((node) => layout.root!.x < layout[node.id]!.x)).toBe(true);
    expect(layout[siblings[0]!.id]!.x).toBeLessThan(layout["third-rank"]!.x);
  });

  it("places newly added siblings without colliding with retained or new Nodes", () => {
    const base = structureWithHub();
    const original: Structure = { ...base, nodes: base.nodes.slice(0, 1), edges: [] };
    const previous = { hub: { x: 500, y: 300 } };
    const newNodes = Array.from({ length: 12 }, (_, index) => ({
      id: `new-${String(index).padStart(2, "0")}`,
      label: `New ${index}`,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    }));
    const updated: Structure = {
      ...original,
      nodes: [...original.nodes, ...newNodes],
      edges: newNodes.map((node) => ({
        id: `edge-${node.id}`,
        from: "hub",
        to: node.id,
        label: "contains",
        directed: true,
        anchors: [],
      })),
    };
    const reconciled = reconcileStructureLayout(updated, previous);
    expect(reconciled.hub).toEqual(previous.hub);
    expectNoNodeOverlap(reconciled);
    const added = newNodes.map((node) => reconciled[node.id]!);
    expect(Math.min(...added.map((point) => point.x))).toBeLessThan(previous.hub.x);
    expect(Math.max(...added.map((point) => point.x))).toBeGreaterThan(previous.hub.x);
    expect(Math.min(...added.map((point) => point.y))).toBeLessThan(previous.hub.y);
    expect(Math.max(...added.map((point) => point.y))).toBeGreaterThan(previous.hub.y);
  });

  it("keeps authored display content, parallel relations, and self-relations out of layout", () => {
    const base = structureWithHub();
    const layout = initialStructureLayout(base);
    const alternateProjectionInputs: Structure = {
      ...base,
      nodes: base.nodes.map((node) => ({
        ...node,
        label: `Changed ${node.label}`,
        description: "Different authored content",
        kind: "different-kind",
        notation: node.id === "hub" ? "database" : "component",
      })),
      edges: [
        ...base.edges.map((edge) => ({
          ...edge,
          label: `Changed ${edge.label}`,
        })),
        {
          id: "parallel",
          from: "hub",
          to: "node-01",
          label: "parallel claim",
          directed: true,
          anchors: [],
        },
        {
          id: "self",
          from: "hub",
          to: "hub",
          label: "self claim",
          directed: true,
          anchors: [],
        },
      ],
    };
    expect(initialStructureLayout(alternateProjectionInputs)).toEqual(layout);
  });

  it("uses the entrypoint and factual direction as a soft left-to-right tendency", () => {
    const base = structureWithHub();
    const nodes = ["entry", "parse", "execute", "persist", "peer"].map((id) => ({
      id,
      label: id,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    }));
    const structure: Structure = {
      ...base,
      originNodeId: "entry",
      nodes,
      edges: [
        {
          id: "entry-parse",
          from: "entry",
          to: "parse",
          label: "parses with",
          directed: true,
          anchors: [],
        },
        {
          id: "parse-execute",
          from: "parse",
          to: "execute",
          label: "invokes",
          directed: true,
          anchors: [],
        },
        {
          id: "execute-persist",
          from: "execute",
          to: "persist",
          label: "persists through",
          directed: true,
          anchors: [],
        },
        {
          id: "execute-peer",
          from: "execute",
          to: "peer",
          label: "shares a boundary with",
          directed: false,
          anchors: [],
        },
      ],
    };
    const layout = initialStructureLayout(structure);
    const projection = projectStructure(structure);
    expect(layout.entry!.x).toBeLessThan(layout.parse!.x);
    expect(layout.parse!.x).toBeLessThan(layout.execute!.x);
    expect(layout.execute!.x).toBeLessThan(layout.persist!.x);
    expect(Math.min(...projection.rankByNodeId.values())).toBe(0);
    expect(projection.diagnostics).toMatchObject({
      columnCount: 4,
      rowsPerColumn: [1, 1, 1, 2],
      maxRows: 2,
      nonForwardDirectionalLinkCount: 0,
    });
    expectNoNodeOverlap(layout);
    expect(initialStructureLayout(structure)).toEqual(layout);
    expect(
      projectStructure({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
      }),
    ).toEqual(projection);
  });

  it("moves across a strict-improvement plateau using directional neighbor ranks", () => {
    const structure = structureWithHub();
    structure.originNodeId = "entry";
    structure.nodes = ["entry", "parse", "execute", "persist"].map((id) => ({
      id,
      label: id,
      description: null,
      kind: null,
      notation: "plain",
      anchor: null,
    }));
    structure.edges = [
      {
        id: "entry-parse",
        from: "entry",
        to: "parse",
        label: "parses",
        directed: true,
        anchors: [],
      },
      {
        id: "parse-execute",
        from: "parse",
        to: "execute",
        label: "executes",
        directed: true,
        anchors: [],
      },
      {
        id: "execute-persist",
        from: "execute",
        to: "persist",
        label: "persists",
        directed: true,
        anchors: [],
      },
      {
        id: "entry-persist",
        from: "entry",
        to: "persist",
        label: "also persists",
        directed: true,
        anchors: [],
      },
    ];

    const projection = projectStructure(structure);
    expect(Object.fromEntries(projection.rankByNodeId)).toEqual({
      entry: 0,
      execute: 2,
      parse: 1,
      persist: 3,
    });
    expect(projection.diagnostics.nonForwardDirectionalLinkCount).toBe(0);
    expect(structureAuthoringWarnings(projection.diagnostics)).toEqual([]);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
      }),
    ).toEqual(initialStructureLayout(structure));
  });

  it("keeps an entrypoint and its direct successor on the factual side of a converging DAG", () => {
    const structure = directedStructure(
      "origin",
      ["origin", "b", "c", "d"],
      [
        ["origin", "b"],
        ["origin", "c"],
        ["origin", "d"],
        ["b", "c"],
        ["b", "d"],
      ],
    );
    const projection = projectStructure(structure);

    expect(projection.rankByNodeId.get("origin")).toBe(0);
    expect(projection.rankByNodeId.get("b")).toBe(1);
    expect(projection.rankByNodeId.get("c")).toBe(2);
    expect(projection.rankByNodeId.get("d")).toBe(2);
    expect(projection.diagnostics.nonForwardDirectionalLinkCount).toBe(0);
    expect(structureAuthoringWarnings(projection.diagnostics)).toEqual([]);
  });

  it("keeps every acyclic direct predecessor to the left of a terminal origin", () => {
    const structure = directedStructure(
      "origin",
      ["a", "b", "c", "origin"],
      [
        ["a", "b"],
        ["a", "c"],
        ["a", "origin"],
        ["b", "c"],
        ["c", "origin"],
      ],
    );
    const projection = projectStructure(structure);

    expect(Object.fromEntries(projection.rankByNodeId)).toEqual({
      a: -3,
      b: -2,
      c: -1,
      origin: 0,
    });
    expect(projection.diagnostics.nonForwardDirectionalLinkCount).toBe(0);
    const warnings = structureAuthoringWarnings(projection.diagnostics);
    expect(warnings.map(({ code }) => code)).toEqual([
      "STRUCTURE_ORIGIN_NO_OUTGOING_DIRECTIONAL_RELATION",
    ]);
    expect(warnings[0]?.message).toMatch(
      /behavior Structure.*code entrypoint.*file map.*single-file origin/s,
    );
  });

  it("does not warn for an acyclic entrypoint DAG with a forward layering", () => {
    const structure = directedStructure(
      "origin",
      ["origin", "b", "c", "d"],
      [
        ["origin", "b"],
        ["origin", "c"],
        ["b", "c"],
        ["c", "d"],
      ],
    );
    const projection = projectStructure(structure);

    expect(Object.fromEntries(projection.rankByNodeId)).toEqual({
      b: 1,
      c: 2,
      d: 3,
      origin: 0,
    });
    expect(projection.diagnostics.nonForwardDirectionalLinkCount).toBe(0);
    expect(projection.diagnostics.nonForwardDirectionalLinkRatio).toBe(0);
    expect(structureAuthoringWarnings(projection.diagnostics)).toEqual([]);
  });

  it("keeps logical DAG columns and warnings invariant when asymmetric Node IDs are renamed", () => {
    const logicalLinks = [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [1, 4],
      [2, 3],
      [3, 4],
    ] as const;
    const project = (idsByLogicalNode: readonly string[]) => {
      const structure = directedStructure(
        idsByLogicalNode[0]!,
        idsByLogicalNode,
        logicalLinks.map(([from, to]) => [idsByLogicalNode[from]!, idsByLogicalNode[to]!] as const),
      );
      const projection = projectStructure(structure);
      return {
        ranks: idsByLogicalNode.map((nodeId) => projection.rankByNodeId.get(nodeId)),
        columns: idsByLogicalNode.map((nodeId) => projection.columnIndexByNodeId.get(nodeId)),
        diagnostics: projection.diagnostics,
        warningCodes: structureAuthoringWarnings(projection.diagnostics).map(({ code }) => code),
      };
    };

    expect(project(["a", "b", "c", "d", "e"])).toEqual(project(["a", "d", "b", "c", "e"]));
  });

  it("uses ordinal stable-ID ordering for topology-symmetric Nodes", () => {
    const structure = structureWithHub();
    structure.originNodeId = "origin";
    structure.nodes = ["origin", "a_", "a-", "a", "A"].map((id) => ({
      id,
      label: id,
      description: null,
      kind: null,
      notation: "plain",
      anchor: null,
    }));
    structure.edges = structure.nodes.slice(1).map((node) => ({
      id: `origin-${node.id}`,
      from: "origin",
      to: node.id,
      label: "calls",
      directed: true,
      anchors: [],
    }));

    expect(projectStructure(structure).columns).toEqual([["origin"], ["A", "a", "a-", "a_"]]);
  });

  it("expands a terminal hub origin through multiple negative predecessor ranks", () => {
    const structure = terminalHubStructure();
    const projection = projectStructure(structure);
    const layout = initialStructureLayout(structure);
    const originColumn = projection.columnIndexByNodeId.get("hub")!;

    expect(projection.rankByNodeId.get("hub")).toBe(0);
    expect(projection.rankByNodeId.get("initialize")).toBe(-1);
    expect(projection.rankByNodeId.get("handler")).toBe(-2);
    expect(projection.rankByNodeId.get("source")).toBe(-4);
    expect(projection.columnIndexByNodeId.get("initialize")).toBeLessThan(originColumn);
    expect(projection.columnIndexByNodeId.get("source")).toBeLessThan(
      projection.columnIndexByNodeId.get("handler")!,
    );
    expect(projection.diagnostics).toMatchObject({
      columnCount: 5,
      rowsPerColumn: [1, 1, 4, 6, 1],
      maxRows: 6,
      directionalLinkCount: 19,
      nonForwardDirectionalLinkCount: 0,
      nonForwardDirectionalLinkRatio: 0,
      originOutgoingDirectionalLinkCount: 0,
    });
    expect(structureAuthoringWarnings(projection.diagnostics).map(({ code }) => code)).toEqual([
      "STRUCTURE_ORIGIN_NO_OUTGOING_DIRECTIONAL_RELATION",
    ]);
    expectNoNodeOverlap(layout);
    expect(Object.values(layout).every(({ x, y }) => Number.isFinite(x + y))).toBe(true);

    const shuffled: Structure = {
      ...structure,
      nodes: [...structure.nodes].reverse(),
      edges: [...structure.edges].reverse(),
    };
    expect(projectStructure(shuffled)).toEqual(projection);
    expect(initialStructureLayout(shuffled)).toEqual(layout);

    const alternatePresentation: Structure = {
      ...structure,
      nodes: structure.nodes.map((node) => ({
        ...node,
        label: `Changed ${node.label}`,
        description: `Changed ${node.description}`,
        notation: node.id === "hub" ? "database" : "component",
      })),
      edges: structure.edges.map((edge) => ({ ...edge, label: `Changed ${edge.label}` })),
    };
    expect(initialStructureLayout(alternatePresentation)).toEqual(layout);
  });

  it("derives directional ranks and diagnostics only from canonical pair-level topology", () => {
    const base = structureWithHub();
    const nodes = ["origin", "parallel", "reciprocal", "undirected", "self"].map((id) => ({
      id,
      label: id,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    }));
    const structure: Structure = {
      ...base,
      originNodeId: "origin",
      nodes,
      edges: [
        { ...base.edges[0]!, id: "parallel-a", from: "origin", to: "parallel" },
        { ...base.edges[0]!, id: "parallel-b", from: "origin", to: "parallel" },
        { ...base.edges[0]!, id: "reciprocal-a", from: "origin", to: "reciprocal" },
        { ...base.edges[0]!, id: "reciprocal-b", from: "reciprocal", to: "origin" },
        {
          ...base.edges[0]!,
          id: "undirected-a",
          from: "origin",
          to: "undirected",
        },
        {
          ...base.edges[0]!,
          id: "undirected-b",
          from: "origin",
          to: "undirected",
          directed: false,
        },
        { ...base.edges[0]!, id: "self", from: "self", to: "self" },
      ],
    };
    const topology = simpleStructureTopology(structure);
    const projection = projectStructure(structure);
    expect(topology.directionalLinks).toEqual([["origin", "parallel"]]);
    expect(projection.diagnostics.directionalLinkCount).toBe(1);
    expect(projection.diagnostics.originOutgoingDirectionalLinkCount).toBe(1);
    expect(projection.diagnostics.nonForwardDirectionalLinkCount).toBe(0);
    expect(projection.diagnostics.nonForwardDirectionalLinkRatio).toBe(0);

    const relabeled = {
      ...structure,
      edges: structure.edges.map((edge) => ({ ...edge, label: `long changed ${edge.label}` })),
    };
    expect(initialStructureLayout(relabeled)).toEqual(initialStructureLayout(structure));
  });

  it.each(["undirected", "reciprocal"] as const)(
    "preserves a directional chain beyond a %s bridge",
    (bridgeKind) => {
      const structure = directedStructure(
        "origin",
        ["origin", "next", "sink", "middle", "source"],
        [
          ["origin", "next"],
          ["source", "middle"],
          ["middle", "sink"],
        ],
      );
      structure.edges.push(
        {
          id: "bridge-forward",
          from: "origin",
          to: "sink",
          label: "relates",
          directed: bridgeKind === "reciprocal",
          anchors: [],
        },
        ...(bridgeKind === "reciprocal"
          ? [
              {
                id: "bridge-reverse",
                from: "sink",
                to: "origin",
                label: "relates",
                directed: true,
                anchors: [],
              },
            ]
          : []),
      );

      const projection = projectStructure(structure);
      expect(projection.rankByNodeId.get("source")).toBeLessThan(
        projection.rankByNodeId.get("middle")!,
      );
      expect(projection.rankByNodeId.get("middle")).toBeLessThan(
        projection.rankByNodeId.get("sink")!,
      );
      expect(projection.diagnostics.nonForwardDirectionalLinkCount).toBe(0);
      expect(structureAuthoringWarnings(projection.diagnostics)).toEqual([]);
      expect(
        projectStructure({
          ...structure,
          nodes: [...structure.nodes].reverse(),
          edges: [...structure.edges].reverse(),
        }),
      ).toEqual(projection);
    },
  );

  it("uses whole-graph SCC boundaries before stable IDs when choosing a cycle anchor", () => {
    const logicalLinks = [
      [0, 1],
      [1, 2],
      [1, 3],
      [2, 4],
      [3, 4],
      [4, 1],
    ] as const;
    const project = (idsByLogicalNode: readonly string[]) => {
      const structure = directedStructure(
        idsByLogicalNode[0]!,
        idsByLogicalNode,
        logicalLinks.map(([from, to]) => [idsByLogicalNode[from]!, idsByLogicalNode[to]!] as const),
      );
      const projection = projectStructure(structure);
      return {
        ranks: idsByLogicalNode.map((nodeId) => projection.rankByNodeId.get(nodeId)),
        columns: idsByLogicalNode.map((nodeId) => projection.columnIndexByNodeId.get(nodeId)),
        diagnostics: projection.diagnostics,
        warningCodes: structureAuthoringWarnings(projection.diagnostics).map(({ code }) => code),
      };
    };

    const first = project(["origin", "a", "b", "c", "d"]);
    const renamed = project(["origin", "b", "c", "d", "a"]);
    expect(first).toEqual(renamed);
    expect(first).toMatchObject({
      ranks: [0, 1, 2, 2, 3],
      warningCodes: [],
    });
  });

  it("uses structural rank profiles before stable IDs for a non-symmetric SCC", () => {
    const logicalNodes = [
      "p1",
      "p2",
      "origin",
      "A",
      "B",
      "C",
      "D",
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
    ] as const;
    const logicalLinks = [
      [0, 2],
      [0, 3],
      [0, 5],
      [1, 6],
      [2, 7],
      [2, 8],
      [2, 9],
      [2, 10],
      [2, 11],
      [2, 12],
      [3, 5],
      [5, 4],
      [4, 6],
      [5, 6],
      [6, 3],
    ] as const;
    const project = (cycleIds: readonly string[]) => {
      const ids = logicalNodes.map((logicalNode) => {
        const cycleIndex = ["A", "B", "C", "D"].indexOf(logicalNode);
        return cycleIndex === -1 ? logicalNode : cycleIds[cycleIndex]!;
      });
      const structure = directedStructure(
        "origin",
        ids,
        logicalLinks.map(([from, to]) => [ids[from]!, ids[to]!] as const),
      );
      const projection = projectStructure(structure);
      return {
        logicalRanks: ids.map((nodeId) => projection.rankByNodeId.get(nodeId)),
        diagnostics: projection.diagnostics,
        warningCodes: structureAuthoringWarnings(projection.diagnostics).map(({ code }) => code),
      };
    };

    const first = project(["a", "b", "c", "d"]);
    const renamed = project(["b", "c", "a", "d"]);
    expect(first).toEqual(renamed);
    expect(first).toMatchObject({
      logicalRanks: [-1, -1, 0, 0, 2, 1, 2, 1, 1, 1, 1, 1, 1],
      diagnostics: {
        rowsPerColumn: [2, 2, 7, 2],
        maxRows: 7,
      },
      warningCodes: [],
    });
  });

  it("colors ambiguous attachment endpoints from their whole-component context", () => {
    const logicalNodes = [
      "origin",
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "A",
      "B",
      "C",
    ] as const;
    const directionalLinks = [
      [0, 7],
      [1, 7],
      [2, 7],
      [3, 7],
      [4, 7],
      [5, 7],
      [6, 7],
      [7, 8],
      [8, 9],
      [9, 10],
      [10, 11],
      [12, 13],
      [13, 14],
      [14, 12],
    ] as const;
    const attachmentLinks = [
      [0, 12],
      [8, 13],
      [11, 14],
    ] as const;
    const project = (cycleIds: readonly string[]) => {
      const ids = logicalNodes.map((logicalNode) => {
        const cycleIndex = ["A", "B", "C"].indexOf(logicalNode);
        return cycleIndex === -1 ? logicalNode : cycleIds[cycleIndex]!;
      });
      const structure = directedStructure(
        "origin",
        ids,
        directionalLinks.map(([from, to]) => [ids[from]!, ids[to]!] as const),
      );
      structure.edges.push(
        ...attachmentLinks.map(([from, to], index) => ({
          id: `attachment-${index}`,
          from: ids[from]!,
          to: ids[to]!,
          label: "relates",
          directed: false,
          anchors: [],
        })),
      );
      const projection = projectStructure(structure);
      return {
        logicalRanks: ids.map((nodeId) => projection.rankByNodeId.get(nodeId)),
        diagnostics: projection.diagnostics,
        warningCodes: structureAuthoringWarnings(projection.diagnostics).map(({ code }) => code),
      };
    };

    const permutations = [
      ["a", "b", "c"],
      ["a", "c", "b"],
      ["b", "a", "c"],
      ["b", "c", "a"],
      ["c", "a", "b"],
      ["c", "b", "a"],
    ];
    const expected = project(permutations[0]!);
    for (const permutation of permutations.slice(1)) expect(project(permutation)).toEqual(expected);
    expect(expected).toMatchObject({
      diagnostics: {
        rowsPerColumn: [8, 2, 2, 1, 1, 1],
        maxRows: 8,
        directionalLinkCount: 14,
        nonForwardDirectionalLinkCount: 1,
        originOutgoingDirectionalLinkCount: 1,
      },
      warningCodes: ["STRUCTURE_LAYOUT_MAX_ROWS_HIGH"],
    });
    expect(expected.diagnostics.nonForwardDirectionalLinkRatio).toBeCloseTo(1 / 14);
  });

  it("emits canonical tall-column and non-forward-ratio warnings at their thresholds", () => {
    const isolated = structureWithHub();
    isolated.nodes = isolated.nodes.slice(0, 1);
    isolated.edges = [];
    expect(projectStructure(isolated).diagnostics.nonForwardDirectionalLinkRatio).toBe(0);

    const tall = structureWithHub();
    tall.nodes = tall.nodes.slice(0, 9);
    tall.edges = tall.edges.slice(0, 8);
    const tallWarnings = structureAuthoringWarnings(projectStructure(tall).diagnostics);
    expect(tallWarnings.map(({ code }) => code)).toEqual(["STRUCTURE_LAYOUT_MAX_ROWS_HIGH"]);

    const cycle = structureWithHub();
    cycle.originNodeId = "a";
    cycle.nodes = ["a", "b", "c"].map((id) => ({
      id,
      label: id,
      description: null,
      kind: null,
      notation: "plain",
      anchor: null,
    }));
    cycle.edges = [
      { id: "a-b", from: "a", to: "b", label: "calls", directed: true, anchors: [] },
      { id: "b-c", from: "b", to: "c", label: "calls", directed: true, anchors: [] },
      { id: "c-a", from: "c", to: "a", label: "calls", directed: true, anchors: [] },
    ];
    const cycleProjection = projectStructure(cycle);
    expect(cycleProjection.diagnostics.nonForwardDirectionalLinkCount).toBe(1);
    expect(cycleProjection.diagnostics.nonForwardDirectionalLinkRatio).toBeCloseTo(1 / 3);
    expect(structureAuthoringWarnings(cycleProjection.diagnostics).map(({ code }) => code)).toEqual(
      ["STRUCTURE_LAYOUT_NON_FORWARD_DIRECTIONAL_LINK_RATIO_HIGH"],
    );
  });

  it("keeps every inter-SCC directional link forward while isolating cycle non-forward links", () => {
    const structure = directedStructure(
      "entry",
      ["entry", "a", "b", "c", "persist"],
      [
        ["entry", "a"],
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
        ["c", "persist"],
      ],
    );
    const projection = projectStructure(structure);

    expect(projection.rankByNodeId.get("entry")).toBeLessThan(projection.rankByNodeId.get("a")!);
    expect(projection.rankByNodeId.get("c")).toBeLessThan(projection.rankByNodeId.get("persist")!);
    expect(projection.diagnostics.nonForwardDirectionalLinkCount).toBe(1);
  });

  it("keeps a 50-Node topology finite and collision-free", () => {
    const base = structureWithHub();
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      id: index === 0 ? "hub" : `node-${String(index).padStart(2, "0")}`,
      label: index === 0 ? "Hub" : `Node ${index}`,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    }));
    const structure: Structure = {
      ...base,
      nodes,
      edges: nodes.slice(1).map((node) => ({
        id: `edge-${node.id}`,
        from: "hub",
        to: node.id,
        label: "uses",
        directed: true,
        anchors: [],
      })),
    };
    const layout = initialStructureLayout(structure);
    expectNoNodeOverlap(layout);
    expect(Object.values(layout).every((point) => Number.isFinite(point.x + point.y))).toBe(true);
    expect(initialStructureLayout(structure)).toEqual(layout);
  });

  it("uses stable IDs only to resolve otherwise symmetric topology", () => {
    const base = structureWithHub();
    const structure: Structure = {
      ...base,
      nodes: base.nodes.slice(0, 5),
      edges: [
        {
          id: "incoming",
          from: "node-01",
          to: "hub",
          label: "enters",
          directed: true,
          anchors: [],
        },
        {
          id: "outgoing",
          from: "hub",
          to: "node-02",
          label: "leaves",
          directed: true,
          anchors: [],
        },
        {
          id: "undirected",
          from: "hub",
          to: "node-03",
          label: "peers with",
          directed: false,
          anchors: [],
        },
        {
          id: "reciprocal-a",
          from: "hub",
          to: "node-04",
          label: "sends",
          directed: true,
          anchors: [],
        },
        {
          id: "reciprocal-b",
          from: "node-04",
          to: "hub",
          label: "returns",
          directed: true,
          anchors: [],
        },
      ],
    };
    const layout = initialStructureLayout(structure);
    const reversedUndirected = initialStructureLayout({
      ...structure,
      edges: structure.edges.map((edge) =>
        edge.id === "undirected" ? { ...edge, from: edge.to, to: edge.from } : edge,
      ),
    });
    expect(reversedUndirected).toEqual(layout);
    expectNoNodeOverlap(layout);
  });

  it("keeps supported parallel and self-relation lanes within the route bounds", () => {
    const edges = Array.from({ length: 200 }, (_, index) => ({
      id: `edge-${String(index).padStart(3, "0")}`,
      from: index < 100 ? "left" : "self",
      to: index < 100 ? "right" : "self",
      label: "relates to",
      directed: true,
      anchors: [],
    }));
    const offsets = structureEdgeRouteOffsets(edges);
    expect(offsets.size).toBe(edges.length);
    expect(Math.max(...offsets.values())).toBeLessThanOrEqual(STRUCTURE_MAX_EDGE_LANE_OFFSET);
    expect(Math.min(...offsets.values())).toBeGreaterThanOrEqual(-STRUCTURE_MAX_EDGE_LANE_OFFSET);
    expect(new Set(edges.slice(0, 100).map((edge) => offsets.get(edge.id))).size).toBe(100);
    expect(new Set(edges.slice(100).map((edge) => offsets.get(edge.id))).size).toBe(100);
  });
});
