import { describe, expect, it } from "vitest";
import type { Structure, StructureEdge, StructureNode } from "../../src/domain/models.js";
import { closestMatchingStructureNode } from "../../src/domain/source-reference.js";

function node(id: string): StructureNode {
  return {
    id,
    label: id,
    description: null,
    kind: null,
    notation: "plain",
    anchor: null,
  };
}

function edge(id: string, from: string, to: string, directed = true): StructureEdge {
  return { id, from, to, label: id, directed, anchors: [] };
}

function graph(
  nodes: readonly string[],
  edges: StructureEdge[],
): Pick<Structure, "originNodeId" | "nodes" | "edges"> {
  return { originNodeId: "origin", nodes: nodes.map(node), edges };
}

describe("closestMatchingStructureNode", () => {
  it("selects the matching origin before every other Node", () => {
    const structure = graph(["origin", "near"], [edge("origin-near", "origin", "near")]);
    expect(closestMatchingStructureNode(structure, new Set(["near", "origin"]))?.id).toBe("origin");
  });

  it("selects the nearest matching Node by undirected hop count", () => {
    const structure = graph(
      ["origin", "near", "middle", "far"],
      [
        edge("origin-near", "origin", "near"),
        edge("origin-middle", "origin", "middle"),
        edge("middle-far", "middle", "far"),
      ],
    );
    expect(closestMatchingStructureNode(structure, new Set(["far", "near"]))?.id).toBe("near");
  });

  it("traverses directed Edges in both directions", () => {
    const structure = graph(
      ["origin", "incoming", "far"],
      [edge("incoming-origin", "incoming", "origin", true)],
    );
    expect(closestMatchingStructureNode(structure, new Set(["incoming", "far"]))?.id).toBe(
      "incoming",
    );
  });

  it("breaks equal-distance ties by stable Node ID", () => {
    const structure = graph(
      ["origin", "z-match", "a-match"],
      [edge("origin-z", "origin", "z-match"), edge("origin-a", "origin", "a-match")],
    );
    expect(closestMatchingStructureNode(structure, new Set(["z-match", "a-match"]))?.id).toBe(
      "a-match",
    );
  });

  it("sorts unreachable candidates after reachable candidates", () => {
    const structure = graph(
      ["origin", "reachable", "a-unreachable"],
      [edge("origin-reachable", "origin", "reachable")],
    );
    expect(
      closestMatchingStructureNode(structure, new Set(["a-unreachable", "reachable"]))?.id,
    ).toBe("reachable");
  });
});
