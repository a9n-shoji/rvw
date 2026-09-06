import type { Structure, StructureEdge, StructurePresentationRegion } from "../domain/models.js";

export interface StructureRegionDirectionBuckets {
  fromFirstRegionEdgeIds: readonly string[];
  fromSecondRegionEdgeIds: readonly string[];
  undirectedEdgeIds: readonly string[];
}

export interface StructureRegionDirectRelation {
  /** Region IDs are always in stable-ID order. Direction buckets are relative to this tuple. */
  regionIds: readonly [firstRegionId: string, secondRegionId: string];
  edgeIds: readonly string[];
  backboneEdgeIds: readonly string[];
  directions: StructureRegionDirectionBuckets;
}

export interface StructureRegionUnassignedBoundaryDirections {
  fromRegionEdgeIds: readonly string[];
  fromUnassignedNodeEdgeIds: readonly string[];
  undirectedEdgeIds: readonly string[];
}

export interface StructureRegionUnassignedBoundary {
  regionId: string;
  unassignedNodeId: string;
  edgeIds: readonly string[];
  backboneEdgeIds: readonly string[];
  directions: StructureRegionUnassignedBoundaryDirections;
}

export interface StructureRegionOverviewRegion {
  id: string;
  label: string;
  summary: string;
  nodeIds: readonly string[];
  nodeCount: number;
  internalEdgeIds: readonly string[];
  boundaryEdgeIds: readonly string[];
  backboneEdgeIds: readonly string[];
  adjacentRegionIds: readonly string[];
  unassignedNeighborNodeIds: readonly string[];
}

export interface StructureRegionUnassignedComponent {
  nodeIds: readonly string[];
  internalEdgeIds: readonly string[];
  boundaryEdgeIds: readonly string[];
  backboneEdgeIds: readonly string[];
  adjacentRegionIds: readonly string[];
}

export interface StructureRegionOverviewModel {
  startRegionId: string | null;
  regions: readonly StructureRegionOverviewRegion[];
  directRelations: readonly StructureRegionDirectRelation[];
  unassignedBoundaries: readonly StructureRegionUnassignedBoundary[];
  unassignedComponents: readonly StructureRegionUnassignedComponent[];
}

export interface StructureRegionContext {
  /** Derived from the exact component member IDs; never persisted as artifact semantics. */
  id: string;
  nodeIds: readonly string[];
  internalEdgeIds: readonly string[];
  boundaryEdgeIds: readonly string[];
  backboneEdgeIds: readonly string[];
  adjacentRegionIds: readonly string[];
}

export interface StructureRegionContextRelation {
  contextId: string;
  regionId: string;
  edgeIds: readonly string[];
  backboneEdgeIds: readonly string[];
  directions: StructureRegionUnassignedBoundaryDirections;
}

export interface StructureRegionContextSurface {
  contexts: readonly StructureRegionContext[];
  boundaryRelations: readonly StructureRegionContextRelation[];
}

export interface StructureRegionOverviewPoint {
  x: number;
  y: number;
}

export interface StructureRegionOverviewLayoutRegion {
  regionId: string;
  column: number;
  row: number;
  center: StructureRegionOverviewPoint;
}

export interface StructureRegionOverviewLayoutRelation {
  regionIds: readonly [string, string];
  edgeIds: readonly string[];
  backboneEdgeIds: readonly string[];
  directions: StructureRegionDirectionBuckets;
  firstCenter: StructureRegionOverviewPoint;
  secondCenter: StructureRegionOverviewPoint;
}

export interface StructureRegionOverviewLayout {
  width: number;
  height: number;
  columnCount: number;
  rowCount: number;
  regions: readonly StructureRegionOverviewLayoutRegion[];
  directRelations: readonly StructureRegionOverviewLayoutRelation[];
}

export interface StructureRegionOverviewRouteCard {
  id: string;
  center: StructureRegionOverviewPoint;
  width: number;
  height: number;
}

export interface StructureRegionOverviewRouteRequest {
  id: string;
  fromCardId: string;
  toCardId: string;
  labelWidth: number;
  labelHeight: number;
  /** Lower values claim the most direct lanes first. Direct Region relations precede Context. */
  priority?: number;
}

export interface StructureRegionOverviewRoutedRelation {
  id: string;
  points: readonly StructureRegionOverviewPoint[];
  labelCenter: StructureRegionOverviewPoint;
  labelPlacement: "route" | "offset" | "shelf";
  labelLeaderPoints: readonly StructureRegionOverviewPoint[];
}

export interface StructureRegionOverviewRoutingLayout {
  width: number;
  height: number;
  routes: readonly StructureRegionOverviewRoutedRelation[];
}

export const STRUCTURE_REGION_OVERVIEW_CARD_WIDTH = 232;
export const STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT = 176;
export const STRUCTURE_REGION_OVERVIEW_RELATION_LABEL_WIDTH = 200;
// Keep enough negative space for the relationship pill and arrowheads. The overview is a
// comprehension map, so partially hiding the relation behind its responsibility cards is worse
// than spending a little more horizontal space (the container scrolls on narrow panes).
export const STRUCTURE_REGION_OVERVIEW_COLUMN_GAP = 272;
export const STRUCTURE_REGION_OVERVIEW_ROW_GAP = 76;
export const STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE = 12;
export const STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE = 8;
/**
 * Visible route length reserved between an on-route relationship pill and either endpoint card.
 * This is deliberately larger than the SVG marker footprint: the arrowhead needs a short shaft
 * behind it to communicate direction instead of looking like a triangle attached to the pill.
 */
export const STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY = 28;

type StructureRegionOverviewInput = Pick<Structure, "nodes" | "edges" | "presentation">;

function stableCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(stableCompare);
}

function pairKey(first: string, second: string): string {
  return JSON.stringify([first, second]);
}

function regionMarkerStem(regionId: string): string {
  const words = regionId.split(/[-_]+/u).filter(Boolean);
  const marker =
    words.length > 1
      ? words
          .slice(0, 3)
          .map((word) => word[0])
          .join("")
      : [...regionId].slice(0, 3).join("");
  return marker.toUpperCase();
}

function regionMarkerFingerprint(regionId: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < regionId.length; index += 1) {
    hash ^= regionId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, "0");
}

/**
 * Creates compact, non-ordinal Region landmarks from stable Region IDs. Human-readable stems remain
 * short in the common case. Stem collisions receive the shortest unique deterministic fingerprint;
 * the full ID is a rare deterministic fallback for a complete hash collision.
 */
export function structureRegionMarkers(
  regions: readonly Pick<StructurePresentationRegion, "id">[],
): ReadonlyMap<string, string> {
  const regionIds = sortedUnique(regions.map(({ id }) => id));
  const idsByStem = new Map<string, string[]>();
  for (const regionId of regionIds) {
    const stem = regionMarkerStem(regionId);
    const existing = idsByStem.get(stem);
    if (existing) existing.push(regionId);
    else idsByStem.set(stem, [regionId]);
  }

  const markers = new Map<string, string>();
  for (const [stem, ids] of idsByStem) {
    if (ids.length === 1) {
      markers.set(ids[0]!, stem);
      continue;
    }
    const fingerprints = new Map(ids.map((id) => [id, regionMarkerFingerprint(id)]));
    let suffixLength = 2;
    while (
      suffixLength < 7 &&
      new Set(ids.map((id) => fingerprints.get(id)!.slice(0, suffixLength))).size < ids.length
    ) {
      suffixLength += 1;
    }
    const candidates = ids.map((id) => `${stem}·${fingerprints.get(id)!.slice(0, suffixLength)}`);
    const fingerprintsAreUnique = new Set(candidates).size === candidates.length;
    for (const [index, id] of ids.entries()) {
      markers.set(id, fingerprintsAreUnique ? candidates[index]! : `${candidates[index]}·${id}`);
    }
  }
  return markers;
}

