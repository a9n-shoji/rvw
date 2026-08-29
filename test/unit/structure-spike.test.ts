import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  collapsedStructureRelations,
  initialStructureLayout,
  reconcileStructureLayout,
  structureEdgeRouteOffsets,
  structureNeighborhood,
  visibleStructureGraph,
} from "../../src/web/structure-spike/graph.js";
import { structureFixtures } from "../../src/web/structure-spike/fixtures.js";
import type { SourceAnchor, Structure } from "../../src/web/structure-spike/model.js";

function fixtureStructure(id: string): Structure {
  const fixture = structureFixtures.find((candidate) => candidate.structure.id === id);
  if (!fixture) throw new Error(`Fixture not found: ${id}`);
  return fixture.structure;
}

function anchors(structure: Structure): SourceAnchor[] {
  return [
    ...structure.nodes.flatMap((node) => (node.anchor ? [node.anchor] : [])),
    ...structure.edges.flatMap((edge) => edge.anchors ?? []),
  ];
}

describe("Structure Phase 0 fixtures", () => {
  it("includes code relationships, flow comparisons, and exact 20 / 100 / 500 node fixtures", () => {
    expect(
      structureFixtures.filter((fixture) => fixture.category === "Code relationships"),
    ).toHaveLength(4);
    expect(
      structureFixtures.filter((fixture) => fixture.category === "Flow comparisons"),
    ).toHaveLength(3);
    expect(structureFixtures.filter((fixture) => fixture.category === "Synthetic")).toHaveLength(3);
    expect(fixtureStructure("synthetic-20").nodes).toHaveLength(20);
    expect(fixtureStructure("synthetic-100").nodes).toHaveLength(100);
    expect(fixtureStructure("synthetic-500").nodes).toHaveLength(500);
  });

  it("models code-centered neighborhoods rather than author-ordered paths", () => {
    const fixtures = structureFixtures.filter(
      (fixture) => fixture.category === "Code relationships",
    );
    for (const fixture of fixtures) {
      const focus = fixture.structure.initialFocus;
      expect(focus).toBeTruthy();
      const relations = fixture.structure.edges.filter(
        (edge) => edge.from === focus || edge.to === focus,
      );
      if (fixture.structure.id === "rails-react-jobs-page-code-neighborhood") {
        expect(relations, fixture.structure.id).toHaveLength(2);
      } else {
        expect(relations.length, fixture.structure.id).toBeGreaterThanOrEqual(6);
      }
      expect(
        relations.some((edge) => edge.from === focus),
        fixture.structure.id,
      ).toBe(true);
      expect(
        relations.some((edge) => edge.to === focus),
        fixture.structure.id,
      ).toBe(true);
      expect(fixture.walkthroughMermaid).toBeUndefined();
    }
  });

  it("keeps diagram notation producer-authored instead of deriving it from kind", () => {
    const structure = fixtureStructure("rvw-service-code-neighborhood");
    const service = structure.nodes.find((node) => node.id === "rvw-service-class");
    const database = structure.nodes.find((node) => node.id === "rvw-database-class");
    const port = structure.nodes.find((node) => node.id === "github-port");
    expect(service).toMatchObject({ kind: "class", notation: "class" });
    expect(database).toMatchObject({ kind: "class", notation: "database" });
    expect(port).toMatchObject({ kind: "interface", notation: "interface" });
  });

  it("lays out the Rails View and React root on opposite sides of their mount contract", () => {
    const fixture = structureFixtures.find(
      (candidate) => candidate.structure.id === "rails-react-jobs-page-code-neighborhood",
    );
    if (!fixture) throw new Error("Rails / React fixture missing");
    expect(fixture.layout).toBe("bidirectional");
    const positions = initialStructureLayout(fixture.structure, fixture.layout);
    expect(positions["jobs-index-view"]!.x).toBeLessThan(positions["jobs-dom-mount-contract"]!.x);
    expect(positions["jobs-controller"]!.x).toBeLessThan(positions["jobs-index-view"]!.x);
    expect(positions["jobs-react-entry"]!.x).toBeGreaterThan(
      positions["jobs-dom-mount-contract"]!.x,
    );
    expect(positions["jobs-page-component"]!.x).toBeGreaterThan(positions["jobs-react-entry"]!.x);
    expect(fixture.sourceChangeKinds).toMatchObject({
      "test/fixtures/structure-spike/rails-react-page/app/views/jobs/index.html.erb": "modified",
      "test/fixtures/structure-spike/rails-react-page/app/frontend/entries/jobs.tsx": "added",
    });
  });

  it("keeps stable identities unique and every relation endpoint declared", () => {
    for (const fixture of structureFixtures) {
      for (const structure of [fixture.structure, fixture.updatedStructure].filter(
        (value): value is Structure => value !== undefined,
      )) {
        const nodeIds = structure.nodes.map((node) => node.id);
        const edgeIds = structure.edges.map((edge) => edge.id);
        expect(new Set(nodeIds).size, `${structure.id} node IDs`).toBe(nodeIds.length);
        expect(new Set(edgeIds).size, `${structure.id} edge IDs`).toBe(edgeIds.length);
        for (const edge of structure.edges) {
          expect(nodeIds, `${structure.id}:${edge.id} from`).toContain(edge.from);
          expect(nodeIds, `${structure.id}:${edge.id} to`).toContain(edge.to);
          expect(edge.label.length, `${structure.id}:${edge.id} label`).toBeGreaterThan(0);
          expect(typeof edge.directed).toBe("boolean");
        }
      }
    }
  });

  it("points real fixture anchors at existing repository source ranges", () => {
    const real = structureFixtures.filter((fixture) => fixture.category !== "Synthetic");
    const previewServer = readFileSync("test/e2e/fixture-server.mjs", "utf8");
    expect(real.flatMap((fixture) => anchors(fixture.structure)).length).toBeGreaterThan(30);
    for (const fixture of real) {
      for (const anchor of anchors(fixture.structure)) {
        expect(existsSync(anchor.path), `${fixture.structure.id}:${anchor.path}`).toBe(true);
        expect(
          previewServer.includes(JSON.stringify(anchor.path)),
          `${fixture.structure.id}:${anchor.path} preview allowlist`,
        ).toBe(true);
        expect(anchor.startLine === undefined).toBe(anchor.endLine === undefined);
        if (anchor.startLine === undefined || anchor.endLine === undefined) continue;
        const lineCount = readFileSync(anchor.path, "utf8").split("\n").length;
        expect(anchor.startLine).toBeGreaterThan(0);
        expect(anchor.endLine).toBeGreaterThanOrEqual(anchor.startLine);
        expect(anchor.endLine, `${anchor.path} line count`).toBeLessThanOrEqual(lineCount);
      }
    }
  });

  it("keeps collapse content-neutral and stable under semantic text changes", () => {
    const structure = fixtureStructure("synthetic-20");
    const original = collapsedStructureRelations(structure, "node-000", false);
    expect(original.collapsed).toBe(true);
    expect(original.hiddenEdgeIds.size).toBeGreaterThan(0);
    const relabeled: Structure = {
      ...structure,
      nodes: structure.nodes.map((node) => ({
        ...node,
        label: `semantically changed ${node.id}`,
        description: `new meaning for ${node.id}`,
        kind: `framework-specific-${node.id}`,
      })),
      edges: structure.edges.map((edge) => ({
        ...edge,
        label: `semantic taxonomy ${edge.id}`,
      })),
    };
    const changed = collapsedStructureRelations(relabeled, "node-000", false);
    expect([...changed.visibleEdgeIds]).toEqual([...original.visibleEdgeIds]);
    expect([...changed.hiddenEdgeIds]).toEqual([...original.hiddenEdgeIds]);
  });

  it("routes reciprocal relations onto stable content-neutral lanes", () => {
    const structure = fixtureStructure("rails-react-jobs-page-code-neighborhood");
    const reciprocal = structure.edges.filter(
      (edge) => edge.id === "rails-react-16" || edge.id === "rails-react-17",
    );
    const offsets = structureEdgeRouteOffsets(reciprocal);
    expect(offsets.get("rails-react-16")).toBeGreaterThan(0);
    expect(offsets.get("rails-react-17")).toBe(offsets.get("rails-react-16"));
    const relabeled = reciprocal.map((edge) => ({
      ...edge,
      label: `意味を変更 ${edge.id}`,
    }));
    expect([...structureEdgeRouteOffsets(relabeled)]).toEqual([...offsets]);
  });

  it("preserves every common Node ID position across a current-value update", () => {
    const fixture = structureFixtures.find(
      (candidate) => candidate.structure.id === "rvw-comment-watch-flow",
    );
    if (!fixture?.updatedStructure) throw new Error("updated fixture missing");
    const baseline = initialStructureLayout(fixture.structure);
    baseline["ordered-event-log"] = { x: 731, y: 419 };
    const updated = reconcileStructureLayout(fixture.updatedStructure, baseline);
    for (const node of fixture.structure.nodes) {
      expect(updated[node.id], node.id).toEqual(baseline[node.id]);
    }
    expect(updated["notification-scan"]).toBeDefined();
    expect(Number.isFinite(updated["notification-scan"]!.x)).toBe(true);
    expect(Number.isFinite(updated["notification-scan"]!.y)).toBe(true);
  });

  it("supports gradual neighborhoods and a disconnected synthetic area", () => {
    const structure = fixtureStructure("synthetic-100");
    const oneHop = structureNeighborhood(structure, "node-000", 1);
    const twoHop = structureNeighborhood(structure, "node-000", 2);
    const all = structureNeighborhood(structure, "node-000", "all");
    expect(oneHop.size).toBeLessThan(twoHop.size);
    expect(twoHop.size).toBeLessThan(all.size);
    expect(all.size).toBe(100);
    expect(twoHop.has("node-099")).toBe(false);
  });

  it("lays out and filters 500 nodes within a bounded spike budget", () => {
    const structure = fixtureStructure("synthetic-500");
    const started = performance.now();
    const positions = initialStructureLayout(structure);
    const overview = visibleStructureGraph(structure, structure.initialFocus ?? null, "all", true);
    const duration = performance.now() - started;
    expect(Object.keys(positions)).toHaveLength(500);
    expect(overview.nodeIds.size).toBe(500);
    expect(overview.edgeIds.size).toBe(structure.edges.length);
    expect(duration).toBeLessThan(500);
  });
});
