import type { Structure, StructureEdge } from "../domain/models.js";
import {
  projectStructure,
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
  type StructurePoint,
} from "../domain/structure-projection.js";

export {
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
  type StructurePoint,
} from "../domain/structure-projection.js";

export type StructureNeighborhoodDepth = 1 | 2 | "all";

export const STRUCTURE_MAX_EDGE_LANE_OFFSET = 96;

function stableCompare(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function unorderedNodePairKey(left: string, right: string): string {
  return JSON.stringify([left, right].sort(stableCompare));
}

function adjacency(structure: Structure): Map<string, string[]> {
  const result = new Map(structure.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of [...structure.edges].sort((left, right) => stableCompare(left.id, right.id))) {
    if (!result.has(edge.from) || !result.has(edge.to)) continue;
    result.get(edge.from)?.push(edge.to);
    if (edge.from !== edge.to) result.get(edge.to)?.push(edge.from);
  }
  for (const neighbors of result.values()) neighbors.sort(stableCompare);
  return result;
}

export function incidentStructureEdges(structure: Structure, nodeId: string): StructureEdge[] {
  return structure.edges
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .sort((left, right) => stableCompare(left.id, right.id));
}

export function structureNeighborhood(
  structure: Structure,
  focusedNodeId: string | null,
  depth: StructureNeighborhoodDepth,
): Set<string> {
  if (depth === "all" || !focusedNodeId) {
    return new Set(structure.nodes.map((node) => node.id));
  }
  const graph = adjacency(structure);
  if (!graph.has(focusedNodeId)) return new Set(structure.nodes.map((node) => node.id));
  const distances = new Map([[focusedNodeId, 0]]);
  const queue = [focusedNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const distance = distances.get(current) ?? 0;
    if (distance >= depth) continue;
    for (const neighbor of graph.get(current) ?? []) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distance + 1);
      queue.push(neighbor);
    }
  }
  return new Set(distances.keys());
}

export interface VisibleStructureGraph {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

export function visibleStructureGraph(
  structure: Structure,
  focusedNodeId: string | null,
  depth: StructureNeighborhoodDepth,
): VisibleStructureGraph {
  const neighborhood = structureNeighborhood(structure, focusedNodeId, depth);
  const edgeIds = new Set(
    structure.edges
      .filter((edge) => neighborhood.has(edge.from) && neighborhood.has(edge.to))
      .map((edge) => edge.id),
  );
  return { nodeIds: neighborhood, edgeIds };
}

/**
 * Canonical behavior map derived from topology plus the authored entrypoint.
 * Unambiguous directed relations form readable left-to-right ranks; branches use
 * vertical whitespace and topology-derived ordering. Undirected or reciprocal
 * pairs and self-relations do not force an axis; same-direction parallel edges
 * contribute one pair-level signal. Authored display content never affects
 * geometry. Stable IDs only resolve otherwise symmetric ordering, so Reset
 * returns the same graph to the same projection.
 */
export function initialStructureLayout(structure: Structure): Record<string, StructurePoint> {
  return Object.fromEntries(projectStructure(structure).positionsByNodeId);
}

export function reconcileStructureLayout(
  structure: Structure,
  previous: Readonly<Record<string, StructurePoint>>,
): Record<string, StructurePoint> {
  const fallback = initialStructureLayout(structure);
  const next: Record<string, StructurePoint> = {};
  const occupied: StructurePoint[] = [];
  for (const node of structure.nodes) {
    const retained = previous[node.id];
    if (retained) {
      next[node.id] = retained;
      occupied.push(retained);
    }
  }
  for (const node of [...structure.nodes].sort((left, right) => stableCompare(left.id, right.id))) {
    if (next[node.id]) continue;
    const neighbors = incidentStructureEdges(structure, node.id)
      .map((edge) => (edge.from === node.id ? edge.to : edge.from))
      .map((neighborId) => next[neighborId] ?? previous[neighborId])
      .filter((point): point is StructurePoint => point !== undefined);
    if (neighbors.length === 0) {
      const fallbackPoint = fallback[node.id] ?? { x: 64, y: 64 };
      const point = positionOverlapsOccupied(occupied, fallbackPoint)
        ? firstOpenGridPoint(occupied, fallbackPoint)
        : fallbackPoint;
      next[node.id] = point;
      occupied.push(point);
      continue;
    }
    const center = neighbors.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), {
      x: 0,
      y: 0,
    });
    const point = firstOpenGridPoint(
      occupied,
      { x: center.x / neighbors.length, y: center.y / neighbors.length },
      neighbors,
    );
    next[node.id] = point;
    occupied.push(point);
  }
  return next;
}

