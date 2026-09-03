import type { Structure } from "./models.js";

export interface StructurePoint {
  x: number;
  y: number;
}

export const STRUCTURE_NODE_WIDTH = 228;
export const STRUCTURE_NODE_HEIGHT = 112;

export type StructureGraphContent = Pick<Structure, "originNodeId" | "nodes" | "edges">;
export type DirectionalLink = readonly [from: string, to: string];

export interface SimpleStructureTopology {
  neighbors: ReadonlyMap<string, readonly string[]>;
  links: readonly DirectionalLink[];
  directionalLinks: readonly DirectionalLink[];
}

export interface StructureLayoutDiagnostics {
  columnCount: number;
  rowsPerColumn: number[];
  maxRows: number;
  directionalLinkCount: number;
  nonForwardDirectionalLinkCount: number;
  nonForwardDirectionalLinkRatio: number;
  originOutgoingDirectionalLinkCount: number;
}

export interface StructureAuthoringWarning {
  code:
    | "STRUCTURE_ORIGIN_NO_OUTGOING_DIRECTIONAL_RELATION"
    | "STRUCTURE_LAYOUT_MAX_ROWS_HIGH"
    | "STRUCTURE_LAYOUT_NON_FORWARD_DIRECTIONAL_LINK_RATIO_HIGH";
  message: string;
}

export interface StructureProjection {
  positionsByNodeId: ReadonlyMap<string, StructurePoint>;
  rankByNodeId: ReadonlyMap<string, number>;
  columnIndexByNodeId: ReadonlyMap<string, number>;
  columns: readonly (readonly string[])[];
  directionalLinks: readonly DirectionalLink[];
  diagnostics: StructureLayoutDiagnostics;
}

function stableCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareLinks([leftA, leftB]: DirectionalLink, [rightA, rightB]: DirectionalLink): number {
  const first = stableCompare(leftA, rightA);
  return first === 0 ? stableCompare(leftB, rightB) : first;
}

export function simpleStructureTopology(structure: StructureGraphContent): SimpleStructureTopology {
  const neighborSets = new Map(structure.nodes.map((node) => [node.id, new Set<string>()]));
  const pairNodes = new Map<string, DirectionalLink>();
  const pairDirections = new Map<
    string,
    {
      hasUndirected: boolean;
      directions: Map<string, DirectionalLink>;
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
      directions: new Map<string, DirectionalLink>(),
    };
    if (edge.directed) {
      directions.directions.set(JSON.stringify([edge.from, edge.to]), [edge.from, edge.to]);
    } else {
      directions.hasUndirected = true;
    }
    pairDirections.set(pairKey, directions);
  }
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

