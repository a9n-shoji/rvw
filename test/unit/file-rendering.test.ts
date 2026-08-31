import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { diffForRenderer, fileContentsForRenderer } from "../../src/web/file-rendering.js";

describe("file renderer language selection", () => {
  it("pins renamed diff sides to the destination language", () => {
    const oldFile = fileContentsForRenderer("hoge.conf", "server { listen 80; }\n");
    const newFile = fileContentsForRenderer("hoge.conf.template", "server { listen ${PORT}; }\n");

    expect(oldFile.lang).toBe("nginx");
    expect(newFile.lang).toBe("text");
    expect(parseDiffFromFile(oldFile, newFile)).toMatchObject({
      name: "hoge.conf.template",
      prevName: "hoge.conf",
      lang: "text",
    });
  });

  it("hides changes that only alter whitespace", () => {
    const oldFile = fileContentsForRenderer("fixture.ts", "  return   value;\n", "old");
    const newFile = fileContentsForRenderer("fixture.ts", " return value;  \n", "new");

    const visibleWhitespace = diffForRenderer(oldFile, newFile, false);
    const hiddenWhitespace = diffForRenderer(oldFile, newFile, true);

    expect(visibleWhitespace.hunks).toHaveLength(1);
    expect(hiddenWhitespace.hunks).toHaveLength(0);
    expect(hiddenWhitespace.cacheKey).not.toBe(visibleWhitespace.cacheKey);
  });

  it("keeps original source text and line numbers when whitespace is hidden", () => {
    const oldFile = fileContentsForRenderer(
      "fixture.ts",
      "const  stable = 1;\nconst value = 1;\n",
      "old",
    );
    const newFile = fileContentsForRenderer(
      "fixture.ts",
      "const stable = 1;\nconst value = 2;\n",
      "new",
    );

    const diff = diffForRenderer(oldFile, newFile, true);

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ additionLines: 1, deletionLines: 1 });
    expect(diff.deletionLines).toEqual(["const  stable = 1;\n", "const value = 1;\n"]);
    expect(diff.additionLines).toEqual(["const stable = 1;\n", "const value = 2;\n"]);
  });

  it("keeps whitespace content visible in added files", () => {
    const addedFile = fileContentsForRenderer("fixture.ts", "  return value;  \n", "added");

    const diff = diffForRenderer(null, addedFile, true);

    expect(diff.hunks).toHaveLength(1);
    expect(diff.additionLines).toEqual(["  return value;  \n"]);
  });
});
