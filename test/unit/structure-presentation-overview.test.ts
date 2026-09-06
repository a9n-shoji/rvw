import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import { buildStructurePresentationOverviewModel } from "../../src/web/components/StructurePresentationOverview.js";

function overviewStructure(): Structure {
  return {
    id: "70000000-0000-4000-8000-000000000301",
    ref: "rvw://structure/70000000-0000-4000-8000-000000000301",
    pullRequestId: "pr-1",
    sourceOid: "a".repeat(40),
    title: "Presentation overview",
    scope: "A compact spatial reading lens.",
    originNodeId: "a",
    nodes: ["a", "b", "c", "d"].map((id) => ({
      id,
      label: `Node ${id.toUpperCase()}`,
      description: null,
      kind: null,
      notation: "plain",
      anchor: null,
    })),
    edges: [
      {
        id: "forward",
        from: "a",
        to: "b",
        label: "calls",
        directed: true,
        anchors: [],
      },
      {
        id: "reverse",
        from: "c",
        to: "b",
        label: "is consumed by",
        directed: true,
        anchors: [],
      },
      {
        id: "neutral",
        from: "c",
        to: "d",
        label: "shares policy with",
        directed: false,
        anchors: [],
      },
    ],
    presentation: {
      thesis: "These relations form one review-relevant boundary.",
      startNodeId: "a",
      primarySpine: {
        nodeIds: ["a", "b", "c", "d"],
        edgeIds: ["forward", "reverse", "neutral"],
      },
      regions: [
        { label: "Ingress", nodeIds: ["a", "b"] },
        { label: "Policy", nodeIds: ["c", "d"] },
      ],
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("Structure presentation overview", () => {
  it("keeps exact spine Edge labels and distinguishes factual direction from reading priority", () => {
    const model = buildStructurePresentationOverviewModel(overviewStructure())!;

    expect(model.startNode).toMatchObject({ id: "a", label: "Node A", isStart: true });
    expect(model.spineNodes.map(({ id }) => id)).toEqual(["a", "b", "c", "d"]);
    expect(
      model.spineConnections.map(({ edgeId, label, direction }) => ({
        edgeId,
        label,
        direction,
      })),
    ).toEqual([
      { edgeId: "forward", label: "calls", direction: "forward" },
      { edgeId: "reverse", label: "is consumed by", direction: "reverse" },
      { edgeId: "neutral", label: "shares policy with", direction: "undirected" },
    ]);
    expect(model.regions).toEqual([
      { label: "Ingress", nodeCount: 2 },
      { label: "Policy", nodeCount: 2 },
    ]);
  });

  it("represents a region-only presentation through its authorial start and ordered regions", () => {
    const structure = overviewStructure();
    structure.presentation = {
      thesis: "The policy areas are the useful chunks.",
      startNodeId: "c",
      primarySpine: null,
      regions: [
        { label: "Policy", nodeIds: ["c", "d"] },
        { label: "Ingress", nodeIds: ["a", "b"] },
      ],
    };

    const model = buildStructurePresentationOverviewModel(structure)!;

    expect(model.startNode).toMatchObject({ id: "c", isStart: true });
    expect(model.spineNodes).toEqual([]);
    expect(model.spineConnections).toEqual([]);
    expect(model.regions.map(({ label }) => label)).toEqual(["Policy", "Ingress"]);
  });

  it("stays absent for the explicit topology-only fallback", () => {
    const structure = overviewStructure();
    structure.presentation = null;

    expect(buildStructurePresentationOverviewModel(structure)).toBeNull();
  });

  it("does not shift later exact Edges onto the wrong node pair when persisted spine data is stale", () => {
    const structure = overviewStructure();
    structure.presentation!.primarySpine!.edgeIds[0] = "missing-edge";

    const model = buildStructurePresentationOverviewModel(structure)!;

    expect(model.startNode.id).toBe("a");
    expect(model.spineNodes).toEqual([]);
    expect(model.spineConnections).toEqual([]);
  });
});