function canonicalRegions(
  regions: readonly StructurePresentationRegion[],
  validNodeIds: ReadonlySet<string>,
): {
  regions: StructurePresentationRegion[];
  regionByNodeId: ReadonlyMap<string, string>;
} {
  const canonical = [...regions]
    .sort((left, right) => stableCompare(left.id, right.id))
    .map((region) => ({
      ...region,
      nodeIds: sortedUnique(region.nodeIds.filter((nodeId) => validNodeIds.has(nodeId))),
    }));
  const regionByNodeId = new Map<string, string>();
  for (const region of canonical) {
    // Valid artifacts have disjoint membership. Earliest Region ID wins for malformed persisted
    // input so overview derivation remains deterministic rather than depending on array order.
    for (const nodeId of region.nodeIds) {
      if (!regionByNodeId.has(nodeId)) regionByNodeId.set(nodeId, region.id);
    }
  }
  return {
    regions: canonical.map((region) => ({
      ...region,
      nodeIds: region.nodeIds.filter((nodeId) => regionByNodeId.get(nodeId) === region.id),
    })),
    regionByNodeId,
  };
}

interface MutableDirectRelation {
  regionIds: [string, string];
  edgeIds: string[];
  backboneEdgeIds: string[];
  directions: {
    fromFirstRegionEdgeIds: string[];
    fromSecondRegionEdgeIds: string[];
    undirectedEdgeIds: string[];
  };
}

interface MutableUnassignedBoundary {
  regionId: string;
  unassignedNodeId: string;
  edgeIds: string[];
  backboneEdgeIds: string[];
  directions: {
    fromRegionEdgeIds: string[];
    fromUnassignedNodeEdgeIds: string[];
    undirectedEdgeIds: string[];
  };
}

function sortedEdges(
  edges: readonly StructureEdge[],
  validNodeIds: ReadonlySet<string>,
): StructureEdge[] {
  return edges
    .filter((edge) => validNodeIds.has(edge.from) && validNodeIds.has(edge.to))
    .sort((left, right) => stableCompare(left.id, right.id));
}

/**
 * Derives the Region-level factual relationship surface used by compact overview renderers.
 * Only direct factual Edges become Region relations. Paths through unassigned Nodes remain
 * explicit unassigned components and boundaries; they never turn into synthesized Region links.
 */
export function aggregateStructureRegionOverview(
  structure: StructureRegionOverviewInput,
): StructureRegionOverviewModel | null {
  const presentation = structure.presentation;
  if (!presentation) return null;

  const validNodeIds = new Set(structure.nodes.map(({ id }) => id));
  const { regions, regionByNodeId } = canonicalRegions(presentation.regions, validNodeIds);
  const backboneEdgeIds = new Set(presentation.primaryBackbone?.edgeIds ?? []);
  const edges = sortedEdges(structure.edges, validNodeIds);
  const directRelations = new Map<string, MutableDirectRelation>();
  const unassignedBoundaries = new Map<string, MutableUnassignedBoundary>();
  const internalEdgeIdsByRegion = new Map(regions.map(({ id }) => [id, [] as string[]]));
  const boundaryEdgeIdsByRegion = new Map(regions.map(({ id }) => [id, [] as string[]]));
  const backboneEdgeIdsByRegion = new Map(regions.map(({ id }) => [id, [] as string[]]));
  const adjacentRegionIdsByRegion = new Map(regions.map(({ id }) => [id, new Set<string>()]));
  const unassignedNeighborNodeIdsByRegion = new Map(
    regions.map(({ id }) => [id, new Set<string>()]),
  );
  const unassignedNeighborSets = new Map(
    [...validNodeIds]
      .filter((nodeId) => !regionByNodeId.has(nodeId))
      .sort(stableCompare)
      .map((nodeId) => [nodeId, new Set<string>()]),
  );
  const unassignedInternalEdges: StructureEdge[] = [];

  for (const edge of edges) {
    const fromRegionId = regionByNodeId.get(edge.from);
    const toRegionId = regionByNodeId.get(edge.to);
    if (backboneEdgeIds.has(edge.id)) {
      if (fromRegionId) backboneEdgeIdsByRegion.get(fromRegionId)?.push(edge.id);
      if (toRegionId && toRegionId !== fromRegionId) {
        backboneEdgeIdsByRegion.get(toRegionId)?.push(edge.id);
      }
    }

    if (fromRegionId && fromRegionId === toRegionId) {
      internalEdgeIdsByRegion.get(fromRegionId)?.push(edge.id);
      continue;
    }

    if (fromRegionId && toRegionId) {
      const regionIds = [fromRegionId, toRegionId].sort(stableCompare) as [string, string];
      const key = pairKey(...regionIds);
      const relation = directRelations.get(key) ?? {
        regionIds,
        edgeIds: [],
        backboneEdgeIds: [],
        directions: {
          fromFirstRegionEdgeIds: [],
          fromSecondRegionEdgeIds: [],
          undirectedEdgeIds: [],
        },
      };
      relation.edgeIds.push(edge.id);
      if (backboneEdgeIds.has(edge.id)) relation.backboneEdgeIds.push(edge.id);
      if (!edge.directed) relation.directions.undirectedEdgeIds.push(edge.id);
      else if (fromRegionId === regionIds[0]) {
        relation.directions.fromFirstRegionEdgeIds.push(edge.id);
      } else {
        relation.directions.fromSecondRegionEdgeIds.push(edge.id);
      }
      directRelations.set(key, relation);
      boundaryEdgeIdsByRegion.get(fromRegionId)?.push(edge.id);
      boundaryEdgeIdsByRegion.get(toRegionId)?.push(edge.id);
      adjacentRegionIdsByRegion.get(fromRegionId)?.add(toRegionId);
      adjacentRegionIdsByRegion.get(toRegionId)?.add(fromRegionId);
      continue;
    }

    if (!fromRegionId && !toRegionId) {
      unassignedInternalEdges.push(edge);
      if (edge.from !== edge.to) {
        unassignedNeighborSets.get(edge.from)?.add(edge.to);
        unassignedNeighborSets.get(edge.to)?.add(edge.from);
      }
      continue;
    }

    const regionId = fromRegionId ?? toRegionId!;
    const unassignedNodeId = fromRegionId ? edge.to : edge.from;
    const key = pairKey(regionId, unassignedNodeId);
    const boundary = unassignedBoundaries.get(key) ?? {
      regionId,
      unassignedNodeId,
      edgeIds: [],
      backboneEdgeIds: [],
      directions: {
        fromRegionEdgeIds: [],
        fromUnassignedNodeEdgeIds: [],
        undirectedEdgeIds: [],
      },
    };
    boundary.edgeIds.push(edge.id);
    if (backboneEdgeIds.has(edge.id)) boundary.backboneEdgeIds.push(edge.id);
    if (!edge.directed) boundary.directions.undirectedEdgeIds.push(edge.id);
    else if (fromRegionId) boundary.directions.fromRegionEdgeIds.push(edge.id);
    else boundary.directions.fromUnassignedNodeEdgeIds.push(edge.id);
    unassignedBoundaries.set(key, boundary);
    boundaryEdgeIdsByRegion.get(regionId)?.push(edge.id);
    unassignedNeighborNodeIdsByRegion.get(regionId)?.add(unassignedNodeId);
  }

  const boundaryValues = [...unassignedBoundaries.values()].sort(
    (left, right) =>
      stableCompare(left.regionId, right.regionId) ||
      stableCompare(left.unassignedNodeId, right.unassignedNodeId),
  );
  const boundaryByUnassignedNodeId = new Map<string, MutableUnassignedBoundary[]>();
  for (const boundary of boundaryValues) {
    const values = boundaryByUnassignedNodeId.get(boundary.unassignedNodeId) ?? [];
    values.push(boundary);
    boundaryByUnassignedNodeId.set(boundary.unassignedNodeId, values);
  }

  const unassignedComponents: StructureRegionUnassignedComponent[] = [];
  const assignedUnassignedNodeIds = new Set<string>();
  for (const firstNodeId of [...unassignedNeighborSets.keys()].sort(stableCompare)) {
    if (assignedUnassignedNodeIds.has(firstNodeId)) continue;
    const componentNodeIds: string[] = [];
    const queue = [firstNodeId];
    assignedUnassignedNodeIds.add(firstNodeId);
    for (let index = 0; index < queue.length; index += 1) {
      const nodeId = queue[index]!;
      componentNodeIds.push(nodeId);
      for (const neighbor of [...(unassignedNeighborSets.get(nodeId) ?? [])].sort(stableCompare)) {
        if (assignedUnassignedNodeIds.has(neighbor)) continue;
        assignedUnassignedNodeIds.add(neighbor);
        queue.push(neighbor);
      }
    }
    componentNodeIds.sort(stableCompare);
    const memberIds = new Set(componentNodeIds);
    const internalEdgeIds = unassignedInternalEdges
      .filter((edge) => memberIds.has(edge.from) && memberIds.has(edge.to))
      .map(({ id }) => id);
    const boundaries = componentNodeIds.flatMap(
      (nodeId) => boundaryByUnassignedNodeId.get(nodeId) ?? [],
    );
    const boundaryEdgeIds = sortedUnique(boundaries.flatMap(({ edgeIds }) => edgeIds));
    unassignedComponents.push({
      nodeIds: componentNodeIds,
      internalEdgeIds,
      boundaryEdgeIds,
      backboneEdgeIds: sortedUnique(
        [...internalEdgeIds, ...boundaryEdgeIds].filter((edgeId) => backboneEdgeIds.has(edgeId)),
      ),
      adjacentRegionIds: sortedUnique(boundaries.map(({ regionId }) => regionId)),
    });
  }

  return {
    startRegionId: regionByNodeId.get(presentation.startNodeId) ?? null,
    regions: regions.map((region) => ({
      id: region.id,
      label: region.label,
      summary: region.summary,
      nodeIds: region.nodeIds,
      nodeCount: region.nodeIds.length,
      internalEdgeIds: sortedUnique(internalEdgeIdsByRegion.get(region.id) ?? []),
      boundaryEdgeIds: sortedUnique(boundaryEdgeIdsByRegion.get(region.id) ?? []),
      backboneEdgeIds: sortedUnique(backboneEdgeIdsByRegion.get(region.id) ?? []),
      adjacentRegionIds: sortedUnique(adjacentRegionIdsByRegion.get(region.id) ?? []),
      unassignedNeighborNodeIds: sortedUnique(
        unassignedNeighborNodeIdsByRegion.get(region.id) ?? [],
      ),
    })),
    directRelations: [...directRelations.values()].sort((left, right) => {
      const first = stableCompare(left.regionIds[0], right.regionIds[0]);
      return first === 0 ? stableCompare(left.regionIds[1], right.regionIds[1]) : first;
    }),
    unassignedBoundaries: boundaryValues,
    unassignedComponents,
  };
}