function topologyComponents(topology: SimpleStructureTopology): string[][] {
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

function topologyRoot(nodeIds: readonly string[], topology: SimpleStructureTopology): string {
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

function countNonForwardLinks(
  ranks: ReadonlyMap<string, number>,
  directionalLinks: readonly DirectionalLink[],
): number {
  return directionalLinks.reduce((count, [from, to]) => {
    const fromRank = ranks.get(from);
    const toRank = ranks.get(to);
    return count + (fromRank !== undefined && toRank !== undefined && fromRank >= toRank ? 1 : 0);
  }, 0);
}

function normalizedRankIndexes(ranks: ReadonlyMap<string, number>): Map<number, number> {
  return new Map(
    [...new Set(ranks.values())]
      .sort((left, right) => left - right)
      .map((rank, index) => [rank, index]),
  );
}

function totalDirectionalSpan(
  ranks: ReadonlyMap<string, number>,
  directionalLinks: readonly DirectionalLink[],
): number {
  const indexes = normalizedRankIndexes(ranks);
  return directionalLinks.reduce((total, [from, to]) => {
    const fromRank = ranks.get(from);
    const toRank = ranks.get(to);
    if (fromRank === undefined || toRank === undefined) return total;
    return total + Math.abs(indexes.get(fromRank)! - indexes.get(toRank)!);
  }, 0);
}

function compareNumberArrays(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function canonicalTopologyStructuralColors(
  nodeIds: readonly string[],
  topology: SimpleStructureTopology,
  originNodeId: string,
): ReadonlyMap<string, number> {
  const nodeSet = new Set(nodeIds);
  const incomingNeighbors = new Map(nodeIds.map((nodeId) => [nodeId, new Set<string>()]));
  const outgoingNeighbors = new Map(nodeIds.map((nodeId) => [nodeId, new Set<string>()]));
  for (const [from, to] of topology.directionalLinks) {
    if (!nodeSet.has(from) || !nodeSet.has(to)) continue;
    outgoingNeighbors.get(from)?.add(to);
    incomingNeighbors.get(to)?.add(from);
  }
  const ambiguousNeighbors = new Map(
    nodeIds.map((nodeId) => {
      const directionalNeighbors = new Set([
        ...incomingNeighbors.get(nodeId)!,
        ...outgoingNeighbors.get(nodeId)!,
      ]);
      return [
        nodeId,
        new Set(
          (topology.neighbors.get(nodeId) ?? []).filter(
            (neighbor) => nodeSet.has(neighbor) && !directionalNeighbors.has(neighbor),
          ),
        ),
      ];
    }),
  );
  const assignColors = (descriptors: ReadonlyMap<string, string>): Map<string, number> => {
    const colorByDescriptor = new Map(
      [...new Set(descriptors.values())]
        .sort(stableCompare)
        .map((descriptor, index) => [descriptor, index]),
    );
    return new Map(
      nodeIds.map((nodeId) => [nodeId, colorByDescriptor.get(descriptors.get(nodeId)!)!]),
    );
  };
  let colors = assignColors(
    new Map(
      nodeIds.map((nodeId) => [
        nodeId,
        JSON.stringify([
          nodeId === originNodeId ? 1 : 0,
          incomingNeighbors.get(nodeId)!.size,
          outgoingNeighbors.get(nodeId)!.size,
          ambiguousNeighbors.get(nodeId)!.size,
        ]),
      ]),
    ),
  );
  for (let pass = 0; pass < nodeIds.length; pass += 1) {
    const next = assignColors(
      new Map(
        nodeIds.map((nodeId) => [
          nodeId,
          JSON.stringify([
            colors.get(nodeId),
            [...incomingNeighbors.get(nodeId)!]
              .map((neighbor) => colors.get(neighbor)!)
              .sort((left, right) => left - right),
            [...outgoingNeighbors.get(nodeId)!]
              .map((neighbor) => colors.get(neighbor)!)
              .sort((left, right) => left - right),
            [...ambiguousNeighbors.get(nodeId)!]
              .map((neighbor) => colors.get(neighbor)!)
              .sort((left, right) => left - right),
          ]),
        ]),
      ),
    );
    if (nodeIds.every((nodeId) => next.get(nodeId) === colors.get(nodeId))) break;
    colors = next;
  }
  return colors;
}

function chooseRankProposal(
  nodeId: string,
  proposals: ReadonlySet<number>,
  ranks: ReadonlyMap<string, number>,
  directionalLinks: readonly DirectionalLink[],
): number {
  const scored = [...proposals].map((rank) => {
    const candidate = new Map(ranks).set(nodeId, rank);
    return {
      rank,
      nonForward: countNonForwardLinks(candidate, directionalLinks),
      occupiedColumns: new Set(candidate.values()).size,
      span: totalDirectionalSpan(candidate, directionalLinks),
    };
  });
  scored.sort(
    (left, right) =>
      left.nonForward - right.nonForward ||
      left.occupiedColumns - right.occupiedColumns ||
      left.span - right.span ||
      Math.abs(left.rank) - Math.abs(right.rank) ||
      left.rank - right.rank,
  );
  return scored[0]!.rank;
}

function applyForwardWaves(
  nodeSet: ReadonlySet<string>,
  topology: SimpleStructureTopology,
  ranks: Map<string, number>,
): void {
  for (let pass = 0; pass < nodeSet.size; pass += 1) {
    const proposals = new Map<string, Set<number>>();
    for (const [from, to] of topology.directionalLinks) {
      if (!nodeSet.has(from) || !nodeSet.has(to) || ranks.has(to)) continue;
      const fromRank = ranks.get(from);
      if (fromRank === undefined) continue;
      const targetProposals = proposals.get(to) ?? new Set<number>();
      targetProposals.add(fromRank + 1);
      proposals.set(to, targetProposals);
    }
    if (proposals.size === 0) break;
    const accepted = [...proposals]
      .map(
        ([nodeId, nodeProposals]) =>
          [
            nodeId,
            chooseRankProposal(nodeId, nodeProposals, ranks, topology.directionalLinks),
          ] as const,
      )
      .sort(([left], [right]) => stableCompare(left, right));
    for (const [nodeId, rank] of accepted) ranks.set(nodeId, rank);
  }
}

function stronglyConnectedComponents(
  nodeIds: readonly string[],
  directionalLinks: readonly DirectionalLink[],
): string[][] {
  const nodeSet = new Set(nodeIds);
  const outgoing = new Map(nodeIds.map((nodeId) => [nodeId, new Set<string>()]));
  for (const [from, to] of directionalLinks) {
    if (nodeSet.has(from) && nodeSet.has(to)) outgoing.get(from)?.add(to);
  }
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (nodeId: string): void => {
    const nodeIndex = nextIndex;
    nextIndex += 1;
    indexes.set(nodeId, nodeIndex);
    lowLinks.set(nodeId, nodeIndex);
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const neighbor of [...(outgoing.get(nodeId) ?? [])].sort(stableCompare)) {
      if (!indexes.has(neighbor)) {
        visit(neighbor);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, lowLinks.get(neighbor)!));
      } else if (onStack.has(neighbor)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, indexes.get(neighbor)!));
      }
    }

    if (lowLinks.get(nodeId) !== indexes.get(nodeId)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === nodeId) break;
    }
    component.sort(stableCompare);
    components.push(component);
  };

  for (const nodeId of [...nodeIds].sort(stableCompare)) {
    if (!indexes.has(nodeId)) visit(nodeId);
  }
  return components;
}

