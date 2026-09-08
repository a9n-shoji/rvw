import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import {
  deriveLocalStructureLayout,
  initialStructureLayout,
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
} from "../../src/web/structure-graph.js";
import { retryAutomaticStructureLayoutSpacing } from "../../src/web/structure-layout-spacing.js";
import {
  boxesOverlap,
  buildAutomaticStructureRenderFoundation,
  buildFullStructureRenderModel,
  buildStructureRenderFoundation,
  buildStructureRenderModel,
  EDGE_LABEL_LINE_HEIGHT,
  labelBox,
  placeEdgeLabels,
  routeStructureEdges,
  selectStructureRenderModel,
  structureRenderBoundsForNodeIds,
  STRUCTURE_AUTOMATIC_LAYOUT_MAX_SPACING_RETRIES,
  STRUCTURE_EDGE_ARROW_LENGTH,
  STRUCTURE_EDGE_MIN_TERMINAL_APPROACH,
  type StructureEdgeGeometry,
} from "../../src/web/structure-render-model.js";
import { createContractStructures } from "../fixtures/contract/contract-structures.mjs";
import { createStructureStressFixture } from "../fixtures/stress/stress-fixture.js";

function segmentIntersectsBox(
  start: { x: number; y: number },
  end: { x: number; y: number },
  box: { left: number; top: number; right: number; bottom: number },
): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let minimum = 0;
  let maximum = 1;
  for (const [origin, delta, low, high] of [
    [start.x, dx, box.left, box.right],
    [start.y, dy, box.top, box.bottom],
  ] as const) {
    if (Math.abs(delta) < 0.000_001) {
      if (origin < low || origin > high) return false;
      continue;
    }
    const first = (low - origin) / delta;
    const second = (high - origin) / delta;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (minimum > maximum) return false;
  }
  return maximum >= 0 && minimum <= 1;
}

function linePathPoints(path: string): Array<{ x: number; y: number }> {
  return [
    ...path.matchAll(
      /[ML]\s+(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)\s+(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)/giu,
    ),
  ].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

function pointIsOnBoxBoundary(
  point: { x: number; y: number },
  box: { left: number; top: number; right: number; bottom: number },
): boolean {
  const tolerance = 0.000_001;
  const onVertical =
    (Math.abs(point.x - box.left) <= tolerance || Math.abs(point.x - box.right) <= tolerance) &&
    point.y >= box.top - tolerance &&
    point.y <= box.bottom + tolerance;
  const onHorizontal =
    (Math.abs(point.y - box.top) <= tolerance || Math.abs(point.y - box.bottom) <= tolerance) &&
    point.x >= box.left - tolerance &&
    point.x <= box.right + tolerance;
  return onVertical || onHorizontal;
}

function expectDirectedArrowJoin(
  route: StructureEdgeGeometry,
  target: { left: number; top: number; right: number; bottom: number },
): void {
  const tip = { x: route.endX, y: route.endY };
  const base = { x: route.arrowBaseX, y: route.arrowBaseY };
  expect(pointIsOnBoxBoundary(tip, target)).toBe(true);
  expect(Math.hypot(tip.x - base.x, tip.y - base.y)).toBeCloseTo(STRUCTURE_EDGE_ARROW_LENGTH, 8);
  expect(route.arrowPath).toBe(`M ${base.x} ${base.y} L ${tip.x} ${tip.y}`);
  expect(route.strokePath.endsWith(`${base.x} ${base.y}`)).toBe(true);

  const tangentLength = Math.hypot(route.arrowTangentX, route.arrowTangentY);
  expect(tangentLength).toBeCloseTo(1, 8);
  expect(tip.x - base.x).toBeCloseTo(route.arrowTangentX * STRUCTURE_EDGE_ARROW_LENGTH, 8);
  expect(tip.y - base.y).toBeCloseTo(route.arrowTangentY * STRUCTURE_EDGE_ARROW_LENGTH, 8);
  const onVerticalBoundary = tip.x === target.left || tip.x === target.right;
  if (onVerticalBoundary) {
    expect(Math.abs(route.arrowTangentX)).toBeCloseTo(1, 8);
    expect(route.arrowTangentY).toBeCloseTo(0, 8);
  } else {
    expect(route.arrowTangentX).toBeCloseTo(0, 8);
    expect(Math.abs(route.arrowTangentY)).toBeCloseTo(1, 8);
  }

  const terminalStart = route.points.at(-2)!;
  const visibleTerminalApproach = Math.hypot(base.x - terminalStart.x, base.y - terminalStart.y);
  expect(visibleTerminalApproach).toBeGreaterThanOrEqual(STRUCTURE_EDGE_MIN_TERMINAL_APPROACH);
  const approachX = base.x - terminalStart.x;
  const approachY = base.y - terminalStart.y;
  expect(Math.abs(approachX * route.arrowTangentY - approachY * route.arrowTangentX)).toBeCloseTo(
    0,
    8,
  );
}

function pointIsOnPolyline(
  point: { x: number; y: number },
  points: readonly { x: number; y: number }[],
): boolean {
  const tolerance = 0.000_1;
  return points.slice(1).some((end, index) => {
    const start = points[index]!;
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y) <= tolerance;
    const fraction = ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared;
    if (fraction < -tolerance || fraction > 1 + tolerance) return false;
    const projected = { x: start.x + fraction * deltaX, y: start.y + fraction * deltaY };
    return Math.hypot(point.x - projected.x, point.y - projected.y) <= tolerance;
  });
}

function maximumSharedOrthogonalLength(
  left: readonly { x: number; y: number }[],
  right: readonly { x: number; y: number }[],
): number {
  type Segment = {
    orientation: "horizontal" | "vertical";
    fixed: number;
    minimum: number;
    maximum: number;
  };
  const segments = (points: readonly { x: number; y: number }[]) =>
    points.slice(1).flatMap<Segment>((point, index) => {
      const previous = points[index]!;
      if (previous.y === point.y) {
        return [
          {
            orientation: "horizontal" as const,
            fixed: point.y,
            minimum: Math.min(previous.x, point.x),
            maximum: Math.max(previous.x, point.x),
          },
        ];
      }
      if (previous.x === point.x) {
        return [
          {
            orientation: "vertical" as const,
            fixed: point.x,
            minimum: Math.min(previous.y, point.y),
            maximum: Math.max(previous.y, point.y),
          },
        ];
      }
      return [];
    });
  let maximum = 0;
  for (const leftSegment of segments(left)) {
    for (const rightSegment of segments(right)) {
      if (
        leftSegment.orientation !== rightSegment.orientation ||
        leftSegment.fixed !== rightSegment.fixed
      ) {
        continue;
      }
      maximum = Math.max(
        maximum,
        Math.min(leftSegment.maximum, rightSegment.maximum) -
          Math.max(leftSegment.minimum, rightSegment.minimum),
      );
    }
  }
  return maximum;
}

