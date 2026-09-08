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

export type StructureLocalDepth = Exclude<StructureNeighborhoodDepth, "all">;

/**
 * A factual local graph. It deliberately carries only the visible Nodes and real induced Edges,
 * so callers cannot accidentally route or reserve space for hidden graph content.
 */
export interface DerivedLocalStructureGraph {
  centerNodeId: string;
  depth: StructureLocalDepth;
  nodes: Structure["nodes"];
  edges: StructureEdge[];
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

export function deriveLocalStructureGraph(
  structure: Structure,
  centerNodeId: string,
  depth: StructureLocalDepth,
): DerivedLocalStructureGraph | null {
  if (!structure.nodes.some(({ id }) => id === centerNodeId)) return null;
  const nodeIds = structureNeighborhood(structure, centerNodeId, depth);
  const nodes = structure.nodes
    .filter(({ id }) => nodeIds.has(id))
    .sort((left, right) => stableCompare(left.id, right.id));
  const edges = structure.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .sort((left, right) => stableCompare(left.id, right.id));
  return {
    centerNodeId,
    depth,
    nodes,
    edges,
    nodeIds: new Set(nodes.map(({ id }) => id)),
    edgeIds: new Set(edges.map(({ id }) => id)),
  };
}

export interface DerivedLocalStructureLayout {
  graph: DerivedLocalStructureGraph;
  positions: Record<string, StructurePoint>;
}

function compactLocalAxis(
  values: readonly number[],
  anchor: number,
  maximumGap: number,
): ReadonlyMap<number, number> {
  const ordered = [...new Set([...values, anchor])].sort((left, right) => left - right);
  const anchorIndex = ordered.indexOf(anchor);
  const compacted = new Map<number, number>([[anchor, anchor]]);
  for (let index = anchorIndex + 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    compacted.set(current, compacted.get(previous)! + Math.min(current - previous, maximumGap));
  }
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const current = ordered[index]!;
    const next = ordered[index + 1]!;
    compacted.set(current, compacted.get(next)! - Math.min(next - current, maximumGap));
  }
  return compacted;
}

function firstOpenMentalMapPoint(
  occupied: readonly { nodeId: string; point: StructurePoint }[],
  origin: StructurePoint,
  reference: StructurePoint,
  references: Readonly<Record<string, StructurePoint>>,
  neighbors: readonly StructurePoint[],
): StructurePoint {
  const columnStride = STRUCTURE_NODE_WIDTH + 44;
  const rowStride = STRUCTURE_NODE_HEIGHT + 52;
  const occupiedPoints = occupied.map(({ point }) => point);
  let fallback:
    | { point: StructurePoint; violations: number; radius: number; neighborDistance: number }
    | undefined;
  for (let radius = 0; radius <= 50; radius += 1) {
    const candidates: Array<{
      point: StructurePoint;
      violations: number;
      neighborDistance: number;
      crowding: number;
    }> = [];
    for (let row = -radius; row <= radius; row += 1) {
      for (let column = -radius; column <= radius; column += 1) {
        if (radius > 0 && Math.max(Math.abs(column), Math.abs(row)) !== radius) continue;
        const point = {
          x: origin.x + column * columnStride,
          y: origin.y + row * rowStride,
        };
        if (positionOverlapsOccupied(occupiedPoints, point)) continue;
        const violations = occupied.reduce((count, placed) => {
          const placedReference = references[placed.nodeId]!;
          const referenceHorizontal = Math.sign(reference.x - placedReference.x);
          const referenceVertical = Math.sign(reference.y - placedReference.y);
          return (
            count +
            (referenceHorizontal !== 0 &&
            Math.sign(point.x - placed.point.x) !== referenceHorizontal
              ? 1
              : 0) +
            (referenceVertical !== 0 && Math.sign(point.y - placed.point.y) !== referenceVertical
              ? 1
              : 0)
          );
        }, 0);
        const neighborDistance = neighbors.reduce(
          (total, neighbor) => total + Math.hypot(point.x - neighbor.x, point.y - neighbor.y),
          0,
        );
        const crowding = occupiedPoints.reduce(
          (total, placed) =>
            total + 1 / Math.max(1, Math.hypot(point.x - placed.x, point.y - placed.y)),
          0,
        );
        candidates.push({ point, violations, neighborDistance, crowding });
      }
    }
    candidates.sort(
      (left, right) =>
        left.violations - right.violations ||
        left.neighborDistance - right.neighborDistance ||
        left.crowding - right.crowding ||
        left.point.y - right.point.y ||
        left.point.x - right.point.x,
    );
    const best = candidates[0];
    if (best?.violations === 0) return best.point;
    if (
      best &&
      (!fallback ||
        best.violations < fallback.violations ||
        (best.violations === fallback.violations &&
          (radius < fallback.radius ||
            (radius === fallback.radius && best.neighborDistance < fallback.neighborDistance))))
    ) {
      fallback = { ...best, radius };
    }
  }
  return fallback?.point ?? { x: origin.x + occupied.length * columnStride, y: origin.y };
}

/**
 * Derives a local mental-map-preserving layout from the full layout. Axis order and direction are
 * kept while gaps left by hidden Nodes are capped. Collision repair considers only the local graph,
 * and the center remains an exact anchor.
 */
