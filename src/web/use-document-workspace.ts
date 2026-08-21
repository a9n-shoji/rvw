import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  assignDocumentToPane,
  documentTabKey,
  initialDocumentWorkspace,
  removeDocumentFromWorkspace,
  withDocumentNavigationRevision,
  type ActiveDocument,
  type DocumentPaneId,
  type DocumentWorkspaceState,
} from "./document-workspace.js";

type DocumentWorkspaceUpdate =
  DocumentWorkspaceState | ((current: DocumentWorkspaceState) => DocumentWorkspaceState);

export function useDocumentWorkspace(
  onDocumentNavigation: () => void,
  initialDocument?: ActiveDocument | null,
) {
  const [workspace, setWorkspaceState] = useState<DocumentWorkspaceState>(() =>
    initialDocumentWorkspace(initialDocument === undefined ? undefined : initialDocument),
  );
  const workspaceRef = useRef(workspace);
  const setWorkspace = useCallback((update: DocumentWorkspaceUpdate): void => {
    setWorkspaceState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      return withDocumentNavigationRevision(current, next, typeof update !== "function");
    });
  }, []);

  useLayoutEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  const activateDocument = useCallback(
    (document: ActiveDocument, pane?: DocumentPaneId): void => {
      onDocumentNavigation();
      setWorkspace((current) => {
        const targetPane = pane ?? current.panes[documentTabKey(document)] ?? current.focusedPane;
        return {
          ...current,
          active: { ...current.active, [targetPane]: document },
          focusedPane: targetPane,
        };
      });
    },
    [onDocumentNavigation, setWorkspace],
  );

  const openDocument = useCallback(
    (document: ActiveDocument, targetPane?: DocumentPaneId): void => {
      onDocumentNavigation();
      setWorkspace((current) => {
        const key = documentTabKey(document);
        return assignDocumentToPane(
          current,
          document,
          targetPane ?? current.panes[key] ?? current.focusedPane,
        );
      });
    },
    [onDocumentNavigation, setWorkspace],
  );

  const closeDocument = useCallback(
    (document: ActiveDocument): void => {
      onDocumentNavigation();
      setWorkspace((current) => removeDocumentFromWorkspace(current, document));
    },
    [onDocumentNavigation, setWorkspace],
  );

  const closePaneDocuments = useCallback(
    (paneId: DocumentPaneId, keepDocument: ActiveDocument | null = null): void => {
      onDocumentNavigation();
      setWorkspace((current) => {
        const keepKey = keepDocument ? documentTabKey(keepDocument) : null;
        const documentsToClose = current.documents.filter((document) => {
          const key = documentTabKey(document);
          return (current.panes[key] ?? "left") === paneId && key !== keepKey;
        });
        return documentsToClose.reduce(removeDocumentFromWorkspace, current);
      });
    },
    [onDocumentNavigation, setWorkspace],
  );

  const moveDocument = useCallback(
    (document: ActiveDocument, targetPane: DocumentPaneId): void => {
      onDocumentNavigation();
      setWorkspace((current) => assignDocumentToPane(current, document, targetPane));
    },
    [onDocumentNavigation, setWorkspace],
  );

  const dropDocument = useCallback(
    (documentKey: string, targetPane: DocumentPaneId): void => {
      setWorkspace((current) => {
        const document = current.documents.find(
          (candidate) => documentTabKey(candidate) === documentKey,
        );
        return document ? assignDocumentToPane(current, document, targetPane) : current;
      });
    },
    [setWorkspace],
  );

  return {
    workspace,
    workspaceRef,
    setWorkspace,
    activateDocument,
    openDocument,
    closeDocument,
    closePaneDocuments,
    moveDocument,
    dropDocument,
  };
}
