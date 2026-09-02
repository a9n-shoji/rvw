import type { Structure } from "../domain/models.js";
import type { DocumentPaneId } from "./document-workspace.js";
import {
  initialStructureLayout,
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

export function initialStructureViewport(input: {
  structure: Pick<Structure, "originNodeId" | "nodes">;
  positions: Readonly<Record<string, StructurePoint>>;
  surfaceSize: { width: number; height: number };
}): StructureViewport {
  const { structure, positions, surfaceSize } = input;
  const bounds = structureLayoutBounds(
    structure.nodes.map((node) => node.id),
    positions,
  );
  const point = positions[structure.originNodeId];
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
    horizontalFraction = Math.min(0.5, Math.max(0.35, naturalFraction));
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
  updatedAt: string;
}

const sessions = new Map<string, StructureSession>();

function sessionKey(paneId: DocumentPaneId, structureId: string): string {
  return `${paneId}:${structureId}`;
}

export function createStructureSession(structure: Structure): StructureSession {
  const focusId = structure.nodes.some((node) => node.id === structure.originNodeId)
    ? structure.originNodeId
    : null;
  return {
    focusId,
    selectedEdgeId: null,
    depth: "all",
    positions: initialStructureLayout(structure),
    viewport: { x: 110, y: 90, scale: 1 },
    surfaceSize: { width: 0, height: 0 },
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
