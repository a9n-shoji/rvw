import type { ReactNode } from "react";
import type { ChangeKind } from "../../domain/models.js";
import type { ActiveDocument, DocumentPaneId } from "../document-workspace.js";
import { DocumentTabs } from "./DocumentTabs.js";

export function ReviewDocumentPane({
  paneId,
  documents,
  activeDocument,
  focusedPane,
  changeKindsByPath,
  draggedDocumentKey,
  content,
  emptyHint,
  onPaneRef,
  onScroll,
  onFocus,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onMove,
  onDropDocument,
  onDragStartDocument,
  onDragEndDocument,
}: {
  paneId: DocumentPaneId;
  documents: ActiveDocument[];
  activeDocument: ActiveDocument | null;
  focusedPane: DocumentPaneId;
  changeKindsByPath: ReadonlyMap<string, ChangeKind>;
  draggedDocumentKey: string | null;
  content: ReactNode | null;
  emptyHint?: ReactNode;
  onPaneRef: (element: HTMLElement | null) => void;
  onScroll: (scrollTop: number) => void;
  onFocus: () => void;
  onActivate: (document: ActiveDocument) => void;
  onClose: (document: ActiveDocument) => void;
  onCloseOthers: (document: ActiveDocument) => void;
  onCloseAll: () => void;
  onMove: (document: ActiveDocument, targetPane: DocumentPaneId) => void;
  onDropDocument: (
    documentKey: string,
    sourcePane: DocumentPaneId,
    targetPane: DocumentPaneId,
  ) => void;
  onDragStartDocument: (documentKey: string) => void;
  onDragEndDocument: () => void;
}) {
  return (
    <section
      ref={onPaneRef}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      className={`document-pane${focusedPane === paneId ? " active" : ""}${documents.length === 0 ? " empty" : ""}`}
      data-pane={paneId}
      aria-label={`${paneId === "left" ? "左" : "右"}の文書ペイン`}
      onPointerDown={onFocus}
    >
      <DocumentTabs
        paneId={paneId}
        documents={documents}
        activeDocument={activeDocument}
        changeKindsByPath={changeKindsByPath}
        onActivate={onActivate}
        onClose={onClose}
        onCloseOthers={onCloseOthers}
        onCloseAll={onCloseAll}
        onMove={onMove}
        onDropDocument={onDropDocument}
        onDragStartDocument={onDragStartDocument}
        onDragEndDocument={onDragEndDocument}
      />
      {content ?? (
        <div className="empty-document-viewer document-pane-drop-target">
          <strong>
            {draggedDocumentKey ? "ここへドロップ" : `${paneId === "left" ? "左" : "右"}ペイン`}
          </strong>
          <span>{emptyHint ?? "タブを移動するか、Cmd/Ctrl+クリックで文書を開けます。"}</span>
        </div>
      )}
    </section>
  );
}
