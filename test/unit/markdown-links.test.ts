import { describe, expect, it } from "vitest";
import {
  isExternalMarkdownHref,
  markdownLinkWasDragged,
  resolveRepositoryMarkdownPath,
} from "../../src/web/markdown-links.js";

describe("Markdown repository links", () => {
  it("resolves paths relative to the current repository document", () => {
    expect(
      resolveRepositoryMarkdownPath("../runbooks/outbox.md#recovery", "docs/design/a.md"),
    ).toBe("docs/runbooks/outbox.md");
    expect(resolveRepositoryMarkdownPath("/README.md", "docs/design/a.md")).toBe("README.md");
    expect(resolveRepositoryMarkdownPath("order%20flow.md", "docs/index.md")).toBe(
      "docs/order flow.md",
    );
  });

  it("does not turn external, fragment-only, or escaping links into repository paths", () => {
    expect(resolveRepositoryMarkdownPath("https://example.com/docs", "docs/index.md")).toBeNull();
    expect(resolveRepositoryMarkdownPath("//example.com/image.png", "docs/index.md")).toBeNull();
    expect(resolveRepositoryMarkdownPath("data:image/png;base64,AAAA", "docs/index.md")).toBeNull();
    expect(resolveRepositoryMarkdownPath("#failure-model", "docs/index.md")).toBeNull();
    expect(resolveRepositoryMarkdownPath("../../outside.md", "docs/index.md")).toBeNull();
  });

  it("recognizes browser-owned links", () => {
    expect(isExternalMarkdownHref("https://example.com")).toBe(true);
    expect(isExternalMarkdownHref("mailto:reviewer@example.com")).toBe(true);
    expect(isExternalMarkdownHref("//example.com/docs")).toBe(true);
    expect(isExternalMarkdownHref("./architecture.md")).toBe(false);
  });

  it("distinguishes a pointer drag from normal link activation", () => {
    expect(markdownLinkWasDragged({ x: 10, y: 10 }, { x: 12, y: 13 })).toBe(false);
    expect(markdownLinkWasDragged({ x: 10, y: 10 }, { x: 15, y: 10 })).toBe(true);
    expect(markdownLinkWasDragged(null, { x: 15, y: 10 })).toBe(false);
  });
});
