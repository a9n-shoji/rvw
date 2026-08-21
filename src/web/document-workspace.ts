export type DocumentPaneId = "left" | "right";

export type ActiveDocument =
  | { kind: "pull-request-markdown" }
  | { kind: "issue"; id: string; number: number; title: string; url: string }
  | { kind: "walkthrough"; id: string; title: string; sourceOid: string }
  | {
      kind: "repository-file";
      path: string;
      oldPath?: string | null;
      newPath?: string | null;
      sourceOid?: string;
      comparisonPolicy?: "selected-range" | "exact-source";
    };

export interface DocumentWorkspaceState {
  documents: ActiveDocument[];
  panes: Record<string, DocumentPaneId>;
  active: Record<DocumentPaneId, ActiveDocument | null>;
  focusedPane: DocumentPaneId;
  navigationRevision: Record<DocumentPaneId, number>;
}

const initialDocument: ActiveDocument = { kind: "pull-request-markdown" };

export function documentTabKey(document: ActiveDocument): string {
  if (document.kind === "pull-request-markdown") return "pull-request-markdown";
  if (document.kind === "issue") return `issue:${document.id}`;
  if (document.kind === "walkthrough") return `walkthrough:${document.id}`;
  return `file:${document.path}`;
}

export function documentTabPath(document: ActiveDocument): string {
  if (document.kind === "pull-request-markdown") return "Pull Request.md";
  if (document.kind === "issue") return `#${document.number} ${document.title}`;
  if (document.kind === "walkthrough") return document.title;
  return document.path;
}

export function documentTabLabel(document: ActiveDocument): string {
  const path = documentTabPath(document);
  return path.split("/").at(-1) ?? path;
}

export function initialDocumentWorkspace(
  initial: ActiveDocument | null = initialDocument,
): DocumentWorkspaceState {
  if (!initial) {
    return {
      documents: [],
      panes: {},
      active: { left: null, right: null },
      focusedPane: "left",
      navigationRevision: { left: 0, right: 0 },
    };
  }
  return {
    documents: [initial],
    panes: { [documentTabKey(initial)]: "left" },
    active: { left: initial, right: null },
    focusedPane: "left",
    navigationRevision: { left: 0, right: 0 },
  };
}

export function withDocumentNavigationRevision(
  current: DocumentWorkspaceState,
  next: DocumentWorkspaceState,
  replaceAll = false,
): DocumentWorkspaceState {
  if (next === current) return current;
  return {
    ...next,
    navigationRevision: {
      left:
        current.navigationRevision.left +
        Number(replaceAll || current.active.left !== next.active.left),
      right:
        current.navigationRevision.right +
        Number(replaceAll || current.active.right !== next.active.right),
    },
  };
}

export function otherDocumentPane(paneId: DocumentPaneId): DocumentPaneId {
  return paneId === "left" ? "right" : "left";
}

function normalizeDocumentPanes(current: DocumentWorkspaceState): DocumentWorkspaceState {
  const leftDocuments = current.documents.filter(
    (document) => (current.panes[documentTabKey(document)] ?? "left") === "left",
  );
  const rightDocuments = current.documents.filter(
    (document) => current.panes[documentTabKey(document)] === "right",
  );
  if (leftDocuments.length > 0 || rightDocuments.length === 0) return current;
  return {
    ...current,
    panes: Object.fromEntries(
      current.documents.map((document) => [documentTabKey(document), "left" as const]),
    ),
    active: { left: current.active.right ?? rightDocuments[0] ?? null, right: null },
    focusedPane: "left",
  };
}

export function assignDocumentToPane(
  current: DocumentWorkspaceState,
  document: ActiveDocument,
  targetPane: DocumentPaneId,
): DocumentWorkspaceState {
  const key = documentTabKey(document);
  const existingIndex = current.documents.findIndex(
    (candidate) => documentTabKey(candidate) === key,
  );
  const documents =
    existingIndex < 0
      ? [...current.documents, document]
      : current.documents.map((candidate, index) =>
          index === existingIndex ? document : candidate,
        );
  const sourcePane = current.panes[key];
  const panes = { ...current.panes, [key]: targetPane };
  const active = { ...current.active, [targetPane]: document };
  if (
    sourcePane &&
    sourcePane !== targetPane &&
    current.active[sourcePane] &&
    documentTabKey(current.active[sourcePane]) === key
  ) {
    active[sourcePane] =
      documents.find(
        (candidate) =>
          documentTabKey(candidate) !== key && panes[documentTabKey(candidate)] === sourcePane,
      ) ?? null;
  }
  return normalizeDocumentPanes({
    ...current,
    documents,
    panes,
    active,
    focusedPane: targetPane,
  });
}

export function removeDocumentFromWorkspace(
  current: DocumentWorkspaceState,
  document: ActiveDocument,
): DocumentWorkspaceState {
  const key = documentTabKey(document);
  const closingIndex = current.documents.findIndex(
    (candidate) => documentTabKey(candidate) === key,
  );
  if (closingIndex < 0) return current;
  const closingPane = current.panes[key] ?? "left";
  const remaining = current.documents.filter((candidate) => documentTabKey(candidate) !== key);
  const panes = { ...current.panes };
  delete panes[key];
  const active = { ...current.active };
  if (active[closingPane] && documentTabKey(active[closingPane]) === key) {
    const paneDocuments = remaining.filter(
      (candidate) => panes[documentTabKey(candidate)] === closingPane,
    );
    const nextIndex = Math.min(closingIndex, paneDocuments.length - 1);
    active[closingPane] = paneDocuments[nextIndex] ?? paneDocuments.at(-1) ?? null;
  }
  const focusedPane =
    current.focusedPane === closingPane && !active[closingPane]
      ? closingPane === "left"
        ? "right"
        : "left"
      : current.focusedPane;
  return normalizeDocumentPanes({
    ...current,
    documents: remaining,
    panes,
    active,
    focusedPane,
  });
}

export function currentCommitDocument(document: ActiveDocument): ActiveDocument {
  if (document.kind === "pull-request-markdown") return { kind: "pull-request-markdown" };
  if (document.kind === "issue") return document;
  if (document.kind === "walkthrough") return document;
  return { kind: "repository-file", path: document.path };
}
