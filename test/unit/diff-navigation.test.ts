import { FileDiff, parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";
import { DIFF_NAVIGATION_CONTEXT_LINES } from "../../src/web/diff-navigation.js";

describe("diff navigation", () => {
  it("reveals a 10,000-line range and its exact context with one rerender", () => {
    const lines = Array.from({ length: 10_040 }, (_, index) => `line ${index + 1}`);
    const changedLines = [...lines];
    changedLines[2_499] = "first change";
    changedLines[7_499] = "second change";
    const instance = new FileDiff();
    instance.fileDiff = parseDiffFromFile(
      { name: "fixture.ts", contents: `${lines.join("\n")}\n` },
      { name: "fixture.ts", contents: `${changedLines.join("\n")}\n` },
    );
    const rerender = vi.spyOn(instance, "rerender").mockImplementation(() => undefined);

    expect(instance.revealRange(20, 10_019, DIFF_NAVIGATION_CONTEXT_LINES)).toBe(true);
    expect(rerender).toHaveBeenCalledTimes(1);
    for (let line = 15; line <= 10_024; line += 1) {
      expect(instance.isLineRenderable(line), `line ${line}`).toBe(true);
    }
    expect(instance.isLineRenderable(14)).toBe(false);
    expect(instance.isLineRenderable(10_025)).toBe(false);

    expect(instance.revealRange(20, 10_019, DIFF_NAVIGATION_CONTEXT_LINES)).toBe(false);
    expect(rerender).toHaveBeenCalledTimes(1);
  });
});
