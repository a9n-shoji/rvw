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

interface SimpleTopology {
  neighbors: Map<string, string[]>;
  links: Array<readonly [string, string]>;
  directionalLinks: Array<readonly [string, string]>;
}

function simpleTopology(structure: Structure): SimpleTopology {
  const neighborSets = new Map(structure.nodes.map((node) => [node.id, new Set<string>()]));
  const pairNodes = new Map<string, readonly [string, string]>();
  const pairDirections = new Map<
    string,
    {
      hasUndirected: boolean;
      directions: Map<string, readonly [string, string]>;
    }
  >();
  for (const edge of structure.edges) {
    if (edge.from === edge.to || !neighborSets.has(edge.from) || !neighborSets.has(edge.to)) {
      continue;
    }
    neighborSets.get(edge.from)?.add(edge.to);
    neighborSets.get(edge.to)?.add(edge.from);
    const ordered = [edge.from, edge.to].sort(stableCompare) as [string, string];
    const pairKey = JSON.stringify(ordered);
    pairNodes.set(pairKey, ordered);
    const directions = pairDirections.get(pairKey) ?? {
      hasUndirected: false,
      directions: new Map<string, readonly [string, string]>(),
    };
    if (edge.directed) {
      directions.directions.set(JSON.stringify([edge.from, edge.to]), [edge.from, edge.to]);
    } else {
      directions.hasUndirected = true;
    }
    pairDirections.set(pairKey, directions);
  }
  const compareLinks = (
    [leftA, leftB]: readonly [string, string],
    [rightA, rightB]: readonly [string, string],
  ): number => {
    const first = stableCompare(leftA, rightA);
    return first === 0 ? stableCompare(leftB, rightB) : first;
  };
  return {
    neighbors: new Map(
      [...neighborSets].map(([nodeId, neighbors]) => [nodeId, [...neighbors].sort(stableCompare)]),
    ),
    links: [...pairNodes.values()].sort(compareLinks),
    directionalLinks: [...pairDirections.values()]
      .flatMap(({ hasUndirected, directions }) =>
        !hasUndirected && directions.size === 1 ? [...directions.values()] : [],
      )
      .sort(compareLinks),
  };
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

function topologyComponents(topology: SimpleTopology): string[][] {
  const components: string[][] = [];
  const assigned = new Set<string>();
  for (const first of [...topology.neighbors.keys()].sort(stableCompare)) {
    if (assigned.has(first)) continue;
    const component: string[] = [];
    const queue = [first];
    assigned.add(first);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      component.push(current);
      for (const neighbor of topology.neighbors.get(current) ?? []) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        queue.push(neighbor);
      }
    }
    component.sort(stableCompare);
    components.push(component);
  }
  return components.sort(
    (left, right) => right.length - left.length || stableCompare(left[0]!, right[0]!),
  );
}

function topologyRoot(nodeIds: readonly string[], topology: SimpleTopology): string {
  const neighborDegree = (nodeId: string): number =>
    (topology.neighbors.get(nodeId) ?? []).reduce(
      (total, neighbor) => total + (topology.neighbors.get(neighbor)?.length ?? 0),
      0,
    );
  return [...nodeIds].sort(
    (left, right) =>
      (topology.neighbors.get(right)?.length ?? 0) - (topology.neighbors.get(left)?.length ?? 0) ||
      neighborDegree(right) - neighborDegree(left) ||
      stableCompare(left, right),
  )[0]!;
}