function positionOverlapsOccupied(
  occupied: readonly StructurePoint[],
  candidate: StructurePoint,
): boolean {
  return occupied.some(
    (point) =>
      candidate.x < point.x + STRUCTURE_NODE_WIDTH + 44 &&
      candidate.x + STRUCTURE_NODE_WIDTH + 44 > point.x &&
      candidate.y < point.y + STRUCTURE_NODE_HEIGHT + 52 &&
      candidate.y + STRUCTURE_NODE_HEIGHT + 52 > point.y,
  );
}

function firstOpenGridPoint(
  occupied: readonly StructurePoint[],
  origin: StructurePoint,
  neighbors: readonly StructurePoint[] = [],
): StructurePoint {
  const columnStride = STRUCTURE_NODE_WIDTH + 44;
  const rowStride = STRUCTURE_NODE_HEIGHT + 52;
  for (let radius = 0; radius <= 50; radius += 1) {
    const candidates: StructurePoint[] = [];
    for (let row = -radius; row <= radius; row += 1) {
      for (let column = -radius; column <= radius; column += 1) {
        if (radius > 0 && Math.max(Math.abs(column), Math.abs(row)) !== radius) continue;
        const candidate = {
          x: origin.x + column * columnStride,
          y: origin.y + row * rowStride,
        };
        if (!positionOverlapsOccupied(occupied, candidate)) candidates.push(candidate);
      }
    }
    if (candidates.length > 0) {
      const crowding = (candidate: StructurePoint): number =>
        occupied.reduce(
          (total, point) =>
            total + 1 / Math.max(1, Math.hypot(candidate.x - point.x, candidate.y - point.y)),
          0,
        );
      const neighborDistance = (candidate: StructurePoint): number =>
        neighbors.reduce(
          (total, point) => total + Math.hypot(candidate.x - point.x, candidate.y - point.y),
          0,
        );
      candidates.sort(
        (left, right) =>
          neighborDistance(left) - neighborDistance(right) ||
          crowding(left) - crowding(right) ||
          left.y - right.y ||
          left.x - right.x,
      );
      return candidates[0]!;
    }
  }
  return { x: origin.x + occupied.length * columnStride, y: origin.y };
}

export function structureEdgeRouteOffsets(
  edges: readonly StructureEdge[],
): ReadonlyMap<string, number> {
  const offsets = new Map(edges.map((edge) => [edge.id, 0]));
  const pairs = new Map<string, StructureEdge[]>();
  for (const edge of edges) {
    const pairKey = unorderedNodePairKey(edge.from, edge.to);
    const pair = pairs.get(pairKey) ?? [];
    pair.push(edge);
    pairs.set(pairKey, pair);
  }
  for (const pair of pairs.values()) {
    if (pair.length < 2) continue;
    const sorted = pair.sort((left, right) => stableCompare(left.id, right.id));
    const center = (sorted.length - 1) / 2;
    const step = Math.min(18, center === 0 ? 0 : STRUCTURE_MAX_EDGE_LANE_OFFSET / center);
    sorted.forEach((edge, index) => offsets.set(edge.id, (index - center) * step));
  }
  return offsets;
}

export function structureLayoutBounds(
  nodeIds: Iterable<string>,
  positions: Readonly<Record<string, StructurePoint>>,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const nodeId of nodeIds) {
    const point = positions[nodeId];
    if (!point) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + STRUCTURE_NODE_WIDTH);
    maxY = Math.max(maxY, point.y + STRUCTURE_NODE_HEIGHT);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
