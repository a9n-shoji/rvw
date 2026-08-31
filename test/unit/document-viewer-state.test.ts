import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../../src/domain/models.js";
import { sourceAnchorFingerprint } from "../../src/domain/walkthrough-reference.js";
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
    latestHeadOid: selectedOid,
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
          origin: {
            kind: "walkthrough",
            walkthroughId: "walkthrough",
            referenceId: "reference",
          },
          anchorSourceOid: "a".repeat(40),
          latestHeadOid: sourceOid,
          referenceFingerprint: "fingerprint",
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
          origin: {
            kind: "walkthrough",
            walkthroughId: "walkthrough",
            referenceId: "reference",
          },
          anchorSourceOid: "a".repeat(40),
          latestHeadOid: sourceOid,
          referenceFingerprint: "fingerprint",
          diffBaseOid: null,
          hasDiff: false,
          latestFile: null,
        },
      },
      context({ latestHeadOid: sourceOid }),
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

  it("keeps a stale latest reference full without calling the current range historical", () => {
    const resolvedHeadOid = "c".repeat(40);
    const currentHeadOid = "d".repeat(40);
    const state = deriveDocumentViewerState(
      {
        kind: "repository-file",
        path: "src/latest-at-resolution.ts",
        sourceOid: resolvedHeadOid,
        comparisonPolicy: "reference-target",
        referenceContext: {
          outcome: "latest",
          origin: {
            kind: "walkthrough",
            walkthroughId: "walkthrough",
            referenceId: "reference",
          },
          anchorSourceOid: "a".repeat(40),
          latestHeadOid: resolvedHeadOid,
          referenceFingerprint: "fingerprint",
          diffBaseOid: null,
          hasDiff: false,
          latestFile: null,
        },
      },
      context({ selectedOid: currentHeadOid, latestHeadOid: currentHeadOid }),
    );

    expect(state.activeChange).toBeUndefined();
    expect(state.effectiveDisplayMode).toBe("full");
    expect(state.fullViewNotice).toBeNull();
    expect(state.viewerDocument).toMatchObject({
      path: "src/latest-at-resolution.ts",
      sourceOid: resolvedHeadOid,
    });
  });

  it("marks a resolution stale when its Walkthrough reference coordinates change", () => {
    const sourceOid = selectedOid;
    const resolvedReference = {
      id: "reference",
      label: "Original reference",
      path: "src/original.ts",
      startLine: 4,
      endLine: 8,
      description: null,
    };
    const state = deriveDocumentViewerState(
      {
        kind: "repository-file",
        path: resolvedReference.path,
        sourceOid,
        comparisonPolicy: "reference-target",
        referenceContext: {
          outcome: "latest",
          origin: {
            kind: "walkthrough",
            walkthroughId: "walkthrough",
            referenceId: resolvedReference.id,
          },
          anchorSourceOid: sourceOid,
          latestHeadOid: sourceOid,
          referenceFingerprint: sourceAnchorFingerprint(sourceOid, resolvedReference),
          diffBaseOid: null,
          hasDiff: false,
          latestFile: null,
        },
      },
      context({
        walkthroughDetails: new Map([
          [
            "walkthrough",
            {
              id: "walkthrough",
              ref: "rvw://walkthrough/walkthrough",
              pullRequestId: "pull-request",
              sourceOid,
              title: "Updated Walkthrough",
              body: "Updated body",
              authorLabel: "Codex",
              diagramBindings: {},
              references: [
                {
                  ...resolvedReference,
                  path: "src/updated.ts",
                  startLine: 12,
                  endLine: 16,
                },
              ],
              createdAt: "2026-08-29T00:00:00.000Z",
            },
          ],
        ]),
      }),
    );

    expect(state.referenceStaleness).toEqual({
      headChanged: false,
      originChanged: true,
      originKind: "walkthrough",
    });
    expect(state.fullViewNotice).toBeNull();
  });

  it("marks a resolution stale when its Structure source anchor changes", () => {
    const resolvedSourceOid = "a".repeat(40);
    const currentSourceOid = "b".repeat(40);
    const anchor = { path: "src/structure.ts", startLine: 4, endLine: 8 };
    const state = deriveDocumentViewerState(
      {
        kind: "repository-file",
        path: anchor.path,
        sourceOid: selectedOid,
        comparisonPolicy: "reference-target",
        referenceContext: {
          outcome: "latest",
          origin: { kind: "structure", structureId: "structure", anchor },
          anchorSourceOid: resolvedSourceOid,
          latestHeadOid: selectedOid,
          referenceFingerprint: sourceAnchorFingerprint(resolvedSourceOid, anchor),
          diffBaseOid: null,
          hasDiff: false,
          latestFile: null,
        },
      },
      context({
        structureDetails: new Map([
          [
            "structure",
            {
              id: "structure",
              ref: "rvw://structure/structure",
              pullRequestId: "pull-request",
              sourceOid: currentSourceOid,
              title: "Updated Structure",
              scope: "Updated scope",
              originNodeId: "node",
              nodes: [
                {
                  id: "node",
                  label: "Node",
                  description: null,
                  kind: null,
                  notation: "plain",
                  anchor,
                },
              ],
              edges: [],
              createdAt: "2026-08-29T00:00:00.000Z",
              updatedAt: "2026-08-29T00:00:01.000Z",
            },
          ],
        ]),
      }),
    );

    expect(state.referenceStaleness).toEqual({
      headChanged: false,
      originChanged: true,
      originKind: "structure",
    });
    expect(state.fullViewNotice).toBeNull();
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
          origin: {
            kind: "walkthrough",
            walkthroughId: "walkthrough",
            referenceId: "reference",
          },
          anchorSourceOid: "a".repeat(40),
          latestHeadOid: "c".repeat(40),
          referenceFingerprint: "fingerprint",
          diffBaseOid: selectedOid,
          hasDiff: false,
          latestFile: null,
        },
      },
      context({ latestHeadOid: "c".repeat(40) }),
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
