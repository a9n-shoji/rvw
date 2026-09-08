import type { Structure } from "../domain/models.js";
import type { StructurePoint } from "../domain/structure-projection.js";
import type {
  StructureAutomaticSpacingRetryInput,
  StructureEdgeLabelFallbackReason,
} from "./structure-render-model.js";

type StructureSpacingGraph = Pick<Structure, "nodes" | "edges"> &
  Partial<Pick<Structure, "originNodeId">>;

const STRUCTURE_LABEL_SPACING_CUT_LIMIT_PER_AXIS = 3;
const STRUCTURE_LABEL_SPACING_CUT_DEDUPLICATION_GAP = 24;
const STRUCTURE_LABEL_SPACING_RETRY_GAP = {
  distant: { 1: 32, 2: 24 },
  "leader-overlap": { 1: 44, 2: 32 },
  "label-route-overlap": { 1: 52, 2: 40 },
  emergency: { 1: 72, 2: 56 },
} as const;

interface StructureSpacingCut {
  axis: "x" | "y";
  coordinate: number;
  fallbackReason: Exclude<StructureEdgeLabelFallbackReason, null>;
}

function stableCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function fallbackPriority(reason: StructureEdgeLabelFallbackReason | null): number {
  switch (reason) {
    case "emergency":
      return 4;
    case "label-route-overlap":
      return 3;
    case "leader-overlap":
      return 2;
    case "distant":
      return 1;
    case null:
      return 0;
  }
}

function spacingCuts(
  structure: StructureSpacingGraph,
  positions: Readonly<Record<string, StructurePoint>>,
  pressureLabels: StructureAutomaticSpacingRetryInput["pressureLabels"],
): StructureSpacingCut[] {
  const cuts: StructureSpacingCut[] = [];
  const axisCounts = { x: 0, y: 0 };
  const orderedLabels = [...pressureLabels].sort(
    (left, right) =>
      fallbackPriority(right.diagnostics.fallbackReason) -
        fallbackPriority(left.diagnostics.fallbackReason) ||
      right.diagnostics.edgeDistance - left.diagnostics.edgeDistance ||
      right.diagnostics.maxParallelOverlap - left.diagnostics.maxParallelOverlap ||
      right.diagnostics.leaderLength - left.diagnostics.leaderLength ||
      stableCompare(left.edge.id, right.edge.id),
  );
  const edgeIds = new Set(structure.edges.map(({ id }) => id));
  for (const { edge, diagnostics } of orderedLabels) {
    if (!edgeIds.has(edge.id)) continue;
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to || (from.x === to.x && from.y === to.y)) continue;
    const axis = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? "x" : "y";
    if (axisCounts[axis] >= STRUCTURE_LABEL_SPACING_CUT_LIMIT_PER_AXIS) continue;
    const coordinate = (from[axis] + to[axis]) / 2;
    const fallbackReason = diagnostics.fallbackReason ?? "distant";
    const duplicate = cuts.find(
      (cut) =>
        cut.axis === axis &&
        Math.abs(cut.coordinate - coordinate) < STRUCTURE_LABEL_SPACING_CUT_DEDUPLICATION_GAP,
    );
    if (duplicate) {
      if (fallbackPriority(fallbackReason) > fallbackPriority(duplicate.fallbackReason)) {
        duplicate.fallbackReason = fallbackReason;
      }
      continue;
    }
    cuts.push({ axis, coordinate, fallbackReason });
    axisCounts[axis] += 1;
  }
  return cuts;
}

function displacementForCuts(
  value: number,
  cuts: readonly StructureSpacingCut[],
  axis: StructureSpacingCut["axis"],
  attempt: keyof (typeof STRUCTURE_LABEL_SPACING_RETRY_GAP)["distant"],
): number {
  return cuts.reduce((displacement, cut) => {
    if (cut.axis !== axis || value === cut.coordinate) return displacement;
    const gap = STRUCTURE_LABEL_SPACING_RETRY_GAP[cut.fallbackReason][attempt];
    return displacement + (value < cut.coordinate ? -gap / 2 : gap / 2);
  }, 0);
}

