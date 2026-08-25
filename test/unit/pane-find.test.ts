import { describe, expect, it } from "vitest";
import { findPaneTextMatches } from "../../src/web/pane-find.js";

const defaults = {
  matchCase: false,
  wholeWord: false,
  useRegularExpression: false,
};

describe("pane find", () => {
  it("finds literal text without case sensitivity by default", () => {
    expect(findPaneTextMatches("Fixture fixture fixtureSearch", "fixture", defaults)).toEqual({
      matches: [
        { start: 0, end: 7 },
        { start: 8, end: 15 },
        { start: 16, end: 23 },
      ],
      invalidRegularExpression: false,
    });
  });

  it("supports case-sensitive whole-word matching", () => {
    expect(
      findPaneTextMatches("Fixture fixture fixtureSearch", "fixture", {
        ...defaults,
        matchCase: true,
        wholeWord: true,
      }),
    ).toEqual({
      matches: [{ start: 8, end: 15 }],
      invalidRegularExpression: false,
    });
  });

  it("supports regular expressions and reports invalid patterns", () => {
    expect(
      findPaneTextMatches("item-1 item-22", "item-\\d+", {
        ...defaults,
        useRegularExpression: true,
      }).matches,
    ).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 14 },
    ]);
    expect(
      findPaneTextMatches("anything", "[", {
        ...defaults,
        useRegularExpression: true,
      }),
    ).toEqual({ matches: [], invalidRegularExpression: true });
  });

  it("advances safely for zero-width regular expression matches", () => {
    expect(
      findPaneTextMatches("one\ntwo", "^", {
        ...defaults,
        useRegularExpression: true,
      }).matches,
    ).toEqual([{ start: 0, end: 0 }]);
  });
});
