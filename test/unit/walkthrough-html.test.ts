import { describe, expect, it } from "vitest";
import { analyzeReferenceMarkdown } from "../../src/application/rvw-service.js";
import {
  analyzeWalkthroughHtmlPreview,
  renderWalkthroughHtmlPreview,
  resolveWalkthroughRepositoryPath,
  walkthroughHtmlPreviewSourceRanges,
} from "../../src/shared/walkthrough-html.js";

describe("Walkthrough HTML preview", () => {
  it("detects only the exact html-preview fence language", () => {
    const body = [
      "```html",
      "<section>ordinary HTML source</section>",
      "```",
      "",
      "```html-preview-extra",
      "<section>also source</section>",
      "```",
      "",
      "```html-preview",
      '<section><a href="rvw-ref:handler">Preview</a></section>',
      "```",
    ].join("\n");

    const analysis = analyzeReferenceMarkdown(body, { htmlPreviews: true });

    expect(analysis.htmlPreviews).toHaveLength(1);
    expect(analysis.referenceIds).toEqual(["handler"]);
    expect(analysis.htmlPreviews[0]).toMatchObject({ startLine: 10, endLine: 10 });
    expect(walkthroughHtmlPreviewSourceRanges(body)).toEqual([{ startLine: 10, endLine: 10 }]);
  });

  it("finds every HTML preview content range without treating ordinary HTML fences as previews", () => {
    expect(
      walkthroughHtmlPreviewSourceRanges(
        [
          "```html-preview",
          "<section>",
          "  <p>First</p>",
          "</section>",
          "```",
          "```html",
          "<p>Source only</p>",
          "```",
          "```html-preview",
          "<p>Second</p>",
          "```",
        ].join("\n"),
      ),
    ).toEqual([
      { startLine: 2, endLine: 4 },
      { startLine: 10, endLine: 10 },
    ]);
  });

  it("maps HTML node positions to absolute Walkthrough lines after sanitation", () => {
    const rendered = renderWalkthroughHtmlPreview(
      ["<section>", "  <p>Hello</p>", "</section>"].join("\n"),
      20,
    );

    expect(rendered.html).toContain('data-rvw-source-start-line="22"');
    expect(rendered.html).toContain('data-rvw-source-end-line="22"');
    expect(rendered.html).toContain("<!--rvw-source:22:22-->Hello");
  });

  it("extracts HTML references and repository-root image paths", () => {
    expect(
      analyzeWalkthroughHtmlPreview(
        [
          '<a href="rvw-ref:gateway">Gateway</a>',
          '<img src="/docs/images/flow.png" alt="Flow">',
        ].join("\n"),
        7,
      ),
    ).toMatchObject({
      referenceIds: ["gateway"],
      repositoryImages: ["docs/images/flow.png"],
      imageCount: 1,
    });
  });

  it.each([
    ["<script>alert(1)</script>", "<script> は使用できません。"],
    ['<section onclick="alert(1)">x</section>', "onclick attribute は使用できません。"],
    ['<img src="https://example.com/a.png">', "外部画像 https://example.com/a.png"],
    ['<img src="../../secret.png">', "外部画像 ../../secret.png"],
    ['<div data-rvw-source-start-line="1">x</div>', "内部data-rvw-source"],
    ['<style>@import "https://example.com/x.css";</style>', "network resourceを参照するCSS"],
    [
      '<div style="background:url(http://example.com/x.png)">x</div>',
      "network resourceを参照するCSS",
    ],
    ["<svg><foreignObject><p>x</p></foreignObject></svg>", "<foreignObject> は使用できません。"],
    [
      '<svg><rect fill="url(https://example.com/paint.svg#red)"></rect></svg>',
      "network resourceを参照するCSS",
    ],
  ])("rejects unsafe authored HTML: %s", (source, message) => {
    expect(() => analyzeWalkthroughHtmlPreview(source, 37)).toThrowError(
      new RegExp(`html-preview L38:.*${message.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
    );
  });

  it("keeps malformed-but-recoverable HTML renderable", () => {
    const rendered = renderWalkthroughHtmlPreview("<section><p>Hello<p>Again</section>", 4);

    expect(rendered.html).toContain("<section");
    expect(rendered.html).toContain("Hello");
    expect(rendered.html).toContain("Again");
  });

  it("keeps internal SVG fragment resources", () => {
    const rendered = renderWalkthroughHtmlPreview(
      '<svg><defs><linearGradient id="paint"></linearGradient></defs><rect fill="url(#paint)"></rect></svg>',
      4,
    );

    expect(rendered.html).toContain('fill="url(#paint)"');
  });

  it("keeps accessible reusable SVG symbols and arrow markers", () => {
    const rendered = renderWalkthroughHtmlPreview(
      [
        '<svg aria-label="Request flow" viewBox="0 0 160 40">',
        "  <title>Request flow</title>",
        "  <desc>A request moves from the client to the gateway.</desc>",
        "  <defs>",
        '    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">',
        '      <path d="M0,0 L8,4 L0,8 Z"></path>',
        "    </marker>",
        '    <symbol id="client"><circle cx="5" cy="5" r="4"></circle></symbol>',
        "  </defs>",
        '  <use href="#client" x="4" y="15"></use>',
        '  <line x1="14" y1="20" x2="145" y2="20" marker-end="url(#arrow)"></line>',
        "</svg>",
      ].join("\n"),
      4,
    );

    expect(rendered.html).toContain("<title ");
    expect(rendered.html).toContain("<desc ");
    expect(rendered.html).toContain("<marker");
    expect(rendered.html).toContain('markerWidth="8"');
    expect(rendered.html).toContain("<symbol");
    expect(rendered.html).toContain('<use href="#client"');
    expect(rendered.html).toContain('marker-end="url(#arrow)"');
  });

  it("replaces unresolved repository images without leaving a requestable src", () => {
    const rendered = renderWalkthroughHtmlPreview(
      '<img src="docs/flow.png" alt="Flow diagram">',
      1,
    );

    expect(rendered.html).not.toContain("src=");
    expect(rendered.html).toContain("rvw-html-image-placeholder");
    expect(rendered.html).toContain("Flow diagram");
  });

  it("resolves repository paths from the root and rejects root escape", () => {
    expect(resolveWalkthroughRepositoryPath("/docs/images/flow.png")).toBe("docs/images/flow.png");
    expect(resolveWalkthroughRepositoryPath("docs/./images/../flow.png")).toBe("docs/flow.png");
    expect(resolveWalkthroughRepositoryPath("../secret.png")).toBeNull();
    expect(resolveWalkthroughRepositoryPath("https://example.com/a.png")).toBeNull();
  });
});
