import type { ChangeKind, Structure } from "../domain/models.js";
import {
  EDGE_LABEL_LINE_HEIGHT,
  wrapStructureText,
  type EdgeSourceChangeKind,
  type StructureRenderModel,
  type StructureRenderNode,
} from "./structure-render-model.js";
import { STRUCTURE_NODE_HEIGHT, STRUCTURE_NODE_WIDTH } from "./structure-graph.js";

export type StructureExportFormat = "svg" | "png";

export interface StructureExportPalette {
  background: string;
  panel: string;
  text: string;
  muted: string;
  line: string;
  lineStrong: string;
  accent: string;
  success: string;
  attention: string;
  danger: string;
  done: string;
  info: string;
}

export interface StructureSvgDocument {
  source: string;
  width: number;
  height: number;
  viewBox: { x: number; y: number; width: number; height: number };
}

export interface StructurePngRasterPlan {
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
  downscaled: boolean;
}

export type StructureExportErrorCode =
  | "INCOMPLETE_LAYOUT"
  | "INVALID_BOUNDS"
  | "PNG_TOO_LARGE"
  | "PNG_DECODE_FAILED"
  | "PNG_ENCODE_FAILED";

export class StructureExportError extends Error {
  constructor(readonly code: StructureExportErrorCode) {
    super(code);
    this.name = "StructureExportError";
  }
}

const EXPORT_PADDING = 48;
const PNG_PREFERRED_SCALE = 2;
const PNG_MAX_DIMENSION = 16_384;
const PNG_MAX_PIXELS = 32_000_000;
const PNG_MIN_ACCEPTABLE_SCALE = 0.5;
const MONO_FONT = "ui-monospace, SFMono-Regular, Consolas, Liberation Mono, monospace";
const SANS_FONT = "Arial, Helvetica Neue, sans-serif";
const EDGE_MARKER_KINDS = [
  "default",
  "added",
  "modified",
  "deleted",
  "renamed",
  "type-changed",
  "mixed",
] as const;

type StructureEdgeMarkerKind = (typeof EDGE_MARKER_KINDS)[number];

const paletteProperties: Record<keyof StructureExportPalette, string> = {
  background: "--bg",
  panel: "--panel",
  text: "--text",
  muted: "--muted",
  line: "--line",
  lineStrong: "--line-strong",
  accent: "--accent",
  success: "--success",
  attention: "--attention",
  danger: "--danger",
  done: "--done",
  info: "--info",
};

export function readStructureExportPalette(root: HTMLElement): StructureExportPalette {
  const style = getComputedStyle(root);
  return Object.fromEntries(
    Object.entries(paletteProperties).map(([name, property]) => {
      const value = style.getPropertyValue(property).trim();
      if (!value) throw new StructureExportError("INVALID_BOUNDS");
      return [name, value];
    }),
  ) as unknown as StructureExportPalette;
}

export function sanitizeXmlText(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      result += character;
    }
  }
  return result;
}

