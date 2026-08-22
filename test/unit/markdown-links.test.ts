import { describe, expect, it } from "vitest";
import {
  branchGitHubAttachmentAssetUrl,
  githubAttachmentAssetUrl,
  isExternalMarkdownHref,
  markdownAssetUrl,
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

  it("only builds same-origin URLs for validated GitHub user attachments", () => {
    const attachment =
      "https://github.com/user-attachments/assets/37948111-1227-4cdb-a76d-dc8eb469ae5c";
    expect(githubAttachmentAssetUrl("pr-id", attachment)).toBe(
      `/api/pull-requests/pr-id/github-attachment?url=${encodeURIComponent(attachment)}`,
    );
    expect(branchGitHubAttachmentAssetUrl("branch-id", attachment)).toBe(
      `/api/branch-reviews/branch-id/github-attachment?url=${encodeURIComponent(attachment)}`,
    );
    expect(
      githubAttachmentAssetUrl(
        "pr-id",
        "https://github.com.evil.example/user-attachments/assets/37948111-1227-4cdb-a76d-dc8eb469ae5c",
      ),
    ).toBeNull();
    expect(
      branchGitHubAttachmentAssetUrl("branch-id", "https://example.com/diagram.png"),
    ).toBeNull();
  });

  it("encodes asset query values for the same-origin endpoint", () => {
    expect(markdownAssetUrl("pr-id", "a".repeat(40), "docs/order flow.svg")).toBe(
      `/api/pull-requests/pr-id/markdown-asset?sourceOid=${"a".repeat(40)}&path=docs%2Forder+flow.svg`,
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
