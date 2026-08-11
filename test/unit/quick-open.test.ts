import { describe, expect, it } from "vitest";
import {
  rankQuickOpenCandidates,
  type QuickOpenCandidate,
} from "../../src/web/components/QuickOpenPalette.js";

function candidate(
  path: string,
  options: { active?: boolean; open?: boolean } = {},
): QuickOpenCandidate {
  const name = path.split("/").at(-1) ?? path;
  return {
    key: `file:${path}`,
    document: { kind: "repository-file", path },
    path,
    name,
    directory: path.slice(0, Math.max(0, path.length - name.length - 1)),
    entryKind: "file",
    isActive: options.active ?? false,
    isOpen: options.open ?? false,
  };
}

describe("quick open", () => {
  const candidates = [
    candidate("docs/document-tabs.md"),
    candidate("src/web/components/DocumentTabs.tsx"),
    candidate("src/web/components/DocumentViewer.tsx"),
    candidate("src/domain/models.ts"),
  ];

  it("ranks fuzzy filename matches ahead of weaker path matches", () => {
    const results = rankQuickOpenCandidates(candidates, "dctabs");

    expect(results[0]?.candidate.path).toBe("src/web/components/DocumentTabs.tsx");
    expect(results[0]?.nameMatch?.indexes.length).toBeGreaterThan(0);
  });

  it("shows the active and already-open files first before a query is entered", () => {
    const results = rankQuickOpenCandidates(
      [
        candidate("src/c.ts"),
        candidate("src/b.ts", { open: true }),
        candidate("src/a.ts", { active: true, open: true }),
      ],
      "",
    );

    expect(results.map((result) => result.candidate.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });
});
