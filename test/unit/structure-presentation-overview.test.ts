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
    nodes: ["a", "b", "c", "d", "context"].map((id) => ({
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
      {
        id: "context-edge",
        from: "context",
        to: "a",
        label: "configures",
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
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("Structure presentation overview", () => {
  it("keeps the Guide limited to the thesis and authorial start", () => {
    const model = buildStructurePresentationOverviewModel(overviewStructure())!;

    expect(model.thesis).toBe("These relations form one review-relevant boundary.");
    expect(model.startNode).toMatchObject({ id: "a", label: "Node A", isStart: true });
    expect(Object.keys(model).sort()).toEqual(["startNode", "thesis"]);
  });

  it("represents thesis and attention start without manufacturing a backbone or Regions", () => {
    const structure = overviewStructure();
    structure.presentation = {
      thesis: "Begin at the shared policy without inventing additional spatial structure.",
      startNodeId: "c",
      primaryBackbone: null,
    };

    const model = buildStructurePresentationOverviewModel(structure)!;

    expect(model.thesis).toBe(structure.presentation.thesis);
    expect(model.startNode).toMatchObject({ id: "c", isStart: true });
  });

  it("stays absent for the explicit topology-only fallback", () => {
    const structure = overviewStructure();
    structure.presentation = null;

    expect(buildStructurePresentationOverviewModel(structure)).toBeNull();
  });

  it("does not require a valid backbone to render the Guide", () => {
    const structure = overviewStructure();
    structure.presentation!.primaryBackbone!.edgeIds = ["missing-edge", "neutral"];

    const model = buildStructurePresentationOverviewModel(structure)!;

    expect(model).toMatchObject({ thesis: structure.presentation!.thesis, startNode: { id: "a" } });
  });
});
