import type { Structure } from "./models.js";

export interface StructurePoint {
  x: number;
  y: number;
}

export const STRUCTURE_NODE_WIDTH = 228;
export const STRUCTURE_NODE_HEIGHT = 112;
export const STRUCTURE_REGION_PADDING_X = 32;
export const STRUCTURE_REGION_PADDING_TOP = 38;
export const STRUCTURE_REGION_PADDING_BOTTOM = 28;

export type StructureGraphContent = Pick<Structure, "originNodeId" | "nodes" | "edges"> &
  Partial<Pick<Structure, "presentation">>;
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
  /**
   * Diagnostics for this projection's own positions and columns. Factual authoring feedback must
   * use `projectTopologyStructure` so an authorial reading direction cannot rewrite graph health.
   */
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

const PRESENTATION_RANK_GAP = 196;
const PRESENTATION_ROW_STRIDE = STRUCTURE_NODE_HEIGHT + 72;
const PRESENTATION_COLUMN_STRIDE = STRUCTURE_NODE_WIDTH + 64;
const PRESENTATION_NODE_GAP_X = 44;
const PRESENTATION_NODE_GAP_Y = 52;
const PRESENTATION_REGION_GAP_X = 64;
const PRESENTATION_REGION_GAP_Y = 64;
const PRESENTATION_RANK_BAND_ROW_GAP = PRESENTATION_ROW_STRIDE;
const PRESENTATION_TARGET_ASPECT_RATIO = 5 / 3;
const PRESENTATION_ACCEPTABLE_EXTENT_RATIO = 1.1;
const PRESENTATION_COMPOUND_TARGET_ASPECT_RATIO = 1.85;
const PRESENTATION_MAX_BOUNDARY_ALIGNMENT_BASES = 16;

interface PresentationEnvelope {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function presentationPositionOverlaps(
  occupied: readonly StructurePoint[],
  candidate: StructurePoint,
): boolean {
  return occupied.some(
    (point) =>
      candidate.x < point.x + STRUCTURE_NODE_WIDTH + PRESENTATION_NODE_GAP_X &&
      candidate.x + STRUCTURE_NODE_WIDTH + PRESENTATION_NODE_GAP_X > point.x &&
      candidate.y < point.y + STRUCTURE_NODE_HEIGHT + PRESENTATION_NODE_GAP_Y &&
      candidate.y + STRUCTURE_NODE_HEIGHT + PRESENTATION_NODE_GAP_Y > point.y,
  );
}

function presentationPositionIntersectsEnvelope(
  candidate: StructurePoint,
  envelope: PresentationEnvelope,
): boolean {
  return !(
    candidate.x + STRUCTURE_NODE_WIDTH <= envelope.left ||
    candidate.x >= envelope.right ||
    candidate.y + STRUCTURE_NODE_HEIGHT <= envelope.top ||
    candidate.y >= envelope.bottom
  );
}

function presentationPositionIsOpen(
  occupied: readonly StructurePoint[],
  candidate: StructurePoint,
  forbiddenEnvelopes: readonly PresentationEnvelope[],
): boolean {
  return (
    !presentationPositionOverlaps(occupied, candidate) &&
    !forbiddenEnvelopes.some((envelope) =>
      presentationPositionIntersectsEnvelope(candidate, envelope),
    )
  );
}

function presentationSegmentIntersectsNode(
  start: StructurePoint,
  end: StructurePoint,
  node: StructurePoint,
): boolean {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  let minimum = 0;
  let maximum = 1;
  for (const [origin, delta, low, high] of [
    [start.x, deltaX, node.x, node.x + STRUCTURE_NODE_WIDTH],
    [start.y, deltaY, node.y, node.y + STRUCTURE_NODE_HEIGHT],
  ] as const) {
    if (Math.abs(delta) < 0.000_001) {
      if (origin < low || origin > high) return false;
      continue;
    }
    const first = (low - origin) / delta;
    const second = (high - origin) / delta;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (minimum > maximum) return false;
  }
  return maximum >= 0 && minimum <= 1;
}

function firstOpenPresentationPoint(
  occupied: readonly StructurePoint[],
  anchor: StructurePoint,
  forbiddenEnvelopes: readonly PresentationEnvelope[] = [],
  preferredDirection: "above" | "below" | "left" | "right" | "either" = "either",
): StructurePoint {
  if (presentationPositionIsOpen(occupied, anchor, forbiddenEnvelopes)) return anchor;
  for (let radius = 1; radius <= 80; radius += 1) {
    const rowOrder =
      preferredDirection === "above"
        ? [-radius, radius]
        : preferredDirection === "below"
          ? [radius, -radius]
          : [-radius, radius];
    for (const row of rowOrder) {
      for (let column = -radius; column <= radius; column += 1) {
        const candidate = {
          x: anchor.x + column * PRESENTATION_COLUMN_STRIDE,
          y: anchor.y + row * PRESENTATION_ROW_STRIDE,
        };
        if (presentationPositionIsOpen(occupied, candidate, forbiddenEnvelopes)) return candidate;
      }
    }
    const columnOrder =
      preferredDirection === "left"
        ? [-radius, radius]
        : preferredDirection === "right"
          ? [radius, -radius]
          : [-radius, radius];
    for (const column of columnOrder) {
      for (let row = -radius + 1; row < radius; row += 1) {
        if (row === 0) continue;
        const candidate = {
          x: anchor.x + column * PRESENTATION_COLUMN_STRIDE,
          y: anchor.y + row * PRESENTATION_ROW_STRIDE,
        };
        if (presentationPositionIsOpen(occupied, candidate, forbiddenEnvelopes)) return candidate;
      }
    }
  }
  return {
    x: anchor.x,
    y: anchor.y + (occupied.length + 1) * PRESENTATION_ROW_STRIDE,
  };
}

function presentationEnvelope(points: readonly StructurePoint[]): PresentationEnvelope | null {
  if (points.length === 0) return null;
  return {
    left: Math.min(...points.map(({ x }) => x)) - STRUCTURE_REGION_PADDING_X,
    top: Math.min(...points.map(({ y }) => y)) - STRUCTURE_REGION_PADDING_TOP,
    right:
      Math.max(...points.map(({ x }) => x + STRUCTURE_NODE_WIDTH)) + STRUCTURE_REGION_PADDING_X,
    bottom:
      Math.max(...points.map(({ y }) => y + STRUCTURE_NODE_HEIGHT)) +
      STRUCTURE_REGION_PADDING_BOTTOM,
  };
}

function presentationNodeEnvelope(points: readonly StructurePoint[]): PresentationEnvelope | null {
  if (points.length === 0) return null;
  return {
    left: Math.min(...points.map(({ x }) => x)),
    top: Math.min(...points.map(({ y }) => y)),
    right: Math.max(...points.map(({ x }) => x + STRUCTURE_NODE_WIDTH)),
    bottom: Math.max(...points.map(({ y }) => y + STRUCTURE_NODE_HEIGHT)),
  };
}

function presentationGridDimensions(nodeCount: number): { columns: number; rows: number } {
  const columns = Math.max(
    1,
    Math.ceil(Math.sqrt((nodeCount * PRESENTATION_ROW_STRIDE) / PRESENTATION_COLUMN_STRIDE)),
  );
  return { columns, rows: Math.max(1, Math.ceil(nodeCount / columns)) };
}

interface PresentationRankBand {
  nodeIds: readonly string[];
  columns: number;
  rows: number;
  width: number;
  height: number;
}

interface PresentationRankBandPacking {
  positions: ReadonlyMap<string, StructurePoint>;
  normalizedExtent: number;
  relationSpan: number;
  area: number;
  rowSizes: readonly number[];
}

function presentationEnvelopesOverlap(
  left: PresentationEnvelope,
  right: PresentationEnvelope,
): boolean {
  return !(
    left.right <= right.left ||
    right.right <= left.left ||
    left.bottom <= right.top ||
    right.bottom <= left.top
  );
}

function presentationBandRowPartitions<T>(values: readonly T[]): T[][][] {
  if (values.length === 0) return [[]];
  const result: T[][][] = [];
  for (let rowSize = 1; rowSize <= values.length; rowSize += 1) {
    const row = values.slice(0, rowSize);
    for (const remaining of presentationBandRowPartitions(values.slice(rowSize))) {
      result.push([row, ...remaining]);
    }
  }
  return result;
}

function presentationUniformBandRows<T>(values: readonly T[], rowSize: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / rowSize) }, (_, index) =>
    values.slice(index * rowSize, (index + 1) * rowSize),
  );
}

function comparePresentationRankBandPackings(
  left: PresentationRankBandPacking,
  right: PresentationRankBandPacking,
): number {
  return (
    left.relationSpan - right.relationSpan ||
    left.normalizedExtent - right.normalizedExtent ||
    left.area - right.area ||
    compareNumberArrays(left.rowSizes, right.rowSizes)
  );
}

