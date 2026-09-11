import type {
  SourceAnchor,
  SourceReferenceFileTarget,
  StructureSourceLocator,
} from "../domain/models.js";
import {
  currentCommitDocument,
  type ActiveDocument,
  type DocumentPaneId,
  type ReferenceDocumentContext,
  type SourceReferenceOrigin,
} from "./document-workspace.js";
import type {
  StructureCameraFrame,
  StructureRegionsViewState,
  StructureViewMode,
  StructureViewport,
} from "./structure-session.js";
import type { StructureNeighborhoodDepth, StructurePoint } from "./structure-graph.js";

export const READING_HISTORY_STATE_KEY = "rvwReading";

export interface StructureReadingSnapshot {
  /** Artifact revision whose derived geometry the snapshot was captured against. */
  artifactUpdatedAt: string;
  viewMode: StructureViewMode;
  focusId: string | null;
  /** Optional for compatibility with history entries captured before local centers were separate. */
  localCenterId?: string | null;
  selectedEdgeId: string | null;
  depth: StructureNeighborhoodDepth;
  framedRegionId: string | null;
  cameraFrame: StructureCameraFrame | null;
  viewport: StructureViewport;
  surfaceSize: { width: number; height: number };
  /** Complete-map state. Optional fields preserve old browser-history entries. */
  allCameraFrame?: StructureCameraFrame | null;
  allViewport?: StructureViewport;
  allSurfaceSize?: { width: number; height: number };
  positions?: Record<string, StructurePoint>;
  localPositions?: Record<string, StructurePoint> | null;
  localLayoutBasisKey?: string | null;
  regionsViewport: StructureViewport;
  regionsSurfaceSize: { width: number; height: number };
  regionsCameraMode: StructureRegionsViewState["cameraMode"];
  layoutBasisKey: string;
  positionsKey: string;
  regionsLayoutBasisKey: string;
}

export type ReadingLocator =
  | { kind: "line"; line: number | null; endLine?: number }
  | { kind: "scroll"; top: number }
  | { kind: "structure"; snapshot: StructureReadingSnapshot };

export interface ReadingHistoryEntry {
  version: 1;
  pullRequestId: string;
  pane: DocumentPaneId;
  document: ActiveDocument;
  locator: ReadingLocator;
}

export function sameReadingDocument(left: ActiveDocument, right: ActiveDocument): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "pull-request-markdown" || right.kind === "pull-request-markdown") {
    return left.kind === right.kind;
  }
  if (left.kind === "walkthrough" || right.kind === "walkthrough") {
    return left.kind === "walkthrough" && right.kind === "walkthrough" && left.id === right.id;
  }
  if (left.kind === "structure" || right.kind === "structure") {
    return left.kind === "structure" && right.kind === "structure" && left.id === right.id;
  }
  return (
    left.path === right.path &&
    left.oldPath === right.oldPath &&
    left.newPath === right.newPath &&
    left.sourceOid === right.sourceOid &&
    left.comparisonPolicy === right.comparisonPolicy &&
    JSON.stringify(left.referenceContext ?? null) === JSON.stringify(right.referenceContext ?? null)
  );
}

function preservesReferenceContextInHistory(document: ActiveDocument): boolean {
  return (
    document.kind === "repository-file" &&
    (document.comparisonPolicy === "exact-source" ||
      document.comparisonPolicy === "reference-target")
  );
}

