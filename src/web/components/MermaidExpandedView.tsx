import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { CodeReference, DocumentContent } from "../../domain/models.js";
import { api, documentUrl, type DocumentResponse } from "../api.js";
import type { ThemePreference } from "../theme.js";
import { FileEntryIcon } from "./FileIcon.js";
import { MermaidSurface } from "./MermaidSurface.js";

export type MermaidCodeReferenceOpen = (
  sourceOid: string,
  reference: CodeReference,
  openInRightPane: boolean,
) => Promise<string | null>;

export interface MermaidReferencePeekResolution {
  sourceOid: string;
  reference: CodeReference;
  document: DocumentContent;
}

export interface MermaidReviewWorkspace {
  pullRequestId: string;
  commentCount: number;
  renderComments: (onOpenCodeReference: MermaidCodeReferenceOpen) => ReactNode;
  onOpenCodeReference: MermaidCodeReferenceOpen;
  diagramReferenceBindings?: {
    sourceOid: string;
    onRendered: (container: HTMLDivElement) => void;
    referenceFromTarget: (target: EventTarget | null) => CodeReference | undefined;
    resolveForPeek?: (reference: CodeReference) => Promise<MermaidReferencePeekResolution>;
    onOpenInReview: (reference: CodeReference, openInRightPane: boolean) => void;
  };
}

interface DiagramSize {
  width: number;
  height: number;
}

interface ReferencePeek {
  sourceOid: string;
  reference: CodeReference;
  resolveForPeek?: (reference: CodeReference) => Promise<MermaidReferencePeekResolution>;
  onOpenInReview?: (reference: CodeReference, openInRightPane: boolean) => void;
}

const zoomLevels = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const referenceContextLines = 4;
const defaultRailWidth = 380;
const minRailWidth = 300;
const maxRailWidth = 640;
const minCanvasWidth = 360;
const railResizeHandleWidth = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function availableRailMaxWidth(workspaceWidth: number): number {
  return Math.max(
    minRailWidth,
    Math.min(maxRailWidth, workspaceWidth - minCanvasWidth - railResizeHandleWidth),
  );
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden && element.getClientRects().length > 0);
}

function diagramSize(container: HTMLDivElement): DiagramSize | null {
  const svg = container.querySelector<SVGSVGElement>("svg");
  if (!svg) return null;
  const viewBox = svg.viewBox.baseVal;
  if (viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height };
  }
  const width = svg.width.baseVal.value;
  const height = svg.height.baseVal.value;
  return width > 0 && height > 0 ? { width, height } : null;
}

function referenceLines(document: DocumentContent | undefined, reference: CodeReference) {
  if (document?.availability !== "available" || document.text === null) return null;
  const lines = document.text.split("\n");
  const referencedStart = reference.startLine ?? 1;
  const referencedEnd =
    reference.startLine === null
      ? Math.min(lines.length, 32)
      : (reference.endLine ?? reference.startLine);
  const start = Math.max(1, referencedStart - referenceContextLines);
  const end = Math.min(lines.length, referencedEnd + referenceContextLines);
  return {
    start,
    end,
    referencedStart,
    referencedEnd,
    lines: lines.slice(start - 1, end),
  };
}

function ZoomOutIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3 8h10M8 3v10" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function CommentRailIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M2.25 3.5A1.25 1.25 0 0 1 3.5 2.25h9A1.25 1.25 0 0 1 13.75 3.5v6A1.25 1.25 0 0 1 12.5 10.75H7l-3.25 2.5v-2.5H3.5A1.25 1.25 0 0 1 2.25 9.5v-6Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m3.5 3.5 9 9m0-9-9 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ReferencePeekPanel({
  peek,
  document,
  loading,
  error,
  onBack,
  onOpenInReview,
}: {
  peek: ReferencePeek;
  document: DocumentContent | undefined;
  loading: boolean;
  error: Error | null;
  onBack: () => void;
  onOpenInReview: (openInRightPane: boolean) => void;
}) {
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const excerpt = useMemo(
    () => referenceLines(document, peek.reference),
    [document, peek.reference],
  );
  const normalizedEndLine =
    peek.reference.startLine === null ? null : (peek.reference.endLine ?? peek.reference.startLine);
  const lineLabel =
    peek.reference.startLine === null
      ? "File"
      : peek.reference.startLine === normalizedEndLine
        ? `L${peek.reference.startLine}`
        : `L${peek.reference.startLine}–L${normalizedEndLine}`;
  useEffect(() => {
    backButtonRef.current?.focus();
  }, []);
  return (
    <div className="mermaid-reference-peek">
      <header>
        <button ref={backButtonRef} className="button--back" onClick={onBack}>
          ← Comments
        </button>
        <div className="mermaid-reference-location">
          <FileEntryIcon path={peek.reference.path} kind="file" />
          <span>
            <strong title={peek.reference.path}>{peek.reference.path}</strong>
            <small>{lineLabel}</small>
          </span>
        </div>
      </header>
      <div className="mermaid-reference-source">
        {loading ? (
          <p role="status">参照先を読み込んでいます…</p>
        ) : error ? (
          <p className="form-error" role="alert">
            {error.message}
          </p>
        ) : document?.availability !== "available" ? (
          <p role="status">この参照先はテキストとして表示できません。</p>
        ) : excerpt ? (
          <HighlightedReferenceExcerpt
            excerpt={excerpt}
            path={peek.reference.path}
            lineLabel={lineLabel}
          />
        ) : null}
      </div>
      <footer>
        <button
          title="Cmd/Ctrl+clickで右ペインに開く"
          onClick={(event) => onOpenInReview(event.metaKey || event.ctrlKey)}
        >
          Open in review
        </button>
      </footer>
    </div>
  );
}

