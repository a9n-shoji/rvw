import { describe, expect, it } from "vitest";
import { resolveFileIcon, resolveFolderIcon } from "../../src/web/file-icons.js";

describe("vscode file icons", () => {
  it.each([
    ["src/App.tsx", "react"],
    ["src/server.ts", "lang-typescript-duo"],
    ["scripts/build.mjs", "lang-javascript-duo"],
    ["README.md", "lang-markdown"],
    ["package.json", "npm"],
    ["Dockerfile", "docker"],
    ["vite.config.ts", "vite"],
    ["assets/logo.svg", "svg-2"],
    ["unknown.data-format", "file-duo"],
  ])("resolves %s to %s", (path, expected) => {
    expect(resolveFileIcon(path).name).toBe(expected);
  });

  it("uses dedicated icons for non-regular entries", () => {
    expect(resolveFileIcon("linked.ts", "symlink").name).toBe("file-symlink-duo");
    expect(resolveFileIcon("vendor/module", "submodule").name).toBe("submodule");
  });

  it("uses matching closed and expanded folder icons", () => {
    expect(resolveFolderIcon(false).name).toBe("folder-duo");
    expect(resolveFolderIcon(true).name).toBe("folder-open-duo");
  });
});
