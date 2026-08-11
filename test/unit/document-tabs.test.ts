import { describe, expect, it } from "vitest";
import {
  assignDocumentToPane,
  currentCommitDocument,
  documentTabKey,
  documentTabLabel,
  documentTabPath,
  initialDocumentWorkspace,
  removeDocumentFromWorkspace,
  withDocumentNavigationRevision,
  type ActiveDocument,
} from "../../src/web/document-workspace.js";

describe("document tabs", () => {
  it("uses one stable tab identity for each document path", () => {
    const current: ActiveDocument = { kind: "repository-file", path: "src/web/app/App.tsx" };
    const historical: ActiveDocument = {
      kind: "repository-file",
      path: "src/web/app/App.tsx",
      sourceOid: "a".repeat(40),
    };

    expect(documentTabKey(current)).toBe("file:src/web/app/App.tsx");
    expect(documentTabKey(historical)).toBe(documentTabKey(current));
    expect(documentTabLabel(current)).toBe("App.tsx");
    expect(documentTabPath(current)).toBe("src/web/app/App.tsx");
  });

  it("gives Pull Request.md one fixed tab identity", () => {
    const document: ActiveDocument = { kind: "pull-request-markdown" };

    expect(documentTabKey(document)).toBe("pull-request-markdown");
    expect(documentTabLabel(document)).toBe("Pull Request.md");
    expect(documentTabPath(document)).toBe("Pull Request.md");
  });

  it("moves a document between panes and keeps both panes usable", () => {
    const repositoryFile: ActiveDocument = { kind: "repository-file", path: "src/index.ts" };
    const withFile = assignDocumentToPane(initialDocumentWorkspace(), repositoryFile, "left");
    const moved = assignDocumentToPane(withFile, repositoryFile, "right");

    expect(moved.panes).toMatchObject({
      "pull-request-markdown": "left",
      "file:src/index.ts": "right",
    });
    expect(moved.active.left).toEqual({ kind: "pull-request-markdown" });
    expect(moved.active.right).toEqual(repositoryFile);
    expect(moved.focusedPane).toBe("right");
  });

  it("collapses a right-only workspace back into the left pane", () => {
    const moved = assignDocumentToPane(
      initialDocumentWorkspace(),
      { kind: "pull-request-markdown" },
      "right",
    );

    expect(moved.panes).toEqual({ "pull-request-markdown": "left" });
    expect(moved.active).toEqual({ left: { kind: "pull-request-markdown" }, right: null });
    expect(moved.focusedPane).toBe("left");
  });

  it("selects a remaining document when the active tab closes", () => {
    const firstFile: ActiveDocument = { kind: "repository-file", path: "src/first.ts" };
    const secondFile: ActiveDocument = { kind: "repository-file", path: "src/second.ts" };
    const withFirst = assignDocumentToPane(initialDocumentWorkspace(), firstFile, "left");
    const withSecond = assignDocumentToPane(withFirst, secondFile, "left");
    const closed = removeDocumentFromWorkspace(withSecond, secondFile);

    expect(closed.documents).not.toContain(secondFile);
    expect(closed.active.left).toEqual(firstFile);
  });

  it("increments navigation revisions only for panes whose active document changed", () => {
    const current = initialDocumentWorkspace();
    const file: ActiveDocument = { kind: "repository-file", path: "src/index.ts" };
    const next = assignDocumentToPane(current, file, "right");

    expect(withDocumentNavigationRevision(current, next).navigationRevision).toEqual({
      left: 0,
      right: 1,
    });
    expect(withDocumentNavigationRevision(current, next, true).navigationRevision).toEqual({
      left: 1,
      right: 1,
    });
  });

  it("rebinds exact repository documents to the selected commit without changing walkthroughs", () => {
    const exactDocument: ActiveDocument = {
      kind: "repository-file",
      path: "src/index.ts",
      sourceOid: "a".repeat(40),
      comparisonPolicy: "exact-source",
    };
    const walkthrough: ActiveDocument = {
      kind: "walkthrough",
      id: "walkthrough-id",
      title: "Flow",
      sourceOid: "b".repeat(40),
    };

    expect(currentCommitDocument(exactDocument)).toEqual({
      kind: "repository-file",
      path: "src/index.ts",
    });
    expect(currentCommitDocument(walkthrough)).toBe(walkthrough);
  });
});