function PlainReferenceExcerpt({
  excerpt,
  label,
}: {
  excerpt: NonNullable<ReturnType<typeof referenceLines>>;
  label: string;
}) {
  return (
    <pre aria-label={label} data-syntax-highlighted="false">
      {excerpt.lines.map((line, index) => {
        const lineNumber = excerpt.start + index;
        const referenced =
          lineNumber >= excerpt.referencedStart && lineNumber <= excerpt.referencedEnd;
        return (
          <span
            className={referenced ? "is-referenced" : undefined}
            data-line={lineNumber}
            key={lineNumber}
          >
            <span aria-hidden="true">{lineNumber}</span>
            <code>{line || " "}</code>
          </span>
        );
      })}
    </pre>
  );
}

function HighlightedReferenceExcerpt({
  excerpt,
  path,
  lineLabel,
}: {
  excerpt: NonNullable<ReturnType<typeof referenceLines>>;
  path: string;
  lineLabel: string;
}) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const label = `${path} ${lineLabel} のソース抜粋`;
  useEffect(() => {
    let active = true;
    setHighlightedHtml(null);
    const highlight = async (): Promise<void> => {
      const { getFiletypeFromFileName, getSharedHighlighter } = await import("@pierre/diffs");
      const lang = getFiletypeFromFileName(path);
      const highlighter = await getSharedHighlighter({
        langs: [lang],
        themes: ["github-light", "github-dark"],
      });
      const html = highlighter.codeToHtml(excerpt.lines.join("\n"), {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        transformers: [
          {
            line(node, line) {
              const lineNumber = excerpt.start + line - 1;
              this.addClassToHast(node, "mermaid-reference-code-line");
              if (lineNumber >= excerpt.referencedStart && lineNumber <= excerpt.referencedEnd) {
                this.addClassToHast(node, "is-referenced");
              }
              node.properties["data-line"] = lineNumber;
            },
          },
        ],
      });
      if (active) setHighlightedHtml(html);
    };
    void highlight().catch((error: unknown) => {
      console.error("Reference peekのsyntax highlightingに失敗しました。", error);
    });
    return () => {
      active = false;
    };
  }, [excerpt, path]);

  return highlightedHtml === null ? (
    <PlainReferenceExcerpt excerpt={excerpt} label={label} />
  ) : (
    <div
      className="mermaid-reference-highlight"
      aria-label={label}
      data-syntax-highlighted="true"
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
    />
  );
}

