import type { ChangeKind, Structure, StructureEdge, StructureNode } from "../domain/models.js";
import {
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
  structureEdgeRouteOffsets,
  type StructurePoint,
} from "./structure-graph.js";

export interface StructureBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface StructureEdgeGeometry {
  path: string;
  startX: number;
  startY: number;
  control1X: number;
  control1Y: number;
  control2X: number;
  control2Y: number;
  endX: number;
  endY: number;
  bounds: StructureBox;
}

export type EdgeSourceChangeKind = ChangeKind | "mixed";

export interface EdgeSourcePresentation {
  anchorCount: number;
  changeKind: EdgeSourceChangeKind | null;
}

export interface StructureEdgeLabelPlacement {
  edge: StructureEdge;
  displayLines: readonly string[];
  source: EdgeSourcePresentation;
  x: number;
  y: number;
  selectWidth: number;
  boxWidth: number;
  height: number;
  crowded: boolean;
}

export interface StructureRenderSelection {
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
  labelEdgeIds: ReadonlySet<string>;
}

export interface StructureRenderEdge {
  edge: StructureEdge;
  geometry: StructureEdgeGeometry;
  source: EdgeSourcePresentation;
}

export interface StructureRenderNode {
  node: StructureNode;
  point: StructurePoint;
  sourceLabel: string | null;
  changeKind: ChangeKind | null;
}

export interface StructureRenderModel {
  nodes: readonly StructureRenderNode[];
  edges: readonly StructureRenderEdge[];
  labels: readonly StructureEdgeLabelPlacement[];
  bounds: StructureBox | null;
}

export type StructureLabelAccessory = "source-actions" | "none";
export type StructureEdgeLabelMode = "viewer-clamped" | "export-complete";

const EDGE_LABEL_MAX_TEXT_WIDTH = 210;
const EDGE_LABEL_COMPACT_MAX_TEXT_WIDTH = 136;
const EDGE_LABEL_MIN_TEXT_WIDTH = 64;
const EDGE_LABEL_HORIZONTAL_PADDING = 11;
const EDGE_LABEL_WIDTH_SAFETY = 2;
export const EDGE_LABEL_LINE_HEIGHT = 14;

function stableCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function shortestUniqueSourceLabels(paths: readonly string[]): Map<string, string> {
  const distinctPaths = [...new Set(paths)];
  const segments = new Map(distinctPaths.map((path) => [path, path.split("/")]));
  return new Map(
    distinctPaths.map((path) => {
      const parts = segments.get(path)!;
      for (let length = 1; length <= parts.length; length += 1) {
        const suffix = parts.slice(-length).join("/");
        const unique = distinctPaths.every(
          (candidate) =>
            candidate === path || segments.get(candidate)!.slice(-length).join("/") !== suffix,
        );
        if (unique) return [path, suffix];
      }
      return [path, path];
    }),
  );
}

export function edgeSourcePresentation(
  edge: StructureEdge,
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>,
): EdgeSourcePresentation {
  const changedKinds = edge.anchors.flatMap((anchor) => {
    const kind = sourceChangeKinds.get(anchor.path);
    return kind ? [kind] : [];
  });
  const distinctKinds = [...new Set(changedKinds)].sort(stableCompare);
  return {
    anchorCount: edge.anchors.length,
    changeKind:
      distinctKinds.length > 1 ? "mixed" : distinctKinds.length === 1 ? distinctKinds[0]! : null,
  };
}

