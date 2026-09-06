import type { StructureEdge } from "./models.js";

type BackboneEdge = Pick<StructureEdge, "from" | "to">;

function compareStructureIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalStructureBackboneEdgeIds(edgeIds: readonly string[]): string[] {
  return [...edgeIds].sort(compareStructureIds);
}

export function canonicalStructureRegionNodeIds(nodeIds: readonly string[]): string[] {
  return [...nodeIds].sort(compareStructureIds);
}

export function structureBackboneNodeIds(edges: readonly BackboneEdge[]): Set<string> {
  const nodeIds = new Set<string>();
  for (const edge of edges) {
    nodeIds.add(edge.from);
    nodeIds.add(edge.to);
  }
  return nodeIds;
}

export function isStructureBackboneWeaklyConnected(
  edges: readonly BackboneEdge[],
  startNodeId: string,
): boolean {
  const nodeIds = structureBackboneNodeIds(edges);
  if (!nodeIds.has(startNodeId)) return false;

  const neighbors = new Map([...nodeIds].map((nodeId) => [nodeId, new Set<string>()]));
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    neighbors.get(edge.from)!.add(edge.to);
    neighbors.get(edge.to)!.add(edge.from);
  }

  const reached = new Set([startNodeId]);
  const queue = [startNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of neighbors.get(current) ?? []) {
      if (reached.has(neighbor)) continue;
      reached.add(neighbor);
      queue.push(neighbor);
    }
  }
  return reached.size === nodeIds.size;
}
