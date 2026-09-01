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
import { api, type FileStructureReferenceIndexResponse } from "../api.js";
import { StructureIcon } from "./WalkthroughPanel.js";

type RepositoryFileRef = Extract<DocumentRef, { kind: "repository-file" }>;

export function FileStructureReferencesButton({
  pullRequestId,
  fileRef,
  structureFingerprint,
  structuresLoaded,
  onSelect,
}: {
  pullRequestId: string;
  fileRef: RepositoryFileRef | null;
  structureFingerprint: string;
  structuresLoaded: boolean;
  onSelect: (reference: FileStructureReference) => void;
}) {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const hostRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuHadFocusRef = useRef(false);
  const focusedStructureIdRef = useRef<string | null>(null);
  const previousReferenceIdsRef = useRef<string[]>([]);
  const query = useQuery({
    queryKey: [
      "structure-reference-index",
      pullRequestId,
      fileRef?.sourceOid,
      structureFingerprint,
    ],
    queryFn: async () => {
      const search = new URLSearchParams({
        sourceOid: fileRef!.sourceOid,
      });
      return await api<FileStructureReferenceIndexResponse>(
        `/api/pull-requests/${pullRequestId}/structure-reference-index?${search.toString()}`,
      );
    },
    enabled: fileRef !== null && structuresLoaded,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previousData) =>
      previousData?.index.sourceOid === fileRef?.sourceOid ? previousData : undefined,
  });
  const references =
    query.data?.index.entries.find(({ path }) => path === fileRef?.path)?.references ?? [];
  const initialLoading = fileRef !== null && query.isPending;
  const refreshing = fileRef !== null && query.isFetching && query.data !== undefined;
  const initialFailed = fileRef !== null && query.isLoadingError;
  const refreshFailed = fileRef !== null && query.isRefetchError;
  const failed = initialFailed || refreshFailed;
  const available = !initialLoading && references.length > 0;
  const unavailable = initialLoading || (!failed && !available);
  const referenceIdentity = references.map((reference) => reference.structure.id).join("\u0000");

  useEffect(() => {
    menuHadFocusRef.current = false;
    focusedStructureIdRef.current = null;
    previousReferenceIdsRef.current = [];
    setOpen(false);
  }, [fileRef?.path, fileRef?.sourceOid]);
  useEffect(() => {
    if (!open || (!initialLoading && !initialFailed && references.length > 0)) return;
    const restoreFocus = menuHadFocusRef.current;
    menuHadFocusRef.current = false;
    focusedStructureIdRef.current = null;
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, [initialFailed, initialLoading, open, references.length]);

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

  useLayoutEffect(() => {
    const previousIds = previousReferenceIdsRef.current;
    const currentIds = references.map((reference) => reference.structure.id);
    previousReferenceIdsRef.current = currentIds;
    if (!open || currentIds.length === 0 || !menuHadFocusRef.current) return;
    const menu = menuRef.current;
    if (!menu || menu.contains(document.activeElement)) return;

    const focusedId = focusedStructureIdRef.current;
    const focusedIndex = focusedId === null ? -1 : previousIds.indexOf(focusedId);
    const fallbackIndex = focusedIndex < 0 ? 0 : Math.min(focusedIndex, currentIds.length - 1);
    const targetId =
      focusedId !== null && currentIds.includes(focusedId) ? focusedId : currentIds[fallbackIndex]!;
    const target = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.dataset.structureId === targetId,
    );
    target?.focus();
  }, [open, referenceIdentity, references]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (hostRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      menuHadFocusRef.current = false;
      focusedStructureIdRef.current = null;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      menuHadFocusRef.current = false;
      focusedStructureIdRef.current = null;
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

  const title = initialLoading
    ? "このファイルのStructure参照を確認しています"
    : initialFailed
      ? "Structure参照の取得に失敗しました。再試行"
      : refreshFailed
        ? "Structure参照を更新できませんでした。再試行"
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
        aria-busy={initialLoading || refreshing || undefined}
        aria-disabled={unavailable || undefined}
        onClick={() => {
          if (unavailable) return;
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
            onFocusCapture={() => {
              menuHadFocusRef.current = true;
            }}
            onBlurCapture={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                !event.currentTarget.contains(event.relatedTarget)
              ) {
                menuHadFocusRef.current = false;
              }
            }}
          >
            {references.map((reference) => {
              const additionalMatches = reference.matchingNodeCount - 1;
              return (
                <button
                  key={reference.structure.id}
                  type="button"
                  role="menuitem"
                  data-structure-id={reference.structure.id}
                  onFocus={() => {
                    focusedStructureIdRef.current = reference.structure.id;
                  }}
                  onClick={() => {
                    menuHadFocusRef.current = false;
                    focusedStructureIdRef.current = null;
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