function escapeXml(value: string): string {
  return sanitizeXmlText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function finiteNumber(value: number): string {
  if (!Number.isFinite(value)) throw new StructureExportError("INVALID_BOUNDS");
  return Number(value.toFixed(3)).toString();
}

function colorForChangeKind(
  changeKind: ChangeKind | EdgeSourceChangeKind | null,
  palette: StructureExportPalette,
  fallback: string,
): string {
  switch (changeKind) {
    case "added":
      return palette.success;
    case "modified":
    case "mixed":
      return palette.attention;
    case "deleted":
      return palette.danger;
    case "renamed":
      return palette.done;
    case "type-changed":
      return palette.info;
    default:
      return fallback;
  }
}

function svgTextLines(input: {
  lines: readonly string[];
  x: number;
  firstY: number;
  lineHeight: number;
  fontSize: number;
  fontFamily: string;
  fill: string;
  fontWeight?: number;
  anchor?: "start" | "middle";
}): string {
  const anchor = input.anchor ?? "start";
  return `<text x="${finiteNumber(input.x)}" y="${finiteNumber(input.firstY)}" fill="${escapeXml(input.fill)}" font-family="${escapeXml(input.fontFamily)}" font-size="${finiteNumber(input.fontSize)}"${input.fontWeight ? ` font-weight="${input.fontWeight}"` : ""} text-anchor="${anchor}">${input.lines
    .map(
      (line, index) =>
        `<tspan x="${finiteNumber(input.x)}" dy="${index === 0 ? "0" : finiteNumber(input.lineHeight)}">${escapeXml(line)}</tspan>`,
    )
    .join("")}</text>`;
}

interface NodeContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function nodeContentBox(renderNode: StructureRenderNode): NodeContentBox {
  const { node, point } = renderNode;
  switch (node.notation) {
    case "database":
      return { x: point.x + 10, y: point.y + 21, width: STRUCTURE_NODE_WIDTH - 20, height: 84 };
    case "component":
      return { x: point.x + 22, y: point.y + 6, width: STRUCTURE_NODE_WIDTH - 30, height: 100 };
    case "external":
      return { x: point.x + 18, y: point.y + 6, width: STRUCTURE_NODE_WIDTH - 36, height: 100 };
    case "concept":
      return { x: point.x + 24, y: point.y + 12, width: STRUCTURE_NODE_WIDTH - 48, height: 94 };
    default:
      return { x: point.x + 8, y: point.y + 6, width: STRUCTURE_NODE_WIDTH - 16, height: 100 };
  }
}

function serializeNodeShape(
  renderNode: StructureRenderNode,
  outline: string,
  palette: StructureExportPalette,
): string {
  const { node, point } = renderNode;
  const x = point.x;
  const y = point.y;
  const common = `fill="${escapeXml(palette.panel)}" stroke="${escapeXml(outline)}" stroke-width="1.4"`;
  switch (node.notation) {
    case "class":
    case "interface":
      return `<rect x="${finiteNumber(x)}" y="${finiteNumber(y)}" width="${STRUCTURE_NODE_WIDTH}" height="${STRUCTURE_NODE_HEIGHT}" rx="2" ${common}${node.notation === "interface" ? ' stroke-dasharray="5 3"' : ""}/>`;
    case "database": {
      const left = x;
      const right = x + STRUCTURE_NODE_WIDTH;
      const top = y + 10;
      const bottom = y + STRUCTURE_NODE_HEIGHT - 10;
      return `<path d="M ${finiteNumber(left)} ${finiteNumber(top)} C ${finiteNumber(left)} ${finiteNumber(y - 3)}, ${finiteNumber(right)} ${finiteNumber(y - 3)}, ${finiteNumber(right)} ${finiteNumber(top)} L ${finiteNumber(right)} ${finiteNumber(bottom)} C ${finiteNumber(right)} ${finiteNumber(y + STRUCTURE_NODE_HEIGHT + 3)}, ${finiteNumber(left)} ${finiteNumber(y + STRUCTURE_NODE_HEIGHT + 3)}, ${finiteNumber(left)} ${finiteNumber(bottom)} Z" ${common}/><path d="M ${finiteNumber(left)} ${finiteNumber(top)} C ${finiteNumber(left)} ${finiteNumber(y + 23)}, ${finiteNumber(right)} ${finiteNumber(y + 23)}, ${finiteNumber(right)} ${finiteNumber(top)}" fill="none" stroke="${escapeXml(outline)}" stroke-width="1.2"/>`;
    }
    case "component":
      return `<rect x="${finiteNumber(x)}" y="${finiteNumber(y)}" width="${STRUCTURE_NODE_WIDTH}" height="${STRUCTURE_NODE_HEIGHT}" rx="3" ${common}/><rect x="${finiteNumber(x + 2)}" y="${finiteNumber(y + 36)}" width="13" height="8" ${common}/><rect x="${finiteNumber(x + 2)}" y="${finiteNumber(y + 52)}" width="13" height="8" ${common}/>`;
    case "external":
      return `<polygon points="${finiteNumber(x + 20)},${finiteNumber(y)} ${finiteNumber(x + STRUCTURE_NODE_WIDTH - 20)},${finiteNumber(y)} ${finiteNumber(x + STRUCTURE_NODE_WIDTH)},${finiteNumber(y + STRUCTURE_NODE_HEIGHT / 2)} ${finiteNumber(x + STRUCTURE_NODE_WIDTH - 20)},${finiteNumber(y + STRUCTURE_NODE_HEIGHT)} ${finiteNumber(x + 20)},${finiteNumber(y + STRUCTURE_NODE_HEIGHT)} ${finiteNumber(x)},${finiteNumber(y + STRUCTURE_NODE_HEIGHT / 2)}" ${common}/>`;
    case "concept":
      return `<rect x="${finiteNumber(x)}" y="${finiteNumber(y)}" width="${STRUCTURE_NODE_WIDTH}" height="${STRUCTURE_NODE_HEIGHT}" rx="56" ${common}/>`;
    default:
      return `<rect x="${finiteNumber(x)}" y="${finiteNumber(y)}" width="${STRUCTURE_NODE_WIDTH}" height="${STRUCTURE_NODE_HEIGHT}" rx="8" ${common}/>`;
  }
}

function serializeNode(
  renderNode: StructureRenderNode,
  structure: Structure,
  palette: StructureExportPalette,
): string {
  const { node, point } = renderNode;
  const outline = colorForChangeKind(renderNode.changeKind, palette, palette.lineStrong);
  const content = nodeContentBox(renderNode);
  const sourceLines = renderNode.sourceLabel
    ? wrapStructureText({
        text: renderNode.sourceLabel,
        maxUnits: content.width / 10,
        maxLines: 1,
        ellipsize: true,
      })
    : [];
  const sourceHeight = sourceLines.length > 0 ? 17 : 0;
  const titleMaxLines = sourceLines.length > 0 ? 3 : 4;
  const titleLines = wrapStructureText({
    text: node.label,
    maxUnits: content.width / 11,
    maxLines: titleMaxLines,
    ellipsize: true,
  });
  const titleLineHeight = 14.5;
  const titleHeight = Math.max(1, titleLines.length) * titleLineHeight;
  const descriptionTop = content.y + sourceHeight + titleHeight + 3;
  const descriptionLineHeight = 12.6;
  const descriptionMaxLines = Math.max(
    0,
    Math.floor((content.y + content.height - descriptionTop) / descriptionLineHeight),
  );
  const descriptionLines =
    descriptionMaxLines > 0
      ? wrapStructureText({
          text: node.description ?? "Producerによる説明なし",
          maxUnits: content.width / 9,
          maxLines: descriptionMaxLines,
          ellipsize: true,
        })
      : [];
  const divider =
    node.notation === "class" || node.notation === "interface"
      ? `<line x1="${finiteNumber(content.x)}" y1="${finiteNumber(descriptionTop - 2)}" x2="${finiteNumber(content.x + content.width)}" y2="${finiteNumber(descriptionTop - 2)}" stroke="${escapeXml(outline)}" stroke-width="1"/>`
      : "";
  const originMark = (() => {
    switch (node.notation) {
      case "external":
        return {
          x: point.x + 22,
          top: point.y + 16,
          bottom: point.y + STRUCTURE_NODE_HEIGHT - 16,
        };
      case "concept":
        return {
          x: point.x + 20,
          top: point.y + 24,
          bottom: point.y + STRUCTURE_NODE_HEIGHT - 24,
        };
      case "database":
        return {
          x: point.x + 5,
          top: point.y + 18,
          bottom: point.y + STRUCTURE_NODE_HEIGHT - 18,
        };
      case "component":
        return {
          x: point.x + 18,
          top: point.y + 10,
          bottom: point.y + STRUCTURE_NODE_HEIGHT - 10,
        };
      default:
        return {
          x: point.x + 4,
          top: point.y + 10,
          bottom: point.y + STRUCTURE_NODE_HEIGHT - 10,
        };
    }
  })();
  const origin =
    node.id === structure.originNodeId
      ? `<line data-node-origin-mark="true" x1="${finiteNumber(originMark.x)}" y1="${finiteNumber(originMark.top)}" x2="${finiteNumber(originMark.x)}" y2="${finiteNumber(originMark.bottom)}" stroke="${escapeXml(palette.accent)}" stroke-width="4" stroke-linecap="round"/>`
      : "";
  const source =
    sourceLines.length > 0
      ? svgTextLines({
          lines: sourceLines,
          x: content.x,
          firstY: content.y + 10,
          lineHeight: 12,
          fontSize: 10,
          fontFamily: MONO_FONT,
          fill: palette.muted,
          fontWeight: 600,
        })
      : "";
  const titleY = content.y + sourceHeight + 10;
  const title = svgTextLines({
    lines: titleLines,
    x: content.x,
    firstY: titleY,
    lineHeight: titleLineHeight,
    fontSize: 11,
    fontFamily: MONO_FONT,
    fill: palette.text,
    fontWeight: 700,
  });
  const description =
    descriptionLines.length > 0
      ? svgTextLines({
          lines: descriptionLines,
          x: content.x,
          firstY: descriptionTop + 9,
          lineHeight: descriptionLineHeight,
          fontSize: 9,
          fontFamily: SANS_FONT,
          fill: palette.muted,
        })
      : "";
  return `<g data-node-id="${escapeXml(node.id)}" data-node-notation="${escapeXml(node.notation)}"${node.id === structure.originNodeId ? ' data-origin-node="true"' : ""}${renderNode.changeKind ? ` data-source-change-kind="${escapeXml(renderNode.changeKind)}"` : ""}>${serializeNodeShape(renderNode, outline, palette)}${origin}<g data-node-content="true">${source}${title}${divider}${description}</g><title>${escapeXml(node.label)}</title><desc>${escapeXml(node.description ?? "")}</desc></g>`;
}

export function assertCompleteStructureExport(
  model: StructureRenderModel,
  structure: Structure,
): void {
  const complete =
    model.nodes.length === structure.nodes.length &&
    model.edges.length === structure.edges.length &&
    model.labels.length === structure.edges.length &&
    model.bounds !== null;
  const finite = model.bounds
    ? [model.bounds.left, model.bounds.top, model.bounds.right, model.bounds.bottom].every(
        Number.isFinite,
      )
    : false;
  if (!complete || !finite) throw new StructureExportError("INCOMPLETE_LAYOUT");
}

function serializeEdgeLabel(
  placement: StructureRenderModel["labels"][number],
  palette: StructureExportPalette,
): string {
  const outline = colorForChangeKind(placement.source.changeKind, palette, palette.accent);
  const lines = placement.displayLines;
  const firstY = -((lines.length - 1) * EDGE_LABEL_LINE_HEIGHT) / 2 + 3.5;
  return `<g data-edge-label-id="${escapeXml(placement.edge.id)}" transform="translate(${finiteNumber(placement.x)} ${finiteNumber(placement.y)})"${placement.crowded ? ' data-crowded="true"' : ""}><rect x="${finiteNumber(-placement.selectWidth / 2)}" y="${finiteNumber(-placement.height / 2)}" width="${finiteNumber(placement.selectWidth)}" height="${finiteNumber(placement.height)}" rx="${finiteNumber(placement.height / 2)}" fill="${escapeXml(palette.panel)}" stroke="${escapeXml(outline)}" stroke-width="1"${placement.crowded ? ' stroke-dasharray="4 3"' : ""}/>${svgTextLines({ lines, x: 0, firstY, lineHeight: EDGE_LABEL_LINE_HEIGHT, fontSize: 10, fontFamily: SANS_FONT, fill: outline, anchor: "middle" })}<title>${escapeXml(placement.edge.label)}</title></g>`;
}

function edgeMarkerKind(changeKind: EdgeSourceChangeKind | null): StructureEdgeMarkerKind {
  return changeKind ?? "default";
}

function edgeMarkerId(kind: StructureEdgeMarkerKind): string {
  return `rvw-structure-arrow-${kind}`;
}

function edgeMarkerColor(kind: StructureEdgeMarkerKind, palette: StructureExportPalette): string {
  return colorForChangeKind(kind === "default" ? null : kind, palette, palette.muted);
}

function serializeEdgeMarkerDefs(palette: StructureExportPalette): string {
  return EDGE_MARKER_KINDS.map((kind) => {
    const color = edgeMarkerColor(kind, palette);
    return `<marker id="${edgeMarkerId(kind)}" data-edge-marker-kind="${kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeXml(color)}"/></marker>`;
  }).join("");
}

export function serializeStructureSvg(input: {
  structure: Structure;
  model: StructureRenderModel;
  palette: StructureExportPalette;
}): StructureSvgDocument {
  const { structure, model, palette } = input;
  assertCompleteStructureExport(model, structure);
  const bounds = model.bounds!;
  const x = Math.floor(bounds.left - EXPORT_PADDING);
  const y = Math.floor(bounds.top - EXPORT_PADDING);
  const right = Math.ceil(bounds.right + EXPORT_PADDING);
  const bottom = Math.ceil(bounds.bottom + EXPORT_PADDING);
  const width = right - x;
  const height = bottom - y;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new StructureExportError("INVALID_BOUNDS");
  }
  const edges = model.edges
    .map(({ edge, geometry, source }) => {
      const markerKind = edgeMarkerKind(source.changeKind);
      const stroke = edgeMarkerColor(markerKind, palette);
      return `<path data-edge-id="${escapeXml(edge.id)}" d="${escapeXml(geometry.path)}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="1.4" opacity="${source.changeKind ? "0.76" : "0.58"}"${edge.directed ? ` marker-end="url(#${edgeMarkerId(markerKind)})"` : ""}/>`;
    })
    .join("");
  const labels = model.labels.map((placement) => serializeEdgeLabel(placement, palette)).join("");
  const nodes = model.nodes
    .map((renderNode) => serializeNode(renderNode, structure, palette))
    .join("");
  const source = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}" role="img" aria-labelledby="rvw-structure-title rvw-structure-description" data-rvw-structure-id="${escapeXml(structure.id)}" data-rvw-source-oid="${escapeXml(structure.sourceOid)}"><title id="rvw-structure-title">${escapeXml(structure.title)}</title><desc id="rvw-structure-description">${escapeXml(structure.scope)}</desc><defs>${serializeEdgeMarkerDefs(palette)}</defs><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escapeXml(palette.background)}"/><g data-layer="edges">${edges}</g><g data-layer="edge-labels">${labels}</g><g data-layer="nodes">${nodes}</g></svg>`;
  return { source, width, height, viewBox: { x, y, width, height } };
}

export function planStructurePngRaster(width: number, height: number): StructurePngRasterPlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new StructureExportError("INVALID_BOUNDS");
  }
  const scale = Math.min(
    PNG_PREFERRED_SCALE,
    PNG_MAX_DIMENSION / width,
    PNG_MAX_DIMENSION / height,
    Math.sqrt(PNG_MAX_PIXELS / (width * height)),
  );
  if (!Number.isFinite(scale) || scale < PNG_MIN_ACCEPTABLE_SCALE) {
    throw new StructureExportError("PNG_TOO_LARGE");
  }
  return {
    scale,
    pixelWidth: Math.max(1, Math.floor(width * scale)),
    pixelHeight: Math.max(1, Math.floor(height * scale)),
    downscaled: scale < PNG_PREFERRED_SCALE,
  };
}

function svgAtRasterSize(document: StructureSvgDocument, plan: StructurePngRasterPlan): string {
  return document.source
    .replace(/(<svg\b[^>]*\bwidth=")[^"]*(")/u, `$1${plan.pixelWidth}$2`)
    .replace(/(<svg\b[^>]*\bheight=")[^"]*(")/u, `$1${plan.pixelHeight}$2`);
}

export async function rasterizeStructureSvg(
  document: StructureSvgDocument,
  plan: StructurePngRasterPlan,
): Promise<Blob> {
  const svgBlob = new Blob([svgAtRasterSize(document, plan)], {
    type: "image/svg+xml;charset=utf-8",
  });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new StructureExportError("PNG_DECODE_FAILED"));
      image.src = url;
    });
    const canvas = window.document.createElement("canvas");
    canvas.width = plan.pixelWidth;
    canvas.height = plan.pixelHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new StructureExportError("PNG_ENCODE_FAILED");
    context.drawImage(image, 0, 0, plan.pixelWidth, plan.pixelHeight);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new StructureExportError("PNG_ENCODE_FAILED"))),
        "image/png",
      );
    });
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function structureExportFilename(
  structure: Pick<Structure, "title" | "sourceOid">,
  format: StructureExportFormat,
): string {
  const safeTitle = [
    ...sanitizeXmlText(structure.title)
      .replace(/[<>:"\\|?*]+|\//gu, "-")
      .replace(/\s+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^[.\s-]+|[.\s-]+$/gu, ""),
  ]
    .slice(0, 80)
    .join("");
  return `rvw-structure-${safeTitle || "structure"}-${structure.sourceOid.slice(0, 8)}.${format}`;
}

export function downloadStructureBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  window.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function structureExportErrorMessage(error: unknown): string {
  if (error instanceof StructureExportError) {
    switch (error.code) {
      case "INCOMPLETE_LAYOUT":
        return "Structure全体の配置を構築できませんでした。レイアウトを戻して再実行してください。";
      case "PNG_TOO_LARGE":
        return "図がPNGの安全なサイズを超えています。SVGを使用するか、Node配置を近づけてから再実行してください。";
      case "PNG_DECODE_FAILED":
        return "Structure SVGをPNGへ変換できませんでした。SVG形式で再実行してください。";
      case "PNG_ENCODE_FAILED":
        return "PNGファイルを生成できませんでした。SVG形式で再実行してください。";
      case "INVALID_BOUNDS":
        return "Structureの出力範囲を計算できませんでした。";
    }
  }
  return error instanceof Error ? error.message : "Structureをエクスポートできませんでした。";
}
