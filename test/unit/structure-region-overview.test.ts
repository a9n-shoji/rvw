import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import {
  buildContextRegionRelationLabel,
  buildDirectRegionRelationLabel,
} from "../../src/web/components/StructureRegionCanvas.js";
import {
  aggregateStructureRegionOverview,
  deriveStructureRegionContextSurface,
  layoutStructureRegionOverview,
  routeStructureRegionOverviewRelations,
  structureRegionMarkers,
  STRUCTURE_REGION_OVERVIEW_COLUMN_GAP,
  STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE,
  STRUCTURE_REGION_OVERVIEW_RELATION_LABEL_WIDTH,
  STRUCTURE_REGION_OVERVIEW_ROW_GAP,
  STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY,
} from "../../src/web/structure-region-overview.js";
import { structureTextUnits } from "../../src/web/structure-render-model.js";

interface TestRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function testCard(id: string, x: number, y: number) {
  return { id, center: { x, y }, width: 180, height: 100 };
}

function cardRect(card: ReturnType<typeof testCard>): TestRect {
  return {
    left: card.center.x - card.width / 2,
    top: card.center.y - card.height / 2,
    right: card.center.x + card.width / 2,
    bottom: card.center.y + card.height / 2,
  };
}

function testRectsOverlap(left: TestRect, right: TestRect): boolean {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
}

function segmentEntersRect(
  first: { x: number; y: number },
  second: { x: number; y: number },
  rect: TestRect,
): boolean {
  if (first.y === second.y) {
    return (
      first.y > rect.top &&
      first.y < rect.bottom &&
      Math.min(first.x, second.x) < rect.right &&
      Math.max(first.x, second.x) > rect.left
    );
  }
  if (first.x === second.x) {
    return (
      first.x > rect.left &&
      first.x < rect.right &&
      Math.min(first.y, second.y) < rect.bottom &&
      Math.max(first.y, second.y) > rect.top
    );
  }
  return true;
}

