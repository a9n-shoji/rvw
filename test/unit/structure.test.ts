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
  initialStructureLayout,
  reconcileStructureLayout,
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
  STRUCTURE_MAX_EDGE_LANE_OFFSET,
  structureEdgeRouteOffsets,
  structureNeighborhood,
  visibleStructureGraph,
} from "../../src/web/structure-graph.js";

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
      primarySpine: {
        nodeIds: ["receive", "decide", "respond"],
        edgeIds: ["receive-decide", "decide-respond"],
      },
      regions: [
        { label: "Input", nodeIds: ["receive", "input-detail"] },
        { label: "Policy", nodeIds: ["policy-detail"] },
        { label: "Output", nodeIds: ["respond", "output-detail"] },
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
    const spine = structure.presentation!.primarySpine!.nodeIds.map((nodeId) => layout[nodeId]!);
    expect(spine.map(({ y }) => y)).toEqual([spine[0]!.y, spine[0]!.y, spine[0]!.y]);
    expect(spine[0]!.x).toBeLessThan(spine[1]!.x);
    expect(spine[1]!.x).toBeLessThan(spine[2]!.x);
    expect(Object.keys(layout).sort()).toEqual(structure.nodes.map(({ id }) => id).sort());
    expectNoNodeOverlap(layout);

    const regionBounds = structure.presentation!.regions.map((region) => ({
      left: Math.min(...region.nodeIds.map((nodeId) => layout[nodeId]!.x)),
      right: Math.max(...region.nodeIds.map((nodeId) => layout[nodeId]!.x + STRUCTURE_NODE_WIDTH)),
    }));
    expect(regionBounds[0]!.right).toBeLessThan(regionBounds[1]!.left);
    expect(regionBounds[1]!.right).toBeLessThan(regionBounds[2]!.left);
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

  it("keeps factual authoring diagnostics independent from a reverse reading spine", () => {
    const structure = directedStructure(
      "consumer",
      ["contract", "consumer"],
      [["consumer", "contract"]],
    );
    structure.presentation = {
      thesis: "Read the contract before the consumer that depends on it.",
      startNodeId: "contract",
      primarySpine: {
        nodeIds: ["contract", "consumer"],
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
      primarySpine: null,
      regions: [{ label: "Starting point", nodeIds: ["root"] }],
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

  it("reserves an intervening region across an unassigned spine Node", () => {
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
      primarySpine: {
        nodeIds: ["A", "X", "B"],
        edgeIds: ["edge-0", "edge-1"],
      },
      regions: [
        { label: "Before", nodeIds: ["A"] },
        { label: "Policies", nodeIds: regionNodeIds },
        { label: "After", nodeIds: ["B"] },
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

    expect(regionBounds[0]!.right).toBeLessThan(regionBounds[1]!.left);
    expect(regionBounds[1]!.right).toBeLessThan(regionBounds[2]!.left);
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
        primarySpine: null,
        regions: [{ label: "Policies", nodeIds: ["hub", ...policyIds] }],
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

  it("wraps twelve ordered regions into a bounded row-major surface", () => {
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
      thesis: "The hub coordinates twelve ordered policy chunks.",
      startNodeId: "hub",
      primarySpine: null,
      regions: Array.from({ length: 12 }, (_, regionIndex) => ({
        label: `Region ${regionIndex}`,
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
      if (index === 0) continue;
      const previous = bounds[index - 1]!;
      const sameRow = current.top === previous.top;
      if (sameRow) {
        expect(current.left).toBeGreaterThan(previous.right);
      } else {
        expect(current.top).toBeGreaterThan(previous.bottom);
        expect(current.left).toBeLessThan(previous.left);
      }
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
    expect(Math.max(width / height, height / width)).toBeLessThanOrEqual(2);
    expectNoNodeOverlap(layout);
    expect(
      initialStructureLayout({
        ...structure,
        nodes: [...structure.nodes].reverse(),
        edges: [...structure.edges].reverse(),
      }),
    ).toEqual(layout);
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
    expect(structureAuthoringWarnings(projection.diagnostics).map(({ code }) => code)).toEqual([
      "STRUCTURE_ORIGIN_NO_OUTGOING_DIRECTIONAL_RELATION",
    ]);
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
