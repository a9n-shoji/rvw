import { describe, expect, it } from "vitest";
import {
  parseReadingHistoryEntry,
  readingHistoryState,
  sameReadingDocument,
  type ReadingHistoryEntry,
} from "../../src/web/reading-history.js";

const reviewKey = "pull-request:11111111-1111-4111-8111-111111111111";

function entry(overrides: Partial<ReadingHistoryEntry> = {}): ReadingHistoryEntry {
  return {
    version: 1,
    reviewKey,
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
    expect(parseReadingHistoryEntry(state, reviewKey)).toEqual(value);
  });

  it("rejects entries for another Pull Request and malformed locators", () => {
    const state = readingHistoryState(null, entry());
    expect(parseReadingHistoryEntry(state, "22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(
      parseReadingHistoryEntry(
        readingHistoryState(null, entry({ locator: { kind: "line", line: 1 } })),
        reviewKey,
      ),
    ).not.toBeNull();

    const malformed = structuredClone(state) as Record<string, Record<string, unknown>>;
    malformed.rvwReading!.locator = { kind: "scroll", top: -1 };
    expect(parseReadingHistoryEntry(malformed, reviewKey)).toBeNull();
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

  it("round-trips an Issue document with the GitHub URL needed for comments", () => {
    const issueEntry = entry({
      document: {
        kind: "issue",
        id: "70000000-0000-4000-8000-000000000142",
        number: 142,
        title: "Treat Issues as documents",
        url: "https://github.com/acme/review-repo/issues/142",
      },
    });

    expect(parseReadingHistoryEntry(readingHistoryState(null, issueEntry), reviewKey)).toEqual(
      issueEntry,
    );
  });
});