function coordinateExtent(
  structure: StructureSpacingGraph,
  positions: Readonly<Record<string, StructurePoint>>,
  axis: StructureSpacingCut["axis"],
): number {
  const values = structure.nodes.flatMap(({ id }) => {
    const point = positions[id];
    return point ? [point[axis]] : [];
  });
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

function retryScaleWithinExtent(
  structure: StructureSpacingGraph,
  current: Readonly<Record<string, StructurePoint>>,
  candidate: Readonly<Record<string, StructurePoint>>,
  maximumExtentPositions: Readonly<Record<string, StructurePoint>>,
  minimumExtentReduction: number,
  axis: StructureSpacingCut["axis"],
): number {
  const currentExtent = coordinateExtent(structure, current, axis);
  const candidateExtent = coordinateExtent(structure, candidate, axis);
  const maximumExtent = Math.max(
    currentExtent,
    coordinateExtent(structure, maximumExtentPositions, axis) - minimumExtentReduction,
  );
  if (candidateExtent <= maximumExtent || candidateExtent <= currentExtent) return 1;
  return Math.max(
    0,
    Math.min(1, (maximumExtent - currentExtent) / (candidateExtent - currentExtent)),
  );
}

/**
 * Adds a small amount of space only across bands implicated by unhealthy Edge labels. The caller
 * owns the two-attempt cap; this function keeps the chosen anchor exact and never changes order
 * within an unaffected band.
 */
export function retryAutomaticStructureLayoutSpacing({
  structure,
  anchorNodeId,
  attempt,
  positions,
  pressureLabels,
  maximumExtentPositions,
  minimumExtentReduction = 0,
}: Pick<StructureAutomaticSpacingRetryInput, "attempt" | "positions" | "pressureLabels"> & {
  structure: StructureSpacingGraph;
  anchorNodeId: string | null;
  maximumExtentPositions?: Readonly<Record<string, StructurePoint>>;
  minimumExtentReduction?: number;
}): Readonly<Record<string, StructurePoint>> | null {
  const cuts = spacingCuts(structure, positions, pressureLabels);
  if (cuts.length === 0) return null;
  const anchorId =
    (anchorNodeId && positions[anchorNodeId] ? anchorNodeId : null) ??
    (structure.originNodeId && positions[structure.originNodeId]
      ? structure.originNodeId
      : (structure.nodes.find(({ id }) => positions[id])?.id ?? null));
  const anchor = anchorId ? positions[anchorId] : undefined;
  const anchorDisplacement = anchor
    ? {
        x: displacementForCuts(anchor.x, cuts, "x", attempt),
        y: displacementForCuts(anchor.y, cuts, "y", attempt),
      }
    : { x: 0, y: 0 };
  const candidate = Object.fromEntries(
    structure.nodes.flatMap(({ id }) => {
      const point = positions[id];
      if (!point) return [];
      return [
        [
          id,
          {
            x: point.x + displacementForCuts(point.x, cuts, "x", attempt) - anchorDisplacement.x,
            y: point.y + displacementForCuts(point.y, cuts, "y", attempt) - anchorDisplacement.y,
          },
        ] as const,
      ];
    }),
  );
  if (!maximumExtentPositions) return candidate;
  const xScale = retryScaleWithinExtent(
    structure,
    positions,
    candidate,
    maximumExtentPositions,
    minimumExtentReduction,
    "x",
  );
  const yScale = retryScaleWithinExtent(
    structure,
    positions,
    candidate,
    maximumExtentPositions,
    minimumExtentReduction,
    "y",
  );
  if (xScale === 1 && yScale === 1) return candidate;
  return Object.fromEntries(
    structure.nodes.flatMap(({ id }) => {
      const current = positions[id];
      const next = candidate[id];
      if (!current || !next) return [];
      return [
        [
          id,
          {
            x: current.x + (next.x - current.x) * xScale,
            y: current.y + (next.y - current.y) * yScale,
          },
        ] as const,
      ];
    }),
  );
}
