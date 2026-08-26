import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { MarkdownSourceRange } from "./markdown-source-map.js";
import { CommentIcon } from "./components/CommentComposer.js";

export interface HtmlPreviewOverlayAction {
  range: MarkdownSourceRange;
  left: number;
  top: number;
  label: string;
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
}: {
  action: HtmlPreviewOverlayAction | null;
  markers: HtmlPreviewOverlayMarker[];
  composer: ReactNode;
  composerAnchor: HtmlPreviewOverlayAction | null;
  onComment: (action: HtmlPreviewOverlayAction) => void;
  onActivateComment: (commentId: string) => void;
}) {
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
          onClick={() => onActivateComment(marker.id)}
        >
          <CommentIcon />
        </button>
      ))}
      {action && (
        <button
          className="walkthrough-html-comment-action"
          style={{ left: action.left, top: action.top }}
          aria-label={action.label}
          title={action.label}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onComment(action)}
        >
          <CommentIcon />
          コメント
        </button>
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