function presentationRankBandPositions(input: {
  rankValues: readonly number[];
  rankGroups: ReadonlyMap<number, readonly string[]>;
  relationEdges: readonly StructureGraphContent["edges"][number][];
  preserveShortSequence: boolean;
}): ReadonlyMap<string, StructurePoint> {
  const { rankValues, rankGroups, relationEdges, preserveShortSequence } = input;
  const bands = rankValues.map((rank): PresentationRankBand => {
    const nodeIds = rankGroups.get(rank)!;
    const { columns, rows } = presentationGridDimensions(nodeIds.length);
    return {
      nodeIds,
      columns,
      rows,
      width: (columns - 1) * PRESENTATION_COLUMN_STRIDE + STRUCTURE_NODE_WIDTH,
      height: (rows - 1) * PRESENTATION_ROW_STRIDE + STRUCTURE_NODE_HEIGHT,
    };
  });
  const partitions =
    preserveShortSequence && bands.length < 6
      ? [[bands]]
      : bands.length <= 12
        ? presentationBandRowPartitions(bands)
        : Array.from({ length: bands.length }, (_, index) =>
            presentationUniformBandRows(bands, index + 1),
          );
  const packings: PresentationRankBandPacking[] = [];
  for (const rows of partitions) {
    const positions = new Map<string, StructurePoint>();
    let turnX = 0;
    let cursorY = 0;
    for (const [rowIndex, row] of rows.entries()) {
      const rowHeight = Math.max(...row.map(({ height }) => height));
      const leftToRight = rowIndex % 2 === 0;
      let cursorX = turnX;
      for (const band of row) {
        const bandLeft = leftToRight ? cursorX : cursorX - band.width;
        const bandTop = cursorY + (rowHeight - band.height) / 2;
        band.nodeIds.forEach((nodeId, index) => {
          positions.set(nodeId, {
            x: bandLeft + Math.floor(index / band.rows) * PRESENTATION_COLUMN_STRIDE,
            y: bandTop + (index % band.rows) * PRESENTATION_ROW_STRIDE,
          });
        });
        cursorX = leftToRight
          ? bandLeft + band.width + PRESENTATION_RANK_GAP
          : bandLeft - PRESENTATION_RANK_GAP;
      }
      turnX = leftToRight ? cursorX - PRESENTATION_RANK_GAP : cursorX + PRESENTATION_RANK_GAP;
      cursorY += rowHeight + PRESENTATION_RANK_BAND_ROW_GAP;
    }
    const points = [...positions.values()];
    const left = Math.min(...points.map(({ x }) => x));
    const right = Math.max(...points.map(({ x }) => x + STRUCTURE_NODE_WIDTH));
    const top = Math.min(...points.map(({ y }) => y));
    const bottom = Math.max(...points.map(({ y }) => y + STRUCTURE_NODE_HEIGHT));
    const width = right - left;
    const height = bottom - top;
    const relationSpan = relationEdges.reduce((total, edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      return from && to ? total + Math.abs(from.x - to.x) + Math.abs(from.y - to.y) : total;
    }, 0);
    packings.push({
      positions,
      normalizedExtent: Math.max(width / PRESENTATION_TARGET_ASPECT_RATIO, height),
      relationSpan,
      area: width * height,
      rowSizes: rows.map((row) => row.length),
    });
  }
  const minimumNormalizedExtent = Math.min(
    ...packings.map(({ normalizedExtent }) => normalizedExtent),
  );
  const acceptablePackings = packings.filter(
    ({ normalizedExtent }) =>
      normalizedExtent <= minimumNormalizedExtent * PRESENTATION_ACCEPTABLE_EXTENT_RATIO,
  );
  acceptablePackings.sort(comparePresentationRankBandPackings);
  return acceptablePackings[0]!.positions;
}

interface PresentationRegionRelation {
  regionIds: readonly [string, string];
  hasBackboneEdge: boolean;
  directedFrom: string | null;
  directedTo: string | null;
}

interface PresentationRegionPlan {
  id: string;
  members: readonly string[];
  columns: number;
  rows: number;
  width: number;
  height: number;
  envelopeWidth: number;
  envelopeHeight: number;
}

interface PresentationRegionGridCell {
  column: number;
  row: number;
}

interface PresentationRegionPacking {
  plans: readonly PresentationRegionPlan[];
  cellByRegionId: ReadonlyMap<string, PresentationRegionGridCell>;
  topLeftByRegionId: ReadonlyMap<string, StructurePoint>;
}

function presentationRegionRelations(input: {
  structure: StructureGraphContent;
  regionByNodeId: ReadonlyMap<string, string>;
  backboneEdgeIds: ReadonlySet<string>;
}): PresentationRegionRelation[] {
  const { structure, regionByNodeId, backboneEdgeIds } = input;
  const pairs = new Map<
    string,
    {
      regionIds: [string, string];
      hasBackboneEdge: boolean;
      hasUndirected: boolean;
      directions: Set<string>;
    }
  >();
  for (const edge of [...structure.edges].sort((left, right) => stableCompare(left.id, right.id))) {
    const fromRegionId = regionByNodeId.get(edge.from);
    const toRegionId = regionByNodeId.get(edge.to);
    if (!fromRegionId || !toRegionId || fromRegionId === toRegionId) continue;
    const regionIds = [fromRegionId, toRegionId].sort(stableCompare) as [string, string];
    const key = JSON.stringify(regionIds);
    const pair = pairs.get(key) ?? {
      regionIds,
      hasBackboneEdge: false,
      hasUndirected: false,
      directions: new Set<string>(),
    };
    pair.hasBackboneEdge ||= backboneEdgeIds.has(edge.id);
    if (edge.directed) pair.directions.add(JSON.stringify([fromRegionId, toRegionId]));
    else pair.hasUndirected = true;
    pairs.set(key, pair);
  }
  return [...pairs.values()]
    .sort((left, right) => {
      const first = stableCompare(left.regionIds[0], right.regionIds[0]);
      return first === 0 ? stableCompare(left.regionIds[1], right.regionIds[1]) : first;
    })
    .map((pair) => {
      const direction =
        !pair.hasUndirected && pair.directions.size === 1
          ? (JSON.parse([...pair.directions][0]!) as [string, string])
          : null;
      return {
        regionIds: pair.regionIds,
        hasBackboneEdge: pair.hasBackboneEdge,
        directedFrom: direction?.[0] ?? null,
        directedTo: direction?.[1] ?? null,
      };
    });
}

function comparePresentationRegionCells(
  left: PresentationRegionGridCell,
  right: PresentationRegionGridCell,
): number {
  return left.row - right.row || left.column - right.column;
}