function structureRouteLength(route: StructureEdgeGeometry): number {
  return route.points.slice(1).reduce((total, point, index) => {
    const previous = route.points[index]!;
    return total + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0);
}

function testRouteGeometry(points: readonly { x: number; y: number }[]): StructureEdgeGeometry {
  const first = points[0]!;
  const last = points.at(-1)!;
  const tangentLength = Math.max(1, Math.hypot(last.x - first.x, last.y - first.y));
  return {
    path: "",
    strokePath: "",
    arrowPath: "",
    points,
    startX: first.x,
    startY: first.y,
    control1X: first.x,
    control1Y: first.y,
    control2X: last.x,
    control2Y: last.y,
    endX: last.x,
    endY: last.y,
    arrowBaseX: last.x,
    arrowBaseY: last.y,
    arrowTangentX: (last.x - first.x) / tangentLength,
    arrowTangentY: (last.y - first.y) / tangentLength,
    bounds: {
      left: Math.min(...points.map(({ x }) => x)),
      top: Math.min(...points.map(({ y }) => y)),
      right: Math.max(...points.map(({ x }) => x)),
      bottom: Math.max(...points.map(({ y }) => y)),
    },
  };
}

function properSegmentsCross(
  leftStart: { x: number; y: number },
  leftEnd: { x: number; y: number },
  rightStart: { x: number; y: number },
  rightEnd: { x: number; y: number },
): boolean {
  const orientation = (
    first: { x: number; y: number },
    second: { x: number; y: number },
    third: { x: number; y: number },
  ): number =>
    (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  const epsilon = 0.000_001;
  const first = orientation(leftStart, leftEnd, rightStart);
  const second = orientation(leftStart, leftEnd, rightEnd);
  const third = orientation(rightStart, rightEnd, leftStart);
  const fourth = orientation(rightStart, rightEnd, leftEnd);
  return first * second < -epsilon && third * fourth < -epsilon;
}

function unrelatedRouteConflicts(
  routes: readonly {
    edge: { id: string; from: string; to: string };
    geometry: StructureEdgeGeometry;
  }[],
): { crossingPairs: string[]; sharedLanePairs: string[] } {
  const crossingPairs: string[] = [];
  const sharedLanePairs: string[] = [];
  for (const [index, left] of routes.entries()) {
    for (const right of routes.slice(index + 1)) {
      if (
        [left.edge.from, left.edge.to].some(
          (nodeId) => nodeId === right.edge.from || nodeId === right.edge.to,
        )
      ) {
        continue;
      }
      if (maximumSharedOrthogonalLength(left.geometry.points, right.geometry.points) > 0) {
        sharedLanePairs.push(`${left.edge.id}|${right.edge.id}`);
      }
      const crosses = left.geometry.points
        .slice(1)
        .some((leftEnd, leftIndex) =>
          right.geometry.points
            .slice(1)
            .some((rightEnd, rightIndex) =>
              properSegmentsCross(
                left.geometry.points[leftIndex]!,
                leftEnd,
                right.geometry.points[rightIndex]!,
                rightEnd,
              ),
            ),
        );
      if (crosses) crossingPairs.push(`${left.edge.id}|${right.edge.id}`);
    }
  }
  return { crossingPairs, sharedLanePairs };
}

function renderStructure(): Structure {
  const notations = [
    "plain",
    "class",
    "database",
    "interface",
    "component",
    "external",
    "concept",
  ] as const;
  return {
    id: "70000000-0000-4000-8000-000000000121",
    ref: "rvw://structure/70000000-0000-4000-8000-000000000121",
    pullRequestId: "pr-1",
    sourceOid: "a".repeat(40),
    title: "Export render model",
    scope: "All exported relationships.",
    originNodeId: "node-0",
    presentation: null,
    nodes: notations.map((notation, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
      description: `Description ${index}`,
      kind: null,
      notation,
      anchor:
        index === 0
          ? { path: "src/export/entry.ts", startLine: 1, endLine: 3 }
          : index === 1
            ? { path: "src/other/entry.ts", startLine: 4, endLine: 5 }
            : null,
    })),
    edges: [
      {
        id: "forward",
        from: "node-0",
        to: "node-1",
        label: "calls",
        directed: true,
        anchors: [{ path: "src/export/entry.ts", startLine: 2, endLine: 2 }],
      },
      {
        id: "reverse",
        from: "node-1",
        to: "node-0",
        label: "reports to",
        directed: true,
        anchors: [],
      },
      {
        id: "parallel",
        from: "node-0",
        to: "node-1",
        label: "validates through",
        directed: true,
        anchors: [],
      },
      {
        id: "self",
        from: "node-1",
        to: "node-1",
        label: "retries itself",
        directed: true,
        anchors: [],
      },
      ...notations.slice(2).map((_, index) => ({
        id: `branch-${index}`,
        from: "node-1",
        to: `node-${index + 2}`,
        label: `dispatches branch ${index}`,
        directed: index % 2 === 0,
        anchors: [],
      })),
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function spacingRetryStructure(): Structure {
  return {
    ...renderStructure(),
    originNodeId: "source",
    nodes: ["source", "target"].map((id) => ({
      id,
      label: id,
      description: null,
      kind: null,
      notation: "plain",
      anchor: null,
    })),
    edges: [
      {
        id: "relationship",
        from: "source",
        to: "target",
        label: "a wide relationship that needs spacing",
        directed: true,
        anchors: [],
      },
    ],
  };
}

describe("Structure shared render model", () => {
  it("frames a semantic Node set with its induced exact Edge, label, and leader geometry", () => {
    const structure = createContractStructures({
      pullRequestId: "pr-1",
      baseOid: "a".repeat(40),
      firstHead: "b".repeat(40),
    })[2] as Structure;
    const positions = initialStructureLayout(structure);
    const foundation = buildStructureRenderFoundation({
      structure,
      positions,
      sourceChangeKinds: new Map(),
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-adaptive",
    });
    const edgeId = "detail-route-authenticates";
    const bounds = structureRenderBoundsForNodeIds(foundation, [
      "order-detail-route",
      "detail-actor-auth",
    ])!;
    const inducedEdge = foundation.edges.find(({ edge }) => edge.id === edgeId)!;
    const inducedLabel = foundation.labels.find(({ edge }) => edge.id === edgeId)!;
    const inducedLabelBounds = labelBox(
      inducedLabel.x,
      inducedLabel.y,
      inducedLabel.boxWidth,
      inducedLabel.height,
      4,
    );

    expect(inducedLabel.leaderBounds).not.toBeNull();
    for (const included of [
      inducedEdge.geometry.bounds,
      inducedLabelBounds,
      inducedLabel.leaderBounds!,
    ]) {
      expect(bounds.left).toBeLessThanOrEqual(included.left);
      expect(bounds.top).toBeLessThanOrEqual(included.top);
      expect(bounds.right).toBeGreaterThanOrEqual(included.right);
      expect(bounds.bottom).toBeGreaterThanOrEqual(included.bottom);
    }
    expect(bounds.right).toBeLessThan(positions["order-detail-contract"]!.x);
    expect(bounds).not.toEqual(
      selectStructureRenderModel(foundation, {
        nodeIds: new Set(structure.nodes.map(({ id }) => id)),
        edgeIds: new Set(structure.edges.map(({ id }) => id)),
        labelEdgeIds: new Set(structure.edges.map(({ id }) => id)),
      }).bounds,
    );
  });

  it("derives exact region membership and factual primary-backbone Edges from presentation", () => {
    const structure: Structure = {
      ...renderStructure(),
      presentation: {
        thesis: "The request crosses a stable boundary.",
        startNodeId: "node-0",
        primaryBackbone: {
          edgeIds: ["parallel"],
        },
        regions: [
          {
            id: "a-ingress",
            label: "Ingress",
            summary: "Request ingress and validation responsibilities.",
            nodeIds: ["node-0", "node-2"],
          },
          {
            id: "b-execution",
            label: "Execution",
            summary: "Request execution responsibilities.",
            nodeIds: ["node-1", "node-3"],
          },
        ],
      },
    };
    const model = buildFullStructureRenderModel({
      structure,
      positions: initialStructureLayout(structure),
      sourceChangeKinds: new Map(),
    });

    expect(model.presentation?.thesis).toBe(structure.presentation!.thesis);
    expect(model.presentation?.startNodeId).toBe("node-0");
    expect([...model.presentation!.primaryBackboneNodeIds].sort()).toEqual(["node-0", "node-1"]);
    expect([...model.presentation!.primaryBackboneEdgeIds]).toEqual(["parallel"]);
    expect(
      model.presentation?.regions.map(({ id, label, summary }) => ({ id, label, summary })),
    ).toEqual([
      {
        id: "a-ingress",
        label: "Ingress",
        summary: "Request ingress and validation responsibilities.",
      },
      {
        id: "b-execution",
        label: "Execution",
        summary: "Request execution responsibilities.",
      },
    ]);
    expect(model.presentation?.regions.map(({ nodeIds }) => nodeIds)).toEqual([
      ["node-0", "node-2"],
      ["node-1", "node-3"],
    ]);
    const executionBounds = model.presentation!.regions[1]!.bounds;
    const internalEdge = model.edges.find(({ edge }) => edge.id === "branch-1")!;
    const internalLabel = model.labels.find(({ edge }) => edge.id === "branch-1")!;
    const internalLabelBounds = labelBox(
      internalLabel.x,
      internalLabel.y,
      internalLabel.boxWidth,
      internalLabel.height,
      4,
    );
    for (const bounds of [
      internalEdge.geometry.bounds,
      internalLabelBounds,
      ...(internalLabel.leaderBounds ? [internalLabel.leaderBounds] : []),
    ]) {
      expect(executionBounds.left).toBeLessThanOrEqual(bounds.left);
      expect(executionBounds.top).toBeLessThanOrEqual(bounds.top);
      expect(executionBounds.right).toBeGreaterThanOrEqual(bounds.right);
      expect(executionBounds.bottom).toBeGreaterThanOrEqual(bounds.bottom);
    }
  });

  it("keeps generated presentation metadata deterministic across input order", () => {
    for (let caseIndex = 0; caseIndex < 40; caseIndex += 1) {
      const spineCount = 2 + (caseIndex % 4);
      const regionCount = 1 + (caseIndex % Math.min(3, spineCount));
      const spineIds = Array.from({ length: spineCount }, (_, index) => `spine-${index}`);
      const regionIndexBySpineIndex = spineIds.map((_, index) =>
        Math.min(regionCount - 1, Math.floor((index * regionCount) / spineCount)),
      );
      const regionExtraIds = Array.from({ length: regionCount }, (_, index) => [
        `region-${index}-near`,
        `region-${index}-far`,
      ]);
      const unassignedIds = ["branch-z", "branch-m", "branch-a"];
      const nodeIds = [...spineIds, ...regionExtraIds.flat(), ...unassignedIds];
      const spineEdgeIds = spineIds.slice(1).map((_, index) => `spine-edge-${index}`);
      const structure: Structure = {
        ...renderStructure(),
        originNodeId: spineIds[0]!,
        nodes: nodeIds.map((id) => ({
          id,
          label: id,
          description: null,
          kind: null,
          notation: "plain",
          anchor: null,
        })),
        edges: [
          ...spineEdgeIds.map((id, index) => ({
            id,
            from: spineIds[index]!,
            to: spineIds[index + 1]!,
            label: "continues",
            directed: true,
            anchors: [],
          })),
          ...regionExtraIds.flatMap(([nearId, farId], regionIndex) => {
            const spineIndex = regionIndexBySpineIndex.indexOf(regionIndex);
            return [
              {
                id: `${nearId}-edge`,
                from: spineIds[spineIndex]!,
                to: nearId!,
                label: "relates",
                directed: true,
                anchors: [],
              },
              {
                id: `${farId}-edge`,
                from: nearId!,
                to: farId!,
                label: "relates",
                directed: true,
                anchors: [],
              },
            ];
          }),
          {
            id: "branch-z-edge",
            from: spineIds[0]!,
            to: "branch-z",
            label: "branches",
            directed: true,
            anchors: [],
          },
          {
            id: "branch-m-edge",
            from: "branch-z",
            to: "branch-m",
            label: "continues",
            directed: true,
            anchors: [],
          },
          {
            id: "branch-a-edge",
            from: "branch-m",
            to: "branch-a",
            label: "continues",
            directed: true,
            anchors: [],
          },
        ],
        presentation: {
          thesis: "Generated presentation.",
          startNodeId: spineIds[0]!,
          primaryBackbone: caseIndex % 3 === 0 ? null : { edgeIds: spineEdgeIds },
          regions: Array.from({ length: regionCount }, (_, regionIndex) => ({
            id: `region-${regionIndex}`,
            label: `Region ${regionIndex}`,
            summary: `Responsibilities grouped in region ${regionIndex}.`,
            nodeIds: [
              ...spineIds.filter(
                (_, spineIndex) => regionIndexBySpineIndex[spineIndex] === regionIndex,
              ),
              ...regionExtraIds[regionIndex]!,
            ],
          })),
        },
      };
      const firstPositions = initialStructureLayout(structure);
      const model = buildFullStructureRenderModel({
        structure,
        positions: firstPositions,
        sourceChangeKinds: new Map(),
      });

      expect(
        initialStructureLayout({
          ...structure,
          nodes: [...structure.nodes].reverse(),
          edges: [...structure.edges].reverse(),
        }),
      ).toEqual(firstPositions);
      expect(
        model.presentation?.regions.map(({ id, index, label, summary, nodeIds }) => ({
          id,
          index,
          label,
          summary,
          nodeIds,
        })),
      ).toEqual(
        structure.presentation!.regions.map((region, index) => ({
          id: region.id,
          index,
          label: region.label,
          summary: region.summary,
          nodeIds: [...region.nodeIds].sort(),
        })),
      );
    }
  });

  it("builds every Node, Edge, and Edge label with complete bounds", () => {
    const structure = renderStructure();
    const model = buildFullStructureRenderModel({
      structure,
      positions: initialStructureLayout(structure),
      sourceChangeKinds: new Map([
        ["src/export/entry.ts", "modified"],
        ["src/other/entry.ts", "renamed"],
      ]),
    });

    expect(model.nodes).toHaveLength(structure.nodes.length);
    expect(model.edges).toHaveLength(structure.edges.length);
    expect(model.labels).toHaveLength(structure.edges.length);
    expect(model.nodes[0]?.sourceLabel).toBe("export/entry.ts");
    expect(model.nodes[1]?.sourceLabel).toBe("other/entry.ts");
    expect(model.bounds).not.toBeNull();
    expect(Object.values(model.bounds!)).toSatisfy((values: number[]) =>
      values.every(Number.isFinite),
    );
    const self = model.edges.find(({ edge }) => edge.id === "self")!;
    expect(model.bounds!.right).toBeGreaterThanOrEqual(self.geometry.bounds.right);
    expect(model.bounds!.top).toBeLessThanOrEqual(self.geometry.bounds.top);
  });

  it("keeps the full contract Structure routes compact and free of unrelated crossings", () => {
    const structure = createContractStructures({
      pullRequestId: "pr-1",
      baseOid: "a".repeat(40),
      firstHead: "b".repeat(40),
    })[0] as Structure;
    const model = buildFullStructureRenderModel({
      structure,
      positions: initialStructureLayout(structure),
      sourceChangeKinds: new Map(),
    });
    const conflicts = unrelatedRouteConflicts(model.edges);

    expect(model.edges).toHaveLength(structure.edges.length);
    expect(model.labels).toHaveLength(structure.edges.length);
    expect(
      model.edges.reduce((total, edge) => total + structureRouteLength(edge.geometry), 0),
    ).toBeLessThanOrEqual(4_000);
    expect(conflicts).toEqual({ crossingPairs: [], sharedLanePairs: [] });
    expect(model.bounds!.right - model.bounds!.left).toBeLessThanOrEqual(2_000);
    expect(model.bounds!.bottom - model.bounds!.top).toBeLessThanOrEqual(1_100);
  });

  it("keeps a partial-Region twelve-Node Context route bounded and crossing-free", () => {
    const nodeIds = Array.from(
      { length: 12 },
      (_, index) => `node-${String(index).padStart(2, "0")}`,
    );
    const edges = nodeIds.slice(1).map((nodeId, index) => ({
      id: `context-edge-${String(index).padStart(2, "0")}`,
      from: nodeIds[index]!,
      to: nodeId,
      label: `continues through Context ${index}`,
      directed: true,
      anchors: [],
    }));
    const structure: Structure = {
      ...renderStructure(),
      originNodeId: nodeIds[0]!,
      nodes: nodeIds.map((id) => ({
        id,
        label: id,
        description: null,
        kind: null,
        notation: "plain",
        anchor: null,
      })),
      edges,
      presentation: {
        thesis: "A small authored entry chunk exposes a longer factual Context chain.",
        startNodeId: nodeIds[0]!,
        primaryBackbone: { edgeIds: edges.map(({ id }) => id) },
        regions: [
          {
            id: "entry",
            label: "Entry",
            summary: "The authored entry comprehension chunk.",
            nodeIds: [nodeIds[0]!],
          },
        ],
      },
    };
    const model = buildFullStructureRenderModel({
      structure,
      positions: initialStructureLayout(structure),
      sourceChangeKinds: new Map(),
    });

    expect(model.edges.map(({ edge }) => edge.id).sort()).toEqual(edges.map(({ id }) => id).sort());
    expect(model.labels).toHaveLength(edges.length);
    expect(unrelatedRouteConflicts(model.edges)).toEqual({
      crossingPairs: [],
      sharedLanePairs: [],
    });
    expect(
      model.edges.reduce((total, edge) => total + structureRouteLength(edge.geometry), 0),
    ).toBeLessThanOrEqual(2_600);
    expect(model.bounds!.right - model.bounds!.left).toBeLessThanOrEqual(1_750);
    expect(model.bounds!.bottom - model.bounds!.top).toBeLessThanOrEqual(950);
  });

  it("keeps a fifty-Node Context fan-out bounded with finite route complexity", () => {
    const leafIds = Array.from(
      { length: 49 },
      (_, index) => `leaf-${String(index).padStart(2, "0")}`,
    );
    const edges = leafIds.map((nodeId, index) => ({
      id: `policy-edge-${String(index).padStart(2, "0")}`,
      from: "hub",
      to: nodeId,
      label: `routes to independent policy ${index}`,
      directed: true,
      anchors: [],
    }));
    const structure: Structure = {
      ...renderStructure(),
      originNodeId: "hub",
      nodes: ["hub", ...leafIds].map((id) => ({
        id,
        label: id,
        description: null,
        kind: null,
        notation: "plain",
        anchor: null,
      })),
      edges,
      presentation: {
        thesis: "The hub exposes many independent factual policies.",
        startNodeId: "hub",
        primaryBackbone: null,
        regions: [
          {
            id: "coordination",
            label: "Coordination",
            summary: "The authored coordination responsibility.",
            nodeIds: ["hub"],
          },
        ],
      },
    };
    const model = buildFullStructureRenderModel({
      structure,
      positions: initialStructureLayout(structure),
      sourceChangeKinds: new Map(),
    });
    const routeLengths = model.edges.map(({ geometry }) => structureRouteLength(geometry));
    const routePointCounts = model.edges.map(({ geometry }) => geometry.points.length);

    expect(model.edges).toHaveLength(edges.length);
    expect(model.labels).toHaveLength(edges.length);
    expect(routeLengths.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(32_000);
    expect(
      routePointCounts.reduce((sum, value) => sum + value, 0) / edges.length,
    ).toBeLessThanOrEqual(12);
    expect(Math.max(...routePointCounts)).toBeLessThanOrEqual(52);
    expect(model.bounds!.right - model.bounds!.left).toBeLessThanOrEqual(3_100);
    expect(model.bounds!.bottom - model.bounds!.top).toBeLessThanOrEqual(1_650);
  });

  it("keeps every label after manual positions block direct association leaders", () => {
    const structure = createContractStructures({
      pullRequestId: "pr-1",
      baseOid: "a".repeat(40),
      firstHead: "b".repeat(40),
    })[0] as Structure;
    const canonical = initialStructureLayout(structure);
    const hub = canonical["hub"]!;

    for (const [deltaX, deltaY] of [
      [-500, -100],
      [-300, 52],
      [250, -300],
      [250, 52],
      [75, 52],
    ] as const) {
      const positions = {
        ...canonical,
        hub: { x: hub.x + deltaX, y: hub.y + deltaY },
      };
      const model = buildFullStructureRenderModel({
        structure,
        positions,
        sourceChangeKinds: new Map(),
      });
      const nodeBoxes = model.nodes.map(({ point }) => ({
        left: point.x,
        top: point.y,
        right: point.x + STRUCTURE_NODE_WIDTH,
        bottom: point.y + STRUCTURE_NODE_HEIGHT,
      }));

      expect(model.edges, `${deltaX},${deltaY}: Edge routes`).toHaveLength(structure.edges.length);
      expect(model.labels, `${deltaX},${deltaY}: Edge labels`).toHaveLength(structure.edges.length);
      expect(
        model.labels.every((label) =>
          nodeBoxes.every(
            (nodeBox) =>
              !boxesOverlap(labelBox(label.x, label.y, label.boxWidth, label.height, 4), nodeBox),
          ),
        ),
      ).toBe(true);
      expect(
        model.labels.filter(({ displaced }) => displaced).every(({ leaderPath }) => leaderPath),
      ).toBe(true);
      for (const label of model.labels.filter(({ displaced }) => displaced)) {
        const points = linePathPoints(label.leaderPath!);
        const edgeGeometry = model.edges.find(({ edge }) => edge.id === label.edge.id)!.geometry;
        const box = labelBox(label.x, label.y, label.boxWidth, label.height);
        expect(points.length).toBeGreaterThanOrEqual(2);
        expect(label.leaderEdgeAnchor).toEqual(points[0]);
        expect(label.leaderLabelAnchor).toEqual(points.at(-1));
        expect(pointIsOnPolyline(label.leaderEdgeAnchor!, edgeGeometry.points)).toBe(true);
        expect(pointIsOnBoxBoundary(label.leaderLabelAnchor!, box)).toBe(true);
        expect(label.leaderLabelAnchor).not.toEqual({ x: label.x, y: label.y });
        expect(
          points
            .slice(1)
            .every((point, index) =>
              nodeBoxes.every((nodeBox) => !segmentIntersectsBox(points[index]!, point, nodeBox)),
            ),
        ).toBe(true);
      }
      for (const label of model.labels) {
        const edgeGeometry = model.edges.find(({ edge }) => edge.id === label.edge.id)!.geometry;
        const box = labelBox(label.x, label.y, label.boxWidth, label.height);
        const inline = edgeGeometry.points
          .slice(1)
          .some((point, index) => segmentIntersectsBox(edgeGeometry.points[index]!, point, box));
        expect(
          inline || label.leaderPath,
          `${label.edge.id} has no visible association`,
        ).toBeTruthy();
      }
    }
  });

  it("respects screen selections while source actions reserve label width", () => {
    const structure = renderStructure();
    const positions = initialStructureLayout(structure);
    const selection = {
      nodeIds: new Set(["node-0", "node-1"]),
      edgeIds: new Set(["forward", "reverse", "parallel", "self"]),
      labelEdgeIds: new Set(["forward"]),
    };
    const withSourceAction = buildStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
      selection,
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-adaptive",
    });
    const withoutSourceAction = buildStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
      selection,
      labelAccessory: "none",
      edgeLabelMode: "viewer-adaptive",
    });

    expect(withSourceAction.nodes).toHaveLength(2);
    expect(withSourceAction.edges).toHaveLength(4);
    expect(withSourceAction.labels.map(({ edge }) => edge.id)).toEqual(["forward"]);
    expect(withSourceAction.labels[0]!.boxWidth).toBeGreaterThan(
      withoutSourceAction.labels[0]!.boxWidth,
    );
  });

  it("compares compact and complete label boxes in one proximity-first candidate set", () => {
    const edge = {
      id: "main",
      from: "source",
      to: "target",
      label: "this is a substantially wide relationship label",
      directed: true,
      anchors: [
        { path: "src/source.ts", startLine: 1, endLine: 1 },
        { path: "src/target.ts", startLine: 1, endLine: 1 },
      ],
    };
    const nodes = ["left-wall", "right-wall"].map((id) => ({
      id,
      label: id,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    }));
    const positions = {
      "left-wall": { x: -98, y: -56 },
      "right-wall": { x: 350, y: -56 },
    };
    const routes = new Map([
      [
        "main",
        testRouteGeometry([
          { x: 0, y: 0 },
          { x: 500, y: 0 },
        ]),
      ],
    ]);

    const viewer = placeEdgeLabels(
      [edge],
      nodes,
      positions,
      new Map(),
      routes,
      "source-actions",
      "viewer-adaptive",
    )[0]!;
    const complete = placeEdgeLabels(
      [edge],
      nodes,
      positions,
      new Map(),
      routes,
      "source-actions",
      "export-complete",
    )[0]!;

    expect(viewer.source.anchorCount).toBe(2);
    expect(viewer.boxWidth).toBeGreaterThan(viewer.selectWidth);
    expect(viewer.diagnostics.usedCompactWidth).toBe(true);
    expect(viewer.diagnostics.edgeDistance).toBe(0);
    expect(viewer.displaced).toBe(false);
    expect(viewer.leaderPath).toBeNull();
    expect(complete.boxWidth).toBeGreaterThan(viewer.boxWidth);
    expect(complete.diagnostics.usedCompactWidth).toBe(false);
    expect(complete.diagnostics.edgeDistance).toBeGreaterThan(0);
    expect(complete.displaced).toBe(true);
  });

  it("moves along the own Edge before retreating along its normal", () => {
    const edge = {
      id: "main",
      from: "source",
      to: "target",
      label: "moves",
      directed: true,
      anchors: [],
    };
    const blocker = {
      id: "blocker",
      label: "blocker",
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    };
    const route = testRouteGeometry([
      { x: 0, y: 0 },
      { x: 800, y: 0 },
    ]);
    const placement = placeEdgeLabels(
      [edge],
      [blocker],
      { blocker: { x: 286, y: -56 } },
      new Map(),
      new Map([[edge.id, route]]),
      "none",
      "viewer-adaptive",
    )[0]!;

    expect(placement.x).not.toBeCloseTo(400);
    expect(placement.y).toBe(0);
    expect(placement.displaced).toBe(false);
    expect(placement.leaderPath).toBeNull();
    expect(placement.diagnostics.edgeDistance).toBe(0);
    expect(
      boxesOverlap(labelBox(placement.x, placement.y, placement.boxWidth, placement.height, 5), {
        left: 286 - 20,
        top: -56 - 20,
        right: 286 + STRUCTURE_NODE_WIDTH + 20,
        bottom: -56 + STRUCTURE_NODE_HEIGHT + 20,
      }),
    ).toBe(false);
  });

  it("starts displaced leaders transversely and avoids a long nearby parallel route", () => {
    const edge = {
      id: "main",
      from: "source",
      to: "target",
      label: "forced leader",
      directed: true,
      anchors: [],
    };
    const nodes = ["left-wall", "right-wall"].map((id) => ({
      id,
      label: id,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    }));
    const ownRoute = testRouteGeometry([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    const blockingRoute = testRouteGeometry([
      { x: 50, y: -200 },
      { x: 50, y: 0 },
    ]);
    const placement = placeEdgeLabels(
      [edge],
      nodes,
      {
        "left-wall": { x: -238, y: -56 },
        "right-wall": { x: 110, y: -56 },
      },
      new Map(),
      new Map([
        [edge.id, ownRoute],
        ["blocking-route", blockingRoute],
      ]),
      "none",
      "viewer-adaptive",
    )[0]!;
    const leaderPoints = linePathPoints(placement.leaderPath!);

    expect(placement.displaced).toBe(true);
    expect(placement.y).toBeGreaterThan(0);
    expect(leaderPoints.length).toBeGreaterThanOrEqual(3);
    expect(pointIsOnPolyline(leaderPoints[0]!, ownRoute.points)).toBe(true);
    expect(leaderPoints[1]!.x).toBeCloseTo(leaderPoints[0]!.x);
    expect(Math.abs(leaderPoints[1]!.y - leaderPoints[0]!.y)).toBeCloseTo(12);
    expect(placement.diagnostics.maxParallelOverlap).toBeLessThan(36);
    expect(placement.crowded).toBe(false);
    expect(
      [
        placement.diagnostics.edgeDistance,
        placement.diagnostics.leaderLength,
        placement.diagnostics.maxParallelOverlap,
        placement.diagnostics.crossingCount,
      ].every(Number.isFinite),
    ).toBe(true);
  });

  it("retries an automatic layout once when spacing resolves, without changing the manual builder", () => {
    const structure = spacingRetryStructure();
    const initialPositions = {
      source: { x: 0, y: 0 },
      target: { x: 260, y: 0 },
    };
    const manual = buildStructureRenderFoundation({
      structure,
      positions: initialPositions,
      sourceChangeKinds: new Map(),
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-adaptive",
    });
    const attempts: number[] = [];
    const automatic = buildAutomaticStructureRenderFoundation({
      structure,
      positions: initialPositions,
      sourceChangeKinds: new Map(),
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-adaptive",
      retryPositions: ({ attempt, pressureLabels }) => {
        attempts.push(attempt);
        expect(pressureLabels.map(({ edge }) => edge.id)).toEqual(["relationship"]);
        return {
          source: { x: 0, y: 0 },
          target: { x: 600, y: 0 },
        };
      },
    });

    expect(manual.labels[0]!.diagnostics.spacingPressure).toBe(true);
    expect(manual.nodes.find(({ node }) => node.id === "target")!.point.x).toBe(260);
    expect(attempts).toEqual([1]);
    expect(automatic.retryCount).toBe(1);
    expect(automatic.positions.target!.x).toBe(600);
    expect(automatic.foundation.labels[0]!.diagnostics.spacingPressure).toBe(false);
  });

  it("caps automatic spacing retries at two attempts", () => {
    const structure = spacingRetryStructure();
    const attempts: number[] = [];
    const automatic = buildAutomaticStructureRenderFoundation({
      structure,
      positions: {
        source: { x: 0, y: 0 },
        target: { x: 260, y: 0 },
      },
      sourceChangeKinds: new Map(),
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-adaptive",
      retryPositions: ({ attempt }) => {
        attempts.push(attempt);
        return {
          source: { x: 0, y: 0 },
          target: { x: attempt === 1 ? 280 : 320, y: 0 },
        };
      },
    });

    expect(STRUCTURE_AUTOMATIC_LAYOUT_MAX_SPACING_RETRIES).toBe(2);
    expect(attempts).toEqual([1, 2]);
    expect(automatic.retryCount).toBe(2);
    expect(automatic.positions.target!.x).toBe(320);
    expect(automatic.foundation.labels[0]!.diagnostics.spacingPressure).toBe(true);
  });

  it("stops automatic spacing retries on unchanged or non-finite candidates", () => {
    const structure = spacingRetryStructure();
    const positions = {
      source: { x: 0, y: 0 },
      target: { x: 260, y: 0 },
    };
    const results = [
      buildAutomaticStructureRenderFoundation({
        structure,
        positions,
        sourceChangeKinds: new Map(),
        labelAccessory: "source-actions",
        edgeLabelMode: "viewer-adaptive",
        retryPositions: () => ({ ...positions }),
      }),
      buildAutomaticStructureRenderFoundation({
        structure,
        positions,
        sourceChangeKinds: new Map(),
        labelAccessory: "source-actions",
        edgeLabelMode: "viewer-adaptive",
        retryPositions: () => ({
          source: { x: 0, y: 0 },
          target: { x: Number.NaN, y: 0 },
        }),
      }),
    ];

    expect(results.map(({ retryCount }) => retryCount)).toEqual([0, 0]);
    expect(results.every(({ positions: result }) => result === positions)).toBe(true);
  });

  it("keeps the two source-backed Order one-hop relations on their own Edges", () => {
    const structure = createContractStructures({
      pullRequestId: "pr-1",
      baseOid: "a".repeat(40),
      firstHead: "b".repeat(40),
    }).find(({ title }) => title === "Order placement behavior") as Structure;
    const local = deriveLocalStructureLayout(
      structure,
      "hub",
      1,
      initialStructureLayout(structure),
    )!;
    const renderGraph = {
      nodes: local.graph.nodes,
      edges: local.graph.edges,
      presentation: structure.presentation,
    };
    const automatic = buildAutomaticStructureRenderFoundation({
      structure: renderGraph,
      positions: local.positions,
      sourceChangeKinds: new Map(),
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-adaptive",
      retryPositions: ({ attempt, positions, pressureLabels }) =>
        retryAutomaticStructureLayoutSpacing({
          structure: renderGraph,
          anchorNodeId: "hub",
          attempt,
          positions,
          pressureLabels,
        }),
    });
    const labels = new Map(automatic.foundation.labels.map((label) => [label.edge.id, label]));
    const retry = labels.get("handler-idempotency-envelope")!;
    const snapshot = labels.get("order-returns-snapshot")!;

    expect(automatic.retryCount).toBeLessThanOrEqual(2);
    expect(retry.edge.label).toBe("再試行を束ねる");
    expect(snapshot.edge.label).toBe("response snapshotを返す");
    expect({ placement: retry.sourceMenuPlacement, width: retry.sourceMenuWidth }).toEqual({
      placement: "above-left",
      width: 144,
    });
    expect({ placement: snapshot.sourceMenuPlacement, width: snapshot.sourceMenuWidth }).toEqual({
      placement: "below-right",
      width: 144,
    });
    for (const label of [retry, snapshot]) {
      expect(label.source.anchorCount).toBe(2);
      expect(label.sourceMenuPlacement).not.toBeNull();
      expect(label.diagnostics.edgeDistance).toBe(0);
      expect(label.displaced).toBe(false);
      expect(label.leaderPath).toBeNull();
      expect(label.diagnostics.fallbackReason).not.toBe("distant");
      expect(label.diagnostics.fallbackReason).not.toBe("emergency");
    }
  });

  it("keeps label positions stable when the authored Edge array order changes", () => {
    const structure = renderStructure();
    const positions = initialStructureLayout(structure);
    const first = buildFullStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
    });
    const reordered = buildFullStructureRenderModel({
      structure: { ...structure, edges: [...structure.edges].reverse() },
      positions,
      sourceChangeKinds: new Map(),
    });
    const placements = (model: typeof first) =>
      Object.fromEntries(model.labels.map(({ edge, x, y }) => [edge.id, { x, y }]));
    expect(placements(reordered)).toEqual(placements(first));
  });

  it("routes parallel, reciprocal, and self-loop Edges around every non-endpoint Node", () => {
    const structure: Structure = {
      ...renderStructure(),
      originNodeId: "left",
      nodes: ["left", "blocker", "right", "lower-right"].map((id) => ({
        id,
        label: id,
        description: null,
        kind: null,
        notation: "plain",
        anchor: null,
      })),
      edges: [
        {
          id: "forward-a",
          from: "left",
          to: "right",
          label: "first parallel relation",
          directed: true,
          anchors: [],
        },
        {
          id: "forward-b",
          from: "left",
          to: "right",
          label: "second parallel relation",
          directed: true,
          anchors: [],
        },
        {
          id: "reciprocal",
          from: "right",
          to: "left",
          label: "reverse relation",
          directed: true,
          anchors: [],
        },
        {
          id: "different-pair",
          from: "left",
          to: "lower-right",
          label: "another relation sharing the obstacle gutter",
          directed: true,
          anchors: [],
        },
        {
          id: "self",
          from: "blocker",
          to: "blocker",
          label: "self relation",
          directed: true,
          anchors: [],
        },
      ],
    };
    const positions = {
      left: { x: 0, y: 0 },
      blocker: { x: 300, y: 0 },
      right: { x: 600, y: 0 },
      "lower-right": { x: 600, y: 184 },
    };
    const routes = routeStructureEdges(structure.edges, structure.nodes, positions);
    expect(routes.size).toBe(structure.edges.length);
    expect(
      new Set(["forward-a", "forward-b", "reciprocal"].map((edgeId) => routes.get(edgeId)!.path))
        .size,
    ).toBe(3);

    const nodeBoxes = new Map(
      structure.nodes.map((node) => {
        const point = positions[node.id as keyof typeof positions];
        return [
          node.id,
          {
            left: point.x,
            top: point.y,
            right: point.x + STRUCTURE_NODE_WIDTH,
            bottom: point.y + STRUCTURE_NODE_HEIGHT,
          },
        ] as const;
      }),
    );
    for (const edge of structure.edges) {
      const route = routes.get(edge.id)!;
      expect(pointIsOnBoxBoundary(route.points[0]!, nodeBoxes.get(edge.from)!)).toBe(true);
      expect(pointIsOnBoxBoundary(route.points.at(-1)!, nodeBoxes.get(edge.to)!)).toBe(true);
      expect(route.points[1]).not.toEqual(route.points[0]);
      expect(route.points.at(-2)).not.toEqual(route.points.at(-1));
      expectDirectedArrowJoin(route, nodeBoxes.get(edge.to)!);
      for (const [nodeId, box] of nodeBoxes) {
        if (nodeId === edge.from || nodeId === edge.to) continue;
        expect(
          route.points
            .slice(1)
            .some((point, index) => segmentIntersectsBox(route.points[index]!, point, box)),
          `${edge.id} crosses ${nodeId}`,
        ).toBe(false);
      }
    }
    for (const [index, edgeId] of ["forward-a", "forward-b", "reciprocal"].entries()) {
      for (const otherId of ["forward-a", "forward-b", "reciprocal"].slice(index + 1)) {
        expect(
          maximumSharedOrthogonalLength(
            routes.get(edgeId)!.points.slice(1, -1),
            routes.get(otherId)!.points.slice(1, -1),
          ),
          `${edgeId} and ${otherId} collapse into one obstacle lane`,
        ).toBe(0);
      }
    }
    for (const edgeId of ["forward-a", "forward-b", "reciprocal"]) {
      expect(
        maximumSharedOrthogonalLength(
          routes.get(edgeId)!.points.slice(1, -1),
          routes.get("different-pair")!.points.slice(1, -1),
        ),
        `${edgeId} and a different endpoint pair share a long obstacle lane`,
      ).toBeLessThan(48);
    }

    const reordered = routeStructureEdges(
      [...structure.edges].reverse(),
      [...structure.nodes].reverse(),
      positions,
    );
    expect(
      Object.fromEntries([...reordered].map(([edgeId, geometry]) => [edgeId, geometry.path])),
    ).toEqual(Object.fromEntries([...routes].map(([edgeId, geometry]) => [edgeId, geometry.path])));
  });

  it("keeps direct lane endpoints and directed marker metadata on Node boundaries", () => {
    const structure: Structure = {
      ...renderStructure(),
      originNodeId: "left",
      nodes: ["left", "right"].map((id) => ({
        id,
        label: id,
        description: null,
        kind: null,
        notation: "plain",
        anchor: null,
      })),
      edges: [
        {
          id: "forward-a",
          from: "left",
          to: "right",
          label: "first lane",
          directed: true,
          anchors: [],
        },
        {
          id: "forward-b",
          from: "left",
          to: "right",
          label: "second lane",
          directed: true,
          anchors: [],
        },
        {
          id: "reverse",
          from: "right",
          to: "left",
          label: "return lane",
          directed: true,
          anchors: [],
        },
      ],
    };
    const positions = { left: { x: 0, y: 0 }, right: { x: 600, y: 220 } };
    const boxes = new Map(
      structure.nodes.map((node) => {
        const point = positions[node.id as keyof typeof positions];
        return [
          node.id,
          {
            left: point.x,
            top: point.y,
            right: point.x + STRUCTURE_NODE_WIDTH,
            bottom: point.y + STRUCTURE_NODE_HEIGHT,
          },
        ] as const;
      }),
    );
    const routes = routeStructureEdges(structure.edges, structure.nodes, positions);

    expect(routes.size).toBe(structure.edges.length);
    for (const edge of structure.edges) {
      const route = routes.get(edge.id)!;
      expect(pointIsOnBoxBoundary(route.points[0]!, boxes.get(edge.from)!)).toBe(true);
      expect(pointIsOnBoxBoundary(route.points.at(-1)!, boxes.get(edge.to)!)).toBe(true);
      expect({ x: route.endX, y: route.endY }).toEqual(route.points.at(-1));
      expect(route.points[1]).not.toEqual(route.points[0]);
      expect(route.points.at(-2)).not.toEqual(route.points.at(-1));
      expectDirectedArrowJoin(route, boxes.get(edge.to)!);
    }
  });

  it.each(["concept", "external", "database"] as const)(
    "attaches parallel Edges to the visible %s shape rather than its transparent layout corners",
    (notation) => {
      const structure: Structure = {
        ...renderStructure(),
        originNodeId: "source",
        nodes: [
          {
            id: "source",
            label: "source",
            description: null,
            kind: null,
            notation: "plain",
            anchor: null,
          },
          {
            id: "target",
            label: "target",
            description: null,
            kind: null,
            notation,
            anchor: null,
          },
        ],
        edges: Array.from({ length: 3 }, (_, index) => ({
          id: `edge-${index}`,
          from: "source",
          to: "target",
          label: `relation ${index}`,
          directed: true,
          anchors: [],
        })),
      };
      const target = { x: 0, y: 400 };
      const routes = routeStructureEdges(structure.edges, structure.nodes, {
        source: { x: 0, y: 0 },
        target,
      });
      const tips = structure.edges.map((edge) => routes.get(edge.id)!.points.at(-1)!);

      expect(routes.size).toBe(3);
      expect(new Set(tips.map(({ x, y }) => `${x}:${y}`)).size).toBe(3);
      expect(tips.some(({ y }) => y > target.y)).toBe(true);
      for (const edge of structure.edges) {
        const route = routes.get(edge.id)!;
        const tip = route.points.at(-1)!;
        expect(route.endX).toBe(tip.x);
        expect(route.endY).toBe(tip.y);
        expect(route.arrowTangentX).toBeCloseTo(0, 8);
        expect(route.arrowTangentY).toBeCloseTo(1, 8);
        expect(route.arrowBaseX).toBeCloseTo(tip.x, 8);
        expect(route.arrowBaseY).toBeCloseTo(tip.y - STRUCTURE_EDGE_ARROW_LENGTH, 8);

        const offsetX = Math.abs(tip.x - (target.x + STRUCTURE_NODE_WIDTH / 2));
        if (notation === "concept") {
          const radius = STRUCTURE_NODE_HEIGHT / 2;
          const flatHalf = STRUCTURE_NODE_WIDTH / 2 - radius;
          const curvedOffset = Math.max(0, offsetX - flatHalf);
          const expectedInset =
            curvedOffset === 0 ? 0 : radius * (1 - Math.sqrt(1 - (curvedOffset / radius) ** 2));
          expect(tip.y).toBeCloseTo(target.y + expectedInset, 8);
        } else if (notation === "external") {
          const shoulder = STRUCTURE_NODE_WIDTH * 0.09;
          const flatHalf = STRUCTURE_NODE_WIDTH / 2 - shoulder;
          const expectedInset =
            (Math.max(0, offsetX - flatHalf) / shoulder) * (STRUCTURE_NODE_HEIGHT / 2);
          expect(tip.y).toBeCloseTo(target.y + expectedInset, 8);
        } else {
          const radiusX = STRUCTURE_NODE_WIDTH / 2;
          const radiusY = STRUCTURE_NODE_HEIGHT * 0.14;
          const expectedInset = radiusY * (1 - Math.sqrt(1 - (offsetX / radiusX) ** 2));
          expect(tip.y).toBeCloseTo(target.y + expectedInset, 8);
        }
      }
    },
  );

  it("allocates distinct deterministic boundary ports for every Edge at a dense hub", () => {
    const structure = createContractStructures({
      pullRequestId: "pr-1",
      baseOid: "a".repeat(40),
      firstHead: "b".repeat(40),
    })[0] as Structure;
    const positions = initialStructureLayout(structure);
    const routes = routeStructureEdges(structure.edges, structure.nodes, positions);
    const incident = structure.edges.filter((edge) => edge.from === "hub" || edge.to === "hub");
    const endpointAndStub = incident.map((edge) => {
      const route = routes.get(edge.id)!;
      const hubIsSource = edge.from === "hub";
      return {
        edgeId: edge.id,
        endpoint: hubIsSource ? route.points[0]! : route.points.at(-1)!,
        stub: hubIsSource ? route.points[1]! : route.points.at(-2)!,
      };
    });
    const pointKey = ({ x, y }: { x: number; y: number }): string => `${x}:${y}`;

    expect(incident).toHaveLength(9);
    expect(new Set(endpointAndStub.map(({ endpoint }) => pointKey(endpoint))).size).toBe(
      incident.length,
    );
    expect(new Set(endpointAndStub.map(({ stub }) => pointKey(stub))).size).toBe(incident.length);

    const model = buildFullStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
    });
    const hub = positions["hub"]!;
    const hubJunction = {
      left: hub.x - 20,
      top: hub.y - 20,
      right: hub.x + STRUCTURE_NODE_WIDTH + 20,
      bottom: hub.y + STRUCTURE_NODE_HEIGHT + 20,
    };
    for (const placement of model.labels.filter(({ edge }) =>
      incident.some(({ id }) => id === edge.id),
    )) {
      expect(
        boxesOverlap(
          labelBox(placement.x, placement.y, placement.boxWidth, placement.height),
          hubJunction,
        ),
        `${placement.edge.id} obscures the hub junction`,
      ).toBe(false);
    }

    const reordered = routeStructureEdges(
      [...structure.edges].reverse(),
      [...structure.nodes].reverse(),
      positions,
    );
    expect(
      Object.fromEntries([...reordered].map(([edgeId, geometry]) => [edgeId, geometry.path])),
    ).toEqual(Object.fromEntries([...routes].map(([edgeId, geometry]) => [edgeId, geometry.path])));
  });

  it("selects an active lens from complete artifact-stable geometry", () => {
    const structure = renderStructure();
    const positions = initialStructureLayout(structure);
    const foundation = buildStructureRenderFoundation({
      structure,
      positions,
      sourceChangeKinds: new Map(),
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-adaptive",
    });
    const complete = selectStructureRenderModel(foundation, {
      nodeIds: new Set(structure.nodes.map(({ id }) => id)),
      edgeIds: new Set(structure.edges.map(({ id }) => id)),
      labelEdgeIds: new Set(structure.edges.map(({ id }) => id)),
    });
    const focusedEdgeIds = new Set(["forward", "parallel"]);
    const focused = selectStructureRenderModel(foundation, {
      nodeIds: new Set(["node-0", "node-1"]),
      edgeIds: focusedEdgeIds,
      labelEdgeIds: focusedEdgeIds,
    });
    const completePositions = Object.fromEntries(
      complete.labels.map(({ edge, x, y }) => [edge.id, { x, y }]),
    );
    expect(Object.fromEntries(focused.labels.map(({ edge, x, y }) => [edge.id, { x, y }]))).toEqual(
      Object.fromEntries([...focusedEdgeIds].map((edgeId) => [edgeId, completePositions[edgeId]])),
    );
    for (const focusedEdge of focused.edges) {
      expect(focusedEdge).toBe(complete.edges.find(({ edge }) => edge.id === focusedEdge.edge.id));
    }
    for (const focusedNode of focused.nodes) {
      expect(focusedNode).toBe(complete.nodes.find(({ node }) => node.id === focusedNode.node.id));
    }
    for (const focusedLabel of focused.labels) {
      expect(focusedLabel).toBe(
        complete.labels.find(({ edge }) => edge.id === focusedLabel.edge.id),
      );
    }
    expect(focused.presentation).toBe(complete.presentation);
  });

  it("uses deterministic obstacle-free simple routes for a large fan-out", () => {
    const structure = createStructureStressFixture({ nodeCount: 100, shape: "fan-out" });
    const positions = initialStructureLayout(structure);
    const routes = routeStructureEdges(structure.edges, structure.nodes, positions);

    expect(routes.size).toBe(structure.edges.length);
    for (const edge of structure.edges) {
      const route = routes.get(edge.id)!;
      for (const node of structure.nodes) {
        if (node.id === edge.from || node.id === edge.to) continue;
        const point = positions[node.id]!;
        const nodeBox = {
          left: point.x,
          top: point.y,
          right: point.x + STRUCTURE_NODE_WIDTH,
          bottom: point.y + STRUCTURE_NODE_HEIGHT,
        };
        expect(
          route.points
            .slice(1)
            .some((end, index) => segmentIntersectsBox(route.points[index]!, end, nodeBox)),
          `${edge.id} crosses ${node.id}`,
        ).toBe(false);
      }
    }

    const reordered = routeStructureEdges(
      [...structure.edges].reverse(),
      [...structure.nodes].reverse(),
      positions,
    );
    expect(Object.fromEntries([...reordered].map(([id, route]) => [id, route.path]))).toEqual(
      Object.fromEntries([...routes].map(([id, route]) => [id, route.path])),
    );
  });

  it("keeps complete Viewer label text and derives its collision height from every line", () => {
    const labels = [
      "calls",
      "validates through a second line",
      `explains ${"a very long conditional relation ".repeat(12)}`,
    ];
    const structures = labels.map((label) => {
      const structure = renderStructure();
      structure.edges = [{ ...structure.edges[0]!, label }];
      const model = buildStructureRenderModel({
        structure,
        positions: initialStructureLayout(structure),
        sourceChangeKinds: new Map(),
        selection: {
          nodeIds: new Set(structure.nodes.map(({ id }) => id)),
          edgeIds: new Set(structure.edges.map(({ id }) => id)),
          labelEdgeIds: new Set(structure.edges.map(({ id }) => id)),
        },
        labelAccessory: "none",
        edgeLabelMode: "viewer-adaptive",
      });
      return model.labels[0]!;
    });

    expect(structures[0]!.displayLines).toEqual(["calls"]);
    expect(structures[0]!.height).toBe(24);
    expect(structures[1]!.displayLines).toHaveLength(2);
    expect(structures[1]!.height).toBe(EDGE_LABEL_LINE_HEIGHT * 2 + 10);
    expect(structures[2]!.displayLines.length).toBeGreaterThan(2);
    expect(structures[2]!.displayLines.join(" ")).not.toContain("…");
    expect(structures[2]!.displayLines.join(" ").replaceAll(/\s+/gu, " ").trim()).toBe(
      labels[2]!.replaceAll(/\s+/gu, " ").trim(),
    );
    expect(structures[2]!.height).toBe(
      EDGE_LABEL_LINE_HEIGHT * structures[2]!.displayLines.length + 10,
    );
  });

  it("uses complete wrapped Edge labels and matching bounds for export", () => {
    const structure = renderStructure();
    structure.edges = [
      {
        ...structure.edges[0]!,
        label: `explains ${"a very long conditional relation ".repeat(12)}finished`,
      },
    ];
    const model = buildFullStructureRenderModel({
      structure,
      positions: initialStructureLayout(structure),
      sourceChangeKinds: new Map(),
    });
    const placement = model.labels[0]!;
    const box = labelBox(placement.x, placement.y, placement.boxWidth, placement.height, 4);

    expect(placement.displayLines.length).toBeGreaterThan(2);
    expect(placement.displayLines.join(" ")).not.toContain("…");
    expect(placement.height).toBe(placement.displayLines.length * EDGE_LABEL_LINE_HEIGHT + 10);
    expect(model.bounds!.left).toBeLessThanOrEqual(box.left);
    expect(model.bounds!.top).toBeLessThanOrEqual(box.top);
    expect(model.bounds!.right).toBeGreaterThanOrEqual(box.right);
    expect(model.bounds!.bottom).toBeGreaterThanOrEqual(box.bottom);
  });

  it("re-wraps crowded labels without truncating before using displaced placement", () => {
    const structure: Structure = {
      ...renderStructure(),
      originNodeId: "controller",
      nodes: ["routes", "composition", "controller", "auth", "handler", "request-schema"].map(
        (id) => ({
          id,
          label: id,
          description: null,
          kind: null,
          notation: "plain",
          anchor: null,
        }),
      ),
      edges: [
        {
          id: "controller-executes-handler",
          from: "controller",
          to: "handler",
          label: "HTTP commandとして実行する",
          directed: true,
          anchors: [
            { path: "src/controller.ts", startLine: 1, endLine: 1 },
            { path: "src/handler.ts", startLine: 1, endLine: 1 },
          ],
        },
        {
          id: "composition-constructs-handler",
          from: "composition",
          to: "handler",
          label: "具象portを注入して構築する",
          directed: true,
          anchors: [
            { path: "src/composition.ts", startLine: 1, endLine: 1 },
            { path: "src/handler.ts", startLine: 1, endLine: 1 },
          ],
        },
      ],
    };
    const positions = {
      routes: { x: 64, y: 432 },
      composition: { x: 64, y: 616 },
      controller: { x: 484, y: 432 },
      auth: { x: 484, y: 616 },
      handler: { x: 904, y: 432 },
      "request-schema": { x: 904, y: 616 },
    };
    const model = buildStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
      selection: {
        nodeIds: new Set(structure.nodes.map(({ id }) => id)),
        edgeIds: new Set(structure.edges.map(({ id }) => id)),
        labelEdgeIds: new Set(structure.edges.map(({ id }) => id)),
      },
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-adaptive",
    });
    const [composition, controller] = model.labels;

    expect(model.labels.map(({ edge }) => edge.id)).toEqual([
      "composition-constructs-handler",
      "controller-executes-handler",
    ]);
    expect(model.labels.every(({ crowded }) => !crowded)).toBe(true);
    expect(controller!.displayLines.join("")).toBe("HTTP commandとして実行する");
    expect(controller!.displayLines.join("")).not.toContain("…");
    expect(
      boxesOverlap(
        labelBox(composition!.x, composition!.y, composition!.boxWidth, composition!.height),
        labelBox(controller!.x, controller!.y, controller!.boxWidth, controller!.height),
      ),
    ).toBe(false);
  });

  it("does not silently synthesize missing session coordinates", () => {
    const structure = renderStructure();
    const positions = initialStructureLayout(structure);
    delete positions["node-6"];
    const model = buildFullStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
    });
    expect(model.nodes).toHaveLength(structure.nodes.length - 1);
    expect(model.edges.length).toBeLessThan(structure.edges.length);
  });

  it("retains label avoidance while routing leaders beyond sixty-four dense Edges", () => {
    let seed = 246_813_579;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    const nodes = Array.from({ length: 10 }, (_, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: null,
    }));
    const slots = Array.from({ length: 10 }, (_, index) => ({
      x: (index % 5) * 236,
      y: Math.floor(index / 5) * 120,
    }));
    for (let index = slots.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [slots[index], slots[swapIndex]] = [slots[swapIndex]!, slots[index]!];
    }
    const positions = Object.fromEntries(nodes.map((node, index) => [node.id, slots[index]!]));
    const structure: Structure = {
      ...renderStructure(),
      originNodeId: nodes[0]!.id,
      nodes,
      edges: Array.from({ length: 65 }, (_, index) => ({
        id: `dense-${String(index).padStart(3, "0")}`,
        from: nodes[Math.floor(random() * nodes.length)]!.id,
        to: nodes[Math.floor(random() * nodes.length)]!.id,
        label: `relationship ${index} with enough text`,
        directed: true,
        anchors: [],
      })),
    };
    const model = buildFullStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
    });
    const nodeBoxes = model.nodes.map(({ point }) => ({
      left: point.x,
      top: point.y,
      right: point.x + STRUCTURE_NODE_WIDTH,
      bottom: point.y + STRUCTURE_NODE_HEIGHT,
    }));

    expect(model.labels).toHaveLength(65);
    expect(model.labels.slice(64).every(({ leaderPath }) => leaderPath !== null)).toBe(true);
    for (const label of model.labels) {
      const leaderPoints = linePathPoints(label.leaderPath ?? "");
      for (const [leaderIndex, end] of leaderPoints.slice(1).entries()) {
        const start = leaderPoints[leaderIndex]!;
        expect(
          nodeBoxes.some((box) => segmentIntersectsBox(start, end, box)),
          `${label.edge.id} leader crosses a Node`,
        ).toBe(false);
        expect(
          model.labels
            .filter(({ edge }) => edge.id !== label.edge.id)
            .some((other) =>
              segmentIntersectsBox(
                start,
                end,
                labelBox(other.x, other.y, other.boxWidth, other.height),
              ),
            ),
          `${label.edge.id} leader crosses another label`,
        ).toBe(false);
      }
    }
  });

  it("places all 200 labels of one parallel bundle without label collisions", () => {
    const structure: Structure = {
      ...renderStructure(),
      originNodeId: "left",
      nodes: ["left", "right"].map((id) => ({
        id,
        label: id,
        description: null,
        kind: null,
        notation: "plain",
        anchor: null,
      })),
      edges: Array.from({ length: 200 }, (_, index) => ({
        id: `parallel-${String(index).padStart(3, "0")}`,
        from: "left",
        to: "right",
        label: `parallel relationship ${index} remains individually inspectable`,
        directed: true,
        anchors: [],
      })),
    };
    const model = buildFullStructureRenderModel({
      structure,
      positions: { left: { x: 0, y: 0 }, right: { x: 600, y: 0 } },
      sourceChangeKinds: new Map(),
    });

    expect(model.edges).toHaveLength(200);
    expect(model.labels).toHaveLength(200);
    const nodeBoxes = model.nodes.map(({ point }) => ({
      left: point.x,
      top: point.y,
      right: point.x + STRUCTURE_NODE_WIDTH,
      bottom: point.y + STRUCTURE_NODE_HEIGHT,
    }));
    for (const [index, label] of model.labels.entries()) {
      const box = labelBox(label.x, label.y, label.boxWidth, label.height, 4);
      for (const other of model.labels.slice(index + 1)) {
        expect(
          boxesOverlap(box, labelBox(other.x, other.y, other.boxWidth, other.height, 4)),
          `${label.edge.id} overlaps ${other.edge.id}`,
        ).toBe(false);
      }
      if (!label.displaced) continue;
      expect(label.leaderPath, `${label.edge.id} has no association leader`).not.toBeNull();
      const leaderPoints = linePathPoints(label.leaderPath!);
      for (const [leaderIndex, end] of leaderPoints.slice(1).entries()) {
        const start = leaderPoints[leaderIndex]!;
        for (const nodeBox of nodeBoxes) {
          expect(
            segmentIntersectsBox(start, end, nodeBox),
            `${label.edge.id} leader crosses a Node`,
          ).toBe(false);
        }
        for (const other of model.labels.filter(({ edge }) => edge.id !== label.edge.id)) {
          expect(
            segmentIntersectsBox(
              start,
              end,
              labelBox(other.x, other.y, other.boxWidth, other.height),
            ),
            `${label.edge.id} leader crosses ${other.edge.id}`,
          ).toBe(false);
        }
      }
    }
    expect(
      model.labels.every(({ diagnostics }) =>
        [
          diagnostics.edgeDistance,
          diagnostics.leaderLength,
          diagnostics.maxParallelOverlap,
          diagnostics.crossingCount,
        ].every(Number.isFinite),
      ),
    ).toBe(true);
    expect(
      model.labels
        .slice(64)
        .some(({ crowded, diagnostics }) => crowded && diagnostics.fallbackReason !== null),
    ).toBe(true);
    expect(
      model.labels
        .filter(({ crowded }) => crowded)
        .every(({ diagnostics }) => diagnostics.spacingPressure),
    ).toBe(true);
    expect(model.labels.some(({ diagnostics }) => diagnostics.fallbackReason === "emergency")).toBe(
      true,
    );
    expect(model.bounds!.right - model.bounds!.left).toBeLessThan(50_000);
    expect(model.bounds!.bottom - model.bounds!.top).toBeLessThan(50_000);
  });

  it("keeps the 50 Node and 200 Edge boundary finite and complete", () => {
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
      description: null,
      kind: null,
      notation: "plain" as const,
      anchor: index === 0 ? { path: "src/entry.ts", startLine: 1, endLine: 1 } : null,
    }));
    const structure: Structure = {
      ...renderStructure(),
      originNodeId: "node-0",
      nodes,
      edges: Array.from({ length: 200 }, (_, index) => ({
        id: `edge-${index}`,
        from: `node-${index % 49}`,
        to: `node-${(index % 49) + 1}`,
        label: `passes relation ${index}`,
        directed: index % 3 !== 0,
        anchors: [],
      })),
    };
    const positions = initialStructureLayout(structure);
    const exportModel = buildFullStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
    });
    const viewerModel = buildStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
      selection: {
        nodeIds: new Set(nodes.map(({ id }) => id)),
        edgeIds: new Set(structure.edges.map(({ id }) => id)),
        labelEdgeIds: new Set(structure.edges.map(({ id }) => id)),
      },
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-adaptive",
    });
    for (const model of [exportModel, viewerModel]) {
      expect(model.nodes).toHaveLength(50);
      expect(model.edges).toHaveLength(200);
      expect(model.labels).toHaveLength(200);
      const nodeBoxes = model.nodes.map(({ point }) => ({
        left: point.x,
        top: point.y,
        right: point.x + STRUCTURE_NODE_WIDTH,
        bottom: point.y + STRUCTURE_NODE_HEIGHT,
      }));
      expect(
        model.labels.every((label) =>
          nodeBoxes.every(
            (nodeBox) =>
              !boxesOverlap(labelBox(label.x, label.y, label.boxWidth, label.height, 4), nodeBox),
          ),
        ),
      ).toBe(true);
      for (const [index, label] of model.labels.entries()) {
        const box = labelBox(label.x, label.y, label.boxWidth, label.height, 4);
        for (const other of model.labels.slice(index + 1)) {
          expect(
            boxesOverlap(box, labelBox(other.x, other.y, other.boxWidth, other.height, 4)),
            `${label.edge.id} overlaps ${other.edge.id}`,
          ).toBe(false);
        }
      }
      expect([
        ...model.nodes.flatMap(({ point }) => [point.x, point.y]),
        ...model.labels.flatMap(({ x, y }) => [x, y]),
      ]).toSatisfy((values: number[]) => values.every(Number.isFinite));
      expect(model.bounds!.right - model.bounds!.left).toBeLessThan(50_000);
      expect(model.bounds!.bottom - model.bounds!.top).toBeLessThan(50_000);
    }
  });
});