export function deriveLocalStructureLayout(
  structure: Structure,
  centerNodeId: string,
  depth: StructureLocalDepth,
  fullPositions: Readonly<Record<string, StructurePoint>>,
): DerivedLocalStructureLayout | null {
  const graph = deriveLocalStructureGraph(structure, centerNodeId, depth);
  if (!graph) return null;

  const fallbackPositions: Readonly<Record<string, StructurePoint>> = graph.nodes.some(
    ({ id }) => fullPositions[id] === undefined,
  )
    ? initialStructureLayout(structure)
    : {};
  const fallbackCenter = fallbackPositions[centerNodeId] ?? { x: 64, y: 64 };
  const referenceCenter = fullPositions[centerNodeId] ?? fallbackCenter;
  const fallbackTranslation = {
    x: referenceCenter.x - fallbackCenter.x,
    y: referenceCenter.y - fallbackCenter.y,
  };
  const referencePositions = Object.fromEntries(
    graph.nodes.map(({ id }) => [
      id,
      fullPositions[id] ??
        (fallbackPositions[id]
          ? {
              x: fallbackPositions[id].x + fallbackTranslation.x,
              y: fallbackPositions[id].y + fallbackTranslation.y,
            }
          : referenceCenter),
    ]),
  ) as Record<string, StructurePoint>;
  const center = referencePositions[centerNodeId]!;
  const xByReference = compactLocalAxis(
    graph.nodes.map(({ id }) => referencePositions[id]!.x),
    center.x,
    STRUCTURE_NODE_WIDTH + 64,
  );
  const yByReference = compactLocalAxis(
    graph.nodes.map(({ id }) => referencePositions[id]!.y),
    center.y,
    STRUCTURE_NODE_HEIGHT + 72,
  );
  const desiredPositions = Object.fromEntries(
    graph.nodes.map(({ id }) => {
      const reference = referencePositions[id]!;
      return [id, { x: xByReference.get(reference.x)!, y: yByReference.get(reference.y)! }];
    }),
  ) as Record<string, StructurePoint>;

  const neighbors = new Map(graph.nodes.map(({ id }) => [id, [] as string[]]));
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue;
    neighbors.get(edge.from)?.push(edge.to);
    neighbors.get(edge.to)?.push(edge.from);
  }
  for (const adjacent of neighbors.values()) adjacent.sort(stableCompare);
  const hops = new Map<string, number>([[centerNodeId, 0]]);
  const queue = [centerNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const neighbor of neighbors.get(current) ?? []) {
      if (hops.has(neighbor)) continue;
      hops.set(neighbor, hops.get(current)! + 1);
      queue.push(neighbor);
    }
  }

  const positions: Record<string, StructurePoint> = {};
  const occupied: Array<{ nodeId: string; point: StructurePoint }> = [];
  const placementOrder = [...graph.nodes].sort(
    (left, right) =>
      (hops.get(left.id) ?? Number.POSITIVE_INFINITY) -
        (hops.get(right.id) ?? Number.POSITIVE_INFINITY) ||
      desiredPositions[left.id]!.y - desiredPositions[right.id]!.y ||
      desiredPositions[left.id]!.x - desiredPositions[right.id]!.x ||
      stableCompare(left.id, right.id),
  );
  for (const { id } of placementOrder) {
    const desired = desiredPositions[id]!;
    const adjacentPoints = (neighbors.get(id) ?? []).flatMap((neighborId) =>
      positions[neighborId] ? [positions[neighborId]] : [],
    );
    const point = positionOverlapsOccupied(
      occupied.map(({ point }) => point),
      desired,
    )
      ? firstOpenMentalMapPoint(
          occupied,
          desired,
          referencePositions[id]!,
          referencePositions,
          adjacentPoints,
        )
      : desired;
    positions[id] = point;
    occupied.push({ nodeId: id, point });
  }
  return { graph, positions };
}

/**
 * Reconciles a newly derived local map with reviewer-owned local coordinates. Existing visible
 * Nodes retain their exact positions; only newly visible Nodes are placed from the fresh automatic
 * layout and repaired around those retained obstacles. This is used for current-value replacement,
 * never for an explicit Reset.
 */
export function reconcileDerivedLocalStructureLayout(
  layout: DerivedLocalStructureLayout,
  previous: Readonly<Record<string, StructurePoint>>,
): Record<string, StructurePoint> {
  const positions: Record<string, StructurePoint> = {};
  const occupied: StructurePoint[] = [];
  for (const { id } of layout.graph.nodes) {
    const retained = previous[id];
    if (!retained || !Number.isFinite(retained.x) || !Number.isFinite(retained.y)) continue;
    positions[id] = retained;
    occupied.push(retained);
  }
  for (const { id } of [...layout.graph.nodes].sort((left, right) =>
    stableCompare(left.id, right.id),
  )) {
    if (positions[id]) continue;
    const desired = layout.positions[id] ?? { x: 64, y: 64 };
    const neighbors = layout.graph.edges
      .filter((edge) => edge.from === id || edge.to === id)
      .map((edge) => (edge.from === id ? edge.to : edge.from))
      .flatMap((neighborId) => (positions[neighborId] ? [positions[neighborId]] : []));
    const point = positionOverlapsOccupied(occupied, desired)
      ? firstOpenGridPoint(occupied, desired, neighbors)
      : desired;
    positions[id] = point;
    occupied.push(point);
  }
  return positions;
}

/**
 * Canonical behavior map derived from factual topology and optional authorial
 * spatial presentation. Organizer-backed presentations use the optional exact
 * Edge backbone and stable comprehension Region memberships without accepting coordinates.
 * A start-only presentation shares the factual topology projection with null,
 * while its thesis and attention start remain visible presentation semantics.
 * Stable IDs only resolve otherwise symmetric ordering, so Reset returns the
 * same artifact to the same projection.
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
