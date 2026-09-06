import type { Structure } from "../domain/models.js";
import type { DocumentPaneId } from "./document-workspace.js";
import {
  initialStructureLayout,
  reconcileStructureLayout,
  structureLayoutBounds,
  type StructureNeighborhoodDepth,
  type StructurePoint,
} from "./structure-graph.js";

export interface StructureViewport {
  x: number;
  y: number;
  scale: number;
}

export interface StructureCameraBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface StructureGuideDisclosure {
  thesis: boolean;
  coreRelations: boolean;
  regions: boolean;
}

export interface StructureNavigationHistoryEntry {
  focusId: string | null;
  depth: StructureNeighborhoodDepth;
  framedRegionIndex: number | null;
  viewport: StructureViewport;
}

const STRUCTURE_CAMERA_PADDING = 36;
const STRUCTURE_CAMERA_TOP_INSET = 52;
const MAX_STRUCTURE_CAMERA_SCALE = 1.25;
const MAX_STRUCTURE_NAVIGATION_HISTORY = 50;

export function initialStructureGuideDisclosure(): StructureGuideDisclosure {
  return {
    thesis: true,
    coreRelations: false,
    regions: false,
  };
}

export function structureBackboneNodeIds(
  structure: Pick<Structure, "edges"> & Partial<Pick<Structure, "presentation">>,
): Set<string> {
  const edgeIds = new Set(structure.presentation?.primaryBackbone?.edgeIds ?? []);
  return new Set(
    structure.edges.flatMap((edge) => (edgeIds.has(edge.id) ? [edge.from, edge.to] : [])),
  );
}

export function structureOneHopNodeIds(
  structure: Pick<Structure, "nodes" | "edges">,
  nodeIds: Iterable<string>,
): Set<string> {
  const result = new Set(nodeIds);
  for (const nodeId of [...result]) {
    for (const edge of structure.edges) {
      if (edge.from !== nodeId && edge.to !== nodeId) continue;
      result.add(edge.from);
      result.add(edge.to);
    }
  }
  const currentNodeIds = new Set(structure.nodes.map((node) => node.id));
  return new Set([...result].filter((nodeId) => currentNodeIds.has(nodeId)));
}

export function structureHomeNodeIds(
  structure: Pick<Structure, "originNodeId" | "nodes" | "edges"> &
    Partial<Pick<Structure, "presentation">>,
): Set<string> {
  const backboneNodeIds = structureBackboneNodeIds(structure);
  const homeNodeId = structure.presentation?.startNodeId ?? structure.originNodeId;
  const coreNodeIds = backboneNodeIds.size > 0 ? backboneNodeIds : new Set([homeNodeId]);
  return structureOneHopNodeIds(structure, coreNodeIds);
}

export function structureViewportForNodeIds(input: {
  nodeIds: Iterable<string>;
  positions: Readonly<Record<string, StructurePoint>>;
  surfaceSize: { width: number; height: number };
  maxScale?: number;
}): StructureViewport | null {
  const { nodeIds, positions, surfaceSize } = input;
  const bounds = structureLayoutBounds(nodeIds, positions);
  if (!bounds) return null;
  return structureViewportForBounds({
    bounds: {
      left: bounds.minX,
      top: bounds.minY,
      right: bounds.maxX,
      bottom: bounds.maxY,
    },
    surfaceSize,
    ...(input.maxScale === undefined ? {} : { maxScale: input.maxScale }),
  });
}

export function structureViewportForBounds(input: {
  bounds: StructureCameraBounds;
  surfaceSize: { width: number; height: number };
  maxScale?: number;
}): StructureViewport | null {
  const { bounds, surfaceSize } = input;
  if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return null;
  const availableWidth = Math.max(1, surfaceSize.width - STRUCTURE_CAMERA_PADDING * 2);
  const availableHeight = Math.max(
    1,
    surfaceSize.height - STRUCTURE_CAMERA_TOP_INSET - STRUCTURE_CAMERA_PADDING,
  );
  const boundsWidth = Math.max(1, bounds.right - bounds.left);
  const boundsHeight = Math.max(1, bounds.bottom - bounds.top);
  const scale = Math.min(
    input.maxScale ?? MAX_STRUCTURE_CAMERA_SCALE,
    Math.max(
      MIN_STRUCTURE_ZOOM,
      Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight),
    ),
  );
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  return {
    scale,
    x: surfaceSize.width / 2 - centerX * scale,
    y: STRUCTURE_CAMERA_TOP_INSET + availableHeight / 2 - centerY * scale,
  };
}

export function initialStructureViewport(input: {
  structure: Pick<Structure, "originNodeId" | "nodes" | "edges"> &
    Partial<Pick<Structure, "presentation">>;
  positions: Readonly<Record<string, StructurePoint>>;
  surfaceSize: { width: number; height: number };
}): StructureViewport {
  const { structure, positions, surfaceSize } = input;
  return (
    structureViewportForNodeIds({
      nodeIds: structureHomeNodeIds(structure),
      positions,
      surfaceSize,
    }) ?? { x: 110, y: 90, scale: 1 }
  );
}

