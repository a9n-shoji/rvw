import type { ActiveDocument, DocumentPaneId } from "./document-workspace.js";

export const READING_HISTORY_STATE_KEY = "rvwReading";

export type ReadingLocator =
  { kind: "line"; line: number | null; endLine?: number } | { kind: "scroll"; top: number };

export interface ReadingHistoryEntry {
  version: 1;
  reviewKey: string;
  pane: DocumentPaneId;
  document: ActiveDocument;
  locator: ReadingLocator;
}

export function sameReadingDocument(left: ActiveDocument, right: ActiveDocument): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "pull-request-markdown" || right.kind === "pull-request-markdown") {
    return left.kind === right.kind;
  }
  if (left.kind === "issue" || right.kind === "issue") {
    return left.kind === "issue" && right.kind === "issue" && left.id === right.id;
  }
  if (left.kind === "walkthrough" || right.kind === "walkthrough") {
    return left.kind === "walkthrough" && right.kind === "walkthrough" && left.id === right.id;
  }
  return (
    left.path === right.path &&
    left.oldPath === right.oldPath &&
    left.newPath === right.newPath &&
    left.sourceOid === right.sourceOid &&
    left.comparisonPolicy === right.comparisonPolicy
  );
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function parseDocument(value: unknown): ActiveDocument | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "pull-request-markdown") return { kind: "pull-request-markdown" };
  if (value.kind === "issue") {
    return typeof value.id === "string" &&
      typeof value.number === "number" &&
      typeof value.title === "string"
      ? { kind: "issue", id: value.id, number: value.number, title: value.title }
      : null;
  }
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
  if (
    value.kind !== "repository-file" ||
    typeof value.path !== "string" ||
    !optionalNullableString(value.oldPath) ||
    !optionalNullableString(value.newPath) ||
    (value.sourceOid !== undefined && typeof value.sourceOid !== "string") ||
    (value.comparisonPolicy !== undefined &&
      value.comparisonPolicy !== "selected-range" &&
      value.comparisonPolicy !== "exact-source")
  ) {
    return null;
  }
  return {
    kind: "repository-file",
    path: value.path,
    ...(value.oldPath === undefined ? {} : { oldPath: value.oldPath }),
    ...(value.newPath === undefined ? {} : { newPath: value.newPath }),
    ...(value.sourceOid === undefined ? {} : { sourceOid: value.sourceOid }),
    ...(value.comparisonPolicy === undefined ? {} : { comparisonPolicy: value.comparisonPolicy }),
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
  reviewKey: string,
): ReadingHistoryEntry | null {
  if (!isRecord(state)) return null;
  const value = state[READING_HISTORY_STATE_KEY];
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.reviewKey !== reviewKey ||
    (value.pane !== "left" && value.pane !== "right")
  ) {
    return null;
  }
  const document = parseDocument(value.document);
  const locator = parseLocator(value.locator);
  if (!document || !locator) return null;
  return {
    version: 1,
    reviewKey,
    pane: value.pane,
    document,
    locator,
  };
}
