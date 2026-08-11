import { describe, expect, it } from "vitest";
import type { SearchResult } from "../../src/domain/models.js";
import { groupSearchResults, splitSearchResultPath } from "../../src/web/components/SearchPanel.js";

describe("search result grouping", () => {
  it("groups matching lines by file and counts every occurrence", () => {
    const pullRequestId = "11111111-1111-4111-8111-111111111111";
    const sourceOid = "a".repeat(40);
    const results: SearchResult[] = [
      {
        document: {
          kind: "repository-file",
          pullRequestId,
          sourceOid,
          path: "src/example.ts",
        },
        path: "src/example.ts",
        line: 2,
        text: "test test",
        matches: [
          { start: 0, end: 4 },
          { start: 5, end: 9 },
        ],
      },
      {
        document: {
          kind: "repository-file",
          pullRequestId,
          sourceOid,
          path: "src/example.ts",
        },
        path: "src/example.ts",
        line: 8,
        text: "another test",
        matches: [{ start: 8, end: 12 }],
      },
      {
        document: { kind: "pull-request-markdown", pullRequestId },
        path: "Pull Request.md",
        line: 1,
        text: "# Test",
        matches: [{ start: 2, end: 6 }],
      },
    ];

    expect(groupSearchResults(results)).toMatchObject([
      { path: "src/example.ts", matchCount: 3, results: [{ line: 2 }, { line: 8 }] },
      { path: "Pull Request.md", matchCount: 1, results: [{ line: 1 }] },
    ]);
  });
});

describe("search result path labels", () => {
  it("separates the filename from its parent directory", () => {
    expect(splitSearchResultPath("src/web/components/SearchPanel.tsx")).toEqual({
      fileName: "SearchPanel.tsx",
      directory: "src/web/components",
    });
  });

  it("leaves root-level files without a directory label", () => {
    expect(splitSearchResultPath("README.md")).toEqual({
      fileName: "README.md",
      directory: "",
    });
  });
});
