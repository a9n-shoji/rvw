import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
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
    anchor: null,
  }));
  return {
    id: "70000000-0000-4000-8000-000000000001",
    ref: "rvw://structure/70000000-0000-4000-8000-000000000001",
    pullRequestId: "pr-1",
    sourceOid: "a".repeat(40),
    title: "Hub relationships",
    scope: "A bounded test graph.",
    initialFocus: "hub",
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

describe("Structure domain presentation rules", () => {
  it("round-trips stable Structure URIs", () => {
    const id = "70000000-0000-4000-8000-000000000001";
    expect(formatStructureUri(id)).toBe(`rvw://structure/${id}`);
    expect(parseStructureUri(formatStructureUri(id))).toBe(id);
    expect(() => parseStructureUri("rvw://structure/not-a-uuid")).toThrow(/URI/);
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
        { id: "node-new", label: "New", description: null, kind: null, anchor: null },
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

  it("keeps adjacent ranks separate when one rank needs multiple columns", () => {
    const base = structureWithHub();
    const siblings = Array.from({ length: 11 }, (_, index) => ({
      id: `sibling-${String(index).padStart(2, "0")}`,
      label: `Sibling ${index}`,
      description: null,
      kind: null,
      anchor: null,
    }));
    const structure: Structure = {
      ...base,
      initialFocus: null,
      nodes: [
        { id: "root", label: "Root", description: null, kind: null, anchor: null },
        ...siblings,
        { id: "third-rank", label: "Third rank", description: null, kind: null, anchor: null },
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
    expectNoNodeOverlap(initialStructureLayout(structure));
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
  });

  it("places incoming and outgoing relations on opposite sides of initial focus", () => {
    const base = structureWithHub();
    const structure: Structure = {
      ...base,
      edges: base.edges.map((edge) =>
        edge.to === "node-01" ? { ...edge, from: "node-01", to: "hub" } : edge,
      ),
    };
    const layout = initialStructureLayout(structure);
    expect(layout["node-01"]!.x).toBeLessThan(layout.hub!.x);
    expect(layout["node-02"]!.x).toBeGreaterThan(layout.hub!.x);
  });

  it("keeps undirected and reciprocal relations on a neutral rank", () => {
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
    expect(layout["node-01"]!.x).toBeLessThan(layout.hub!.x);
    expect(layout["node-02"]!.x).toBeGreaterThan(layout.hub!.x);
    expect(layout["node-03"]!.x).toBe(layout.hub!.x);
    expect(layout["node-04"]!.x).toBe(layout.hub!.x);

    const reversedUndirected = initialStructureLayout({
      ...structure,
      edges: structure.edges.map((edge) =>
        edge.id === "undirected" ? { ...edge, from: edge.to, to: edge.from } : edge,
      ),
    });
    expect(reversedUndirected).toEqual(layout);
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
