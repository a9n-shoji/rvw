import type { FormEvent } from "react";
import type { IssueDocument } from "../../domain/models.js";
import { ErrorNotice } from "./ErrorNotice.js";

export function ReviewIssuePanel({
  issues,
  activeIssueId,
  reference,
  adding,
  removingIssueId,
  error,
  onReferenceChange,
  onAdd,
  onOpen,
  onRemove,
}: {
  issues: IssueDocument[];
  activeIssueId: string | null;
  reference: string;
  adding: boolean;
  removingIssueId: string | null;
  error: unknown;
  onReferenceChange: (reference: string) => void;
  onAdd: () => void;
  onOpen: (issue: IssueDocument, openInOtherPane: boolean) => void;
  onRemove: (issue: IssueDocument) => void;
}) {
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onAdd();
  };
  return (
    <section className="review-issues-panel" aria-label="Issues">
      <h3>
        Issues <span>{issues.length}</span>
      </h3>
      <form onSubmit={submit}>
        <input
          value={reference}
          onChange={(event) => onReferenceChange(event.target.value)}
          placeholder="#142 または Issue URL"
        />
        <button disabled={!reference.trim() || adding}>追加</button>
      </form>
      <nav>
        {issues.map((issue) => (
          <div className="issue-list-row" key={issue.id}>
            <button
              type="button"
              className={`issue-list-open${activeIssueId === issue.id ? " active" : ""}`}
              onMouseDown={(event) => {
                if (!event.metaKey && !event.ctrlKey) return;
                event.preventDefault();
                onOpen(issue, true);
              }}
              onClick={(event) => {
                if (!event.metaKey && !event.ctrlKey) onOpen(issue, false);
              }}
              onContextMenu={(event) => {
                if (event.ctrlKey || event.metaKey) event.preventDefault();
              }}
            >
              <strong>#{issue.number}</strong>
              <span>{issue.title}</span>
              <em>
                {issue.state}
                {issue.syncError ? " · stale" : ""}
              </em>
            </button>
            <button
              type="button"
              className="issue-list-remove"
              aria-label={`#${issue.number}を削除`}
              title="このreviewからIssueを削除"
              disabled={removingIssueId === issue.id}
              onClick={() => onRemove(issue)}
            >
              ×
            </button>
          </div>
        ))}
      </nav>
      <ErrorNotice error={error} />
    </section>
  );
}
