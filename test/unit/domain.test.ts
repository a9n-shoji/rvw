import { describe, expect, it } from "vitest";
import { formatCommentUri, parseCommentUri } from "../../src/domain/comment-uri.js";
import {
  findUniqueQuotedLineRange,
  mapUnchangedLineRange,
  placeMutableDocumentComment,
} from "../../src/domain/line-mapping.js";
import {
  buildPullRequestMarkdown,
  hashDocument,
  selectedLineText,
} from "../../src/domain/pr-markdown.js";
import { createSourceExcerpt, MAX_SOURCE_EXCERPT_BYTES } from "../../src/domain/source-excerpt.js";

describe("Pull Request Markdown", () => {
  it("normalizes CRLF and preserves the exact v1 shape", () => {
    expect(buildPullRequestMarkdown("Title\r\ncontinued", "Body\r\nline")).toBe(
      "# Title\ncontinued\n\nBody\nline",
    );
  });

  it("hashes the normalized document and extracts quoted lines", () => {
    const markdown = buildPullRequestMarkdown("Title", "first\nsecond");
    expect(hashDocument(markdown)).toMatch(/^[0-9a-f]{64}$/);
    expect(selectedLineText(markdown, 3, 4)).toBe("first\nsecond");
    expect(findUniqueQuotedLineRange("first\nsecond", `prefix\n${markdown}`)).toEqual({
      startLine: 4,
      endLine: 5,
    });
  });
});

describe("conservative line mapping", () => {
  it("tracks unchanged lines after insertions", () => {
    expect(mapUnchangedLineRange("a\nb\nc", "new\na\nb\nc", 2, 3)).toEqual({
      startLine: 3,
      endLine: 4,
    });
  });

  it("marks modified ranges outdated", () => {
    expect(mapUnchangedLineRange("a\nb\nc", "a\nchanged\nc", 2, 2)).toBeNull();
  });

  it("rejects ambiguous repeated destinations", () => {
    expect(mapUnchangedLineRange("top\nvalue", "value\ntop\nvalue", 2, 2)).toBeNull();
  });
});

describe("mutable document comment placement", () => {
  const original = "heading\nselected\nending";
  const anchor = {
    sourceDocumentHash: hashDocument(original),
    quotedText: "selected",
    startLine: 2,
    endLine: 2,
  };

  it("keeps the original range while the document hash matches", () => {
    expect(placeMutableDocumentComment(anchor, original)).toEqual({
      outdated: false,
      range: { startLine: 2, endLine: 2 },
    });
  });

  it("re-anchors one exact quote after the mutable document changes", () => {
    expect(placeMutableDocumentComment(anchor, `new\n${original}`)).toEqual({
      outdated: false,
      range: { startLine: 3, endLine: 3 },
    });
  });

  it("marks an ambiguous quote outdated", () => {
    expect(placeMutableDocumentComment(anchor, "selected\nother\nselected")).toEqual({
      outdated: true,
      range: null,
    });
  });

  it("keeps a whole-document comment attached without a range", () => {
    expect(
      placeMutableDocumentComment(
        { sourceDocumentHash: null, quotedText: null, startLine: null, endLine: null },
        "current body",
      ),
    ).toEqual({ outdated: false, range: null });
  });
});

describe("comment URI", () => {
  it("round trips UUID refs", () => {
    const id = "d1bc05bb-7405-4fc8-a81d-1749ee41a919";
    expect(parseCommentUri(formatCommentUri(id))).toBe(id);
  });

  it("rejects other URI shapes", () => {
    expect(() => parseCommentUri("https://example.com/comment/1")).toThrow(/不正/);
  });
});

describe("source excerpt", () => {
  it("returns bounded context around a selected line range", () => {
    const text = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");

    expect(createSourceExcerpt(text, 30, 32)).toMatchObject({
      startLine: 10,
      endLine: 52,
      truncatedBefore: true,
      truncatedAfter: true,
      truncatedByBytes: false,
    });
  });

  it("caps file-level excerpts at 200 lines", () => {
    const text = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n");
    const excerpt = createSourceExcerpt(text, null, null);

    expect(excerpt.text.split("\n")).toHaveLength(200);
    expect(excerpt).toMatchObject({
      startLine: 1,
      endLine: 200,
      truncatedBefore: false,
      truncatedAfter: true,
      truncatedByBytes: false,
    });
  });

  it("caps file-level excerpts by UTF-8 bytes without splitting a character", () => {
    const longFirstLine = "あ".repeat(MAX_SOURCE_EXCERPT_BYTES);
    const excerpt = createSourceExcerpt(`${longFirstLine}\nsecond`, null, null);

    expect(Buffer.byteLength(excerpt.text, "utf8")).toBeLessThanOrEqual(MAX_SOURCE_EXCERPT_BYTES);
    expect(excerpt).toMatchObject({
      startLine: 1,
      endLine: 1,
      truncatedBefore: false,
      truncatedAfter: true,
      truncatedByBytes: true,
    });
  });
});