function internalComponentRanks(
  nodeIds: readonly string[],
  directionalLinks: readonly DirectionalLink[],
  structuralColors: ReadonlyMap<string, number>,
  preferredAnchor: string | null,
  originIncomingBoundaryNodeIds: readonly string[],
  incomingBoundaryNodeIds: readonly string[],
  outgoingBoundaryNodeIds: readonly string[],
  attachmentBoundaryNodeIds: readonly string[],
): Map<string, number> {
  if (nodeIds.length === 1) return new Map([[nodeIds[0]!, 0]]);
  const nodeSet = new Set(nodeIds);
  const internalLinks = directionalLinks.filter(
    ([from, to]) => nodeSet.has(from) && nodeSet.has(to),
  );
  const neighborSets = new Map(nodeIds.map((nodeId) => [nodeId, new Set<string>()]));
  for (const [from, to] of internalLinks) {
    neighborSets.get(from)?.add(to);
    neighborSets.get(to)?.add(from);
  }
  const topology: SimpleStructureTopology = {
    neighbors: new Map(
      [...neighborSets].map(([nodeId, neighbors]) => [nodeId, [...neighbors].sort(stableCompare)]),
    ),
    links: internalLinks,
    directionalLinks: internalLinks,
  };
  const ranksFromAnchor = (anchor: string): Map<string, number> => {
    const rawRanks = new Map([[anchor, 0]]);
    applyForwardWaves(nodeSet, topology, rawRanks);
    const rankIndexes = normalizedRankIndexes(rawRanks);
    return new Map(nodeIds.map((nodeId) => [nodeId, rankIndexes.get(rawRanks.get(nodeId)!) ?? 0]));
  };
  if (preferredAnchor && nodeSet.has(preferredAnchor)) return ranksFromAnchor(preferredAnchor);

  const candidates = nodeIds.map((anchor) => {
    const ranks = ranksFromAnchor(anchor);
    const maxRank = Math.max(...ranks.values());
    const rankLoadProfile = Array.from(
      { length: maxRank + 1 },
      (_, rank) => nodeIds.filter((nodeId) => ranks.get(nodeId) === rank).length,
    );
    const rankStructuralProfile = rankLoadProfile.flatMap((_, rank) => [
      -1,
      ...nodeIds
        .filter((nodeId) => ranks.get(nodeId) === rank)
        .map((nodeId) => structuralColors.get(nodeId)!)
        .sort((left, right) => left - right),
    ]);
    return {
      anchor,
      ranks,
      nonForward: countNonForwardLinks(ranks, internalLinks),
      originIncomingBoundaryRanks: originIncomingBoundaryNodeIds
        .map((nodeId) => ranks.get(nodeId)!)
        .sort((left, right) => right - left),
      incomingBoundaryRanks: incomingBoundaryNodeIds
        .map((nodeId) => ranks.get(nodeId)!)
        .sort((left, right) => right - left),
      outgoingBoundaryDistances: outgoingBoundaryNodeIds
        .map((nodeId) => maxRank - ranks.get(nodeId)!)
        .sort((left, right) => right - left),
      attachmentBoundaryRanks: attachmentBoundaryNodeIds
        .map((nodeId) => ranks.get(nodeId)!)
        .sort((left, right) => right - left),
      width: new Set(ranks.values()).size,
      span: totalDirectionalSpan(ranks, internalLinks),
      rankLoadProfile,
      rankStructuralProfile,
      anchorStructuralColor: structuralColors.get(anchor)!,
    };
  });
  candidates.sort(
    (left, right) =>
      left.nonForward - right.nonForward ||
      compareNumberArrays(left.originIncomingBoundaryRanks, right.originIncomingBoundaryRanks) ||
      compareNumberArrays(left.incomingBoundaryRanks, right.incomingBoundaryRanks) ||
      compareNumberArrays(left.outgoingBoundaryDistances, right.outgoingBoundaryDistances) ||
      compareNumberArrays(left.attachmentBoundaryRanks, right.attachmentBoundaryRanks) ||
      left.width - right.width ||
      left.span - right.span ||
      compareNumberArrays(left.rankLoadProfile, right.rankLoadProfile) ||
      compareNumberArrays(left.rankStructuralProfile, right.rankStructuralProfile) ||
      left.anchorStructuralColor - right.anchorStructuralColor ||
      stableCompare(left.anchor, right.anchor),
  );
  return candidates[0]!.ranks;
}