function contextId(nodeIds: readonly string[]): string {
  return `context:${JSON.stringify(nodeIds)}`;
}

/**
 * Gives the partial-membership remainder an explicit, neutral surface. Boundary relations are
 * aggregated only from exact Region↔unassigned-node Edges; this never synthesizes a transitive
 * Region relation through the component.
 */
export function deriveStructureRegionContextSurface(
  model: StructureRegionOverviewModel,
): StructureRegionContextSurface {
  const contexts = model.unassignedComponents.map((component) => ({
    id: contextId(component.nodeIds),
    ...component,
  }));
  const contextIdByNodeId = new Map(
    contexts.flatMap((context) => context.nodeIds.map((nodeId) => [nodeId, context.id] as const)),
  );
  const mutableRelations = new Map<
    string,
    {
      contextId: string;
      regionId: string;
      edgeIds: string[];
      backboneEdgeIds: string[];
      directions: {
        fromRegionEdgeIds: string[];
        fromUnassignedNodeEdgeIds: string[];
        undirectedEdgeIds: string[];
      };
    }
  >();
  for (const boundary of model.unassignedBoundaries) {
    const derivedContextId = contextIdByNodeId.get(boundary.unassignedNodeId);
    if (!derivedContextId) continue;
    const key = pairKey(boundary.regionId, derivedContextId);
    const relation = mutableRelations.get(key) ?? {
      contextId: derivedContextId,
      regionId: boundary.regionId,
      edgeIds: [],
      backboneEdgeIds: [],
      directions: {
        fromRegionEdgeIds: [],
        fromUnassignedNodeEdgeIds: [],
        undirectedEdgeIds: [],
      },
    };
    relation.edgeIds.push(...boundary.edgeIds);
    relation.backboneEdgeIds.push(...boundary.backboneEdgeIds);
    relation.directions.fromRegionEdgeIds.push(...boundary.directions.fromRegionEdgeIds);
    relation.directions.fromUnassignedNodeEdgeIds.push(
      ...boundary.directions.fromUnassignedNodeEdgeIds,
    );
    relation.directions.undirectedEdgeIds.push(...boundary.directions.undirectedEdgeIds);
    mutableRelations.set(key, relation);
  }
  return {
    contexts,
    boundaryRelations: [...mutableRelations.values()]
      .map((relation) => ({
        ...relation,
        edgeIds: sortedUnique(relation.edgeIds),
        backboneEdgeIds: sortedUnique(relation.backboneEdgeIds),
        directions: {
          fromRegionEdgeIds: sortedUnique(relation.directions.fromRegionEdgeIds),
          fromUnassignedNodeEdgeIds: sortedUnique(relation.directions.fromUnassignedNodeEdgeIds),
          undirectedEdgeIds: sortedUnique(relation.directions.undirectedEdgeIds),
        },
      }))
      .sort(
        (left, right) =>
          stableCompare(left.regionId, right.regionId) ||
          stableCompare(left.contextId, right.contextId),
      ),
  };
}

function overviewRelationWeight(relation: StructureRegionDirectRelation): number {
  return relation.backboneEdgeIds.length > 0 ? 3 : 1;
}

function overviewDirectedRegionIds(
  relation: StructureRegionDirectRelation,
): readonly [from: string, to: string] | null {
  const { fromFirstRegionEdgeIds, fromSecondRegionEdgeIds, undirectedEdgeIds } =
    relation.directions;
  if (undirectedEdgeIds.length > 0) return null;
  if (fromFirstRegionEdgeIds.length > 0 && fromSecondRegionEdgeIds.length === 0) {
    return relation.regionIds;
  }
  if (fromSecondRegionEdgeIds.length > 0 && fromFirstRegionEdgeIds.length === 0) {
    return [relation.regionIds[1], relation.regionIds[0]];
  }
  return null;
}

/**
 * Places the compact Region overview on a small deterministic grid. The grid is derived from
 * direct Region adjacency, not presentation array order; primary-backbone adjacency receives a
 * stronger proximity weight. Coordinates are ready for an SVG viewBox or absolutely-positioned
 * cards using the exported card and gap constants.
 */
