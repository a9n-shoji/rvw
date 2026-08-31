import type {
  SourceAnchor,
  SourceReferenceFileTarget,
  StructureSourceLocator,
} from "../domain/models.js";
import type {
  ActiveDocument,
  DocumentPaneId,
  ReferenceDocumentContext,
  SourceReferenceOrigin,
} from "./document-workspace.js";

export const READING_HISTORY_STATE_KEY = "rvwReading";

export type ReadingLocator =
  { kind: "line"; line: number | null; endLine?: number } | { kind: "scroll"; top: number };

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

export function readingHistoryState(
  currentState: unknown,
  entry: ReadingHistoryEntry,
): UnknownRecord {
  return {
    ...(isRecord(currentState) ? currentState : {}),
    [READING_HISTORY_STATE_KEY]: entry,
  };
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
  if (!document || !locator) return null;
  return {
    version: 1,
    pullRequestId,
    pane: value.pane,
    document,
    locator,
  };
}
