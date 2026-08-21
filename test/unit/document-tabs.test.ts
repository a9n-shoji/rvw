import { describe, expect, it } from "vitest";
import {
  assignDocumentToPane,
  currentCommitDocument,
  documentTabKey,
  documentTabLabel,
  documentTabPath,
  initialDocumentWorkspace,
  moveDocumentToPane,
  removeDocumentFromWorkspace,
  withDocumentNavigationRevision,
  type ActiveDocument,
} from "../../src/web/document-workspace.js";
import { documentTabPresentation } from "../../src/web/document-tab-presentation.js";

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

  it("uses the shortest unique parent suffix for duplicate basenames", () => {
    const documents: ActiveDocument[] = [
      { kind: "repository-file", path: "src/application/orders/create-order.ts" },
      { kind: "repository-file", path: "src/http/controllers/create-order.ts" },
      { kind: "repository-file", path: "src/http/schemas/create-order.ts" },
    ];

    expect(documents.map((document) => documentTabPresentation(document, documents))).toEqual([
      {
        displayLabel: "create-order.ts · orders",
        accessibleLabel: "src/application/orders/create-order.ts",
      },
      {
        displayLabel: "create-order.ts · controllers",
        accessibleLabel: "src/http/controllers/create-order.ts",
      },
      {
        displayLabel: "create-order.ts · schemas",
        accessibleLabel: "src/http/schemas/create-order.ts",
      },
    ]);
  });

  it("distinguishes virtual and repository documents with the same display path", () => {
    const pullRequestDocument: ActiveDocument = { kind: "pull-request-markdown" };
    const repositoryDocument: ActiveDocument = {
      kind: "repository-file",
      path: "Pull Request.md",
    };
    const documents = [pullRequestDocument, repositoryDocument];

    expect(documentTabPresentation(pullRequestDocument, documents)).toEqual({
      displayLabel: "Pull Request.md · PR本文",
      accessibleLabel: "Pull Request.md（PR本文）",
      identityQualifier: "PR本文",
    });
    expect(documentTabPresentation(repositoryDocument, documents)).toEqual({
      displayLabel: "Pull Request.md · repository",
      accessibleLabel: "Pull Request.md（repository）",
      identityQualifier: "repository",
    });
  });

  it("distinguishes walkthroughs with identical titles", () => {
    const documents: ActiveDocument[] = [
      {
        kind: "walkthrough",
        id: "11111111-aaaa-4111-8111-111111111111",
        title: "同じ説明",
        sourceOid: "a".repeat(40),
      },
      {
        kind: "walkthrough",
        id: "22222222-bbbb-4222-8222-222222222222",
        title: "同じ説明",
        sourceOid: "a".repeat(40),
      },
    ];

    expect(documents.map((document) => documentTabPresentation(document, documents))).toEqual([
      {
        displayLabel: "同じ説明 · Walkthrough 11111111",
        accessibleLabel: "同じ説明（Walkthrough 11111111）",
        identityQualifier: "Walkthrough 11111111",
      },
      {
        displayLabel: "同じ説明 · Walkthrough 22222222",
        accessibleLabel: "同じ説明（Walkthrough 22222222）",
        identityQualifier: "Walkthrough 22222222",
      },
    ]);
  });

  it("opens the same document once in each pane", () => {
    const repositoryFile: ActiveDocument = { kind: "repository-file", path: "src/index.ts" };
    const withFile = assignDocumentToPane(initialDocumentWorkspace(), repositoryFile, "left");
    const duplicated = assignDocumentToPane(
      withFile,
      {
        ...repositoryFile,
        sourceOid: "a".repeat(40),
        comparisonPolicy: "exact-source",
      },
      "right",
    );

    expect(duplicated.documents.left).toEqual([{ kind: "pull-request-markdown" }, repositoryFile]);
    expect(duplicated.documents.right).toEqual([
      {
        ...repositoryFile,
        sourceOid: "a".repeat(40),
        comparisonPolicy: "exact-source",
      },
    ]);
    expect(duplicated.active.left).toEqual(repositoryFile);
    expect(duplicated.active.right).toEqual(duplicated.documents.right[0]);
  });

  it("keeps at most one copy of a document within a pane", () => {
    const repositoryFile: ActiveDocument = { kind: "repository-file", path: "src/index.ts" };
    const withFile = assignDocumentToPane(initialDocumentWorkspace(), repositoryFile, "left");
    const replaced = assignDocumentToPane(
      withFile,
      { ...repositoryFile, sourceOid: "a".repeat(40), comparisonPolicy: "exact-source" },
      "left",
    );

    expect(replaced.documents.left).toHaveLength(2);
    expect(replaced.documents.left[1]).toMatchObject({
      kind: "repository-file",
      path: "src/index.ts",
      comparisonPolicy: "exact-source",
    });
  });

  it("moves a tab without leaving a duplicate in its source pane", () => {
    const repositoryFile: ActiveDocument = { kind: "repository-file", path: "src/index.ts" };
    const withFile = assignDocumentToPane(initialDocumentWorkspace(), repositoryFile, "left");
    const moved = moveDocumentToPane(withFile, repositoryFile, "left", "right");

    expect(moved.documents.left).toEqual([{ kind: "pull-request-markdown" }]);
    expect(moved.documents.right).toEqual([repositoryFile]);
    expect(moved.active.left).toEqual({ kind: "pull-request-markdown" });
    expect(moved.active.right).toEqual(repositoryFile);
    expect(moved.focusedPane).toBe("right");
  });

  it("collapses a right-only workspace back into the left pane", () => {
    const moved = moveDocumentToPane(
      initialDocumentWorkspace(),
      { kind: "pull-request-markdown" },
      "left",
      "right",
    );

    expect(moved.documents).toEqual({
      left: [{ kind: "pull-request-markdown" }],
      right: [],
    });
    expect(moved.active).toEqual({ left: { kind: "pull-request-markdown" }, right: null });
    expect(moved.focusedPane).toBe("left");
  });

  it("selects a remaining document when the active tab closes", () => {
    const firstFile: ActiveDocument = { kind: "repository-file", path: "src/first.ts" };
    const secondFile: ActiveDocument = { kind: "repository-file", path: "src/second.ts" };
    const withFirst = assignDocumentToPane(initialDocumentWorkspace(), firstFile, "left");
    const withSecond = assignDocumentToPane(withFirst, secondFile, "left");
    const closed = removeDocumentFromWorkspace(withSecond, secondFile);

    expect(closed.documents.left).not.toContain(secondFile);
    expect(closed.active.left).toEqual(firstFile);
  });

  it("closes only the requested pane copy", () => {
    const file: ActiveDocument = { kind: "repository-file", path: "src/index.ts" };
    const inLeft = assignDocumentToPane(initialDocumentWorkspace(), file, "left");
    const inBoth = assignDocumentToPane(inLeft, file, "right");
    const closedRight = removeDocumentFromWorkspace(inBoth, file, "right");

    expect(closedRight.documents.left).toContainEqual(file);
    expect(closedRight.documents.right).toEqual([]);
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
