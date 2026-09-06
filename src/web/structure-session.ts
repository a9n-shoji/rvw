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

export interface StructureRegionsViewState {
  /** Regions owns a derived overview camera; it never reuses the Graph viewport. */
  viewport: StructureViewport;
  surfaceSize: { width: number; height: number };
  cameraMode: "home" | "fit" | "manual";
  layoutBasisKey: string;
}

export interface StructureCameraBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type StructureCameraFrame =
  | { kind: "bounds"; bounds: StructureCameraBounds }
  | { kind: "nodes"; nodeIds: string[]; maxScale?: number }
  | { kind: "region"; regionId: string }
  | { kind: "center-node"; nodeId: string; scale: number };

export interface StructureGuideDisclosure {
  thesis: boolean;
}

export type StructureViewMode = "graph" | "regions";

export interface StructureRegionsHistoryCamera {
  regionsViewport: StructureViewport;
  regionsSurfaceSize: { width: number; height: number };
  regionsCameraMode: StructureRegionsViewState["cameraMode"];
}

const STRUCTURE_CAMERA_PADDING = 36;
const STRUCTURE_CAMERA_TOP_INSET = 52;
const STRUCTURE_REGIONS_CAMERA_PADDING = 28;
const STRUCTURE_REGIONS_HOME_SCALE_FLOOR = 0.72;
const MAX_STRUCTURE_CAMERA_SCALE = 1.25;

