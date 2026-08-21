import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  assignDocumentToPane,
  documentTabKey,
  findDocumentInPane,
  initialDocumentWorkspace,
  moveDocumentToPane,
  preferredDocumentPane,
  removeDocumentFromWorkspace,
  withDocumentNavigationRevision,
  type ActiveDocument,
  type DocumentPaneId,
  type DocumentWorkspaceState,
} from "./document-workspace.js";

type DocumentWorkspaceUpdate =
  DocumentWorkspaceState | ((current: DocumentWorkspaceState) => DocumentWorkspaceState);

export function useDocumentWorkspace(
  onDocumentNavigation: (paneIds: readonly DocumentPaneId[]) => void,
) {
  const [workspace, setWorkspaceState] = useState<DocumentWorkspaceState>(initialDocumentWorkspace);
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
      const targetPane = pane ?? preferredDocumentPane(workspaceRef.current, document);
      onDocumentNavigation([targetPane]);
      setWorkspace((current) => {
        const currentTargetPane = pane ?? preferredDocumentPane(current, document);
        const activeDocument = findDocumentInPane(current, document, currentTargetPane) ?? document;
        return {
          ...current,
          active: { ...current.active, [currentTargetPane]: activeDocument },
          focusedPane: currentTargetPane,
        };
      });
    },
    [onDocumentNavigation, setWorkspace],
  );

  const openDocument = useCallback(
    (document: ActiveDocument, targetPane?: DocumentPaneId): void => {
      const resolvedPane = targetPane ?? preferredDocumentPane(workspaceRef.current, document);
      onDocumentNavigation([resolvedPane]);
      setWorkspace((current) => {
        return assignDocumentToPane(
          current,
          document,
          targetPane ?? preferredDocumentPane(current, document),
        );
      });
    },
    [onDocumentNavigation, setWorkspace],
  );

  const closeDocument = useCallback(
    (document: ActiveDocument, paneId?: DocumentPaneId): void => {
      onDocumentNavigation(paneId ? [paneId] : ["left", "right"]);
      setWorkspace((current) => removeDocumentFromWorkspace(current, document, paneId));
    },
    [onDocumentNavigation, setWorkspace],
  );

  const closePaneDocuments = useCallback(
    (paneId: DocumentPaneId, keepDocument: ActiveDocument | null = null): void => {
      onDocumentNavigation([paneId]);
      setWorkspace((current) => {
        const keepKey = keepDocument ? documentTabKey(keepDocument) : null;
        const documentsToClose = current.documents[paneId].filter(
          (document) => documentTabKey(document) !== keepKey,
        );
        return documentsToClose.reduce(
          (workspace, document) => removeDocumentFromWorkspace(workspace, document, paneId),
          current,
        );
      });
    },
    [onDocumentNavigation, setWorkspace],
  );

  const moveDocument = useCallback(
    (document: ActiveDocument, sourcePane: DocumentPaneId, targetPane: DocumentPaneId): void => {
      onDocumentNavigation([sourcePane, targetPane]);
      setWorkspace((current) => moveDocumentToPane(current, document, sourcePane, targetPane));
    },
    [onDocumentNavigation, setWorkspace],
  );

  const dropDocument = useCallback(
    (documentKey: string, sourcePane: DocumentPaneId, targetPane: DocumentPaneId): void => {
      onDocumentNavigation([sourcePane, targetPane]);
      setWorkspace((current) => {
        const document = current.documents[sourcePane].find(
          (candidate) => documentTabKey(candidate) === documentKey,
        );
        return document ? moveDocumentToPane(current, document, sourcePane, targetPane) : current;
      });
    },
    [onDocumentNavigation, setWorkspace],
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
