import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import {
  createStructureSession,
  deleteStructureSessions,
  getStructureSession,
  initialStructureViewport,
  MAX_STRUCTURE_ZOOM,
  MIN_STRUCTURE_ZOOM,
  scaledStructureZoom,
  setStructureSession,
  transferStructureSession,
} from "../../src/web/structure-session.js";

function structure(id: string): Structure {
  return {
    id,
    ref: `rvw://structure/${id}`,
    pullRequestId: "pr-1",
    sourceOid: "a".repeat(40),
    title: "Session boundary",
    scope: "A bounded test Structure.",
    originNodeId: "entry",
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

describe("Structure pane sessions", () => {
  it("starts from the complete map while highlighting the authored behavior entrypoint", () => {
    const session = createStructureSession(structure("70000000-0000-4000-8000-000000000098"));
    expect(session.focusId).toBe("entry");
    expect(session.depth).toBe("all");
  });

  it("keeps an entrypoint origin at one quarter of the initial viewport", () => {
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
    const originCenter = session.positions.entry!.x + 228 / 2 + viewport.x;
    expect(originCenter).toBe(300);
    expect(viewport.scale).toBe(1);
    expect(session.focusId).toBe("entry");
  });

  it("moves a terminal origin rightward using node-only predecessor spans", () => {
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
    const originViewportX = session.positions.entry!.x + 228 / 2 + viewport.x;
    const predecessorViewportX = session.positions.predecessor!.x + 228 / 2 + viewport.x;
    expect(originViewportX / surfaceSize.width).toBeGreaterThanOrEqual(0.35);
    expect(originViewportX / surfaceSize.width).toBeLessThanOrEqual(0.5);
    expect(predecessorViewportX).toBeGreaterThan(0);
    expect(predecessorViewportX).toBeLessThan(surfaceSize.width);
    expect(viewport.scale).toBe(1);

    value.edges[1]!.label = "short";
    expect(
      initialStructureViewport({ structure: value, positions: session.positions, surfaceSize }),
    ).toEqual(viewport);
    expect(session.focusId).toBe("entry");
  });

  it("keeps the nearest predecessor visible for a narrow intermediate-origin viewport", () => {
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
      const originViewportX = session.positions.entry!.x + 228 / 2 + viewport.x;
      const predecessorLeft = session.positions.predecessor!.x + viewport.x;
      const predecessorRight = predecessorLeft + 228;
      const predecessorVisibleWidth = Math.max(
        0,
        Math.min(width, predecessorRight) - Math.max(0, predecessorLeft),
      );

      expect(originViewportX / width).toBeGreaterThanOrEqual(0.35);
      expect(originViewportX / width).toBeLessThanOrEqual(0.5);
      expect(predecessorVisibleWidth).toBeGreaterThanOrEqual(64);
      expect(viewport.scale).toBe(1);

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
});
