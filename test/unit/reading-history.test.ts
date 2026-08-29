import { describe, expect, it } from "vitest";
import {
  parseReadingHistoryEntry,
  readingHistoryState,
  sameReadingDocument,
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

  it("round-trips the session-only Walkthrough reference resolution context", () => {
    const referenceDocument = {
      kind: "repository-file" as const,
      path: "src/reference.ts",
      oldPath: "src/reference.ts",
      newPath: "src/reference.ts",
      sourceOid: "a".repeat(40),
      comparisonPolicy: "reference-target" as const,
      referenceContext: {
        outcome: "source-fallback" as const,
        anchorSourceOid: "a".repeat(40),
        latestHeadOid: "c".repeat(40),
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
});