export function layoutStructureRegionOverview(
  model: StructureRegionOverviewModel,
): StructureRegionOverviewLayout {
  if (model.regions.length === 0) {
    return {
      width: 0,
      height: 0,
      columnCount: 0,
      rowCount: 0,
      regions: [],
      directRelations: [],
    };
  }
  const regionIds = model.regions.map(({ id }) => id).sort(stableCompare);
  const neighbors = new Map(regionIds.map((regionId) => [regionId, new Map<string, number>()]));
  for (const relation of model.directRelations) {
    const [first, second] = relation.regionIds;
    const weight = overviewRelationWeight(relation);
    neighbors.get(first)?.set(second, weight);
    neighbors.get(second)?.set(first, weight);
  }
  const relationByPair = new Map(
    model.directRelations.map((relation) => [JSON.stringify(relation.regionIds), relation]),
  );
  const weightedDegree = (regionId: string): number =>
    [...(neighbors.get(regionId)?.values() ?? [])].reduce((sum, weight) => sum + weight, 0);
  const placementOrder: string[] = [];
  const unplaced = new Set(regionIds);
  const placed = new Set<string>();
  while (unplaced.size > 0) {
    const next = [...unplaced].sort((left, right) => {
      if (placementOrder.length === 0 && model.startRegionId) {
        if (left === model.startRegionId) return -1;
        if (right === model.startRegionId) return 1;
      }
      const placedAffinity = (regionId: string): number =>
        [...(neighbors.get(regionId) ?? [])].reduce(
          (sum, [neighborId, weight]) => sum + (placed.has(neighborId) ? weight : 0),
          0,
        );
      return (
        placedAffinity(right) - placedAffinity(left) ||
        weightedDegree(right) - weightedDegree(left) ||
        stableCompare(left, right)
      );
    })[0]!;
    placementOrder.push(next);
    placed.add(next);
    unplaced.delete(next);
  }

  const targetAspectRatio = 5 / 3;
  const minimumColumns = model.regions.length === 1 ? 1 : 2;
  const maximumColumns = Math.max(
    minimumColumns,
    Math.min(model.regions.length, Math.ceil(Math.sqrt(model.regions.length * 2))),
  );
  const candidates: Array<{
    columnCount: number;
    rowCount: number;
    cellByRegionId: Map<string, { column: number; row: number }>;
    score: number;
    signature: string;
  }> = [];
  for (let columnCount = minimumColumns; columnCount <= maximumColumns; columnCount += 1) {
    const rowCount = Math.ceil(regionIds.length / columnCount);
    const available = Array.from({ length: regionIds.length }, (_, index) => ({
      column: index % columnCount,
      row: Math.floor(index / columnCount),
    }));
    const cellByRegionId = new Map<string, { column: number; row: number }>();
    for (const [index, regionId] of placementOrder.entries()) {
      const chosen = [...available].sort((left, right) => {
        if (index === 0) {
          return (
            left.column - right.column ||
            Math.abs(left.row - (rowCount - 1) / 2) - Math.abs(right.row - (rowCount - 1) / 2) ||
            left.row - right.row
          );
        }
        const cellScore = (cell: { column: number; row: number }) => {
          let adjacencyDistance = 0;
          let adjacencyWeight = 0;
          let directionPenalty = 0;
          for (const [neighborId, weight] of neighbors.get(regionId) ?? []) {
            const neighborCell = cellByRegionId.get(neighborId);
            if (!neighborCell) continue;
            adjacencyWeight += weight;
            adjacencyDistance +=
              weight *
              (Math.abs(cell.column - neighborCell.column) + Math.abs(cell.row - neighborCell.row));
            const relation = relationByPair.get(
              JSON.stringify([regionId, neighborId].sort(stableCompare)),
            );
            const direction = relation ? overviewDirectedRegionIds(relation) : null;
            if (direction?.[0] === neighborId && cell.column < neighborCell.column) {
              directionPenalty += 1;
            }
            if (direction?.[1] === neighborId && cell.column > neighborCell.column) {
              directionPenalty += 1;
            }
          }
          const nearestPlaced = Math.min(
            ...[...cellByRegionId.values()].map(
              (placedCell) =>
                Math.abs(cell.column - placedCell.column) + Math.abs(cell.row - placedCell.row),
            ),
          );
          return { adjacencyWeight, adjacencyDistance, directionPenalty, nearestPlaced };
        };
        const leftScore = cellScore(left);
        const rightScore = cellScore(right);
        return (
          Number(rightScore.adjacencyWeight > 0) - Number(leftScore.adjacencyWeight > 0) ||
          leftScore.directionPenalty - rightScore.directionPenalty ||
          leftScore.adjacencyDistance - rightScore.adjacencyDistance ||
          leftScore.nearestPlaced - rightScore.nearestPlaced ||
          left.row - right.row ||
          left.column - right.column
        );
      })[0]!;
      cellByRegionId.set(regionId, chosen);
      available.splice(available.indexOf(chosen), 1);
    }
    const width =
      columnCount * STRUCTURE_REGION_OVERVIEW_CARD_WIDTH +
      Math.max(0, columnCount - 1) * STRUCTURE_REGION_OVERVIEW_COLUMN_GAP;
    const height =
      rowCount * STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT +
      Math.max(0, rowCount - 1) * STRUCTURE_REGION_OVERVIEW_ROW_GAP;
    const relationSpan = model.directRelations.reduce((sum, relation) => {
      const first = cellByRegionId.get(relation.regionIds[0])!;
      const second = cellByRegionId.get(relation.regionIds[1])!;
      return (
        sum +
        overviewRelationWeight(relation) *
          (Math.abs(first.column - second.column) + Math.abs(first.row - second.row))
      );
    }, 0);
    const directionViolations = model.directRelations.filter((relation) => {
      const direction = overviewDirectedRegionIds(relation);
      if (!direction) return false;
      return cellByRegionId.get(direction[0])!.column > cellByRegionId.get(direction[1])!.column;
    }).length;
    candidates.push({
      columnCount,
      rowCount,
      cellByRegionId,
      score:
        Math.max(width / targetAspectRatio, height) + relationSpan * 36 + directionViolations * 120,
      signature: regionIds
        .map((regionId) => {
          const cell = cellByRegionId.get(regionId)!;
          return `${regionId}:${cell.column},${cell.row}`;
        })
        .join("|"),
    });
  }
  candidates.sort(
    (left, right) =>
      left.score - right.score ||
      left.columnCount * left.rowCount - right.columnCount * right.rowCount ||
      stableCompare(left.signature, right.signature),
  );
  const selected = candidates[0]!;
  const regionLayouts = regionIds.map((regionId): StructureRegionOverviewLayoutRegion => {
    const cell = selected.cellByRegionId.get(regionId)!;
    return {
      regionId,
      ...cell,
      center: {
        x:
          cell.column *
            (STRUCTURE_REGION_OVERVIEW_CARD_WIDTH + STRUCTURE_REGION_OVERVIEW_COLUMN_GAP) +
          STRUCTURE_REGION_OVERVIEW_CARD_WIDTH / 2,
        y:
          cell.row * (STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT + STRUCTURE_REGION_OVERVIEW_ROW_GAP) +
          STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT / 2,
      },
    };
  });
  const centerByRegionId = new Map(regionLayouts.map(({ regionId, center }) => [regionId, center]));
  return {
    width:
      selected.columnCount * STRUCTURE_REGION_OVERVIEW_CARD_WIDTH +
      Math.max(0, selected.columnCount - 1) * STRUCTURE_REGION_OVERVIEW_COLUMN_GAP,
    height:
      selected.rowCount * STRUCTURE_REGION_OVERVIEW_CARD_HEIGHT +
      Math.max(0, selected.rowCount - 1) * STRUCTURE_REGION_OVERVIEW_ROW_GAP,
    columnCount: selected.columnCount,
    rowCount: selected.rowCount,
    regions: regionLayouts,
    directRelations: model.directRelations.map((relation) => ({
      regionIds: relation.regionIds,
      edgeIds: relation.edgeIds,
      backboneEdgeIds: relation.backboneEdgeIds,
      directions: relation.directions,
      firstCenter: centerByRegionId.get(relation.regionIds[0])!,
      secondCenter: centerByRegionId.get(relation.regionIds[1])!,
    })),
  };
}

interface RoutingRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface RoutingEndpoint {
  port: StructureRegionOverviewPoint;
  escape: StructureRegionOverviewPoint;
}

interface RoutingGridResult {
  points: StructureRegionOverviewPoint[];
  start: StructureRegionOverviewPoint;
  target: StructureRegionOverviewPoint;
}

interface RoutingPolyline {
  points: readonly StructureRegionOverviewPoint[];
}

interface RoutingQueueEntry {
  cost: number;
  state: number;
}

const ROUTING_EPSILON = 0.001;
const ROUTING_BEND_PENALTY = 34;
const ROUTING_CROSSING_PENALTY = 72;
const ROUTING_SHARED_LANE_PENALTY = 520;
const ROUTING_MINIMUM_SHARED_LANE = 48;
// Exact congestion-aware routing is intentionally reserved for surfaces where individual lanes
// remain legible. Beyond this point its repeated shortest-path and label-collision scans grow
// superlinearly, while the visual result is congested anyway. Dense surfaces use deterministic
// relation shelves below the map; every relation remains exact and card-safe, and runtime stays
// bounded by the number of distinct endpoint cards rather than the number of relations.
const ROUTING_DENSE_RELATION_THRESHOLD = 32;
const ROUTING_DENSE_CARD_RELATION_PRODUCT = 1_024;

