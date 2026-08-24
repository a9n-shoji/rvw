import { describe, expect, it } from "vitest";
import {
  markdownRangeFromPointerIntent,
  rehypeRvwSourceMap,
} from "../../src/web/markdown-source-map.js";

describe("Markdown preview source mapping", () => {
  it("uses the pointer target instead of a browser range expanded to earlier blocks", () => {
    expect(
      markdownRangeFromPointerIntent(
        { startLine: 31, endLine: 33 },
        { startLine: 33, endLine: 33 },
        { startLine: 33, endLine: 33 },
      ),
    ).toEqual({ startLine: 33, endLine: 33 });
    expect(
      markdownRangeFromPointerIntent(
        { startLine: 15, endLine: 21 },
        { startLine: 21, endLine: 21 },
        { startLine: 21, endLine: 21 },
      ),
    ).toEqual({ startLine: 21, endLine: 21 });
  });

  it("keeps intentional pointer drags across multiple mapped lines", () => {
    expect(
      markdownRangeFromPointerIntent(
        { startLine: 15, endLine: 21 },
        { startLine: 15, endLine: 15 },
        { startLine: 21, endLine: 21 },
      ),
    ).toEqual({ startLine: 15, endLine: 21 });
  });

  it("keeps source lines on rendered text and inserts inline comment anchors", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          position: { start: { line: 3 }, end: { line: 4 } },
          children: [
            {
              type: "text",
              value: "first\nsecond",
              position: { start: { line: 3 }, end: { line: 4 } },
            },
          ],
        },
      ],
    };

    rehypeRvwSourceMap({
      annotations: [{ id: "comment-1", range: { startLine: 4, endLine: 4 } }],
      activeCommentId: "comment-1",
      selectedRange: { startLine: 3, endLine: 3 },
      composerOpen: true,
    })(tree);

    expect(tree.children).toHaveLength(3);
    expect(tree.children[0]).toMatchObject({
      properties: {
        dataRvwSourceStartLine: 3,
        dataRvwSourceEndLine: 4,
      },
      children: [
        {
          tagName: "span",
          properties: {
            dataRvwSourceStartLine: 3,
            dataRvwSourceEndLine: 3,
            className: ["rvw-markdown-selected"],
          },
        },
        { type: "text", value: "\n" },
        {
          tagName: "span",
          properties: {
            dataRvwSourceStartLine: 4,
            dataRvwSourceEndLine: 4,
            className: ["rvw-markdown-commented"],
          },
        },
      ],
    });
    expect(tree.children[1]).toMatchObject({
      tagName: "div",
      properties: { dataRvwComposerAnchor: "true" },
    });
    expect(tree.children[2]).toMatchObject({
      tagName: "div",
      properties: { dataRvwCommentAnchor: "comment-1" },
    });
  });

  it("infers source lines for multiline paragraph text whose position was removed", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          position: { start: { line: 3 }, end: { line: 4 } },
          children: [
            { type: "text", value: "first" },
            { type: "element", tagName: "br", properties: {}, children: [] },
            { type: "text", value: "\nsecond" },
          ],
        },
      ],
    };

    rehypeRvwSourceMap({
      annotations: [{ id: "comment-1", range: { startLine: 3, endLine: 3 } }],
      activeCommentId: "comment-1",
    })(tree);

    expect(tree.children[0]?.children).toMatchObject([
      {
        tagName: "span",
        properties: {
          dataRvwSourceStartLine: 3,
          dataRvwSourceEndLine: 3,
          className: ["rvw-markdown-commented"],
        },
        children: [{ value: "first" }],
      },
      { tagName: "br" },
      { type: "text", value: "\n" },
      {
        tagName: "span",
        properties: {
          dataRvwSourceStartLine: 4,
          dataRvwSourceEndLine: 4,
        },
        children: [{ value: "second" }],
      },
    ]);
  });

  it("only underlines the source range for the active comment", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          position: { start: { line: 2 }, end: { line: 2 } },
          children: [
            {
              type: "text",
              value: "review me",
              position: { start: { line: 2 }, end: { line: 2 } },
            },
          ],
        },
      ],
    };

    rehypeRvwSourceMap({
      annotations: [{ id: "comment-1", range: { startLine: 2, endLine: 2 } }],
    })(tree);

    const mappedText = tree.children[0]?.children?.[0] as { properties?: Record<string, unknown> };
    expect(mappedText.properties).not.toHaveProperty("className");
    expect(tree.children[1]).toMatchObject({
      properties: { dataRvwCommentAnchor: "comment-1" },
    });
  });

  it("uses the comment underline for a navigated Markdown reference range", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          position: { start: { line: 6 }, end: { line: 7 } },
          children: [
            {
              type: "text",
              value: "first\nsecond",
              position: { start: { line: 6 }, end: { line: 7 } },
            },
          ],
        },
      ],
    };

    rehypeRvwSourceMap({ navigationRange: { startLine: 6, endLine: 7 } })(tree);

    expect(tree.children[0]?.children).toMatchObject([
      {
        properties: { className: ["rvw-markdown-commented"] },
        children: [{ value: "first" }],
      },
      { type: "text", value: "\n" },
      {
        properties: { className: ["rvw-markdown-commented"] },
        children: [{ value: "second" }],
      },
    ]);
    expect(tree.children).toHaveLength(1);
  });

  it("maps individual lines inside fenced code without changing its text", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "pre",
          properties: {},
          position: { start: { line: 5 }, end: { line: 8 } },
          children: [
            {
              type: "element",
              tagName: "code",
              properties: {},
              position: { start: { line: 5 }, end: { line: 8 } },
              children: [
                {
                  type: "text",
                  value: "first()\nsecond()",
                },
              ],
            },
          ],
        },
      ],
    };

    rehypeRvwSourceMap()(tree);

    expect(tree.children[0]?.children?.[0]?.children).toMatchObject([
      {
        tagName: "span",
        properties: { dataRvwSourceStartLine: 6, dataRvwSourceEndLine: 6 },
        children: [{ value: "first()" }],
      },
      { type: "text", value: "\n" },
      {
        tagName: "span",
        properties: { dataRvwSourceStartLine: 7, dataRvwSourceEndLine: 7 },
        children: [{ value: "second()" }],
      },
    ]);
  });

  it("maps generated single-line text such as a task-list label to its parent line", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "li",
          properties: { className: ["task-list-item"] },
          position: { start: { line: 36 }, end: { line: 36 } },
          children: [{ type: "text", value: " Unit tests" }],
        },
      ],
    };

    rehypeRvwSourceMap()(tree);

    expect(tree.children[0]?.children).toMatchObject([
      {
        tagName: "span",
        properties: { dataRvwSourceStartLine: 36, dataRvwSourceEndLine: 36 },
        children: [{ value: " Unit tests" }],
      },
    ]);
  });

  it("places a declarative composer slot after a list instead of mutating the list DOM", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "ul",
          properties: {},
          position: { start: { line: 8 }, end: { line: 10 } },
          children: [
            {
              type: "element",
              tagName: "li",
              properties: {},
              position: { start: { line: 9 }, end: { line: 9 } },
              children: [{ type: "text", value: "selected" }],
            },
          ],
        },
      ],
    };

    rehypeRvwSourceMap({
      selectedRange: { startLine: 9, endLine: 9 },
      composerOpen: true,
      annotations: [{ id: "list-comment", range: { startLine: 9, endLine: 9 } }],
    })(tree);

    expect(tree.children).toHaveLength(3);
    expect(tree.children[0]?.tagName).toBe("ul");
    expect(tree.children[0]?.children).toHaveLength(1);
    expect(tree.children[1]).toMatchObject({
      tagName: "div",
      properties: {
        className: ["markdown-selection-composer-slot"],
        dataRvwComposerAnchor: "true",
      },
    });
    expect(tree.children[2]).toMatchObject({
      tagName: "div",
      properties: { dataRvwCommentAnchor: "list-comment" },
    });
  });
});
