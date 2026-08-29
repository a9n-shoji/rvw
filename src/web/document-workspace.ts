import type { WalkthroughReferenceFileTarget } from "../domain/models.js";

export type DocumentPaneId = "left" | "right";

export interface ReferenceDocumentContext {
  outcome: "latest" | "source-fallback";
  walkthroughId: string;
  referenceId: string;
  anchorSourceOid: string;
  latestHeadOid: string;
  referenceFingerprint: string;
  diffBaseOid: string | null;
  hasDiff: boolean;
  latestFile: WalkthroughReferenceFileTarget | null;
}

export type ActiveDocument =
  | { kind: "pull-request-markdown" }
  | { kind: "walkthrough"; id: string; title: string; sourceOid: string }
  | { kind: "structure"; id: string; title: string; sourceOid: string }
  | {
      kind: "repository-file";
      path: string;
      oldPath?: string | null;
      newPath?: string | null;
      sourceOid?: string;
      comparisonPolicy?: "selected-range" | "exact-source" | "reference-target";
      referenceContext?: ReferenceDocumentContext;
    };

export interface DocumentWorkspaceState {
  documents: Record<DocumentPaneId, ActiveDocument[]>;
  active: Record<DocumentPaneId, ActiveDocument | null>;
  focusedPane: DocumentPaneId;
  navigationRevision: Record<DocumentPaneId, number>;
}

export interface DocumentPaneTransition {
  sourceDocument: ActiveDocument;
  targetDocument: ActiveDocument;
  sourcePane: DocumentPaneId;
  targetPane: DocumentPaneId;
}

const initialDocument: ActiveDocument = { kind: "pull-request-markdown" };

export function documentTabKey(document: ActiveDocument): string {
  if (document.kind === "pull-request-markdown") return "pull-request-markdown";
  if (document.kind === "walkthrough") return `walkthrough:${document.id}`;
  if (document.kind === "structure") return `structure:${document.id}`;
  return `file:${document.path}`;
}

export function documentPaneTabKey(paneId: DocumentPaneId, document: ActiveDocument): string {
  return `${paneId}:${documentTabKey(document)}`;
}

export function documentTabPath(document: ActiveDocument): string {
  if (document.kind === "pull-request-markdown") return "Pull Request.md";
  if (document.kind === "walkthrough") return document.title;
  if (document.kind === "structure") return document.title;
  return document.path;
}

export function documentTabLabel(document: ActiveDocument): string {
  const path = documentTabPath(document);
  return path.split("/").at(-1) ?? path;
}

