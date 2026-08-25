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
  onComment,
  onActivateComment,
}: {
  action: HtmlPreviewOverlayAction | null;
  markers: HtmlPreviewOverlayMarker[];
  onComment: (range: MarkdownSourceRange) => void;
  onActivateComment: (commentId: string) => void;
}) {
  return (
    <div className="walkthrough-html-overlay" aria-hidden={action === null && markers.length === 0}>
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
          onClick={() => onComment(action.range)}
        >
          <CommentIcon />
          コメント
        </button>
      )}
    </div>
  );
}
