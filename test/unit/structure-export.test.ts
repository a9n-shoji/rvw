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
    expect(source).toMatch(
      /<path data-edge-id="edge-0"[^>]*stroke="#d29922"[^>]*marker-end="url\(#rvw-structure-arrow-modified\)"/u,
    );
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

  it("clamps rendered Edge label text while keeping the complete text in the title", () => {
    const structure = exportStructure();
    const longLabel = structure.edges[0]!.label;
    const { document } = documentFor(structure);
    const escapedLabel = longLabel
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    expect(document.source).toContain(`<title>${escapedLabel}</title>`);
    const labelGroup = document.source.match(/<g data-edge-label-id="edge-0"[\s\S]*?<\/g>/u)?.[0];
    expect(labelGroup).toBeDefined();
    expect(labelGroup).toContain("…");
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
