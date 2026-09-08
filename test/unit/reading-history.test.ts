import { describe, expect, it } from "vitest";
import {
  isCurrentStructureReadingSnapshot,
  parseReadingHistoryEntry,
  readingHistoryState,
  sameReadingDocument,
  shouldReplaceStructureReadingEntry,
  type ReadingHistoryEntry,
} from "../../src/web/reading-history.js";

const pullRequestId = "11111111-1111-4111-8111-111111111111";

function entry(overrides: Partial<ReadingHistoryEntry> = {}): ReadingHistoryEntry {
  return {
    version: 1,
    pullRequestId,
    pane: "left",
    document: { kind: "repository-file", path: "src/fixture.ts" },
    locator: { kind: "scroll", top: 120 },
    ...overrides,
  };
}

describe("reading history", () => {
  it("round-trips a namespaced reading entry without removing unrelated history state", () => {
    const value = entry({
      pane: "right",
      locator: { kind: "line", line: 18, endLine: 22 },
    });
    const state = readingHistoryState({ unrelated: true }, value);

    expect(state.unrelated).toBe(true);
    expect(parseReadingHistoryEntry(state, pullRequestId)).toEqual(value);
  });

  it("rejects entries for another Pull Request and malformed locators", () => {
    const state = readingHistoryState(null, entry());
    expect(parseReadingHistoryEntry(state, "22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(
      parseReadingHistoryEntry(
        readingHistoryState(null, entry({ locator: { kind: "line", line: 1 } })),
        pullRequestId,
      ),
    ).not.toBeNull();

    const malformed = structuredClone(state) as Record<string, Record<string, unknown>>;
    malformed.rvwReading!.locator = { kind: "scroll", top: -1 };
    expect(parseReadingHistoryEntry(malformed, pullRequestId)).toBeNull();
  });

  it("round-trips a runtime-validated Structure reading snapshot", () => {
    const value = entry({
      document: {
        kind: "structure",
        id: "structure-1",
        title: "Order flow",
        sourceOid: "a".repeat(40),
      },
      locator: {
        kind: "structure",
        snapshot: {
          artifactUpdatedAt: "2026-09-06T00:00:00.000Z",
          viewMode: "regions",
          focusId: "entry",
          selectedEdgeId: null,
          depth: 2,
          framedRegionId: null,
          cameraFrame: { kind: "nodes", nodeIds: ["entry", "service"] },
          viewport: { x: -20, y: 15, scale: 0.8 },
          surfaceSize: { width: 800, height: 500 },
          regionsViewport: { x: 10, y: 30, scale: 1.2 },
          regionsSurfaceSize: { width: 900, height: 600 },
          regionsCameraMode: "manual",
          layoutBasisKey: "graph-basis",
          positionsKey: "positions",
          regionsLayoutBasisKey: "regions-basis",
        },
      },
    });
    const state = readingHistoryState({ unrelated: true }, value);
    expect(parseReadingHistoryEntry(state, pullRequestId)).toEqual(value);

    const malformed = structuredClone(state) as Record<string, Record<string, unknown>>;
    const locator = malformed.rvwReading!.locator as Record<string, unknown>;
    locator.snapshot = { ...(locator.snapshot as object), depth: 3 };
    expect(parseReadingHistoryEntry(malformed, pullRequestId)).toBeNull();

    const missingArtifactRevision = structuredClone(state) as Record<
      string,
      Record<string, unknown>
    >;
    const missingRevisionLocator = missingArtifactRevision.rvwReading!.locator as Record<
      string,
      unknown
    >;
    const missingRevisionSnapshot = missingRevisionLocator.snapshot as Record<string, unknown>;
    delete missingRevisionSnapshot.artifactUpdatedAt;
    expect(parseReadingHistoryEntry(missingArtifactRevision, pullRequestId)).toBeNull();

    const mismatchedDocument = readingHistoryState(null, {
      ...value,
      document: { kind: "repository-file", path: "src/not-a-structure.ts" },
    });
    expect(parseReadingHistoryEntry(mismatchedDocument, pullRequestId)).toBeNull();

    if (value.locator.kind !== "structure") throw new Error("expected Structure locator");
    const latest = value.locator.snapshot;
    expect(isCurrentStructureReadingSnapshot(latest, structuredClone(latest))).toBe(true);
    expect(
      isCurrentStructureReadingSnapshot(latest, {
        ...latest,
        focusId: "newer-focus",
      }),
    ).toBe(false);
    expect(
      shouldReplaceStructureReadingEntry({
        latest,
        candidate: latest,
        focusedPane: "right",
        activeDocument: value.document,
        pane: "left",
        structureId: "structure-1",
      }),
    ).toBe(false);
    expect(
      shouldReplaceStructureReadingEntry({
        latest,
        candidate: latest,
        focusedPane: "left",
        activeDocument: value.document,
        pane: "left",
        structureId: "structure-1",
      }),
    ).toBe(true);
  });

  it("round-trips separate full and local Structure geometry while rejecting malformed points", () => {
    const value = entry({
      document: {
        kind: "structure",
        id: "structure-2",
        title: "Local exploration",
        sourceOid: "b".repeat(40),
      },
      locator: {
        kind: "structure",
        snapshot: {
          artifactUpdatedAt: "2026-09-06T00:00:00.000Z",
          viewMode: "graph",
          focusId: "selected",
          localCenterId: "center",
          selectedEdgeId: "edge",
          depth: 1,
          framedRegionId: null,
          cameraFrame: { kind: "center-node", nodeId: "center", scale: 1.1 },
          viewport: { x: -220, y: 80, scale: 1.1 },
          surfaceSize: { width: 800, height: 500 },
          allCameraFrame: { kind: "nodes", nodeIds: ["entry", "selected"] },
          allViewport: { x: 35, y: 60, scale: 0.7 },
          allSurfaceSize: { width: 800, height: 500 },
          positions: {
            entry: { x: 60, y: 80 },
            selected: { x: 480, y: 180 },
          },
          localPositions: {
            center: { x: 40, y: 50 },
            selected: { x: 410, y: 90 },
          },
          localLayoutBasisKey: "local-basis",
          regionsViewport: { x: 10, y: 30, scale: 1.2 },
          regionsSurfaceSize: { width: 900, height: 600 },
          regionsCameraMode: "manual",
          layoutBasisKey: "graph-basis",
          positionsKey: "positions",
          regionsLayoutBasisKey: "regions-basis",
        },
      },
    });
    const state = readingHistoryState(null, value);

    expect(parseReadingHistoryEntry(state, pullRequestId)).toEqual(value);

    const malformedPoint = structuredClone(state) as Record<string, Record<string, unknown>>;
    const malformedLocator = malformedPoint.rvwReading!.locator as Record<string, unknown>;
    const malformedSnapshot = malformedLocator.snapshot as Record<string, unknown>;
    malformedSnapshot.localPositions = { center: { x: Number.POSITIVE_INFINITY, y: 50 } };
    expect(parseReadingHistoryEntry(malformedPoint, pullRequestId)).toBeNull();

    const malformedAllCamera = structuredClone(state) as Record<string, Record<string, unknown>>;
    const cameraLocator = malformedAllCamera.rvwReading!.locator as Record<string, unknown>;
    const cameraSnapshot = cameraLocator.snapshot as Record<string, unknown>;
    cameraSnapshot.allCameraFrame = { kind: "center-node", nodeId: "entry", scale: 0 };
    expect(parseReadingHistoryEntry(malformedAllCamera, pullRequestId)).toBeNull();

    if (value.locator.kind !== "structure") throw new Error("expected Structure locator");
    const withoutCachedLocalPositions = structuredClone(value);
    if (withoutCachedLocalPositions.locator.kind !== "structure") {
      throw new Error("expected Structure locator");
    }
    withoutCachedLocalPositions.locator.snapshot.localPositions = null;
    withoutCachedLocalPositions.locator.snapshot.localLayoutBasisKey = null;
    expect(
      parseReadingHistoryEntry(
        readingHistoryState(null, withoutCachedLocalPositions),
        pullRequestId,
      ),
    ).toEqual(withoutCachedLocalPositions);
  });

  it("distinguishes current-range and exact-source readings of the same path", () => {
    const current = { kind: "repository-file" as const, path: "src/fixture.ts" };
    const exact = {
      kind: "repository-file" as const,
      path: "src/fixture.ts",
      sourceOid: "a".repeat(40),
      comparisonPolicy: "exact-source" as const,
    };

    expect(sameReadingDocument(current, { ...current })).toBe(true);
    expect(sameReadingDocument(current, exact)).toBe(false);
  });

  it("round-trips a session-only source reference resolution context", () => {
    const referenceDocument = {
      kind: "repository-file" as const,
      path: "src/reference.ts",
      oldPath: "src/reference.ts",
      newPath: "src/reference.ts",
      sourceOid: "a".repeat(40),
      comparisonPolicy: "reference-target" as const,
      referenceContext: {
        outcome: "source-fallback" as const,
        origin: {
          kind: "walkthrough" as const,
          walkthroughId: "walkthrough",
          referenceId: "reference",
        },
        anchorSourceOid: "a".repeat(40),
        latestHeadOid: "c".repeat(40),
        referenceFingerprint: "fingerprint",
        diffBaseOid: "0".repeat(40),
        hasDiff: true,
        latestFile: {
          sourceOid: "c".repeat(40),
          path: "src/reference.ts",
          diffBaseOid: "b".repeat(40),
          oldPath: "src/reference.ts",
          newPath: "src/reference.ts",
          hasDiff: true,
        },
      },
    };
    const value = entry({ document: referenceDocument, locator: { kind: "line", line: 8 } });

    expect(parseReadingHistoryEntry(readingHistoryState(null, value), pullRequestId)).toEqual(
      value,
    );
    expect(sameReadingDocument(referenceDocument, { ...referenceDocument })).toBe(true);
  });

  it("round-trips a Structure source reference origin", () => {
    const referenceDocument = {
      kind: "repository-file" as const,
      path: "src/structure.ts",
      sourceOid: "c".repeat(40),
      comparisonPolicy: "reference-target" as const,
      referenceContext: {
        outcome: "latest" as const,
        origin: {
          kind: "structure" as const,
          structureId: "structure",
          locator: { kind: "node" as const, nodeId: "claim" },
          resolvedAnchor: { path: "src/structure.ts", startLine: 4, endLine: 9 },
        },
        anchorSourceOid: "a".repeat(40),
        latestHeadOid: "c".repeat(40),
        referenceFingerprint: "fingerprint",
        diffBaseOid: null,
        hasDiff: false,
        latestFile: null,
      },
    };
    const value = entry({ document: referenceDocument, locator: { kind: "line", line: 4 } });

    expect(parseReadingHistoryEntry(readingHistoryState(null, value), pullRequestId)).toEqual(
      value,
    );
  });
});