export function edgePath(
  edge: StructureEdge,
  positions: Readonly<Record<string, StructurePoint>>,
  laneOffset = 0,
  reciprocal = false,
): StructureEdgeGeometry | null {
  const from = positions[edge.from];
  const to = positions[edge.to];
  if (!from || !to) return null;
  const fromX = from.x + STRUCTURE_NODE_WIDTH / 2;
  const fromY = from.y + STRUCTURE_NODE_HEIGHT / 2;
  const toX = to.x + STRUCTURE_NODE_WIDTH / 2;
  const toY = to.y + STRUCTURE_NODE_HEIGHT / 2;
  if (edge.from === edge.to) {
    const right = from.x + STRUCTURE_NODE_WIDTH;
    const top = from.y;
    const gap = 8;
    const loopShift = laneOffset * 0.3;
    const loopReach = 88 + Math.abs(laneOffset) * 0.35;
    return {
      path: `M ${right + gap} ${top + 34 + loopShift} C ${right + loopReach} ${top - 84 + loopShift}, ${right + loopReach} ${top + STRUCTURE_NODE_HEIGHT + 84 + loopShift}, ${right + gap} ${top + STRUCTURE_NODE_HEIGHT - 34 + loopShift}`,
      startX: right + gap,
      startY: top + 34 + loopShift,
      control1X: right + loopReach,
      control1Y: top - 84 + loopShift,
      control2X: right + loopReach,
      control2Y: top + STRUCTURE_NODE_HEIGHT + 84 + loopShift,
      endX: right + gap,
      endY: top + STRUCTURE_NODE_HEIGHT - 34 + loopShift,
      bounds: {
        left: right + gap,
        top: top - 84 + loopShift,
        right: right + loopReach,
        bottom: top + STRUCTURE_NODE_HEIGHT + 84 + loopShift,
      },
    };
  }
  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const unitX = dx / length;
  const unitY = dy / length;
  const perpendicularX = -unitY;
  const perpendicularY = unitX;
  const boundaryDistance = Math.min(
    STRUCTURE_NODE_WIDTH / 2 / Math.max(0.0001, Math.abs(unitX)),
    STRUCTURE_NODE_HEIGHT / 2 / Math.max(0.0001, Math.abs(unitY)),
  );
  const endpointDistance = boundaryDistance + 8;
  const startX = fromX + unitX * endpointDistance + perpendicularX * laneOffset;
  const startY = fromY + unitY * endpointDistance + perpendicularY * laneOffset;
  const endX = toX - unitX * endpointDistance + perpendicularX * laneOffset;
  const endY = toY - unitY * endpointDistance + perpendicularY * laneOffset;
  const minimumCurve = reciprocal ? 132 : laneOffset === 0 ? 28 : 52;
  const maximumCurve = reciprocal ? 168 : 96;
  const curve =
    Math.min(maximumCurve, Math.max(minimumCurve, length * (reciprocal ? 0.18 : 0.1))) +
    laneOffset * 0.35;
  const control1X = startX + (endX - startX) * 0.36 + perpendicularX * curve;
  const control1Y = startY + (endY - startY) * 0.36 + perpendicularY * curve;
  const control2X = startX + (endX - startX) * 0.64 + perpendicularX * curve;
  const control2Y = startY + (endY - startY) * 0.64 + perpendicularY * curve;
  return {
    path: `M ${startX} ${startY} C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${endX} ${endY}`,
    startX,
    startY,
    control1X,
    control1Y,
    control2X,
    control2Y,
    endX,
    endY,
    bounds: {
      left: Math.min(startX, control1X, control2X, endX),
      top: Math.min(startY, control1Y, control2Y, endY),
      right: Math.max(startX, control1X, control2X, endX),
      bottom: Math.max(startY, control1Y, control2Y, endY),
    },
  };
}

export function reciprocalStructureEdgeIds(edges: readonly StructureEdge[]): Set<string> {
  const directions = new Set(
    edges
      .filter((edge) => edge.directed && edge.from !== edge.to)
      .map((edge) => JSON.stringify([edge.from, edge.to])),
  );
  return new Set(
    edges
      .filter(
        (edge) =>
          edge.directed &&
          edge.from !== edge.to &&
          directions.has(JSON.stringify([edge.to, edge.from])),
      )
      .map((edge) => edge.id),
  );
}

