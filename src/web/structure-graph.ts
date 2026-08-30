import type { Structure, StructureEdge } from "../domain/models.js";

export interface StructurePoint {
  x: number;
  y: number;
}

export type StructureNeighborhoodDepth = 1 | 2 | "all";

export const STRUCTURE_NODE_WIDTH = 228;
export const STRUCTURE_NODE_HEIGHT = 112;
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
  originNodeId: string | null,
  depth: StructureNeighborhoodDepth,
): Set<string> {
  if (depth === "all" || !originNodeId) {
    return new Set(structure.nodes.map((node) => node.id));
  }
  const graph = adjacency(structure);
  if (!graph.has(originNodeId)) return new Set(structure.nodes.map((node) => node.id));
  const distances = new Map([[originNodeId, 0]]);
  const queue = [originNodeId];
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

function bidirectionalInitialLayout(
  structure: Structure,
  focusId: string,
): Record<string, StructurePoint> {
  const pairDirections = new Map<string, Set<"forward" | "reverse" | "undirected">>();
  for (const edge of structure.edges) {
    if (edge.from === edge.to) continue;
    const pairKey = unorderedNodePairKey(edge.from, edge.to);
    const directions = pairDirections.get(pairKey) ?? new Set();
    if (!edge.directed) directions.add("undirected");
    else directions.add(stableCompare(edge.from, edge.to) < 0 ? "forward" : "reverse");
    pairDirections.set(pairKey, directions);
  }
  const neutralPairs = new Set(
    [...pairDirections]
      .filter(
        ([, directions]) =>
          directions.has("undirected") || (directions.has("forward") && directions.has("reverse")),
      )
      .map(([pairKey]) => pairKey),
  );
  const levels = new Map([[focusId, 0]]);
  const queue = [focusId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const currentLevel = levels.get(current) ?? 0;
    for (const edge of [...structure.edges].sort((left, right) =>
      stableCompare(left.id, right.id),
    )) {
      const neighbor = edge.from === current ? edge.to : edge.to === current ? edge.from : null;
      if (!neighbor || levels.has(neighbor)) continue;
      const neutral = !edge.directed || neutralPairs.has(unorderedNodePairKey(edge.from, edge.to));
      levels.set(neighbor, currentLevel + (neutral ? 0 : edge.from === current ? 1 : -1));
      queue.push(neighbor);
    }
  }

  const groups = new Map<number, string[]>();
  for (const [nodeId, level] of levels) {
    const group = groups.get(level) ?? [];
    group.push(nodeId);
    groups.set(level, group);
  }
  for (const group of groups.values()) group.sort(stableCompare);
  const minLevel = Math.min(0, ...groups.keys());
  const maxLevel = Math.max(0, ...groups.keys());
  const rowStride = STRUCTURE_NODE_HEIGHT + 84;
  const rankStride = STRUCTURE_NODE_WIDTH + 172;
  const maxRows = Math.max(1, ...[...groups.values()].map((group) => group.length));
  const centerY = 64 + ((maxRows - 1) * rowStride) / 2;
  const positions: Record<string, StructurePoint> = {};
  for (const [level, nodeIds] of groups) {
    const top = centerY - ((nodeIds.length - 1) * rowStride) / 2;
    nodeIds.forEach((nodeId, index) => {
      positions[nodeId] = {
        x: 64 + (level - minLevel) * rankStride,
        y: top + index * rowStride,
      };
    });
  }

  const unassigned = structure.nodes
    .map((node) => node.id)
    .filter((nodeId) => positions[nodeId] === undefined)
    .sort(stableCompare);
  unassigned.forEach((nodeId, index) => {
    positions[nodeId] = {
      x: 64 + (maxLevel - minLevel + 1) * rankStride,
      y: centerY + index * rowStride,
    };
  });
  return positions;
}

/**
 * Content-neutral viewer layout. IDs and directed topology are the only inputs;
 * labels, kinds, descriptions, paths, and relation semantics never influence
 * position. A declared initial focus forms the center rank, so incoming and
 * outgoing relations remain visually distinguishable without layout metadata;
 * undirected and reciprocal pairs stay neutral rather than inventing a side.
 */
export function initialStructureLayout(structure: Structure): Record<string, StructurePoint> {
  if (structure.nodes.length === 0) return {};
  if (
    structure.initialFocus &&
    structure.nodes.some((node) => node.id === structure.initialFocus)
  ) {
    return bidirectionalInitialLayout(structure, structure.initialFocus);
  }
  const graph = adjacency(structure);
  const ids = structure.nodes.map((node) => node.id).sort(stableCompare);
  const roots = [
    ...(structure.initialFocus && graph.has(structure.initialFocus)
      ? [structure.initialFocus]
      : []),
    ...ids,
  ];
  const assigned = new Set<string>();
  const positions: Record<string, StructurePoint> = {};
  let componentTop = 64;
  for (const root of roots) {
    if (assigned.has(root)) continue;
    const distances = new Map([[root, 0]]);
    const queue = [root];
    assigned.add(root);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      for (const neighbor of graph.get(current) ?? []) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        distances.set(neighbor, (distances.get(current) ?? 0) + 1);
        queue.push(neighbor);
      }
    }
    const ranks = new Map<number, string[]>();
    for (const [id, rank] of distances) {
      const group = ranks.get(rank) ?? [];
      group.push(id);
      ranks.set(rank, group);
    }
    let componentBottom = componentTop;
    const perColumn = 10;
    const columnStride = STRUCTURE_NODE_WIDTH + 44;
    const rankGap = 68;
    let rankX = 64;
    for (const [, rankIds] of [...ranks].sort(([left], [right]) => left - right)) {
      rankIds.sort(stableCompare);
      rankIds.forEach((id, index) => {
        const subcolumn = Math.floor(index / perColumn);
        const row = index % perColumn;
        positions[id] = {
          x: rankX + subcolumn * columnStride,
          y: componentTop + row * 164,
        };
        componentBottom = Math.max(
          componentBottom,
          componentTop + row * 164 + STRUCTURE_NODE_HEIGHT,
        );
      });
      rankX += Math.max(1, Math.ceil(rankIds.length / perColumn)) * columnStride + rankGap;
    }
    componentTop = componentBottom + 180;
  }
  return positions;
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
    const point = firstOpenGridPoint(occupied, {
      x: center.x / neighbors.length + STRUCTURE_NODE_WIDTH + 112,
      y: center.y / neighbors.length,
    });
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
): StructurePoint {
  const columnStride = STRUCTURE_NODE_WIDTH + 44;
  const rowStride = STRUCTURE_NODE_HEIGHT + 52;
  for (let radius = 0; radius <= 50; radius += 1) {
    for (let row = -radius; row <= radius; row += 1) {
      for (let column = -radius; column <= radius; column += 1) {
        if (radius > 0 && Math.max(Math.abs(column), Math.abs(row)) !== radius) continue;
        const candidate = {
          x: origin.x + column * columnStride,
          y: origin.y + row * rowStride,
        };
        if (!positionOverlapsOccupied(occupied, candidate)) return candidate;
      }
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