function presentationRegionPacking(input: {
  structure: StructureGraphContent;
  regionByNodeId: ReadonlyMap<string, string>;
  backboneEdgeIds: ReadonlySet<string>;
  startNodeId: string;
}): PresentationRegionPacking {
  const { structure, regionByNodeId, backboneEdgeIds, startNodeId } = input;
  const validNodeIds = new Set(structure.nodes.map(({ id }) => id));
  const plans = [...structure.presentation!.regions]
    .sort((left, right) => stableCompare(left.id, right.id))
    .map((region): PresentationRegionPlan => {
      const members = [
        ...new Set(region.nodeIds.filter((nodeId) => validNodeIds.has(nodeId))),
      ].sort(stableCompare);
      const { columns, rows } = presentationGridDimensions(members.length);
      const width = (columns - 1) * PRESENTATION_COLUMN_STRIDE + STRUCTURE_NODE_WIDTH;
      const height = (rows - 1) * PRESENTATION_ROW_STRIDE + STRUCTURE_NODE_HEIGHT;
      return {
        id: region.id,
        members,
        columns,
        rows,
        width,
        height,
        envelopeWidth: width + 2 * STRUCTURE_REGION_PADDING_X,
        envelopeHeight: height + STRUCTURE_REGION_PADDING_TOP + STRUCTURE_REGION_PADDING_BOTTOM,
      };
    });
  if (plans.length === 0) {
    return { plans, cellByRegionId: new Map(), topLeftByRegionId: new Map() };
  }

  const relations = presentationRegionRelations({ structure, regionByNodeId, backboneEdgeIds });
  const relationByPair = new Map(
    relations.map((relation) => [JSON.stringify(relation.regionIds), relation]),
  );
  const neighbors = new Map(plans.map(({ id }) => [id, new Map<string, number>()]));
  for (const relation of relations) {
    const [first, second] = relation.regionIds;
    const weight = relation.hasBackboneEdge ? 3 : 1;
    neighbors.get(first)?.set(second, weight);
    neighbors.get(second)?.set(first, weight);
  }
  const startRegionId = regionByNodeId.get(startNodeId);
  const degree = (regionId: string): number =>
    [...(neighbors.get(regionId)?.values() ?? [])].reduce((sum, weight) => sum + weight, 0);
  const canonicalPlacementOrder = (): string[] => {
    const unplaced = new Set(plans.map(({ id }) => id));
    const placed = new Set<string>();
    const result: string[] = [];
    while (unplaced.size > 0) {
      const next = [...unplaced].sort((left, right) => {
        if (result.length === 0 && startRegionId) {
          if (left === startRegionId) return -1;
          if (right === startRegionId) return 1;
        }
        const leftPlacedAffinity = [...(neighbors.get(left) ?? [])].reduce(
          (sum, [neighbor, weight]) => sum + (placed.has(neighbor) ? weight : 0),
          0,
        );
        const rightPlacedAffinity = [...(neighbors.get(right) ?? [])].reduce(
          (sum, [neighbor, weight]) => sum + (placed.has(neighbor) ? weight : 0),
          0,
        );
        return (
          rightPlacedAffinity - leftPlacedAffinity ||
          degree(right) - degree(left) ||
          stableCompare(left, right)
        );
      })[0]!;
      result.push(next);
      unplaced.delete(next);
      placed.add(next);
    }
    return result;
  };
  const placementOrder = canonicalPlacementOrder();
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const candidatePackings: Array<{
    cellByRegionId: ReadonlyMap<string, PresentationRegionGridCell>;
    topLeftByRegionId: ReadonlyMap<string, StructurePoint>;
    score: number;
    width: number;
    height: number;
    signature: string;
  }> = [];
  const maximumColumnCount = Math.min(plans.length, Math.ceil(Math.sqrt(plans.length * 3)));
  for (let columnCount = 1; columnCount <= maximumColumnCount; columnCount += 1) {
    const rowCount = Math.ceil(plans.length / columnCount);
    const availableCells: PresentationRegionGridCell[] = Array.from(
      { length: plans.length },
      (_, index) => ({ column: index % columnCount, row: Math.floor(index / columnCount) }),
    );
    const cellByRegionId = new Map<string, PresentationRegionGridCell>();
    for (const [placementIndex, regionId] of placementOrder.entries()) {
      const cell = [...availableCells].sort((left, right) => {
        if (placementIndex === 0) {
          return (
            left.column - right.column ||
            Math.abs(left.row - (rowCount - 1) / 2) - Math.abs(right.row - (rowCount - 1) / 2) ||
            left.row - right.row
          );
        }
        const score = (candidate: PresentationRegionGridCell) => {
          let relationDistance = 0;
          let directionalPenalty = 0;
          let connectedWeight = 0;
          for (const [neighborId, weight] of neighbors.get(regionId) ?? []) {
            const neighborCell = cellByRegionId.get(neighborId);
            if (!neighborCell) continue;
            connectedWeight += weight;
            relationDistance +=
              weight *
              (Math.abs(candidate.column - neighborCell.column) +
                Math.abs(candidate.row - neighborCell.row));
            const relation = relationByPair.get(
              JSON.stringify([regionId, neighborId].sort(stableCompare)),
            );
            if (relation?.directedFrom === neighborId && candidate.column < neighborCell.column) {
              directionalPenalty += 1;
            }
            if (relation?.directedTo === neighborId && candidate.column > neighborCell.column) {
              directionalPenalty += 1;
            }
          }
          const distanceToPlaced = Math.min(
            ...[...cellByRegionId.values()].map(
              (placedCell) =>
                Math.abs(candidate.column - placedCell.column) +
                Math.abs(candidate.row - placedCell.row),
            ),
          );
          return {
            disconnected: connectedWeight === 0 ? 1 : 0,
            directionalPenalty,
            relationDistance,
            distanceToPlaced,
          };
        };
        const leftScore = score(left);
        const rightScore = score(right);
        return (
          leftScore.disconnected - rightScore.disconnected ||
          leftScore.directionalPenalty - rightScore.directionalPenalty ||
          leftScore.relationDistance - rightScore.relationDistance ||
          leftScore.distanceToPlaced - rightScore.distanceToPlaced ||
          comparePresentationRegionCells(left, right)
        );
      })[0]!;
      cellByRegionId.set(regionId, cell);
      availableCells.splice(availableCells.indexOf(cell), 1);
    }

    const columnWidths = Array.from({ length: columnCount }, (_, column) =>
      Math.max(
        0,
        ...[...cellByRegionId].flatMap(([regionId, cell]) =>
          cell.column === column ? [planById.get(regionId)!.envelopeWidth] : [],
        ),
      ),
    );
    const rowHeights = Array.from({ length: rowCount }, (_, row) =>
      Math.max(
        0,
        ...[...cellByRegionId].flatMap(([regionId, cell]) =>
          cell.row === row ? [planById.get(regionId)!.envelopeHeight] : [],
        ),
      ),
    );
    const columnLefts = columnWidths.map((_, column) =>
      columnWidths
        .slice(0, column)
        .reduce((sum, width) => sum + width + PRESENTATION_REGION_GAP_X, 0),
    );
    const rowTops = rowHeights.map((_, row) =>
      rowHeights.slice(0, row).reduce((sum, height) => sum + height + PRESENTATION_REGION_GAP_Y, 0),
    );
    const topLeftByRegionId = new Map(
      [...cellByRegionId].map(([regionId, cell]) => {
        const plan = planById.get(regionId)!;
        return [
          regionId,
          {
            x: columnLefts[cell.column]! + (columnWidths[cell.column]! - plan.envelopeWidth) / 2,
            y: rowTops[cell.row]! + (rowHeights[cell.row]! - plan.envelopeHeight) / 2,
          },
        ];
      }),
    );
    const width =
      columnWidths.reduce((sum, value) => sum + value, 0) +
      Math.max(0, columnCount - 1) * PRESENTATION_REGION_GAP_X;
    const height =
      rowHeights.reduce((sum, value) => sum + value, 0) +
      Math.max(0, rowCount - 1) * PRESENTATION_REGION_GAP_Y;
    const center = (regionId: string): StructurePoint => {
      const plan = planById.get(regionId)!;
      const topLeft = topLeftByRegionId.get(regionId)!;
      return {
        x: topLeft.x + plan.envelopeWidth / 2,
        y: topLeft.y + plan.envelopeHeight / 2,
      };
    };
    const totalRelationSpan = relations.reduce((sum, relation) => {
      const first = center(relation.regionIds[0]);
      const second = center(relation.regionIds[1]);
      return sum + Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
    }, 0);
    const directionViolations = relations.filter((relation) => {
      if (!relation.directedFrom || !relation.directedTo) return false;
      return center(relation.directedFrom).x > center(relation.directedTo).x;
    }).length;
    const averageRelationSpan = relations.length === 0 ? 0 : totalRelationSpan / relations.length;
    candidatePackings.push({
      cellByRegionId,
      topLeftByRegionId,
      score:
        Math.max(width / PRESENTATION_TARGET_ASPECT_RATIO, height) +
        averageRelationSpan * 0.35 +
        directionViolations * 240,
      width,
      height,
      signature: plans
        .map(({ id }) => {
          const cell = cellByRegionId.get(id)!;
          return `${id}:${cell.column},${cell.row}`;
        })
        .join("|"),
    });
  }
  candidatePackings.sort(
    (left, right) =>
      left.score - right.score ||
      left.width * left.height - right.width * right.height ||
      stableCompare(left.signature, right.signature),
  );
  return { plans, ...candidatePackings[0]! };
}