function curveLabelCandidate(
  geometry: StructureEdgeGeometry,
  fraction: number,
  offset: number,
): { x: number; y: number } {
  const inverse = 1 - fraction;
  const x =
    inverse ** 3 * geometry.startX +
    3 * inverse ** 2 * fraction * geometry.control1X +
    3 * inverse * fraction ** 2 * geometry.control2X +
    fraction ** 3 * geometry.endX;
  const y =
    inverse ** 3 * geometry.startY +
    3 * inverse ** 2 * fraction * geometry.control1Y +
    3 * inverse * fraction ** 2 * geometry.control2Y +
    fraction ** 3 * geometry.endY;
  const tangentX =
    3 * inverse ** 2 * (geometry.control1X - geometry.startX) +
    6 * inverse * fraction * (geometry.control2X - geometry.control1X) +
    3 * fraction ** 2 * (geometry.endX - geometry.control2X);
  const tangentY =
    3 * inverse ** 2 * (geometry.control1Y - geometry.startY) +
    6 * inverse * fraction * (geometry.control2Y - geometry.control1Y) +
    3 * fraction ** 2 * (geometry.endY - geometry.control2Y);
  const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
  return {
    x: x + (-tangentY / tangentLength) * offset,
    y: y + (tangentX / tangentLength) * offset,
  };
}

export function boxesOverlap(left: StructureBox, right: StructureBox): boolean {
  return !(
    left.right < right.left ||
    left.left > right.right ||
    left.bottom < right.top ||
    left.top > right.bottom
  );
}

export function labelBox(
  x: number,
  y: number,
  width: number,
  height: number,
  padding = 0,
): StructureBox {
  return {
    left: x - width / 2 - padding,
    top: y - height / 2 - padding,
    right: x + width / 2 + padding,
    bottom: y + height / 2 + padding,
  };
}

export function mergedBounds(boxes: readonly StructureBox[]): StructureBox | null {
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

export function structureTextUnits(text: string): number {
  return [...text].reduce(
    (total, character) =>
      total +
      (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character) ? 1 : 0.56),
    0,
  );
}

function isWrapOpportunity(character: string, next: string | undefined): boolean {
  return /\s/u.test(character) || /[./_-]/u.test(character) || (character === ":" && next === ":");
}

function fitEllipsis(text: string, maxUnits: number): string {
  const ellipsis = "…";
  const characters = [...text.trimEnd()];
  while (characters.length > 0 && structureTextUnits(characters.join("") + ellipsis) > maxUnits) {
    characters.pop();
  }
  return `${characters.join("").trimEnd()}${ellipsis}`;
}

function wrapSingleLine(text: string, maxUnits: number): string[] {
  let remaining = text.trim();
  if (!remaining) return [""];
  const lines: string[] = [];
  while (structureTextUnits(remaining) > maxUnits) {
    const characters = [...remaining];
    let units = 0;
    let hardEnd = 0;
    let preferredEnd = 0;
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index]!;
      const nextUnits = units + structureTextUnits(character);
      if (nextUnits > maxUnits && hardEnd > 0) break;
      units = nextUnits;
      hardEnd = index + 1;
      if (isWrapOpportunity(character, characters[index + 1])) {
        if (character === ":" && characters[index + 1] === ":") {
          const tokenUnits = nextUnits + structureTextUnits(characters[index + 1]!);
          if (tokenUnits <= maxUnits) preferredEnd = index + 2;
          else if (index > 0) {
            preferredEnd = index;
            break;
          }
        } else {
          preferredEnd = index + 1;
        }
      }
      if (units > maxUnits) break;
    }
    const end = Math.min(characters.length, preferredEnd > 0 ? preferredEnd : Math.max(1, hardEnd));
    lines.push(characters.slice(0, end).join("").trimEnd());
    remaining = characters.slice(end).join("").trimStart();
    if (!remaining) break;
  }
  if (remaining) lines.push(remaining);
  return lines;
}

