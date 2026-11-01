import { readFileSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { validateWalkthroughAssets } from "../../src/shared/walkthrough-assets.js";
import { renderWalkthroughHtmlPreview } from "../../src/shared/walkthrough-html.js";
import { importWalkthroughFiles } from "../../src/cli/walkthrough-import.js";

const font = readFileSync("test/fixtures/static-artifact/assets/editorial.woff2").toString(
  "base64",
);
const png = readFileSync("test/fixtures/static-artifact/assets/pixel.png").toString("base64");
describe("static artifact boundary", () => {
  it("preserves standalone selectors, authored typography and resolves only declared asset URLs", () => {
    const source = readFileSync("test/fixtures/static-artifact/editorial.html", "utf8");
    const result = renderWalkthroughHtmlPreview(
      source,
      1,
      new Map([
        ["assets/editorial.woff2", `data:font/woff2;base64,${font}`],
        ["assets/pixel.png", `data:image/png;base64,${png}`],
      ]),
    );
    expect(result.standalone).toBe(true);
    expect(result.html).toContain('<html lang="en"');
    expect(result.html).toContain("body{margin:0;font-family:Editorial,serif");
    expect(result.html).toContain("data:font/woff2;base64,");
    expect(result.html).toContain("data:image/png;base64,");
    expect(result.assetReferences).toEqual([
      { path: "assets/editorial.woff2", kind: "font" },
      { path: "assets/pixel.png", kind: "image" },
    ]);
    expect(result.referenceIds).toEqual(["handler"]);
  });
  it("preserves benign custom properties, data labels and textual URLs", () => {
    const result = renderWalkthroughHtmlPreview(
      '<style>p::after {content:attr(data-label) " https://example.com";} :root {--spacing:clamp(1rem, 2vw, 3rem);} p {padding:var(--spacing)}</style><p data-label="Caption">Text</p>',
      0,
    );
    expect(result.html).toContain('data-label="Caption"');
    expect(result.html).toContain("attr(data-label)");
    expect(result.html).toContain("https://example.com");
  });
  it.each([
    "<script>alert(1)</script>",
    '<img src="pixel.png" onerror="alert(1)">',
    '<iframe src="about:blank"></iframe>',
    '<form action="https://evil.test"></form>',
    '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.test"></head><body>x</body></html>',
    '<style>@import "x.css";</style>',
    "<style>@namespace url(https://evil.test);</style>",
    "<style>p{background:url(https://evil.test/a)}</style>",
    "<style>p{background:u\\72l(https://evil.test/a)}</style>",
    '<style>p{background:image-set("https://evil.test/a" 1x)}</style>',
    "<style>p{background:url(../escape.png)}</style>",
    "<style>p{background:url(data:image/png;base64,AAAA)}</style>",
    '<style>@font-face{font-family:X;src:local("Arial")}</style>',
    "<style>@font-face{font-family:X;src:var(--font)}</style>",
    "<style>p{behavior:url(x.htc)}</style>",
    "<style>p{width:expression(alert(1))}</style>",
  ])("rejects active or non-reproducible resource: %s", (source) => {
    expect(() => renderWalkthroughHtmlPreview(source, 0)).toThrow();
  });
  it("enforces bytes, MIME, names, counts and limits", () => {
    expect(
      validateWalkthroughAssets([{ path: "font.woff2", mediaType: "font/woff2", base64: font }])[0]
        ?.byteLength,
    ).toBeGreaterThan(1000);
    expect(() =>
      validateWalkthroughAssets([{ path: "x.png", mediaType: "image/png", base64: font }]),
    ).toThrow(/MIME/);
    for (const name of [
      "../x.png",
      "/x.png",
      "a/../../x.png",
      "https://a/x.png",
      "a%2fx.png",
      "a\\x.png",
    ])
      expect(() =>
        validateWalkthroughAssets([{ path: name, mediaType: "image/png", base64: png }]),
      ).toThrow();
    const input = { path: "x.png", mediaType: "image/png" as const, base64: png };
    expect(() => validateWalkthroughAssets([input, input])).toThrow(/duplicate/);
    expect(() => validateWalkthroughAssets(Array.from({ length: 33 }, () => input))).toThrow(
      /maximum/,
    );
    expect(() =>
      validateWalkthroughAssets([{ ...input, base64: "a".repeat(8 * 1024 * 1024) }]),
    ).toThrow();
  });
  it("imports document + directory without changing source and refuses symlinks", async () => {
    const imported = (await importWalkthroughFiles(
      { title: "Report" },
      {
        html: "test/fixtures/static-artifact/editorial.html",
        assetsDir: "test/fixtures/static-artifact/assets",
      },
    )) as { body: string; assets: unknown[] };
    expect(imported.body).toContain(
      readFileSync("test/fixtures/static-artifact/editorial.html", "utf8"),
    );
    expect(imported.assets).toHaveLength(2);
    const dir = mkdtempSync(path.join(tmpdir(), "rvw-import-"));
    writeFileSync(path.join(dir, "source"), "secret");
    symlinkSync(path.join(dir, "source"), path.join(dir, "linked"));
    await expect(importWalkthroughFiles({}, { assetsDir: dir })).rejects.toThrow();
    await expect(
      importWalkthroughFiles(
        { body: "existing" },
        { html: "test/fixtures/static-artifact/editorial.html" },
      ),
    ).rejects.toThrow(/either body/);
  });
});
