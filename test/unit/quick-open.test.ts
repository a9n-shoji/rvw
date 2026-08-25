import { describe, expect, it } from "vitest";
import {
  buildQuickOpenCandidates,
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

  it("builds large candidate lists without comparing every document pair", () => {
    const files = Array.from({ length: 5_000 }, (_, index) => ({
      path: `packages/package-${String(index).padStart(4, "0")}/src/index.ts`,
      entryKind: "file" as const,
    }));

    const candidates = buildQuickOpenCandidates(files, [], null);

    expect(candidates).toHaveLength(5_001);
    expect(candidates.at(-1)?.path).toBe("packages/package-4999/src/index.ts");
  });

  it("qualifies virtual and repository documents only when their paths collide", () => {
    const candidates = buildQuickOpenCandidates(
      [
        { path: "Pull Request.md", entryKind: "file" },
        { path: "README.md", entryKind: "file" },
      ],
      [],
      null,
    );

    expect(candidates.map(({ path, identityQualifier }) => ({ path, identityQualifier }))).toEqual([
      { path: "Pull Request.md", identityQualifier: "PR本文" },
      { path: "Pull Request.md", identityQualifier: "repository" },
      { path: "README.md", identityQualifier: undefined },
    ]);
  });

  it("includes already-open Issue and Walkthrough documents without duplicating files", () => {
    const issue = {
      kind: "issue" as const,
      id: "issue-142",
      number: 142,
      title: "Stabilize the request path",
      url: "https://github.com/acme/review-repo/issues/142",
    };
    const walkthrough = {
      kind: "walkthrough" as const,
      id: "walkthrough-1",
      title: "Current request flow",
      sourceOid: "a".repeat(40),
    };
    const file = { kind: "repository-file" as const, path: "README.md" };

    const candidates = buildQuickOpenCandidates(
      [{ path: "README.md", entryKind: "file" }],
      [file, issue, walkthrough, issue],
      walkthrough,
      false,
    );

    expect(
      candidates.map(({ key, path, isActive, isOpen }) => ({ key, path, isActive, isOpen })),
    ).toEqual([
      { key: "file:README.md", path: "README.md", isActive: false, isOpen: true },
      {
        key: "issue:issue-142",
        path: "#142 Stabilize the request path",
        isActive: false,
        isOpen: true,
      },
      {
        key: "walkthrough:walkthrough-1",
        path: "Current request flow",
        isActive: true,
        isOpen: true,
      },
    ]);
  });
});