function directionalCondensationRanks(
  nodeIds: readonly string[],
  topology: SimpleStructureTopology,
  originNodeId: string,
): Map<string, number> {
  const nodeSet = new Set(nodeIds);
  const directionalLinks = topology.directionalLinks.filter(
    ([from, to]) => nodeSet.has(from) && nodeSet.has(to),
  );
  const structuralColors = canonicalTopologyStructuralColors(nodeIds, topology, originNodeId);
  const components = stronglyConnectedComponents(nodeIds, directionalLinks);
  const componentByNodeId = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    for (const nodeId of component) componentByNodeId.set(nodeId, componentIndex);
  });
  const outgoing = new Map(components.map((_, index) => [index, new Set<number>()]));
  const incoming = new Map(components.map((_, index) => [index, new Set<number>()]));
  for (const [from, to] of directionalLinks) {
    const fromComponent = componentByNodeId.get(from)!;
    const toComponent = componentByNodeId.get(to)!;
    if (fromComponent === toComponent) continue;
    outgoing.get(fromComponent)!.add(toComponent);
    incoming.get(toComponent)!.add(fromComponent);
  }

  const originComponent = componentByNodeId.get(originNodeId)!;
  const directionalGroups: number[][] = [];
  const directionalGroupByComponent = new Map<number, number>();
  for (let first = 0; first < components.length; first += 1) {
    if (directionalGroupByComponent.has(first)) continue;
    const groupIndex = directionalGroups.length;
    const group: number[] = [];
    const queue = [first];
    directionalGroupByComponent.set(first, groupIndex);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      group.push(current);
      for (const neighbor of [...outgoing.get(current)!, ...incoming.get(current)!]) {
        if (directionalGroupByComponent.has(neighbor)) continue;
        directionalGroupByComponent.set(neighbor, groupIndex);
        queue.push(neighbor);
      }
    }
    directionalGroups.push(group);
  }

  const directionalGroupByNodeId = new Map<string, number>();
  for (const [nodeId, componentIndex] of componentByNodeId) {
    directionalGroupByNodeId.set(nodeId, directionalGroupByComponent.get(componentIndex)!);
  }
  const attachmentBoundaryNodeIds = new Map(
    components.map((_, componentIndex) => [componentIndex, [] as string[]]),
  );
  for (const [left, right] of topology.links) {
    if (directionalGroupByNodeId.get(left) === directionalGroupByNodeId.get(right)) continue;
    attachmentBoundaryNodeIds.get(componentByNodeId.get(left)!)!.push(left);
    attachmentBoundaryNodeIds.get(componentByNodeId.get(right)!)!.push(right);
  }

  const compareComponents = (left: number, right: number): number =>
    stableCompare(components[left]![0]!, components[right]![0]!);
  const localRanks = new Map<number, ReadonlyMap<string, number>>();
  const componentWidths = new Map<number, number>();
  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    const component = components[componentIndex]!;
    const ranks = internalComponentRanks(
      component,
      directionalLinks,
      structuralColors,
      component.includes(originNodeId) ? originNodeId : null,
      directionalLinks.flatMap(([from, to]) =>
        componentByNodeId.get(from) === originComponent &&
        componentByNodeId.get(to) === componentIndex &&
        componentIndex !== originComponent
          ? [to]
          : [],
      ),
      directionalLinks.flatMap(([from, to]) =>
        componentByNodeId.get(to) === componentIndex &&
        componentByNodeId.get(from) !== componentIndex
          ? [to]
          : [],
      ),
      directionalLinks.flatMap(([from, to]) =>
        componentByNodeId.get(from) === componentIndex &&
        componentByNodeId.get(to) !== componentIndex
          ? [from]
          : [],
      ),
      attachmentBoundaryNodeIds.get(componentIndex)!,
    );
    localRanks.set(componentIndex, ranks);
    componentWidths.set(componentIndex, Math.max(...ranks.values()) + 1);
  }

  const remainingIncoming = new Map(
    components.map((_, componentIndex) => [componentIndex, incoming.get(componentIndex)!.size]),
  );
  const componentStarts = new Map<number, number>();
  const ready = components
    .map((_, componentIndex) => componentIndex)
    .filter((componentIndex) => remainingIncoming.get(componentIndex) === 0)
    .sort(compareComponents);
  for (const componentIndex of ready) componentStarts.set(componentIndex, 0);
  while (ready.length > 0) {
    const current = ready.shift()!;
    for (const target of [...outgoing.get(current)!].sort(compareComponents)) {
      componentStarts.set(
        target,
        Math.max(
          componentStarts.get(target) ?? 0,
          componentStarts.get(current)! + componentWidths.get(current)!,
        ),
      );
      const unresolved = remainingIncoming.get(target)! - 1;
      remainingIncoming.set(target, unresolved);
      if (unresolved === 0) {
        ready.push(target);
        ready.sort(compareComponents);
      }
    }
  }

  const unshiftedRanks = new Map<string, number>();
  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    for (const [nodeId, localRank] of localRanks.get(componentIndex)!) {
      unshiftedRanks.set(nodeId, componentStarts.get(componentIndex)! + localRank);
    }
  }

  const originGroup = directionalGroupByComponent.get(originComponent)!;
  const groupOffsets = new Map<number, number>([[originGroup, -unshiftedRanks.get(originNodeId)!]]);
  while (groupOffsets.size < directionalGroups.length) {
    const proposals = new Map<number, Set<number>>();
    for (const [left, right] of topology.links) {
      const leftGroup = directionalGroupByNodeId.get(left)!;
      const rightGroup = directionalGroupByNodeId.get(right)!;
      if (leftGroup === rightGroup) continue;
      const leftOffset = groupOffsets.get(leftGroup);
      const rightOffset = groupOffsets.get(rightGroup);
      if (leftOffset !== undefined && rightOffset === undefined) {
        const offsets = proposals.get(rightGroup) ?? new Set<number>();
        offsets.add(unshiftedRanks.get(left)! + leftOffset + 1 - unshiftedRanks.get(right)!);
        proposals.set(rightGroup, offsets);
      }
      if (leftOffset === undefined && rightOffset !== undefined) {
        const offsets = proposals.get(leftGroup) ?? new Set<number>();
        offsets.add(unshiftedRanks.get(right)! + rightOffset + 1 - unshiftedRanks.get(left)!);
        proposals.set(leftGroup, offsets);
      }
    }
    if (proposals.size === 0) break;
    const knownGroupOffsets = new Map(groupOffsets);
    const rankedValues = [...unshiftedRanks].flatMap(([nodeId, rank]) => {
      const offset = knownGroupOffsets.get(directionalGroupByNodeId.get(nodeId)!);
      return offset === undefined ? [] : [rank + offset];
    });
    const acceptedOffsets = new Map<number, number>();
    for (const [groupIndex, proposedOffsets] of proposals) {
      const candidates = [...proposedOffsets].map((offset) => {
        const crossGroupSpan = topology.links.reduce((total, [left, right]) => {
          const leftGroup = directionalGroupByNodeId.get(left)!;
          const rightGroup = directionalGroupByNodeId.get(right)!;
          const leftOffset = leftGroup === groupIndex ? offset : knownGroupOffsets.get(leftGroup);
          const rightOffset =
            rightGroup === groupIndex ? offset : knownGroupOffsets.get(rightGroup);
          if (leftOffset === undefined || rightOffset === undefined) return total;
          return (
            total +
            Math.abs(
              unshiftedRanks.get(left)! + leftOffset - unshiftedRanks.get(right)! - rightOffset,
            )
          );
        }, 0);
        const addedRanks = directionalGroups[groupIndex]!.flatMap((componentIndex) =>
          components[componentIndex]!.map((nodeId) => unshiftedRanks.get(nodeId)! + offset),
        );
        return {
          offset,
          crossGroupSpan,
          occupiedColumns: new Set([...rankedValues, ...addedRanks]).size,
        };
      });
      candidates.sort(
        (left, right) =>
          left.crossGroupSpan - right.crossGroupSpan ||
          left.occupiedColumns - right.occupiedColumns ||
          Math.abs(left.offset) - Math.abs(right.offset) ||
          left.offset - right.offset,
      );
      acceptedOffsets.set(groupIndex, candidates[0]!.offset);
    }
    for (const [groupIndex, offset] of acceptedOffsets) groupOffsets.set(groupIndex, offset);
  }

  const ranks = new Map<string, number>();
  for (const [nodeId, rank] of unshiftedRanks) {
    const groupOffset = groupOffsets.get(directionalGroupByNodeId.get(nodeId)!);
    ranks.set(nodeId, rank + (groupOffset ?? 0));
  }
  return ranks;
}

