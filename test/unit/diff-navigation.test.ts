import { describe, expect, it, vi } from "vitest";
import {
  diffNavigationWindow,
  firstCollapsedDiffNavigationLine,
} from "../../src/web/diff-navigation.js";

describe("diff navigation", () => {
  it("adds nearby context to a code reference range", () => {
    expect(diffNavigationWindow({ line: 20, endLine: 300 })).toEqual({
      startLine: 15,
      endLine: 305,
    });
    expect(diffNavigationWindow({ line: 3, endLine: 1 })).toEqual({
      startLine: 1,
      endLine: 8,
    });
  });

  it("does not turn a single-line jump without a range into a context expansion", () => {
    expect(diffNavigationWindow({ line: 20 })).toBeNull();
    expect(diffNavigationWindow({ line: null })).toBeNull();
  });

  it("finds the first collapsed line across the whole reference window", () => {
    const isLineRenderable = vi.fn((line: number) => line < 121 || line > 174);
    expect(firstCollapsedDiffNavigationLine({ line: 20, endLine: 300 }, isLineRenderable)).toBe(
      121,
    );
    expect(isLineRenderable).toHaveBeenLastCalledWith(121);
  });

  it("finishes only after the range and its context are renderable", () => {
    const isLineRenderable = vi.fn(() => true);
    expect(
      firstCollapsedDiffNavigationLine({ line: 20, endLine: 300 }, isLineRenderable),
    ).toBeNull();
    expect(isLineRenderable).toHaveBeenCalledTimes(291);
    expect(isLineRenderable).toHaveBeenLastCalledWith(305);
  });
});
