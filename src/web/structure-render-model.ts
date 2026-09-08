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
  /** Complete factual centerline, including the target boundary tip. */
  path: string;
  /** Visible relation stroke, ending exactly at the directed-arrow base. */
  strokePath: string;
  /** Invisible terminal carrier whose marker runs from the arrow base to the boundary tip. */
  arrowPath: string;
  points: readonly StructurePoint[];
  startX: number;
  startY: number;
  control1X: number;
  control1Y: number;
  control2X: number;
  control2Y: number;
  endX: number;
  endY: number;
  arrowBaseX: number;
  arrowBaseY: number;
  arrowTangentX: number;
  arrowTangentY: number;
  bounds: StructureBox;
}

export type EdgeSourceChangeKind = ChangeKind | "mixed";

export interface EdgeSourcePresentation {
  anchorCount: number;
  changeKind: EdgeSourceChangeKind | null;
}

export type StructureEdgeSourceMenuPlacement =
  "below-left" | "above-left" | "below-right" | "above-right";

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
  displaced: boolean;
  leaderPath: string | null;
  leaderBounds: StructureBox | null;
  leaderEdgeAnchor: StructurePoint | null;
  leaderLabelAnchor: StructurePoint | null;
  sourceMenuPlacement: StructureEdgeSourceMenuPlacement | null;
  sourceMenuWidth: number | null;
  diagnostics: StructureEdgeLabelDiagnostics;
}

export type StructureEdgeLabelFallbackReason =
  "distant" | "label-route-overlap" | "leader-overlap" | "emergency";

/**
 * Renderer-owned placement health. This never changes the factual Edge or authoring payload; it
 * lets the automatic-layout caller decide whether a bounded spacing retry would be worthwhile.
 */
