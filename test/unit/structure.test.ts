import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import { formatStructureUri, parseStructureUri } from "../../src/domain/structure-uri.js";
import {
  collapsedStructureRelations,
  initialStructureLayout,
  reconcileStructureLayout,
  STRUCTURE_MAX_EDGE_LANE_OFFSET,
  structureEdgeRouteOffsets,
  structureNeighborhood,
  visibleStructureGraph,
} from "../../src/web/structure-graph.js";

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

  it("selects collapsed relations by stable Edge ID, independent of content", () => {
    const structure = structureWithHub();
    const initial = collapsedStructureRelations(structure, "hub", false);
    expect(initial.collapsed).toBe(true);
    expect([...initial.visibleEdgeIds]).toEqual(["edge-01", "edge-02", "edge-03", "edge-04"]);

    const changedClaims: Structure = {
      ...structure,
      nodes: structure.nodes.map((node) => ({
        ...node,
        label: `rewritten ${node.label}`,
        kind: "different-kind",
      })),
      edges: structure.edges.map((edge) => ({ ...edge, label: `rewritten ${edge.label}` })),
    };
    expect([...collapsedStructureRelations(changedClaims, "hub", false).visibleEdgeIds]).toEqual([
      ...initial.visibleEdgeIds,
    ]);
    expect(collapsedStructureRelations(structure, "hub", true).hiddenEdgeIds.size).toBe(0);
  });

  it("supports local neighborhoods without deleting the semantic graph", () => {
    const structure = structureWithHub();
    expect(structureNeighborhood(structure, "node-01", 1)).toEqual(new Set(["node-01", "hub"]));
    expect(structureNeighborhood(structure, "node-01", 2).size).toBe(structure.nodes.length);
    const visible = visibleStructureGraph(structure, "hub", 1, false);
    expect(visible.nodeIds.size).toBe(5);
    expect(visible.edgeIds.size).toBe(4);
    expect(visible.hiddenRelationCount).toBe(10);
    expect(visibleStructureGraph(structure, "hub", "all", false).nodeIds.size).toBe(
      structure.nodes.length,
    );
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

  it("keeps dense parallel and self-relation lanes within the readable canvas", () => {
    const edges = Array.from({ length: 5_000 }, (_, index) => ({
      id: `edge-${String(index).padStart(4, "0")}`,
      from: index < 2_500 ? "left" : "self",
      to: index < 2_500 ? "right" : "self",
      label: "relates to",
      directed: true,
      anchors: [],
    }));
    const offsets = structureEdgeRouteOffsets(edges);
    expect(offsets.size).toBe(edges.length);
    expect(Math.max(...offsets.values())).toBeLessThanOrEqual(STRUCTURE_MAX_EDGE_LANE_OFFSET);
    expect(Math.min(...offsets.values())).toBeGreaterThanOrEqual(-STRUCTURE_MAX_EDGE_LANE_OFFSET);
    expect(new Set(edges.slice(0, 2_500).map((edge) => offsets.get(edge.id))).size).toBe(2_500);
    expect(new Set(edges.slice(2_500).map((edge) => offsets.get(edge.id))).size).toBe(2_500);
  });
});
