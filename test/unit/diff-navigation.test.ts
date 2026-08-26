import { FileDiff, parseDiffFromFile, VirtualizedFileDiff } from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";
import { DIFF_NAVIGATION_CONTEXT_LINES } from "../../src/web/diff-navigation.js";

function createFixtureDiff(lineCount: number, changedLineNumbers: number[]) {
  const lines = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`);
  const changedLines = [...lines];
  for (const lineNumber of changedLineNumbers) {
    changedLines[lineNumber - 1] = `changed line ${lineNumber}`;
  }
  return parseDiffFromFile(
    { name: "fixture.ts", contents: `${lines.join("\n")}\n` },
    { name: "fixture.ts", contents: `${changedLines.join("\n")}\n` },
  );
}

describe("diff navigation", () => {
  it("reveals a 10,000-line range and its exact context with one rerender", () => {
    const instance = new FileDiff();
    instance.fileDiff = createFixtureDiff(10_040, [2_500, 7_500]);
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

  it("batches a range plan through the simple virtualizer layout flow", () => {
    const instanceChanged = vi.fn();
    const virtualizer = {
      type: "simple",
      config: { resizeDebugging: false },
      instanceChanged,
    };
    const instance = new VirtualizedFileDiff(undefined, virtualizer as never);
    instance.fileDiff = createFixtureDiff(340, [170]);
    const rerender = vi.spyOn(instance, "rerender").mockImplementation(() => undefined);

    expect(instance.revealRange(20, 300, DIFF_NAVIGATION_CONTEXT_LINES)).toBe(true);
    expect(instanceChanged).toHaveBeenCalledTimes(1);
    expect(instanceChanged).toHaveBeenCalledWith(instance, true);
    expect(rerender).not.toHaveBeenCalled();
    expect(instance.isLineRenderable(15)).toBe(true);
    expect(instance.isLineRenderable(100)).toBe(true);
    expect(instance.isLineRenderable(250)).toBe(true);
    expect(instance.isLineRenderable(305)).toBe(true);
    expect(instance.isLineRenderable(14)).toBe(false);
    expect(instance.isLineRenderable(306)).toBe(false);
  });

  it("stages one idempotent range plan through the CodeView expansion flow", () => {
    const instanceChanged = vi.fn();
    const codeView = { type: "advanced", instanceChanged };
    const instance = new VirtualizedFileDiff(undefined, codeView as never);
    const fileDiff = createFixtureDiff(340, [170]);
    instance.fileDiff = fileDiff;
    const hunksRenderer = (
      instance as unknown as {
        hunksRenderer: { expandHunk: (...args: unknown[]) => void };
      }
    ).hunksRenderer;
    const expandHunk = vi.spyOn(hunksRenderer, "expandHunk");
    const rerender = vi.spyOn(instance, "rerender").mockImplementation(() => undefined);

    expect(instance.revealRange(20, 300, DIFF_NAVIGATION_CONTEXT_LINES)).toBe(true);
    expect(instanceChanged).toHaveBeenCalledTimes(1);
    expect(instanceChanged).toHaveBeenCalledWith(instance, true);
    expect(expandHunk).not.toHaveBeenCalled();
    expect(rerender).not.toHaveBeenCalled();
    expect(instance.isLineRenderable(15)).toBe(true);
    expect(instance.isLineRenderable(100)).toBe(true);
    expect(instance.isLineRenderable(250)).toBe(true);
    expect(instance.isLineRenderable(305)).toBe(true);
    expect(instance.isLineRenderable(14)).toBe(false);
    expect(instance.isLineRenderable(306)).toBe(false);

    expect(instance.revealRange(20, 300, DIFF_NAVIGATION_CONTEXT_LINES)).toBe(false);
    expect(instanceChanged).toHaveBeenCalledTimes(1);

    expect(instance.consumeCodeViewLayoutChanges(fileDiff)).toBeUndefined();
    expect(expandHunk).toHaveBeenCalledTimes(2);
    expect(rerender).not.toHaveBeenCalled();
    expect(instance.revealRange(20, 300, DIFF_NAVIGATION_CONTEXT_LINES)).toBe(false);
    expect(instanceChanged).toHaveBeenCalledTimes(1);
  });
});
