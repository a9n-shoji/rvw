import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ChangeKind } from "../../domain/models.js";
import { documentTabPresentation } from "../document-tab-presentation.js";
import {
  documentTabKey,
  documentTabPath,
  type ActiveDocument,
  type DocumentPaneId,
} from "../document-workspace.js";
import { FileEntryIcon } from "./FileIcon.js";
import { ChangeIcon } from "./FileTree.js";
import { WalkthroughIcon } from "./WalkthroughPanel.js";

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
      <path
        fill="currentColor"
        d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"
      />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
      <circle cx="3" cy="8" r="1.35" fill="currentColor" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
      <circle cx="13" cy="8" r="1.35" fill="currentColor" />
    </svg>
  );
}

export function DocumentTabs({
  paneId,
  documents,
  activeDocument,
  changeKindsByPath,
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
  changeKindsByPath: ReadonlyMap<string, ChangeKind>;
  onActivate: (document: ActiveDocument) => void;
  onClose: (document: ActiveDocument) => void;
  onCloseOthers: (document: ActiveDocument) => void;
  onCloseAll: () => void;
  onMove: (document: ActiveDocument, targetPane: DocumentPaneId) => void;
  onDropDocument: (documentKey: string, targetPane: DocumentPaneId) => void;
  onDragStartDocument: (documentKey: string) => void;
  onDragEndDocument: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuHostRef = useRef<HTMLDivElement>(null);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const activeKey = activeDocument ? documentTabKey(activeDocument) : null;
  const targetPane: DocumentPaneId = paneId === "left" ? "right" : "left";
  const targetPaneLabel = targetPane === "right" ? "右" : "左";
  const dropDocument = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const documentKey = event.dataTransfer.getData("application/x-rvw-document-tab");
    if (documentKey) onDropDocument(documentKey, paneId);
  };
  const activateAt = (index: number): void => {
    const document = documents[index];
    if (!document) return;
    const key = documentTabKey(document);
    onActivate(document);
    window.requestAnimationFrame(() => tabButtons.current.get(key)?.focus());
  };
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (documents.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % documents.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + documents.length) % documents.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = documents.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateAt(nextIndex);
  };
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)',
      ),
    ];
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  useEffect(() => {
    if (!activeKey) return;
    tabButtons.current.get(activeKey)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, documents.length]);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    menuHostRef.current
      ?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
      ?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!menuHostRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuToggleRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <div
      className="document-tabs-shell"
      data-pane={paneId}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={dropDocument}
    >
      <nav className="document-tabs" role="tablist" aria-label="開いている文書">
        {documents.map((document, index) => {
          const key = documentTabKey(document);
          const path = documentTabPath(document);
          const presentation = documentTabPresentation(document, documents);
          const changeKind =
            document.kind === "repository-file" ? changeKindsByPath.get(document.path) : undefined;
          return (
            <div
              className={`document-tab${key === activeKey ? " active" : ""}`}
              key={key}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-rvw-document-tab", key);
                onDragStartDocument(key);
              }}
              onDragEnd={onDragEndDocument}
            >
              <button
                ref={(element) => {
                  if (element) tabButtons.current.set(key, element);
                  else tabButtons.current.delete(key);
                }}
                className="document-tab-activate"
                role="tab"
                aria-selected={key === activeKey}
                aria-label={presentation.accessibleLabel}
                tabIndex={key === activeKey ? 0 : -1}
                onClick={() => onActivate(document)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <span className="document-tab-icon-group" aria-hidden="true">
                  {document.kind === "walkthrough" ? (
                    <WalkthroughIcon />
                  ) : (
                    <FileEntryIcon path={path} kind="file" />
                  )}
                  {changeKind && <ChangeIcon kind={changeKind} />}
                </span>
                <span className="document-tab-label" title={path}>
                  {presentation.displayLabel}
                </span>
              </button>
              <button
                className="document-tab-close"
                aria-label={`${presentation.accessibleLabel}を閉じる`}
                onClick={() => onClose(document)}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </nav>
      <div className="document-tabs-menu" ref={menuHostRef}>
        <button
          ref={menuToggleRef}
          className="document-tabs-menu-toggle"
          aria-label={`${paneId === "left" ? "左" : "右"}ペインの操作`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreIcon />
        </button>
        {menuOpen && (
          <div className="document-tabs-menu-popover" role="menu" onKeyDown={handleMenuKeyDown}>
            <button
              role="menuitem"
              disabled={!activeDocument}
              onClick={() => {
                if (activeDocument) onMove(activeDocument, targetPane);
                setMenuOpen(false);
              }}
            >
              選択中のタブを{targetPaneLabel}ペインへ移動
            </button>
            <div className="document-tabs-menu-separator" />
            <button
              role="menuitem"
              disabled={!activeDocument || documents.length <= 1}
              onClick={() => {
                if (activeDocument) onCloseOthers(activeDocument);
                setMenuOpen(false);
              }}
            >
              他のタブをすべて閉じる
            </button>
            <button
              role="menuitem"
              disabled={documents.length === 0}
              onClick={() => {
                onCloseAll();
                setMenuOpen(false);
              }}
            >
              このペインのタブをすべて閉じる
            </button>
            <div className="document-tabs-menu-separator" />
            {documents.length === 0 ? (
              <span>開いている文書はありません。</span>
            ) : (
              documents.map((document) => {
                const key = documentTabKey(document);
                const presentation = documentTabPresentation(document, documents);
                const changeKind =
                  document.kind === "repository-file"
                    ? changeKindsByPath.get(document.path)
                    : undefined;
                return (
                  <button
                    key={key}
                    role="menuitem"
                    aria-label={presentation.accessibleLabel}
                    className={key === activeKey ? "active" : ""}
                    onClick={() => {
                      onActivate(document);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="document-tab-icon-group" aria-hidden="true">
                      {document.kind === "walkthrough" ? (
                        <WalkthroughIcon />
                      ) : (
                        <FileEntryIcon path={documentTabPath(document)} kind="file" />
                      )}
                      {changeKind && <ChangeIcon kind={changeKind} />}
                    </span>
                    <span className="document-tabs-menu-label">{presentation.accessibleLabel}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
