import type { Structure } from "../domain/models.js";
import type { DocumentPaneId } from "./document-workspace.js";
import {
  initialStructureLayout,
  reconcileStructureLayout,
  STRUCTURE_NODE_HEIGHT,
  STRUCTURE_NODE_WIDTH,
  structureLayoutBounds,
  type StructureNeighborhoodDepth,
  type StructurePoint,
} from "./structure-graph.js";

export interface StructureViewport {
  x: number;
  y: number;
  scale: number;
}

const MIN_VISIBLE_NEAREST_LEFT_NODE_WIDTH = 64;

export function initialStructureViewport(input: {
  structure: Pick<Structure, "originNodeId" | "nodes"> & Partial<Pick<Structure, "presentation">>;
  positions: Readonly<Record<string, StructurePoint>>;
  surfaceSize: { width: number; height: number };
}): StructureViewport {
  const { structure, positions, surfaceSize } = input;
  const bounds = structureLayoutBounds(
    structure.nodes.map((node) => node.id),
    positions,
  );
  const initialFocusId = structure.presentation?.startNodeId;
  const point = positions[initialFocusId ?? structure.originNodeId];
  const centerX = point
    ? point.x + STRUCTURE_NODE_WIDTH / 2
    : bounds
      ? (bounds.minX + bounds.maxX) / 2
      : 0;
  const centerY = point
    ? point.y + STRUCTURE_NODE_HEIGHT / 2
    : bounds
      ? (bounds.minY + bounds.maxY) / 2
      : 0;
  let horizontalFraction = 0.25;
  if (point && bounds && bounds.minX < point.x) {
    const leftSpan = centerX - bounds.minX;
    const rightSpan = bounds.maxX - centerX;
    const naturalFraction = leftSpan / Math.max(leftSpan + rightSpan, 1);
    const nearestLeftNodeRight = Math.max(
      ...structure.nodes.flatMap((node) => {
        const nodePoint = positions[node.id];
        return nodePoint && nodePoint.x < point.x ? [nodePoint.x + STRUCTURE_NODE_WIDTH] : [];
      }),
    );
    const visibilityFraction = Number.isFinite(nearestLeftNodeRight)
      ? (centerX - nearestLeftNodeRight + MIN_VISIBLE_NEAREST_LEFT_NODE_WIDTH) /
        Math.max(surfaceSize.width, 1)
      : 0;
    horizontalFraction = Math.min(0.5, Math.max(0.35, naturalFraction, visibilityFraction));
  }
  return {
    scale: 1,
    x: surfaceSize.width * horizontalFraction - centerX,
    y: surfaceSize.height / 2 - centerY,
  };
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
  positions: Record<string, StructurePoint>;
  viewport: StructureViewport;
  surfaceSize: { width: number; height: number };
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

export function structureLayoutBasisKey(structure: Pick<Structure, "presentation">): string {
  const presentation = structure.presentation;
  if (!presentation || (presentation.primarySpine === null && presentation.regions.length === 0)) {
    return "structure-layout-basis:v1:null";
  }
  return `structure-layout-basis:v1:${JSON.stringify({
    startNodeId: presentation.startNodeId,
    primarySpine: presentation.primarySpine
      ? {
          nodeIds: presentation.primarySpine.nodeIds,
        }
      : null,
    regions: presentation.regions.map((region) => [...region.nodeIds].sort(stableCompare)),
  })}`;
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
    positions: initialStructureLayout(structure),
    viewport: { x: 110, y: 90, scale: 1 },
    surfaceSize: { width: 0, height: 0 },
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
  return {
    focusId,
    selectedEdgeId:
      previous.selectedEdgeId && structure.edges.some((edge) => edge.id === previous.selectedEdgeId)
        ? previous.selectedEdgeId
        : null,
    depth: focusId === null ? "all" : previous.depth,
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
