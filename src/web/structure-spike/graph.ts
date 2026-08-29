import type { Structure, StructureEdge } from "./model.js";

export interface StructurePoint {
  x: number;
  y: number;
}

export type StructureLayoutMode = "ranked" | "bidirectional";

export type StructureNeighborhoodDepth = 1 | 2 | "all";

export const STRUCTURE_NODE_WIDTH = 240;
export const STRUCTURE_NODE_HEIGHT = 132;
export const STRUCTURE_COLLAPSE_THRESHOLD = 12;
export const STRUCTURE_COLLAPSE_LIMIT_PER_DIRECTION = 4;

function adjacencyFor(structure: Structure): Map<string, string[]> {
  const adjacency = new Map(structure.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of structure.edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
    if (edge.to !== edge.from) adjacency.get(edge.to)?.push(edge.from);
  }
  return adjacency;
}

export function incidentStructureEdges(structure: Structure, nodeId: string): StructureEdge[] {
  return structure.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId);
}

const STRUCTURE_EDGE_LANE_OFFSET = 14;
const STRUCTURE_EDGE_LANE_GAP = 14;

/**
 * Gives parallel and reciprocal relations stable, content-neutral lanes.
 * Reciprocal edges receive the same local perpendicular offset; because their
 * directions are reversed, that places them on opposite sides of the centerline.
 */
export function structureEdgeRouteOffsets(
  edges: readonly StructureEdge[],
): ReadonlyMap<string, number> {
  const offsets = new Map(edges.map((edge) => [edge.id, 0]));
  const pairs = new Map<string, StructureEdge[]>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const endpoints = [edge.from, edge.to].sort((left, right) => left.localeCompare(right));
    const key = JSON.stringify(endpoints);
    const pair = pairs.get(key) ?? [];
    pair.push(edge);
    pairs.set(key, pair);
  }
  for (const pair of pairs.values()) {
    if (pair.length < 2) continue;
    const [canonicalFrom, canonicalTo] = [pair[0]!.from, pair[0]!.to].sort((left, right) =>
      left.localeCompare(right),
    );
    const forward = pair
      .filter((edge) => edge.from === canonicalFrom && edge.to === canonicalTo)
      .sort((left, right) => left.id.localeCompare(right.id));
    const reverse = pair
      .filter((edge) => edge.from === canonicalTo && edge.to === canonicalFrom)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (forward.length > 0 && reverse.length > 0) {
      for (const group of [forward, reverse]) {
        group.forEach((edge, index) => {
          offsets.set(edge.id, STRUCTURE_EDGE_LANE_OFFSET + index * STRUCTURE_EDGE_LANE_GAP);
        });
      }
      continue;
    }
    const stablePair = [...pair].sort((left, right) => left.id.localeCompare(right.id));
    const center = (stablePair.length - 1) / 2;
    stablePair.forEach((edge, index) => {
      offsets.set(edge.id, (index - center) * STRUCTURE_EDGE_LANE_GAP);
    });
  }
  return offsets;
}

export function structureNeighborhood(
  structure: Structure,
  originNodeId: string | null,
  depth: StructureNeighborhoodDepth,
): Set<string> {
  if (depth === "all" || !originNodeId) return new Set(structure.nodes.map((node) => node.id));
  const adjacency = adjacencyFor(structure);
  if (!adjacency.has(originNodeId)) return new Set(structure.nodes.map((node) => node.id));
  const distances = new Map([[originNodeId, 0]]);
  const queue = [originNodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const distance = distances.get(current) ?? 0;
    if (distance >= depth) continue;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distance + 1);
      queue.push(neighbor);
    }
  }
  return new Set(distances.keys());
}

export interface CollapsedStructureRelations {
  collapsed: boolean;
  visibleEdgeIds: Set<string>;
  hiddenEdgeIds: Set<string>;
}

