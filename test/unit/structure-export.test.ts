import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import {
  assertCompleteStructureExport,
  planStructurePngRaster,
  serializeStructureSvg,
  StructureExportError,
  structureExportFilename,
  type StructureExportPalette,
} from "../../src/web/structure-export.js";
import { initialStructureLayout, STRUCTURE_NODE_HEIGHT } from "../../src/web/structure-graph.js";
import {
  buildFullStructureRenderModel,
  EDGE_LABEL_LINE_HEIGHT,
  STRUCTURE_EDGE_ARROW_LENGTH,
  STRUCTURE_EDGE_ARROW_WIDTH,
  structureTextUnits,
  wrapStructureText,
} from "../../src/web/structure-render-model.js";

const palette: StructureExportPalette = {
  background: "#0d1117",
  panel: "#161b22",
  text: "#e6edf3",
  muted: "#8b949e",
  line: "#30363d",
  lineStrong: "#484f58",
  accent: "#58a6ff",
  success: "#3fb950",
  attention: "#d29922",
  danger: "#ff7b72",
  done: "#d2a8ff",
  info: "#58a6ff",
};

function exportStructure(): Structure {
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
    id: "70000000-0000-4000-8000-000000000122",
    ref: "rvw://structure/70000000-0000-4000-8000-000000000122",
    pullRequestId: "pr-1",
    sourceOid: "abcdef12".repeat(5),
    title: 'Unsafe <Structure> & "export"',
    scope: "Scope with </desc><script>alert(1)</script> and \u0001 control.",
    originNodeId: "node-0",
    presentation: null,
    nodes: notations.map((notation, index) => ({
      id: `node-${index}`,
      label:
        index === 0 ? `Very long <entry> & label ${"segment/".repeat(20)} ending` : `Node ${index}`,
      description:
        index === 0
          ? `Long description ${"details and context ".repeat(30)} finished`
          : `Description ${index}`,
      kind: null,
      notation,
      anchor: index === 0 ? { path: 'src/<unsafe>&"entry".ts', startLine: 1, endLine: 3 } : null,
    })),
    edges: notations.slice(1).map((_, index) => ({
      id: `edge-${index}`,
      from: "node-0",
      to: `node-${index + 1}`,
      label:
        index === 0
          ? `calls <unsafe> & ${"complete edge wording ".repeat(12)}finished`
          : `uses relation ${index}`,
      directed: index !== 1,
      anchors: index === 0 ? [{ path: 'src/<unsafe>&"entry".ts', startLine: 2, endLine: 2 }] : [],
    })),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function documentFor(structure = exportStructure()) {
  const model = buildFullStructureRenderModel({
    structure,
    positions: initialStructureLayout(structure),
    sourceChangeKinds: new Map([['src/<unsafe>&"entry".ts', "modified" as const]]),
  });
  return { model, document: serializeStructureSvg({ structure, model, palette }) };
}

describe("Structure SVG export", () => {
  it("exports authored thesis, canonical Regions, and exact explanation backbone without session state", () => {
    const structure = exportStructure();
    structure.edges.push({
      id: "edge-parallel",
      from: "node-0",
      to: "node-1",
      label: "parallel but not primary",
      directed: false,
      anchors: [],
    });
    structure.presentation = {
      thesis: 'Flow <starts> here & stays factual "throughout".',
      startNodeId: "node-0",
      primaryBackbone: { edgeIds: ["edge-0"] },
      regions: [
        {
          id: "a-input-validation",
          label: "Input & validation",
          summary: "Input decoding and validation responsibilities.",
          nodeIds: ["node-0", "node-2"],
        },
        {
          id: "b-execution-core",
          label: "Execution <core>",
          summary: "Core execution responsibilities.",
          nodeIds: ["node-1", "node-3"],
        },
      ],
    };
    const { model, document } = documentFor(structure);

    expect(document.source).toContain('data-layer="presentation-thesis"');
    expect(document.source).toContain(
      "Flow &lt;starts&gt; here &amp; stays factual &quot;throughout&quot;.",
    );
    expect(document.source).not.toContain("data-presentation-region-index");
    expect(document.source).toContain('data-presentation-region-id="a-input-validation"');
    expect(document.source).toContain('data-presentation-region-label="Input &amp; validation"');
    expect(document.source).toContain('data-layer="presentation-region-members"');
    expect(document.source.match(/data-presentation-region-member-node-id=/gu)).toHaveLength(4);
    expect(document.source).toContain('data-presentation-region-member-node-id="node-0"');
    expect(document.source).toContain("Region AIV: Input &amp; validation");
    expect(document.source).toContain("REGIONS · AIV Input &amp; validation (2 Nodes)");
    expect(document.source).toContain("Input decoding and validation responsibilities.");
    expect(document.source).toContain(
      "DIRECT REGION CONNECTIONS · AIV → BEC (2 Edges) · AIV — BEC (1 Edge)",
    );
    expect(document.source).toContain("START · Very long &lt;entry&gt; &amp; label");
    expect(document.source).toContain("BACKBONE · 1 exact relation highlighted");
    expect(document.source).not.toContain("CORE RELATIONS ·");
    expect(document.source).not.toContain('data-layer="presentation-regions"');
    expect(document.source).toContain('data-edge-id="edge-0" data-primary-backbone="true"');
    expect(document.source).toMatch(/data-edge-id="edge-parallel"(?![^>]*data-primary-backbone)/u);
    expect(document.source).toContain('data-node-id="node-0" data-node-notation="plain"');
    expect(document.source).toContain('data-node-primary-backbone-mark="true"');
    expect(document.source).toContain('data-presentation-start-node="true"');
    expect(document.source).toContain('data-node-presentation-start-mark="true"');
    expect(document.source).toContain('data-node-origin-mark="true"');
    expect(document.source).not.toContain("selected-edge");
    expect(document.source).not.toContain("focus-id");
    expect(document.source).toContain("Explanation backbone member");
    expect(document.source).toContain("Factual graph origin");
    expect(model.presentation?.regions).toHaveLength(2);

    const reordered = documentFor({
      ...structure,
      presentation: {
        ...structure.presentation,
        regions: [...structure.presentation.regions].reverse(),
      },
    });
    expect(reordered.document.source).toBe(document.source);
  });

  it("exports thesis and attention start without fabricated spine or region metadata", () => {
    const structure = exportStructure();
    structure.presentation = {
      thesis: "Begin at the shared boundary without inventing another spatial organizer.",
      startNodeId: "node-1",
      primaryBackbone: null,
      regions: [],
    };

    const { model, document } = documentFor(structure);

    expect(model.presentation).toMatchObject({
      thesis: structure.presentation.thesis,
      startNodeId: "node-1",
      regions: [],
    });
    expect(model.presentation?.primaryBackboneNodeIds.size).toBe(0);
    expect(model.presentation?.primaryBackboneEdgeIds.size).toBe(0);
    expect(document.source).toContain('data-layer="presentation-thesis"');
    expect(document.source).toContain("START · Node 1");
    expect(document.source).toContain('data-node-id="node-1"');
    expect(document.source).toContain('data-node-presentation-start-mark="true"');
    expect(document.source).not.toContain("BACKBONE ·");
    expect(document.source).not.toContain("REGIONS ·");
    expect(document.source).not.toContain("data-node-primary-backbone-mark");
    expect(document.source).not.toContain('data-layer="presentation-region-members"');
    expect(document.source).not.toContain("data-presentation-region-member-node-id");
  });

  it("serializes a standalone, complete, deterministic SVG", () => {
    const structure = exportStructure();
    const first = documentFor(structure);
    const second = serializeStructureSvg({ structure, model: first.model, palette });
    const source = first.document.source;

    expect(first.document.width).toBeGreaterThan(0);
    expect(first.document.height).toBeGreaterThan(0);
    expect(first.document.viewBox.width).toBe(first.document.width);
    expect(first.document.viewBox.height).toBe(first.document.height);
    expect(source.match(/data-node-id=/gu)).toHaveLength(structure.nodes.length);
    expect(source.match(/<path data-edge-id=/gu)).toHaveLength(structure.edges.length);
    expect(source.match(/data-edge-label-id=/gu)).toHaveLength(structure.edges.length);
    expect(source.match(/marker-end=/gu)).toHaveLength(
      structure.edges.filter((edge) => edge.directed).length,
    );
    expect(source.match(/data-edge-marker-kind=/gu)).toHaveLength(7);
    expect(source.match(new RegExp(`refX="${STRUCTURE_EDGE_ARROW_LENGTH}"`, "gu"))).toHaveLength(7);
    expect(
      source.match(new RegExp(`markerWidth="${STRUCTURE_EDGE_ARROW_LENGTH}"`, "gu")),
    ).toHaveLength(7);
    expect(
      source.match(new RegExp(`markerHeight="${STRUCTURE_EDGE_ARROW_WIDTH}"`, "gu")),
    ).toHaveLength(7);
    expect(source.match(/markerUnits="userSpaceOnUse"/gu)).toHaveLength(7);
    for (const [kind, color] of [
      ["default", palette.muted],
      ["added", palette.success],
      ["modified", palette.attention],
      ["deleted", palette.danger],
      ["renamed", palette.done],
      ["type-changed", palette.info],
      ["mixed", palette.attention],
    ]) {
      expect(source).toMatch(
        new RegExp(`<marker id="rvw-structure-arrow-${kind}"[^>]*><path[^>]*fill="${color}"`, "u"),
      );
    }
    expect(source).toMatch(/<path data-edge-id="edge-0"[^>]*stroke="#d29922"/u);
    expect(source).toMatch(
      /<path data-edge-arrow-id="edge-0"[^>]*stroke="#d29922"[^>]*stroke-width="0"[^>]*marker-end="url\(#rvw-structure-arrow-modified\)"/u,
    );
    expect(source).not.toMatch(/<path data-edge-id="edge-0"[^>]*marker-end=/u);
    expect(source).not.toContain("context-stroke");
    for (const notation of structure.nodes.map((node) => node.notation)) {
      expect(source).toContain(`data-node-notation="${notation}"`);
    }
    expect(source).toContain('data-origin-node="true"');
    expect(source).toContain('data-source-change-kind="modified"');
    expect(source).toContain("…");
    expect(source).toContain("calls &lt;unsafe&gt; &amp;");
    expect(source).not.toContain("\u0001");
    expect(source).not.toContain("<foreignObject");
    expect(source).not.toContain("<script");
    expect(source).not.toContain("<image");
    expect(source).not.toContain("var(");
    expect(source).toBe(second.source);
  });

  it("renders displaced-label leaders as neutral anchored callouts below every label", () => {
    const structure = exportStructure();
    structure.edges.push(
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `parallel-callout-${index}`,
        from: "node-0",
        to: "node-1",
        label: `parallel callout relation ${index}`,
        directed: true,
        anchors: [],
      })),
    );
    const { model, document } = documentFor(structure);
    const placement = model.labels.find(({ leaderPath }) => leaderPath !== null);

    expect(placement).toBeDefined();
    expect(placement!.leaderEdgeAnchor).not.toBeNull();
    expect(placement!.leaderLabelAnchor).not.toBeNull();
    const leaderGroup = document.source.match(
      new RegExp(`<g data-edge-label-leader-id="${placement!.edge.id}"[\\s\\S]*?<\\/g>`, "u"),
    )?.[0];
    expect(leaderGroup).toBeDefined();
    expect(leaderGroup).toContain('data-edge-label-leader-halo="true"');
    expect(leaderGroup).toContain(`stroke="${palette.panel}"`);
    expect(leaderGroup).toContain('stroke-width="4"');
    expect(leaderGroup).toContain('data-edge-label-leader-line="true"');
    expect(leaderGroup).toContain(`stroke="${palette.muted}"`);
    expect(leaderGroup).toContain('stroke-dasharray="1 4"');
    expect(leaderGroup).toContain('stroke-linecap="round"');
    expect(leaderGroup).toContain('data-edge-label-leader-anchor="true"');
    const anchor = leaderGroup!.match(
      /data-edge-label-leader-anchor="true" cx="([^"]+)" cy="([^"]+)"/u,
    );
    expect(anchor).not.toBeNull();
    expect(Number(anchor![1])).toBeCloseTo(placement!.leaderEdgeAnchor!.x, 3);
    expect(Number(anchor![2])).toBeCloseTo(placement!.leaderEdgeAnchor!.y, 3);

    const leaderLayer = document.source.indexOf('<g data-layer="edge-label-leaders">');
    const labelLayer = document.source.indexOf('<g data-layer="edge-labels">');
    expect(leaderLayer).toBeGreaterThan(document.source.indexOf('<g data-layer="edges">'));
    expect(labelLayer).toBeGreaterThan(leaderLayer);
    expect(document.source.indexOf(`data-edge-label-id="${placement!.edge.id}"`)).toBeGreaterThan(
      leaderLayer,
    );
  });

  it("keeps notation-aware origin marks clear of shaped Node borders", () => {
    for (const expected of [
      { nodeId: "node-4", insetX: 18, insetY: 10 },
      { nodeId: "node-5", insetX: 22, insetY: 16 },
      { nodeId: "node-6", insetX: 20, insetY: 24 },
    ]) {
      const structure = exportStructure();
      structure.originNodeId = expected.nodeId;
      const positions = initialStructureLayout(structure);
      const { document } = documentFor(structure);
      const groupStart = document.source.indexOf(`<g data-node-id="${expected.nodeId}"`);
      const markStart = document.source.indexOf('<line data-node-origin-mark="true"', groupStart);
      const contentStart = document.source.indexOf('<g data-node-content="true">', groupStart);
      expect(groupStart).toBeGreaterThanOrEqual(0);
      expect(markStart).toBeGreaterThan(groupStart);
      expect(markStart).toBeLessThan(contentStart);
      const mark = document.source.slice(markStart, document.source.indexOf("/>", markStart));
      const attribute = (name: string): number => {
        const match = mark.match(new RegExp(`${name}="([^"]+)"`, "u"));
        expect(match).not.toBeNull();
        return Number(match![1]);
      };
      const point = positions[expected.nodeId]!;
      expect(attribute("x1")).toBe(point.x + expected.insetX);
      expect(attribute("x2")).toBe(point.x + expected.insetX);
      expect(attribute("y1")).toBe(point.y + expected.insetY);
      expect(attribute("y2")).toBe(point.y + STRUCTURE_NODE_HEIGHT - expected.insetY);
    }
  });

  it("renders the complete Edge label visibly with geometry for every wrapped line", () => {
    const structure = exportStructure();
    const longLabel = structure.edges[0]!.label;
    const { model, document } = documentFor(structure);
    const escapedLabel = longLabel
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    expect(document.source).toContain(`<title>${escapedLabel}</title>`);
    const labelGroup = document.source.match(/<g data-edge-label-id="edge-0"[\s\S]*?<\/g>/u)?.[0];
    expect(labelGroup).toBeDefined();
    const placement = model.labels.find(({ edge }) => edge.id === "edge-0")!;
    expect(placement.displayLines.length).toBeGreaterThan(2);
    expect(placement.displayLines.join(" ").replaceAll(/\s+/gu, " ").trim()).toBe(
      longLabel.replaceAll(/\s+/gu, " ").trim(),
    );
    expect(placement.height).toBe(placement.displayLines.length * EDGE_LABEL_LINE_HEIGHT + 10);
    expect(labelGroup).not.toContain("…");
    for (const line of placement.displayLines) {
      const escapedLine = line
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      expect(labelGroup).toContain(`>${escapedLine}</tspan>`);
    }
  });

  it("fails rather than exporting an incomplete layout", () => {
    const structure = exportStructure();
    const positions = initialStructureLayout(structure);
    delete positions["node-6"];
    const model = buildFullStructureRenderModel({
      structure,
      positions,
      sourceChangeKinds: new Map(),
    });
    expect(() => assertCompleteStructureExport(model, structure)).toThrowError(
      expect.objectContaining({ code: "INCOMPLETE_LAYOUT" }),
    );
  });

  it("wraps at semantic separators and prioritizes ellipsized Node text", () => {
    expect(
      wrapStructureText({ text: "alpha/beta::gamma-delta", maxUnits: 5, ellipsize: false }),
    ).toEqual(["alpha/", "beta::", "gamma-", "delta"]);
    const namespaceBoundary = wrapStructureText({
      text: "a::",
      maxUnits: 1.2,
      ellipsize: false,
    });
    expect(namespaceBoundary).toEqual(["a", "::"]);
    expect(namespaceBoundary.every((line) => structureTextUnits(line) <= 1.2)).toBe(true);
    const limited = wrapStructureText({
      text: "one two three four five",
      maxUnits: 4,
      maxLines: 2,
      ellipsize: true,
    });
    expect(limited).toHaveLength(2);
    expect(limited[1]).toMatch(/…$/u);
  });

  it("sanitizes portable filenames", () => {
    expect(
      structureExportFilename(
        { title: '  日本語 / <bad>: "name"?*  ', sourceOid: "abcdef123456" },
        "svg",
      ),
    ).toBe("rvw-structure-日本語-bad-name-abcdef12.svg");
    expect(structureExportFilename({ title: "<>:*?", sourceOid: "1234567890" }, "png")).toBe(
      "rvw-structure-structure-12345678.png",
    );
  });
});

describe("Structure PNG raster planning", () => {
  it("uses 2× output inside the safety budget", () => {
    expect(planStructurePngRaster(1_000, 600)).toEqual({
      scale: 2,
      pixelWidth: 2_000,
      pixelHeight: 1_200,
      downscaled: false,
    });
  });

  it("downscales large output within both dimension and pixel budgets", () => {
    const plan = planStructurePngRaster(8_000, 4_000);
    expect(plan.downscaled).toBe(true);
    expect(plan.pixelWidth).toBeLessThanOrEqual(16_384);
    expect(plan.pixelHeight).toBeLessThanOrEqual(16_384);
    expect(plan.pixelWidth * plan.pixelHeight).toBeLessThanOrEqual(32_000_000);
  });

  it("rejects invalid and unreasonably sparse output", () => {
    expect(() => planStructurePngRaster(0, 20)).toThrow(StructureExportError);
    expect(() => planStructurePngRaster(100_000, 100_000)).toThrowError(
      expect.objectContaining({ code: "PNG_TOO_LARGE" }),
    );
  });
});