export interface StructureEdgeLabelDiagnostics {
  edgeDistance: number;
  leaderLength: number;
  maxParallelOverlap: number;
  crossingCount: number;
  usedCompactWidth: boolean;
  spacingPressure: boolean;
  fallbackReason: StructureEdgeLabelFallbackReason | null;
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

export interface StructureRenderRegion {
  id: string;
  index: number;
  label: string;
  summary: string;
  nodeIds: readonly string[];
  bounds: StructureBox;
}

export interface StructureRenderPresentation {
  thesis: string;
  startNodeId: string;
  primaryBackboneNodeIds: ReadonlySet<string>;
  primaryBackboneEdgeIds: ReadonlySet<string>;
  regions: readonly StructureRenderRegion[];
}

export interface StructureRenderModel {
  nodes: readonly StructureRenderNode[];
  edges: readonly StructureRenderEdge[];
  labels: readonly StructureEdgeLabelPlacement[];
  presentation: StructureRenderPresentation | null;
  bounds: StructureBox | null;
}

/**
 * Selection-independent geometry for one factual Structure revision and one set of Node positions.
 *
 * Routing and label placement intentionally use the complete graph so that changing the reviewer's
 * focus does not move surviving relations. Keeping that expensive work in a separate foundation also
 * lets the Viewer change its lens without routing the same complete graph again.
 */
export interface StructureRenderFoundation {
  nodes: readonly StructureRenderNode[];
  edges: readonly StructureRenderEdge[];
  labels: readonly StructureEdgeLabelPlacement[];
  presentation: StructureRenderPresentation | null;
}

/**
 * Renderer input deliberately omits factual entrypoint fields. A derived local graph may exclude
 * the artifact's origin/start Node and must not masquerade as a protocol-valid Structure value.
 */
export type StructureRenderGraph = Pick<Structure, "nodes" | "edges" | "presentation">;

export interface StructureRenderFoundationInput {
  structure: StructureRenderGraph;
  positions: Readonly<Record<string, StructurePoint>>;
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>;
  labelAccessory: StructureLabelAccessory;
  edgeLabelMode: StructureEdgeLabelMode;
}

export interface StructureAutomaticSpacingRetryInput {
  attempt: 1 | 2;
  positions: Readonly<Record<string, StructurePoint>>;
  foundation: StructureRenderFoundation;
  pressureLabels: readonly StructureEdgeLabelPlacement[];
}

export interface StructureAutomaticRenderFoundationInput extends StructureRenderFoundationInput {
  retryPositions: (
    input: StructureAutomaticSpacingRetryInput,
  ) => Readonly<Record<string, StructurePoint>> | null | undefined;
}

export interface StructureAutomaticRenderFoundationResult {
  foundation: StructureRenderFoundation;
  positions: Readonly<Record<string, StructurePoint>>;
  retryCount: number;
}

export type StructureLabelAccessory = "source-actions" | "none";
export type StructureEdgeLabelMode = "viewer-adaptive" | "export-complete";

const EDGE_LABEL_MAX_TEXT_WIDTH = 210;
const EDGE_LABEL_COMPACT_MAX_TEXT_WIDTH = 136;
const EDGE_LABEL_MIN_TEXT_WIDTH = 64;
const EDGE_LABEL_HORIZONTAL_PADDING = 11;
const EDGE_LABEL_WIDTH_SAFETY = 2;
export const EDGE_LABEL_LINE_HEIGHT = 14;
const EDGE_LABEL_SOURCE_MENU_WIDTH = 300;
const EDGE_LABEL_SOURCE_MENU_MAX_HEIGHT = 180;
const EDGE_LABEL_SOURCE_MENU_ITEM_HEIGHT = 26;
const EDGE_LABEL_SOURCE_MENU_ITEM_GAP = 5;
const EDGE_LABEL_SOURCE_MENU_PADDING = 7;
const EDGE_LABEL_SOURCE_MENU_BORDER = 1;
const EDGE_LABEL_SOURCE_MENU_OFFSET = 5;
const EDGE_LABEL_SOURCE_MENU_WIDTHS = [EDGE_LABEL_SOURCE_MENU_WIDTH, 240, 180, 144] as const;
const EDGE_LABEL_SOURCE_MENU_PLACEMENTS = [
  "below-left",
  "above-left",
  "below-right",
  "above-right",
] as const satisfies readonly StructureEdgeSourceMenuPlacement[];
const EDGE_LABEL_COLLISION_PADDING = 5;
const EDGE_LABEL_NEAR_GAP = 20;
const EDGE_LABEL_SHORT_LEADER_GAP = 72;
const EDGE_LABEL_LEADER_KICKOFF = 12;
const EDGE_LABEL_LEADER_NEAR_PARALLEL_DISTANCE = 6;
const EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP = 36;
const EDGE_LABEL_LEADER_FULL_GRID_VERTEX_LIMIT = 4_096;
const EDGE_LABEL_EMERGENCY_FULL_GRID_VERTEX_LIMIT = 32_768;
const EDGE_LABEL_OBSTACLE_BOUNDARY_TOLERANCE = 0.001;
const EDGE_LABEL_EMERGENCY_ANCHOR_LIMIT = 22;
const EDGE_LABEL_EMERGENCY_SHELF_GAP = 24;
const EDGE_LABEL_EMERGENCY_STACK_GAP = 12;
const EDGE_LABEL_OUTSIDE_GAP = 8;
const EDGE_LABEL_OUTSIDE_SLOT_GAP = 12;
const EDGE_LABEL_OUTSIDE_RING_COUNT = 3;
const EDGE_LABEL_OUTSIDE_SLOTS_PER_SIDE_LIMIT = 32;
const EDGE_LABEL_OUTSIDE_ANCHORS_PER_SLOT = 3;
const EDGE_LABEL_OUTSIDE_LEADER_ATTEMPT_LIMIT = 64;
const EDGE_LABEL_SEGMENT_INDEX_CELL_SIZE = 128;
const STRUCTURE_AUTOMATIC_LAYOUT_SPACING_RETRY_ATTEMPTS = [1, 2] as const;
export const STRUCTURE_AUTOMATIC_LAYOUT_MAX_SPACING_RETRIES =
  STRUCTURE_AUTOMATIC_LAYOUT_SPACING_RETRY_ATTEMPTS.length;
const EDGE_LABEL_CANDIDATE_FRACTIONS = Array.from(
  { length: 22 },
  (_, index) => 0.08 + index * 0.04,
).sort((left, right) => Math.abs(left - 0.5) - Math.abs(right - 0.5));
const EDGE_LABEL_CANDIDATE_OFFSETS = [
  0, 14, -14, 28, -28, 44, -44, 64, -64, 88, -88, 116, -116, 152, -152, 196, -196, 248, -248,
] as const;

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

const EDGE_NODE_CLEARANCE = 12;
const EDGE_ROUTE_OUTER_GUTTER = 56;
const EDGE_ROUTE_BEND_COST = 28;
export const STRUCTURE_EDGE_ARROW_LENGTH = 12;
export const STRUCTURE_EDGE_ARROW_WIDTH = 10;
/** Minimum visible straight run between the final bend and a directed arrowhead's base. */
export const STRUCTURE_EDGE_MIN_TERMINAL_APPROACH = 10;
const EDGE_ARROW_TERMINAL_STUB = STRUCTURE_EDGE_ARROW_LENGTH + STRUCTURE_EDGE_MIN_TERMINAL_APPROACH;

type RouteDirection = "horizontal" | "vertical" | "start";
type RouteSide = "left" | "right" | "top" | "bottom";

interface RoutePort {
  point: StructurePoint;
  boundaryPoint: StructurePoint;
  side: RouteSide;
}

type RoutePortOffsets = Readonly<Record<RouteSide, number>>;

interface EdgeRoutePortOffsets {
  from: RoutePortOffsets;
  to: RoutePortOffsets;
}

interface WeightedRoutePoint {
  point: StructurePoint;
  penalty: number;
}

function sampledCubic(input: {
  start: StructurePoint;
  control1: StructurePoint;
  control2: StructurePoint;
  end: StructurePoint;
}): StructurePoint[] {
  return Array.from({ length: 49 }, (_, index) => {
    const fraction = index / 48;
    const inverse = 1 - fraction;
    return {
      x:
        inverse ** 3 * input.start.x +
        3 * inverse ** 2 * fraction * input.control1.x +
        3 * inverse * fraction ** 2 * input.control2.x +
        fraction ** 3 * input.end.x,
      y:
        inverse ** 3 * input.start.y +
        3 * inverse ** 2 * fraction * input.control1.y +
        3 * inverse * fraction ** 2 * input.control2.y +
        fraction ** 3 * input.end.y,
    };
  });
}

function geometryBounds(points: readonly StructurePoint[]): StructureBox {
  return {
    left: Math.min(...points.map(({ x }) => x)),
    top: Math.min(...points.map(({ y }) => y)),
    right: Math.max(...points.map(({ x }) => x)),
    bottom: Math.max(...points.map(({ y }) => y)),
  };
}

type StructureEdgeCenterlineGeometry = Omit<
  StructureEdgeGeometry,
  "strokePath" | "arrowPath" | "arrowBaseX" | "arrowBaseY" | "arrowTangentX" | "arrowTangentY"
>;

function terminalArrow(points: readonly StructurePoint[]): {
  base: StructurePoint;
  path: string;
  tangent: StructurePoint;
} {
  const tip = points.at(-1)!;
  const previous = [...points]
    .reverse()
    .slice(1)
    .find((point) => point.x !== tip.x || point.y !== tip.y)!;
  const dx = tip.x - previous.x;
  const dy = tip.y - previous.y;
  const terminalLength = Math.hypot(dx, dy);
  const tangent = { x: dx / terminalLength, y: dy / terminalLength };
  const length = Math.min(STRUCTURE_EDGE_ARROW_LENGTH, terminalLength);
  const base = {
    x: tip.x - tangent.x * length,
    y: tip.y - tangent.y * length,
  };
  return {
    base,
    path: `M ${base.x} ${base.y} L ${tip.x} ${tip.y}`,
    tangent,
  };
}

function withArrowTerminal(
  geometry: StructureEdgeCenterlineGeometry,
  strokePath: string,
): StructureEdgeGeometry {
  const arrow = terminalArrow(geometry.points);
  return {
    ...geometry,
    strokePath,
    arrowPath: arrow.path,
    arrowBaseX: arrow.base.x,
    arrowBaseY: arrow.base.y,
    arrowTangentX: arrow.tangent.x,
    arrowTangentY: arrow.tangent.y,
  };
}

function cubicGeometry(input: {
  start: StructurePoint;
  control1: StructurePoint;
  control2: StructurePoint;
  end: StructurePoint;
}): StructureEdgeCenterlineGeometry {
  const points = sampledCubic(input);
  return {
    path: `M ${input.start.x} ${input.start.y} C ${input.control1.x} ${input.control1.y}, ${input.control2.x} ${input.control2.y}, ${input.end.x} ${input.end.y}`,
    points,
    startX: input.start.x,
    startY: input.start.y,
    control1X: input.control1.x,
    control1Y: input.control1.y,
    control2X: input.control2.x,
    control2Y: input.control2.y,
    endX: input.end.x,
    endY: input.end.y,
    bounds: geometryBounds([...points, input.control1, input.control2]),
  };
}

function stubbedCubicGeometry(input: {
  boundaryStart: StructurePoint;
  start: StructurePoint;
  control1: StructurePoint;
  control2: StructurePoint;
  end: StructurePoint;
  boundaryEnd: StructurePoint;
}): StructureEdgeGeometry {
  const core = cubicGeometry(input);
  const points = simplifyRoutePoints([input.boundaryStart, ...core.points, input.boundaryEnd]);
  const centerline = {
    ...core,
    path: `M ${input.boundaryStart.x} ${input.boundaryStart.y} L ${input.start.x} ${input.start.y} C ${input.control1.x} ${input.control1.y}, ${input.control2.x} ${input.control2.y}, ${input.end.x} ${input.end.y} L ${input.boundaryEnd.x} ${input.boundaryEnd.y}`,
    points,
    startX: input.boundaryStart.x,
    startY: input.boundaryStart.y,
    endX: input.boundaryEnd.x,
    endY: input.boundaryEnd.y,
    bounds: geometryBounds([...points, input.control1, input.control2]),
  };
  const arrow = terminalArrow(points);
  return withArrowTerminal(
    centerline,
    `M ${input.boundaryStart.x} ${input.boundaryStart.y} L ${input.start.x} ${input.start.y} C ${input.control1.x} ${input.control1.y}, ${input.control2.x} ${input.control2.y}, ${input.end.x} ${input.end.y} L ${arrow.base.x} ${arrow.base.y}`,
  );
}

function simplifyRoutePoints(points: readonly StructurePoint[]): StructurePoint[] {
  const result: StructurePoint[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    const beforePrevious = result.at(-2);
    if (
      beforePrevious &&
      previous &&
      ((beforePrevious.x === previous.x && previous.x === point.x) ||
        (beforePrevious.y === previous.y && previous.y === point.y))
    ) {
      result[result.length - 1] = point;
    } else {
      result.push(point);
    }
  }
  return result;
}

function polylineGeometry(rawPoints: readonly StructurePoint[]): StructureEdgeGeometry | null {
  const points = simplifyRoutePoints(rawPoints);
  const start = points[0];
  const end = points.at(-1);
  if (!start || !end || points.length < 2) return null;
  const pathForPoints = (pathPoints: readonly StructurePoint[]): string => {
    const pathStart = pathPoints[0]!;
    const segments = pathPoints.slice(1).map((point, index) => {
      const previous = pathPoints[index]!;
      return `C ${previous.x + (point.x - previous.x) / 3} ${previous.y + (point.y - previous.y) / 3}, ${previous.x + ((point.x - previous.x) * 2) / 3} ${previous.y + ((point.y - previous.y) * 2) / 3}, ${point.x} ${point.y}`;
    });
    return `M ${pathStart.x} ${pathStart.y} ${segments.join(" ")}`;
  };
  const second = points[1]!;
  const penultimate = points.at(-2)!;
  const centerline: StructureEdgeCenterlineGeometry = {
    path: pathForPoints(points),
    points,
    startX: start.x,
    startY: start.y,
    control1X: start.x + (second.x - start.x) / 3,
    control1Y: start.y + (second.y - start.y) / 3,
    control2X: penultimate.x + ((end.x - penultimate.x) * 2) / 3,
    control2Y: penultimate.y + ((end.y - penultimate.y) * 2) / 3,
    endX: end.x,
    endY: end.y,
    bounds: geometryBounds(points),
  };
  const arrow = terminalArrow(points);
  const strokePoints = simplifyRoutePoints([...points.slice(0, -1), arrow.base]);
  return withArrowTerminal(centerline, pathForPoints(strokePoints));
}

function directEdgeGeometry(
  edge: StructureEdge,
  positions: Readonly<Record<string, StructurePoint>>,
  laneOffset: number,
  reciprocal: boolean,
  portOffsets?: EdgeRoutePortOffsets,
  nodeNotations?: ReadonlyMap<string, StructureNode["notation"]>,
): StructureEdgeGeometry | null {
  const from = positions[edge.from];
  const to = positions[edge.to];
  if (!from || !to || edge.from === edge.to) return null;
  const fromCenter = {
    x: from.x + STRUCTURE_NODE_WIDTH / 2,
    y: from.y + STRUCTURE_NODE_HEIGHT / 2,
  };
  const toCenter = {
    x: to.x + STRUCTURE_NODE_WIDTH / 2,
    y: to.y + STRUCTURE_NODE_HEIGHT / 2,
  };
  const fromSide = preferredRouteSide(fromCenter, toCenter);
  const toSide = preferredRouteSide(toCenter, fromCenter);
  const fromPort = routePorts(
    nodeRouteBox(from, 0),
    portOffsets?.from ?? laneOffset,
    EDGE_ARROW_TERMINAL_STUB,
    nodeNotations?.get(edge.from),
  ).find(({ side }) => side === fromSide)!;
  const toPort = routePorts(
    nodeRouteBox(to, 0),
    portOffsets?.to ?? laneOffset,
    EDGE_ARROW_TERMINAL_STUB,
    nodeNotations?.get(edge.to),
  ).find(({ side }) => side === toSide)!;
  const innerDx = toPort.point.x - fromPort.point.x;
  const innerDy = toPort.point.y - fromPort.point.y;
  const length = Math.max(1, Math.hypot(innerDx, innerDy));
  const unitX = innerDx / length;
  const unitY = innerDy / length;
  const perpendicularX = -unitY;
  const perpendicularY = unitX;
  const start = fromPort.point;
  const end = toPort.point;
  const curve = laneOffset * (reciprocal ? 5.5 : 4);
  const control1 = {
    x: start.x + (end.x - start.x) / 3 + perpendicularX * curve,
    y: start.y + (end.y - start.y) / 3 + perpendicularY * curve,
  };
  const control2 = {
    x: start.x + ((end.x - start.x) * 2) / 3 + perpendicularX * curve,
    y: start.y + ((end.y - start.y) * 2) / 3 + perpendicularY * curve,
  };
  return stubbedCubicGeometry({
    boundaryStart: fromPort.boundaryPoint,
    start,
    control1,
    control2,
    end,
    boundaryEnd: toPort.boundaryPoint,
  });
}

export function edgePath(
  edge: StructureEdge,
  positions: Readonly<Record<string, StructurePoint>>,
  laneOffset = 0,
  reciprocal = false,
): StructureEdgeGeometry | null {
  if (edge.from !== edge.to) {
    return directEdgeGeometry(edge, positions, laneOffset, reciprocal);
  }
  const point = positions[edge.from];
  if (!point) return null;
  const shift = laneOffset * 0.5;
  const boundaryStart = {
    x: point.x + STRUCTURE_NODE_WIDTH,
    y: point.y + Math.max(16, Math.min(48, 32 + shift)),
  };
  const boundaryEnd = {
    x: point.x + STRUCTURE_NODE_WIDTH,
    y: point.y + Math.max(64, Math.min(96, STRUCTURE_NODE_HEIGHT - 32 + shift)),
  };
  return stubbedCubicGeometry({
    boundaryStart,
    start: {
      x: boundaryStart.x + EDGE_ARROW_TERMINAL_STUB,
      y: boundaryStart.y,
    },
    control1: {
      x: point.x + STRUCTURE_NODE_WIDTH + 88 + Math.abs(laneOffset) * 2,
      y: point.y - 72 + shift,
    },
    control2: {
      x: point.x + STRUCTURE_NODE_WIDTH + 88 + Math.abs(laneOffset) * 2,
      y: point.y + STRUCTURE_NODE_HEIGHT + 72 + shift,
    },
    end: {
      x: boundaryEnd.x + EDGE_ARROW_TERMINAL_STUB,
      y: boundaryEnd.y,
    },
    boundaryEnd,
  });
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

function nodeRouteBox(point: StructurePoint, padding = EDGE_NODE_CLEARANCE): StructureBox {
  return {
    left: point.x - padding,
    top: point.y - padding,
    right: point.x + STRUCTURE_NODE_WIDTH + padding,
    bottom: point.y + STRUCTURE_NODE_HEIGHT + padding,
  };
}

function pointInsideBox(point: StructurePoint, box: StructureBox): boolean {
  return point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom;
}

function orthogonalSegmentBlocked(
  left: StructurePoint,
  right: StructurePoint,
  obstacles: readonly StructureBox[],
): boolean {
  if (left.y === right.y) {
    const segmentLeft = Math.min(left.x, right.x);
    const segmentRight = Math.max(left.x, right.x);
    return obstacles.some(
      (box) =>
        left.y > box.top &&
        left.y < box.bottom &&
        segmentLeft < box.right &&
        segmentRight > box.left,
    );
  }
  if (left.x === right.x) {
    const segmentTop = Math.min(left.y, right.y);
    const segmentBottom = Math.max(left.y, right.y);
    return obstacles.some(
      (box) =>
        left.x > box.left &&
        left.x < box.right &&
        segmentTop < box.bottom &&
        segmentBottom > box.top,
    );
  }
  return true;
}

function segmentIntersectsBox(
  start: StructurePoint,
  end: StructurePoint,
  box: StructureBox,
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

function routeIntersectsBoxes(
  points: readonly StructurePoint[],
  obstacles: readonly StructureBox[],
): boolean {
  return points
    .slice(1)
    .some((point, index) =>
      obstacles.some((box) => segmentIntersectsBox(points[index]!, point, box)),
    );
}

function routePorts(
  box: StructureBox,
  offsets: number | RoutePortOffsets,
  clearance: number,
  notation: StructureNode["notation"] = "plain",
): RoutePort[] {
  const centerX = (box.left + box.right) / 2;
  const centerY = (box.top + box.bottom) / 2;
  const offsetFor = (side: RouteSide): number =>
    typeof offsets === "number" ? offsets : offsets[side];
  const horizontalShift = (side: RouteSide): number =>
    Math.max(
      -(box.right - box.left) / 2 + 16,
      Math.min((box.right - box.left) / 2 - 16, offsetFor(side)),
    );
  const verticalShift = (side: RouteSide): number =>
    Math.max(
      -(box.bottom - box.top) / 2 + 16,
      Math.min((box.bottom - box.top) / 2 - 16, offsetFor(side)),
    );
  const rectangularPorts: Array<{ boundaryPoint: StructurePoint; side: RouteSide }> = [
    {
      boundaryPoint: { x: box.left, y: centerY + verticalShift("left") },
      side: "left",
    },
    {
      boundaryPoint: { x: box.right, y: centerY + verticalShift("right") },
      side: "right",
    },
    {
      boundaryPoint: { x: centerX + horizontalShift("top"), y: box.top },
      side: "top",
    },
    {
      boundaryPoint: { x: centerX + horizontalShift("bottom"), y: box.bottom },
      side: "bottom",
    },
  ];
  return rectangularPorts.map(({ boundaryPoint: rectangularPoint, side }) => {
    const boundaryPoint = visibleNodeBoundaryPoint(box, side, rectangularPoint, notation);
    // Curved and polygonal Nodes can inset their visible boundary substantially from the layout
    // box. The routing terminal still has to clear the complete Node box before joining the shared
    // orthogonal grid, otherwise its first point is discarded as an obstacle interior.
    const point = (() => {
      switch (side) {
        case "left":
          return { x: box.left - clearance, y: boundaryPoint.y };
        case "right":
          return { x: box.right + clearance, y: boundaryPoint.y };
        case "top":
          return { x: boundaryPoint.x, y: box.top - clearance };
        case "bottom":
          return { x: boundaryPoint.x, y: box.bottom + clearance };
      }
    })();
    return { point, boundaryPoint, side };
  });
}

function roundedRectangleBoundaryPoint(
  box: StructureBox,
  side: RouteSide,
  rectangularPoint: StructurePoint,
  radiusX: number,
  radiusY: number,
): StructurePoint {
  const centerX = (box.left + box.right) / 2;
  const centerY = (box.top + box.bottom) / 2;
  const halfWidth = (box.right - box.left) / 2;
  const halfHeight = (box.bottom - box.top) / 2;
  const horizontalFlatHalf = Math.max(0, halfWidth - radiusX);
  const verticalFlatHalf = Math.max(0, halfHeight - radiusY);
  if (side === "top" || side === "bottom") {
    const offset = rectangularPoint.x - centerX;
    if (Math.abs(offset) <= horizontalFlatHalf) return rectangularPoint;
    const cornerCenterX = centerX + Math.sign(offset || 1) * horizontalFlatHalf;
    const normalizedX = Math.max(-1, Math.min(1, (rectangularPoint.x - cornerCenterX) / radiusX));
    const insetY = radiusY * (1 - Math.sqrt(Math.max(0, 1 - normalizedX ** 2)));
    return {
      x: rectangularPoint.x,
      y: side === "top" ? box.top + insetY : box.bottom - insetY,
    };
  }
  const offset = rectangularPoint.y - centerY;
  if (Math.abs(offset) <= verticalFlatHalf) return rectangularPoint;
  const cornerCenterY = centerY + Math.sign(offset || 1) * verticalFlatHalf;
  const normalizedY = Math.max(-1, Math.min(1, (rectangularPoint.y - cornerCenterY) / radiusY));
  const insetX = radiusX * (1 - Math.sqrt(Math.max(0, 1 - normalizedY ** 2)));
  return {
    x: side === "left" ? box.left + insetX : box.right - insetX,
    y: rectangularPoint.y,
  };
}

function externalNodeBoundaryPoint(
  box: StructureBox,
  side: RouteSide,
  rectangularPoint: StructurePoint,
): StructurePoint {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  const centerX = (box.left + box.right) / 2;
  const centerY = (box.top + box.bottom) / 2;
  const shoulder = width * 0.09;
  if (side === "left" || side === "right") {
    const normalizedY = Math.min(1, Math.abs(rectangularPoint.y - centerY) / (height / 2));
    const insetX = shoulder * normalizedY;
    return {
      x: side === "left" ? box.left + insetX : box.right - insetX,
      y: rectangularPoint.y,
    };
  }
  const horizontalFlatHalf = width / 2 - shoulder;
  const offset = rectangularPoint.x - centerX;
  if (Math.abs(offset) <= horizontalFlatHalf) return rectangularPoint;
  const excess = Math.abs(offset) - horizontalFlatHalf;
  const insetY = (excess / shoulder) * (height / 2);
  return {
    x: rectangularPoint.x,
    y: side === "top" ? box.top + insetY : box.bottom - insetY,
  };
}

function visibleNodeBoundaryPoint(
  box: StructureBox,
  side: RouteSide,
  rectangularPoint: StructurePoint,
  notation: StructureNode["notation"],
): StructurePoint {
  if (notation === "external") {
    return externalNodeBoundaryPoint(box, side, rectangularPoint);
  }
  if (notation === "concept") {
    const radius = Math.min((box.right - box.left) / 2, (box.bottom - box.top) / 2);
    return roundedRectangleBoundaryPoint(box, side, rectangularPoint, radius, radius);
  }
  if (notation === "database") {
    return roundedRectangleBoundaryPoint(
      box,
      side,
      rectangularPoint,
      (box.right - box.left) / 2,
      (box.bottom - box.top) * 0.14,
    );
  }
  return rectangularPoint;
}

function evenlySpacedPortOffsets(count: number, sideLength: number): number[] {
  if (count <= 1) return [0];
  const usableHalfLength = Math.max(1, sideLength / 2 - 16);
  const step = (usableHalfLength * 2) / (count - 1);
  return Array.from({ length: count }, (_, index) => -usableHalfLength + index * step);
}

function structureEdgePortOffsets(
  edges: readonly StructureEdge[],
  positions: Readonly<Record<string, StructurePoint>>,
): ReadonlyMap<string, EdgeRoutePortOffsets> {
  type Endpoint = {
    edge: StructureEdge;
    end: "from" | "to";
    nodeId: string;
    otherNodeId: string;
    otherCenter: StructurePoint;
  };
  const endpointsByNodeId = new Map<string, Endpoint[]>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) continue;
    const fromCenter = {
      x: from.x + STRUCTURE_NODE_WIDTH / 2,
      y: from.y + STRUCTURE_NODE_HEIGHT / 2,
    };
    const toCenter = {
      x: to.x + STRUCTURE_NODE_WIDTH / 2,
      y: to.y + STRUCTURE_NODE_HEIGHT / 2,
    };
    const endpoints = [
      {
        edge,
        end: "from" as const,
        nodeId: edge.from,
        otherNodeId: edge.to,
        otherCenter: toCenter,
      },
      {
        edge,
        end: "to" as const,
        nodeId: edge.to,
        otherNodeId: edge.from,
        otherCenter: fromCenter,
      },
    ];
    for (const endpoint of endpoints) {
      const incident = endpointsByNodeId.get(endpoint.nodeId) ?? [];
      incident.push(endpoint);
      endpointsByNodeId.set(endpoint.nodeId, incident);
    }
  }

  const mutable = new Map<
    string,
    { from: Record<RouteSide, number>; to: Record<RouteSide, number> }
  >();
  const emptyOffsets = (): Record<RouteSide, number> => ({ left: 0, right: 0, top: 0, bottom: 0 });
  const endpointOrder =
    (side: RouteSide) =>
    (left: Endpoint, right: Endpoint): number => {
      const leftAxis =
        side === "left" || side === "right" ? left.otherCenter.y : left.otherCenter.x;
      const rightAxis =
        side === "left" || side === "right" ? right.otherCenter.y : right.otherCenter.x;
      return (
        leftAxis - rightAxis ||
        stableCompare(left.otherNodeId, right.otherNodeId) ||
        stableCompare(left.edge.id, right.edge.id) ||
        stableCompare(left.end, right.end)
      );
    };
  for (const endpoints of endpointsByNodeId.values()) {
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const sorted = [...endpoints].sort(endpointOrder(side));
      const sideLength =
        side === "left" || side === "right" ? STRUCTURE_NODE_HEIGHT : STRUCTURE_NODE_WIDTH;
      const offsets = evenlySpacedPortOffsets(sorted.length, sideLength);
      sorted.forEach((endpoint, index) => {
        const assignment = mutable.get(endpoint.edge.id) ?? {
          from: emptyOffsets(),
          to: emptyOffsets(),
        };
        assignment[endpoint.end][side] = offsets[index]!;
        mutable.set(endpoint.edge.id, assignment);
      });
    }
  }
  return mutable;
}