export function wrapStructureText(input: {
  text: string;
  maxUnits: number;
  maxLines?: number;
  ellipsize?: boolean;
}): string[] {
  const maxUnits = Math.max(0.56, input.maxUnits);
  const rawLines = input.text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .flatMap((line) => wrapSingleLine(line, maxUnits));
  const maxLines = input.maxLines ?? Number.POSITIVE_INFINITY;
  if (rawLines.length <= maxLines) return rawLines;
  const result = rawLines.slice(0, Math.max(1, maxLines));
  if (input.ellipsize !== false) {
    result[result.length - 1] = fitEllipsis(result[result.length - 1]!, maxUnits);
  }
  return result;
}

function edgeLabelSize(
  edge: StructureEdge,
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>,
  labelAccessory: StructureLabelAccessory,
  labelMode: StructureEdgeLabelMode,
  maxTextWidth = EDGE_LABEL_MAX_TEXT_WIDTH,
): {
  selectWidth: number;
  boxWidth: number;
  height: number;
  displayLines: readonly string[];
  source: EdgeSourcePresentation;
} {
  const naturalTextWidth = Math.ceil(structureTextUnits(edge.label) * 11.5);
  const textWidth = Math.min(
    maxTextWidth,
    Math.max(
      EDGE_LABEL_MIN_TEXT_WIDTH,
      naturalTextWidth + EDGE_LABEL_HORIZONTAL_PADDING + EDGE_LABEL_WIDTH_SAFETY,
    ),
  );
  const contentWidth = Math.max(1, textWidth - EDGE_LABEL_HORIZONTAL_PADDING);
  const displayLines = wrapStructureText(
    labelMode === "viewer-clamped"
      ? {
          text: edge.label,
          maxUnits: contentWidth / 11.5,
          maxLines: 2,
          ellipsize: true,
        }
      : { text: edge.label, maxUnits: contentWidth / 11.5, ellipsize: false },
  );
  const textHeight = Math.max(24, displayLines.length * EDGE_LABEL_LINE_HEIGHT + 10);
  const source = edgeSourcePresentation(edge, sourceChangeKinds);
  const sourceBadgeOverflow = source.anchorCount > 1 ? 4 : 0;
  const sourceActionWidth =
    labelAccessory === "source-actions" && source.anchorCount > 0 ? 29 + sourceBadgeOverflow : 0;
  const height =
    labelAccessory === "source-actions"
      ? Math.max(textHeight, source.anchorCount > 1 ? 34 : source.anchorCount === 1 ? 26 : 0)
      : textHeight;
  return {
    selectWidth: textWidth,
    boxWidth: textWidth + sourceActionWidth,
    height,
    displayLines,
    source,
  };
}