function regionStructure(): Structure {
  const node = (id: string) => ({
    id,
    label: id,
    description: null,
    kind: null,
    notation: "plain" as const,
    anchor: null,
  });
  const edge = (
    id: string,
    from: string,
    to: string,
    directed = true,
  ): Structure["edges"][number] => ({ id, from, to, directed, label: id, anchors: [] });
  return {
    id: "70000000-0000-4000-8000-000000000401",
    ref: "rvw://structure/70000000-0000-4000-8000-000000000401",
    pullRequestId: "pr-1",
    sourceOid: "a".repeat(40),
    title: "Region relationships",
    scope: "Direct factual relations across spatial chunks.",
    originNodeId: "a1",
    nodes: ["a1", "a2", "b1", "c1", "u1", "u2", "isolated"].map(node),
    edges: [
      edge("internal-a", "a1", "a2"),
      edge("a-to-b", "a2", "b1"),
      edge("b-to-a", "b1", "a1"),
      edge("a-b-neutral", "a1", "b1", false),
      edge("b-to-c", "b1", "c1"),
      edge("a-to-u", "a1", "u1"),
      edge("u-to-c", "u2", "c1"),
      edge("u-bridge", "u1", "u2", false),
    ],
    presentation: {
      thesis: "Regions keep direct relationships distinct from unassigned bridges.",
      startNodeId: "a1",
      primaryBackbone: { edgeIds: ["b-to-a", "b-to-c", "a-to-u", "u-bridge"] },
      regions: [
        { id: "region-c", label: "C", summary: "C summary", nodeIds: ["c1"] },
        { id: "region-a", label: "A", summary: "A summary", nodeIds: ["a2", "a1"] },
        { id: "region-b", label: "B", summary: "B summary", nodeIds: ["b1"] },
      ],
    },
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
}

describe("Structure Region overview derivation", () => {
  it("aggregates exact direct Edges by unordered Region pair and preserves direction", () => {
    const model = aggregateStructureRegionOverview(regionStructure())!;

    expect(model.startRegionId).toBe("region-a");
    expect(model.regions).toEqual([
      {
        id: "region-a",
        label: "A",
        summary: "A summary",
        nodeIds: ["a1", "a2"],
        nodeCount: 2,
        internalEdgeIds: ["internal-a"],
        boundaryEdgeIds: ["a-b-neutral", "a-to-b", "a-to-u", "b-to-a"],
        backboneEdgeIds: ["a-to-u", "b-to-a"],
        adjacentRegionIds: ["region-b"],
        unassignedNeighborNodeIds: ["u1"],
      },
      expect.objectContaining({
        id: "region-b",
        adjacentRegionIds: ["region-a", "region-c"],
      }),
      expect.objectContaining({
        id: "region-c",
        adjacentRegionIds: ["region-b"],
        unassignedNeighborNodeIds: ["u2"],
      }),
    ]);
    expect(model.directRelations).toEqual([
      {
        regionIds: ["region-a", "region-b"],
        edgeIds: ["a-b-neutral", "a-to-b", "b-to-a"],
        backboneEdgeIds: ["b-to-a"],
        directions: {
          fromFirstRegionEdgeIds: ["a-to-b"],
          fromSecondRegionEdgeIds: ["b-to-a"],
          undirectedEdgeIds: ["a-b-neutral"],
        },
      },
      {
        regionIds: ["region-b", "region-c"],
        edgeIds: ["b-to-c"],
        backboneEdgeIds: ["b-to-c"],
        directions: {
          fromFirstRegionEdgeIds: ["b-to-c"],
          fromSecondRegionEdgeIds: [],
          undirectedEdgeIds: [],
        },
      },
    ]);
  });

  it("keeps predicate direction and partial Core membership explicit inside an aggregate pill", () => {
    const model = aggregateStructureRegionOverview(regionStructure())!;
    const relation = model.directRelations.find(
      ({ regionIds }) => regionIds[0] === "region-a" && regionIds[1] === "region-b",
    )!;
    const label = buildDirectRegionRelationLabel(
      relation,
      new Map([
        ["a-b-neutral", "同じ判断境界を共有する"],
        ["a-to-b", "delegates"],
        ["b-to-a", "returns"],
      ]),
      new Map([
        ["region-a", "Application coordination"],
        ["region-b", "Domain and remote effects"],
      ]),
    );
    const visible = label.lines.join("\n");

    expect(label.full).toContain(
      "Application coordination — Domain and remote effects: 同じ判断境界を共有する",
    );
    expect(label.full).toContain("Application coordination → Domain and remote effects: delegates");
    expect(label.full).toContain(
      "Domain and remote effects → Application coordination: returns (Core)",
    );
    expect(visible).toContain("3 exact Edges · Core 1/3");
    expect(label.lines.every((line) => structureTextUnits(line) <= 17)).toBe(true);
  });

  it("keeps an unassigned bridge explicit instead of synthesizing a transitive Region link", () => {
    const structure = regionStructure();
    structure.edges = structure.edges.filter(
      ({ id }) => id !== "a-to-b" && id !== "b-to-a" && id !== "a-b-neutral" && id !== "b-to-c",
    );
    const model = aggregateStructureRegionOverview(structure)!;

    expect(model.directRelations).toEqual([]);
    expect(model.unassignedBoundaries).toEqual([
      {
        regionId: "region-a",
        unassignedNodeId: "u1",
        edgeIds: ["a-to-u"],
        backboneEdgeIds: ["a-to-u"],
        directions: {
          fromRegionEdgeIds: ["a-to-u"],
          fromUnassignedNodeEdgeIds: [],
          undirectedEdgeIds: [],
        },
      },
      {
        regionId: "region-c",
        unassignedNodeId: "u2",
        edgeIds: ["u-to-c"],
        backboneEdgeIds: [],
        directions: {
          fromRegionEdgeIds: [],
          fromUnassignedNodeEdgeIds: ["u-to-c"],
          undirectedEdgeIds: [],
        },
      },
    ]);
    expect(model.unassignedComponents).toEqual([
      {
        nodeIds: ["isolated"],
        internalEdgeIds: [],
        boundaryEdgeIds: [],
        backboneEdgeIds: [],
        adjacentRegionIds: [],
      },
      {
        nodeIds: ["u1", "u2"],
        internalEdgeIds: ["u-bridge"],
        boundaryEdgeIds: ["a-to-u", "u-to-c"],
        backboneEdgeIds: ["a-to-u", "u-bridge"],
        adjacentRegionIds: ["region-a", "region-c"],
      },
    ]);

    const contextSurface = deriveStructureRegionContextSurface(model);
    const bridge = contextSurface.contexts.find((context) => context.nodeIds.includes("u1"))!;
    expect(contextSurface.boundaryRelations).toEqual([
      expect.objectContaining({
        contextId: bridge.id,
        regionId: "region-a",
        edgeIds: ["a-to-u"],
        directions: {
          fromRegionEdgeIds: ["a-to-u"],
          fromUnassignedNodeEdgeIds: [],
          undirectedEdgeIds: [],
        },
      }),
      expect.objectContaining({
        contextId: bridge.id,
        regionId: "region-c",
        edgeIds: ["u-to-c"],
        directions: {
          fromRegionEdgeIds: [],
          fromUnassignedNodeEdgeIds: ["u-to-c"],
          undirectedEdgeIds: [],
        },
      }),
    ]);
    const contextToRegion = contextSurface.boundaryRelations.find(
      ({ regionId }) => regionId === "region-c",
    )!;
    const label = buildContextRegionRelationLabel(
      contextToRegion,
      new Map([["u-to-c", "provides recovery state"]]),
      new Map([["region-c", "Recovery decision"]]),
    );
    expect(label.full).toBe("Context → Recovery decision: provides recovery state");
    expect(label.lines.join(" ")).toContain("Context →");
  });

  it("is invariant to Region, member, Node, Edge, and backbone array order", () => {
    const structure = regionStructure();
    const model = aggregateStructureRegionOverview(structure);
    const reversed: Structure = {
      ...structure,
      nodes: [...structure.nodes].reverse(),
      edges: [...structure.edges].reverse(),
      presentation: {
        ...structure.presentation!,
        primaryBackbone: {
          edgeIds: [...structure.presentation!.primaryBackbone!.edgeIds].reverse(),
        },
        regions: [...structure.presentation!.regions]
          .reverse()
          .map((region) => ({ ...region, nodeIds: [...region.nodeIds].reverse() })),
      },
    };

    expect(aggregateStructureRegionOverview(reversed)).toEqual(model);
    expect(layoutStructureRegionOverview(aggregateStructureRegionOverview(reversed)!)).toEqual(
      layoutStructureRegionOverview(model!),
    );
  });

  it("keeps direct and backbone-connected Regions near in a bounded 2D mini-map", () => {
    const structure = regionStructure();
    const extraRegionIds = ["region-d", "region-e", "region-f", "region-g", "region-h"];
    for (const regionId of extraRegionIds) {
      const nodeId = `${regionId}-node`;
      structure.nodes.push({
        id: nodeId,
        label: nodeId,
        description: null,
        kind: null,
        notation: "plain",
        anchor: null,
      });
      structure.presentation!.regions.push({
        id: regionId,
        label: regionId,
        summary: `${regionId} summary`,
        nodeIds: [nodeId],
      });
      structure.edges.push({
        id: `a-to-${regionId}`,
        from: "a1",
        to: nodeId,
        label: "fans out",
        directed: true,
        anchors: [],
      });
    }
    const model = aggregateStructureRegionOverview(structure)!;
    const layout = layoutStructureRegionOverview(model);
    const cellById = new Map(
      layout.regions.map(({ regionId, column, row }) => [regionId, { column, row }]),
    );
    const start = cellById.get("region-a")!;

    expect(layout.regions).toHaveLength(8);
    expect(layout.columnCount).toBeLessThanOrEqual(4);
    expect(layout.rowCount).toBeGreaterThan(1);
    expect(start.column).toBe(0);
    expect(Math.abs(start.row - (layout.rowCount - 1) / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.max(layout.width / layout.height, layout.height / layout.width)).toBeLessThan(2.5);
    for (const regionId of extraRegionIds) {
      const cell = cellById.get(regionId)!;
      expect(
        Math.abs(cell.column - start.column) + Math.abs(cell.row - start.row),
      ).toBeLessThanOrEqual(3);
    }
    expect(
      layout.directRelations.every(({ firstCenter, secondCenter }) =>
        Number.isFinite(firstCenter.x + firstCenter.y + secondCenter.x + secondCenter.y),
      ),
    ).toBe(true);
    expect(STRUCTURE_REGION_OVERVIEW_COLUMN_GAP).toBeGreaterThanOrEqual(
      STRUCTURE_REGION_OVERVIEW_RELATION_LABEL_WIDTH +
        2 * (STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE + STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY),
    );
    expect(STRUCTURE_REGION_OVERVIEW_ROW_GAP).toBeGreaterThanOrEqual(70);
  });

  it("routes a long Region relation around non-endpoint responsibility cards", () => {
    const cards = [
      testCard("region-a", 120, 100),
      testCard("region-b", 360, 100),
      testCard("region-c", 600, 100),
      testCard("region-d", 120, 330),
      testCard("region-e", 600, 330),
    ];
    const routing = routeStructureRegionOverviewRelations({
      cards,
      relations: [
        {
          id: "a-to-c",
          fromCardId: "region-a",
          toCardId: "region-c",
          labelWidth: 200,
          labelHeight: 46,
        },
      ],
      width: 720,
      height: 460,
    });
    const route = routing.routes[0]!;
    const middleCard = cardRect(cards[1]!);

    expect(route.points.length).toBeGreaterThan(2);
    expect(
      route.points
        .slice(1)
        .some((point, index) => segmentEntersRect(route.points[index]!, point, middleCard)),
    ).toBe(false);
    expect(
      route.points.slice(1).every((point, index) => {
        const previous = route.points[index]!;
        return previous.x === point.x || previous.y === point.y;
      }),
    ).toBe(true);
  });

  it("keeps on-route labels far enough from endpoint arrowheads to expose a terminal shaft", () => {
    const labelWidth = 200;
    const labelHeight = 46;
    const terminalGap =
      STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE + STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY;
    const cards = [testCard("left", 100, 100), testCard("right", 100 + 180 + 272, 100)];
    const routing = routeStructureRegionOverviewRelations({
      cards,
      relations: [
        {
          id: "left-to-right",
          fromCardId: "left",
          toCardId: "right",
          labelWidth,
          labelHeight,
        },
      ],
      width: 652,
      height: 220,
    });
    const route = routing.routes[0]!;
    const leftLabelEdge = route.labelCenter.x - labelWidth / 2;
    const rightLabelEdge = route.labelCenter.x + labelWidth / 2;

    expect(route.labelPlacement).toBe("route");
    expect(leftLabelEdge - route.points[0]!.x).toBeGreaterThanOrEqual(terminalGap);
    expect(route.points.at(-1)!.x - rightLabelEdge).toBeGreaterThanOrEqual(terminalGap);
  });

  it("moves a relation pill off-route when a short card gap cannot preserve arrowhead runway", () => {
    const cards = [testCard("left", 100, 100), testCard("right", 100 + 180 + 224, 100)];
    const routing = routeStructureRegionOverviewRelations({
      cards,
      relations: [
        {
          id: "left-to-right",
          fromCardId: "left",
          toCardId: "right",
          labelWidth: 200,
          labelHeight: 46,
        },
      ],
      width: 604,
      height: 260,
    });
    const route = routing.routes[0]!;

    expect(route.labelPlacement).toBe("offset");
    expect(route.labelLeaderPoints).toHaveLength(2);
  });

  it("separates the coincident midpoints of crossing diagonal relations", () => {
    const cards = [
      testCard("a", 120, 100),
      testCard("b", 500, 100),
      testCard("c", 120, 360),
      testCard("d", 500, 360),
    ];
    const relations = [
      { id: "a-to-d", fromCardId: "a", toCardId: "d", labelWidth: 200, labelHeight: 46 },
      { id: "b-to-c", fromCardId: "b", toCardId: "c", labelWidth: 200, labelHeight: 46 },
    ];
    const routing = routeStructureRegionOverviewRelations({
      cards,
      relations,
      width: 640,
      height: 480,
    });
    const labelRects = routing.routes.map(({ labelCenter }, index) => ({
      left: labelCenter.x - relations[index]!.labelWidth / 2,
      right: labelCenter.x + relations[index]!.labelWidth / 2,
      top: labelCenter.y - relations[index]!.labelHeight / 2,
      bottom: labelCenter.y + relations[index]!.labelHeight / 2,
    }));

    expect(routing.routes).toHaveLength(2);
    expect(testRectsOverlap(labelRects[0]!, labelRects[1]!)).toBe(false);
    for (const label of labelRects) {
      expect(cards.some((card) => testRectsOverlap(label, cardRect(card)))).toBe(false);
    }
  });

  it("keeps Context boundary routes out of intervening Region cards on a 12-card surface", () => {
    const cards = Array.from({ length: 12 }, (_, index) =>
      testCard(`region-${index}`, 120 + (index % 4) * 240, 100 + Math.floor(index / 4) * 210),
    );
    cards.push(testCard("context", 840, 760));
    const relations = [
      {
        id: "context-to-start",
        fromCardId: "context",
        toCardId: "region-0",
        labelWidth: 200,
        labelHeight: 61,
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        id: `hub-to-${index + 1}`,
        fromCardId: "region-0",
        toCardId: `region-${index + 1}`,
        labelWidth: 200,
        labelHeight: 46,
      })),
    ];
    const forward = routeStructureRegionOverviewRelations({
      cards,
      relations,
      width: 960,
      height: 860,
    });
    const reversed = routeStructureRegionOverviewRelations({
      cards: [...cards].reverse(),
      relations: [...relations].reverse(),
      width: 960,
      height: 860,
    });

    expect(reversed).toEqual(forward);
    expect(forward.routes).toHaveLength(relations.length);
    const labelRects = forward.routes.map((route) => {
      const relation = relations.find(({ id }) => id === route.id)!;
      return {
        left: route.labelCenter.x - relation.labelWidth / 2,
        right: route.labelCenter.x + relation.labelWidth / 2,
        top: route.labelCenter.y - relation.labelHeight / 2,
        bottom: route.labelCenter.y + relation.labelHeight / 2,
      };
    });
    expect(
      labelRects.flatMap((label, index) =>
        labelRects.slice(index + 1).filter((other) => testRectsOverlap(label, other)),
      ),
    ).toEqual([]);
    expect(
      labelRects.flatMap((label) =>
        cards.filter((card) => testRectsOverlap(label, cardRect(card))),
      ),
    ).toEqual([]);
    for (const route of forward.routes) {
      const relation = relations.find(({ id }) => id === route.id)!;
      const nonEndpoints = cards.filter(
        ({ id }) => id !== relation.fromCardId && id !== relation.toCardId,
      );
      for (const card of nonEndpoints) {
        expect(
          route.points
            .slice(1)
            .some((point, index) => segmentEntersRect(route.points[index]!, point, cardRect(card))),
        ).toBe(false);
      }
    }
  });

  it("uses deterministic card-safe shelves when a relationship surface is too dense to optimize", () => {
    const cards = Array.from({ length: 10 }, (_, index) =>
      testCard(`card-${index}`, 140 + (index % 5) * 220, 110 + Math.floor(index / 5) * 200),
    );
    const relations = Array.from({ length: 33 }, (_, index) => ({
      id: `dense-${index.toString().padStart(2, "0")}`,
      fromCardId: `card-${index % 5}`,
      toCardId: `card-${5 + ((index * 3) % 5)}`,
      labelWidth: 200,
      labelHeight: 46 + (index % 2) * 15,
    }));
    const forward = routeStructureRegionOverviewRelations({
      cards,
      relations,
      width: 1_200,
      height: 500,
    });
    const reversed = routeStructureRegionOverviewRelations({
      cards: [...cards].reverse(),
      relations: [...relations].reverse(),
      width: 1_200,
      height: 500,
    });

    expect(reversed).toEqual(forward);
    expect(forward.routes).toHaveLength(relations.length);
    expect(forward.routes.every(({ labelPlacement }) => labelPlacement === "shelf")).toBe(true);
    const labelRects = forward.routes.map((route) => {
      const relation = relations.find(({ id }) => id === route.id)!;
      return {
        left: route.labelCenter.x - relation.labelWidth / 2,
        right: route.labelCenter.x + relation.labelWidth / 2,
        top: route.labelCenter.y - relation.labelHeight / 2,
        bottom: route.labelCenter.y + relation.labelHeight / 2,
      };
    });
    expect(
      labelRects.flatMap((label, index) =>
        labelRects.slice(index + 1).filter((other) => testRectsOverlap(label, other)),
      ),
    ).toEqual([]);
    for (const route of forward.routes) {
      const relation = relations.find(({ id }) => id === route.id)!;
      expect(
        route.points.slice(1).every((point, index) => {
          const previous = route.points[index]!;
          return previous.x === point.x || previous.y === point.y;
        }),
      ).toBe(true);
      for (const card of cards.filter(
        ({ id }) => id !== relation.fromCardId && id !== relation.toCardId,
      )) {
        expect(
          route.points
            .slice(1)
            .some((point, index) => segmentEntersRect(route.points[index]!, point, cardRect(card))),
        ).toBe(false);
      }
    }
  });

  it("derives compact non-ordinal markers from stable IDs and resolves collisions deterministically", () => {
    const regions = [{ id: "http-boundary" }, { id: "handler-bridge" }, { id: "policy" }];
    const markers = structureRegionMarkers(regions);
    const reversed = structureRegionMarkers([...regions].reverse());

    expect(markers.get("policy")).toBe("POL");
    expect(markers.get("http-boundary")).toMatch(/^HB·/u);
    expect(markers.get("handler-bridge")).toMatch(/^HB·/u);
    expect(markers.get("http-boundary")).not.toBe(markers.get("handler-bridge"));
    expect([...markers]).toEqual([...reversed]);
    expect([...markers.values()].every((marker) => !/^R\d+$/u.test(marker))).toBe(true);
  });

  it("returns no Region surface for topology-only Structures", () => {
    const structure = regionStructure();
    structure.presentation = null;
    expect(aggregateStructureRegionOverview(structure)).toBeNull();
  });
});