export function collapsedStructureRelations(
  structure: Structure,
  nodeId: string | null,
  expanded: boolean,
): CollapsedStructureRelations {
  const incident = nodeId ? incidentStructureEdges(structure, nodeId) : [];
  if (!nodeId || expanded || incident.length <= STRUCTURE_COLLAPSE_THRESHOLD) {
    return {
      collapsed: false,
      visibleEdgeIds: new Set(incident.map((edge) => edge.id)),
      hiddenEdgeIds: new Set(),
    };
  }
  const buckets = {
    incoming: [] as StructureEdge[],
    outgoing: [] as StructureEdge[],
    undirected: [] as StructureEdge[],
  };
  for (const edge of incident) {
    if (!edge.directed || edge.from === edge.to) buckets.undirected.push(edge);
    else if (edge.from === nodeId) buckets.outgoing.push(edge);
    else buckets.incoming.push(edge);
  }
  const visible = new Set(
    Object.values(buckets).flatMap((edges) =>
      edges.slice(0, STRUCTURE_COLLAPSE_LIMIT_PER_DIRECTION).map((edge) => edge.id),
    ),
  );
  return {
    collapsed: true,
    visibleEdgeIds: visible,
    hiddenEdgeIds: new Set(incident.filter((edge) => !visible.has(edge.id)).map((edge) => edge.id)),
  };
}

export interface VisibleStructureGraph {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  hiddenRelationCount: number;
  relationsCollapsed: boolean;
}

export function visibleStructureGraph(
  structure: Structure,
  focusedNodeId: string | null,
  depth: StructureNeighborhoodDepth,
  focusedNodeExpanded: boolean,
): VisibleStructureGraph {
  const neighborhood = structureNeighborhood(structure, focusedNodeId, depth);
  const collapse = collapsedStructureRelations(structure, focusedNodeId, focusedNodeExpanded);
  const edgeIds = new Set(
    structure.edges
      .filter(
        (edge) =>
          neighborhood.has(edge.from) &&
          neighborhood.has(edge.to) &&
          !collapse.hiddenEdgeIds.has(edge.id),
      )
      .map((edge) => edge.id),
  );
  if (depth === "all" || !focusedNodeId) {
    return {
      nodeIds: neighborhood,
      edgeIds,
      hiddenRelationCount: collapse.hiddenEdgeIds.size,
      relationsCollapsed: collapse.collapsed,
    };
  }
  const adjacency = new Map([...neighborhood].map((nodeId) => [nodeId, [] as string[]]));
  for (const edge of structure.edges) {
    if (!edgeIds.has(edge.id)) continue;
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const connected = new Set([focusedNodeId]);
  const queue = [focusedNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) continue;
    for (const neighbor of adjacency.get(nodeId) ?? []) {
      if (connected.has(neighbor)) continue;
      connected.add(neighbor);
      queue.push(neighbor);
    }
  }
  return {
    nodeIds: connected,
    edgeIds,
    hiddenRelationCount: collapse.hiddenEdgeIds.size,
    relationsCollapsed: collapse.collapsed,
  };
}

function componentLayout(
  structure: Structure,
  componentRoot: string,
  assigned: Set<string>,
  positions: Record<string, StructurePoint>,
  componentTop: number,
): number {
  const adjacency = adjacencyFor(structure);
  const distances = new Map([[componentRoot, 0]]);
  const queue = [componentRoot];
  assigned.add(componentRoot);
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) continue;
    for (const neighbor of adjacency.get(nodeId) ?? []) {
      if (assigned.has(neighbor)) continue;
      assigned.add(neighbor);
      distances.set(neighbor, (distances.get(nodeId) ?? 0) + 1);
      queue.push(neighbor);
    }
  }
  const ranks = new Map<number, string[]>();
  for (const node of structure.nodes) {
    const rank = distances.get(node.id);
    if (rank === undefined) continue;
    const nodes = ranks.get(rank) ?? [];
    nodes.push(node.id);
    ranks.set(rank, nodes);
  }
  let componentBottom = componentTop;
  let rankLeft = 80;
  const nodesPerColumn = structure.nodes.length >= 100 ? 20 : 10;
  const columnStride = STRUCTURE_NODE_WIDTH + 72;
  const rankGutter = 280;
  const rowStride = STRUCTURE_NODE_HEIGHT + 84;
  for (const [, nodeIds] of [...ranks].sort(([left], [right]) => left - right)) {
    const columnCount = Math.max(1, Math.ceil(nodeIds.length / nodesPerColumn));
    nodeIds.forEach((nodeId, index) => {
      const column = Math.floor(index / nodesPerColumn);
      const row = index % nodesPerColumn;
      positions[nodeId] = {
        x: rankLeft + column * columnStride,
        y: componentTop + row * rowStride,
      };
      componentBottom = Math.max(
        componentBottom,
        componentTop + row * rowStride + STRUCTURE_NODE_HEIGHT,
      );
    });
    // A dedicated, content-neutral gutter between BFS ranks gives relation labels
    // room without assigning meaning to kind or label text.
    rankLeft += columnCount * columnStride + rankGutter;
  }
  return componentBottom;
}

