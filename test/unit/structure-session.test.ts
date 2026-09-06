import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import {
  createStructureSession,
  deleteStructureSessions,
  getStructureSession,
  initialStructureViewport,
  MAX_STRUCTURE_ZOOM,
  MIN_STRUCTURE_ZOOM,
  preserveStructureLayoutScreenPosition,
  reconcileStructureSession,
  scaledStructureZoom,
  setStructureSession,
  appendStructureNavigationHistory,
  initialStructureGuideDisclosure,
  structureBackboneNodeIds,
  structureHomeNodeIds,
  structureLayoutBasisKey,
  structureOneHopNodeIds,
  structureViewportForBounds,
  structureViewportForNodeIds,
  transferStructureSession,
} from "../../src/web/structure-session.js";
import { initialStructureLayout } from "../../src/web/structure-graph.js";

function structure(id: string): Structure {
  return {
    id,
    ref: `rvw://structure/${id}`,
    pullRequestId: "pr-1",
    sourceOid: "a".repeat(40),
    title: "Session boundary",
    scope: "A bounded test Structure.",
    originNodeId: "entry",
    presentation: null,
    nodes: [
      {
        id: "entry",
        label: "Entry",
        description: null,
        kind: null,
        notation: "plain",
        anchor: { path: "src/entry.ts", startLine: 1, endLine: 1 },
      },
    ],
    edges: [],
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function presentedStructure(id: string): Structure {
  const value = structure(id);
  value.originNodeId = "A";
  value.nodes = ["A", "B", "C"].map((nodeId) => ({
    ...value.nodes[0]!,
    id: nodeId,
    label: nodeId,
    anchor: nodeId === "A" ? value.nodes[0]!.anchor : null,
  }));
  value.edges = [
    { id: "ab", from: "A", to: "B", label: "A to B", directed: true, anchors: [] },
    { id: "bc", from: "B", to: "C", label: "B to C", directed: true, anchors: [] },
    { id: "ac", from: "A", to: "C", label: "A to C", directed: true, anchors: [] },
    {
      id: "ab-parallel",
      from: "A",
      to: "B",
      label: "A observes B",
      directed: true,
      anchors: [],
    },
  ];
  value.presentation = {
    thesis: "Understand A, B, and C as one authored spatial explanation.",
    startNodeId: "A",
    primaryBackbone: { edgeIds: ["ab", "bc"] },
    regions: [
      { label: "First", nodeIds: ["A", "B"] },
      { label: "Second", nodeIds: ["C"] },
    ],
  };
  return value;
}

describe("Structure pane sessions", () => {
  it("starts a presented Structure from the authorial start, not the factual origin", () => {
    const value = structure("70000000-0000-4000-8000-000000000096");
    value.nodes.push(
      { ...value.nodes[0]!, id: "read-first", label: "Read first", anchor: null },
      { ...value.nodes[0]!, id: "read-next", label: "Read next", anchor: null },
    );
    value.edges.push({
      id: "read-first-next",
      from: "read-first",
      to: "read-next",
      label: "leads to",
      directed: true,
      anchors: [],
    });
    value.presentation = {
      thesis: "Read the authored backbone before exploring supporting details.",
      startNodeId: "read-first",
      primaryBackbone: { edgeIds: ["read-first-next"] },
      regions: [],
    };

    const session = createStructureSession(value);
    expect(session.focusId).toBe("read-first");
    expect(session.depth).toBe("all");
    expect(session.positions["read-first"]!.x).toBeLessThan(session.positions["read-next"]!.x);
    expect(session.positions["read-first"]!.y).toBe(session.positions["read-next"]!.y);

    const viewport = initialStructureViewport({
      structure: value,
      positions: session.positions,
      surfaceSize: { width: 900, height: 600 },
    });
    expect(
      viewport.y + (session.positions["read-first"]!.y + 112 / 2) * viewport.scale,
    ).toBeCloseTo(308);
    expect(viewport.scale).toBeLessThanOrEqual(1.25);
  });

  it("starts from the complete map while highlighting the authored behavior entrypoint", () => {
    const session = createStructureSession(structure("70000000-0000-4000-8000-000000000098"));
    expect(session.focusId).toBe("entry");
    expect(session.depth).toBe("all");
  });

  it("frames a null-presentation origin and its one-hop context on first open", () => {
    const value = structure("70000000-0000-4000-8000-000000000097");
    value.nodes.push({
      ...value.nodes[0]!,
      id: "next",
      label: "Next",
      anchor: null,
    });
    value.edges.push({
      id: "entry-next",
      from: "entry",
      to: "next",
      label: "calls",
      directed: true,
      anchors: [],
    });
    const session = createStructureSession(value);
    const viewport = initialStructureViewport({
      structure: value,
      positions: session.positions,
      surfaceSize: { width: 1_200, height: 800 },
    });
    expect(viewport).toEqual(
      structureViewportForNodeIds({
        nodeIds: structureHomeNodeIds(value),
        positions: session.positions,
        surfaceSize: { width: 1_200, height: 800 },
      }),
    );
    expect(viewport.scale).toBeLessThanOrEqual(1.25);
    expect(session.focusId).toBe("entry");
  });

  it("frames only the terminal origin's immediate context, independently of labels", () => {
    const value = structure("70000000-0000-4000-8000-000000000096");
    value.nodes.unshift(
      { ...value.nodes[0]!, id: "root", label: "Root", anchor: null },
      { ...value.nodes[0]!, id: "predecessor", label: "Predecessor", anchor: null },
    );
    value.originNodeId = "entry";
    value.edges.push(
      {
        id: "root-predecessor",
        from: "root",
        to: "predecessor",
        label: "calls",
        directed: true,
        anchors: [],
      },
      {
        id: "predecessor-entry",
        from: "predecessor",
        to: "entry",
        label: "updates with an intentionally very long authored predicate that is not geometry",
        directed: true,
        anchors: [],
      },
    );
    const session = createStructureSession(value);
    const surfaceSize = { width: 1_200, height: 800 };
    const viewport = initialStructureViewport({
      structure: value,
      positions: session.positions,
      surfaceSize,
    });
    expect(viewport).toEqual(
      structureViewportForNodeIds({
        nodeIds: ["predecessor", "entry"],
        positions: session.positions,
        surfaceSize,
      }),
    );
    expect(structureHomeNodeIds(value)).toEqual(new Set(["predecessor", "entry"]));

    value.edges[1]!.label = "short";
    expect(
      initialStructureViewport({ structure: value, positions: session.positions, surfaceSize }),
    ).toEqual(viewport);
    expect(session.focusId).toBe("entry");
  });

  it("uses the same bounded one-hop Home frame in narrow viewports", () => {
    const value = structure("70000000-0000-4000-8000-000000000095");
    value.nodes = ["predecessor", "entry", "s1", "s2", "s3", "s4"].map((id) => ({
      ...value.nodes[0]!,
      id,
      label: id,
      anchor: id === "entry" ? value.nodes[0]!.anchor : null,
    }));
    value.edges = [
      ["predecessor", "entry"],
      ["entry", "s1"],
      ["s1", "s2"],
      ["s2", "s3"],
      ["s3", "s4"],
    ].map(([from, to]) => ({
      id: `${from}-${to}`,
      from: from!,
      to: to!,
      label: "calls with a deliberately long label that cannot affect the viewport",
      directed: true,
      anchors: [],
    }));
    const session = createStructureSession(value);

    for (const width of [800, 1_000]) {
      const surfaceSize = { width, height: 700 };
      const viewport = initialStructureViewport({
        structure: value,
        positions: session.positions,
        surfaceSize,
      });
      expect(viewport).toEqual(
        structureViewportForNodeIds({
          nodeIds: ["predecessor", "entry", "s1"],
          positions: session.positions,
          surfaceSize,
        }),
      );
      expect(viewport.scale).toBeLessThanOrEqual(1.25);

      value.edges[0]!.label = "short";
      expect(
        initialStructureViewport({ structure: value, positions: session.positions, surfaceSize }),
      ).toEqual(viewport);
    }
    expect(session.focusId).toBe("entry");
  });

  it("moves the current reading state between panes without sharing both entries", () => {
    const value = structure("70000000-0000-4000-8000-000000000099");
    const session = {
      ...createStructureSession(value),
      positions: { entry: { x: 777, y: 333 } },
      viewport: { x: 21, y: 34, scale: 1.4 },
    };
    setStructureSession("left", value.id, session);

    transferStructureSession(value.id, "left", "right");

    expect(getStructureSession("left", value.id)).toBeUndefined();
    expect(getStructureSession("right", value.id)).toEqual(session);
    deleteStructureSessions(value.id);
    expect(getStructureSession("right", value.id)).toBeUndefined();
  });

  it("uses one zoom range so zoom-out never enlarges a fitted viewport", () => {
    expect(scaledStructureZoom(MIN_STRUCTURE_ZOOM, 1 / 1.2)).toBe(MIN_STRUCTURE_ZOOM);
    expect(scaledStructureZoom(0.08, 1 / 1.2)).toBeLessThan(0.08);
    expect(scaledStructureZoom(MAX_STRUCTURE_ZOOM, 1.2)).toBe(MAX_STRUCTURE_ZOOM);
  });

  it("fits derived region bounds without changing member geometry", () => {
    const viewport = structureViewportForBounds({
      bounds: { left: 100, top: 200, right: 700, bottom: 500 },
      surfaceSize: { width: 900, height: 600 },
    });

    expect(viewport).not.toBeNull();
    expect(viewport!.scale).toBeLessThanOrEqual(1.25);
    expect(viewport!.x + 100 * viewport!.scale).toBeGreaterThanOrEqual(36);
    expect(viewport!.x + 700 * viewport!.scale).toBeLessThanOrEqual(900 - 36);
    expect(viewport!.y + 200 * viewport!.scale).toBeGreaterThanOrEqual(52);
    expect(viewport!.y + 500 * viewport!.scale).toBeLessThanOrEqual(600 - 36);
  });

  it("derives Home from exact backbone endpoints plus one-hop context", () => {
    const value = presentedStructure("70000000-0000-4000-8000-000000000087");
    value.nodes.push(
      { ...value.nodes[0]!, id: "D", label: "D", anchor: null },
      { ...value.nodes[0]!, id: "E", label: "E", anchor: null },
    );
    value.edges.push(
      { id: "cd", from: "C", to: "D", label: "C to D", directed: true, anchors: [] },
      { id: "de", from: "D", to: "E", label: "D to E", directed: true, anchors: [] },
    );

    expect([...structureBackboneNodeIds(value)].sort()).toEqual(["A", "B", "C"]);
    expect([...structureOneHopNodeIds(value, ["C"])].sort()).toEqual(["A", "B", "C", "D"]);
    expect([...structureHomeNodeIds(value)].sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("frames only the requested exact member geometry", () => {
    const viewport = structureViewportForNodeIds({
      nodeIds: ["left", "right"],
      positions: {
        left: { x: 100, y: 200 },
        right: { x: 700, y: 500 },
        unrelated: { x: 12_000, y: 8_000 },
      },
      surfaceSize: { width: 900, height: 600 },
    })!;

    expect(viewport.scale).toBeGreaterThan(MIN_STRUCTURE_ZOOM);
    expect(viewport.scale).toBeLessThanOrEqual(1.25);
    for (const point of [
      { x: 100, y: 200 },
      { x: 700, y: 500 },
    ]) {
      expect(viewport.x + point.x * viewport.scale).toBeGreaterThanOrEqual(35);
      expect(viewport.x + (point.x + 228) * viewport.scale).toBeLessThanOrEqual(865);
      expect(viewport.y + point.y * viewport.scale).toBeGreaterThanOrEqual(51);
      expect(viewport.y + (point.y + 112) * viewport.scale).toBeLessThanOrEqual(565);
    }
  });

  it("starts with a compact Guide disclosure and bounded pane-local navigation history", () => {
    expect(initialStructureGuideDisclosure()).toEqual({
      thesis: true,
      coreRelations: false,
      regions: false,
    });

    const first = {
      focusId: "A",
      depth: "all" as const,
      framedRegionIndex: null,
      viewport: { x: 1, y: 2, scale: 1 },
    };
    expect(appendStructureNavigationHistory([first], first)).toEqual([first]);
    expect(
      appendStructureNavigationHistory([first], {
        ...first,
        depth: 1,
      }),
    ).toEqual([first, { ...first, depth: 1 }]);
    expect(
      appendStructureNavigationHistory([first], {
        ...first,
        framedRegionIndex: 0,
      }),
    ).toEqual([first, { ...first, framedRegionIndex: 0 }]);
    const history = Array.from({ length: 55 }, (_, index) => ({
      focusId: `node-${index}`,
      depth: "all" as const,
      framedRegionIndex: null,
      viewport: { x: index, y: index * 2, scale: 1 },
    })).reduce(appendStructureNavigationHistory, []);
    expect(history).toHaveLength(50);
    expect(history[0]!.focusId).toBe("node-5");
    expect(history.at(-1)!.focusId).toBe("node-54");
  });

  it("keys only the authored fields that determine canonical geometry", () => {
    const value = presentedStructure("70000000-0000-4000-8000-000000000094");
    const baseline = structureLayoutBasisKey(value);
    expect(
      structureLayoutBasisKey({
        edges: value.edges,
        presentation: {
          ...value.presentation!,
          thesis: "Different prose must not move the graph.",
          regions: value.presentation!.regions.map((region) => ({
            label: `Renamed ${region.label}`,
            nodeIds: [...region.nodeIds].reverse(),
          })),
        },
      }),
    ).toBe(baseline);
    expect(
      structureLayoutBasisKey({
        edges: value.edges,
        presentation: {
          ...value.presentation!,
          regions: [...value.presentation!.regions].reverse(),
        },
      }),
    ).not.toBe(baseline);
    expect(
      structureLayoutBasisKey({
        edges: value.edges,
        presentation: {
          ...value.presentation!,
          primaryBackbone: { edgeIds: ["ab-parallel", "bc"] },
        },
      }),
    ).toBe(baseline);
    expect(
      structureLayoutBasisKey({
        edges: value.edges,
        presentation: {
          ...value.presentation!,
          primaryBackbone: { edgeIds: ["ac", "bc"] },
        },
      }),
    ).not.toBe(baseline);
    expect(
      structureLayoutBasisKey({
        edges: value.edges,
        presentation: { ...value.presentation!, startNodeId: "B" },
      }),
    ).not.toBe(baseline);
    expect(structureLayoutBasisKey({ presentation: null, edges: value.edges })).not.toBe(baseline);
  });

  it("treats a start-only presentation as topology geometry while starting attention at its Node", () => {
    const value = presentedStructure("70000000-0000-4000-8000-000000000086");
    const topologyValue: Structure = { ...value, presentation: null };
    const startOnly: Structure = {
      ...value,
      presentation: {
        thesis: "Begin at B without inventing a backbone or chunk.",
        startNodeId: "B",
        primaryBackbone: null,
        regions: [],
      },
    };

    const session = createStructureSession(startOnly);
    expect(session.focusId).toBe("B");
    expect(session.positions).toEqual(initialStructureLayout(topologyValue));
    expect(structureLayoutBasisKey(startOnly)).toBe(structureLayoutBasisKey(topologyValue));

    const manual = {
      ...session,
      positions: {
        A: { x: 701, y: 702 },
        B: { x: 703, y: 704 },
        C: { x: 705, y: 706 },
      },
    };
    const changedStart: Structure = {
      ...startOnly,
      updatedAt: "2026-08-30T00:01:00.000Z",
      presentation: {
        ...startOnly.presentation!,
        thesis: "Begin at C without inventing a backbone or chunk.",
        startNodeId: "C",
      },
    };
    const reconciled = reconcileStructureSession(changedStart, manual);
    expect(reconciled.positions).toEqual(manual.positions);
    expect(reconciled.focusId).toBe("B");

    const organized: Structure = {
      ...changedStart,
      updatedAt: "2026-08-30T00:02:00.000Z",
      presentation: {
        ...changedStart.presentation!,
        regions: [{ label: "Policy", nodeIds: ["B", "C"] }],
      },
    };
    const organizedSession = reconcileStructureSession(organized, reconciled);
    expect(organizedSession.positions).toEqual(initialStructureLayout(organized));
    expect(organizedSession.focusId).toBe("B");
  });

  it("rebases changed backbone adjacency while preserving reviewer state and focus position", () => {
    const value = presentedStructure("70000000-0000-4000-8000-000000000093");
    const session = {
      ...createStructureSession(value),
      focusId: "B",
      selectedEdgeId: "ab",
      depth: 2 as const,
      framedRegionIndex: 1,
      positions: {
        A: { x: 100, y: 80 },
        B: { x: 760, y: 330 },
        C: { x: 1_220, y: 110 },
      },
      viewport: { x: -215, y: 74, scale: 1.4 },
    };
    const updated: Structure = {
      ...value,
      updatedAt: "2026-08-30T00:01:00.000Z",
      presentation: {
        ...value.presentation!,
        primaryBackbone: { edgeIds: ["ac", "bc"] },
      },
    };

    const reconciled = reconcileStructureSession(updated, session);
    expect(reconciled.positions).toEqual(initialStructureLayout(updated));
    expect(reconciled.focusId).toBe("B");
    expect(reconciled.selectedEdgeId).toBe("ab");
    expect(reconciled.depth).toBe(2);
    expect(reconciled.framedRegionIndex).toBeNull();
    expect(reconciled.viewport.scale).toBe(session.viewport.scale);
    expect(reconciled.viewport.x + reconciled.positions.B!.x * reconciled.viewport.scale).toBe(
      session.viewport.x + session.positions.B.x * session.viewport.scale,
    );
    expect(reconciled.viewport.y + reconciled.positions.B!.y * reconciled.viewport.scale).toBe(
      session.viewport.y + session.positions.B.y * session.viewport.scale,
    );
  });

  it("rebases for ordered regions and null transitions", () => {
    const value = presentedStructure("70000000-0000-4000-8000-000000000092");
    const session = {
      ...createStructureSession(value),
      framedRegionIndex: 1,
      positions: {
        A: { x: 901, y: 902 },
        B: { x: 903, y: 904 },
        C: { x: 905, y: 906 },
      },
    };
    const reordered: Structure = {
      ...value,
      updatedAt: "2026-08-30T00:01:00.000Z",
      presentation: {
        ...value.presentation!,
        primaryBackbone: null,
        regions: [...value.presentation!.regions].reverse(),
      },
    };
    const regionReconciled = reconcileStructureSession(reordered, session);
    expect(regionReconciled.positions).toEqual(initialStructureLayout(reordered));
    expect(regionReconciled.framedRegionIndex).toBeNull();

    const withoutPresentation: Structure = {
      ...reordered,
      updatedAt: "2026-08-30T00:02:00.000Z",
      presentation: null,
    };
    const nullReconciled = reconcileStructureSession(withoutPresentation, {
      ...regionReconciled,
      positions: {
        A: { x: 801, y: 802 },
        B: { x: 803, y: 804 },
        C: { x: 805, y: 806 },
      },
    });
    expect(nullReconciled.positions).toEqual(initialStructureLayout(withoutPresentation));
  });

  it("preserves the layout center on screen when a rebase has no surviving focus", () => {
    const value = presentedStructure("70000000-0000-4000-8000-000000000089");
    const session = {
      ...createStructureSession(value),
      focusId: null,
      positions: {
        A: { x: 10_000, y: 4_000 },
        B: { x: 10_600, y: 4_400 },
        C: { x: 11_200, y: 4_800 },
      },
      viewport: { x: -10_100, y: -4_050, scale: 1.25 },
    };
    const updated: Structure = {
      ...value,
      updatedAt: "2026-08-30T00:01:00.000Z",
      presentation: {
        ...value.presentation!,
        primaryBackbone: { edgeIds: ["ac", "bc"] },
      },
    };
    const previousCenter = {
      x: (session.positions.A.x + session.positions.C.x + 228) / 2,
      y: (session.positions.A.y + session.positions.C.y + 112) / 2,
    };

    const reconciled = reconcileStructureSession(updated, session);
    const nextXs = Object.values(reconciled.positions).map(({ x }) => x);
    const nextYs = Object.values(reconciled.positions).map(({ y }) => y);
    const nextCenter = {
      x: (Math.min(...nextXs) + Math.max(...nextXs) + 228) / 2,
      y: (Math.min(...nextYs) + Math.max(...nextYs) + 112) / 2,
    };
    expect(reconciled.focusId).toBeNull();
    expect(reconciled.viewport.scale).toBe(session.viewport.scale);
    expect(reconciled.viewport.x + nextCenter.x * reconciled.viewport.scale).toBe(
      session.viewport.x + previousCenter.x * session.viewport.scale,
    );
    expect(reconciled.viewport.y + nextCenter.y * reconciled.viewport.scale).toBe(
      session.viewport.y + previousCenter.y * session.viewport.scale,
    );
  });

  it("retains survivor positions for prose-only and graph-only updates", () => {
    const value = presentedStructure("70000000-0000-4000-8000-000000000091");
    const manual = {
      A: { x: 501, y: 502 },
      B: { x: 503, y: 504 },
      C: { x: 505, y: 506 },
    };
    const session = {
      ...createStructureSession(value),
      framedRegionIndex: 1,
      positions: manual,
    };
    const proseOnly: Structure = {
      ...value,
      updatedAt: "2026-08-30T00:01:00.000Z",
      presentation: {
        ...value.presentation!,
        thesis: "A revised thesis that does not carry geometry.",
        regions: value.presentation!.regions.map((region) => ({
          ...region,
          label: `Renamed ${region.label}`,
        })),
      },
    };
    const proseReconciled = reconcileStructureSession(proseOnly, session);
    expect(proseReconciled.positions).toEqual(manual);
    expect(proseReconciled.viewport).toEqual(session.viewport);
    expect(proseReconciled.framedRegionIndex).toBe(1);

    const graphOnly: Structure = {
      ...proseOnly,
      updatedAt: "2026-08-30T00:02:00.000Z",
      nodes: [
        ...proseOnly.nodes,
        {
          id: "D",
          label: "D",
          description: null,
          kind: null,
          notation: "plain",
          anchor: null,
        },
      ],
      edges: [
        ...proseOnly.edges,
        { id: "cd", from: "C", to: "D", label: "C to D", directed: true, anchors: [] },
      ],
    };
    const graphReconciled = reconcileStructureSession(graphOnly, proseReconciled);
    expect(graphReconciled.positions.A).toEqual(manual.A);
    expect(graphReconciled.positions.B).toEqual(manual.B);
    expect(graphReconciled.positions.C).toEqual(manual.C);
    expect(graphReconciled.positions.D).toBeDefined();
  });

  it("preserves Guide disclosure and prunes navigation history only for removed targets", () => {
    const value = presentedStructure("70000000-0000-4000-8000-000000000085");
    const session = {
      ...createStructureSession(value),
      guideDisclosure: { thesis: false, coreRelations: true, regions: true },
      navigationHistory: [
        {
          focusId: "B",
          depth: 1 as const,
          framedRegionIndex: 0,
          viewport: { x: 10, y: 20, scale: 1 },
        },
        {
          focusId: "C",
          depth: 2 as const,
          framedRegionIndex: 1,
          viewport: { x: 30, y: 40, scale: 1.2 },
        },
        {
          focusId: null,
          depth: "all" as const,
          framedRegionIndex: null,
          viewport: { x: 50, y: 60, scale: 0.8 },
        },
      ],
    };
    const updated: Structure = {
      ...value,
      updatedAt: "2026-08-30T00:01:00.000Z",
      nodes: value.nodes.filter((node) => node.id !== "C"),
      edges: value.edges.filter((edge) => edge.from !== "C" && edge.to !== "C"),
      presentation: {
        ...value.presentation!,
        primaryBackbone: { edgeIds: ["ab"] },
        regions: [{ label: "First", nodeIds: ["A", "B"] }],
      },
    };

    const reconciled = reconcileStructureSession(updated, session);

    expect(reconciled.guideDisclosure).toEqual(session.guideDisclosure);
    expect(reconciled.navigationHistory.map(({ focusId }) => focusId)).toEqual(["B", null]);
    expect(reconciled.navigationHistory.map(({ depth }) => depth)).toEqual([1, "all"]);
    expect(reconciled.navigationHistory.map(({ framedRegionIndex }) => framedRegionIndex)).toEqual([
      null,
      null,
    ]);
    expect(reconciled.navigationHistory[0]!.viewport.scale).toBe(1);
    expect(reconciled.navigationHistory[1]!.viewport.scale).toBe(0.8);
  });

  it("centers replacement geometry when no Node survives a rebase", () => {
    const value = presentedStructure("70000000-0000-4000-8000-000000000088");
    const session = {
      ...createStructureSession(value),
      focusId: "B",
      positions: {
        A: { x: 10_000, y: 4_000 },
        B: { x: 10_600, y: 4_400 },
        C: { x: 11_200, y: 4_800 },
      },
      viewport: { x: -10_100, y: -4_050, scale: 1.25 },
      surfaceSize: { width: 800, height: 600 },
    };
    const updated: Structure = {
      ...value,
      updatedAt: "2026-08-30T00:01:00.000Z",
      originNodeId: "X",
      nodes: ["X", "Y"].map((nodeId) => ({
        ...value.nodes[0]!,
        id: nodeId,
        label: nodeId,
        anchor: nodeId === "X" ? value.nodes[0]!.anchor : null,
      })),
      edges: [{ id: "xy", from: "X", to: "Y", label: "X to Y", directed: true, anchors: [] }],
      presentation: {
        thesis: "The replacement has no stable Node identity.",
        startNodeId: "X",
        primaryBackbone: { edgeIds: ["xy"] },
        regions: [],
      },
    };

    const reconciled = reconcileStructureSession(updated, session);
    const xs = Object.values(reconciled.positions).map(({ x }) => x);
    const ys = Object.values(reconciled.positions).map(({ y }) => y);
    const center = {
      x: (Math.min(...xs) + Math.max(...xs) + 228) / 2,
      y: (Math.min(...ys) + Math.max(...ys) + 112) / 2,
    };
    expect(reconciled.focusId).toBeNull();
    expect(reconciled.viewport.scale).toBe(session.viewport.scale);
    expect(reconciled.viewport.x + center.x * reconciled.viewport.scale).toBe(400);
    expect(reconciled.viewport.y + center.y * reconciled.viewport.scale).toBe(300);
  });

  it("reconciles a cached closed-tab session before restoring it", () => {
    const value = presentedStructure("70000000-0000-4000-8000-000000000090");
    const cached = {
      ...createStructureSession(value),
      positions: {
        A: { x: 701, y: 702 },
        B: { x: 703, y: 704 },
        C: { x: 705, y: 706 },
      },
    };
    setStructureSession("left", value.id, cached);
    const updated: Structure = {
      ...value,
      updatedAt: "2026-08-30T00:01:00.000Z",
      presentation: {
        ...value.presentation!,
        primaryBackbone: { edgeIds: ["ac", "bc"] },
      },
    };

    const restored = reconcileStructureSession(updated, getStructureSession("left", value.id)!);
    expect(restored.positions).toEqual(initialStructureLayout(updated));
    expect(restored.layoutBasisKey).toBe(structureLayoutBasisKey(updated));
    deleteStructureSessions(value.id);
  });

  it("keeps the focused Node at the same screen coordinate when resetting geometry", () => {
    const viewport = { x: -120, y: 70, scale: 1.75 };
    const previousPositions = { focus: { x: 720, y: 410 } };
    const nextPositions = { focus: { x: 64, y: 96 } };
    const nextViewport = preserveStructureLayoutScreenPosition({
      viewport,
      surfaceSize: { width: 800, height: 600 },
      nodeId: "focus",
      nodeIds: ["focus"],
      previousPositions,
      nextPositions,
    });
    expect(nextViewport.scale).toBe(viewport.scale);
    expect(nextViewport.x + nextPositions.focus.x * nextViewport.scale).toBe(
      viewport.x + previousPositions.focus.x * viewport.scale,
    );
    expect(nextViewport.y + nextPositions.focus.y * nextViewport.scale).toBe(
      viewport.y + previousPositions.focus.y * viewport.scale,
    );
  });
});
