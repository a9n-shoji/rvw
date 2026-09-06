import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import { buildStructureRegionCanvasModel } from "../../src/web/components/StructureRegionCanvas.js";

function nearLimitRegionStructure(): Structure {
  const regionNodeIds = Array.from({ length: 12 }, (_, index) => `region-node-${index}`);
  const contextNodeIds = Array.from({ length: 38 }, (_, index) => `context-node-${index}`);
  const relationPairs = regionNodeIds.flatMap((regionNodeId) =>
    contextNodeIds.map((contextNodeId) => [regionNodeId, contextNodeId] as const),
  );
  const edges: Structure["edges"] = [
    ...regionNodeIds.slice(1).map((nodeId, index) => ({
      id: `region-chain-${index}`,
      from: regionNodeIds[index]!,
      to: nodeId,
      label: "hands off to",
      directed: true,
      anchors: [],
    })),
    ...relationPairs.slice(0, 189).map(([regionNodeId, contextNodeId], index) => ({
      id: `boundary-${index.toString().padStart(3, "0")}`,
      from: index % 2 === 0 ? regionNodeId : contextNodeId,
      to: index % 2 === 0 ? contextNodeId : regionNodeId,
      label: index % 3 === 0 ? "configures" : "observes",
      directed: true,
      anchors: [],
    })),
  ];
  return {
    id: "79000000-0000-4000-8000-000000000001",
    ref: "rvw://structure/79000000-0000-4000-8000-000000000001",
    pullRequestId: "pr-1",
    sourceOid: "a".repeat(40),
    title: "Near-limit Region map",
    scope: "Exercises the valid maximum-size Region and Context relationship surface.",
    originNodeId: regionNodeIds[0]!,
    nodes: [...regionNodeIds, ...contextNodeIds].map((id) => ({
      id,
      label: id,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    })),
    edges,
    presentation: {
      thesis: "A dense but valid map must not freeze the viewer.",
      startNodeId: regionNodeIds[0]!,
      primaryBackbone: { edgeIds: edges.slice(0, 11).map(({ id }) => id) },
      regions: regionNodeIds.map((nodeId, index) => ({
        id: `region-${index.toString().padStart(2, "0")}`,
        label: `Region ${index}`,
        summary: `Responsibility ${index}`,
        nodeIds: [nodeId],
      })),
    },
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
}

describe("Structure Region routing performance", () => {
  it("keeps a valid near-limit Region and Context surface bounded", () => {
    const startedAt = performance.now();
    const model = buildStructureRegionCanvasModel(nearLimitRegionStructure())!;
    const elapsed = performance.now() - startedAt;

    expect(model.regionOverview.regions).toHaveLength(12);
    expect(model.contextSurface.contexts).toHaveLength(38);
    expect(model.regionOverview.directRelations).toHaveLength(11);
    expect(model.contextSurface.boundaryRelations).toHaveLength(189);
    expect(model.relationRoutes).toHaveLength(200);
    expect(model.relationRoutes.every(({ labelPlacement }) => labelPlacement === "shelf")).toBe(
      true,
    );
    expect(elapsed).toBeLessThan(2_000);
  }, 120_000);
});