function bidirectionalStructureLayout(structure: Structure): Record<string, StructurePoint> {
  const focus = structure.initialFocus;
  if (!focus || !structure.nodes.some((node) => node.id === focus)) {
    return initialStructureLayout(structure, "ranked");
  }
  const levels = new Map([[focus, 0]]);
  const queue = [focus];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const currentLevel = levels.get(current) ?? 0;
    for (const edge of structure.edges) {
      const neighbor = edge.from === current ? edge.to : edge.to === current ? edge.from : null;
      if (!neighbor || levels.has(neighbor)) continue;
      levels.set(neighbor, currentLevel + (edge.from === current ? 1 : -1));
      queue.push(neighbor);
    }
  }
  const minLevel = Math.min(0, ...levels.values());
  const maxLevel = Math.max(0, ...levels.values());
  const groups = new Map<number, string[]>();
  for (const node of structure.nodes) {
    const level = levels.get(node.id);
    if (level === undefined) continue;
    const group = groups.get(level) ?? [];
    group.push(node.id);
    groups.set(level, group);
  }
  const rowStride = STRUCTURE_NODE_HEIGHT + 84;
  const rankStride = STRUCTURE_NODE_WIDTH + 120;
  const maxRows = Math.max(1, ...[...groups.values()].map((nodes) => nodes.length));
  const centerY = 80 + ((maxRows - 1) * rowStride) / 2;
  const positions: Record<string, StructurePoint> = {};
  for (const [level, nodeIds] of groups) {
    const top = centerY - ((nodeIds.length - 1) * rowStride) / 2;
    nodeIds.forEach((nodeId, index) => {
      positions[nodeId] = {
        x: 80 + (level - minLevel) * rankStride,
        y: top + index * rowStride,
      };
    });
  }
  const unassigned = structure.nodes.filter((node) => positions[node.id] === undefined);
  unassigned.forEach((node, index) => {
    positions[node.id] = {
      x: 80 + (maxLevel - minLevel + 1) * rankStride,
      y: centerY + index * rowStride,
    };
  });
  return positions;
}

export function initialStructureLayout(
  structure: Structure,
  mode: StructureLayoutMode = "ranked",
): Record<string, StructurePoint> {
  if (mode === "bidirectional") return bidirectionalStructureLayout(structure);
  if (structure.nodes.length === 0) return {};
  const positions: Record<string, StructurePoint> = {};
  const assigned = new Set<string>();
  const roots = [
    ...(structure.initialFocus ? [structure.initialFocus] : []),
    ...structure.nodes.map((node) => node.id),
  ];
  let componentTop = 80;
  for (const root of roots) {
    if (assigned.has(root) || !structure.nodes.some((node) => node.id === root)) continue;
    const bottom = componentLayout(structure, root, assigned, positions, componentTop);
    componentTop = bottom + 220;
  }
  return positions;
}

function stableIdOffset(id: string): StructurePoint {
  let hash = 2166136261;
  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return {
    x: 110 + ((hash >>> 0) % 5) * 22,
    y: -90 + (((hash >>> 8) >>> 0) % 9) * 22,
  };
}

export function reconcileStructureLayout(
  structure: Structure,
  previous: Readonly<Record<string, StructurePoint>>,
): Record<string, StructurePoint> {
  const fallback = initialStructureLayout(structure);
  const next: Record<string, StructurePoint> = {};
  for (const node of structure.nodes) {
    const retained = previous[node.id];
    if (retained) next[node.id] = retained;
  }
  for (const node of structure.nodes) {
    if (next[node.id]) continue;
    const anchoredNeighbors = incidentStructureEdges(structure, node.id)
      .map((edge) => (edge.from === node.id ? edge.to : edge.from))
      .map((neighborId) => next[neighborId] ?? previous[neighborId])
      .filter((point): point is StructurePoint => point !== undefined);
    if (anchoredNeighbors.length === 0) {
      next[node.id] = fallback[node.id] ?? { x: 80, y: 80 };
      continue;
    }
    const center = anchoredNeighbors.reduce(
      (total, point) => ({ x: total.x + point.x, y: total.y + point.y }),
      { x: 0, y: 0 },
    );
    const offset = stableIdOffset(node.id);
    next[node.id] = {
      x: center.x / anchoredNeighbors.length + offset.x,
      y: center.y / anchoredNeighbors.length + offset.y,
    };
  }
  return next;
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