function presentationRegionMemberOrder(input: {
  members: readonly string[];
  columns: number;
  rows: number;
  regionId: string;
  startNodeId: string;
  regionByNodeId: ReadonlyMap<string, string>;
  regionCellById: ReadonlyMap<string, PresentationRegionGridCell>;
  topology: SimpleStructureTopology;
  relationEdges: readonly StructureGraphContent["edges"][number][];
  backboneEdgeIds: ReadonlySet<string>;
}): Array<{ index: number; nodeId: string }> {
  const {
    members,
    columns,
    rows,
    regionId,
    startNodeId,
    regionByNodeId,
    regionCellById,
    topology,
    relationEdges,
    backboneEdgeIds,
  } = input;
  const ownCell = regionCellById.get(regionId) ?? { column: 0, row: 0 };
  const memberSet = new Set(members);
  const internalLinks = topology.links.filter(
    ([from, to]) => memberSet.has(from) && memberSet.has(to),
  );
  const internalPairKey = (from: string, to: string): string =>
    JSON.stringify([from, to].sort(stableCompare));
  const internalLinkWeights = new Map<string, number>();
  for (const [from, to] of internalLinks) {
    internalLinkWeights.set(internalPairKey(from, to), 1);
  }
  for (const edge of relationEdges) {
    if (
      edge.from === edge.to ||
      !memberSet.has(edge.from) ||
      !memberSet.has(edge.to) ||
      !backboneEdgeIds.has(edge.id)
    ) {
      continue;
    }
    const key = internalPairKey(edge.from, edge.to);
    if (internalLinkWeights.has(key)) internalLinkWeights.set(key, 3);
  }
  const internalBackboneLinks = internalLinks.filter(
    ([from, to]) => (internalLinkWeights.get(internalPairKey(from, to)) ?? 1) > 1,
  );
  const internalNeighbors = new Map(members.map((nodeId) => [nodeId, new Map<string, number>()]));
  for (const [from, to] of internalLinks) {
    const weight = internalLinkWeights.get(internalPairKey(from, to)) ?? 1;
    internalNeighbors.get(from)?.set(to, weight);
    internalNeighbors.get(to)?.set(from, weight);
  }
  const directionalIncoming = new Map(members.map((nodeId) => [nodeId, 0]));
  const directionalOutgoing = new Map(members.map((nodeId) => [nodeId, 0]));
  for (const [from, to] of topology.directionalLinks) {
    if (!memberSet.has(from) || !memberSet.has(to)) continue;
    directionalOutgoing.set(from, directionalOutgoing.get(from)! + 1);
    directionalIncoming.set(to, directionalIncoming.get(to)! + 1);
  }
  const affinity = new Map(
    members.map((nodeId) => {
      const adjacentCells: PresentationRegionGridCell[] = [];
      let externalNeighborCount = 0;
      for (const neighbor of topology.neighbors.get(nodeId) ?? []) {
        const neighborRegionId = regionByNodeId.get(neighbor);
        const cell = neighborRegionId ? regionCellById.get(neighborRegionId) : undefined;
        if (neighborRegionId && neighborRegionId !== regionId && cell) adjacentCells.push(cell);
        else if (!neighborRegionId) externalNeighborCount += 1;
      }
      const horizontal = adjacentCells.reduce((sum, cell) => sum + cell.column - ownCell.column, 0);
      const vertical = adjacentCells.reduce((sum, cell) => sum + cell.row - ownCell.row, 0);
      return [
        nodeId,
        {
          count: adjacentCells.length + externalNeighborCount,
          adjacentRegionCount: adjacentCells.length,
          externalNeighborCount,
          horizontal,
          vertical,
        },
      ] as const;
    }),
  );
  const cells = Array.from({ length: columns * rows }, (_, index) => ({
    index,
    column: index % columns,
    row: Math.floor(index / columns),
  }));
  const assignment = new Map<number, string>();
  const assignedNodeIds = new Set<string>();
  const unassignedNodeIds = new Set(members);
  const internalWeight = (nodeId: string): number =>
    [...(internalNeighbors.get(nodeId)?.values() ?? [])].reduce((sum, weight) => sum + weight, 0);
  const placedNeighborWeight = (nodeId: string): number =>
    [...(internalNeighbors.get(nodeId) ?? [])].reduce(
      (sum, [neighbor, weight]) => sum + (assignedNodeIds.has(neighbor) ? weight : 0),
      0,
    );
  while (unassignedNodeIds.size > 0) {
    const nodeId = [...unassignedNodeIds].sort((left, right) => {
      const leftAffinity = affinity.get(left)!;
      const rightAffinity = affinity.get(right)!;
      return (
        placedNeighborWeight(right) - placedNeighborWeight(left) ||
        rightAffinity.count - leftAffinity.count ||
        internalWeight(right) - internalWeight(left) ||
        Number(right === startNodeId) - Number(left === startNodeId) ||
        directionalIncoming.get(left)! - directionalIncoming.get(right)! ||
        directionalOutgoing.get(right)! - directionalOutgoing.get(left)! ||
        stableCompare(left, right)
      );
    })[0]!;
    const { adjacentRegionCount, externalNeighborCount, horizontal, vertical } =
      affinity.get(nodeId)!;
    const desiredColumn =
      adjacentRegionCount === 0 || horizontal === 0
        ? (columns - 1) / 2
        : horizontal > 0
          ? columns - 1
          : 0;
    const desiredRow =
      adjacentRegionCount === 0 || vertical === 0 ? (rows - 1) / 2 : vertical > 0 ? rows - 1 : 0;
    const distanceToPerimeter = (cell: PresentationRegionGridCell): number =>
      Math.min(cell.column, columns - 1 - cell.column, cell.row, rows - 1 - cell.row);
    const placedCellByNodeId = new Map(
      [...assignment].map(([index, assignedNodeId]) => [
        assignedNodeId,
        { column: index % columns, row: Math.floor(index / columns) },
      ]),
    );
    const relationDistance = (cell: PresentationRegionGridCell): number =>
      [...(internalNeighbors.get(nodeId) ?? [])].reduce((sum, [neighbor, weight]) => {
        const neighborCell = placedCellByNodeId.get(neighbor);
        return neighborCell
          ? sum +
              weight *
                (Math.abs(cell.column - neighborCell.column) +
                  Math.abs(cell.row - neighborCell.row))
          : sum;
      }, 0);
    const cell = [...cells].sort(
      (left, right) =>
        externalNeighborCount * (distanceToPerimeter(left) - distanceToPerimeter(right)) ||
        relationDistance(left) - relationDistance(right) ||
        Math.abs(left.column - desiredColumn) +
          Math.abs(left.row - desiredRow) -
          Math.abs(right.column - desiredColumn) -
          Math.abs(right.row - desiredRow) ||
        left.row - right.row ||
        left.column - right.column,
    )[0]!;
    assignment.set(cell.index, nodeId);
    cells.splice(cells.indexOf(cell), 1);
    assignedNodeIds.add(nodeId);
    unassignedNodeIds.delete(nodeId);
  }
  const initial = Array.from<string | null>({ length: columns * rows }).fill(null);
  for (const [index, nodeId] of assignment) initial[index] = nodeId;
  const cellForIndex = (index: number): PresentationRegionGridCell => ({
    column: index % columns,
    row: Math.floor(index / columns),
  });
  const properCrossing = (
    leftFrom: PresentationRegionGridCell,
    leftTo: PresentationRegionGridCell,
    rightFrom: PresentationRegionGridCell,
    rightTo: PresentationRegionGridCell,
  ): boolean => {
    const orientation = (
      first: PresentationRegionGridCell,
      second: PresentationRegionGridCell,
      third: PresentationRegionGridCell,
    ): number =>
      (second.column - first.column) * (third.row - first.row) -
      (second.row - first.row) * (third.column - first.column);
    const first = orientation(leftFrom, leftTo, rightFrom);
    const second = orientation(leftFrom, leftTo, rightTo);
    const third = orientation(rightFrom, rightTo, leftFrom);
    const fourth = orientation(rightFrom, rightTo, leftTo);
    return first * second < 0 && third * fourth < 0;
  };
  const score = (ordered: readonly (string | null)[]) => {
    const indexByNodeId = new Map(
      ordered.flatMap((nodeId, index) => (nodeId === null ? [] : [[nodeId, index] as const])),
    );
    const linkWeight = (from: string, to: string): number =>
      internalLinkWeights.get(internalPairKey(from, to)) ?? 1;
    const internalCrossings = internalLinks.reduce((count, [leftFromId, leftToId], index) => {
      const leftFrom = cellForIndex(indexByNodeId.get(leftFromId)!);
      const leftTo = cellForIndex(indexByNodeId.get(leftToId)!);
      return (
        count +
        internalLinks.slice(index + 1).reduce((crossingWeight, [rightFromId, rightToId]) => {
          if (
            leftFromId === rightFromId ||
            leftFromId === rightToId ||
            leftToId === rightFromId ||
            leftToId === rightToId
          ) {
            return crossingWeight;
          }
          return properCrossing(
            leftFrom,
            leftTo,
            cellForIndex(indexByNodeId.get(rightFromId)!),
            cellForIndex(indexByNodeId.get(rightToId)!),
          )
            ? crossingWeight + linkWeight(leftFromId, leftToId) * linkWeight(rightFromId, rightToId)
            : crossingWeight;
        }, 0)
      );
    }, 0);
    const externalBoundaryDistance = ordered.reduce((total, nodeId, index) => {
      if (nodeId === null) return total;
      const cell = cellForIndex(index);
      return (
        total +
        (topology.neighbors.get(nodeId) ?? []).reduce((distance, neighbor) => {
          const neighborRegionId = regionByNodeId.get(neighbor);
          const neighborCell = neighborRegionId ? regionCellById.get(neighborRegionId) : undefined;
          if (!neighborRegionId) {
            return (
              distance +
              Math.min(cell.column, columns - 1 - cell.column, cell.row, rows - 1 - cell.row)
            );
          }
          if (neighborRegionId === regionId || !neighborCell) return distance;
          const horizontal =
            neighborCell.column < ownCell.column
              ? cell.column
              : neighborCell.column > ownCell.column
                ? columns - 1 - cell.column
                : Math.abs(cell.column - (columns - 1) / 2);
          const vertical =
            neighborCell.row < ownCell.row
              ? cell.row
              : neighborCell.row > ownCell.row
                ? rows - 1 - cell.row
                : Math.abs(cell.row - (rows - 1) / 2);
          return distance + horizontal + vertical;
        }, 0)
      );
    }, 0);
    let backboneLongRelationPenalty = 0;
    let longRelationPenalty = 0;
    const internalSpan = internalLinks.reduce((total, [from, to]) => {
      const fromCell = cellForIndex(indexByNodeId.get(from)!);
      const toCell = cellForIndex(indexByNodeId.get(to)!);
      const span = Math.abs(fromCell.column - toCell.column) + Math.abs(fromCell.row - toCell.row);
      const weight = linkWeight(from, to);
      if (weight > 1) backboneLongRelationPenalty += Math.max(0, span - 1) ** 2;
      longRelationPenalty += weight * Math.max(0, span - 1) ** 2;
      return total + weight * span;
    }, 0);
    return {
      internalCrossings,
      backboneLongRelationPenalty,
      externalBoundaryDistance,
      internalSpan,
      longRelationPenalty,
    };
  };
  const compareScores = (left: ReturnType<typeof score>, right: ReturnType<typeof score>): number =>
    left.backboneLongRelationPenalty - right.backboneLongRelationPenalty ||
    left.internalCrossings - right.internalCrossings ||
    left.longRelationPenalty - right.longRelationPenalty ||
    left.externalBoundaryDistance - right.externalBoundaryDistance ||
    left.internalSpan - right.internalSpan;

  let result = initial;
  let resultScore = score(result);

  const spanningPathNodeIds = (
    links: readonly (readonly [string, string])[],
  ): readonly string[] | null => {
    if (links.length !== members.length - 1) return null;
    const neighbors = new Map(members.map((nodeId) => [nodeId, new Set<string>()]));
    for (const [from, to] of links) {
      neighbors.get(from)?.add(to);
      neighbors.get(to)?.add(from);
    }
    const pathEndpoints = members.filter((nodeId) => neighbors.get(nodeId)?.size === 1);
    if (pathEndpoints.length !== 2 || members.some((nodeId) => neighbors.get(nodeId)?.size === 0)) {
      return null;
    }
    const preferredEndpoint = [...pathEndpoints].sort(
      (left, right) =>
        Number(right === startNodeId) - Number(left === startNodeId) ||
        directionalOutgoing.get(right)! -
          directionalIncoming.get(right)! -
          (directionalOutgoing.get(left)! - directionalIncoming.get(left)!) ||
        stableCompare(left, right),
    )[0]!;
    const pathNodeIds: string[] = [];
    let previous: string | null = null;
    let current: string | undefined = preferredEndpoint;
    while (current !== undefined) {
      pathNodeIds.push(current);
      const nextNodeId: string | undefined = [...(neighbors.get(current) ?? [])]
        .filter((nodeId) => nodeId !== previous)
        .sort(stableCompare)[0];
      previous = current;
      current = nextNodeId;
    }
    return pathNodeIds.length === members.length ? pathNodeIds : null;
  };

  // A spanning primary-backbone path has an exact bounded embedding even when factual auxiliary
  // Edges add chords. Fall back to an all-relation path when no authored backbone path exists.
  const pathNodeIds =
    spanningPathNodeIds(internalBackboneLinks) ?? spanningPathNodeIds(internalLinks);
  if (pathNodeIds) {
    const horizontalSequences = ([false, true] as const).flatMap((reverseRows) =>
      ([false, true] as const).map((reverseFirstRow) => {
        const rowIndexes = Array.from({ length: rows }, (_, index) => index);
        if (reverseRows) rowIndexes.reverse();
        return rowIndexes.flatMap((row, rowIndex) => {
          const columnIndexes = Array.from({ length: columns }, (_, index) => index);
          if (reverseFirstRow !== (rowIndex % 2 === 1)) columnIndexes.reverse();
          return columnIndexes.map((column) => row * columns + column);
        });
      }),
    );
    const verticalSequences = ([false, true] as const).flatMap((reverseColumns) =>
      ([false, true] as const).map((reverseFirstColumn) => {
        const columnIndexes = Array.from({ length: columns }, (_, index) => index);
        if (reverseColumns) columnIndexes.reverse();
        return columnIndexes.flatMap((column, columnIndex) => {
          const rowIndexes = Array.from({ length: rows }, (_, index) => index);
          if (reverseFirstColumn !== (columnIndex % 2 === 1)) rowIndexes.reverse();
          return rowIndexes.map((row) => row * columns + column);
        });
      }),
    );
    for (const cellIndexes of [...horizontalSequences, ...verticalSequences]) {
      const candidate = Array.from<string | null>({ length: columns * rows }).fill(null);
      pathNodeIds.forEach((nodeId, index) => {
        candidate[cellIndexes[index]!] = nodeId;
      });
      const candidateScore = score(candidate);
      if (compareScores(candidateScore, resultScore) < 0) {
        result = candidate;
        resultScore = candidateScore;
      }
    }
  }

  // The topology-aware greedy seed (and exact path seed above) sees every relation. Keep the
  // all-pairs swap/crossing refinement bounded for dense or large Regions.
  if (members.length > 10 || internalLinks.length > 24) {
    return result.flatMap((nodeId, index) => (nodeId === null ? [] : [{ index, nodeId }]));
  }
  for (let pass = 0; pass < Math.min(initial.length, 8); pass += 1) {
    let best = result;
    let bestScore = resultScore;
    for (let left = 0; left < result.length; left += 1) {
      for (let right = left + 1; right < result.length; right += 1) {
        if (result[left] === null && result[right] === null) continue;
        const candidate = [...result];
        [candidate[left], candidate[right]] = [candidate[right]!, candidate[left]!];
        const candidateScore = score(candidate);
        if (compareScores(candidateScore, bestScore) < 0) {
          best = candidate;
          bestScore = candidateScore;
        }
      }
    }
    if (best === result) break;
    result = best;
    resultScore = bestScore;
  }
  return result.flatMap((nodeId, index) => (nodeId === null ? [] : [{ index, nodeId }]));
}