function componentRanks(
  nodeIds: readonly string[],
  topology: SimpleStructureTopology,
  entrypointId: string | null,
): Map<string, number> {
  const nodeSet = new Set(nodeIds);
  const entrypoint = entrypointId && nodeSet.has(entrypointId) ? entrypointId : null;

  if (!entrypoint) {
    const root = topologyRoot(nodeIds, topology);
    const ranks = new Map<string, number>();
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

  const ranks = directionalCondensationRanks(nodeIds, topology, entrypoint);

  // Any topology-only remainder stays discoverable beside its nearest ranked
  // neighbor without turning its ambiguous relation into a directional signal.
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
  topology: SimpleStructureTopology,
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

interface ComponentProjection {
  nodeIds: readonly string[];
  positions: ReadonlyMap<string, StructurePoint>;
  ranks: ReadonlyMap<string, number>;
  width: number;
  height: number;
}

function layoutTopologyComponent(
  nodeIds: readonly string[],
  topology: SimpleStructureTopology,
  entrypointId: string | null,
): ComponentProjection {
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
  const positions = new Map<string, StructurePoint>();
  rankValues.forEach((rank, rankIndex) => {
    const group = groups.get(rank)!;
    const top = centerY - ((group.length - 1) * rowStride) / 2;
    group.forEach((nodeId, rowIndex) => {
      positions.set(nodeId, { x: rankIndex * rankStride, y: top + rowIndex * rowStride });
    });
  });
  return {
    nodeIds,
    positions,
    ranks,
    width: (rankValues.length - 1) * rankStride + STRUCTURE_NODE_WIDTH,
    height: (maxRows - 1) * rowStride + STRUCTURE_NODE_HEIGHT,
  };
}

export function projectStructure(structure: StructureGraphContent): StructureProjection {
  const topology = simpleStructureTopology(structure);
  if (structure.nodes.length === 0) {
    const diagnostics: StructureLayoutDiagnostics = {
      columnCount: 0,
      rowsPerColumn: [],
      maxRows: 0,
      directionalLinkCount: topology.directionalLinks.length,
      nonForwardDirectionalLinkCount: 0,
      nonForwardDirectionalLinkRatio: 0,
      originOutgoingDirectionalLinkCount: 0,
    };
    return {
      positionsByNodeId: new Map(),
      rankByNodeId: new Map(),
      columnIndexByNodeId: new Map(),
      columns: [],
      directionalLinks: topology.directionalLinks,
      diagnostics,
    };
  }

  const componentGap = 180;
  const outerPadding = 64;
  const components = topologyComponents(topology).map((nodeIds) =>
    layoutTopologyComponent(
      nodeIds,
      topology,
      nodeIds.includes(structure.originNodeId) ? structure.originNodeId : null,
    ),
  );
  const totalArea = components.reduce(
    (sum, component) => sum + (component.width + componentGap) * (component.height + componentGap),
    0,
  );
  const targetRowWidth = Math.max(960, Math.sqrt(totalArea) * 1.45);
  const positions = new Map<string, StructurePoint>();
  const ranks = new Map<string, number>();
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
      const point = component.positions.get(nodeId)!;
      positions.set(nodeId, { x: cursorX + point.x, y: cursorY + point.y });
      ranks.set(nodeId, component.ranks.get(nodeId) ?? 0);
    }
    cursorX += component.width + componentGap;
    rowHeight = Math.max(rowHeight, component.height);
  }

  const xValues = [...new Set([...positions.values()].map(({ x }) => x))].sort(
    (left, right) => left - right,
  );
  const columnIndexByX = new Map(xValues.map((x, index) => [x, index]));
  const columns = xValues.map((x) =>
    [...positions]
      .filter(([, point]) => point.x === x)
      .sort(([, left], [, right]) => left.y - right.y)
      .map(([nodeId]) => nodeId),
  );
  const columnIndexByNodeId = new Map(
    [...positions].map(([nodeId, point]) => [nodeId, columnIndexByX.get(point.x)!]),
  );
  const nonForwardDirectionalLinkCount = topology.directionalLinks.reduce(
    (count, [from, to]) =>
      count +
      (columnIndexByNodeId.has(from) &&
      columnIndexByNodeId.has(to) &&
      columnIndexByNodeId.get(from)! >= columnIndexByNodeId.get(to)!
        ? 1
        : 0),
    0,
  );
  const directionalLinkCount = topology.directionalLinks.length;
  const rowsPerColumn = columns.map((column) => column.length);
  const diagnostics: StructureLayoutDiagnostics = {
    columnCount: columns.length,
    rowsPerColumn,
    maxRows: Math.max(0, ...rowsPerColumn),
    directionalLinkCount,
    nonForwardDirectionalLinkCount,
    nonForwardDirectionalLinkRatio:
      directionalLinkCount === 0 ? 0 : nonForwardDirectionalLinkCount / directionalLinkCount,
    originOutgoingDirectionalLinkCount: topology.directionalLinks.filter(
      ([from]) => from === structure.originNodeId,
    ).length,
  };
  return {
    positionsByNodeId: positions,
    rankByNodeId: ranks,
    columnIndexByNodeId,
    columns,
    directionalLinks: topology.directionalLinks,
    diagnostics,
  };
}