export function documentForReadingHistoryRestore(
  historyDocument: ActiveDocument,
  openDocument: ActiveDocument | undefined,
): ActiveDocument {
  // selected-range source OIDs describe the selection at capture time, not a durable reference pin.
  const targetDocument = preservesReferenceContextInHistory(historyDocument)
    ? historyDocument
    : currentCommitDocument(historyDocument);
  return openDocument && sameReadingDocument(openDocument, targetDocument)
    ? openDocument
    : targetDocument;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function parseReferenceFileTarget(value: unknown): SourceReferenceFileTarget | null {
  if (
    !isRecord(value) ||
    typeof value.sourceOid !== "string" ||
    typeof value.path !== "string" ||
    !optionalNullableString(value.diffBaseOid) ||
    !optionalNullableString(value.oldPath) ||
    !optionalNullableString(value.newPath) ||
    typeof value.hasDiff !== "boolean"
  ) {
    return null;
  }
  return {
    sourceOid: value.sourceOid,
    path: value.path,
    diffBaseOid: value.diffBaseOid ?? null,
    oldPath: value.oldPath ?? null,
    newPath: value.newPath ?? null,
    hasDiff: value.hasDiff,
  };
}

function parseSourceAnchor(value: unknown): SourceAnchor | null {
  if (!isRecord(value) || typeof value.path !== "string") return null;
  const startLine = value.startLine;
  const endLine = value.endLine;
  const fileLevel = startLine === null && endLine === null;
  const lineRange =
    Number.isInteger(startLine) &&
    Number(startLine) > 0 &&
    Number.isInteger(endLine) &&
    Number(endLine) >= Number(startLine);
  if (!fileLevel && !lineRange) return null;
  return {
    path: value.path,
    startLine: startLine as number | null,
    endLine: endLine as number | null,
  };
}

function parseStructureSourceLocator(value: unknown): StructureSourceLocator | null {
  if (!isRecord(value)) return null;
  if (value.kind === "node") {
    return typeof value.nodeId === "string" ? { kind: "node", nodeId: value.nodeId } : null;
  }
  if (value.kind === "edge") {
    return typeof value.edgeId === "string" &&
      Number.isInteger(value.anchorIndex) &&
      Number(value.anchorIndex) >= 0
      ? { kind: "edge", edgeId: value.edgeId, anchorIndex: Number(value.anchorIndex) }
      : null;
  }
  return null;
}

function parseReferenceOrigin(value: unknown): SourceReferenceOrigin | null {
  if (!isRecord(value)) return null;
  if (value.kind === "walkthrough") {
    return typeof value.walkthroughId === "string" && typeof value.referenceId === "string"
      ? {
          kind: "walkthrough",
          walkthroughId: value.walkthroughId,
          referenceId: value.referenceId,
        }
      : null;
  }
  if (value.kind === "structure") {
    const locator = parseStructureSourceLocator(value.locator);
    const resolvedAnchor = parseSourceAnchor(value.resolvedAnchor);
    return typeof value.structureId === "string" && locator && resolvedAnchor
      ? { kind: "structure", structureId: value.structureId, locator, resolvedAnchor }
      : null;
  }
  return null;
}

function parseReferenceContext(value: unknown): ReferenceDocumentContext | null | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    (value.outcome !== "latest" && value.outcome !== "source-fallback") ||
    typeof value.anchorSourceOid !== "string" ||
    typeof value.latestHeadOid !== "string" ||
    typeof value.referenceFingerprint !== "string" ||
    !optionalNullableString(value.diffBaseOid) ||
    typeof value.hasDiff !== "boolean"
  ) {
    return null;
  }
  const origin =
    parseReferenceOrigin(value.origin) ??
    (typeof value.walkthroughId === "string" && typeof value.referenceId === "string"
      ? {
          kind: "walkthrough" as const,
          walkthroughId: value.walkthroughId,
          referenceId: value.referenceId,
        }
      : null);
  if (!origin) return null;
  const latestFile = value.latestFile === null ? null : parseReferenceFileTarget(value.latestFile);
  if (value.latestFile !== null && latestFile === null) return null;
  return {
    outcome: value.outcome,
    origin,
    anchorSourceOid: value.anchorSourceOid,
    latestHeadOid: value.latestHeadOid,
    referenceFingerprint: value.referenceFingerprint,
    diffBaseOid: value.diffBaseOid ?? null,
    hasDiff: value.hasDiff,
    latestFile,
  };
}

function parseDocument(value: unknown): ActiveDocument | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "pull-request-markdown") return { kind: "pull-request-markdown" };
  if (value.kind === "walkthrough") {
    return typeof value.id === "string" &&
      typeof value.title === "string" &&
      typeof value.sourceOid === "string"
      ? {
          kind: "walkthrough",
          id: value.id,
          title: value.title,
          sourceOid: value.sourceOid,
        }
      : null;
  }
  if (value.kind === "structure") {
    return typeof value.id === "string" &&
      typeof value.title === "string" &&
      typeof value.sourceOid === "string"
      ? { kind: "structure", id: value.id, title: value.title, sourceOid: value.sourceOid }
      : null;
  }
  if (
    value.kind !== "repository-file" ||
    typeof value.path !== "string" ||
    !optionalNullableString(value.oldPath) ||
    !optionalNullableString(value.newPath) ||
    (value.sourceOid !== undefined && typeof value.sourceOid !== "string") ||
    (value.comparisonPolicy !== undefined &&
      value.comparisonPolicy !== "selected-range" &&
      value.comparisonPolicy !== "exact-source" &&
      value.comparisonPolicy !== "reference-target")
  ) {
    return null;
  }
  const referenceContext = parseReferenceContext(value.referenceContext);
  if (referenceContext === null) return null;
  return {
    kind: "repository-file",
    path: value.path,
    ...(value.oldPath === undefined ? {} : { oldPath: value.oldPath }),
    ...(value.newPath === undefined ? {} : { newPath: value.newPath }),
    ...(value.sourceOid === undefined ? {} : { sourceOid: value.sourceOid }),
    ...(value.comparisonPolicy === undefined ? {} : { comparisonPolicy: value.comparisonPolicy }),
    ...(referenceContext === undefined ? {} : { referenceContext }),
  };
}

