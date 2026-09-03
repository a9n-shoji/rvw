import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import { initialStructureLayout } from "../../src/web/structure-graph.js";
import {
  boxesOverlap,
  buildFullStructureRenderModel,
  buildStructureRenderModel,
  EDGE_LABEL_LINE_HEIGHT,
  labelBox,
} from "../../src/web/structure-render-model.js";

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

  it("re-wraps a crowded label within two lines before using a collision fallback", () => {
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
    expect(controller!.boxWidth).toBeLessThanOrEqual(170);
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
    const model = buildFullStructureRenderModel({
      structure,
      positions: initialStructureLayout(structure),
      sourceChangeKinds: new Map(),
    });
    expect(model.nodes).toHaveLength(50);
    expect(model.edges).toHaveLength(200);
    expect(model.labels).toHaveLength(200);
    expect(model.labels.some(({ crowded }) => crowded)).toBe(true);
    expect([
      ...model.nodes.flatMap(({ point }) => [point.x, point.y]),
      ...model.labels.flatMap(({ x, y }) => [x, y]),
    ]).toSatisfy((values: number[]) => values.every(Number.isFinite));
  });
});
