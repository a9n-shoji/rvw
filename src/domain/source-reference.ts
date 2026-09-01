import type { SourceAnchor, Structure, StructureNode, StructureSourceLocator } from "./models.js";

export function sourceAnchorFingerprint(
  sourceOid: string,
  reference: Pick<SourceAnchor, "path" | "startLine" | "endLine">,
): string {
  return JSON.stringify([sourceOid, reference.path, reference.startLine, reference.endLine]);
}

export function structureSourceAnchor(
  structure: Structure,
  locator: StructureSourceLocator,
): SourceAnchor | null {
  if (locator.kind === "node") {
    return structure.nodes.find((node) => node.id === locator.nodeId)?.anchor ?? null;
  }
  const edge = structure.edges.find((candidate) => candidate.id === locator.edgeId);
  return edge?.anchors[locator.anchorIndex] ?? null;
}

function compareStableIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function closestMatchingStructureNode(
  structure: Pick<Structure, "originNodeId" | "nodes" | "edges">,
  matchingNodeIds: ReadonlySet<string>,
): StructureNode | null {
  if (matchingNodeIds.size === 0) return null;
  const distances = new Map<string, number>([[structure.originNodeId, 0]]);
  const neighbors = new Map(structure.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of structure.edges) {
    neighbors.get(edge.from)?.add(edge.to);
    neighbors.get(edge.to)?.add(edge.from);
  }
  const queue = [structure.originNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    const distance = distances.get(nodeId)!;
    for (const neighbor of neighbors.get(nodeId) ?? []) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distance + 1);
      queue.push(neighbor);
    }
  }
  return (
    structure.nodes
      .filter((node) => matchingNodeIds.has(node.id))
      .sort((left, right) => {
        const leftDistance = distances.get(left.id) ?? Number.POSITIVE_INFINITY;
        const rightDistance = distances.get(right.id) ?? Number.POSITIVE_INFINITY;
        return leftDistance - rightDistance || compareStableIds(left.id, right.id);
      })[0] ?? null
  );
}
