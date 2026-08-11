import { ErrorNotice } from "./ErrorNotice.js";

type CommentSubmitKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  repeat: boolean;
  nativeEvent: { isComposing: boolean };
  preventDefault: () => void;
};

export function handleCommentSubmitShortcut(
  event: CommentSubmitKeyEvent,
  enabled: boolean,
  onSubmit: () => void,
): void {
  if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
  if (event.repeat || event.nativeEvent.isComposing) return;
  event.preventDefault();
  if (enabled) onSubmit();
}

export function CommentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
      <path
        fill="currentColor"
        d="M1.75 2.5A1.75 1.75 0 0 1 3.5.75h9A1.75 1.75 0 0 1 14.25 2.5v7A1.75 1.75 0 0 1 12.5 11.25H7.06l-3.88 3.1A.75.75 0 0 1 2 13.77v-2.7A1.75 1.75 0 0 1 1.75 9.5v-7Zm1.75-.25a.25.25 0 0 0-.25.25v7c0 .14.11.25.25.25V12.2l3.03-2.42a.75.75 0 0 1 .47-.17h5.5a.25.25 0 0 0 .25-.25V2.5a.25.25 0 0 0-.25-.25h-9Z"
      />
    </svg>
  );
}

export function InlineCommentComposer({
  body,
  label,
  disabled = false,
  pending,
  error,
  validationError,
  placement,
  onBodyChange,
  onCancel,
  onSubmit,
}: {
  body: string;
  label: string;
  disabled?: boolean;
  pending: boolean;
  error: unknown;
  validationError: string | undefined;
  placement: "file" | "line";
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const canSubmit = Boolean(body.trim()) && !disabled && !pending;
  return (
    <div className={`inline-comment-composer inline-comment-composer--${placement}`}>
      <strong>{label}</strong>
      <textarea
        autoFocus
        rows={4}
        value={body}
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onCancel();
            return;
          }
          handleCommentSubmitShortcut(event, canSubmit, onSubmit);
        }}
        placeholder="コメントを入力（plain text）"
        aria-label={label}
      />
      {validationError && <p className="form-error">{validationError}</p>}
      <ErrorNotice error={error} />
      <div className="inline-comment-actions">
        <button
          type="button"
          className="button--quiet"
          disabled={pending}
          onPointerDown={(event) => {
            event.preventDefault();
            onCancel();
          }}
          onClick={onCancel}
        >
          キャンセル
        </button>
        <button type="button" disabled={!canSubmit} onClick={onSubmit}>
          コメント
        </button>
      </div>
    </div>
  );
}