function parseLocator(value: unknown): ReadingLocator | null {
  if (!isRecord(value)) return null;
  if (value.kind === "scroll") {
    return typeof value.top === "number" && Number.isFinite(value.top) && value.top >= 0
      ? { kind: "scroll", top: value.top }
      : null;
  }
  if (value.kind === "structure") {
    const snapshot = parseStructureReadingSnapshot(value.snapshot);
    return snapshot ? { kind: "structure", snapshot } : null;
  }
  if (value.kind !== "line") return null;
  const lineValid = value.line === null || (Number.isInteger(value.line) && Number(value.line) > 0);
  const endLineValid =
    value.endLine === undefined ||
    (Number.isInteger(value.endLine) &&
      Number(value.endLine) > 0 &&
      value.line !== null &&
      Number(value.endLine) >= Number(value.line));
  if (!lineValid || !endLineValid) return null;
  return {
    kind: "line",
    line: value.line as number | null,
    ...(value.endLine === undefined ? {} : { endLine: Number(value.endLine) }),
  };
}

function parseViewport(value: unknown): StructureViewport | null {
  if (
    !isRecord(value) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    typeof value.scale !== "number" ||
    !Number.isFinite(value.scale) ||
    value.scale <= 0
  ) {
    return null;
  }
  return { x: value.x, y: value.y, scale: value.scale };
}

function parseSurfaceSize(value: unknown): { width: number; height: number } | null {
  if (
    !isRecord(value) ||
    typeof value.width !== "number" ||
    !Number.isFinite(value.width) ||
    value.width < 0 ||
    typeof value.height !== "number" ||
    !Number.isFinite(value.height) ||
    value.height < 0
  ) {
    return null;
  }
  return { width: value.width, height: value.height };
}

function parseStructurePositions(
  value: unknown,
): Record<string, StructurePoint> | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 10_000) return undefined;
  const positions: Array<[string, StructurePoint]> = [];
  for (const [nodeId, point] of entries) {
    if (
      !isRecord(point) ||
      typeof point.x !== "number" ||
      !Number.isFinite(point.x) ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.y)
    ) {
      return undefined;
    }
    positions.push([nodeId, { x: point.x, y: point.y }]);
  }
  return Object.fromEntries(positions);
}

function parseCameraFrame(value: unknown): StructureCameraFrame | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (value.kind === "nodes") {
    if (!Array.isArray(value.nodeIds) || !value.nodeIds.every((id) => typeof id === "string")) {
      return undefined;
    }
    if (
      value.maxScale !== undefined &&
      (typeof value.maxScale !== "number" ||
        !Number.isFinite(value.maxScale) ||
        value.maxScale <= 0)
    ) {
      return undefined;
    }
    return {
      kind: "nodes",
      nodeIds: [...value.nodeIds],
      ...(typeof value.maxScale === "number" &&
      Number.isFinite(value.maxScale) &&
      value.maxScale > 0
        ? { maxScale: value.maxScale }
        : {}),
    };
  }
  if (value.kind === "region" && typeof value.regionId === "string") {
    return { kind: "region", regionId: value.regionId };
  }
  if (
    value.kind === "center-node" &&
    typeof value.nodeId === "string" &&
    typeof value.scale === "number" &&
    Number.isFinite(value.scale) &&
    value.scale > 0
  ) {
    return { kind: "center-node", nodeId: value.nodeId, scale: value.scale };
  }
  if (value.kind === "bounds" && isRecord(value.bounds)) {
    const { left, top, right, bottom } = value.bounds;
    if (
      [left, top, right, bottom].every(
        (part) => typeof part === "number" && Number.isFinite(part),
      ) &&
      (right as number) >= (left as number) &&
      (bottom as number) >= (top as number)
    ) {
      return {
        kind: "bounds",
        bounds: {
          left: left as number,
          top: top as number,
          right: right as number,
          bottom: bottom as number,
        },
      };
    }
  }
  return undefined;
}

