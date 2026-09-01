import { useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { DocumentRef, FileStructureReference } from "../../domain/models.js";
import { api, type FileStructureReferencesResponse } from "../api.js";
import { StructureIcon } from "./WalkthroughPanel.js";

type RepositoryFileRef = Extract<DocumentRef, { kind: "repository-file" }>;

export function FileStructureReferencesButton({
  pullRequestId,
  fileRef,
  onSelect,
}: {
  pullRequestId: string;
  fileRef: RepositoryFileRef | null;
  onSelect: (reference: FileStructureReference) => void;
}) {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const hostRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ["structure-references", pullRequestId, fileRef?.sourceOid, fileRef?.path],
    queryFn: async () => {
      const search = new URLSearchParams({
        sourceOid: fileRef!.sourceOid,
        path: fileRef!.path,
      });
      return await api<FileStructureReferencesResponse>(
        `/api/pull-requests/${pullRequestId}/structure-references?${search.toString()}`,
      );
    },
    enabled: fileRef !== null,
    retry: false,
  });
  const references = query.data?.references ?? [];
  const loading = fileRef !== null && (query.isPending || query.isFetching);
  const failed = fileRef !== null && query.isError;
  const available = !loading && !failed && references.length > 0;

  useEffect(() => setOpen(false), [fileRef?.path, fileRef?.sourceOid]);
  useEffect(() => {
    if (loading || failed || references.length === 0) setOpen(false);
  }, [failed, loading, references.length]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = (): void => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rectangle = trigger.getBoundingClientRect();
      setPopoverStyle({
        top: rectangle.bottom + 6,
        right: Math.max(8, window.innerWidth - rectangle.right),
      });
    };
    updatePosition();
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (hostRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
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

  const title = loading
    ? "このファイルのStructure参照を確認しています"
    : failed
      ? "Structure参照の取得に失敗しました。再試行"
      : references.length === 0
        ? "このレビュー版では、このファイルをNodeから参照するStructureはありません"
        : `このファイルを参照するStructure ${references.length}件`;

  return (
    <div className="file-structure-references" ref={hostRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`comment-icon-button file-structure-references-trigger${failed ? " is-error" : ""}`}
        aria-label={title}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={loading || undefined}
        disabled={!failed && !available}
        onClick={() => {
          if (failed) {
            void query.refetch();
            return;
          }
          setOpen((current) => !current);
        }}
      >
        <StructureIcon />
      </button>
      {failed && (
        <span className="file-structure-references-error-badge" aria-hidden="true">
          !
        </span>
      )}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="file-structure-references-popover"
            role="menu"
            aria-label="このファイルを参照するStructure"
            style={popoverStyle}
            onKeyDown={handleMenuKeyDown}
          >
            {references.map((reference) => {
              const additionalMatches = reference.matchingNodeCount - 1;
              return (
                <button
                  key={reference.structure.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onSelect(reference);
                  }}
                >
                  <strong>{reference.structure.title}</strong>
                  <span>
                    Node: {reference.targetNodeLabel}
                    {additionalMatches > 0 && (
                      <span className="file-structure-references-additional">
                        +{additionalMatches}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
