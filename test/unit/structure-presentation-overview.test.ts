import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import { buildStructurePresentationOverviewModel } from "../../src/web/components/StructurePresentationOverview.js";
import {
  buildStructureRegionCanvasModel,
  structureRegionCanvasStartBounds,
  StructureRegionCanvas,
  StructureRegionExactEdgeList,
} from "../../src/web/components/StructureRegionCanvas.js";
import { createContractStructures } from "../fixtures/contract/contract-structures.mjs";

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
      regions: [
        {
          id: "ingress",
          label: "Ingress",
          summary: "Ingress accepts and normalizes the request.",
          nodeIds: ["a", "b"],
        },
        {
          id: "policy",
          label: "Policy",
          summary: "Policy owns the review-relevant decision.",
          nodeIds: ["c", "d"],
        },
      ],
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

  it("keeps the authorial start independent from Region membership and ID order", () => {
    const structure = overviewStructure();
    structure.presentation = {
      thesis: "The policy areas are the useful chunks.",
      startNodeId: "c",
      primaryBackbone: null,
      regions: [
        {
          id: "z-ingress",
          label: "Ingress",
          summary: "Ingress accepts the request.",
          nodeIds: ["a", "b"],
        },
        {
          id: "a-policy",
          label: "Policy",
          summary: "Policy evaluates it.",
          nodeIds: ["c", "d"],
        },
      ],
    };

    const model = buildStructurePresentationOverviewModel(structure)!;

    expect(model.startNode).toMatchObject({ id: "c", isStart: true });
  });

  it("represents thesis and attention start without manufacturing a backbone or Regions", () => {
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

describe("Structure Region canvas model", () => {
  it("visibly disambiguates exact parallel Edge identities even without source anchors", () => {
    const parallelEdges: Structure["edges"] = [
      {
        id: "parallel-exact-a",
        from: "a",
        to: "b",
        label: "same factual predicate",
        directed: true,
        anchors: [],
      },
      {
        id: "parallel-exact-b",
        from: "a",
        to: "b",
        label: "same factual predicate",
        directed: true,
        anchors: [],
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(StructureRegionExactEdgeList, {
        edges: parallelEdges,
        nodeLabelsById: new Map([
          ["a", "Node A"],
          ["b", "Node B"],
        ]),
        onOpenEdge: () => undefined,
        onOpenEdgeSource: () => undefined,
      }),
    );

    expect(markup).toContain("Edge · parallel-exact-a");
    expect(markup).toContain("Edge · parallel-exact-b");
    expect(markup.match(/Node A → Node B: same factual predicate/gu)).toHaveLength(2);
    expect(markup.match(/sourceなし/gu)).toHaveLength(2);
  });

  it("targets either the assigned start Region or its explicit unassigned Context for Home", () => {
    const assigned = overviewStructure();
    const assignedModel = buildStructureRegionCanvasModel(assigned)!;
    const assignedBounds = structureRegionCanvasStartBounds(assigned, assignedModel)!;
    expect(assignedBounds.right - assignedBounds.left).toBe(232);
    expect(assignedBounds.bottom - assignedBounds.top).toBe(176);

    const unassigned = overviewStructure();
    unassigned.presentation = { ...unassigned.presentation!, startNodeId: "context" };
    const unassignedModel = buildStructureRegionCanvasModel(unassigned)!;
    const contextBounds = structureRegionCanvasStartBounds(unassigned, unassignedModel)!;
    expect(unassignedModel.regionOverview.startRegionId).toBeNull();
    expect(
      unassignedModel.contextSurface.contexts.some(({ nodeIds }) => nodeIds.includes("context")),
    ).toBe(true);
    expect(contextBounds.right - contextBounds.left).toBe(210);
    expect(contextBounds.bottom - contextBounds.top).toBe(104);
  });

  it("moves Region responsibilities and exact relations out of the Guide", () => {
    const model = buildStructureRegionCanvasModel(overviewStructure())!;

    expect(model.assignedNodeCount).toBe(4);
    expect(model.unassignedNodeCount).toBe(1);
    expect(model.regionOverview.regions.map(({ id, summary }) => ({ id, summary }))).toEqual([
      {
        id: "ingress",
        summary: "Ingress accepts and normalizes the request.",
      },
      { id: "policy", summary: "Policy owns the review-relevant decision." },
    ]);
    expect(model.regionOverview.directRelations).toEqual([
      expect.objectContaining({
        regionIds: ["ingress", "policy"],
        edgeIds: ["reverse"],
      }),
    ]);
  });

  it("keeps unassigned nodes visible as neutral Context components with exact boundaries", () => {
    const model = buildStructureRegionCanvasModel(overviewStructure())!;

    expect(model.contextSurface.contexts).toEqual([
      expect.objectContaining({ nodeIds: ["context"], adjacentRegionIds: ["ingress"] }),
    ]);
    expect(model.contextSurface.boundaryRelations).toEqual([
      expect.objectContaining({
        regionId: "ingress",
        edgeIds: ["context-edge"],
        directions: {
          fromRegionEdgeIds: [],
          fromUnassignedNodeEdgeIds: ["context-edge"],
          undirectedEdgeIds: [],
        },
      }),
    ]);
    expect(model.contextLayouts).toHaveLength(1);
  });

  it("is absent when there are no authored Regions", () => {
    const structure = overviewStructure();
    structure.presentation = { ...structure.presentation!, regions: [] };

    expect(buildStructureRegionCanvasModel(structure)).toBeNull();
  });

  it("keeps the four-Region dogfood surface compact without relation shelves", () => {
    const structure = createContractStructures({
      pullRequestId: "pr-1",
      baseOid: "a".repeat(40),
      firstHead: "b".repeat(40),
    })[0] as Structure;
    const model = buildStructureRegionCanvasModel(structure)!;
    const routeLength = (points: readonly { x: number; y: number }[]): number =>
      points.slice(1).reduce((total, point, index) => {
        const previous = points[index]!;
        return total + Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
      }, 0);
    const directRoutes = model.relationRoutes.filter(({ id }) => id.startsWith("region:"));
    const contextRoutes = model.relationRoutes.filter(({ id }) => id.startsWith("context:"));

    expect(model.regionOverview.regions).toHaveLength(4);
    expect(model.contextSurface.contexts).toHaveLength(1);
    expect(model.width).toBeLessThanOrEqual(1_150);
    expect(model.height).toBeLessThan(900);
    expect(model.relationRoutes.every(({ labelPlacement }) => labelPlacement !== "shelf")).toBe(
      true,
    );
    expect(Math.max(...directRoutes.map(({ points }) => routeLength(points)))).toBeLessThan(1_000);
    expect(Math.max(...contextRoutes.map(({ points }) => routeLength(points)))).toBeLessThan(1_000);
  });

  it("gives normal and Core Region arrowheads explicit theme-aware paint classes", () => {
    const markup = renderToStaticMarkup(
      createElement(StructureRegionCanvas, {
        structure: overviewStructure(),
        framedRegionId: null,
        onOpenRegion: () => undefined,
        onOpenContext: () => undefined,
        onOpenEdge: () => undefined,
        onOpenEdgeSource: () => undefined,
      }),
    );

    expect(markup).toContain('class="structure-region-map-arrowhead"');
    expect(markup).toContain('class="structure-region-map-arrowhead core"');
    expect(markup).toMatch(/marker-(?:start|end)="url\(#structure-region-[^"]+-core-arrow\)"/u);
    expect(markup).not.toContain("context-stroke");
  });
});
