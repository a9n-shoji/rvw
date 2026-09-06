import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import {
  initialStructureLayout,
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
} from "../../src/web/structure-graph.js";
import {
  boxesOverlap,
  buildFullStructureRenderModel,
  buildStructureRenderModel,
  EDGE_LABEL_LINE_HEIGHT,
  labelBox,
  routeStructureEdges,
} from "../../src/web/structure-render-model.js";
import { createContractStructures } from "../fixtures/contract/contract-structures.mjs";

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

describe("Structure shared render model", () => {
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
          { label: "Ingress", nodeIds: ["node-0", "node-2"] },
          { label: "Execution", nodeIds: ["node-1", "node-3"] },
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
    expect(model.presentation?.regions.map(({ label }) => label)).toEqual(["Ingress", "Execution"]);
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
            label: `Region ${regionIndex}`,
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
        model.presentation?.regions.map(({ index, label, nodeIds }) => ({
          index,
          label,
          nodeIds,
        })),
      ).toEqual(
        structure.presentation!.regions.map((region, index) => ({
          index,
          label: region.label,
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
        expect(points.length).toBeGreaterThanOrEqual(2);
        expect(
          points
            .slice(1)
            .every((point, index) =>
              nodeBoxes.every((nodeBox) => !segmentIntersectsBox(points[index]!, point, nodeBox)),
            ),
        ).toBe(true);
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
      edgeLabelMode: "viewer-clamped",
    });
    const withoutSourceAction = buildStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
      selection,
      labelAccessory: "none",
      edgeLabelMode: "viewer-clamped",
    });

    expect(withSourceAction.nodes).toHaveLength(2);
    expect(withSourceAction.edges).toHaveLength(4);
    expect(withSourceAction.labels.map(({ edge }) => edge.id)).toEqual(["forward"]);
    expect(withSourceAction.labels[0]!.boxWidth).toBeGreaterThan(
      withoutSourceAction.labels[0]!.boxWidth,
    );
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
    }
  });

  it("places labels against the complete artifact before filtering the active lens", () => {
    const structure = renderStructure();
    const positions = initialStructureLayout(structure);
    const complete = buildStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
      selection: {
        nodeIds: new Set(structure.nodes.map(({ id }) => id)),
        edgeIds: new Set(structure.edges.map(({ id }) => id)),
        labelEdgeIds: new Set(structure.edges.map(({ id }) => id)),
      },
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-clamped",
    });
    const focusedEdgeIds = new Set(["forward", "parallel"]);
    const focused = buildStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
      selection: {
        nodeIds: new Set(["node-0", "node-1"]),
        edgeIds: focusedEdgeIds,
        labelEdgeIds: focusedEdgeIds,
      },
      labelAccessory: "source-actions",
      edgeLabelMode: "viewer-clamped",
    });
    const completePositions = Object.fromEntries(
      complete.labels.map(({ edge, x, y }) => [edge.id, { x, y }]),
    );
    expect(Object.fromEntries(focused.labels.map(({ edge, x, y }) => [edge.id, { x, y }]))).toEqual(
      Object.fromEntries([...focusedEdgeIds].map((edgeId) => [edgeId, completePositions[edgeId]])),
    );
  });

  it("uses the same maximum two-line representation for Viewer label geometry and rendering", () => {
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
        edgeLabelMode: "viewer-clamped",
      });
      return model.labels[0]!;
    });

    expect(structures[0]!.displayLines).toEqual(["calls"]);
    expect(structures[0]!.height).toBe(24);
    expect(structures[1]!.displayLines).toHaveLength(2);
    expect(structures[1]!.height).toBe(EDGE_LABEL_LINE_HEIGHT * 2 + 10);
    expect(structures[2]!.displayLines).toHaveLength(2);
    expect(structures[2]!.displayLines[1]).toMatch(/…$/u);
    expect(structures[2]!.height).toBe(EDGE_LABEL_LINE_HEIGHT * 2 + 10);
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

  it("re-wraps a crowded label within two lines before using displaced placement", () => {
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
      edgeLabelMode: "viewer-clamped",
    });
    const [composition, controller] = model.labels;

    expect(model.labels.map(({ edge }) => edge.id)).toEqual([
      "composition-constructs-handler",
      "controller-executes-handler",
    ]);
    expect(model.labels.every(({ crowded }) => !crowded)).toBe(true);
    expect(controller!.displayLines.length).toBeLessThanOrEqual(2);
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
    for (const [index, label] of model.labels.entries()) {
      const box = labelBox(label.x, label.y, label.boxWidth, label.height, 4);
      for (const other of model.labels.slice(index + 1)) {
        expect(
          boxesOverlap(box, labelBox(other.x, other.y, other.boxWidth, other.height, 4)),
          `${label.edge.id} overlaps ${other.edge.id}`,
        ).toBe(false);
      }
    }
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
      edgeLabelMode: "viewer-clamped",
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