export function placeEdgeLabels(
  edges: readonly StructureEdge[],
  nodes: readonly StructureNode[],
  positions: Readonly<Record<string, StructurePoint>>,
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>,
  routeOffsets: ReadonlyMap<string, number>,
  reciprocalEdgeIds: ReadonlySet<string>,
  labelAccessory: StructureLabelAccessory,
  labelMode: StructureEdgeLabelMode,
): StructureEdgeLabelPlacement[] {
  const nodeBoxes = nodes.flatMap((node) => {
    const point = positions[node.id];
    return point
      ? [
          {
            left: point.x,
            top: point.y,
            right: point.x + STRUCTURE_NODE_WIDTH,
            bottom: point.y + STRUCTURE_NODE_HEIGHT,
          },
        ]
      : [];
  });
  const collisionCellSize = 128;
  const collisionCellLimit = 48;
  const occupiedLabels = new Map<string, { boxes: StructureBox[]; saturated: boolean }>();
  const cellKeys = (box: StructureBox): string[] => {
    const keys: string[] = [];
    const left = Math.floor(box.left / collisionCellSize);
    const right = Math.floor(box.right / collisionCellSize);
    const top = Math.floor(box.top / collisionCellSize);
    const bottom = Math.floor(box.bottom / collisionCellSize);
    for (let x = left; x <= right; x += 1) {
      for (let y = top; y <= bottom; y += 1) keys.push(`${x}:${y}`);
    }
    return keys;
  };
  const overlapsOccupiedLabel = (box: StructureBox): boolean => {
    const seen = new Set<StructureBox>();
    for (const key of cellKeys(box)) {
      const cell = occupiedLabels.get(key);
      if (!cell) continue;
      if (cell.saturated) return true;
      for (const occupied of cell.boxes) {
        if (seen.has(occupied)) continue;
        seen.add(occupied);
        if (boxesOverlap(box, occupied)) return true;
      }
    }
    return false;
  };
  const occupyLabel = (box: StructureBox): void => {
    for (const key of cellKeys(box)) {
      const cell = occupiedLabels.get(key) ?? { boxes: [], saturated: false };
      if (!cell.saturated) {
        cell.boxes.push(box);
        if (cell.boxes.length >= collisionCellLimit) {
          cell.boxes = [];
          cell.saturated = true;
        }
      }
      occupiedLabels.set(key, cell);
    }
  };
  const placements: StructureEdgeLabelPlacement[] = [];
  const candidateFractions = Array.from({ length: 22 }, (_, index) => 0.08 + index * 0.04).sort(
    (left, right) => Math.abs(left - 0.5) - Math.abs(right - 0.5),
  );
  const candidateOffsets = [0, 12, -12, 24, -24, 36, -36, 48, -48] as const;
  const candidates = candidateOffsets.flatMap((offset) =>
    candidateFractions.map((fraction) => [fraction, offset] as const),
  );

  const stableEdges = [...edges].sort((left, right) => stableCompare(left.id, right.id));
  for (const [edgeIndex, edge] of stableEdges.entries()) {
    const geometry = edgePath(
      edge,
      positions,
      routeOffsets.get(edge.id) ?? 0,
      reciprocalEdgeIds.has(edge.id),
    );
    if (!geometry) continue;
    const naturalSize = edgeLabelSize(edge, sourceChangeKinds, labelAccessory, labelMode);
    const sizes: Array<ReturnType<typeof edgeLabelSize>> = [naturalSize];
    if (labelMode === "viewer-clamped") {
      const compactSize = edgeLabelSize(
        edge,
        sourceChangeKinds,
        labelAccessory,
        labelMode,
        EDGE_LABEL_COMPACT_MAX_TEXT_WIDTH,
      );
      if (compactSize.boxWidth < naturalSize.boxWidth) sizes.push(compactSize);
    }
    let available:
      { point: { x: number; y: number }; size: ReturnType<typeof edgeLabelSize> } | undefined;
    let fallback: typeof available;
    let firstPossible: { x: number; y: number } | undefined;
    for (const size of sizes) {
      const possible = candidates.map(([fraction, offset]) =>
        curveLabelCandidate(geometry, fraction, offset),
      );
      firstPossible ??= possible[edgeIndex % possible.length]!;
      const nodeSafe = possible.filter((candidate) => {
        const box = labelBox(candidate.x, candidate.y, size.boxWidth, size.height, 4);
        return !nodeBoxes.some((nodeBox) => boxesOverlap(box, nodeBox));
      });
      const point = nodeSafe.find((candidate) => {
        const box = labelBox(candidate.x, candidate.y, size.boxWidth, size.height, 5);
        return !overlapsOccupiedLabel(box);
      });
      if (point) {
        available = { point, size };
        break;
      }
      const fallbackPoint = nodeSafe[edgeIndex % nodeSafe.length];
      if (fallbackPoint) fallback = { point: fallbackPoint, size };
    }
    const chosen = available ?? fallback ?? { point: firstPossible!, size: naturalSize };
    occupyLabel(
      labelBox(chosen.point.x, chosen.point.y, chosen.size.boxWidth, chosen.size.height, 4),
    );
    placements.push({
      edge,
      displayLines: chosen.size.displayLines,
      source: chosen.size.source,
      x: chosen.point.x,
      y: chosen.point.y,
      selectWidth: chosen.size.selectWidth,
      boxWidth: chosen.size.boxWidth,
      height: chosen.size.height,
      crowded: !available,
    });
  }
  return placements;
}