function presentationRegionOnlyPositions(input: {
  structure: StructureGraphContent;
  topology: SimpleStructureTopology;
  regionByNodeId: ReadonlyMap<string, string>;
  packing: PresentationRegionPacking;
}): ReadonlyMap<string, StructurePoint> {
  const { structure, topology, regionByNodeId, packing } = input;
  const backboneEdgeIds = new Set(structure.presentation?.primaryBackbone?.edgeIds ?? []);
  const startNodeId = structure.presentation?.startNodeId ?? structure.originNodeId;
  const positions = new Map<string, StructurePoint>();
  for (const plan of packing.plans) {
    const topLeft = packing.topLeftByRegionId.get(plan.id)!;
    const members = presentationRegionMemberOrder({
      members: plan.members,
      columns: plan.columns,
      rows: plan.rows,
      regionId: plan.id,
      startNodeId,
      regionByNodeId,
      regionCellById: packing.cellByRegionId,
      topology,
      relationEdges: structure.edges,
      backboneEdgeIds,
    });
    members.forEach(({ nodeId, index }) => {
      positions.set(nodeId, {
        x:
          topLeft.x +
          STRUCTURE_REGION_PADDING_X +
          (index % plan.columns) * PRESENTATION_COLUMN_STRIDE,
        y:
          topLeft.y +
          STRUCTURE_REGION_PADDING_TOP +
          Math.floor(index / plan.columns) * PRESENTATION_ROW_STRIDE,
      });
    });
  }
  return positions;
}

interface PresentationRegionExternalComponent {
  nodeIds: readonly string[];
  nodeIdSet: ReadonlySet<string>;
  internalEdges: readonly StructureGraphContent["edges"][number][];
  boundaryEdges: readonly StructureGraphContent["edges"][number][];
  backboneBoundaryCount: number;
  signature: string;
}

interface PresentationRegionExternalPlacement {
  positions: ReadonlyMap<string, StructurePoint>;
  envelope: PresentationEnvelope;
}

/**
 * Region membership is intentionally partial. The connected remainder is therefore kept as
 * renderer-owned compound units while deriving canonical geometry, matching the factual Context
 * components exposed by the Regions projection without turning them into authored Regions.
 */