export interface StructureNavigationTarget {
  structureId: string;
  structureUpdatedAt: string;
  pane: DocumentPaneId;
  nodeId: string;
  requestId: number;
}

export const MIN_STRUCTURE_ZOOM = 0.03;
export const MAX_STRUCTURE_ZOOM = 2.5;

export function scaledStructureZoom(currentScale: number, factor: number): number {
  return Math.min(MAX_STRUCTURE_ZOOM, Math.max(MIN_STRUCTURE_ZOOM, currentScale * factor));
}

export interface StructureSession {
  focusId: string | null;
  selectedEdgeId: string | null;
  depth: StructureNeighborhoodDepth;
  framedRegionIndex: number | null;
  positions: Record<string, StructurePoint>;
  viewport: StructureViewport;
  surfaceSize: { width: number; height: number };
  guideDisclosure: StructureGuideDisclosure;
  navigationHistory: StructureNavigationHistoryEntry[];
  /**
   * Client-derived identity of the artifact fields that determine canonical geometry.
   * It deliberately excludes prose and labels, which must not discard reviewer layout.
   */
  layoutBasisKey: string;
  updatedAt: string;
}

const sessions = new Map<string, StructureSession>();

function sessionKey(paneId: DocumentPaneId, structureId: string): string {
  return `${paneId}:${structureId}`;
}