export function MermaidExpandedView({
  source,
  themePreference,
  renderIdPrefix,
  review,
  onClose,
}: {
  source: string;
  themePreference: ThemePreference;
  renderIdPrefix: string;
  review?: MermaidReviewWorkspace | undefined;
  onClose: () => void;
}) {
  const titleId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const commentsButtonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const referenceRef = useRef<ReferencePeek | null>(null);
  const diagramReferenceBindingsRef = useRef(review?.diagramReferenceBindings);
  closeRef.current = onClose;
  diagramReferenceBindingsRef.current = review?.diagramReferenceBindings;
  const [railOpen, setRailOpen] = useState(false);
  const [railWidth, setRailWidth] = useState(defaultRailWidth);
  const [resizingRail, setResizingRail] = useState(false);
  const [reference, setReference] = useState<ReferencePeek | null>(null);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [naturalSize, setNaturalSize] = useState<DiagramSize | null>(null);
  const [canvasSize, setCanvasSize] = useState<DiagramSize>({ width: 0, height: 0 });
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  referenceRef.current = reference;

  useEffect(() => {
    const backdrop = backdropRef.current;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const background = Array.from(document.body.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop,
    );
    const backgroundState = background.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of background) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      for (const state of backgroundState) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateSize = (): void =>
      setCanvasSize({ width: canvas.clientWidth, height: canvas.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const updateSize = (): void => setWorkspaceWidth(workspace.clientWidth);
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const availableRailMax =
    workspaceWidth > 0 ? availableRailMaxWidth(workspaceWidth) : maxRailWidth;
  useEffect(() => {
    setRailWidth((width) => clamp(width, minRailWidth, availableRailMax));
  }, [availableRailMax]);

  const fitScale = naturalSize
    ? Math.min(
        1,
        Math.max(0.05, (canvasSize.width - 48) / naturalSize.width),
        Math.max(0.05, (canvasSize.height - 48) / naturalSize.height),
      )
    : 1;
  const effectiveScale = zoom === "fit" ? fitScale : zoom;
  const zoomOut = zoomLevels.filter((level) => level < effectiveScale - 0.001).at(-1);
  const zoomIn = zoomLevels.find((level) => level > effectiveScale + 0.001);
  const canReturnToFitOnZoomOut =
    zoom !== "fit" && zoomOut === undefined && fitScale < effectiveScale - 0.001;
  const renderedWidth = naturalSize ? naturalSize.width * effectiveScale : undefined;
  const renderedHeight = naturalSize ? naturalSize.height * effectiveScale : undefined;
  const prepareExpandedSvg = useCallback((container: HTMLDivElement): void => {
    setNaturalSize(diagramSize(container));
    diagramReferenceBindingsRef.current?.onRendered(container);
  }, []);
  const updateRailWidth = useCallback((clientX: number): void => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    const availableMax = availableRailMaxWidth(bounds.width);
    setRailWidth(clamp(bounds.right - clientX, minRailWidth, availableMax));
  }, []);
  const referenceQuery = useQuery({
    queryKey: [
      "mermaid-reference-peek",
      review?.pullRequestId,
      reference?.sourceOid,
      reference?.reference.id,
      reference?.reference.path,
      reference?.reference.startLine,
      reference?.reference.endLine,
      Boolean(reference?.resolveForPeek),
    ],
    queryFn: async (): Promise<MermaidReferencePeekResolution> => {
      if (!reference || !review) throw new Error("参照先がありません。");
      if (reference.resolveForPeek) {
        return await reference.resolveForPeek(reference.reference);
      }
      const referenceDocument = {
        kind: "repository-file",
        pullRequestId: review.pullRequestId,
        sourceOid: reference.sourceOid,
        path: reference.reference.path,
      } as const;
      const { document } = await api<DocumentResponse>(documentUrl(referenceDocument));
      return {
        sourceOid: reference.sourceOid,
        reference: reference.reference,
        document,
      };
    },
    enabled: reference !== null && Boolean(review),
    staleTime: reference?.resolveForPeek ? 0 : Number.POSITIVE_INFINITY,
  });
  const displayedReference =
    reference && referenceQuery.data
      ? {
          ...reference,
          sourceOid: referenceQuery.data.sourceOid,
          reference: referenceQuery.data.reference,
        }
      : reference;
  const openReference: MermaidCodeReferenceOpen = useCallback((sourceOid, codeReference) => {
    setRailOpen(true);
    setReference({ sourceOid, reference: codeReference });
    return Promise.resolve(null);
  }, []);
  const openDiagramReference = useCallback((target: EventTarget | null): boolean => {
    const bindings = diagramReferenceBindingsRef.current;
    const codeReference = bindings?.referenceFromTarget(target);
    if (!bindings || !codeReference) return false;
    setRailOpen(true);
    setReference({
      sourceOid: bindings.sourceOid,
      reference: codeReference,
      ...(bindings.resolveForPeek ? { resolveForPeek: bindings.resolveForPeek } : {}),
      onOpenInReview: bindings.onOpenInReview,
    });
    return true;
  }, []);
  const showComments = useCallback((): void => {
    setReference(null);
    window.requestAnimationFrame(() => commentsButtonRef.current?.focus());
  }, []);
  useEffect(() => {
    const handleDocumentKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        event.defaultPrevented ||
        dialogRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (referenceRef.current) showComments();
      else closeRef.current();
    };
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown);
  }, [showComments]);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === "Tab") {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key !== "Escape" || event.nativeEvent.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (referenceRef.current) {
      showComments();
      return;
    }
    closeRef.current();
  };

  return createPortal(
    <div className="mermaid-expanded-backdrop" ref={backdropRef}>
      <section
        className={`mermaid-expanded-view${railOpen && review ? " has-rail" : ""}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="mermaid-expanded-toolbar">
          <strong id={titleId}>Mermaid diagram</strong>
          <div className="mermaid-expanded-actions">
            <div className="mermaid-zoom-controls" aria-label="Diagram zoom">
              <button
                aria-label="Zoom out"
                title="Zoom out"
                disabled={zoomOut === undefined && !canReturnToFitOnZoomOut}
                onClick={() =>
                  zoomOut !== undefined
                    ? setZoom(zoomOut)
                    : canReturnToFitOnZoomOut
                      ? setZoom("fit")
                      : undefined
                }
              >
                <ZoomOutIcon />
              </button>
              <button
                className={zoom === "fit" ? "active" : ""}
                aria-pressed={zoom === "fit"}
                title="Fit diagram"
                onClick={() => setZoom("fit")}
              >
                Fit
              </button>
              <button
                aria-label="Zoom in"
                title="Zoom in"
                disabled={zoomIn === undefined}
                onClick={() => zoomIn !== undefined && setZoom(zoomIn)}
              >
                <ZoomInIcon />
              </button>
            </div>
            {review && (
              <button
                ref={commentsButtonRef}
                className="mermaid-comments-toggle"
                aria-pressed={railOpen}
                title={railOpen ? "Commentsを閉じる" : "Commentsを開く"}
                onClick={() => {
                  setRailOpen((open) => !open);
                  setReference(null);
                }}
              >
                <CommentRailIcon />
                Comments
                {review.commentCount > 0 && <span>{review.commentCount}</span>}
              </button>
            )}
            <button
              ref={closeButtonRef}
              className="mermaid-expanded-close"
              aria-label="Expanded Mermaid viewを閉じる"
              title="Close (Escape)"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </header>
        <div
          className={`mermaid-expanded-workspace${resizingRail ? " is-resizing" : ""}`}
          ref={workspaceRef}
          style={{ "--mermaid-review-rail-width": `${railWidth}px` } as CSSProperties}
        >
          <div
            className="mermaid-expanded-canvas"
            ref={canvasRef}
            role="region"
            aria-label="Mermaid diagram canvas"
            tabIndex={0}
            data-zoom-mode={zoom === "fit" ? "fit" : "manual"}
            data-zoom={effectiveScale.toFixed(3)}
          >
            <div className="mermaid-expanded-stage">
              <MermaidSurface
                className="mermaid-expanded-diagram"
                role={review?.diagramReferenceBindings ? "group" : "img"}
                aria-label="Expanded Mermaid diagram"
                source={source}
                themePreference={themePreference}
                renderIdPrefix={`${renderIdPrefix}Expanded`}
                errorClassName="mermaid-expanded-error"
                onRendered={prepareExpandedSvg}
                onPointerDown={(event) => {
                  if (event.button !== 0 || !openDiagramReference(event.target)) return;
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onKeyDown={(event) => {
                  if (
                    (event.key !== "Enter" && event.key !== " ") ||
                    !openDiagramReference(event.target)
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                }}
                style={{
                  ...(renderedWidth === undefined ? {} : { width: renderedWidth }),
                  ...(renderedHeight === undefined ? {} : { height: renderedHeight }),
                }}
              />
            </div>
          </div>
          {railOpen && review && (
            <>
              <div
                className={`horizontal-resize-handle mermaid-rail-resize-handle${resizingRail ? " active" : ""}`}
                role="separator"
                aria-label="Comments railの幅を変更"
                aria-orientation="vertical"
                aria-valuemin={minRailWidth}
                aria-valuemax={Math.round(availableRailMax)}
                aria-valuenow={Math.round(railWidth)}
                tabIndex={0}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setResizingRail(true);
                  updateRailWidth(event.clientX);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  updateRailWidth(event.clientX);
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  setResizingRail(false);
                }}
                onPointerCancel={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  setResizingRail(false);
                }}
                onLostPointerCapture={() => setResizingRail(false)}
                onDoubleClick={() =>
                  setRailWidth(clamp(defaultRailWidth, minRailWidth, availableRailMax))
                }
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  setRailWidth((width) =>
                    clamp(
                      width + (event.key === "ArrowLeft" ? 16 : -16),
                      minRailWidth,
                      availableRailMax,
                    ),
                  );
                }}
              />
              <aside className="mermaid-review-rail" aria-label="Diagram review">
                {reference && displayedReference ? (
                  <ReferencePeekPanel
                    peek={displayedReference}
                    document={referenceQuery.data?.document}
                    loading={referenceQuery.isLoading}
                    error={referenceQuery.error}
                    onBack={showComments}
                    onOpenInReview={(openInRightPane) => {
                      const current = reference;
                      onClose();
                      if (current.onOpenInReview) {
                        current.onOpenInReview(current.reference, openInRightPane);
                      } else {
                        void review.onOpenCodeReference(
                          current.sourceOid,
                          current.reference,
                          openInRightPane,
                        );
                      }
                    }}
                  />
                ) : (
                  <div className="mermaid-comments-mode">
                    <header>
                      <strong>Comments</strong>
                      <span>{review.commentCount}</span>
                    </header>
                    <div className="mermaid-comments-scroll">
                      {review.renderComments(openReference)}
                    </div>
                  </div>
                )}
              </aside>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
