import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MarkdownSourceRange } from "./markdown-source-map.js";
import { CommentIcon } from "./components/CommentComposer.js";

export interface HtmlPreviewOverlayAction {
  range: MarkdownSourceRange;
  left: number;
  top: number;
  label: string;
  composerTop?: number | undefined;
  onPreview?: () => void;
  onPreviewEnd?: () => void;
}

export interface HtmlPreviewOverlayMarker {
  id: string;
  left: number;
  top: number;
  active: boolean;
  label: string;
}

export function HtmlPreviewOverlay({
  action,
  markers,
  composer,
  composerAnchor,
  onComment,
  onActivateComment,
  renderCommentThread,
}: {
  action: HtmlPreviewOverlayAction | null;
  markers: HtmlPreviewOverlayMarker[];
  composer: ReactNode;
  composerAnchor: HtmlPreviewOverlayAction | null;
  onComment: (action: HtmlPreviewOverlayAction) => void;
  onActivateComment: (commentId: string) => void;
  renderCommentThread: (commentId: string) => ReactNode;
}) {
  const [openCommentId, setOpenCommentId] = useState<string | null>(null);
  const threadId = useId();
  const threadRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const openMarker = markers.find((marker) => marker.id === openCommentId);
  const visibleCommentId = openMarker?.id ?? null;
  const closeThread = (): void => {
    const marker = overlayRef.current?.querySelector<HTMLButtonElement>(
      `[data-html-comment-id="${CSS.escape(openCommentId ?? "")}"]`,
    );
    setOpenCommentId(null);
    marker?.focus();
  };
  useLayoutEffect(() => {
    if (!visibleCommentId) return;
    threadRef.current?.focus({ preventScroll: true });
    threadRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [visibleCommentId]);
  const composerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!composer) return;
    const frame = window.requestAnimationFrame(() => {
      composerRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [composer]);
  return (
    <div
      ref={overlayRef}
      className="walkthrough-html-overlay"
      aria-hidden={action === null && markers.length === 0 && !composer}
    >
      {markers.map((marker) => (
        <button
          key={marker.id}
          className={`walkthrough-html-marker${marker.active ? " is-active" : ""}`}
          style={{ left: marker.left, top: marker.top }}
          aria-label={marker.label}
          title={marker.label}
          data-html-comment-id={marker.id}
          aria-expanded={openCommentId === marker.id}
          aria-controls={openCommentId === marker.id ? threadId : undefined}
          onClick={() => {
            if (openCommentId === marker.id) {
              closeThread();
            } else {
              setOpenCommentId(marker.id);
              onActivateComment(marker.id);
            }
          }}
        >
          <CommentIcon />
        </button>
      ))}
      {openMarker && (
        <div
          ref={threadRef}
          id={threadId}
          role="dialog"
          aria-label="HTML上のコメント"
          tabIndex={-1}
          className="walkthrough-html-comment-thread"
          style={{
            left: `clamp(12px, ${openMarker.left}px, max(12px, 100% - 432px))`,
            top: openMarker.top + 24,
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Escape" &&
              !event.nativeEvent.isComposing &&
              !event.defaultPrevented
            ) {
              event.preventDefault();
              event.stopPropagation();
              closeThread();
            }
          }}
        >
          <button className="button--quiet" aria-label="コメントを閉じる" onClick={closeThread}>
            閉じる
          </button>
          {renderCommentThread(openMarker.id)}
        </div>
      )}
      {action && (
        <>
          <button
            className="walkthrough-html-comment-action"
            style={{ left: action.left, top: action.top }}
            aria-label={action.label}
            title={action.label}
            onPointerDown={(event) => event.preventDefault()}
            onMouseEnter={action.onPreview}
            onMouseLeave={action.onPreviewEnd}
            onFocus={action.onPreview}
            onBlur={action.onPreviewEnd}
            onClick={() => {
              setOpenCommentId(null);
              onComment(action);
            }}
          >
            <CommentIcon />
          </button>
        </>
      )}
      {composer && composerAnchor && (
        <div
          ref={composerRef}
          className="walkthrough-html-comment-composer"
          style={{ left: composerAnchor.left, top: composerAnchor.top }}
        >
          {composer}
        </div>
      )}
    </div>
  );
}
