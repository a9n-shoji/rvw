import { describe, expect, it } from "vitest";
import {
  buildFileTree,
  calculateFileTreeRenderWindow,
  decorateAllFilesWithChanges,
  flattenFileTree,
} from "../../src/web/components/FileTree.js";

describe("file tree", () => {
  it("groups paths into sorted directories with files after folders", () => {
    const tree = buildFileTree([
      { path: "README.md", entryKind: "file" },
      { path: "src/index.ts", entryKind: "file", changeKind: "modified" },
      { path: "src/components/App.tsx", entryKind: "file", changeKind: "added" },
      { path: "docs/guide.md", entryKind: "file" },
    ]);

    expect(tree.map((node) => node.name)).toEqual(["docs", "src", "README.md"]);
    const src = tree[1];
    expect(src?.kind).toBe("directory");
    if (src?.kind !== "directory") throw new Error("expected src directory");
    expect(src.children.map((node) => node.name)).toEqual(["components", "index.ts"]);
    expect(src.children[1]).toMatchObject({
      kind: "file",
      path: "src/index.ts",
      changeKind: "modified",
    });
  });

  it("decorates the complete tree and retains deleted files", () => {
    const files = decorateAllFilesWithChanges(
      [
        { path: "src/modified.ts", entryKind: "file" },
        { path: "src/added.ts", entryKind: "file" },
        { path: "src/unchanged.ts", entryKind: "file" },
      ],
      [
        {
          kind: "modified",
          status: "M",
          similarity: null,
          oldPath: "src/modified.ts",
          newPath: "src/modified.ts",
        },
        {
          kind: "added",
          status: "A",
          similarity: null,
          oldPath: null,
          newPath: "src/added.ts",
        },
        {
          kind: "deleted",
          status: "D",
          similarity: null,
          oldPath: "src/deleted.ts",
          newPath: null,
        },
      ],
    );

    expect(files).toEqual([
      { path: "src/modified.ts", entryKind: "file", changeKind: "modified" },
      { path: "src/added.ts", entryKind: "file", changeKind: "added" },
      { path: "src/unchanged.ts", entryKind: "file" },
      { path: "src/deleted.ts", entryKind: "file", changeKind: "deleted" },
    ]);
  });

  it("flattens only expanded branches while filters reveal every match", () => {
    const tree = buildFileTree([
      { path: "README.md", entryKind: "file" },
      { path: "src/index.ts", entryKind: "file" },
      { path: "src/components/App.tsx", entryKind: "file" },
    ]);

    expect(flattenFileTree(tree, new Set(["src"]), false).map(({ node }) => node.path)).toEqual([
      "src",
      "src/components",
      "src/index.ts",
      "README.md",
    ]);
    expect(flattenFileTree(tree, new Set(), true).map(({ node }) => node.path)).toEqual([
      "src",
      "src/components",
      "src/components/App.tsx",
      "src/index.ts",
      "README.md",
    ]);
  });

  it("bounds the rendered rows for a large scrolled tree", () => {
    expect(calculateFileTreeRenderWindow(10_000, 31_000, 620, 31, 10)).toEqual({
      start: 990,
      end: 1_030,
    });
  });
});