function parseStructureReadingSnapshot(value: unknown): StructureReadingSnapshot | null {
  if (!isRecord(value)) return null;
  const viewport = parseViewport(value.viewport);
  const surfaceSize = parseSurfaceSize(value.surfaceSize);
  const regionsViewport = parseViewport(value.regionsViewport);
  const regionsSurfaceSize = parseSurfaceSize(value.regionsSurfaceSize);
  const cameraFrame = parseCameraFrame(value.cameraFrame);
  const allCameraFrame =
    value.allCameraFrame === undefined ? undefined : parseCameraFrame(value.allCameraFrame);
  const allViewport =
    value.allViewport === undefined ? undefined : parseViewport(value.allViewport);
  const allSurfaceSize =
    value.allSurfaceSize === undefined ? undefined : parseSurfaceSize(value.allSurfaceSize);
  const positions =
    value.positions === undefined ? undefined : parseStructurePositions(value.positions);
  const localPositions =
    value.localPositions === undefined ? undefined : parseStructurePositions(value.localPositions);
  if (
    typeof value.artifactUpdatedAt !== "string" ||
    (value.viewMode !== "graph" && value.viewMode !== "regions") ||
    (value.focusId !== null && typeof value.focusId !== "string") ||
    !optionalNullableString(value.localCenterId) ||
    (value.selectedEdgeId !== null && typeof value.selectedEdgeId !== "string") ||
    (value.depth !== 1 && value.depth !== 2 && value.depth !== "all") ||
    (value.framedRegionId !== null && typeof value.framedRegionId !== "string") ||
    cameraFrame === undefined ||
    (value.allCameraFrame !== undefined && allCameraFrame === undefined) ||
    !viewport ||
    (value.allViewport !== undefined && !allViewport) ||
    !surfaceSize ||
    (value.allSurfaceSize !== undefined && !allSurfaceSize) ||
    (value.positions !== undefined && (positions === undefined || positions === null)) ||
    (value.localPositions !== undefined && localPositions === undefined) ||
    !optionalNullableString(value.localLayoutBasisKey) ||
    !regionsViewport ||
    !regionsSurfaceSize ||
    (value.regionsCameraMode !== "home" &&
      value.regionsCameraMode !== "fit" &&
      value.regionsCameraMode !== "manual") ||
    typeof value.layoutBasisKey !== "string" ||
    typeof value.positionsKey !== "string" ||
    typeof value.regionsLayoutBasisKey !== "string"
  ) {
    return null;
  }
  return {
    artifactUpdatedAt: value.artifactUpdatedAt,
    viewMode: value.viewMode,
    focusId: value.focusId,
    ...(value.localCenterId === undefined ? {} : { localCenterId: value.localCenterId }),
    selectedEdgeId: value.selectedEdgeId,
    depth: value.depth,
    framedRegionId: value.framedRegionId,
    cameraFrame,
    viewport,
    surfaceSize,
    ...(allCameraFrame === undefined ? {} : { allCameraFrame }),
    ...(allViewport === undefined || allViewport === null ? {} : { allViewport }),
    ...(allSurfaceSize === undefined || allSurfaceSize === null ? {} : { allSurfaceSize }),
    ...(positions === undefined || positions === null ? {} : { positions }),
    ...(localPositions === undefined ? {} : { localPositions }),
    ...(value.localLayoutBasisKey === undefined
      ? {}
      : { localLayoutBasisKey: value.localLayoutBasisKey }),
    regionsViewport,
    regionsSurfaceSize,
    regionsCameraMode: value.regionsCameraMode,
    layoutBasisKey: value.layoutBasisKey,
    positionsKey: value.positionsKey,
    regionsLayoutBasisKey: value.regionsLayoutBasisKey,
  };
}

export function readingHistoryState(
  currentState: unknown,
  entry: ReadingHistoryEntry,
): UnknownRecord {
  return {
    ...(isRecord(currentState) ? currentState : {}),
    [READING_HISTORY_STATE_KEY]: entry,
  };
}

export function isCurrentStructureReadingSnapshot(
  latest: StructureReadingSnapshot | undefined,
  candidate: StructureReadingSnapshot,
): boolean {
  return (
    latest === undefined ||
    latest === candidate ||
    JSON.stringify(latest) === JSON.stringify(candidate)
  );
}

export function shouldReplaceStructureReadingEntry(input: {
  latest: StructureReadingSnapshot | undefined;
  candidate: StructureReadingSnapshot;
  focusedPane: DocumentPaneId;
  activeDocument: ActiveDocument | null;
  pane: DocumentPaneId;
  structureId: string;
}): boolean {
  return (
    isCurrentStructureReadingSnapshot(input.latest, input.candidate) &&
    input.focusedPane === input.pane &&
    input.activeDocument?.kind === "structure" &&
    input.activeDocument.id === input.structureId
  );
}

export function parseReadingHistoryEntry(
  state: unknown,
  pullRequestId: string,
): ReadingHistoryEntry | null {
  if (!isRecord(state)) return null;
  const value = state[READING_HISTORY_STATE_KEY];
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.pullRequestId !== pullRequestId ||
    (value.pane !== "left" && value.pane !== "right")
  ) {
    return null;
  }
  const document = parseDocument(value.document);
  const locator = parseLocator(value.locator);
  if (!document || !locator || (locator.kind === "structure" && document.kind !== "structure")) {
    return null;
  }
  return {
    version: 1,
    pullRequestId,
    pane: value.pane,
    document,
    locator,
  };
}