export function initialDocumentWorkspace(): DocumentWorkspaceState {
  return {
    documents: { left: [initialDocument], right: [] },
    active: { left: initialDocument, right: null },
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

export function findDocumentInPane(
  current: DocumentWorkspaceState,
  document: ActiveDocument,
  paneId: DocumentPaneId,
): ActiveDocument | undefined {
  const key = documentTabKey(document);
  return current.documents[paneId].find((candidate) => documentTabKey(candidate) === key);
}

export function documentPaneIds(
  current: DocumentWorkspaceState,
  document: ActiveDocument,
): DocumentPaneId[] {
  return (["left", "right"] as const).filter((paneId) =>
    findDocumentInPane(current, document, paneId),
  );
}

export function documentPaneTransitions(
  previous: DocumentWorkspaceState,
  next: DocumentWorkspaceState,
): DocumentPaneTransition[] {
  const transitions: DocumentPaneTransition[] = [];
  for (const sourcePane of ["left", "right"] as const) {
    const targetPane = otherDocumentPane(sourcePane);
    for (const sourceDocument of previous.documents[sourcePane]) {
      if (findDocumentInPane(next, sourceDocument, sourcePane)) continue;
      const targetDocument = findDocumentInPane(next, sourceDocument, targetPane);
      if (!targetDocument) continue;
      transitions.push({ sourceDocument, targetDocument, sourcePane, targetPane });
    }
  }
  return transitions;
}

export function preferredDocumentPane(
  current: DocumentWorkspaceState,
  document: ActiveDocument,
): DocumentPaneId {
  if (findDocumentInPane(current, document, current.focusedPane)) return current.focusedPane;
  return documentPaneIds(current, document)[0] ?? current.focusedPane;
}

export function normalizeDocumentPanes(current: DocumentWorkspaceState): DocumentWorkspaceState {
  if (current.documents.left.length > 0 || current.documents.right.length === 0) return current;
  return {
    ...current,
    documents: { left: current.documents.right, right: [] },
    active: { left: current.active.right ?? current.documents.right[0] ?? null, right: null },
    focusedPane: "left",
  };
}

export function assignDocumentToPane(
  current: DocumentWorkspaceState,
  document: ActiveDocument,
  targetPane: DocumentPaneId,
): DocumentWorkspaceState {
  const key = documentTabKey(document);
  const existingIndex = current.documents[targetPane].findIndex(
    (candidate) => documentTabKey(candidate) === key,
  );
  const targetDocuments =
    existingIndex < 0
      ? [...current.documents[targetPane], document]
      : current.documents[targetPane].map((candidate, index) =>
          index === existingIndex ? document : candidate,
        );
  return {
    ...current,
    documents: { ...current.documents, [targetPane]: targetDocuments },
    active: { ...current.active, [targetPane]: document },
    focusedPane: targetPane,
  };
}

export function moveDocumentToPane(
  current: DocumentWorkspaceState,
  document: ActiveDocument,
  sourcePane: DocumentPaneId,
  targetPane: DocumentPaneId,
): DocumentWorkspaceState {
  if (sourcePane === targetPane) return assignDocumentToPane(current, document, targetPane);
  const key = documentTabKey(document);
  const sourceIndex = current.documents[sourcePane].findIndex(
    (candidate) => documentTabKey(candidate) === key,
  );
  if (sourceIndex < 0) return current;
  const sourceDocuments = current.documents[sourcePane].filter(
    (candidate) => documentTabKey(candidate) !== key,
  );
  const targetIndex = current.documents[targetPane].findIndex(
    (candidate) => documentTabKey(candidate) === key,
  );
  const targetDocuments =
    targetIndex < 0
      ? [...current.documents[targetPane], document]
      : current.documents[targetPane].map((candidate, index) =>
          index === targetIndex ? document : candidate,
        );
  const active = { ...current.active, [targetPane]: document };
  if (current.active[sourcePane] && documentTabKey(current.active[sourcePane]) === key) {
    const nextIndex = Math.min(sourceIndex, sourceDocuments.length - 1);
    active[sourcePane] = sourceDocuments[nextIndex] ?? sourceDocuments.at(-1) ?? null;
  }
  return normalizeDocumentPanes({
    ...current,
    documents: {
      ...current.documents,
      [sourcePane]: sourceDocuments,
      [targetPane]: targetDocuments,
    },
    active,
    focusedPane: targetPane,
  });
}

export function removeDocumentFromWorkspace(
  current: DocumentWorkspaceState,
  document: ActiveDocument,
  paneId?: DocumentPaneId,
): DocumentWorkspaceState {
  const key = documentTabKey(document);
  const closingPane =
    paneId ??
    (["left", "right"] as const).find((candidatePane) =>
      current.documents[candidatePane].some((candidate) => candidate === document),
    ) ??
    (findDocumentInPane(current, document, current.focusedPane)
      ? current.focusedPane
      : documentPaneIds(current, document)[0]);
  if (!closingPane) return current;
  const closingIndex = current.documents[closingPane].findIndex(
    (candidate) => documentTabKey(candidate) === key,
  );
  if (closingIndex < 0) return current;
  const remaining = current.documents[closingPane].filter(
    (candidate) => documentTabKey(candidate) !== key,
  );
  const active = { ...current.active };
  if (active[closingPane] && documentTabKey(active[closingPane]) === key) {
    const nextIndex = Math.min(closingIndex, remaining.length - 1);
    active[closingPane] = remaining[nextIndex] ?? remaining.at(-1) ?? null;
  }
  const focusedPane =
    current.focusedPane === closingPane && !active[closingPane]
      ? otherDocumentPane(closingPane)
      : current.focusedPane;
  return normalizeDocumentPanes({
    ...current,
    documents: { ...current.documents, [closingPane]: remaining },
    active,
    focusedPane,
  });
}

export function currentCommitDocument(document: ActiveDocument): ActiveDocument {
  if (document.kind === "pull-request-markdown") return { kind: "pull-request-markdown" };
  if (document.kind === "walkthrough" || document.kind === "structure") return document;
  if (document.comparisonPolicy === "reference-target") return document;
  return { kind: "repository-file", path: document.path };
}