function routingPointKey(point: StructureRegionOverviewPoint): string {
  return `${point.x}:${point.y}`;
}

function routingRectForCard(card: StructureRegionOverviewRouteCard, expansion = 0): RoutingRect {
  return {
    id: card.id,
    left: card.center.x - card.width / 2 - expansion,
    top: card.center.y - card.height / 2 - expansion,
    right: card.center.x + card.width / 2 + expansion,
    bottom: card.center.y + card.height / 2 + expansion,
  };
}

function routingRectForLabel(
  center: StructureRegionOverviewPoint,
  width: number,
  height: number,
  expansion = 0,
): RoutingRect {
  return {
    id: "label",
    left: center.x - width / 2 - expansion,
    top: center.y - height / 2 - expansion,
    right: center.x + width / 2 + expansion,
    bottom: center.y + height / 2 + expansion,
  };
}

function routingRectsOverlap(left: RoutingRect, right: RoutingRect): boolean {
  return (
    left.left < right.right - ROUTING_EPSILON &&
    left.right > right.left + ROUTING_EPSILON &&
    left.top < right.bottom - ROUTING_EPSILON &&
    left.bottom > right.top + ROUTING_EPSILON
  );
}

function routingPointInsideRect(point: StructureRegionOverviewPoint, rect: RoutingRect): boolean {
  return (
    point.x > rect.left + ROUTING_EPSILON &&
    point.x < rect.right - ROUTING_EPSILON &&
    point.y > rect.top + ROUTING_EPSILON &&
    point.y < rect.bottom - ROUTING_EPSILON
  );
}

function routingSegmentIntersectsRect(
  first: StructureRegionOverviewPoint,
  second: StructureRegionOverviewPoint,
  rect: RoutingRect,
): boolean {
  if (Math.abs(first.y - second.y) < ROUTING_EPSILON) {
    if (first.y <= rect.top + ROUTING_EPSILON || first.y >= rect.bottom - ROUTING_EPSILON) {
      return false;
    }
    const left = Math.min(first.x, second.x);
    const right = Math.max(first.x, second.x);
    return left < rect.right - ROUTING_EPSILON && right > rect.left + ROUTING_EPSILON;
  }
  if (Math.abs(first.x - second.x) < ROUTING_EPSILON) {
    if (first.x <= rect.left + ROUTING_EPSILON || first.x >= rect.right - ROUTING_EPSILON) {
      return false;
    }
    const top = Math.min(first.y, second.y);
    const bottom = Math.max(first.y, second.y);
    return top < rect.bottom - ROUTING_EPSILON && bottom > rect.top + ROUTING_EPSILON;
  }
  return true;
}

function routingSegmentIntersectionPenalty(
  first: StructureRegionOverviewPoint,
  second: StructureRegionOverviewPoint,
  routed: readonly RoutingPolyline[],
): number {
  let penalty = 0;
  const horizontal = Math.abs(first.y - second.y) < ROUTING_EPSILON;
  for (const route of routed) {
    for (let index = 1; index < route.points.length; index += 1) {
      const otherFirst = route.points[index - 1]!;
      const otherSecond = route.points[index]!;
      const otherHorizontal = Math.abs(otherFirst.y - otherSecond.y) < ROUTING_EPSILON;
      if (horizontal === otherHorizontal) {
        if (
          horizontal
            ? Math.abs(first.y - otherFirst.y) >= ROUTING_EPSILON
            : Math.abs(first.x - otherFirst.x) >= ROUTING_EPSILON
        ) {
          continue;
        }
        const firstStart = horizontal ? Math.min(first.x, second.x) : Math.min(first.y, second.y);
        const firstEnd = horizontal ? Math.max(first.x, second.x) : Math.max(first.y, second.y);
        const otherStart = horizontal
          ? Math.min(otherFirst.x, otherSecond.x)
          : Math.min(otherFirst.y, otherSecond.y);
        const otherEnd = horizontal
          ? Math.max(otherFirst.x, otherSecond.x)
          : Math.max(otherFirst.y, otherSecond.y);
        const overlap = Math.min(firstEnd, otherEnd) - Math.max(firstStart, otherStart);
        // A few pixels at a common card port are a junction, not a confusing shared corridor.
        if (overlap >= ROUTING_MINIMUM_SHARED_LANE) {
          penalty += ROUTING_SHARED_LANE_PENALTY + overlap;
        }
        continue;
      }
      const horizontalFirst = horizontal ? first : otherFirst;
      const horizontalSecond = horizontal ? second : otherSecond;
      const verticalFirst = horizontal ? otherFirst : first;
      const verticalSecond = horizontal ? otherSecond : second;
      const horizontalLeft = Math.min(horizontalFirst.x, horizontalSecond.x);
      const horizontalRight = Math.max(horizontalFirst.x, horizontalSecond.x);
      const verticalTop = Math.min(verticalFirst.y, verticalSecond.y);
      const verticalBottom = Math.max(verticalFirst.y, verticalSecond.y);
      if (
        verticalFirst.x > horizontalLeft + ROUTING_EPSILON &&
        verticalFirst.x < horizontalRight - ROUTING_EPSILON &&
        horizontalFirst.y > verticalTop + ROUTING_EPSILON &&
        horizontalFirst.y < verticalBottom - ROUTING_EPSILON
      ) {
        penalty += ROUTING_CROSSING_PENALTY;
      }
    }
  }
  return penalty;
}

function routingQueueLess(left: RoutingQueueEntry, right: RoutingQueueEntry): boolean {
  return left.cost < right.cost || (left.cost === right.cost && left.state < right.state);
}

function routingQueuePush(heap: RoutingQueueEntry[], entry: RoutingQueueEntry): void {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!routingQueueLess(heap[index]!, heap[parent]!)) break;
    [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
    index = parent;
  }
}

function routingQueuePop(heap: RoutingQueueEntry[]): RoutingQueueEntry | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  heap[0] = last;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && routingQueueLess(heap[left]!, heap[smallest]!)) smallest = left;
    if (right < heap.length && routingQueueLess(heap[right]!, heap[smallest]!)) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
    index = smallest;
  }
  return first;
}