function preferredRouteSide(from: StructurePoint, to: StructurePoint): RouteSide {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function routeSidePenalty(side: RouteSide, preferred: RouteSide): number {
  if (side === preferred) return 0;
  if (
    (side === "left" && preferred === "right") ||
    (side === "right" && preferred === "left") ||
    (side === "top" && preferred === "bottom") ||
    (side === "bottom" && preferred === "top")
  ) {
    return 72;
  }
  return 24;
}

function pointKey(point: StructurePoint): string {
  return `${point.x}:${point.y}`;
}

interface RouteQueueEntry {
  stateKey: string;
  vertexKey: string;
  direction: RouteDirection;
  cost: number;
}

function compareQueueEntry(left: RouteQueueEntry, right: RouteQueueEntry): number {
  return left.cost - right.cost || stableCompare(left.stateKey, right.stateKey);
}

function pushRouteQueue(queue: RouteQueueEntry[], entry: RouteQueueEntry): void {
  queue.push(entry);
  for (let index = queue.length - 1; index > 0;) {
    const parent = Math.floor((index - 1) / 2);
    if (compareQueueEntry(queue[parent]!, queue[index]!) <= 0) break;
    [queue[parent], queue[index]] = [queue[index]!, queue[parent]!];
    index = parent;
  }
}

function popRouteQueue(queue: RouteQueueEntry[]): RouteQueueEntry | undefined {
  const first = queue[0];
  const last = queue.pop();
  if (!first || !last || queue.length === 0) return first;
  queue[0] = last;
  for (let index = 0; index < queue.length;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < queue.length && compareQueueEntry(queue[left]!, queue[smallest]!) < 0) {
      smallest = left;
    }
    if (right < queue.length && compareQueueEntry(queue[right]!, queue[smallest]!) < 0) {
      smallest = right;
    }
    if (smallest === index) break;
    [queue[index], queue[smallest]] = [queue[smallest]!, queue[index]!];
    index = smallest;
  }
  return first;
}

function simpleOrthogonalGridRoute(input: {
  sources: readonly WeightedRoutePoint[];
  targets: readonly WeightedRoutePoint[];
  obstacles: readonly StructureBox[];
  channelOffset: number;
}): StructurePoint[] | null {
  const outerBounds = mergedBounds([
    ...input.obstacles,
    ...input.sources.map(({ point }) => ({
      left: point.x,
      top: point.y,
      right: point.x,
      bottom: point.y,
    })),
    ...input.targets.map(({ point }) => ({
      left: point.x,
      top: point.y,
      right: point.x,
      bottom: point.y,
    })),
  ]);
  if (!outerBounds) return null;
  let best: { cost: number; key: string; points: StructurePoint[] } | null = null;
  for (const source of input.sources) {
    for (const target of input.targets) {
      const candidates =
        input.channelOffset === 0
          ? [
              [source.point, { x: target.point.x, y: source.point.y }, target.point],
              [source.point, { x: source.point.x, y: target.point.y }, target.point],
            ]
          : [
              outerBounds.left - EDGE_ROUTE_OUTER_GUTTER - input.channelOffset,
              outerBounds.right + EDGE_ROUTE_OUTER_GUTTER + input.channelOffset,
            ]
              .map((x) => [
                source.point,
                { x, y: source.point.y },
                { x, y: target.point.y },
                target.point,
              ])
              .concat(
                [
                  outerBounds.top - EDGE_ROUTE_OUTER_GUTTER - input.channelOffset,
                  outerBounds.bottom + EDGE_ROUTE_OUTER_GUTTER + input.channelOffset,
                ].map((y) => [
                  source.point,
                  { x: source.point.x, y },
                  { x: target.point.x, y },
                  target.point,
                ]),
              );
      for (const rawPoints of candidates) {
        const points = simplifyRoutePoints(rawPoints);
        if (
          points.length < 2 ||
          points
            .slice(1)
            .some((point, index) =>
              orthogonalSegmentBlocked(points[index]!, point, input.obstacles),
            )
        ) {
          continue;
        }
        const length = points.slice(1).reduce((total, point, index) => {
          const previous = points[index]!;
          return total + Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
        }, 0);
        const cost =
          source.penalty +
          target.penalty +
          length +
          Math.max(0, points.length - 2) * EDGE_ROUTE_BEND_COST;
        const key = points.map(pointKey).join("|");
        if (
          best === null ||
          cost < best.cost ||
          (cost === best.cost && stableCompare(key, best.key) < 0)
        ) {
          best = { cost, key, points };
        }
      }
    }
  }
  return best?.points ?? null;
}