function presentationRegionExternalComponents(input: {
  structure: StructureGraphContent;
  topology: SimpleStructureTopology;
  regionByNodeId: ReadonlyMap<string, string>;
  backboneEdgeIds: ReadonlySet<string>;
}): PresentationRegionExternalComponent[] {
  const { structure, topology, regionByNodeId, backboneEdgeIds } = input;
  const unassigned = new Set(
    structure.nodes
      .map(({ id }) => id)
      .filter((nodeId) => !regionByNodeId.has(nodeId))
      .sort(stableCompare),
  );
  const assigned = new Set<string>();
  const components: PresentationRegionExternalComponent[] = [];
  for (const firstNodeId of [...unassigned].sort(stableCompare)) {
    if (assigned.has(firstNodeId)) continue;
    const queue = [firstNodeId];
    const componentNodeIds: string[] = [];
    assigned.add(firstNodeId);
    for (let index = 0; index < queue.length; index += 1) {
      const nodeId = queue[index]!;
      componentNodeIds.push(nodeId);
      for (const neighbor of topology.neighbors.get(nodeId) ?? []) {
        if (!unassigned.has(neighbor) || assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        queue.push(neighbor);
      }
    }
    componentNodeIds.sort(stableCompare);
    const nodeIdSet = new Set(componentNodeIds);
    const internalEdges = structure.edges
      .filter((edge) => nodeIdSet.has(edge.from) && nodeIdSet.has(edge.to))
      .sort((left, right) => stableCompare(left.id, right.id));
    const boundaryEdges = structure.edges
      .filter(
        (edge) =>
          nodeIdSet.has(edge.from) !== nodeIdSet.has(edge.to) &&
          (regionByNodeId.has(edge.from) || regionByNodeId.has(edge.to)),
      )
      .sort((left, right) => stableCompare(left.id, right.id));
    components.push({
      nodeIds: componentNodeIds,
      nodeIdSet,
      internalEdges,
      boundaryEdges,
      backboneBoundaryCount: boundaryEdges.filter((edge) => backboneEdgeIds.has(edge.id)).length,
      signature: componentNodeIds.join("\u0000"),
    });
  }
  return components;
}

function presentationRegionExternalTemplate(input: {
  component: PresentationRegionExternalComponent;
  topology: SimpleStructureTopology;
  startNodeId: string;
  backboneEdgeIds: ReadonlySet<string>;
}): ReadonlyMap<string, StructurePoint> {
  const { component, topology, startNodeId, backboneEdgeIds } = input;
  const componentTopology: SimpleStructureTopology = {
    neighbors: new Map(
      component.nodeIds.map((nodeId) => [
        nodeId,
        (topology.neighbors.get(nodeId) ?? []).filter((neighbor) =>
          component.nodeIdSet.has(neighbor),
        ),
      ]),
    ),
    links: topology.links.filter(
      ([from, to]) => component.nodeIdSet.has(from) && component.nodeIdSet.has(to),
    ),
    directionalLinks: topology.directionalLinks.filter(
      ([from, to]) => component.nodeIdSet.has(from) && component.nodeIdSet.has(to),
    ),
  };
  const boundaryStats = new Map(
    component.nodeIds.map((nodeId) => [nodeId, { backbone: 0, total: 0 }]),
  );
  for (const edge of component.boundaryEdges) {
    const componentNodeId = component.nodeIdSet.has(edge.from) ? edge.from : edge.to;
    const stats = boundaryStats.get(componentNodeId)!;
    stats.total += 1;
    if (backboneEdgeIds.has(edge.id)) stats.backbone += 1;
  }
  const entrypointId = component.nodeIds.includes(startNodeId)
    ? startNodeId
    : [...component.nodeIds].sort((left, right) => {
        const leftStats = boundaryStats.get(left)!;
        const rightStats = boundaryStats.get(right)!;
        return (
          rightStats.backbone - leftStats.backbone ||
          rightStats.total - leftStats.total ||
          stableCompare(left, right)
        );
      })[0]!;
  const ranks = componentRanks(component.nodeIds, componentTopology, entrypointId);
  const rawGroups = new Map<number, string[]>();
  for (const nodeId of component.nodeIds) {
    const rank = ranks.get(nodeId) ?? 0;
    const group = rawGroups.get(rank) ?? [];
    group.push(nodeId);
    rawGroups.set(rank, group);
  }
  const rankGroups = orderRankGroups(rawGroups, componentTopology);
  const rawPositions = presentationRankBandPositions({
    rankValues: [...rankGroups.keys()].sort((left, right) => left - right),
    rankGroups,
    relationEdges: component.internalEdges,
    preserveShortSequence: component.nodeIds.length <= 3,
  });
  const minimumX = Math.min(...[...rawPositions.values()].map(({ x }) => x));
  const minimumY = Math.min(...[...rawPositions.values()].map(({ y }) => y));
  return new Map(
    [...rawPositions].map(([nodeId, point]) => [
      nodeId,
      { x: point.x - minimumX, y: point.y - minimumY },
    ]),
  );
}

function presentationRegionExternalPlacement(input: {
  component: PresentationRegionExternalComponent;
  template: ReadonlyMap<string, StructurePoint>;
  positions: ReadonlyMap<string, StructurePoint>;
  occupied: readonly StructurePoint[];
  forbiddenEnvelopes: readonly PresentationEnvelope[];
  backboneEdgeIds: ReadonlySet<string>;
  minimumX: number;
  minimumY: number;
}): PresentationRegionExternalPlacement {
  const {
    component,
    template,
    positions,
    occupied,
    forbiddenEnvelopes,
    backboneEdgeIds,
    minimumX,
    minimumY,
  } = input;
  const templatePoints = [...template.values()];
  const templateEnvelope = presentationNodeEnvelope(templatePoints)!;
  const currentEnvelope = presentationEnvelope(occupied)!;
  const bases: StructurePoint[] = [
    {
      x:
        currentEnvelope.right +
        PRESENTATION_NODE_GAP_X -
        STRUCTURE_REGION_PADDING_X -
        templateEnvelope.left,
      y: currentEnvelope.top - templateEnvelope.top,
    },
    {
      x: currentEnvelope.left - templateEnvelope.left,
      y:
        currentEnvelope.bottom +
        PRESENTATION_NODE_GAP_Y -
        STRUCTURE_REGION_PADDING_BOTTOM -
        templateEnvelope.top,
    },
  ];
  const boundaryBases = new Map<
    string,
    {
      point: StructurePoint;
      backboneCount: number;
      relationCount: number;
      signature: string;
    }
  >();
  for (const edge of component.boundaryEdges) {
    const componentNodeId = component.nodeIdSet.has(edge.from) ? edge.from : edge.to;
    const regionNodeId = component.nodeIdSet.has(edge.from) ? edge.to : edge.from;
    const local = template.get(componentNodeId);
    const anchor = positions.get(regionNodeId);
    if (!local || !anchor) continue;
    const regionEnvelope = forbiddenEnvelopes.find(
      (envelope) =>
        anchor.x >= envelope.left &&
        anchor.x + STRUCTURE_NODE_WIDTH <= envelope.right &&
        anchor.y >= envelope.top &&
        anchor.y + STRUCTURE_NODE_HEIGHT <= envelope.bottom,
    );
    if (!regionEnvelope) continue;
    const candidates = [
      {
        x:
          regionEnvelope.right +
          PRESENTATION_NODE_GAP_X -
          STRUCTURE_REGION_PADDING_X -
          templateEnvelope.left,
        y: anchor.y - local.y,
      },
      {
        x: anchor.x - local.x,
        y:
          regionEnvelope.bottom +
          PRESENTATION_NODE_GAP_Y -
          STRUCTURE_REGION_PADDING_BOTTOM -
          templateEnvelope.top,
      },
    ];
    for (const [index, point] of candidates.entries()) {
      const key = `${point.x}:${point.y}`;
      const existing = boundaryBases.get(key);
      if (existing) {
        existing.relationCount += 1;
        if (backboneEdgeIds.has(edge.id)) existing.backboneCount += 1;
      } else {
        boundaryBases.set(key, {
          point,
          backboneCount: backboneEdgeIds.has(edge.id) ? 1 : 0,
          relationCount: 1,
          signature: `${edge.id}:${index}`,
        });
      }
    }
  }
  bases.push(
    ...[...boundaryBases.values()]
      .sort(
        (left, right) =>
          right.backboneCount - left.backboneCount ||
          right.relationCount - left.relationCount ||
          stableCompare(left.signature, right.signature),
      )
      .slice(0, PRESENTATION_MAX_BOUNDARY_ALIGNMENT_BASES)
      .map(({ point }) => point),
  );

  const candidateOffsets = new Map<string, StructurePoint>();
  const candidateXs = new Set([minimumX]);
  const candidateYs = new Set([minimumY]);
  for (const envelope of forbiddenEnvelopes) {
    candidateXs.add(
      envelope.left - PRESENTATION_NODE_GAP_X - (templateEnvelope.right - templateEnvelope.left),
    );
    candidateXs.add(envelope.left);
    candidateXs.add(envelope.right + PRESENTATION_NODE_GAP_X);
    candidateYs.add(
      envelope.top - PRESENTATION_NODE_GAP_Y - (templateEnvelope.bottom - templateEnvelope.top),
    );
    candidateYs.add(envelope.top);
    candidateYs.add(envelope.bottom + PRESENTATION_NODE_GAP_Y);
  }
  for (const x of candidateXs) {
    for (const y of candidateYs) {
      const offset = { x: x - templateEnvelope.left, y: y - templateEnvelope.top };
      candidateOffsets.set(`${offset.x}:${offset.y}`, offset);
    }
  }
  for (const base of bases) {
    for (const rowShift of [0, -1, 1, -2, 2]) {
      for (const columnShift of [0, -1, 1, -2, 2]) {
        const offset = {
          x: base.x + columnShift * PRESENTATION_COLUMN_STRIDE,
          y: base.y + rowShift * PRESENTATION_ROW_STRIDE,
        };
        candidateOffsets.set(`${offset.x}:${offset.y}`, offset);
      }
    }
  }

  const candidates = [...candidateOffsets.values()].flatMap((offset) => {
    const translated = new Map(
      [...template].map(([nodeId, point]) => [
        nodeId,
        { x: point.x + offset.x, y: point.y + offset.y },
      ]),
    );
    const points = [...translated.values()];
    const envelope = presentationNodeEnvelope(points)!;
    if (
      forbiddenEnvelopes.some((forbidden) => presentationEnvelopesOverlap(envelope, forbidden)) ||
      points.some((point) => presentationPositionOverlaps(occupied, point))
    ) {
      return [];
    }
    const combinedEnvelope = presentationNodeEnvelope([...occupied, ...points])!;
    const width = combinedEnvelope.right - combinedEnvelope.left;
    const height = combinedEnvelope.bottom - combinedEnvelope.top;
    let relationSpan = 0;
    let relationWeight = 0;
    let obstructedBoundarySegmentCount = 0;
    const obstacles = [...occupied, ...points];
    for (const edge of component.boundaryEdges) {
      const componentNodeId = component.nodeIdSet.has(edge.from) ? edge.from : edge.to;
      const regionNodeId = component.nodeIdSet.has(edge.from) ? edge.to : edge.from;
      const componentPoint = translated.get(componentNodeId);
      const regionPoint = positions.get(regionNodeId);
      if (!componentPoint || !regionPoint) continue;
      const weight = backboneEdgeIds.has(edge.id) ? 3 : 1;
      relationWeight += weight;
      relationSpan +=
        weight *
        (Math.abs(componentPoint.x - regionPoint.x) + Math.abs(componentPoint.y - regionPoint.y));
      const componentCenter = {
        x: componentPoint.x + STRUCTURE_NODE_WIDTH / 2,
        y: componentPoint.y + STRUCTURE_NODE_HEIGHT / 2,
      };
      const regionCenter = {
        x: regionPoint.x + STRUCTURE_NODE_WIDTH / 2,
        y: regionPoint.y + STRUCTURE_NODE_HEIGHT / 2,
      };
      obstructedBoundarySegmentCount +=
        weight *
        obstacles.filter(
          (point) =>
            (point.x !== componentPoint.x || point.y !== componentPoint.y) &&
            (point.x !== regionPoint.x || point.y !== regionPoint.y) &&
            presentationSegmentIntersectsNode(componentCenter, regionCenter, point),
        ).length;
    }
    const averageRelationSpan = relationWeight === 0 ? 0 : relationSpan / relationWeight;
    const averageBoundaryObstruction =
      relationWeight === 0 ? 0 : obstructedBoundarySegmentCount / relationWeight;
    return [
      {
        positions: translated,
        envelope,
        score:
          Math.max(width / PRESENTATION_COMPOUND_TARGET_ASPECT_RATIO, height) +
          averageRelationSpan * 0.2 +
          Math.min(2, averageBoundaryObstruction) * 180,
        area: width * height,
        relationSpan,
        obstructedBoundarySegmentCount,
        offset,
      },
    ];
  });
  candidates.sort(
    (left, right) =>
      left.score - right.score ||
      left.obstructedBoundarySegmentCount - right.obstructedBoundarySegmentCount ||
      left.area - right.area ||
      left.relationSpan - right.relationSpan ||
      left.offset.y - right.offset.y ||
      left.offset.x - right.offset.x,
  );
  const chosen = candidates[0];
  if (chosen) return chosen;

  // The right-hand base is guaranteed to escape every previously placed envelope. Retain an
  // explicit fallback so future candidate changes cannot silently drop a factual component.
  const fallbackOffset = bases[0]!;
  const fallbackPositions = new Map(
    [...template].map(([nodeId, point]) => [
      nodeId,
      { x: point.x + fallbackOffset.x, y: point.y + fallbackOffset.y },
    ]),
  );
  return {
    positions: fallbackPositions,
    envelope: presentationNodeEnvelope([...fallbackPositions.values()])!,
  };
}

function presentationBackboneCorridors(
  edges: readonly StructureGraphContent["edges"][number][],
  positions: ReadonlyMap<string, StructurePoint>,
): PresentationEnvelope[] {
  return edges.flatMap((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return [];
    const fromCenter = {
      x: from.x + STRUCTURE_NODE_WIDTH / 2,
      y: from.y + STRUCTURE_NODE_HEIGHT / 2,
    };
    const toCenter = {
      x: to.x + STRUCTURE_NODE_WIDTH / 2,
      y: to.y + STRUCTURE_NODE_HEIGHT / 2,
    };
    if (Math.abs(fromCenter.x - toCenter.x) >= Math.abs(fromCenter.y - toCenter.y)) {
      const left = Math.min(from.x + STRUCTURE_NODE_WIDTH, to.x + STRUCTURE_NODE_WIDTH);
      const right = Math.max(from.x, to.x);
      if (right <= left) return [];
      const centerY = (fromCenter.y + toCenter.y) / 2;
      return [{ left, right, top: centerY - 38, bottom: centerY + 38 }];
    }
    const top = Math.min(from.y + STRUCTURE_NODE_HEIGHT, to.y + STRUCTURE_NODE_HEIGHT);
    const bottom = Math.max(from.y, to.y);
    if (bottom <= top) return [];
    const centerX = (fromCenter.x + toCenter.x) / 2;
    return [{ left: centerX - 38, right: centerX + 38, top, bottom }];
  });
}

function presentationDistanceToAnchors(
  nodeId: string,
  anchors: ReadonlySet<string>,
  topology: SimpleStructureTopology,
): number {
  if (anchors.has(nodeId)) return 0;
  const seen = new Set([nodeId]);
  let frontier = [nodeId];
  for (let distance = 1; frontier.length > 0; distance += 1) {
    const next: string[] = [];
    for (const current of frontier.sort(stableCompare)) {
      for (const neighbor of topology.neighbors.get(current) ?? []) {
        if (anchors.has(neighbor)) return distance;
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next.sort(stableCompare);
  }
  return Number.POSITIVE_INFINITY;
}

function nextPresentationNode(
  candidates: ReadonlySet<string>,
  anchors: ReadonlySet<string>,
  topology: SimpleStructureTopology,
): string {
  return [...candidates].sort(
    (left, right) =>
      presentationDistanceToAnchors(left, anchors, topology) -
        presentationDistanceToAnchors(right, anchors, topology) || stableCompare(left, right),
  )[0]!;
}

function nearestPresentationAnchor(input: {
  nodeId: string;
  anchors: ReadonlySet<string>;
  topology: SimpleStructureTopology;
  positions: ReadonlyMap<string, StructurePoint>;
}): string | null {
  const { nodeId, anchors, topology, positions } = input;
  const seen = new Set([nodeId]);
  let frontier = [nodeId];
  while (frontier.length > 0) {
    const matches = frontier
      .filter((candidate) => anchors.has(candidate) && positions.has(candidate))
      .sort((left, right) => {
        const leftX = positions.get(left)?.x ?? 0;
        const rightX = positions.get(right)?.x ?? 0;
        return leftX - rightX || stableCompare(left, right);
      });
    if (matches[0]) return matches[0];
    const next: string[] = [];
    for (const current of frontier.sort(stableCompare)) {
      for (const neighbor of topology.neighbors.get(current) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next.sort(stableCompare);
  }
  return null;
}

function projectionFromPresentedPositions(
  structure: StructureGraphContent,
  topology: SimpleStructureTopology,
  rawPositions: ReadonlyMap<string, StructurePoint>,
): StructureProjection {
  const outerPadding = 64;
  const minX = Math.min(...[...rawPositions.values()].map((point) => point.x));
  const minY = Math.min(...[...rawPositions.values()].map((point) => point.y));
  const positions = new Map(
    [...rawPositions].map(([nodeId, point]) => [
      nodeId,
      { x: point.x - minX + outerPadding, y: point.y - minY + outerPadding },
    ]),
  );
  const xValues = [...new Set([...positions.values()].map(({ x }) => x))].sort(
    (left, right) => left - right,
  );
  const columnIndexByX = new Map(xValues.map((x, index) => [x, index]));
  const columns = xValues.map((x) =>
    [...positions]
      .filter(([, point]) => point.x === x)
      .sort(
        ([leftId, left], [rightId, right]) => left.y - right.y || stableCompare(leftId, rightId),
      )
      .map(([nodeId]) => nodeId),
  );
  const columnIndexByNodeId = new Map(
    [...positions].map(([nodeId, point]) => [nodeId, columnIndexByX.get(point.x)!]),
  );
  const ranks = new Map(columnIndexByNodeId);
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
  const rowsPerColumn = columns.map((column) => column.length);
  const directionalLinkCount = topology.directionalLinks.length;
  return {
    positionsByNodeId: positions,
    rankByNodeId: ranks,
    columnIndexByNodeId,
    columns,
    directionalLinks: topology.directionalLinks,
    diagnostics: {
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
    },
  };
}

function projectPresentedStructure(
  structure: StructureGraphContent,
  topology: SimpleStructureTopology,
): StructureProjection | null {
  const presentation = structure.presentation;
  if (!presentation) return null;
  const nodeIds = new Set(structure.nodes.map((node) => node.id));
  if (presentation.primaryBackbone === null && presentation.regions.length === 0) return null;
  const backboneEdgeIds = new Set(presentation.primaryBackbone?.edgeIds ?? []);
  const backboneEdges = structure.edges
    .filter(
      (edge) => backboneEdgeIds.has(edge.id) && nodeIds.has(edge.from) && nodeIds.has(edge.to),
    )
    .sort((left, right) => stableCompare(left.id, right.id));
  const backboneNodeIds = new Set(
    backboneEdges.flatMap((edge) => (edge.from === edge.to ? [edge.from] : [edge.from, edge.to])),
  );
  const startNodeId = nodeIds.has(presentation.startNodeId)
    ? presentation.startNodeId
    : nodeIds.has(structure.originNodeId)
      ? structure.originNodeId
      : ([...nodeIds].sort(stableCompare)[0] ?? null);
  if (!startNodeId) return null;

  const regionByNodeId = new Map<string, string>();
  for (const region of [...presentation.regions].sort((left, right) =>
    stableCompare(left.id, right.id),
  )) {
    for (const nodeId of [...new Set(region.nodeIds)].sort(stableCompare)) {
      if (nodeIds.has(nodeId) && !regionByNodeId.has(nodeId)) {
        regionByNodeId.set(nodeId, region.id);
      }
    }
  }
  const hasPlacedRegions = regionByNodeId.size > 0;
  if (!hasPlacedRegions && backboneEdges.length === 0) return null;
  const regionPacking = presentationRegionPacking({
    structure,
    regionByNodeId,
    backboneEdgeIds,
    startNodeId,
  });
  const positions = new Map<string, StructurePoint>();
  if (hasPlacedRegions) {
    // Regions are the authored spatial chunks. Place their complete membership as compound units
    // before positioning unassigned context, even when a primary backbone is also present. The
    // backbone still shapes the Region packing through its stronger cross-Region relation weight
    // and remains the exact visual core, but it must not pull members of the same comprehension
    // chunk into distant global bands.
    for (const [nodeId, point] of presentationRegionOnlyPositions({
      structure,
      topology,
      regionByNodeId,
      packing: regionPacking,
    })) {
      positions.set(nodeId, point);
    }
  } else if (backboneEdges.length > 0) {
    const backboneNeighborSets = new Map(
      [...backboneNodeIds].sort(stableCompare).map((nodeId) => [nodeId, new Set<string>()]),
    );
    for (const edge of backboneEdges) {
      if (edge.from === edge.to) continue;
      backboneNeighborSets.get(edge.from)?.add(edge.to);
      backboneNeighborSets.get(edge.to)?.add(edge.from);
    }
    const backboneNeighbors = new Map(
      [...backboneNeighborSets].map(([nodeId, neighbors]) => [
        nodeId,
        [...neighbors].sort(stableCompare),
      ]),
    );
    const ranks = new Map([[startNodeId, 0]]);
    const queue = [startNodeId];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      for (const neighbor of backboneNeighbors.get(current) ?? []) {
        if (ranks.has(neighbor)) continue;
        ranks.set(neighbor, (ranks.get(current) ?? 0) + 1);
        queue.push(neighbor);
      }
    }
    const rankGroups = new Map<number, string[]>();
    for (const nodeId of [...backboneNodeIds].sort(stableCompare)) {
      const rank = ranks.get(nodeId) ?? 0;
      const group = rankGroups.get(rank) ?? [];
      group.push(nodeId);
      rankGroups.set(rank, group);
    }
    const rankValues = [...rankGroups.keys()].sort((left, right) => left - right);
    const orderIndex = new Map<string, number>();
    for (const rank of rankValues) {
      const group = rankGroups.get(rank)!;
      group.sort((left, right) => {
        const previousBarycenter = (nodeId: string): number => {
          const indexes = (backboneNeighbors.get(nodeId) ?? [])
            .filter((neighbor) => (ranks.get(neighbor) ?? 0) < rank)
            .flatMap((neighbor) => {
              const value = orderIndex.get(neighbor);
              return value === undefined ? [] : [value];
            });
          return indexes.length === 0
            ? Number.POSITIVE_INFINITY
            : indexes.reduce((sum, value) => sum + value, 0) / indexes.length;
        };
        return (
          previousBarycenter(left) - previousBarycenter(right) ||
          stableCompare(
            regionByNodeId.get(left) ?? "\uffff",
            regionByNodeId.get(right) ?? "\uffff",
          ) ||
          stableCompare(left, right)
        );
      });
      group.forEach((nodeId, index) => orderIndex.set(nodeId, index));
    }
    for (const [nodeId, point] of presentationRankBandPositions({
      rankValues,
      rankGroups,
      relationEdges: backboneEdges,
      preserveShortSequence: true,
    })) {
      positions.set(nodeId, point);
    }
  }

  const occupied = [...positions.values()];
  const backboneCorridors = presentationBackboneCorridors(backboneEdges, positions);
  const regionEnvelopes = [...presentation.regions]
    .sort((left, right) => stableCompare(left.id, right.id))
    .flatMap((region) => {
      const envelope = presentationEnvelope(
        [...new Set(region.nodeIds)]
          .sort(stableCompare)
          .flatMap((nodeId) => (nodeIds.has(nodeId) ? [positions.get(nodeId)!] : [])),
      );
      return envelope ? [envelope] : [];
    });

  const regionExternalEnvelopes: PresentationEnvelope[] = [];
  if (hasPlacedRegions) {
    const regionPoints = [...positions.values()];
    const regionMinimumX = Math.min(...regionPoints.map(({ x }) => x));
    const regionMinimumY = Math.min(...regionPoints.map(({ y }) => y));
    const boundaryAnchorOrder = (component: PresentationRegionExternalComponent) => {
      const anchors = component.boundaryEdges.flatMap((edge) => {
        const regionNodeId = component.nodeIdSet.has(edge.from) ? edge.to : edge.from;
        const point = positions.get(regionNodeId);
        return point ? [point] : [];
      });
      return {
        y: anchors.length > 0 ? Math.min(...anchors.map(({ y }) => y)) : Number.MAX_SAFE_INTEGER,
        x: anchors.length > 0 ? Math.min(...anchors.map(({ x }) => x)) : Number.MAX_SAFE_INTEGER,
      };
    };
    const regionExternalComponents = presentationRegionExternalComponents({
      structure,
      topology,
      regionByNodeId,
      backboneEdgeIds,
    }).sort(
      (left, right) =>
        Number(right.nodeIds.includes(startNodeId)) - Number(left.nodeIds.includes(startNodeId)) ||
        right.backboneBoundaryCount - left.backboneBoundaryCount ||
        right.boundaryEdges.length - left.boundaryEdges.length ||
        boundaryAnchorOrder(left).y - boundaryAnchorOrder(right).y ||
        boundaryAnchorOrder(left).x - boundaryAnchorOrder(right).x ||
        right.nodeIds.length - left.nodeIds.length ||
        stableCompare(left.signature, right.signature),
    );
    for (const component of regionExternalComponents) {
      const template = presentationRegionExternalTemplate({
        component,
        topology,
        startNodeId,
        backboneEdgeIds,
      });
      const placement = presentationRegionExternalPlacement({
        component,
        template,
        positions,
        occupied,
        forbiddenEnvelopes: [...regionEnvelopes, ...regionExternalEnvelopes],
        backboneEdgeIds,
        minimumX: regionMinimumX,
        minimumY: regionMinimumY,
      });
      for (const [nodeId, point] of placement.positions) {
        positions.set(nodeId, point);
        occupied.push(point);
      }
      regionExternalEnvelopes.push(placement.envelope);
    }
  }

  const presentedAnchors = new Set(positions.keys());
  const remaining = new Set([...nodeIds].filter((nodeId) => !positions.has(nodeId)));
  const fallbackX =
    Math.max(
      0,
      ...[...positions.values()].map(({ x }) => x + STRUCTURE_NODE_WIDTH),
      ...regionEnvelopes.map(({ right }) => right),
    ) + PRESENTATION_RANK_GAP;
  while (remaining.size > 0) {
    const nodeId = nextPresentationNode(remaining, presentedAnchors, topology);
    const directAnchors = (topology.neighbors.get(nodeId) ?? [])
      .filter((neighbor) => presentedAnchors.has(neighbor) && positions.has(neighbor))
      .sort(stableCompare);
    const anchorId = nearestPresentationAnchor({
      nodeId,
      anchors: presentedAnchors,
      topology,
      positions,
    });
    const anchor = anchorId ? positions.get(anchorId)! : { x: fallbackX, y: 0 };
    const desired =
      directAnchors.length >= 2
        ? {
            x:
              directAnchors.reduce((sum, current) => sum + positions.get(current)!.x, 0) /
              directAnchors.length,
            y:
              directAnchors.reduce((sum, current) => sum + positions.get(current)!.y, 0) /
              directAnchors.length,
          }
        : { x: anchor.x, y: anchor.y + PRESENTATION_ROW_STRIDE };
    const point = firstOpenPresentationPoint(
      occupied,
      desired,
      [...backboneCorridors, ...regionEnvelopes, ...regionExternalEnvelopes],
      directAnchors.length >= 2 ? "either" : "below",
    );
    positions.set(nodeId, point);
    occupied.push(point);
    presentedAnchors.add(nodeId);
    remaining.delete(nodeId);
  }
  return projectionFromPresentedPositions(structure, topology, positions);
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

function projectTopologyStructureWithTopology(
  structure: StructureGraphContent,
  topology: SimpleStructureTopology,
): StructureProjection {
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

/**
 * Projects only the factual graph topology. In particular, this is the source of authoring
 * diagnostics even when the displayed projection also has an authorial presentation.
 */
export function projectTopologyStructure(structure: StructureGraphContent): StructureProjection {
  return projectTopologyStructureWithTopology(structure, simpleStructureTopology(structure));
}

export function projectStructure(structure: StructureGraphContent): StructureProjection {
  const topology = simpleStructureTopology(structure);
  const topologyProjection = projectTopologyStructureWithTopology(structure, topology);
  const presented = projectPresentedStructure(structure, topology);
  return presented ?? topologyProjection;
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
        "the neutral topology diagnostic has a tall column; reconsider the factual origin, node granularity, overlapping or nested claims, whether multiple behaviors are mixed, and the subject boundary.",
    });
  }
  if (diagnostics.nonForwardDirectionalLinkRatio >= 0.25) {
    warnings.push({
      code: "STRUCTURE_LAYOUT_NON_FORWARD_DIRECTIONAL_LINK_RATIO_HIGH",
      message:
        "many unambiguous directed relations are non-forward in the neutral topology diagnostic; reconsider the factual origin, node granularity, behavior boundary, and subject boundary. A factual graph may remain above this threshold. Do not change edge direction solely to improve the score.",
    });
  }
  return warnings;
}