export function buildStructureRenderModel(input: {
  structure: Structure;
  positions: Readonly<Record<string, StructurePoint>>;
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>;
  selection: StructureRenderSelection;
  labelAccessory: StructureLabelAccessory;
  edgeLabelMode: StructureEdgeLabelMode;
}): StructureRenderModel {
  const { structure, positions, sourceChangeKinds, selection, labelAccessory, edgeLabelMode } =
    input;
  const sourceLabels = shortestUniqueSourceLabels([
    ...structure.nodes.flatMap((node) => (node.anchor ? [node.anchor.path] : [])),
    ...structure.edges.flatMap((edge) => edge.anchors.map((anchor) => anchor.path)),
  ]);
  const nodes = structure.nodes.flatMap((node) => {
    if (!selection.nodeIds.has(node.id)) return [];
    const point = positions[node.id];
    if (!point) return [];
    return [
      {
        node,
        point,
        sourceLabel: node.anchor ? (sourceLabels.get(node.anchor.path) ?? node.anchor.path) : null,
        changeKind: node.anchor ? (sourceChangeKinds.get(node.anchor.path) ?? null) : null,
      },
    ];
  });
  const renderNodeIds = new Set(nodes.map(({ node }) => node.id));
  const selectedEdges = structure.edges.filter(
    (edge) =>
      selection.edgeIds.has(edge.id) && renderNodeIds.has(edge.from) && renderNodeIds.has(edge.to),
  );
  const routeOffsets = structureEdgeRouteOffsets(structure.edges);
  const reciprocalEdgeIds = reciprocalStructureEdgeIds(structure.edges);
  const edges = selectedEdges.flatMap((edge) => {
    const geometry = edgePath(
      edge,
      positions,
      routeOffsets.get(edge.id) ?? 0,
      reciprocalEdgeIds.has(edge.id),
    );
    return geometry
      ? [{ edge, geometry, source: edgeSourcePresentation(edge, sourceChangeKinds) }]
      : [];
  });
  const edgeIds = new Set(edges.map(({ edge }) => edge.id));
  const labelEdges = selectedEdges.filter(
    (edge) => edgeIds.has(edge.id) && selection.labelEdgeIds.has(edge.id),
  );
  const labels = placeEdgeLabels(
    labelEdges,
    nodes.map(({ node }) => node),
    positions,
    sourceChangeKinds,
    routeOffsets,
    reciprocalEdgeIds,
    labelAccessory,
    edgeLabelMode,
  );
  const boxes: StructureBox[] = nodes.map(({ point }) => ({
    left: point.x,
    top: point.y,
    right: point.x + STRUCTURE_NODE_WIDTH,
    bottom: point.y + STRUCTURE_NODE_HEIGHT,
  }));
  boxes.push(...edges.map(({ geometry }) => geometry.bounds));
  boxes.push(
    ...labels.map((placement) =>
      labelBox(placement.x, placement.y, placement.boxWidth, placement.height, 4),
    ),
  );
  return { nodes, edges, labels, bounds: mergedBounds(boxes) };
}

export function buildFullStructureRenderModel(input: {
  structure: Structure;
  positions: Readonly<Record<string, StructurePoint>>;
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>;
}): StructureRenderModel {
  const { structure } = input;
  return buildStructureRenderModel({
    ...input,
    selection: {
      nodeIds: new Set(structure.nodes.map((node) => node.id)),
      edgeIds: new Set(structure.edges.map((edge) => edge.id)),
      labelEdgeIds: new Set(structure.edges.map((edge) => edge.id)),
    },
    labelAccessory: "none",
    edgeLabelMode: "export-complete",
  });
}