function componentRanks(
  nodeIds: readonly string[],
  topology: SimpleTopology,
  entrypointId: string | null,
): Map<string, number> {
  const nodeSet = new Set(nodeIds);
  const entrypoint = entrypointId && nodeSet.has(entrypointId) ? entrypointId : null;
  const ranks = new Map<string, number>();

  if (!entrypoint) {
    const root = topologyRoot(nodeIds, topology);
    ranks.set(root, 0);
    const queue = [root];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      for (const neighbor of topology.neighbors.get(current) ?? []) {
        if (!nodeSet.has(neighbor) || ranks.has(neighbor)) continue;
        ranks.set(neighbor, ranks.get(current)! + 1);
        queue.push(neighbor);
      }
    }
    return ranks;
  }

  // Only a single, unambiguous directed relation contributes to the behavior
  // axis. Reciprocal and undirected pairs remain topology without a forced side.
  const outgoing = new Map(nodeIds.map((nodeId) => [nodeId, [] as string[]]));
  for (const [from, to] of topology.directionalLinks) {
    if (!nodeSet.has(from) || !nodeSet.has(to)) continue;
    outgoing.get(from)?.push(to);
  }
  for (const targets of outgoing.values()) targets.sort(stableCompare);

  ranks.set(entrypoint, 0);
  const queue = [entrypoint];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const target of outgoing.get(current) ?? []) {
      if (ranks.has(target)) continue;
      ranks.set(target, ranks.get(current)! + 1);
      queue.push(target);
    }
  }

  // A setup dependency that points into an already ranked responsibility is
  // placed immediately before it, but never to the left of the factual origin.
  for (let pass = 0; pass < nodeIds.length; pass += 1) {
    let changed = false;
    for (const [from, to] of topology.directionalLinks) {
      if (!nodeSet.has(from) || !nodeSet.has(to)) continue;
      const fromRank = ranks.get(from);
      const toRank = ranks.get(to);
      if (fromRank === undefined && toRank !== undefined) {
        ranks.set(from, Math.max(0, toRank - 1));
        changed = true;
      } else if (fromRank !== undefined && toRank === undefined) {
        ranks.set(to, fromRank + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Ambiguous/cyclic/undirected remainder stays discoverable next to the first
  // ranked neighbor without inventing a direction for that relation.
  const rankedQueue = [...ranks]
    .sort(
      ([leftId, leftRank], [rightId, rightRank]) =>
        leftRank - rightRank || stableCompare(leftId, rightId),
    )
    .map(([nodeId]) => nodeId);
  for (let index = 0; index < rankedQueue.length; index += 1) {
    const current = rankedQueue[index]!;
    for (const neighbor of topology.neighbors.get(current) ?? []) {
      if (!nodeSet.has(neighbor) || ranks.has(neighbor)) continue;
      ranks.set(neighbor, ranks.get(current)! + 1);
      rankedQueue.push(neighbor);
    }
  }
  return ranks;
}

function orderRankGroups(
  groups: Map<number, string[]>,
  topology: SimpleTopology,
): Map<number, string[]> {
  const rankValues = [...groups.keys()].sort((left, right) => left - right);
  const result = new Map(
    rankValues.map((rank) => [rank, [...groups.get(rank)!].sort(stableCompare)]),
  );
  const sortAgainst = (rank: number, adjacentRank: number): void => {
    const nodes = result.get(rank)!;
    const adjacent = result.get(adjacentRank)!;
    const adjacentOrder = new Map(adjacent.map((nodeId, index) => [nodeId, index]));
    const barycenter = (nodeId: string): number | null => {
      const indexes = (topology.neighbors.get(nodeId) ?? []).flatMap((neighbor) => {
        const index = adjacentOrder.get(neighbor);
        return index === undefined ? [] : [index];
      });
      return indexes.length === 0
        ? null
        : indexes.reduce((total, index) => total + index, 0) / indexes.length;
    };
    nodes.sort((left, right) => {
      const leftCenter = barycenter(left);
      const rightCenter = barycenter(right);
      if (leftCenter === null && rightCenter === null) return stableCompare(left, right);
      if (leftCenter === null) return 1;
      if (rightCenter === null) return -1;
      return leftCenter - rightCenter || stableCompare(left, right);
    });
  };
  for (let pass = 0; pass < 6; pass += 1) {
    for (let index = 1; index < rankValues.length; index += 1) {
      sortAgainst(rankValues[index]!, rankValues[index - 1]!);
    }
    for (let index = rankValues.length - 2; index >= 0; index -= 1) {
      sortAgainst(rankValues[index]!, rankValues[index + 1]!);
    }
  }
  return result;
}

function layoutTopologyComponent(
  nodeIds: readonly string[],
  topology: SimpleTopology,
  entrypointId: string | null,
): Record<string, StructurePoint> {
  if (nodeIds.length === 1) return { [nodeIds[0]!]: { x: 0, y: 0 } };
  const ranks = componentRanks(nodeIds, topology, entrypointId);
  const rawGroups = new Map<number, string[]>();
  for (const nodeId of nodeIds) {
    const rank = ranks.get(nodeId) ?? 0;
    const group = rawGroups.get(rank) ?? [];
    group.push(nodeId);
    rawGroups.set(rank, group);
  }
  const groups = orderRankGroups(rawGroups, topology);
  const rankValues = [...groups.keys()].sort((left, right) => left - right);
  const rankStride = STRUCTURE_NODE_WIDTH + 192;
  const rowStride = STRUCTURE_NODE_HEIGHT + 72;
  const maxRows = Math.max(...[...groups.values()].map((nodes) => nodes.length));
  const centerY = ((maxRows - 1) * rowStride) / 2;
  const positions: Record<string, StructurePoint> = {};
  rankValues.forEach((rank, rankIndex) => {
    const group = groups.get(rank)!;
    const top = centerY - ((group.length - 1) * rowStride) / 2;
    group.forEach((nodeId, rowIndex) => {
      positions[nodeId] = {
        x: rankIndex * rankStride,
        y: top + rowIndex * rowStride,
      };
    });
  });
  return positions;
}

/**
 * Canonical behavior map derived from topology plus the authored entrypoint.
 * Unambiguous directed relations form readable left-to-right ranks; branches use
 * vertical whitespace and topology-derived ordering. Undirected, reciprocal,
 * parallel, and self-relations do not force an axis. Authored display content
 * never affects geometry. Stable IDs only resolve otherwise symmetric ordering,
 * so Reset returns the same graph to the same projection.
 */
export function initialStructureLayout(structure: Structure): Record<string, StructurePoint> {
  if (structure.nodes.length === 0) return {};
  const topology = simpleTopology(structure);
  const componentGap = 180;
  const outerPadding = 64;
  const components = topologyComponents(topology).map((nodeIds) => {
    const positions = layoutTopologyComponent(nodeIds, topology, structure.originNodeId);
    const bounds = structureLayoutBounds(nodeIds, positions)!;
    return {
      nodeIds,
      positions,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
    };
  });
  const totalArea = components.reduce(
    (sum, component) => sum + (component.width + componentGap) * (component.height + componentGap),
    0,
  );
  const targetRowWidth = Math.max(960, Math.sqrt(totalArea) * 1.45);
  const result: Record<string, StructurePoint> = {};
  let cursorX = outerPadding;
  let cursorY = outerPadding;
  let rowHeight = 0;
  for (const component of components) {
    if (cursorX > outerPadding && cursorX + component.width > targetRowWidth) {
      cursorX = outerPadding;
      cursorY += rowHeight + componentGap;
      rowHeight = 0;
    }
    for (const nodeId of component.nodeIds) {
      const point = component.positions[nodeId]!;
      result[nodeId] = { x: cursorX + point.x, y: cursorY + point.y };
    }
    cursorX += component.width + componentGap;
    rowHeight = Math.max(rowHeight, component.height);
  }
  return result;
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
