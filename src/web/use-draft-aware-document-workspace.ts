import { useCallback, useState } from "react";
import { moveCommentDraftsForWorkspaceTransition } from "./comment-draft-store.js";
import {
  assignDocumentToPane,
  documentPaneTransitions,
  documentTabKey,
  moveDocumentToPane,
  preferredDocumentPane,
  removeDocumentFromWorkspace,
  type ActiveDocument,
  type DocumentPaneId,
  type DocumentWorkspaceState,
} from "./document-workspace.js";
import { useDocumentWorkspace } from "./use-document-workspace.js";

type DocumentWorkspaceUpdate =
  DocumentWorkspaceState | ((current: DocumentWorkspaceState) => DocumentWorkspaceState);

export const commentDraftTransitionConflictMessage =
  "移動先にも入力中のコメントまたは返信があります。どちらかを送信または消去してから移動してください。";
export const commentDraftReplacementConflictMessage =
  "このタブには入力中のコメントがあります。送信または消去してから別のsourceへ切り替えてください。";

export function useDraftAwareDocumentWorkspace({
  reviewId,
  onDocumentNavigation,
  onDraftConflict,
  initialDocument,
}: {
  reviewId: string | null;
  onDocumentNavigation: (paneIds: readonly DocumentPaneId[]) => void;
  onDraftConflict: (message: string) => void;
  initialDocument?: ActiveDocument | null;
}) {
  const {
    workspace,
    workspaceRef,
    setWorkspace: setBaseWorkspace,
    activateDocument,
  } = useDocumentWorkspace(onDocumentNavigation, initialDocument);
  const [draftWorkspaceRevision, setDraftWorkspaceRevision] = useState(0);

  const applyWorkspaceTransition = useCallback(
    (
      nextWorkspace: DocumentWorkspaceState,
      navigationPanes: readonly DocumentPaneId[] = [],
      beforeCommit?: () => void,
    ): boolean => {
      const previousWorkspace = workspaceRef.current;
      if (nextWorkspace === previousWorkspace) return true;
      const paneTransitions = documentPaneTransitions(previousWorkspace, nextWorkspace);
      if (reviewId) {
        const result = moveCommentDraftsForWorkspaceTransition(
          reviewId,
          previousWorkspace,
          nextWorkspace,
        );
        if (result.status === "conflict") {
          onDraftConflict(
            result.reason === "document-replacement"
              ? commentDraftReplacementConflictMessage
              : commentDraftTransitionConflictMessage,
          );
          return false;
        }
        if (result.commentDraftsMoved) setDraftWorkspaceRevision((revision) => revision + 1);
      }
      beforeCommit?.();
      onDocumentNavigation([
        ...new Set([
          ...navigationPanes,
          ...paneTransitions.flatMap(({ sourcePane, targetPane }) => [sourcePane, targetPane]),
        ]),
      ]);
      workspaceRef.current = nextWorkspace;
      setBaseWorkspace(() => nextWorkspace);
      return true;
    },
    [onDocumentNavigation, onDraftConflict, reviewId, setBaseWorkspace, workspaceRef],
  );

  const setWorkspace = useCallback(
    (update: DocumentWorkspaceUpdate): void => {
      const current = workspaceRef.current;
      const next = typeof update === "function" ? update(current) : update;
      applyWorkspaceTransition(next);
    },
    [applyWorkspaceTransition, workspaceRef],
  );

  const openDocument = useCallback(
    (document: ActiveDocument, targetPane?: DocumentPaneId, beforeCommit?: () => void): boolean => {
      const current = workspaceRef.current;
      const resolvedPane = targetPane ?? preferredDocumentPane(current, document);
      return applyWorkspaceTransition(
        assignDocumentToPane(current, document, resolvedPane),
        [resolvedPane],
        beforeCommit,
      );
    },
    [applyWorkspaceTransition, workspaceRef],
  );

  const closeDocument = useCallback(
    (document: ActiveDocument, paneId?: DocumentPaneId): void => {
      const current = workspaceRef.current;
      applyWorkspaceTransition(
        removeDocumentFromWorkspace(current, document, paneId),
        paneId ? [paneId] : ["left", "right"],
      );
    },
    [applyWorkspaceTransition, workspaceRef],
  );

  const closePaneDocuments = useCallback(
    (paneId: DocumentPaneId, keepDocument: ActiveDocument | null = null): void => {
      const current = workspaceRef.current;
      const keepKey = keepDocument ? documentTabKey(keepDocument) : null;
      const nextWorkspace = current.documents[paneId]
        .filter((document) => documentTabKey(document) !== keepKey)
        .reduce((next, document) => removeDocumentFromWorkspace(next, document, paneId), current);
      applyWorkspaceTransition(nextWorkspace, [paneId]);
    },
    [applyWorkspaceTransition, workspaceRef],
  );

  const moveDocument = useCallback(
    (document: ActiveDocument, sourcePane: DocumentPaneId, targetPane: DocumentPaneId): void => {
      const current = workspaceRef.current;
      const nextWorkspace = moveDocumentToPane(current, document, sourcePane, targetPane);
      if (nextWorkspace === current) return;
      applyWorkspaceTransition(nextWorkspace, [sourcePane, targetPane]);
    },
    [applyWorkspaceTransition, workspaceRef],
  );

  const dropDocument = useCallback(
    (documentKey: string, sourcePane: DocumentPaneId, targetPane: DocumentPaneId): void => {
      const document = workspaceRef.current.documents[sourcePane].find(
        (candidate) => documentTabKey(candidate) === documentKey,
      );
      if (document) moveDocument(document, sourcePane, targetPane);
    },
    [moveDocument, workspaceRef],
  );

  return {
    workspace,
    workspaceRef,
    activateDocument,
    openDocument,
    setWorkspace,
    closeDocument,
    closePaneDocuments,
    moveDocument,
    dropDocument,
    applyWorkspaceTransition,
    draftWorkspaceRevision,
  };
}