export function initialStructureGuideDisclosure(): StructureGuideDisclosure {
  return {
    thesis: true,
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
  const homeNodeId = structure.presentation?.startNodeId ?? structure.originNodeId;
  // Core membership is stable authorial emphasis, not a camera extent. A large branched backbone
  // must not make Home shrink every card below reading size; Home is the movable reviewer lens.
  return structureOneHopNodeIds(structure, [homeNodeId]);
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

export function structureViewportForCameraFrame(input: {
  frame: StructureCameraFrame;
  positions: Readonly<Record<string, StructurePoint>>;
  regionBounds: ReadonlyMap<string, StructureCameraBounds>;
  surfaceSize: { width: number; height: number };
  renderBoundsForNodeIds?: (nodeIds: readonly string[]) => StructureCameraBounds | null;
}): StructureViewport | null {
  const { frame, positions, regionBounds, surfaceSize, renderBoundsForNodeIds } = input;
  if (frame.kind === "bounds") {
    return structureViewportForBounds({ bounds: frame.bounds, surfaceSize });
  }
  if (frame.kind === "nodes") {
    const renderBounds = renderBoundsForNodeIds?.(frame.nodeIds);
    if (renderBounds) {
      return structureViewportForBounds({
        bounds: renderBounds,
        surfaceSize,
        ...(frame.maxScale === undefined ? {} : { maxScale: frame.maxScale }),
      });
    }
    return structureViewportForNodeIds({
      nodeIds: frame.nodeIds,
      positions,
      surfaceSize,
      ...(frame.maxScale === undefined ? {} : { maxScale: frame.maxScale }),
    });
  }
  if (frame.kind === "region") {
    const bounds = regionBounds.get(frame.regionId);
    return bounds ? structureViewportForBounds({ bounds, surfaceSize }) : null;
  }
  const point = positions[frame.nodeId];
  if (!point || surfaceSize.width <= 0 || surfaceSize.height <= 0) return null;
  return {
    scale: frame.scale,
    x: surfaceSize.width / 2 - (point.x + STRUCTURE_NODE_WIDTH / 2) * frame.scale,
    y: surfaceSize.height / 2 - (point.y + STRUCTURE_NODE_HEIGHT / 2) * frame.scale,
  };
}

/**
 * Bounds are a renderer-derived extent, so they are valid only against the exact artifact and
 * canonical/manual geometry they were captured from. Semantic Node and Region frames remain safe
 * to project against a newer artifact after their identities have been reconciled.
 */
export function structureCameraFrameForHistoryRestore(input: {
  frame: StructureCameraFrame | null;
  snapshotArtifactUpdatedAt: string;
  currentArtifactUpdatedAt: string;
  geometryMatches: boolean;
}): StructureCameraFrame | null {
  if (
    input.frame?.kind === "bounds" &&
    (input.snapshotArtifactUpdatedAt !== input.currentArtifactUpdatedAt || !input.geometryMatches)
  ) {
    return null;
  }
  return input.frame;
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

export function structureRegionsViewportForFit(input: {
  contentSize: { width: number; height: number };
  surfaceSize: { width: number; height: number };
}): StructureViewport | null {
  const { contentSize, surfaceSize } = input;
  if (
    contentSize.width <= 0 ||
    contentSize.height <= 0 ||
    surfaceSize.width <= 0 ||
    surfaceSize.height <= 0
  ) {
    return null;
  }
  const availableWidth = Math.max(1, surfaceSize.width - STRUCTURE_REGIONS_CAMERA_PADDING * 2);
  const availableHeight = Math.max(1, surfaceSize.height - STRUCTURE_REGIONS_CAMERA_PADDING * 2);
  const scale = Math.min(
    1,
    Math.max(
      MIN_STRUCTURE_ZOOM,
      Math.min(availableWidth / contentSize.width, availableHeight / contentSize.height),
    ),
  );
  return {
    scale,
    x: (surfaceSize.width - contentSize.width * scale) / 2,
    y: (surfaceSize.height - contentSize.height * scale) / 2,
  };
}

export function structureRegionsViewportForHome(input: {
  contentSize: { width: number; height: number };
  surfaceSize: { width: number; height: number };
  attentionBounds: StructureCameraBounds | null;
}): StructureViewport | null {
  const fitted = structureRegionsViewportForFit(input);
  if (!fitted) return null;
  const { contentSize, surfaceSize, attentionBounds } = input;
  const scale = Math.min(1, Math.max(STRUCTURE_REGIONS_HOME_SCALE_FLOOR, fitted.scale));
  let x = (surfaceSize.width - contentSize.width * scale) / 2;
  let y = (surfaceSize.height - contentSize.height * scale) / 2;
  if (!attentionBounds) return { x, y, scale };

  const revealAxis = (
    offset: number,
    start: number,
    end: number,
    surfaceLength: number,
  ): number => {
    const padding = Math.min(STRUCTURE_REGIONS_CAMERA_PADDING, surfaceLength / 4);
    const scaledLength = (end - start) * scale;
    if (scaledLength > surfaceLength - padding * 2) {
      return surfaceLength / 2 - ((start + end) / 2) * scale;
    }
    const screenStart = offset + start * scale;
    const screenEnd = offset + end * scale;
    if (screenStart < padding) return offset + padding - screenStart;
    if (screenEnd > surfaceLength - padding) {
      return offset + (surfaceLength - padding - screenEnd);
    }
    return offset;
  };
  x = revealAxis(x, attentionBounds.left, attentionBounds.right, surfaceSize.width);
  y = revealAxis(y, attentionBounds.top, attentionBounds.bottom, surfaceSize.height);
  return { x, y, scale };
}

export interface StructureSession {
  viewMode: StructureViewMode;
  focusId: string | null;
  selectedEdgeId: string | null;
  depth: StructureNeighborhoodDepth;
  framedRegionId: string | null;
  cameraFrame: StructureCameraFrame | null;
  positions: Record<string, StructurePoint>;
  viewport: StructureViewport;
  surfaceSize: { width: number; height: number };
  regionsView: StructureRegionsViewState;
  guideDisclosure: StructureGuideDisclosure;
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
  // v2 makes declared Regions the primary compound placement. Scope the projection revision to
  // Region-bearing presentations so topology/start-only and backbone-only manual layouts survive
  // an implementation change that cannot affect their canonical geometry.
  const projectionVersion = presentation.regions.length > 0 ? "v2" : "v1";
  return `structure-layout-basis:${projectionVersion}:${JSON.stringify({
    startNodeId: presentation.startNodeId,
    primaryBackbone: presentation.primaryBackbone ? backboneAdjacency : null,
    regions: presentation.regions
      .map((region) => ({ id: region.id, nodeIds: [...region.nodeIds].sort(stableCompare) }))
      .sort((left, right) => stableCompare(left.id, right.id)),
  })}`;
}

/**
 * Identity of fields that can change the derived Regions map geometry or route labels.
 * Region summaries and the Structure thesis are deliberately absent: cards have fixed geometry,
 * so prose-only edits must not throw away the reviewer's Regions camera.
 */
export function structureRegionsLayoutBasisKey(
  structure: Pick<Structure, "presentation" | "nodes" | "edges">,
): string {
  const presentation = structure.presentation;
  if (!presentation || presentation.regions.length === 0) {
    return "structure-regions-layout-basis:v1:none";
  }
  return `structure-regions-layout-basis:v1:${JSON.stringify({
    startNodeId: presentation.startNodeId,
    primaryBackboneEdgeIds: presentation.primaryBackbone
      ? [...presentation.primaryBackbone.edgeIds].sort(stableCompare)
      : null,
    regions: presentation.regions
      .map((region) => ({
        id: region.id,
        label: region.label,
        nodeIds: [...region.nodeIds].sort(stableCompare),
      }))
      .sort((left, right) => stableCompare(left.id, right.id)),
    nodeIds: structure.nodes.map((node) => node.id).sort(stableCompare),
    edges: structure.edges
      .map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        directed: edge.directed,
        label: edge.label,
      }))
      .sort((left, right) => stableCompare(left.id, right.id)),
  })}`;
}

export function initialStructureRegionsView(
  structure: Pick<Structure, "presentation" | "nodes" | "edges">,
): StructureRegionsViewState {
  return {
    viewport: { x: 0, y: 0, scale: 1 },
    surfaceSize: { width: 0, height: 0 },
    cameraMode: "home",
    layoutBasisKey: structureRegionsLayoutBasisKey(structure),
  };
}

export function restoreStructureRegionsViewFromHistory(
  current: StructureRegionsViewState,
  entry: StructureRegionsHistoryCamera,
  targetSurfaceSize?: { width: number; height: number },
): StructureRegionsViewState {
  const restoredSurfaceSize = targetSurfaceSize ?? entry.regionsSurfaceSize;
  const restoredViewport =
    entry.regionsCameraMode === "manual"
      ? {
          ...entry.regionsViewport,
          x:
            entry.regionsViewport.x +
            (restoredSurfaceSize.width - entry.regionsSurfaceSize.width) / 2,
          y:
            entry.regionsViewport.y +
            (restoredSurfaceSize.height - entry.regionsSurfaceSize.height) / 2,
        }
      : entry.regionsViewport;
  return {
    ...current,
    viewport: restoredViewport,
    surfaceSize: restoredSurfaceSize,
    cameraMode: entry.regionsCameraMode,
  };
}

function reconcileStructureCameraFrame(
  frame: StructureCameraFrame | null,
  nodeIds: ReadonlySet<string>,
  regionIds: ReadonlySet<string>,
  artifactUpdated: boolean,
): StructureCameraFrame | null {
  // A bounds frame is a renderer-derived snapshot created by Fit. Even when canonical Node
  // positions survive an update, Nodes, Edges, or labels can change its extent. Preserve the
  // current viewport across polling, but do not let a later pane resize reapply stale geometry.
  if (!frame || (artifactUpdated && frame.kind === "bounds")) return null;
  if (frame.kind === "region") return regionIds.has(frame.regionId) ? frame : null;
  if (frame.kind === "center-node") return nodeIds.has(frame.nodeId) ? frame : null;
  if (frame.kind === "bounds") return frame;
  const survivingNodeIds = frame.nodeIds.filter((nodeId) => nodeIds.has(nodeId));
  if (survivingNodeIds.length === 0) return null;
  return {
    kind: "nodes",
    nodeIds: survivingNodeIds,
    ...(frame.maxScale === undefined ? {} : { maxScale: frame.maxScale }),
  };
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
    viewMode: "graph",
    focusId,
    selectedEdgeId: null,
    depth: "all",
    framedRegionId: null,
    cameraFrame: null,
    positions: initialStructureLayout(structure),
    viewport: { x: 110, y: 90, scale: 1 },
    surfaceSize: { width: 0, height: 0 },
    regionsView: initialStructureRegionsView(structure),
    guideDisclosure: initialStructureGuideDisclosure(),
    layoutBasisKey: structureLayoutBasisKey(structure),
    updatedAt: structure.updatedAt,
  };
}

export function reconcileStructureSession(
  structure: Structure,
  previous: StructureSession,
): StructureSession {
  const nodeIds = new Set(structure.nodes.map((node) => node.id));
  const regionIds = new Set(structure.presentation?.regions.map((region) => region.id) ?? []);
  const viewMode: StructureViewMode =
    previous.viewMode === "regions" && regionIds.size > 0 ? "regions" : "graph";
  const focusId = previous.focusId && nodeIds.has(previous.focusId) ? previous.focusId : null;
  const layoutBasisKey = structureLayoutBasisKey(structure);
  const layoutBasisChanged = previous.layoutBasisKey !== layoutBasisKey;
  const artifactUpdated = previous.updatedAt !== structure.updatedAt;
  const regionsLayoutBasisKey = structureRegionsLayoutBasisKey(structure);
  const previousRegionsView = previous.regionsView ?? initialStructureRegionsView(structure);
  const regionsLayoutBasisChanged = previousRegionsView.layoutBasisKey !== regionsLayoutBasisKey;
  const regionsView: StructureRegionsViewState = !regionsLayoutBasisChanged
    ? previousRegionsView
    : {
        ...initialStructureRegionsView(structure),
        surfaceSize: previousRegionsView.surfaceSize,
      };
  const positions = layoutBasisChanged
    ? initialStructureLayout(structure)
    : reconcileStructureLayout(structure, previous.positions);
  const guideDisclosure: StructureGuideDisclosure = {
    thesis: previous.guideDisclosure?.thesis ?? initialStructureGuideDisclosure().thesis,
  };
  const previousFramedRegionId = previous.framedRegionId ?? null;
  const framedRegionId =
    previousFramedRegionId !== null && regionIds.has(previousFramedRegionId)
      ? previousFramedRegionId
      : null;
  return {
    viewMode,
    focusId,
    selectedEdgeId:
      previous.selectedEdgeId && structure.edges.some((edge) => edge.id === previous.selectedEdgeId)
        ? previous.selectedEdgeId
        : null,
    depth: focusId === null ? "all" : previous.depth,
    framedRegionId,
    cameraFrame:
      layoutBasisChanged && framedRegionId !== null
        ? { kind: "region", regionId: framedRegionId }
        : reconcileStructureCameraFrame(
            previous.cameraFrame ?? null,
            nodeIds,
            regionIds,
            artifactUpdated,
          ),
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
    regionsView,
    guideDisclosure,
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