function sortedRoutingAxes(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function routingAxesWithCorridorCenters(values: Iterable<number>): number[] {
  const boundaries = sortedRoutingAxes(values);
  return sortedRoutingAxes([
    ...boundaries,
    ...boundaries.slice(1).map((value, index) => (boundaries[index]! + value) / 2),
  ]);
}

function simplifyOrthogonalPoints(
  points: readonly StructureRegionOverviewPoint[],
): StructureRegionOverviewPoint[] {
  const distinct = points.filter(
    (point, index) => index === 0 || routingPointKey(point) !== routingPointKey(points[index - 1]!),
  );
  return distinct.filter((point, index) => {
    if (index === 0 || index === distinct.length - 1) return true;
    const previous = distinct[index - 1]!;
    const next = distinct[index + 1]!;
    return !(
      (Math.abs(previous.x - point.x) < ROUTING_EPSILON &&
        Math.abs(point.x - next.x) < ROUTING_EPSILON) ||
      (Math.abs(previous.y - point.y) < ROUTING_EPSILON &&
        Math.abs(point.y - next.y) < ROUTING_EPSILON)
    );
  });
}

function routeCardEndpoints(
  card: StructureRegionOverviewRouteCard,
  clearance: number,
): RoutingEndpoint[] {
  const halfWidth = card.width / 2;
  const halfHeight = card.height / 2;
  return [
    {
      port: { x: card.center.x - halfWidth, y: card.center.y },
      escape: { x: card.center.x - halfWidth - clearance, y: card.center.y },
    },
    {
      port: { x: card.center.x + halfWidth, y: card.center.y },
      escape: { x: card.center.x + halfWidth + clearance, y: card.center.y },
    },
    {
      port: { x: card.center.x, y: card.center.y - halfHeight },
      escape: { x: card.center.x, y: card.center.y - halfHeight - clearance },
    },
    {
      port: { x: card.center.x, y: card.center.y + halfHeight },
      escape: { x: card.center.x, y: card.center.y + halfHeight + clearance },
    },
  ];
}

function findOrthogonalGridRoute(input: {
  starts: readonly StructureRegionOverviewPoint[];
  targets: readonly StructureRegionOverviewPoint[];
  obstacles: readonly RoutingRect[];
  routed: readonly RoutingPolyline[];
  width: number;
  height: number;
  extraX?: readonly number[];
  extraY?: readonly number[];
}): RoutingGridResult | null {
  const xValues = routingAxesWithCorridorCenters([
    STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE,
    input.width - STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE,
    ...input.starts.map(({ x }) => x),
    ...input.targets.map(({ x }) => x),
    ...(input.extraX ?? []),
    ...input.obstacles.flatMap(({ left, right }) => [left, right]),
  ]);
  const yValues = routingAxesWithCorridorCenters([
    STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE,
    input.height - STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE,
    ...input.starts.map(({ y }) => y),
    ...input.targets.map(({ y }) => y),
    ...(input.extraY ?? []),
    ...input.obstacles.flatMap(({ top, bottom }) => [top, bottom]),
  ]);
  const xIndexByValue = new Map(xValues.map((value, index) => [value, index]));
  const yIndexByValue = new Map(yValues.map((value, index) => [value, index]));
  const pointIndex = (xIndex: number, yIndex: number): number => yIndex * xValues.length + xIndex;
  const pointAt = (index: number): StructureRegionOverviewPoint => ({
    x: xValues[index % xValues.length]!,
    y: yValues[Math.floor(index / xValues.length)]!,
  });
  const pointIsAvailable = (point: StructureRegionOverviewPoint): boolean =>
    !input.obstacles.some((obstacle) => routingPointInsideRect(point, obstacle));
  const available = new Uint8Array(xValues.length * yValues.length);
  for (let yIndex = 0; yIndex < yValues.length; yIndex += 1) {
    for (let xIndex = 0; xIndex < xValues.length; xIndex += 1) {
      const index = pointIndex(xIndex, yIndex);
      if (pointIsAvailable(pointAt(index))) available[index] = 1;
    }
  }
  const indicesForPoints = (points: readonly StructureRegionOverviewPoint[]): number[] =>
    points.flatMap((point) => {
      const xIndex = xIndexByValue.get(point.x);
      const yIndex = yIndexByValue.get(point.y);
      if (xIndex === undefined || yIndex === undefined) return [];
      const index = pointIndex(xIndex, yIndex);
      return available[index] === 1 ? [index] : [];
    });
  const startIndices = indicesForPoints(input.starts);
  const targetIndices = new Set(indicesForPoints(input.targets));
  if (startIndices.length === 0 || targetIndices.size === 0) return null;

  // Direction is part of the state so a bend can be priced without losing the shortest-path
  // guarantee. 0 = no previous segment, 1 = horizontal, 2 = vertical.
  const stateCount = xValues.length * yValues.length * 3;
  const distance = new Float64Array(stateCount);
  distance.fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(stateCount);
  previous.fill(-1);
  const queue: RoutingQueueEntry[] = [];
  for (const index of startIndices.sort((left, right) => left - right)) {
    const state = index * 3;
    distance[state] = 0;
    routingQueuePush(queue, { cost: 0, state });
  }

  let finalState = -1;
  while (queue.length > 0) {
    const current = routingQueuePop(queue)!;
    if (current.cost !== distance[current.state]) continue;
    const currentPointIndex = Math.floor(current.state / 3);
    const currentDirection = current.state % 3;
    if (targetIndices.has(currentPointIndex)) {
      finalState = current.state;
      break;
    }
    const xIndex = currentPointIndex % xValues.length;
    const yIndex = Math.floor(currentPointIndex / xValues.length);
    const neighborCoordinates = [
      [xIndex - 1, yIndex, 1],
      [xIndex + 1, yIndex, 1],
      [xIndex, yIndex - 1, 2],
      [xIndex, yIndex + 1, 2],
    ] as const;
    const currentPoint = pointAt(currentPointIndex);
    for (const [neighborX, neighborY, direction] of neighborCoordinates) {
      if (
        neighborX < 0 ||
        neighborX >= xValues.length ||
        neighborY < 0 ||
        neighborY >= yValues.length
      ) {
        continue;
      }
      const neighborPointIndex = pointIndex(neighborX, neighborY);
      if (available[neighborPointIndex] !== 1) continue;
      const neighborPoint = pointAt(neighborPointIndex);
      // Every obstacle boundary is a grid axis. Therefore an edge between adjacent grid points
      // cannot enter a rectangle without one endpoint being inside it (or crossing an intervening
      // boundary axis). Availability above is sufficient and avoids an obstacle scan per edge.
      const length =
        Math.abs(currentPoint.x - neighborPoint.x) + Math.abs(currentPoint.y - neighborPoint.y);
      const bend =
        currentDirection !== 0 && currentDirection !== direction ? ROUTING_BEND_PENALTY : 0;
      const congestion = routingSegmentIntersectionPenalty(
        currentPoint,
        neighborPoint,
        input.routed,
      );
      const nextState = neighborPointIndex * 3 + direction;
      const nextDistance = current.cost + length + bend + congestion;
      if (nextDistance + ROUTING_EPSILON >= distance[nextState]!) continue;
      distance[nextState] = nextDistance;
      previous[nextState] = current.state;
      routingQueuePush(queue, { cost: nextDistance, state: nextState });
    }
  }
  if (finalState < 0) return null;
  const reversedPointIndices: number[] = [];
  for (let state = finalState; state >= 0; state = previous[state]!) {
    reversedPointIndices.push(Math.floor(state / 3));
    if (previous[state]! < 0) break;
  }
  const points = reversedPointIndices.reverse().map(pointAt);
  return {
    points: simplifyOrthogonalPoints(points),
    start: points[0]!,
    target: points.at(-1)!,
  };
}

function routingPolylineSegments(
  points: readonly StructureRegionOverviewPoint[],
): Array<readonly [StructureRegionOverviewPoint, StructureRegionOverviewPoint]> {
  return points.slice(1).map((point, index) => [points[index]!, point] as const);
}

function routingLabelCandidates(
  points: readonly StructureRegionOverviewPoint[],
  width: number,
  height: number,
): Array<{ center: StructureRegionOverviewPoint; distanceFromMiddle: number }> {
  const segments = routingPolylineSegments(points);
  const lengths = segments.map(
    ([first, second]) => Math.abs(first.x - second.x) + Math.abs(first.y - second.y),
  );
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const candidates: Array<{ center: StructureRegionOverviewPoint; distanceFromMiddle: number }> =
    [];
  let traversed = 0;
  for (const [index, [first, second]] of segments.entries()) {
    const horizontal = Math.abs(first.y - second.y) < ROUTING_EPSILON;
    const firstAxis = horizontal ? first.x : first.y;
    const secondAxis = horizontal ? second.x : second.y;
    const firstIsLower = firstAxis <= secondAxis;
    const isFirstSegment = index === 0;
    const isLastSegment = index === segments.length - 1;
    const lowerTerminalRunway =
      (isFirstSegment && firstIsLower ? STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY : 0) +
      (isLastSegment && !firstIsLower ? STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY : 0);
    const upperTerminalRunway =
      (isFirstSegment && !firstIsLower ? STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY : 0) +
      (isLastSegment && firstIsLower ? STRUCTURE_REGION_OVERVIEW_TERMINAL_RUNWAY : 0);
    const minimum = horizontal
      ? Math.min(first.x, second.x) +
        width / 2 +
        STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE +
        lowerTerminalRunway
      : Math.min(first.y, second.y) +
        height / 2 +
        STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE +
        lowerTerminalRunway;
    const maximum = horizontal
      ? Math.max(first.x, second.x) -
        width / 2 -
        STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE -
        upperTerminalRunway
      : Math.max(first.y, second.y) -
        height / 2 -
        STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE -
        upperTerminalRunway;
    if (minimum <= maximum + ROUTING_EPSILON) {
      const positions = new Set<number>([minimum, maximum, (minimum + maximum) / 2]);
      for (let value = minimum; value <= maximum + ROUTING_EPSILON; value += 12) {
        positions.add(Math.min(value, maximum));
      }
      for (const position of positions) {
        const offset = horizontal ? Math.abs(position - first.x) : Math.abs(position - first.y);
        candidates.push({
          center: horizontal ? { x: position, y: first.y } : { x: first.x, y: position },
          distanceFromMiddle: Math.abs(traversed + offset - totalLength / 2),
        });
      }
    }
    traversed += lengths[index]!;
  }
  return candidates.sort(
    (left, right) =>
      left.distanceFromMiddle - right.distanceFromMiddle ||
      left.center.y - right.center.y ||
      left.center.x - right.center.x,
  );
}

function routingLabelIntersectsPath(rect: RoutingRect, route: RoutingPolyline): boolean {
  return routingPolylineSegments(route.points).some(([first, second]) =>
    routingSegmentIntersectsRect(first, second, rect),
  );
}

function findRoutingLabelCenter(input: {
  points: readonly StructureRegionOverviewPoint[];
  labelWidth: number;
  labelHeight: number;
  cardRects: readonly RoutingRect[];
  labelRects: readonly RoutingRect[];
  routed: readonly RoutingPolyline[];
  width: number;
  height: number;
}): StructureRegionOverviewPoint | undefined {
  return routingLabelCandidates(input.points, input.labelWidth, input.labelHeight)
    .map(({ center }) => center)
    .find((center) => {
      const rawRect = routingRectForLabel(center, input.labelWidth, input.labelHeight);
      const rect = routingRectForLabel(
        center,
        input.labelWidth,
        input.labelHeight,
        STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE,
      );
      return (
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= input.width &&
        rect.bottom <= input.height &&
        !input.cardRects.some((card) => routingRectsOverlap(rect, card)) &&
        !input.labelRects.some((label) => routingRectsOverlap(rect, label)) &&
        !input.routed.some((route) => routingLabelIntersectsPath(rawRect, route))
      );
    });
}

function findOffsetRoutingLabel(input: {
  points: readonly StructureRegionOverviewPoint[];
  labelWidth: number;
  labelHeight: number;
  cardRects: readonly RoutingRect[];
  labelRects: readonly RoutingRect[];
  routed: readonly RoutingPolyline[];
  width: number;
  height: number;
}): {
  center: StructureRegionOverviewPoint;
  leaderPoints: readonly StructureRegionOverviewPoint[];
} | null {
  const segments = routingPolylineSegments(input.points);
  const lengths = segments.map(
    ([first, second]) => Math.abs(first.x - second.x) + Math.abs(first.y - second.y),
  );
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const candidates: Array<{
    center: StructureRegionOverviewPoint;
    leaderPoints: readonly StructureRegionOverviewPoint[];
    score: number;
  }> = [];
  let traversed = 0;
  for (const [index, [first, second]] of segments.entries()) {
    const horizontal = first.y === second.y;
    const minimum = horizontal ? Math.min(first.x, second.x) : Math.min(first.y, second.y);
    const maximum = horizontal ? Math.max(first.x, second.x) : Math.max(first.y, second.y);
    const positions = new Set<number>([minimum, maximum, (minimum + maximum) / 2]);
    for (let value = minimum; value <= maximum + ROUTING_EPSILON; value += 12) {
      positions.add(Math.min(value, maximum));
    }
    const labelHalfExtent = horizontal ? input.labelHeight / 2 : input.labelWidth / 2;
    for (const position of positions) {
      const distanceAlongSegment = Math.abs(position - (horizontal ? first.x : first.y));
      for (const sign of [-1, 1] as const) {
        for (const additionalOffset of [0, 12, 24, 48, 72]) {
          const offset =
            labelHalfExtent + STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE + additionalOffset;
          const anchor = horizontal ? { x: position, y: first.y } : { x: first.x, y: position };
          const center = horizontal
            ? { x: position, y: first.y + sign * offset }
            : { x: first.x + sign * offset, y: position };
          const labelBoundary = horizontal
            ? { x: position, y: center.y - sign * (input.labelHeight / 2) }
            : { x: center.x - sign * (input.labelWidth / 2), y: position };
          const rawRect = routingRectForLabel(center, input.labelWidth, input.labelHeight);
          const rect = routingRectForLabel(
            center,
            input.labelWidth,
            input.labelHeight,
            STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE,
          );
          if (
            rect.left < 0 ||
            rect.top < 0 ||
            rect.right > input.width ||
            rect.bottom > input.height ||
            input.cardRects.some((card) => routingRectsOverlap(rect, card)) ||
            input.labelRects.some((label) => routingRectsOverlap(rect, label)) ||
            input.routed.some((route) => routingLabelIntersectsPath(rawRect, route))
          ) {
            continue;
          }
          if (
            input.cardRects.some((card) =>
              routingSegmentIntersectsRect(anchor, labelBoundary, card),
            ) ||
            input.labelRects.some((label) =>
              routingSegmentIntersectsRect(anchor, labelBoundary, label),
            )
          ) {
            continue;
          }
          candidates.push({
            center,
            leaderPoints:
              routingPointKey(anchor) === routingPointKey(labelBoundary)
                ? []
                : [anchor, labelBoundary],
            score:
              additionalOffset * 4 + Math.abs(traversed + distanceAlongSegment - totalLength / 2),
          });
        }
      }
    }
    traversed += lengths[index]!;
  }
  candidates.sort(
    (left, right) =>
      left.score - right.score || left.center.y - right.center.y || left.center.x - right.center.x,
  );
  return candidates[0] ?? null;
}

interface DenseRoutingCardPath {
  points: readonly StructureRegionOverviewPoint[];
}

/**
 * Dense surfaces cannot make hundreds of independently optimized lanes visually distinct. Route
 * each exact relation through its own labelled shelf instead. Card-to-perimeter paths are cached
 * by endpoint card, so even a maximum-size artifact performs at most two small grid searches per
 * card rather than up to three searches plus exhaustive label scans per relation.
 */
function routeDenseStructureRegionOverviewRelations(input: {
  relations: readonly StructureRegionOverviewRouteRequest[];
  cardById: ReadonlyMap<string, StructureRegionOverviewRouteCard>;
  cardObstacles: readonly RoutingRect[];
  width: number;
  height: number;
}): StructureRegionOverviewRoutingLayout | null {
  const baseGateY = input.height - STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE;
  const leftGate = {
    x: STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE,
    y: baseGateY,
  };
  const rightGate = {
    x: input.width - STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE,
    y: baseGateY,
  };
  const sourcePaths = new Map<string, DenseRoutingCardPath>();
  const targetPaths = new Map<string, DenseRoutingCardPath>();

  const sourcePath = (card: StructureRegionOverviewRouteCard): DenseRoutingCardPath | null => {
    const cached = sourcePaths.get(card.id);
    if (cached) return cached;
    const endpoints = routeCardEndpoints(card, STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE);
    const gridRoute = findOrthogonalGridRoute({
      starts: endpoints.map(({ escape }) => escape),
      targets: [leftGate],
      obstacles: input.cardObstacles,
      routed: [],
      width: input.width,
      height: input.height,
    });
    if (!gridRoute) return null;
    const endpoint = endpoints.find(
      ({ escape }) => routingPointKey(escape) === routingPointKey(gridRoute.start),
    );
    if (!endpoint) return null;
    const path = {
      points: simplifyOrthogonalPoints([endpoint.port, ...gridRoute.points]),
    };
    sourcePaths.set(card.id, path);
    return path;
  };

  const targetPath = (card: StructureRegionOverviewRouteCard): DenseRoutingCardPath | null => {
    const cached = targetPaths.get(card.id);
    if (cached) return cached;
    const endpoints = routeCardEndpoints(card, STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE);
    const gridRoute = findOrthogonalGridRoute({
      starts: [rightGate],
      targets: endpoints.map(({ escape }) => escape),
      obstacles: input.cardObstacles,
      routed: [],
      width: input.width,
      height: input.height,
    });
    if (!gridRoute) return null;
    const endpoint = endpoints.find(
      ({ escape }) => routingPointKey(escape) === routingPointKey(gridRoute.target),
    );
    if (!endpoint) return null;
    const path = {
      points: simplifyOrthogonalPoints([...gridRoute.points, endpoint.port]),
    };
    targetPaths.set(card.id, path);
    return path;
  };

  let height = input.height;
  const routes: StructureRegionOverviewRoutedRelation[] = [];
  for (const relation of input.relations) {
    const source = input.cardById.get(relation.fromCardId);
    const target = input.cardById.get(relation.toCardId);
    if (!source || !target || source.id === target.id) continue;
    const fromSource = sourcePath(source);
    const toTarget = targetPath(target);
    if (!fromSource || !toTarget) return null;

    const shelfY =
      height +
      STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE * 2 +
      relation.labelHeight / 2 +
      STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE;
    height = shelfY + relation.labelHeight / 2 + STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE * 2;
    const labelCenter = {
      x: (leftGate.x + rightGate.x) / 2,
      y: shelfY,
    };
    routes.push({
      id: relation.id,
      points: simplifyOrthogonalPoints([
        ...fromSource.points,
        { x: leftGate.x, y: shelfY },
        { x: rightGate.x, y: shelfY },
        ...toTarget.points,
      ]),
      labelCenter,
      labelPlacement: "shelf",
      labelLeaderPoints: [],
    });
  }
  return { width: input.width, height, routes };
}

/**
 * Routes a Region-mode relationship surface on deterministic orthogonal lanes. Every route avoids
 * non-endpoint responsibility/Context cards. Routes are fixed before pills so a hub's early labels
 * cannot force later relations around the whole map. Pills then claim collision-free on-route or
 * adjacent space; only genuinely dense surfaces fall back to a dedicated bottom shelf.
 */
export function routeStructureRegionOverviewRelations(input: {
  cards: readonly StructureRegionOverviewRouteCard[];
  relations: readonly StructureRegionOverviewRouteRequest[];
  width: number;
  height: number;
}): StructureRegionOverviewRoutingLayout {
  const cards = [...input.cards].sort((left, right) => stableCompare(left.id, right.id));
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const cardRects = cards.map((card) => routingRectForCard(card));
  const cardObstacles = cards.map((card) =>
    routingRectForCard(card, STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE),
  );
  const width = input.width;
  let height = input.height;
  const relations = [...input.relations].sort(
    (left, right) =>
      (left.priority ?? 0) - (right.priority ?? 0) || stableCompare(left.id, right.id),
  );
  if (
    relations.length > ROUTING_DENSE_RELATION_THRESHOLD ||
    cards.length * relations.length > ROUTING_DENSE_CARD_RELATION_PRODUCT
  ) {
    const denseLayout = routeDenseStructureRegionOverviewRelations({
      relations,
      cardById,
      cardObstacles,
      width,
      height,
    });
    if (denseLayout) return denseLayout;
  }
  const provisional: Array<{
    relation: StructureRegionOverviewRouteRequest;
    sourceEndpoints: RoutingEndpoint[];
    targetEndpoints: RoutingEndpoint[];
    points: StructureRegionOverviewPoint[];
  }> = [];
  const routedPolylines: RoutingPolyline[] = [];
  for (const relation of relations) {
    const source = cardById.get(relation.fromCardId);
    const target = cardById.get(relation.toCardId);
    if (!source || !target || source.id === target.id) continue;
    const sourceEndpoints = routeCardEndpoints(source, STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE);
    const targetEndpoints = routeCardEndpoints(target, STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE);
    const gridRoute = findOrthogonalGridRoute({
      starts: sourceEndpoints.map(({ escape }) => escape),
      targets: targetEndpoints.map(({ escape }) => escape),
      obstacles: cardObstacles,
      routed: routedPolylines,
      width,
      height,
    });
    if (!gridRoute) continue;
    const sourceEndpoint = sourceEndpoints.find(
      ({ escape }) => routingPointKey(escape) === routingPointKey(gridRoute.start),
    )!;
    const targetEndpoint = targetEndpoints.find(
      ({ escape }) => routingPointKey(escape) === routingPointKey(gridRoute.target),
    )!;
    const points = simplifyOrthogonalPoints([
      sourceEndpoint.port,
      ...gridRoute.points,
      targetEndpoint.port,
    ]);
    provisional.push({ relation, sourceEndpoints, targetEndpoints, points });
    routedPolylines.push({ points });
  }

  const routes: StructureRegionOverviewRoutedRelation[] = [];
  const labelRects: RoutingRect[] = [];
  for (const current of provisional) {
    const { relation, sourceEndpoints, targetEndpoints } = current;
    const otherRoutes = provisional
      .filter((candidate) => candidate !== current)
      .map(({ points }) => ({ points }));
    let points = current.points;
    let labelCenter = findRoutingLabelCenter({
      points,
      labelWidth: relation.labelWidth,
      labelHeight: relation.labelHeight,
      cardRects,
      labelRects,
      routed: otherRoutes,
      width,
      height,
    });
    let labelPlacement: StructureRegionOverviewRoutedRelation["labelPlacement"] = "route";
    let labelLeaderPoints: readonly StructureRegionOverviewPoint[] = [];
    if (!labelCenter) {
      const offset = findOffsetRoutingLabel({
        points,
        labelWidth: relation.labelWidth,
        labelHeight: relation.labelHeight,
        cardRects,
        labelRects,
        routed: otherRoutes,
        width,
        height,
      });
      if (offset) {
        labelCenter = offset.center;
        labelPlacement = "offset";
        labelLeaderPoints = offset.leaderPoints;
      }
    }

    if (!labelCenter) {
      // A unique shelf is intentionally expensive in space but unambiguous. It is only reached
      // when the ordinary orthogonal route has no card/label-safe segment for this pill.
      const shelfY =
        height +
        STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE * 2 +
        relation.labelHeight / 2 +
        STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE;
      const expandedHeight =
        shelfY + relation.labelHeight / 2 + STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE * 2;
      const leftGate = { x: STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE, y: shelfY };
      const rightGate = {
        x: width - STRUCTURE_REGION_OVERVIEW_ROUTE_CLEARANCE,
        y: shelfY,
      };
      const obstacles = [...cardObstacles, ...labelRects];
      const sourceToShelf = findOrthogonalGridRoute({
        starts: sourceEndpoints.map(({ escape }) => escape),
        targets: [leftGate],
        obstacles,
        routed: otherRoutes,
        width,
        height: expandedHeight,
        extraY: [shelfY],
      });
      const shelfToTarget = findOrthogonalGridRoute({
        starts: [rightGate],
        targets: targetEndpoints.map(({ escape }) => escape),
        obstacles,
        routed: otherRoutes,
        width,
        height: expandedHeight,
        extraY: [shelfY],
      });
      if (sourceToShelf && shelfToTarget) {
        const shelfSourceEndpoint = sourceEndpoints.find(
          ({ escape }) => routingPointKey(escape) === routingPointKey(sourceToShelf.start),
        )!;
        const shelfTargetEndpoint = targetEndpoints.find(
          ({ escape }) => routingPointKey(escape) === routingPointKey(shelfToTarget.target),
        )!;
        points = simplifyOrthogonalPoints([
          shelfSourceEndpoint.port,
          ...sourceToShelf.points,
          rightGate,
          ...shelfToTarget.points,
          shelfTargetEndpoint.port,
        ]);
        labelCenter = { x: (leftGate.x + rightGate.x) / 2, y: shelfY };
        labelPlacement = "shelf";
        labelLeaderPoints = [];
        height = expandedHeight;
        current.points = points;
      }
    }
    if (!labelCenter) {
      // Defensive malformed-layout fallback. A valid two-card surface always has a perimeter path,
      // but keeping a finite result is preferable to dropping an exact factual relation.
      labelCenter = points[Math.floor(points.length / 2)]!;
    }
    labelRects.push(
      routingRectForLabel(
        labelCenter,
        relation.labelWidth,
        relation.labelHeight,
        STRUCTURE_REGION_OVERVIEW_LABEL_CLEARANCE,
      ),
    );
    routes.push({ id: relation.id, points, labelCenter, labelPlacement, labelLeaderPoints });
  }
  return { width, height, routes };
}
