import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import type { StructurePoint } from "../../src/web/structure-graph.js";
import { retryAutomaticStructureLayoutSpacing } from "../../src/web/structure-layout-spacing.js";
import type { StructureEdgeLabelPlacement } from "../../src/web/structure-render-model.js";

function structure(): Structure {
  return {
    id: "spacing",
    title: "Spacing",
    ref: "rvw://structure/spacing",
    pullRequestId: "pr",
    originNodeId: "a",
    sourceOid: "a".repeat(40),
    scope: "fixture",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    presentation: null,
    nodes: [
      { id: "a", label: "A", description: null, kind: null, notation: "plain", anchor: null },
      { id: "b", label: "B", description: null, kind: null, notation: "plain", anchor: null },
      { id: "c", label: "C", description: null, kind: null, notation: "plain", anchor: null },
      { id: "d", label: "D", description: null, kind: null, notation: "plain", anchor: null },
    ],
    edges: [
      { id: "ab", from: "a", to: "b", label: "AB", directed: true, anchors: [] },
      { id: "ac", from: "a", to: "c", label: "AC", directed: true, anchors: [] },
      { id: "dd", from: "d", to: "d", label: "DD", directed: true, anchors: [] },
    ],
  };
}

function pressure(
  edge: Structure["edges"][number],
  edgeDistance: number,
  fallbackReason: StructureEdgeLabelPlacement["diagnostics"]["fallbackReason"] = "distant",
): StructureEdgeLabelPlacement {
  return {
    edge,
    displayLines: [edge.label],
    source: { anchorCount: 0, changeKind: null },
    x: 0,
    y: 0,
    selectWidth: 80,
    boxWidth: 80,
    height: 20,
    crowded: true,
    displaced: true,
    leaderPath: null,
    leaderBounds: null,
    leaderEdgeAnchor: null,
    leaderLabelAnchor: null,
    sourceMenuPlacement: null,
    sourceMenuWidth: null,
    diagnostics: {
      edgeDistance,
      leaderLength: edgeDistance,
      maxParallelOverlap: 0,
      crossingCount: 0,
      usedCompactWidth: false,
      spacingPressure: true,
      fallbackReason,
    },
  };
}

describe("automatic Structure label spacing", () => {
  it("opens only implicated bands while keeping the requested anchor exact", () => {
    const fixture = structure();
    const positions = {
      a: { x: 100, y: 100 },
      b: { x: 300, y: 100 },
      c: { x: 100, y: 300 },
      d: { x: 500, y: 500 },
    };
    const next = retryAutomaticStructureLayoutSpacing({
      structure: fixture,
      anchorNodeId: "a",
      attempt: 1,
      positions,
      pressureLabels: [pressure(fixture.edges[0]!, 90), pressure(fixture.edges[1]!, 80)],
    });

    expect(next).not.toBeNull();
    expect(next?.a).toEqual(positions.a);
    expect(next!.b!.x - next!.a!.x).toBeGreaterThan(positions.b.x - positions.a.x);
    expect(next!.b!.y).toBe(positions.b.y);
    expect(next!.c!.y - next!.a!.y).toBeGreaterThan(positions.c.y - positions.a.y);
    expect(next!.c!.x).toBe(positions.c.x);
  });

  it("is deterministic when diagnostic input order changes", () => {
    const fixture = structure();
    const positions = {
      a: { x: 100, y: 100 },
      b: { x: 300, y: 100 },
      c: { x: 100, y: 300 },
      d: { x: 500, y: 500 },
    };
    const labels = [pressure(fixture.edges[0]!, 50), pressure(fixture.edges[1]!, 90)];
    const run = (pressureLabels: StructureEdgeLabelPlacement[]) =>
      retryAutomaticStructureLayoutSpacing({
        structure: fixture,
        anchorNodeId: "a",
        attempt: 2,
        positions,
        pressureLabels,
      });

    expect(run(labels)).toEqual(run([...labels].reverse()));
  });

  it("uses only the local map's available extent while opening implicated bands", () => {
    const fixture = structure();
    const positions = {
      a: { x: 100, y: 100 },
      b: { x: 300, y: 100 },
      c: { x: 100, y: 300 },
      d: { x: 500, y: 500 },
    };
    const maximumExtentPositions = {
      a: { x: 100, y: 100 },
      b: { x: 300, y: 100 },
      c: { x: 100, y: 300 },
      d: { x: 532, y: 536 },
    };
    const next = retryAutomaticStructureLayoutSpacing({
      structure: fixture,
      anchorNodeId: "a",
      attempt: 1,
      positions,
      pressureLabels: [pressure(fixture.edges[0]!, 90), pressure(fixture.edges[1]!, 80)],
      maximumExtentPositions,
      minimumExtentReduction: 24,
    })!;
    const extent = (
      axis: "x" | "y",
      candidate: Readonly<Record<string, StructurePoint>>,
    ): number => {
      const values = Object.values(candidate).map((point) => point[axis]);
      return Math.max(...values) - Math.min(...values);
    };

    expect(next.a).toEqual(positions.a);
    expect(next.b!.x - next.a!.x).toBeGreaterThan(positions.b.x - positions.a.x);
    expect(next.c!.y - next.a!.y).toBeGreaterThan(positions.c.y - positions.a.y);
    expect(extent("x", next)).toBeCloseTo(extent("x", maximumExtentPositions) - 24);
    expect(extent("y", next)).toBeCloseTo(extent("y", maximumExtentPositions) - 24);
  });

  it("opens an emergency short-edge band enough to make a nearby label viable", () => {
    const fixture = structure();
    const positions = {
      a: { x: 100, y: 100 },
      b: { x: 152, y: 100 },
      c: { x: 100, y: 300 },
      d: { x: 500, y: 500 },
    };
    const run = (
      attempt: 1 | 2,
      fallbackReason: StructureEdgeLabelPlacement["diagnostics"]["fallbackReason"],
    ) =>
      retryAutomaticStructureLayoutSpacing({
        structure: fixture,
        anchorNodeId: "a",
        attempt,
        positions,
        pressureLabels: [pressure(fixture.edges[0]!, 180, fallbackReason)],
      })!;

    const distant = run(1, "distant");
    const firstEmergency = run(1, "emergency");
    const secondEmergency = run(2, "emergency");
    expect(distant.a).toEqual(positions.a);
    expect(firstEmergency.a).toEqual(positions.a);
    expect(firstEmergency.b!.x - firstEmergency.a!.x).toBe(positions.b.x - positions.a.x + 72);
    expect(secondEmergency.b!.x - secondEmergency.a!.x).toBe(positions.b.x - positions.a.x + 56);
    expect(firstEmergency.b!.x - firstEmergency.a!.x).toBeGreaterThan(distant.b!.x - distant.a!.x);
  });

  it("declines a retry when spacing cannot help a self-loop", () => {
    const fixture = structure();
    const positions = {
      a: { x: 100, y: 100 },
      b: { x: 300, y: 100 },
      c: { x: 100, y: 300 },
      d: { x: 500, y: 500 },
    };

    expect(
      retryAutomaticStructureLayoutSpacing({
        structure: fixture,
        anchorNodeId: "d",
        attempt: 1,
        positions,
        pressureLabels: [pressure(fixture.edges[2]!, 120, "emergency")],
      }),
    ).toBeNull();
  });
});
