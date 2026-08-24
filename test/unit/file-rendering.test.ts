import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { fileContentsForRenderer } from "../../src/web/file-rendering.js";

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
});