function orthogonalGridRoute(input: {
  sources: readonly WeightedRoutePoint[];
  targets: readonly WeightedRoutePoint[];
  obstacles: readonly StructureBox[];
  channelOffset?: number;
}): StructurePoint[] | null {
  if (input.sources.length === 0 || input.targets.length === 0) return null;
  // Large layouts otherwise rebuild an O(grid vertices × obstacles) visibility graph for every
  // factual Edge. Most layered fan-in/fan-out relations have a clear one-bend route; choose the
  // same shortest-length + bend + port-penalty objective here and retain the complete grid search
  // for routes that actually need to navigate around multiple cards.
  if (input.obstacles.length >= 64) {
    const simple = simpleOrthogonalGridRoute({
      ...input,
      channelOffset: Math.max(0, input.channelOffset ?? 0),
    });
    if (simple) return simple;
  }
  const terminals = [...input.sources, ...input.targets];
  const outerBounds = mergedBounds([
    ...input.obstacles,
    ...terminals.map(({ point }) => ({
      left: point.x,
      top: point.y,
      right: point.x,
      bottom: point.y,
    })),
  ]);
  if (!outerBounds) return null;
  const channelOffset = Math.max(0, input.channelOffset ?? 0);
  const xValues = [
    outerBounds.left - EDGE_ROUTE_OUTER_GUTTER - channelOffset,
    outerBounds.right + EDGE_ROUTE_OUTER_GUTTER + channelOffset,
    ...input.obstacles.flatMap((box) => [box.left - channelOffset, box.right + channelOffset]),
    ...terminals.map(({ point }) => point.x),
  ].sort((left, right) => left - right);
  const yValues = [
    outerBounds.top - EDGE_ROUTE_OUTER_GUTTER - channelOffset,
    outerBounds.bottom + EDGE_ROUTE_OUTER_GUTTER + channelOffset,
    ...input.obstacles.flatMap((box) => [box.top - channelOffset, box.bottom + channelOffset]),
    ...terminals.map(({ point }) => point.y),
  ].sort((left, right) => left - right);
  const distinctX = [...new Set(xValues)];
  const distinctY = [...new Set(yValues)];
  const points = new Map<string, StructurePoint>();
  for (const y of distinctY) {
    for (const x of distinctX) {
      const point = { x, y };
      if (input.obstacles.some((box) => pointInsideBox(point, box))) continue;
      points.set(pointKey(point), point);
    }
  }
  const neighbors = new Map<string, Set<string>>(
    [...points.keys()].map((key) => [key, new Set<string>()]),
  );
  const connect = (left: StructurePoint, right: StructurePoint): void => {
    if (orthogonalSegmentBlocked(left, right, input.obstacles)) return;
    const leftKey = pointKey(left);
    const rightKey = pointKey(right);
    neighbors.get(leftKey)?.add(rightKey);
    neighbors.get(rightKey)?.add(leftKey);
  };
  for (const y of distinctY) {
    let previous: StructurePoint | null = null;
    for (const x of distinctX) {
      const point = points.get(pointKey({ x, y }));
      if (!point) continue;
      if (previous) connect(previous, point);
      previous = point;
    }
  }
  for (const x of distinctX) {
    let previous: StructurePoint | null = null;
    for (const y of distinctY) {
      const point = points.get(pointKey({ x, y }));
      if (!point) continue;
      if (previous) connect(previous, point);
      previous = point;
    }
  }
  const targetPenalty = new Map<string, number>();
  for (const { point, penalty } of input.targets) {
    const key = pointKey(point);
    targetPenalty.set(key, Math.min(penalty, targetPenalty.get(key) ?? Number.POSITIVE_INFINITY));
  }
  const queue: RouteQueueEntry[] = [];
  const distances = new Map<string, number>();
  const previousStates = new Map<string, string | null>();
  for (const { point, penalty } of input.sources) {
    const vertexKey = pointKey(point);
    if (!points.has(vertexKey)) continue;
    const stateKey = `${vertexKey}|start`;
    const cost = penalty;
    if (cost >= (distances.get(stateKey) ?? Number.POSITIVE_INFINITY)) continue;
    distances.set(stateKey, cost);
    previousStates.set(stateKey, null);
    pushRouteQueue(queue, { stateKey, vertexKey, direction: "start", cost });
  }
  let bestGoal: RouteQueueEntry | null = null;
  let bestGoalCost = Number.POSITIVE_INFINITY;
  while (queue.length > 0) {
    const current = popRouteQueue(queue)!;
    if (current.cost !== distances.get(current.stateKey)) continue;
    if (current.cost > bestGoalCost) break;
    const goalPenalty = targetPenalty.get(current.vertexKey);
    if (goalPenalty !== undefined) {
      const total = current.cost + goalPenalty;
      if (
        total < bestGoalCost ||
        (total === bestGoalCost &&
          (!bestGoal || stableCompare(current.stateKey, bestGoal.stateKey) < 0))
      ) {
        bestGoal = current;
        bestGoalCost = total;
      }
    }
    const currentPoint = points.get(current.vertexKey)!;
    for (const neighborKey of [...(neighbors.get(current.vertexKey) ?? [])].sort(stableCompare)) {
      const neighbor = points.get(neighborKey)!;
      const direction: RouteDirection = currentPoint.x === neighbor.x ? "vertical" : "horizontal";
      const distance =
        Math.abs(currentPoint.x - neighbor.x) + Math.abs(currentPoint.y - neighbor.y);
      const bend =
        current.direction === "start" || current.direction === direction ? 0 : EDGE_ROUTE_BEND_COST;
      const cost = current.cost + distance + bend;
      const stateKey = `${neighborKey}|${direction}`;
      if (cost >= (distances.get(stateKey) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(stateKey, cost);
      previousStates.set(stateKey, current.stateKey);
      pushRouteQueue(queue, { stateKey, vertexKey: neighborKey, direction, cost });
    }
  }
  if (!bestGoal) return null;
  const reversed: StructurePoint[] = [];
  for (let stateKey: string | null = bestGoal.stateKey; stateKey !== null;) {
    const separator = stateKey.lastIndexOf("|");
    const vertexKey = stateKey.slice(0, separator);
    reversed.push(points.get(vertexKey)!);
    stateKey = previousStates.get(stateKey) ?? null;
  }
  return simplifyRoutePoints(reversed.reverse());
}

function orthogonalObstacleRoute(input: {
  from: StructurePoint;
  to: StructurePoint;
  fromBox: StructureBox;
  toBox: StructureBox;
  obstacles: readonly StructureBox[];
  portOffsets: EdgeRoutePortOffsets;
  fromNotation: StructureNode["notation"];
  toNotation: StructureNode["notation"];
  channelOffset?: number;
}): StructurePoint[] | null {
  const preferredSource = preferredRouteSide(input.from, input.to);
  const preferredTarget = preferredRouteSide(input.to, input.from);
  // Channel separation belongs to the shared routing grid. Extending an endpoint stub by the
  // channel offset can make that stub jump through an unrelated card before it reaches the grid.
  const sourcePortClearance = EDGE_NODE_CLEARANCE;
  const targetPortClearance = EDGE_ARROW_TERMINAL_STUB;
  const sourcePorts = routePorts(
    input.fromBox,
    input.portOffsets.from,
    sourcePortClearance,
    input.fromNotation,
  );
  const targetPorts = routePorts(
    input.toBox,
    input.portOffsets.to,
    targetPortClearance,
    input.toNotation,
  );
  const routed = orthogonalGridRoute({
    sources: sourcePorts.map(({ point, side }) => ({
      point,
      penalty: routeSidePenalty(side, preferredSource),
    })),
    targets: targetPorts.map(({ point, side }) => ({
      point,
      penalty: routeSidePenalty(side, preferredTarget),
    })),
    obstacles: input.obstacles,
    ...(input.channelOffset === undefined ? {} : { channelOffset: input.channelOffset }),
  });
  if (!routed) return null;
  const first = routed[0]!;
  const last = routed.at(-1)!;
  const sourcePort = sourcePorts.find(({ point }) => pointKey(point) === pointKey(first));
  const targetPort = targetPorts.find(({ point }) => pointKey(point) === pointKey(last));
  if (!sourcePort || !targetPort) return null;
  return simplifyRoutePoints([sourcePort.boundaryPoint, ...routed, targetPort.boundaryPoint]);
}

interface OrthogonalRouteSegment {
  orientation: "horizontal" | "vertical";
  fixed: number;
  minimum: number;
  maximum: number;
}

function orthogonalRouteSegments(
  geometry: StructureEdgeGeometry,
): readonly OrthogonalRouteSegment[] {
  return geometry.points.slice(1).flatMap<OrthogonalRouteSegment>((point, index) => {
    const previous = geometry.points[index]!;
    if (previous.y === point.y && previous.x !== point.x) {
      return [
        {
          orientation: "horizontal" as const,
          fixed: point.y,
          minimum: Math.min(previous.x, point.x),
          maximum: Math.max(previous.x, point.x),
        },
      ];
    }
    if (previous.x === point.x && previous.y !== point.y) {
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
}

function routesShareLongLane(left: StructureEdgeGeometry, right: StructureEdgeGeometry): boolean {
  const minimumSharedLength = 48;
  const nearLaneDistance = 4;
  return orthogonalRouteSegments(left).some((leftSegment) =>
    orthogonalRouteSegments(right).some((rightSegment) => {
      if (leftSegment.orientation !== rightSegment.orientation) return false;
      if (Math.abs(leftSegment.fixed - rightSegment.fixed) > nearLaneDistance) return false;
      return (
        Math.min(leftSegment.maximum, rightSegment.maximum) -
          Math.max(leftSegment.minimum, rightSegment.minimum) >=
        minimumSharedLength
      );
    }),
  );
}

function routeConflictComponents(
  edgeIds: readonly string[],
  geometries: ReadonlyMap<string, StructureEdgeGeometry>,
): string[][] {
  const neighbors = new Map(edgeIds.map((edgeId) => [edgeId, new Set<string>()]));
  for (let leftIndex = 0; leftIndex < edgeIds.length; leftIndex += 1) {
    const leftId = edgeIds[leftIndex]!;
    const left = geometries.get(leftId);
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < edgeIds.length; rightIndex += 1) {
      const rightId = edgeIds[rightIndex]!;
      const right = geometries.get(rightId);
      if (!right || !routesShareLongLane(left, right)) continue;
      neighbors.get(leftId)!.add(rightId);
      neighbors.get(rightId)!.add(leftId);
    }
  }
  const components: string[][] = [];
  const seen = new Set<string>();
  for (const first of edgeIds) {
    if (seen.has(first) || neighbors.get(first)?.size === 0) continue;
    const component: string[] = [];
    const queue = [first];
    seen.add(first);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      component.push(current);
      for (const neighbor of [...(neighbors.get(current) ?? [])].sort(stableCompare)) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component.sort(stableCompare));
  }
  return components;
}

function selfLoopGeometry(input: {
  point: StructurePoint;
  notation: StructureNode["notation"];
  laneOffset: number;
  obstacles: readonly StructureBox[];
}): StructureEdgeGeometry | null {
  const { point, notation, laneOffset, obstacles } = input;
  const left = point.x;
  const right = point.x + STRUCTURE_NODE_WIDTH;
  const top = point.y;
  const bottom = point.y + STRUCTURE_NODE_HEIGHT;
  const shift = laneOffset * 0.55;
  const clampX = (value: number): number => Math.max(left + 16, Math.min(right - 16, value));
  const clampY = (value: number): number => Math.max(top + 16, Math.min(bottom - 16, value));
  for (let reachStep = 0; reachStep < 12; reachStep += 1) {
    const reach = 88 + Math.abs(laneOffset) * 2 + reachStep * 72;
    const box = { left, right, top, bottom };
    const rightStart = visibleNodeBoundaryPoint(
      box,
      "right",
      { x: right, y: clampY(top + 32 + shift) },
      notation,
    );
    const rightEnd = visibleNodeBoundaryPoint(
      box,
      "right",
      { x: right, y: clampY(bottom - 32 + shift) },
      notation,
    );
    const leftStart = visibleNodeBoundaryPoint(
      box,
      "left",
      { x: left, y: clampY(bottom - 32 - shift) },
      notation,
    );
    const leftEnd = visibleNodeBoundaryPoint(
      box,
      "left",
      { x: left, y: clampY(top + 32 - shift) },
      notation,
    );
    const topStart = visibleNodeBoundaryPoint(
      box,
      "top",
      { x: clampX(left + 48 + shift), y: top },
      notation,
    );
    const topEnd = visibleNodeBoundaryPoint(
      box,
      "top",
      { x: clampX(right - 48 + shift), y: top },
      notation,
    );
    const bottomStart = visibleNodeBoundaryPoint(
      box,
      "bottom",
      { x: clampX(right - 48 - shift), y: bottom },
      notation,
    );
    const bottomEnd = visibleNodeBoundaryPoint(
      box,
      "bottom",
      { x: clampX(left + 48 - shift), y: bottom },
      notation,
    );
    const candidates = [
      stubbedCubicGeometry({
        boundaryStart: rightStart,
        start: { x: right + EDGE_ARROW_TERMINAL_STUB, y: rightStart.y },
        control1: { x: right + reach, y: top - 64 + shift },
        control2: { x: right + reach, y: bottom + 64 + shift },
        end: { x: right + EDGE_ARROW_TERMINAL_STUB, y: rightEnd.y },
        boundaryEnd: rightEnd,
      }),
      stubbedCubicGeometry({
        boundaryStart: leftStart,
        start: { x: left - EDGE_ARROW_TERMINAL_STUB, y: leftStart.y },
        control1: { x: left - reach, y: bottom + 64 - shift },
        control2: { x: left - reach, y: top - 64 - shift },
        end: { x: left - EDGE_ARROW_TERMINAL_STUB, y: leftEnd.y },
        boundaryEnd: leftEnd,
      }),
      stubbedCubicGeometry({
        boundaryStart: topStart,
        start: { x: topStart.x, y: top - EDGE_ARROW_TERMINAL_STUB },
        control1: { x: left - 72 + shift, y: top - reach },
        control2: { x: right + 72 + shift, y: top - reach },
        end: { x: topEnd.x, y: top - EDGE_ARROW_TERMINAL_STUB },
        boundaryEnd: topEnd,
      }),
      stubbedCubicGeometry({
        boundaryStart: bottomStart,
        start: { x: bottomStart.x, y: bottom + EDGE_ARROW_TERMINAL_STUB },
        control1: { x: right + 72 - shift, y: bottom + reach },
        control2: { x: left - 72 - shift, y: bottom + reach },
        end: { x: bottomEnd.x, y: bottom + EDGE_ARROW_TERMINAL_STUB },
        boundaryEnd: bottomEnd,
      }),
    ];
    const available = candidates.find(
      (candidate) => !routeIntersectsBoxes(candidate.points, obstacles),
    );
    if (available) return available;
  }
  return null;
}

/**
 * Computes artifact-stable routes against the complete positioned graph. Callers may filter the
 * returned map for a current lens, but must not route only the visible subset.
 */
export function routeStructureEdges(
  edges: readonly StructureEdge[],
  nodes: readonly StructureNode[],
  positions: Readonly<Record<string, StructurePoint>>,
): ReadonlyMap<string, StructureEdgeGeometry> {
  const routeOffsets = structureEdgeRouteOffsets(edges);
  const portOffsets = structureEdgePortOffsets(edges, positions);
  const nodeNotations = new Map(nodes.map((node) => [node.id, node.notation]));
  const reciprocalEdgeIds = reciprocalStructureEdgeIds(edges);
  const actualBoxByNodeId = new Map(
    nodes.flatMap((node) => {
      const point = positions[node.id];
      return point ? [[node.id, nodeRouteBox(point, 0)] as const] : [];
    }),
  );
  const obstacleByNodeId = new Map(
    nodes.flatMap((node) => {
      const point = positions[node.id];
      return point ? [[node.id, nodeRouteBox(point)] as const] : [];
    }),
  );
  const result = new Map<string, StructureEdgeGeometry>();
  const obstacleRoutedEdgeIds: string[] = [];
  const stableEdges = [...edges].sort((left, right) => stableCompare(left.id, right.id));
  const obstacleRoute = (edge: StructureEdge, channelOffset = 0): StructureEdgeGeometry | null => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    const fromBox = actualBoxByNodeId.get(edge.from);
    const toBox = actualBoxByNodeId.get(edge.to);
    if (!from || !to || !fromBox || !toBox) return null;
    const viableObstacles = [...obstacleByNodeId]
      .filter(([nodeId]) => {
        if (nodeId === edge.from || nodeId === edge.to) return true;
        const actualBox = actualBoxByNodeId.get(nodeId);
        // A manually dragged Node may overlap an endpoint. There is then no route that can both
        // attach to the endpoint boundary and avoid that Node; retaining it as an obstacle would
        // silently drop the factual Edge. Keep the route complete and let the overlapping cards
        // communicate the impossible session geometry until the reviewer moves one of them.
        return actualBox
          ? !boxesOverlap(actualBox, fromBox) && !boxesOverlap(actualBox, toBox)
          : true;
      })
      .map(([, box]) => box);
    const points = orthogonalObstacleRoute({
      from: {
        x: from.x + STRUCTURE_NODE_WIDTH / 2,
        y: from.y + STRUCTURE_NODE_HEIGHT / 2,
      },
      to: {
        x: to.x + STRUCTURE_NODE_WIDTH / 2,
        y: to.y + STRUCTURE_NODE_HEIGHT / 2,
      },
      fromBox,
      toBox,
      obstacles: viableObstacles,
      portOffsets: portOffsets.get(edge.id) ?? {
        from: { left: 0, right: 0, top: 0, bottom: 0 },
        to: { left: 0, right: 0, top: 0, bottom: 0 },
      },
      fromNotation: nodeNotations.get(edge.from) ?? "plain",
      toNotation: nodeNotations.get(edge.to) ?? "plain",
      channelOffset,
    });
    return points ? polylineGeometry(points) : null;
  };
  for (const edge of stableEdges) {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) continue;
    const otherObstacles = [...obstacleByNodeId]
      .filter(([nodeId]) => {
        if (nodeId === edge.from || nodeId === edge.to) return false;
        const actualBox = actualBoxByNodeId.get(nodeId);
        const fromBox = actualBoxByNodeId.get(edge.from);
        const toBox = actualBoxByNodeId.get(edge.to);
        return actualBox && fromBox && toBox
          ? !boxesOverlap(actualBox, fromBox) && !boxesOverlap(actualBox, toBox)
          : true;
      })
      .map(([, box]) => box);
    const rawLaneOffset = routeOffsets.get(edge.id) ?? 0;
    if (edge.from === edge.to) {
      const geometry = selfLoopGeometry({
        point: from,
        notation: nodeNotations.get(edge.from) ?? "plain",
        laneOffset: rawLaneOffset,
        obstacles: otherObstacles,
      });
      if (geometry) result.set(edge.id, geometry);
      continue;
    }
    const direct = directEdgeGeometry(
      edge,
      positions,
      rawLaneOffset,
      reciprocalEdgeIds.has(edge.id),
      portOffsets.get(edge.id),
      nodeNotations,
    );
    if (
      direct &&
      !boxesOverlap(obstacleByNodeId.get(edge.from)!, obstacleByNodeId.get(edge.to)!) &&
      !routeIntersectsBoxes(direct.points, otherObstacles)
    ) {
      result.set(edge.id, direct);
      continue;
    }
    const geometry = obstacleRoute(edge);
    if (geometry) result.set(edge.id, geometry);
    obstacleRoutedEdgeIds.push(edge.id);
  }

  const obstacleRouteIndex = new Map(
    [...obstacleRoutedEdgeIds].sort(stableCompare).map((edgeId, index) => [edgeId, index]),
  );
  const edgeById = new Map(stableEdges.map((edge) => [edge.id, edge]));
  for (let pass = 0; pass < Math.min(8, obstacleRoutedEdgeIds.length); pass += 1) {
    const conflicts = routeConflictComponents(obstacleRoutedEdgeIds, result);
    if (conflicts.length === 0) break;
    for (const component of conflicts) {
      component.forEach((edgeId) => {
        const edge = edgeById.get(edgeId)!;
        const channelIndex = obstacleRouteIndex.get(edgeId)!;
        const geometry = obstacleRoute(edge, (channelIndex + 1) * 8);
        if (geometry) result.set(edgeId, geometry);
      });
    }
  }
  return result;
}

interface StructureEdgeLabelRouteSample {
  point: StructurePoint;
  routePoint: StructurePoint;
  tangent: StructurePoint;
  fraction: number;
  normalOffset: number;
}

function curveLabelCandidate(
  geometry: StructureEdgeGeometry,
  fraction: number,
  offset: number,
): StructureEdgeLabelRouteSample {
  const segments = geometry.points.slice(1).map((point, index) => {
    const previous = geometry.points[index]!;
    return {
      previous,
      point,
      length: Math.hypot(point.x - previous.x, point.y - previous.y),
    };
  });
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  let remaining = totalLength * fraction;
  const segment =
    segments.find((candidate) => {
      if (remaining <= candidate.length) return true;
      remaining -= candidate.length;
      return false;
    }) ?? segments.at(-1);
  if (!segment) {
    const routePoint = { x: geometry.startX, y: geometry.startY };
    return {
      point: routePoint,
      routePoint,
      tangent: { x: 1, y: 0 },
      fraction,
      normalOffset: offset,
    };
  }
  const segmentFraction = segment.length === 0 ? 0 : Math.min(1, remaining / segment.length);
  const x = segment.previous.x + (segment.point.x - segment.previous.x) * segmentFraction;
  const y = segment.previous.y + (segment.point.y - segment.previous.y) * segmentFraction;
  const tangentX = segment.point.x - segment.previous.x;
  const tangentY = segment.point.y - segment.previous.y;
  const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
  const tangent = { x: tangentX / tangentLength, y: tangentY / tangentLength };
  const routePoint = { x, y };
  return {
    point: {
      x: x + -tangent.y * offset,
      y: y + tangent.x * offset,
    },
    routePoint,
    tangent,
    fraction,
    normalOffset: offset,
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

function expandedBox(box: StructureBox, padding: number): StructureBox {
  return {
    left: box.left - padding,
    top: box.top - padding,
    right: box.right + padding,
    bottom: box.bottom + padding,
  };
}

function pointToBoxDistance(point: StructurePoint, box: StructureBox): number {
  const deltaX = Math.max(box.left - point.x, 0, point.x - box.right);
  const deltaY = Math.max(box.top - point.y, 0, point.y - box.bottom);
  return Math.hypot(deltaX, deltaY);
}

function pointToSegmentDistance(
  point: StructurePoint,
  start: StructurePoint,
  end: StructurePoint,
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const fraction = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared),
  );
  return Math.hypot(
    point.x - (start.x + deltaX * fraction),
    point.y - (start.y + deltaY * fraction),
  );
}

function boxToSegmentDistance(
  box: StructureBox,
  start: StructurePoint,
  end: StructurePoint,
): number {
  if (segmentIntersectsBox(start, end, box)) return 0;
  const corners = [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ];
  return Math.min(
    pointToBoxDistance(start, box),
    pointToBoxDistance(end, box),
    ...corners.map((corner) => pointToSegmentDistance(corner, start, end)),
  );
}

function boxToPolylineDistance(box: StructureBox, points: readonly StructurePoint[]): number {
  if (points.length < 2) return Number.POSITIVE_INFINITY;
  return Math.min(
    ...points.slice(1).map((end, index) => boxToSegmentDistance(box, points[index]!, end)),
  );
}

interface IndexedStructureSegment {
  ownerId: string;
  start: StructurePoint;
  end: StructurePoint;
}

interface StructureSegmentIndex {
  addPolyline: (ownerId: string, points: readonly StructurePoint[]) => void;
  query: (bounds: StructureBox) => readonly IndexedStructureSegment[];
}

function segmentBounds(start: StructurePoint, end: StructurePoint, padding = 0): StructureBox {
  return {
    left: Math.min(start.x, end.x) - padding,
    top: Math.min(start.y, end.y) - padding,
    right: Math.max(start.x, end.x) + padding,
    bottom: Math.max(start.y, end.y) + padding,
  };
}

function segmentIndexCellKeys(bounds: StructureBox): string[] {
  const keys: string[] = [];
  const left = Math.floor(bounds.left / EDGE_LABEL_SEGMENT_INDEX_CELL_SIZE);
  const right = Math.floor(bounds.right / EDGE_LABEL_SEGMENT_INDEX_CELL_SIZE);
  const top = Math.floor(bounds.top / EDGE_LABEL_SEGMENT_INDEX_CELL_SIZE);
  const bottom = Math.floor(bounds.bottom / EDGE_LABEL_SEGMENT_INDEX_CELL_SIZE);
  for (let x = left; x <= right; x += 1) {
    for (let y = top; y <= bottom; y += 1) keys.push(`${x}:${y}`);
  }
  return keys;
}

function createStructureSegmentIndex(): StructureSegmentIndex {
  const cells = new Map<string, IndexedStructureSegment[]>();
  return {
    addPolyline(ownerId, points) {
      points.slice(1).forEach((end, index) => {
        const start = points[index]!;
        if (start.x === end.x && start.y === end.y) return;
        const segment = { ownerId, start, end };
        for (const key of segmentIndexCellKeys(segmentBounds(start, end))) {
          const cell = cells.get(key) ?? [];
          cell.push(segment);
          cells.set(key, cell);
        }
      });
    },
    query(bounds) {
      const result = new Set<IndexedStructureSegment>();
      for (const key of segmentIndexCellKeys(bounds)) {
        for (const segment of cells.get(key) ?? []) result.add(segment);
      }
      return [...result];
    },
  };
}

interface StructureParallelOverlapInterval {
  start: number;
  end: number;
}

function segmentNearParallelOverlapInterval(
  leftStart: StructurePoint,
  leftEnd: StructurePoint,
  rightStart: StructurePoint,
  rightEnd: StructurePoint,
): StructureParallelOverlapInterval | null {
  const leftDelta = { x: leftEnd.x - leftStart.x, y: leftEnd.y - leftStart.y };
  const rightDelta = { x: rightEnd.x - rightStart.x, y: rightEnd.y - rightStart.y };
  const leftLength = Math.hypot(leftDelta.x, leftDelta.y);
  const rightLength = Math.hypot(rightDelta.x, rightDelta.y);
  if (leftLength === 0 || rightLength === 0) return null;
  const sine =
    Math.abs(leftDelta.x * rightDelta.y - leftDelta.y * rightDelta.x) / (leftLength * rightLength);
  if (sine > 0.17) return null;
  const separation = Math.min(
    pointToSegmentDistance(leftStart, rightStart, rightEnd),
    pointToSegmentDistance(leftEnd, rightStart, rightEnd),
    pointToSegmentDistance(rightStart, leftStart, leftEnd),
    pointToSegmentDistance(rightEnd, leftStart, leftEnd),
  );
  if (separation > EDGE_LABEL_LEADER_NEAR_PARALLEL_DISTANCE) return null;
  const axis = { x: leftDelta.x / leftLength, y: leftDelta.y / leftLength };
  const project = (point: StructurePoint): number =>
    (point.x - leftStart.x) * axis.x + (point.y - leftStart.y) * axis.y;
  const rightFirst = project(rightStart);
  const rightSecond = project(rightEnd);
  const start = Math.max(0, Math.min(rightFirst, rightSecond));
  const end = Math.min(leftLength, Math.max(rightFirst, rightSecond));
  return end > start ? { start, end } : null;
}

function maximumContinuousParallelOverlap(
  overlapGroups: ReadonlyMap<string, readonly StructureParallelOverlapInterval[]>,
): number {
  let maximum = 0;
  for (const intervals of overlapGroups.values()) {
    const ordered = [...intervals].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    let mergedStart: number | null = null;
    let mergedEnd: number | null = null;
    for (const interval of ordered) {
      if (mergedStart === null || mergedEnd === null) {
        mergedStart = interval.start;
        mergedEnd = interval.end;
        continue;
      }
      if (interval.start <= mergedEnd + 0.001) {
        mergedEnd = Math.max(mergedEnd, interval.end);
        continue;
      }
      maximum = Math.max(maximum, mergedEnd - mergedStart);
      mergedStart = interval.start;
      mergedEnd = interval.end;
    }
    if (mergedStart !== null && mergedEnd !== null) {
      maximum = Math.max(maximum, mergedEnd - mergedStart);
    }
  }
  return maximum;
}

function segmentsProperlyCross(
  leftStart: StructurePoint,
  leftEnd: StructurePoint,
  rightStart: StructurePoint,
  rightEnd: StructurePoint,
): boolean {
  const orientation = (
    first: StructurePoint,
    second: StructurePoint,
    third: StructurePoint,
  ): number =>
    (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  const epsilon = 0.000_001;
  const first = orientation(leftStart, leftEnd, rightStart);
  const second = orientation(leftStart, leftEnd, rightEnd);
  const third = orientation(rightStart, rightEnd, leftStart);
  const fourth = orientation(rightStart, rightEnd, leftEnd);
  return first * second < -epsilon && third * fourth < -epsilon;
}

function polylineLength(points: readonly StructurePoint[]): number {
  return points.slice(1).reduce((total, point, index) => {
    const previous = points[index]!;
    return total + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0);
}

interface StructureLeaderGeometryDiagnostics {
  length: number;
  maxParallelOverlap: number;
  crossingCount: number;
}

function leaderGeometryDiagnostics(
  points: readonly StructurePoint[],
  routeSegments: StructureSegmentIndex,
  leaderSegments: StructureSegmentIndex,
): StructureLeaderGeometryDiagnostics {
  const overlapGroups = new Map<string, StructureParallelOverlapInterval[]>();
  let crossingCount = 0;
  let leaderOffset = 0;
  points.slice(1).forEach((end, index) => {
    const start = points[index]!;
    const bounds = segmentBounds(start, end, EDGE_LABEL_LEADER_NEAR_PARALLEL_DISTANCE);
    const addDiagnostics = (
      segment: IndexedStructureSegment,
      comparisonKind: "route" | "leader",
    ): void => {
      const overlap = segmentNearParallelOverlapInterval(start, end, segment.start, segment.end);
      if (overlap) {
        const key = `${comparisonKind}:${segment.ownerId}`;
        const intervals = overlapGroups.get(key) ?? [];
        intervals.push({ start: leaderOffset + overlap.start, end: leaderOffset + overlap.end });
        overlapGroups.set(key, intervals);
      }
      if (segmentsProperlyCross(start, end, segment.start, segment.end)) crossingCount += 1;
    };
    for (const segment of routeSegments.query(bounds)) addDiagnostics(segment, "route");
    for (const segment of leaderSegments.query(bounds)) addDiagnostics(segment, "leader");
    leaderOffset += Math.hypot(end.x - start.x, end.y - start.y);
  });
  return {
    length: leaderOffset,
    maxParallelOverlap: maximumContinuousParallelOverlap(overlapGroups),
    crossingCount,
  };
}

export function structurePolylineNearParallelOverlap(
  reference: readonly StructurePoint[],
  comparison: readonly StructurePoint[],
): number {
  const routeSegments = createStructureSegmentIndex();
  routeSegments.addPolyline("comparison", comparison);
  return leaderGeometryDiagnostics(reference, routeSegments, createStructureSegmentIndex())
    .maxParallelOverlap;
}

function labelBoundaryPointToward(box: StructureBox, toward: StructurePoint): StructurePoint {
  const center = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  const deltaX = toward.x - center.x;
  const deltaY = toward.y - center.y;
  if (deltaX === 0 && deltaY === 0) return { x: center.x, y: box.top };
  const halfWidth = Math.max(1, (box.right - box.left) / 2);
  const halfHeight = Math.max(1, (box.bottom - box.top) / 2);
  const scale = 1 / Math.max(Math.abs(deltaX) / halfWidth, Math.abs(deltaY) / halfHeight);
  return { x: center.x + deltaX * scale, y: center.y + deltaY * scale };
}

function labelBoundaryPorts(box: StructureBox): StructurePoint[] {
  const centerX = (box.left + box.right) / 2;
  const centerY = (box.top + box.bottom) / 2;
  return [
    { x: box.left, y: centerY },
    { x: box.right, y: centerY },
    { x: centerX, y: box.top },
    { x: centerX, y: box.bottom },
  ];
}

interface StructureLabelLeaderChoice extends StructureLeaderGeometryDiagnostics {
  points: readonly StructurePoint[];
}

function leaderFullGridVertexEstimate(input: {
  sources: readonly WeightedRoutePoint[];
  targets: readonly WeightedRoutePoint[];
  obstacles: readonly StructureBox[];
}): number {
  const xValues = new Set([
    ...input.obstacles.flatMap((box) => [box.left, box.right]),
    ...input.sources.map(({ point }) => point.x),
    ...input.targets.map(({ point }) => point.x),
  ]);
  const yValues = new Set([
    ...input.obstacles.flatMap((box) => [box.top, box.bottom]),
    ...input.sources.map(({ point }) => point.y),
    ...input.targets.map(({ point }) => point.y),
  ]);
  return xValues.size * yValues.size;
}

function labelLeaderPoints(input: {
  routePoint: StructurePoint;
  routeTangent: StructurePoint;
  label: StructureBox;
  obstacles: readonly StructureBox[];
  routeSegments: StructureSegmentIndex;
  leaderSegments: StructureSegmentIndex;
  targetPorts?: readonly StructurePoint[];
  allowOuterRoute?: boolean;
  fullGridVertexLimit?: number;
}): StructureLabelLeaderChoice | null {
  if (input.obstacles.some((box) => pointInsideBox(input.routePoint, box))) return null;
  const normal = { x: -input.routeTangent.y, y: input.routeTangent.x };
  const labelCenter = {
    x: (input.label.left + input.label.right) / 2,
    y: (input.label.top + input.label.bottom) / 2,
  };
  const normalTowardLabel =
    (labelCenter.x - input.routePoint.x) * normal.x +
      (labelCenter.y - input.routePoint.y) * normal.y >=
    0
      ? 1
      : -1;
  const targetPorts = input.targetPorts ?? labelBoundaryPorts(input.label);
  const directTarget = input.targetPorts
    ? [...targetPorts].sort(
        (left, right) =>
          Math.hypot(left.x - input.routePoint.x, left.y - input.routePoint.y) -
            Math.hypot(right.x - input.routePoint.x, right.y - input.routePoint.y) ||
          stableCompare(pointKey(left), pointKey(right)),
      )[0]!
    : labelBoundaryPointToward(input.label, input.routePoint);
  const directDistance = Math.hypot(
    directTarget.x - input.routePoint.x,
    directTarget.y - input.routePoint.y,
  );
  const kickoffDistance = Math.min(EDGE_LABEL_LEADER_KICKOFF, Math.max(2, directDistance * 0.45));
  const directCandidates: StructurePoint[][] = [];
  const routingStarts: StructurePoint[] = [];
  for (const direction of [normalTowardLabel, -normalTowardLabel]) {
    const kickoff = {
      x: input.routePoint.x + normal.x * kickoffDistance * direction,
      y: input.routePoint.y + normal.y * kickoffDistance * direction,
    };
    if (input.obstacles.some((box) => segmentIntersectsBox(input.routePoint, kickoff, box))) {
      continue;
    }
    routingStarts.push(kickoff);
    const target = labelBoundaryPointToward(input.label, kickoff);
    if (!input.obstacles.some((box) => segmentIntersectsBox(kickoff, target, box))) {
      directCandidates.push([input.routePoint, kickoff, target]);
    }
  }
  const evaluate = (rawCandidates: readonly StructurePoint[][]): StructureLabelLeaderChoice[] =>
    [
      ...new Map(
        rawCandidates
          .map((points) => simplifyRoutePoints(points))
          .filter(
            (points) =>
              points.length >= 2 &&
              !points
                .slice(1)
                .some((point, index) =>
                  input.obstacles.some((box) =>
                    segmentIntersectsBox(
                      points[index]!,
                      point,
                      expandedBox(box, -EDGE_LABEL_OBSTACLE_BOUNDARY_TOLERANCE),
                    ),
                  ),
                ),
          )
          .map((points) => [points.map(pointKey).join("|"), points] as const),
      ).values(),
    ].map((points) => ({
      points,
      ...leaderGeometryDiagnostics(points, input.routeSegments, input.leaderSegments),
    }));
  const compare = (left: StructureLabelLeaderChoice, right: StructureLabelLeaderChoice): number => {
    const leftLong = left.maxParallelOverlap >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP;
    const rightLong = right.maxParallelOverlap >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP;
    return (
      Number(leftLong) - Number(rightLong) ||
      left.length + left.crossingCount * 8 - (right.length + right.crossingCount * 8) ||
      left.maxParallelOverlap - right.maxParallelOverlap ||
      left.points.length - right.points.length ||
      stableCompare(left.points.map(pointKey).join("|"), right.points.map(pointKey).join("|"))
    );
  };
  const directChoices = evaluate(directCandidates).sort(compare);
  if (
    directChoices[0] &&
    directChoices[0].maxParallelOverlap < EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP
  ) {
    return directChoices[0];
  }
  const routedCandidates = routingStarts.flatMap((kickoff) => {
    const routeInput = {
      sources: [{ point: kickoff, penalty: 0 }],
      targets: targetPorts.map((point) => ({ point, penalty: 0 })),
      obstacles: [...input.obstacles, input.label],
      channelOffset: 0,
    };
    const routed =
      simpleOrthogonalGridRoute(routeInput) ??
      (input.allowOuterRoute
        ? simpleOrthogonalGridRoute({ ...routeInput, channelOffset: EDGE_LABEL_OUTSIDE_GAP })
        : null) ??
      (leaderFullGridVertexEstimate(routeInput) <=
      (input.fullGridVertexLimit ?? EDGE_LABEL_LEADER_FULL_GRID_VERTEX_LIMIT)
        ? orthogonalGridRoute(routeInput)
        : null);
    return routed ? [[input.routePoint, ...routed]] : [];
  });
  const choices = [...directChoices, ...evaluate(routedCandidates)].sort(compare);
  return choices[0] ?? null;
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
  if (/\s/u.test(character) || /[./_-]/u.test(character) || (character === ":" && next === ":")) {
    return true;
  }
  if (!next || !/[\p{L}\p{N}]/u.test(character) || !/[\p{L}\p{N}]/u.test(next)) return false;
  const isCjk = (value: string): boolean =>
    /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(value);
  return isCjk(character) !== isCjk(next);
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
  _labelMode: StructureEdgeLabelMode,
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
  const displayLines = wrapStructureText({
    text: edge.label,
    maxUnits: contentWidth / 11.5,
    ellipsize: false,
  });
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

interface StructureEdgeSourceMenuReservation {
  placement: StructureEdgeSourceMenuPlacement;
  width: number;
  box: StructureBox;
}

function edgeLabelSourceMenuCollisionBoxes(input: {
  enabled: boolean;
  point: StructurePoint;
  size: ReturnType<typeof edgeLabelSize>;
}): readonly StructureEdgeSourceMenuReservation[] {
  if (
    !input.enabled ||
    input.size.source.anchorCount <= 1 ||
    input.size.boxWidth <= input.size.selectWidth
  ) {
    return [];
  }
  const label = labelBox(input.point.x, input.point.y, input.size.boxWidth, input.size.height);
  const menuHeight = Math.min(
    EDGE_LABEL_SOURCE_MENU_MAX_HEIGHT,
    input.size.source.anchorCount * EDGE_LABEL_SOURCE_MENU_ITEM_HEIGHT +
      Math.max(0, input.size.source.anchorCount - 1) * EDGE_LABEL_SOURCE_MENU_ITEM_GAP +
      EDGE_LABEL_SOURCE_MENU_PADDING * 2 +
      EDGE_LABEL_SOURCE_MENU_BORDER * 2,
  );
  const rightwardLeft = label.right - (input.size.boxWidth - input.size.selectWidth);
  return EDGE_LABEL_SOURCE_MENU_WIDTHS.flatMap((width) =>
    EDGE_LABEL_SOURCE_MENU_PLACEMENTS.map((placement) => {
      const opensRight = placement.endsWith("right");
      const opensBelow = placement.startsWith("below");
      const left = opensRight ? rightwardLeft : label.right - width;
      const belowTop =
        input.point.y + EDGE_LABEL_SOURCE_MENU_ITEM_HEIGHT / 2 + EDGE_LABEL_SOURCE_MENU_OFFSET;
      const aboveBottom =
        input.point.y - EDGE_LABEL_SOURCE_MENU_ITEM_HEIGHT / 2 - EDGE_LABEL_SOURCE_MENU_OFFSET;
      const top = opensBelow ? belowTop : aboveBottom - menuHeight;
      return {
        placement,
        width,
        box: expandedBox(
          {
            left,
            top,
            right: left + width,
            bottom: top + menuHeight,
          },
          EDGE_LABEL_COLLISION_PADDING,
        ),
      };
    }),
  );
}

function boundedOutsideAxisCenters(minimum: number, maximum: number, itemSize: number): number[] {
  const extent = Math.max(0, maximum - minimum);
  if (extent <= itemSize) return [(minimum + maximum) / 2];
  const capacity = Math.max(
    1,
    Math.floor((extent + EDGE_LABEL_OUTSIDE_SLOT_GAP) / (itemSize + EDGE_LABEL_OUTSIDE_SLOT_GAP)),
  );
  const count = Math.min(EDGE_LABEL_OUTSIDE_SLOTS_PER_SIDE_LIMIT, capacity);
  if (count === 1) return [(minimum + maximum) / 2];
  const first = minimum + itemSize / 2;
  const last = maximum - itemSize / 2;
  return Array.from(
    { length: count },
    (_, index) => first + ((last - first) * index) / (count - 1),
  );
}

function edgeLabelAnchorSamples(geometry: StructureEdgeGeometry): StructureEdgeLabelRouteSample[] {
  const length = polylineLength(geometry.points);
  if (length <= 0) return [curveLabelCandidate(geometry, 0.5, 0)];
  const endpointDistance = Math.min(EDGE_LABEL_LEADER_KICKOFF, length / 2);
  const endpointFraction = endpointDistance / length;
  return [endpointFraction, 1 - endpointFraction, ...EDGE_LABEL_CANDIDATE_FRACTIONS]
    .filter((fraction, index, values) => values.indexOf(fraction) === index)
    .map((fraction) => curveLabelCandidate(geometry, fraction, 0));
}

function edgeLabelProximityBand(edgeDistance: number): number {
  if (edgeDistance <= EDGE_LABEL_SHORT_LEADER_GAP) return 0;
  return 1 + Math.floor((edgeDistance - EDGE_LABEL_SHORT_LEADER_GAP) / EDGE_LABEL_SHORT_LEADER_GAP);
}

export function placeEdgeLabels(
  edges: readonly StructureEdge[],
  nodes: readonly StructureNode[],
  positions: Readonly<Record<string, StructurePoint>>,
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>,
  routes: ReadonlyMap<string, StructureEdgeGeometry>,
  labelAccessory: StructureLabelAccessory,
  labelMode: StructureEdgeLabelMode,
): StructureEdgeLabelPlacement[] {
  const nodeIds = new Set(nodes.map(({ id }) => id));
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
  const junctionBoxes = nodeBoxes.map((box) => expandedBox(box, 20));
  const occupiedLabels = new Map<string, StructureBox[]>();
  const occupiedLabelBoxes: StructureBox[] = [];
  const routeSegments = createStructureSegmentIndex();
  const leaderSegments = createStructureSegmentIndex();
  const occupiedLeaderBoxes: StructureBox[] = [];
  let emergencyShelfLeft: number | null = null;
  let emergencyShelfBottom: number | null = null;
  for (const [edgeId, route] of routes) routeSegments.addPolyline(edgeId, route.points);
  const overlapsOccupiedLabel = (box: StructureBox): boolean => {
    const seen = new Set<StructureBox>();
    for (const key of segmentIndexCellKeys(box)) {
      const cell = occupiedLabels.get(key);
      if (!cell) continue;
      for (const occupied of cell) {
        if (seen.has(occupied)) continue;
        seen.add(occupied);
        if (boxesOverlap(box, occupied)) return true;
      }
    }
    return false;
  };
  const occupyLabel = (box: StructureBox): void => {
    occupiedLabelBoxes.push(box);
    for (const key of segmentIndexCellKeys(box)) {
      const cell = occupiedLabels.get(key) ?? [];
      cell.push(box);
      occupiedLabels.set(key, cell);
    }
  };
  const routeIdsIntersectingBox = (box: StructureBox, ownEdgeId: string): Set<string> =>
    new Set(
      routeSegments
        .query(box)
        .filter(
          (segment) =>
            segment.ownerId !== ownEdgeId && segmentIntersectsBox(segment.start, segment.end, box),
        )
        .map(({ ownerId }) => ownerId),
    );
  const leaderIntersectsBox = (box: StructureBox): boolean =>
    leaderSegments
      .query(box)
      .some((segment) => segmentIntersectsBox(segment.start, segment.end, box));
  const placements: StructureEdgeLabelPlacement[] = [];

  const stableEdges = [...edges].sort((left, right) => stableCompare(left.id, right.id));
  for (const edge of stableEdges) {
    const geometry = routes.get(edge.id);
    if (!geometry) continue;
    const naturalSize = edgeLabelSize(edge, sourceChangeKinds, labelAccessory, labelMode);
    const sizes: Array<{
      size: ReturnType<typeof edgeLabelSize>;
      usedCompactWidth: boolean;
    }> = [{ size: naturalSize, usedCompactWidth: false }];
    if (labelMode === "viewer-adaptive") {
      const compactSize = edgeLabelSize(
        edge,
        sourceChangeKinds,
        labelAccessory,
        labelMode,
        EDGE_LABEL_COMPACT_MAX_TEXT_WIDTH,
      );
      if (compactSize.boxWidth < naturalSize.boxWidth) {
        sizes.push({ size: compactSize, usedCompactWidth: true });
      }
    }
    type LabelCandidate = {
      sample: StructureEdgeLabelRouteSample;
      size: ReturnType<typeof edgeLabelSize>;
      box: StructureBox;
      collisionBox: StructureBox;
      edgeDistance: number;
      usedCompactWidth: boolean;
    };
    type LabelChoice = {
      candidate: LabelCandidate;
      displaced: boolean;
      leader: StructureLabelLeaderChoice | null;
      otherRouteIntersections: number;
      associationOverlapCount: number;
      degraded: boolean;
      emergency: boolean;
    };
    const candidates: LabelCandidate[] = sizes.flatMap(({ size, usedCompactWidth }) =>
      EDGE_LABEL_CANDIDATE_OFFSETS.flatMap((offset) =>
        EDGE_LABEL_CANDIDATE_FRACTIONS.map((fraction) => {
          const sample = curveLabelCandidate(geometry, fraction, offset);
          const box = labelBox(sample.point.x, sample.point.y, size.boxWidth, size.height);
          const edgeDistance = boxToPolylineDistance(box, geometry.points);
          return {
            sample,
            size,
            box,
            collisionBox: expandedBox(box, EDGE_LABEL_COLLISION_PADDING),
            edgeDistance,
            usedCompactWidth,
          };
        }),
      ),
    );
    candidates.sort(
      (left, right) =>
        left.edgeDistance - right.edgeDistance ||
        Math.abs(left.sample.normalOffset) - Math.abs(right.sample.normalOffset) ||
        Math.abs(left.sample.fraction - 0.5) - Math.abs(right.sample.fraction - 0.5) ||
        Number(left.usedCompactWidth) - Number(right.usedCompactWidth) ||
        left.size.height - right.size.height ||
        left.sample.point.y - right.sample.point.y ||
        left.sample.point.x - right.sample.point.x,
    );
    const leaderObstacles = [
      ...nodeBoxes.map((box) => expandedBox(box, 4)),
      ...occupiedLabelBoxes.map((box) => expandedBox(box, 2)),
    ];
    const compareChoices = (left: LabelChoice, right: LabelChoice): number =>
      left.associationOverlapCount - right.associationOverlapCount ||
      Number((left.leader?.maxParallelOverlap ?? 0) >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP) -
        Number(
          (right.leader?.maxParallelOverlap ?? 0) >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP,
        ) ||
      (left.leader?.crossingCount ?? 0) - (right.leader?.crossingCount ?? 0) ||
      (left.leader?.maxParallelOverlap ?? 0) - (right.leader?.maxParallelOverlap ?? 0) ||
      left.candidate.edgeDistance - right.candidate.edgeDistance ||
      Math.abs(left.candidate.sample.normalOffset) -
        Math.abs(right.candidate.sample.normalOffset) ||
      Math.abs(left.candidate.sample.fraction - 0.5) -
        Math.abs(right.candidate.sample.fraction - 0.5) ||
      Number(left.candidate.usedCompactWidth) - Number(right.candidate.usedCompactWidth) ||
      left.candidate.sample.point.y - right.candidate.sample.point.y ||
      left.candidate.sample.point.x - right.candidate.sample.point.x;
    let chosen: LabelChoice | undefined;
    let activeProximityBand: number | null = null;
    let bestProximityChoice: LabelChoice | undefined;
    for (const candidate of candidates) {
      const proximityBand = edgeLabelProximityBand(candidate.edgeDistance);
      if (activeProximityBand !== null && proximityBand !== activeProximityBand) {
        chosen = bestProximityChoice;
        if (chosen) break;
      }
      if (activeProximityBand === null || proximityBand !== activeProximityBand) {
        activeProximityBand = proximityBand;
        bestProximityChoice = undefined;
      }
      const collisionBoxes = [candidate.collisionBox];
      if (
        collisionBoxes.some(
          (collisionBox) =>
            junctionBoxes.some((junctionBox) => boxesOverlap(collisionBox, junctionBox)) ||
            overlapsOccupiedLabel(collisionBox) ||
            leaderIntersectsBox(collisionBox),
        )
      ) {
        continue;
      }
      const otherRouteIntersections = routeIdsIntersectingBox(candidate.collisionBox, edge.id).size;
      const associationOverlapCount = otherRouteIntersections;
      const displaced = candidate.edgeDistance > 0.000_001;
      const leader = displaced
        ? labelLeaderPoints({
            routePoint: candidate.sample.routePoint,
            routeTangent: candidate.sample.tangent,
            label: candidate.box,
            obstacles: leaderObstacles,
            routeSegments,
            leaderSegments,
          })
        : null;
      if (displaced && !leader) continue;
      const hasLongLeaderOverlap =
        (leader?.maxParallelOverlap ?? 0) >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP;
      const choice = {
        candidate,
        displaced,
        leader,
        otherRouteIntersections,
        associationOverlapCount,
        degraded: associationOverlapCount > 0 || hasLongLeaderOverlap,
        emergency: false,
      } satisfies LabelChoice;
      if (!bestProximityChoice || compareChoices(choice, bestProximityChoice) < 0) {
        bestProximityChoice = choice;
      }
      // Candidates are distance-sorted. An association-clear placement whose guide has no route
      // crossings or parallel run is already optimal inside this proximity band.
      if (
        !choice.degraded &&
        (choice.leader?.crossingCount ?? 0) === 0 &&
        (choice.leader?.maxParallelOverlap ?? 0) === 0
      ) {
        chosen = choice;
        break;
      }
    }
    chosen ??= bestProximityChoice;
    let outsideDegraded: LabelChoice | undefined;
    const nodeBounds = mergedBounds(junctionBoxes);
    if (!chosen && nodeBounds) {
      const outsideCandidates = sizes.flatMap(({ size, usedCompactWidth }) => {
        const horizontalCenters = boundedOutsideAxisCenters(
          nodeBounds.left,
          nodeBounds.right,
          size.boxWidth,
        );
        const verticalCenters = boundedOutsideAxisCenters(
          nodeBounds.top,
          nodeBounds.bottom,
          size.height,
        );
        const verticalRingStep = size.height + EDGE_LABEL_OUTSIDE_SLOT_GAP;
        const slots = [
          ...Array.from({ length: EDGE_LABEL_OUTSIDE_RING_COUNT }, (_, ring) =>
            horizontalCenters.map((x) => ({
              point: {
                x,
                y:
                  nodeBounds.top -
                  size.height / 2 -
                  EDGE_LABEL_OUTSIDE_GAP -
                  ring * verticalRingStep,
              },
              sideIndex: ring * 4,
            })),
          ).flat(),
          ...Array.from({ length: EDGE_LABEL_OUTSIDE_RING_COUNT }, (_, ring) =>
            horizontalCenters.map((x) => ({
              point: {
                x,
                y:
                  nodeBounds.bottom +
                  size.height / 2 +
                  EDGE_LABEL_OUTSIDE_GAP +
                  ring * verticalRingStep,
              },
              sideIndex: ring * 4 + 1,
            })),
          ).flat(),
          ...verticalCenters.map((y) => ({
            point: {
              x: nodeBounds.left - size.boxWidth / 2 - EDGE_LABEL_OUTSIDE_GAP,
              y,
            },
            sideIndex: 2,
          })),
          ...verticalCenters.map((y) => ({
            point: {
              x: nodeBounds.right + size.boxWidth / 2 + EDGE_LABEL_OUTSIDE_GAP,
              y,
            },
            sideIndex: 3,
          })),
        ];
        const routeSamples = EDGE_LABEL_CANDIDATE_FRACTIONS.map((fraction) =>
          curveLabelCandidate(geometry, fraction, 0),
        );
        return slots.flatMap(({ point, sideIndex }) =>
          [...routeSamples]
            .sort(
              (left, right) =>
                Math.hypot(left.routePoint.x - point.x, left.routePoint.y - point.y) -
                  Math.hypot(right.routePoint.x - point.x, right.routePoint.y - point.y) ||
                Math.abs(left.fraction - 0.5) - Math.abs(right.fraction - 0.5),
            )
            .slice(0, EDGE_LABEL_OUTSIDE_ANCHORS_PER_SLOT)
            .map((routeSample) => {
              const sample = { ...routeSample, point };
              const box = labelBox(point.x, point.y, size.boxWidth, size.height);
              const edgeDistance = boxToPolylineDistance(box, geometry.points);
              return {
                candidate: {
                  sample,
                  size,
                  box,
                  collisionBox: expandedBox(box, EDGE_LABEL_COLLISION_PADDING),
                  edgeDistance,
                  usedCompactWidth,
                } satisfies LabelCandidate,
                sideIndex,
              };
            }),
        );
      });
      outsideCandidates.sort(
        (left, right) =>
          left.candidate.edgeDistance - right.candidate.edgeDistance ||
          Math.abs(left.candidate.sample.fraction - 0.5) -
            Math.abs(right.candidate.sample.fraction - 0.5) ||
          left.sideIndex - right.sideIndex ||
          Number(left.candidate.usedCompactWidth) - Number(right.candidate.usedCompactWidth) ||
          left.candidate.sample.point.y - right.candidate.sample.point.y ||
          left.candidate.sample.point.x - right.candidate.sample.point.x,
      );
      let leaderAttempts = 0;
      for (const { candidate } of outsideCandidates) {
        const collisionBoxes = [candidate.collisionBox];
        if (
          collisionBoxes.some(
            (collisionBox) =>
              junctionBoxes.some((junctionBox) => boxesOverlap(collisionBox, junctionBox)) ||
              overlapsOccupiedLabel(collisionBox) ||
              leaderIntersectsBox(collisionBox),
          )
        ) {
          continue;
        }
        const displaced = candidate.edgeDistance > 0.000_001;
        if (displaced && leaderAttempts >= EDGE_LABEL_OUTSIDE_LEADER_ATTEMPT_LIMIT) break;
        const leader = displaced
          ? labelLeaderPoints({
              routePoint: candidate.sample.routePoint,
              routeTangent: candidate.sample.tangent,
              label: candidate.box,
              obstacles: leaderObstacles,
              routeSegments,
              leaderSegments,
            })
          : null;
        if (displaced) leaderAttempts += 1;
        if (displaced && !leader) continue;
        const otherRouteIntersections = routeIdsIntersectingBox(
          candidate.collisionBox,
          edge.id,
        ).size;
        const associationOverlapCount =
          otherRouteIntersections + Number(leaderIntersectsBox(candidate.collisionBox));
        const hasLongLeaderOverlap =
          (leader?.maxParallelOverlap ?? 0) >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP;
        const choice = {
          candidate,
          displaced,
          leader,
          otherRouteIntersections,
          associationOverlapCount,
          degraded: true,
          emergency: true,
        } satisfies LabelChoice;
        if (associationOverlapCount === 0 && !hasLongLeaderOverlap) {
          chosen = choice;
          break;
        }
        outsideDegraded ??= choice;
      }
    }
    chosen ??= outsideDegraded;
    if (!chosen) {
      const { size, usedCompactWidth } = sizes.at(-1)!;
      const occupiedBounds = mergedBounds([
        ...nodeBoxes,
        ...[...routes.values()].map((route) => route.bounds),
        ...occupiedLabelBoxes,
        ...occupiedLeaderBoxes,
      ])!;
      emergencyShelfLeft ??= occupiedBounds.right + EDGE_LABEL_EMERGENCY_SHELF_GAP;
      const shelfTop = Math.max(
        emergencyShelfBottom ?? occupiedBounds.bottom + EDGE_LABEL_EMERGENCY_SHELF_GAP,
        occupiedBounds.bottom + EDGE_LABEL_EMERGENCY_SHELF_GAP,
      );
      const point = {
        x: emergencyShelfLeft + size.boxWidth / 2,
        y: shelfTop + size.height / 2,
      };
      const box = labelBox(point.x, point.y, size.boxWidth, size.height);
      const collisionBox = expandedBox(box, EDGE_LABEL_COLLISION_PADDING);
      const edgeDistance = boxToPolylineDistance(box, geometry.points);
      const emergencyNodeLeaderObstacles = nodeBoxes.map((nodeBox) => expandedBox(nodeBox, 4));
      const emergencyLabelLeaderObstacles = occupiedLabelBoxes.map((occupied) =>
        expandedBox(occupied, 2),
      );
      const emergencyLeaderObstacles = [
        ...emergencyNodeLeaderObstacles,
        ...emergencyLabelLeaderObstacles,
      ];
      const targetPorts = [{ x: box.left, y: point.y }];
      const emergencyChoices = edgeLabelAnchorSamples(geometry)
        .slice(0, EDGE_LABEL_EMERGENCY_ANCHOR_LIMIT)
        .flatMap<LabelChoice>((routeSample) => {
          const leader = labelLeaderPoints({
            routePoint: routeSample.routePoint,
            routeTangent: routeSample.tangent,
            label: box,
            obstacles: emergencyLeaderObstacles,
            routeSegments,
            leaderSegments,
            targetPorts,
            allowOuterRoute: true,
          });
          if (!leader) return [];
          const otherRouteIntersections = routeIdsIntersectingBox(collisionBox, edge.id).size;
          return [
            {
              candidate: {
                sample: { ...routeSample, point },
                size,
                box,
                collisionBox,
                edgeDistance,
                usedCompactWidth,
              },
              displaced: true,
              leader,
              otherRouteIntersections,
              associationOverlapCount: otherRouteIntersections,
              degraded: true,
              emergency: true,
            },
          ];
        });
      emergencyChoices.sort(
        (left, right) =>
          Number(
            (left.leader?.maxParallelOverlap ?? 0) >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP,
          ) -
            Number(
              (right.leader?.maxParallelOverlap ?? 0) >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP,
            ) ||
          (left.leader?.length ?? 0) +
            (left.leader?.crossingCount ?? 0) * 8 -
            ((right.leader?.length ?? 0) + (right.leader?.crossingCount ?? 0) * 8) ||
          Math.abs(left.candidate.sample.fraction - 0.5) -
            Math.abs(right.candidate.sample.fraction - 0.5) ||
          left.candidate.sample.point.x - right.candidate.sample.point.x,
      );
      chosen = emergencyChoices[0];
      if (!chosen) {
        let routeSample = edgeLabelAnchorSamples(geometry)[0]!;
        // Try every bounded anchor before declaring the obstacle-safe association unavailable.
        // Invalid manual geometry can make the full obstacle set topologically impossible; in
        // that case keep the factual label and surface the least-conflicting direct guide as an
        // emergency diagnostic instead of silently dropping the association.
        let obstacleSafeLeader: StructureLabelLeaderChoice | null = null;
        for (const sample of edgeLabelAnchorSamples(geometry).slice(
          0,
          EDGE_LABEL_EMERGENCY_ANCHOR_LIMIT,
        )) {
          const leader = labelLeaderPoints({
            routePoint: sample.routePoint,
            routeTangent: sample.tangent,
            label: box,
            obstacles: emergencyLeaderObstacles,
            routeSegments,
            leaderSegments,
            targetPorts,
            allowOuterRoute: true,
            fullGridVertexLimit: EDGE_LABEL_EMERGENCY_FULL_GRID_VERTEX_LIMIT,
          });
          if (!leader) continue;
          routeSample = sample;
          obstacleSafeLeader = leader;
          break;
        }
        if (!obstacleSafeLeader) {
          const diagnosedDirectChoices = edgeLabelAnchorSamples(geometry)
            .slice(0, EDGE_LABEL_EMERGENCY_ANCHOR_LIMIT)
            .flatMap((sample) => {
              const normal = { x: -sample.tangent.y, y: sample.tangent.x };
              const towardLabel =
                (point.x - sample.routePoint.x) * normal.x +
                  (point.y - sample.routePoint.y) * normal.y >=
                0
                  ? 1
                  : -1;
              return [towardLabel, -towardLabel].map((direction) => {
                const kickoff = {
                  x: sample.routePoint.x + normal.x * EDGE_LABEL_LEADER_KICKOFF * direction,
                  y: sample.routePoint.y + normal.y * EDGE_LABEL_LEADER_KICKOFF * direction,
                };
                const points = simplifyRoutePoints([sample.routePoint, kickoff, targetPorts[0]!]);
                const obstacleCrossings = (obstacles: readonly StructureBox[]): number =>
                  obstacles.filter((obstacle) =>
                    points
                      .slice(1)
                      .some((end, index) =>
                        segmentIntersectsBox(
                          points[index]!,
                          end,
                          expandedBox(obstacle, -EDGE_LABEL_OBSTACLE_BOUNDARY_TOLERANCE),
                        ),
                      ),
                  ).length;
                return {
                  sample,
                  leader: {
                    points,
                    ...leaderGeometryDiagnostics(points, routeSegments, leaderSegments),
                  } satisfies StructureLabelLeaderChoice,
                  nodeCrossings: obstacleCrossings(emergencyNodeLeaderObstacles),
                  labelCrossings: obstacleCrossings(emergencyLabelLeaderObstacles),
                };
              });
            })
            .sort(
              (left, right) =>
                left.nodeCrossings - right.nodeCrossings ||
                left.labelCrossings - right.labelCrossings ||
                Number(left.leader.maxParallelOverlap >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP) -
                  Number(
                    right.leader.maxParallelOverlap >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP,
                  ) ||
                left.leader.length +
                  left.leader.crossingCount * 8 -
                  (right.leader.length + right.leader.crossingCount * 8) ||
                stableCompare(
                  left.leader.points.map(pointKey).join("|"),
                  right.leader.points.map(pointKey).join("|"),
                ),
            );
          const diagnosedDirect = diagnosedDirectChoices[0];
          if (diagnosedDirect) {
            routeSample = diagnosedDirect.sample;
            obstacleSafeLeader = diagnosedDirect.leader;
          }
        }
        const otherRouteIntersections = routeIdsIntersectingBox(collisionBox, edge.id).size;
        chosen = {
          candidate: {
            sample: { ...routeSample, point },
            size,
            box,
            collisionBox,
            edgeDistance: boxToPolylineDistance(box, geometry.points),
            usedCompactWidth,
          },
          displaced: true,
          leader: obstacleSafeLeader,
          otherRouteIntersections,
          associationOverlapCount:
            otherRouteIntersections + Number(leaderIntersectsBox(collisionBox)),
          degraded: true,
          emergency: true,
        };
      }
      emergencyShelfBottom = chosen.candidate.box.bottom + EDGE_LABEL_EMERGENCY_STACK_GAP;
    }
    occupyLabel(expandedBox(chosen.candidate.box, 4));
    const leaderPoints = chosen.leader ? simplifyRoutePoints(chosen.leader.points) : null;
    if (leaderPoints) {
      leaderSegments.addPolyline(edge.id, leaderPoints);
      occupiedLeaderBoxes.push(expandedBox(geometryBounds(leaderPoints), 3));
    }
    const leaderPath = leaderPoints
      ? `M ${leaderPoints[0]!.x} ${leaderPoints[0]!.y} ${leaderPoints
          .slice(1)
          .map((point) => `L ${point.x} ${point.y}`)
          .join(" ")}`
      : null;
    const fallbackReason: StructureEdgeLabelFallbackReason | null = chosen.emergency
      ? "emergency"
      : chosen.associationOverlapCount > 0
        ? "label-route-overlap"
        : (chosen.leader?.maxParallelOverlap ?? 0) >= EDGE_LABEL_LEADER_LONG_PARALLEL_OVERLAP
          ? "leader-overlap"
          : chosen.candidate.edgeDistance > EDGE_LABEL_SHORT_LEADER_GAP
            ? "distant"
            : null;
    placements.push({
      edge,
      displayLines: chosen.candidate.size.displayLines,
      source: chosen.candidate.size.source,
      x: chosen.candidate.sample.point.x,
      y: chosen.candidate.sample.point.y,
      selectWidth: chosen.candidate.size.selectWidth,
      boxWidth: chosen.candidate.size.boxWidth,
      height: chosen.candidate.size.height,
      crowded: chosen.degraded,
      displaced: chosen.displaced,
      leaderPath,
      leaderBounds: leaderPoints ? expandedBox(geometryBounds(leaderPoints), 3) : null,
      leaderEdgeAnchor: leaderPoints?.[0] ?? null,
      leaderLabelAnchor: leaderPoints?.at(-1) ?? null,
      sourceMenuPlacement: null,
      sourceMenuWidth: null,
      diagnostics: {
        edgeDistance: chosen.candidate.edgeDistance,
        leaderLength: chosen.leader?.length ?? 0,
        maxParallelOverlap: chosen.leader?.maxParallelOverlap ?? 0,
        crossingCount: chosen.leader?.crossingCount ?? 0,
        usedCompactWidth: chosen.candidate.usedCompactWidth,
        spacingPressure:
          fallbackReason !== null || chosen.candidate.edgeDistance > EDGE_LABEL_NEAR_GAP,
        fallbackReason,
      },
    });
  }
  const selectedMenuBoxes: StructureBox[] = [];
  const finalLabelBoxes = new Map(
    placements.map((placement) => [
      placement.edge.id,
      labelBox(placement.x, placement.y, placement.boxWidth, placement.height),
    ]),
  );
  const overlapArea = (left: StructureBox, right: StructureBox): number =>
    Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left)) *
    Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return placements.map((placement) => {
    const reservations = edgeLabelSourceMenuCollisionBoxes({
      enabled: nodeIds.has(placement.edge.from) && nodeIds.has(placement.edge.to),
      point: { x: placement.x, y: placement.y },
      size: placement,
    });
    if (reservations.length === 0) return placement;
    const ranked = reservations
      .map((reservation, preference) => {
        const nodeCollisions = nodeBoxes.filter((box) => boxesOverlap(reservation.box, box));
        const labelCollisions = [...finalLabelBoxes]
          .filter(([edgeId]) => edgeId !== placement.edge.id)
          .map(([, box]) => box)
          .filter((box) => boxesOverlap(reservation.box, box));
        const menuCollisions = selectedMenuBoxes.filter((box) =>
          boxesOverlap(reservation.box, box),
        );
        const leaderCollisionOwners = new Set(
          leaderSegments
            .query(reservation.box)
            .filter((segment) => segmentIntersectsBox(segment.start, segment.end, reservation.box))
            .map(({ ownerId }) => ownerId),
        );
        const routeCollisionOwners = new Set(
          routeSegments
            .query(reservation.box)
            .filter((segment) => segmentIntersectsBox(segment.start, segment.end, reservation.box))
            .map(({ ownerId }) => ownerId),
        );
        const bodyCollisionArea = [...nodeCollisions, ...labelCollisions].reduce(
          (total, box) => total + overlapArea(reservation.box, box),
          0,
        );
        return {
          reservation,
          nodeCollisionCount: nodeCollisions.length,
          labelCollisionCount: labelCollisions.length,
          bodyCollisionArea,
          leaderCollisionCount: leaderCollisionOwners.size,
          menuCollisionCount: menuCollisions.length,
          routeCollisionCount: routeCollisionOwners.size,
          preference,
        };
      })
      .sort(
        (left, right) =>
          left.nodeCollisionCount - right.nodeCollisionCount ||
          left.labelCollisionCount - right.labelCollisionCount ||
          left.bodyCollisionArea - right.bodyCollisionArea ||
          left.leaderCollisionCount - right.leaderCollisionCount ||
          left.menuCollisionCount - right.menuCollisionCount ||
          left.routeCollisionCount - right.routeCollisionCount ||
          left.preference - right.preference,
      );
    const selected = ranked[0]!.reservation;
    selectedMenuBoxes.push(selected.box);
    return {
      ...placement,
      sourceMenuPlacement: selected.placement,
      sourceMenuWidth: selected.width,
    };
  });
}

export function buildStructureRenderFoundation(
  input: StructureRenderFoundationInput,
): StructureRenderFoundation {
  const { structure, positions, sourceChangeKinds, labelAccessory, edgeLabelMode } = input;
  const sourceLabels = shortestUniqueSourceLabels([
    ...structure.nodes.flatMap((node) => (node.anchor ? [node.anchor.path] : [])),
    ...structure.edges.flatMap((edge) => edge.anchors.map((anchor) => anchor.path)),
  ]);
  const allNodes = structure.nodes.flatMap((node) => {
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
  const routes = routeStructureEdges(structure.edges, structure.nodes, positions);
  const allEdges = structure.edges.flatMap((edge) => {
    const geometry = routes.get(edge.id);
    return geometry
      ? [{ edge, geometry, source: edgeSourcePresentation(edge, sourceChangeKinds) }]
      : [];
  });
  const allLabels = placeEdgeLabels(
    structure.edges,
    structure.nodes,
    positions,
    sourceChangeKinds,
    routes,
    labelAccessory,
    edgeLabelMode,
  );
  const presentation = structure.presentation
    ? (() => {
        const structureEdgeIds = new Set(structure.edges.map(({ id }) => id));
        const primaryBackboneEdgeIds = new Set(
          (structure.presentation.primaryBackbone?.edgeIds ?? [])
            .filter((edgeId) => structureEdgeIds.has(edgeId))
            .sort(stableCompare),
        );
        const primaryBackboneNodeIds = new Set(
          structure.edges
            .filter((edge) => primaryBackboneEdgeIds.has(edge.id))
            .flatMap((edge) => [edge.from, edge.to])
            .sort(stableCompare),
        );
        const regions = [...structure.presentation.regions]
          .sort((left, right) => stableCompare(left.id, right.id))
          .flatMap((region, index) => {
            const regionNodeIds = [...new Set(region.nodeIds)]
              .filter((nodeId) => positions[nodeId])
              .sort(stableCompare);
            const regionNodeIdSet = new Set(regionNodeIds);
            const internalEdgeIds = new Set(
              structure.edges
                .filter((edge) => regionNodeIdSet.has(edge.from) && regionNodeIdSet.has(edge.to))
                .map((edge) => edge.id),
            );
            const regionBounds = mergedBounds([
              ...regionNodeIds.map((nodeId) => {
                const point = positions[nodeId]!;
                return {
                  left: point.x,
                  top: point.y,
                  right: point.x + STRUCTURE_NODE_WIDTH,
                  bottom: point.y + STRUCTURE_NODE_HEIGHT,
                };
              }),
              ...structure.edges.flatMap((edge) => {
                if (!internalEdgeIds.has(edge.id)) return [];
                const route = routes.get(edge.id);
                return route ? [route.bounds] : [];
              }),
              ...allLabels.flatMap((placement) => {
                if (!internalEdgeIds.has(placement.edge.id)) return [];
                return [
                  labelBox(placement.x, placement.y, placement.boxWidth, placement.height, 4),
                  ...(placement.leaderBounds ? [placement.leaderBounds] : []),
                ];
              }),
            ]);
            return regionBounds
              ? [
                  {
                    id: region.id,
                    index,
                    label: region.label,
                    summary: region.summary,
                    nodeIds: regionNodeIds,
                    bounds: regionBounds,
                  },
                ]
              : [];
          });
        return {
          thesis: structure.presentation.thesis,
          startNodeId: structure.presentation.startNodeId,
          primaryBackboneNodeIds,
          primaryBackboneEdgeIds,
          regions,
        };
      })()
    : null;
  return { nodes: allNodes, edges: allEdges, labels: allLabels, presentation };
}

function isUsableAutomaticRetryPositions(
  structure: StructureRenderGraph,
  current: Readonly<Record<string, StructurePoint>>,
  candidate: Readonly<Record<string, StructurePoint>> | null | undefined,
): candidate is Readonly<Record<string, StructurePoint>> {
  if (!candidate) return false;
  if (
    Object.values(candidate).some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
  ) {
    return false;
  }
  const nodeIds = structure.nodes.map(({ id }) => id);
  if (nodeIds.some((nodeId) => !candidate[nodeId])) return false;
  return nodeIds.some((nodeId) => {
    const previous = current[nodeId];
    const next = candidate[nodeId]!;
    return !previous || previous.x !== next.x || previous.y !== next.y;
  });
}

/**
 * Builds renderer geometry for an automatic layout and permits at most two spacing-only retries.
 * Manual layouts continue to call buildStructureRenderFoundation directly, so local dragging never
 * triggers this callback implicitly.
 */
export function buildAutomaticStructureRenderFoundation(
  input: StructureAutomaticRenderFoundationInput,
): StructureAutomaticRenderFoundationResult {
  const { retryPositions, ...foundationInput } = input;
  let positions = foundationInput.positions;
  let foundation = buildStructureRenderFoundation(foundationInput);
  let retryCount = 0;
  for (const attempt of STRUCTURE_AUTOMATIC_LAYOUT_SPACING_RETRY_ATTEMPTS) {
    const pressureLabels = foundation.labels.filter(
      ({ diagnostics }) => diagnostics.spacingPressure,
    );
    if (pressureLabels.length === 0) break;
    const candidate = retryPositions({ attempt, positions, foundation, pressureLabels });
    if (!isUsableAutomaticRetryPositions(input.structure, positions, candidate)) break;
    positions = candidate;
    foundation = buildStructureRenderFoundation({ ...foundationInput, positions });
    retryCount += 1;
  }
  return { foundation, positions, retryCount };
}

export function selectStructureRenderModel(
  foundation: StructureRenderFoundation,
  selection: StructureRenderSelection,
): StructureRenderModel {
  const nodes = foundation.nodes.filter(({ node }) => selection.nodeIds.has(node.id));
  const renderNodeIds = new Set(nodes.map(({ node }) => node.id));
  const edges = foundation.edges.filter(
    ({ edge }) =>
      selection.edgeIds.has(edge.id) && renderNodeIds.has(edge.from) && renderNodeIds.has(edge.to),
  );
  const edgeIds = new Set(edges.map(({ edge }) => edge.id));
  const labels = foundation.labels.filter(
    ({ edge }) => edgeIds.has(edge.id) && selection.labelEdgeIds.has(edge.id),
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
  boxes.push(...labels.flatMap(({ leaderBounds }) => (leaderBounds ? [leaderBounds] : [])));
  return {
    nodes,
    edges,
    labels,
    presentation: foundation.presentation,
    bounds: mergedBounds(boxes),
  };
}

/**
 * Bounds for a semantic Node frame, including every exact relation induced by that Node set and
 * the complete visible label/association geometry for those relations. The Node IDs remain the
 * durable camera-frame identity; callers recompute these renderer bounds from current geometry.
 */
export function structureRenderBoundsForNodeIds(
  foundation: StructureRenderFoundation,
  nodeIds: Iterable<string>,
): StructureBox | null {
  const selectedNodeIds = new Set(nodeIds);
  const inducedEdgeIds = new Set(
    foundation.edges
      .filter(({ edge }) => selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to))
      .map(({ edge }) => edge.id),
  );
  return selectStructureRenderModel(foundation, {
    nodeIds: selectedNodeIds,
    edgeIds: inducedEdgeIds,
    labelEdgeIds: inducedEdgeIds,
  }).bounds;
}

export function buildStructureRenderModel(input: {
  structure: StructureRenderGraph;
  positions: Readonly<Record<string, StructurePoint>>;
  sourceChangeKinds: ReadonlyMap<string, ChangeKind>;
  selection: StructureRenderSelection;
  labelAccessory: StructureLabelAccessory;
  edgeLabelMode: StructureEdgeLabelMode;
}): StructureRenderModel {
  const { selection, ...foundationInput } = input;
  return selectStructureRenderModel(buildStructureRenderFoundation(foundationInput), selection);
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
