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
    scope: "A compact spatial explanation lens.",
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
      {
        id: "parallel",
        from: "a",
        to: "b",
        label: "observes",
        directed: true,
        anchors: [],
      },
    ],
    presentation: {
      thesis: "These relations form one review-relevant boundary.",
      startNodeId: "a",
      primaryBackbone: {
        edgeIds: ["reverse", "parallel", "forward", "neutral"],
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
  it("derives backbone Nodes from an unordered exact Edge set", () => {
    const model = buildStructurePresentationOverviewModel(overviewStructure())!;

    expect(model.startNode).toMatchObject({ id: "a", label: "Node A", isStart: true });
    expect(
      model.coreRelations.map(({ edgeId, label, directed, fromNode, toNode }) => ({
        edgeId,
        label,
        directed,
        from: fromNode.id,
        to: toNode.id,
      })),
    ).toEqual([
      { edgeId: "forward", label: "calls", directed: true, from: "a", to: "b" },
      { edgeId: "neutral", label: "shares policy with", directed: false, from: "c", to: "d" },
      { edgeId: "parallel", label: "observes", directed: true, from: "a", to: "b" },
      { edgeId: "reverse", label: "is consumed by", directed: true, from: "c", to: "b" },
    ]);
    expect(model.regions).toEqual([
      { index: 0, label: "Ingress", nodeIds: ["a", "b"], nodeCount: 2 },
      { index: 1, label: "Policy", nodeIds: ["c", "d"], nodeCount: 2 },
    ]);
  });

  it("keeps authorial start independent from canonical region order", () => {
    const structure = overviewStructure();
    structure.presentation = {
      thesis: "The policy areas are the useful chunks.",
      startNodeId: "c",
      primaryBackbone: null,
      regions: [
        { label: "Ingress", nodeIds: ["a", "b"] },
        { label: "Policy", nodeIds: ["c", "d"] },
      ],
    };

    const model = buildStructurePresentationOverviewModel(structure)!;

    expect(model.startNode).toMatchObject({ id: "c", isStart: true });
    expect(model.coreRelations).toEqual([]);
    expect(model.regions.map(({ label }) => label)).toEqual(["Ingress", "Policy"]);
  });

  it("represents thesis and attention start without manufacturing a backbone or regions", () => {
    const structure = overviewStructure();
    structure.presentation = {
      thesis: "Begin at the shared policy without inventing additional spatial structure.",
      startNodeId: "c",
      primaryBackbone: null,
      regions: [],
    };

    const model = buildStructurePresentationOverviewModel(structure)!;

    expect(model.thesis).toBe(structure.presentation.thesis);
    expect(model.startNode).toMatchObject({ id: "c", isStart: true });
    expect(model.coreRelations).toEqual([]);
    expect(model.regions).toEqual([]);
  });

  it("stays absent for the explicit topology-only fallback", () => {
    const structure = overviewStructure();
    structure.presentation = null;

    expect(buildStructurePresentationOverviewModel(structure)).toBeNull();
  });

  it("does not misassign a surviving exact relation when one referenced Edge is unavailable", () => {
    const structure = overviewStructure();
    structure.presentation!.primaryBackbone!.edgeIds = ["missing-edge", "reverse"];

    const model = buildStructurePresentationOverviewModel(structure)!;

    expect(model.startNode.id).toBe("a");
    expect(model.coreRelations.map(({ edgeId }) => edgeId)).toEqual(["reverse"]);
  });
});
