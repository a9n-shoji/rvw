import { describe, expect, it } from "vitest";
import { findFixedStringMatches } from "../../src/domain/search.js";

describe("fixed-string search matching", () => {
  it("finds every non-overlapping occurrence with case-insensitive matching", () => {
    expect(
      findFixedStringMatches("Fixture fixture fixtures", "fixture", {
        matchCase: false,
        wholeWord: false,
      }),
    ).toEqual([
      { start: 0, end: 7 },
      { start: 8, end: 15 },
      { start: 16, end: 23 },
    ]);
  });

  it("honors case and Unicode-aware whole-word boundaries", () => {
    const text = "Test test testing _test 日本 日本語";
    expect(findFixedStringMatches(text, "Test", { matchCase: true, wholeWord: true })).toEqual([
      { start: 0, end: 4 },
    ]);
    expect(findFixedStringMatches(text, "test", { matchCase: false, wholeWord: true })).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ]);
    expect(findFixedStringMatches(text, "日本", { matchCase: true, wholeWord: true })).toEqual([
      { start: 24, end: 26 },
    ]);
  });

  it("treats regular-expression characters as literals", () => {
    expect(
      findFixedStringMatches("a+b aab a+b", "a+b", { matchCase: true, wholeWord: false }),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });
});
