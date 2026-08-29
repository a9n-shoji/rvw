import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../../src/domain/models.js";
import { deriveDocumentViewerState } from "../../src/web/document-viewer-state.js";

const selectedOid = "b".repeat(40);
const changedFile: ChangedFile = {
  kind: "renamed",
  status: "R",
  similarity: 100,
  oldPath: "src/old.ts",
  newPath: "src/new.ts",
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    documentDisplayMode: "diff" as const,
    displayMode: "range" as const,
    selectedOid,
    changedFiles: [changedFile],
    changedFilesLoaded: true,
    walkthroughDetails: new Map(),
    loadingWalkthroughIds: new Set<string>(),
    ...overrides,
  };
}

describe("document viewer state", () => {
  it("applies the selected change paths to a repository document", () => {
    const state = deriveDocumentViewerState(
      { kind: "repository-file", path: "src/old.ts" },
      context(),
    );

    expect(state.activeChange).toBe(changedFile);
    expect(state.viewerDocument).toMatchObject({
      path: "src/new.ts",
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
    });
    expect(state.effectiveDisplayMode).toBe("range");
  });

  it("falls back locally to selected-commit full text when the file did not change", () => {
    const state = deriveDocumentViewerState(
      { kind: "repository-file", path: "src/unchanged.ts" },
      context(),
    );

    expect(state.effectiveDisplayMode).toBe("full");
    expect(state.fullViewNotice).toBe("差分なし · 全文表示");
    expect(state.viewerDocument).toMatchObject({
      path: "src/unchanged.ts",
      sourceOid: selectedOid,
    });
  });

  it("keeps an exact source document full without changing the selected review range", () => {
    const sourceOid = "a".repeat(40);
    const state = deriveDocumentViewerState(
      {
        kind: "repository-file",
        path: "src/history.ts",
        sourceOid,
        comparisonPolicy: "exact-source",
      },
      context(),
    );

    expect(state.effectiveDisplayMode).toBe("full");
    expect(state.fullViewNotice).toBe(
      `参照元 ${sourceOid.slice(0, 8)} ≠ 対象 ${selectedOid.slice(0, 8)} · 全文表示`,
    );
  });

  it("uses the selected global comparison for a latest Walkthrough reference", () => {
    const sourceOid = selectedOid;
    const state = deriveDocumentViewerState(
      {
        kind: "repository-file",
        path: "src/new.ts",
        sourceOid,
        comparisonPolicy: "reference-target",
        referenceContext: {
          outcome: "latest",
          walkthroughId: "walkthrough",
          referenceId: "reference",
          anchorSourceOid: "a".repeat(40),
          latestHeadOid: sourceOid,
          diffBaseOid: selectedOid,
          hasDiff: true,
          latestFile: null,
        },
      },
      context(),
    );

    expect(state.activeChange).toBe(changedFile);
    expect(state.effectiveDisplayMode).toBe("range");
    expect(state.fullViewNotice).toBeNull();
    expect(state.viewerDocument).toMatchObject({
      sourceOid,
      comparisonPolicy: "reference-target",
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
    });
  });

  it("keeps latest full text when the global comparison ends at a historical commit", () => {
    const sourceOid = "c".repeat(40);
    const state = deriveDocumentViewerState(
      {
        kind: "repository-file",
        path: "src/new.ts",
        sourceOid,
        comparisonPolicy: "reference-target",
        referenceContext: {
          outcome: "latest",
          walkthroughId: "walkthrough",
          referenceId: "reference",
          anchorSourceOid: "a".repeat(40),
          latestHeadOid: sourceOid,
          diffBaseOid: null,
          hasDiff: false,
          latestFile: null,
        },
      },
      context(),
    );

    expect(state.activeChange).toBeUndefined();
    expect(state.effectiveDisplayMode).toBe("full");
    expect(state.fullViewNotice).toBe(
      "選択中の比較範囲は最新HEADで終わっていないため · 最新の全文表示",
    );
    expect(state.viewerDocument).toMatchObject({
      path: "src/new.ts",
      sourceOid,
      comparisonPolicy: "reference-target",
    });
    expect(state.viewerDocument).not.toHaveProperty("oldPath");
  });

  it("shows the resolved target as full text locally when its commit has no file diff", () => {
    const state = deriveDocumentViewerState(
      {
        kind: "repository-file",
        path: "src/reference.ts",
        sourceOid: "c".repeat(40),
        comparisonPolicy: "reference-target",
        referenceContext: {
          outcome: "source-fallback",
          walkthroughId: "walkthrough",
          referenceId: "reference",
          anchorSourceOid: "a".repeat(40),
          latestHeadOid: "c".repeat(40),
          diffBaseOid: selectedOid,
          hasDiff: false,
          latestFile: null,
        },
      },
      context(),
    );

    expect(state.effectiveDisplayMode).toBe("full");
    expect(state.fullViewNotice).toBe("差分なし · 全文表示");
  });

  it("explains why a deleted destination has no full view", () => {
    const deleted = { ...changedFile, kind: "deleted" as const, newPath: null };
    const state = deriveDocumentViewerState(
      { kind: "repository-file", path: "src/old.ts" },
      context({ documentDisplayMode: "full", displayMode: "full", changedFiles: [deleted] }),
    );

    expect(state.fullViewUnavailableMessage).toContain("選択範囲の末尾で削除");
  });
});