function stableCompare(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

export function structureLayoutBasisKey(
  structure: Pick<Structure, "presentation" | "edges">,
): string {
  const presentation = structure.presentation;
  if (
    !presentation ||
    (presentation.primaryBackbone === null && presentation.regions.length === 0)
  ) {
    return "structure-layout-basis:v1:null";
  }
  const backboneEdgeIds = new Set(presentation.primaryBackbone?.edgeIds ?? []);
  const backboneAdjacency = [
    ...new Set(
      structure.edges.flatMap((edge) => {
        if (!backboneEdgeIds.has(edge.id) || edge.from === edge.to) return [];
        return [JSON.stringify([edge.from, edge.to].sort(stableCompare))];
      }),
    ),
  ].sort(stableCompare);
  return `structure-layout-basis:v1:${JSON.stringify({
    startNodeId: presentation.startNodeId,
    primaryBackbone: presentation.primaryBackbone ? backboneAdjacency : null,
    regions: presentation.regions.map((region) => [...region.nodeIds].sort(stableCompare)),
  })}`;
}

export function appendStructureNavigationHistory(
  history: readonly StructureNavigationHistoryEntry[],
  entry: StructureNavigationHistoryEntry,
): StructureNavigationHistoryEntry[] {
  const previous = history.at(-1);
  if (
    previous?.focusId === entry.focusId &&
    previous.depth === entry.depth &&
    previous.framedRegionIndex === entry.framedRegionIndex &&
    previous.viewport.x === entry.viewport.x &&
    previous.viewport.y === entry.viewport.y &&
    previous.viewport.scale === entry.viewport.scale
  ) {
    return [...history];
  }
  return [...history, entry].slice(-MAX_STRUCTURE_NAVIGATION_HISTORY);
}

export function preserveStructureLayoutScreenPosition(input: {
  viewport: StructureViewport;
  surfaceSize: { width: number; height: number };
  nodeId: string | null;
  nodeIds: Iterable<string>;
  previousPositions: Readonly<Record<string, StructurePoint>>;
  nextPositions: Readonly<Record<string, StructurePoint>>;
}): StructureViewport {
  const { viewport, surfaceSize, nodeId, nodeIds, previousPositions, nextPositions } = input;
  const previous = nodeId ? previousPositions[nodeId] : undefined;
  const next = nodeId ? nextPositions[nodeId] : undefined;
  if (previous && next) {
    return {
      scale: viewport.scale,
      x: viewport.x + (previous.x - next.x) * viewport.scale,
      y: viewport.y + (previous.y - next.y) * viewport.scale,
    };
  }
  const currentNodeIds = [...nodeIds];
  const previousBounds = structureLayoutBounds(currentNodeIds, previousPositions);
  const nextBounds = structureLayoutBounds(currentNodeIds, nextPositions);
  if (!nextBounds) return viewport;
  if (!previousBounds) {
    const nextCenter = {
      x: (nextBounds.minX + nextBounds.maxX) / 2,
      y: (nextBounds.minY + nextBounds.maxY) / 2,
    };
    return {
      scale: viewport.scale,
      x: (surfaceSize.width > 0 ? surfaceSize.width / 2 : 110) - nextCenter.x * viewport.scale,
      y: (surfaceSize.height > 0 ? surfaceSize.height / 2 : 90) - nextCenter.y * viewport.scale,
    };
  }
  const previousCenter = {
    x: (previousBounds.minX + previousBounds.maxX) / 2,
    y: (previousBounds.minY + previousBounds.maxY) / 2,
  };
  const nextCenter = {
    x: (nextBounds.minX + nextBounds.maxX) / 2,
    y: (nextBounds.minY + nextBounds.maxY) / 2,
  };
  return {
    scale: viewport.scale,
    x: viewport.x + (previousCenter.x - nextCenter.x) * viewport.scale,
    y: viewport.y + (previousCenter.y - nextCenter.y) * viewport.scale,
  };
}

export function createStructureSession(structure: Structure): StructureSession {
  const requestedFocusId = structure.presentation?.startNodeId ?? structure.originNodeId;
  const focusId = structure.nodes.some((node) => node.id === requestedFocusId)
    ? requestedFocusId
    : null;
  return {
    focusId,
    selectedEdgeId: null,
    depth: "all",
    framedRegionIndex: null,
    positions: initialStructureLayout(structure),
    viewport: { x: 110, y: 90, scale: 1 },
    surfaceSize: { width: 0, height: 0 },
    guideDisclosure: initialStructureGuideDisclosure(),
    navigationHistory: [],
    layoutBasisKey: structureLayoutBasisKey(structure),
    updatedAt: structure.updatedAt,
  };
}

export function reconcileStructureSession(
  structure: Structure,
  previous: StructureSession,
): StructureSession {
  const nodeIds = new Set(structure.nodes.map((node) => node.id));
  const focusId = previous.focusId && nodeIds.has(previous.focusId) ? previous.focusId : null;
  const layoutBasisKey = structureLayoutBasisKey(structure);
  const layoutBasisChanged = previous.layoutBasisKey !== layoutBasisKey;
  const positions = layoutBasisChanged
    ? initialStructureLayout(structure)
    : reconcileStructureLayout(structure, previous.positions);
  const guideDisclosure = previous.guideDisclosure ?? initialStructureGuideDisclosure();
  const previousFramedRegionIndex = previous.framedRegionIndex ?? null;
  const framedRegionIndex =
    !layoutBasisChanged &&
    previousFramedRegionIndex !== null &&
    structure.presentation?.regions[previousFramedRegionIndex] !== undefined
      ? previousFramedRegionIndex
      : null;
  const navigationHistory = (previous.navigationHistory ?? [])
    .filter((entry) => entry.focusId === null || nodeIds.has(entry.focusId))
    .map((entry) => ({
      ...entry,
      depth: entry.depth ?? previous.depth,
      framedRegionIndex:
        !layoutBasisChanged &&
        entry.framedRegionIndex !== null &&
        entry.framedRegionIndex !== undefined &&
        structure.presentation?.regions[entry.framedRegionIndex] !== undefined
          ? entry.framedRegionIndex
          : null,
      viewport: layoutBasisChanged
        ? preserveStructureLayoutScreenPosition({
            viewport: entry.viewport,
            surfaceSize: previous.surfaceSize,
            nodeId: entry.focusId,
            nodeIds,
            previousPositions: previous.positions,
            nextPositions: positions,
          })
        : entry.viewport,
    }));
  return {
    focusId,
    selectedEdgeId:
      previous.selectedEdgeId && structure.edges.some((edge) => edge.id === previous.selectedEdgeId)
        ? previous.selectedEdgeId
        : null,
    depth: focusId === null ? "all" : previous.depth,
    framedRegionIndex,
    positions,
    viewport: layoutBasisChanged
      ? preserveStructureLayoutScreenPosition({
          viewport: previous.viewport,
          surfaceSize: previous.surfaceSize,
          nodeId: focusId,
          nodeIds,
          previousPositions: previous.positions,
          nextPositions: positions,
        })
      : previous.viewport,
    surfaceSize: previous.surfaceSize,
    guideDisclosure,
    navigationHistory,
    layoutBasisKey,
    updatedAt: structure.updatedAt,
  };
}

export function getStructureSession(
  paneId: DocumentPaneId,
  structureId: string,
): StructureSession | undefined {
  return sessions.get(sessionKey(paneId, structureId));
}

export function setStructureSession(
  paneId: DocumentPaneId,
  structureId: string,
  session: StructureSession,
): void {
  sessions.set(sessionKey(paneId, structureId), session);
}

export function transferStructureSession(
  structureId: string,
  sourcePane: DocumentPaneId,
  targetPane: DocumentPaneId,
): void {
  const current = getStructureSession(sourcePane, structureId);
  if (!current) return;
  setStructureSession(targetPane, structureId, current);
  sessions.delete(sessionKey(sourcePane, structureId));
}

export function deleteStructureSessions(structureId: string): void {
  sessions.delete(sessionKey("left", structureId));
  sessions.delete(sessionKey("right", structureId));
}