export function structureAuthoringWarnings(
  diagnostics: StructureLayoutDiagnostics,
): StructureAuthoringWarning[] {
  const warnings: StructureAuthoringWarning[] = [];
  if (diagnostics.originOutgoingDirectionalLinkCount === 0) {
    warnings.push({
      code: "STRUCTURE_ORIGIN_NO_OUTGOING_DIRECTIONAL_RELATION",
      message:
        "origin has no outgoing unambiguous directed relation; verify that it is the factual code entrypoint for this behavior. A terminal or intermediate origin may still be valid. Do not change factual relation direction solely to remove this warning.",
    });
  }
  if (diagnostics.maxRows >= 8) {
    warnings.push({
      code: "STRUCTURE_LAYOUT_MAX_ROWS_HIGH",
      message:
        "the initial projection has a tall column; reconsider the factual origin, node granularity, overlapping or nested claims, whether multiple behaviors are mixed, and the subject boundary.",
    });
  }
  if (diagnostics.nonForwardDirectionalLinkRatio >= 0.25) {
    warnings.push({
      code: "STRUCTURE_LAYOUT_NON_FORWARD_DIRECTIONAL_LINK_RATIO_HIGH",
      message:
        "many unambiguous directed relations are non-forward in the initial projection; reconsider the factual origin, node granularity, behavior boundary, and subject boundary. A factual graph may remain above this threshold. Do not change edge direction solely to improve the score.",
    });
  }
  return warnings;
}
