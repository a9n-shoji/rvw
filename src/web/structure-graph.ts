import type { Structure, StructureEdge } from "../domain/models.js";

export interface StructurePoint {
  x: number;
  y: number;
}

export type StructureNeighborhoodDepth = 1 | 2 | "all";

export const STRUCTURE_NODE_WIDTH = 228;
export const STRUCTURE_NODE_HEIGHT = 112;
export const STRUCTURE_COLLAPSE_THRESHOLD = 12;
export const STRUCTURE_COLLAPSE_LIMIT_PER_DIRECTION = 4;
export const STRUCTURE_MAX_EDGE_LANE_OFFSET = 96;

function stableCompare(left: string, right: string): number {
  return left.localeCompare(right, "en");
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

export interface CollapsedStructureRelations {
  collapsed: boolean;
  visibleEdgeIds: Set<string>;
  hiddenEdgeIds: Set<string>;
}

export function collapsedStructureRelations(
  structure: Structure,
  focusedNodeId: string | null,
  expanded: boolean,
): CollapsedStructureRelations {
  const incident = focusedNodeId ? incidentStructureEdges(structure, focusedNodeId) : [];
  if (!focusedNodeId || expanded || incident.length <= STRUCTURE_COLLAPSE_THRESHOLD) {
    return {
      collapsed: false,
      visibleEdgeIds: new Set(incident.map((edge) => edge.id)),
      hiddenEdgeIds: new Set(),
    };
  }
  const buckets: Record<"incoming" | "outgoing" | "undirected", StructureEdge[]> = {
    incoming: [],
    outgoing: [],
    undirected: [],
  };
  for (const edge of incident) {
    if (!edge.directed || edge.from === edge.to) buckets.undirected.push(edge);
    else if (edge.from === focusedNodeId) buckets.outgoing.push(edge);
    else buckets.incoming.push(edge);
  }
  const visibleEdgeIds = new Set(
    Object.values(buckets).flatMap((edges) =>
      edges
        .sort((left, right) => stableCompare(left.id, right.id))
        .slice(0, STRUCTURE_COLLAPSE_LIMIT_PER_DIRECTION)
        .map((edge) => edge.id),
    ),
  );
  return {
    collapsed: true,
    visibleEdgeIds,
    hiddenEdgeIds: new Set(
      incident.filter((edge) => !visibleEdgeIds.has(edge.id)).map((edge) => edge.id),
    ),
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
  expanded: boolean,
): VisibleStructureGraph {
  const neighborhood = structureNeighborhood(structure, focusedNodeId, depth);
  const collapse = collapsedStructureRelations(structure, focusedNodeId, expanded);
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

  // A collapsed relation must not leave an apparently unrelated Node floating in
  // the local view. Keep Nodes that remain reachable through visible relations;
  // Nodes connected by another visible path are intentionally retained.
  const visibleAdjacency = new Map([...neighborhood].map((nodeId) => [nodeId, [] as string[]]));
  for (const edge of structure.edges) {
    if (!edgeIds.has(edge.id)) continue;
    visibleAdjacency.get(edge.from)?.push(edge.to);
    if (edge.from !== edge.to) visibleAdjacency.get(edge.to)?.push(edge.from);
  }
  const nodeIds = new Set([focusedNodeId]);
  const queue = [focusedNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const neighbor of visibleAdjacency.get(current) ?? []) {
      if (nodeIds.has(neighbor)) continue;
      nodeIds.add(neighbor);
      queue.push(neighbor);
    }
  }
  return {
    nodeIds,
    edgeIds,
    hiddenRelationCount: collapse.hiddenEdgeIds.size,
    relationsCollapsed: collapse.collapsed,
  };
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function bidirectionalInitialLayout(
  structure: Structure,
  focusId: string,
): Record<string, StructurePoint> {
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
      levels.set(neighbor, currentLevel + (edge.from === current ? 1 : -1));
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
 * outgoing relations remain visually distinguishable without layout metadata.
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
    for (const [rank, rankIds] of [...ranks].sort(([left], [right]) => left - right)) {
      rankIds.sort(stableCompare);
      const perColumn = structure.nodes.length > 150 ? 18 : 10;
      rankIds.forEach((id, index) => {
        const subcolumn = Math.floor(index / perColumn);
        const row = index % perColumn;
        positions[id] = {
          x: 64 + rank * 340 + subcolumn * 272,
          y: componentTop + row * 164,
        };
        componentBottom = Math.max(
          componentBottom,
          componentTop + row * 164 + STRUCTURE_NODE_HEIGHT,
        );
      });
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
  for (const node of structure.nodes) {
    const retained = previous[node.id];
    if (retained) next[node.id] = retained;
  }
  for (const node of [...structure.nodes].sort((left, right) => stableCompare(left.id, right.id))) {
    if (next[node.id]) continue;
    const neighbors = incidentStructureEdges(structure, node.id)
      .map((edge) => (edge.from === node.id ? edge.to : edge.from))
      .map((neighborId) => next[neighborId] ?? previous[neighborId])
      .filter((point): point is StructurePoint => point !== undefined);
    if (neighbors.length === 0) {
      next[node.id] = fallback[node.id] ?? { x: 64, y: 64 };
      continue;
    }
    const center = neighbors.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), {
      x: 0,
      y: 0,
    });
    const hash = stableHash(node.id);
    next[node.id] = {
      x: center.x / neighbors.length + 120 + (hash % 5) * 18,
      y: center.y / neighbors.length - 72 + ((hash >>> 8) % 9) * 18,
    };
  }
  return next;
}

export function structureEdgeRouteOffsets(
  edges: readonly StructureEdge[],
): ReadonlyMap<string, number> {
  const offsets = new Map(edges.map((edge) => [edge.id, 0]));
  const pairs = new Map<string, StructureEdge[]>();
  for (const edge of edges) {
    const pairKey = [edge.from, edge.to].sort(stableCompare).join("\0");
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
