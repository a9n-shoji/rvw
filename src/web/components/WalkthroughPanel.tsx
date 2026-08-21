import { useState, type FormEvent } from "react";
import type { IssueDocument } from "../../domain/models.js";
import type { AnyWalkthroughSummary } from "../review-context.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { FileEntryIcon, FolderIcon } from "./FileIcon.js";

export function WalkthroughIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
      <path
        fill="currentColor"
        d="M2.75 1.5A1.25 1.25 0 0 0 1.5 2.75v10.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V2.75c0-.69-.56-1.25-1.25-1.25H2.75Zm.25 2h10v7.75H8.8l-2.05 1.7v-1.7H3V3.5Zm2.25 1.25a.75.75 0 1 0 0 1.5h5.5a.75.75 0 0 0 0-1.5h-5.5Zm0 2.75a.75.75 0 1 0 0 1.5h3.5a.75.75 0 0 0 0-1.5h-3.5Z"
      />
    </svg>
  );
}

export function ReviewTreeItems({
  issues,
  walkthroughs,
  includePullRequestDocument = true,
  pullRequestActive,
  activeIssueId,
  activeWalkthroughId,
  issueReference,
  issueAddOpen,
  issueAdding,
  removingIssueId,
  issueError,
  onIssueReferenceChange,
  onIssueAddOpenChange,
  onIssueAdd,
  onOpenIssue,
  onRemoveIssue,
  onOpenPullRequest,
  onOpen,
}: {
  issues: IssueDocument[];
  walkthroughs: AnyWalkthroughSummary[];
  includePullRequestDocument?: boolean;
  pullRequestActive: boolean;
  activeIssueId: string | null;
  activeWalkthroughId: string | null;
  issueReference: string;
  issueAddOpen: boolean;
  issueAdding: boolean;
  removingIssueId: string | null;
  issueError: unknown;
  onIssueReferenceChange: (reference: string) => void;
  onIssueAddOpenChange: (open: boolean) => void;
  onIssueAdd: () => void;
  onOpenIssue: (issue: IssueDocument, openInRightPane: boolean) => void;
  onRemoveIssue: (issue: IssueDocument) => void;
  onOpenPullRequest: (openInRightPane: boolean) => void;
  onOpen: (walkthrough: AnyWalkthroughSummary, openInRightPane: boolean) => void;
}) {
  const [issuesExpanded, setIssuesExpanded] = useState(true);
  const [walkthroughsExpanded, setWalkthroughsExpanded] = useState(false);
  const submitIssue = (event: FormEvent): void => {
    event.preventDefault();
    onIssueAdd();
  };

  return (
    <nav className="review-tree-items" aria-label="レビュー文書">
      {includePullRequestDocument && (
        <button
          type="button"
          className={`file-tree-row review-tree-item review-tree-pull-request${pullRequestActive ? " active" : ""}`}
          onMouseDown={(event) => {
            if (!event.metaKey && !event.ctrlKey) return;
            event.preventDefault();
            onOpenPullRequest(true);
          }}
          onClick={(event) => {
            if (!event.metaKey && !event.ctrlKey) onOpenPullRequest(false);
          }}
          onContextMenu={(event) => {
            if (event.ctrlKey || event.metaKey) event.preventDefault();
          }}
          title="Pull Request.md"
          aria-label="Pull Request.md"
        >
          <span className="directory-chevron" aria-hidden="true" />
          <span className="file-tree-icon-group" aria-hidden="true">
            <FileEntryIcon path="Pull Request.md" kind="file" />
          </span>
          <span className="file-tree-label">Pull Request.md</span>
        </button>
      )}
      <div className="review-tree-directory-row">
        <button
          type="button"
          className="file-tree-row review-tree-item review-tree-directory"
          aria-expanded={issuesExpanded}
          aria-label={`Issues ${issues.length}`}
          onClick={() => setIssuesExpanded((expanded) => !expanded)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !issuesExpanded) return;
            event.preventDefault();
            setIssuesExpanded(false);
            onIssueAddOpenChange(false);
          }}
        >
          <span className="directory-chevron" aria-hidden="true">
            {issuesExpanded ? "▾" : "▸"}
          </span>
          <span className="file-tree-icon-group" aria-hidden="true">
            <FolderIcon expanded={issuesExpanded} />
          </span>
          <span className="file-tree-label">Issues</span>
          <span className="review-tree-count">{issues.length}</span>
        </button>
        <button
          type="button"
          className="review-tree-directory-action"
          aria-label="Issueを追加"
          title="Issueを追加"
          aria-pressed={issueAddOpen}
          onClick={() => {
            setIssuesExpanded(true);
            onIssueAddOpenChange(!issueAddOpen);
          }}
        >
          +
        </button>
      </div>
      {issuesExpanded && (
        <div className="review-tree-issue-list">
          {issueAddOpen && (
            <form
              className="review-tree-issue-form"
              aria-label="Issueを追加"
              onSubmit={submitIssue}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                onIssueReferenceChange("");
                onIssueAddOpenChange(false);
              }}
            >
              <input
                autoFocus
                value={issueReference}
                onChange={(event) => onIssueReferenceChange(event.target.value)}
                placeholder="#142 または Issue URL"
                aria-label="Issue番号またはURL"
              />
              <button disabled={!issueReference.trim() || issueAdding}>追加</button>
            </form>
          )}
          {issues.map((issue) => (
            <div className="review-tree-issue-row" key={issue.id}>
              <button
                type="button"
                className={`file-tree-row review-tree-item review-tree-issue${activeIssueId === issue.id ? " active" : ""}`}
                onMouseDown={(event) => {
                  if (!event.metaKey && !event.ctrlKey) return;
                  event.preventDefault();
                  onOpenIssue(issue, true);
                }}
                onClick={(event) => {
                  if (!event.metaKey && !event.ctrlKey) onOpenIssue(issue, false);
                }}
                onContextMenu={(event) => {
                  if (event.ctrlKey || event.metaKey) event.preventDefault();
                }}
                title={`#${issue.number} ${issue.title}`}
                aria-label={`#${issue.number} ${issue.title}`}
              >
                <span className="directory-chevron" aria-hidden="true" />
                <span className="file-tree-icon-group" aria-hidden="true">
                  <FileEntryIcon path={`Issue-${issue.number}.md`} kind="file" />
                </span>
                <span className="file-tree-label">
                  #{issue.number} {issue.title}
                </span>
                <span className={issue.syncError ? "review-tree-stale" : "review-tree-issue-state"}>
                  {issue.state}
                  {issue.syncError ? " · stale" : ""}
                </span>
              </button>
              <button
                type="button"
                className="review-tree-directory-action review-tree-remove"
                aria-label={`#${issue.number}を削除`}
                title="このreviewからIssueを削除"
                disabled={removingIssueId === issue.id}
                onClick={() => onRemoveIssue(issue)}
              >
                ×
              </button>
            </div>
          ))}
          <ErrorNotice error={issueError} />
        </div>
      )}
      <button
        type="button"
        className="file-tree-row review-tree-item review-tree-walkthroughs"
        aria-expanded={walkthroughsExpanded}
        aria-label={`ウォークスルー ${walkthroughs.length}`}
        disabled={walkthroughs.length === 0}
        onClick={() => setWalkthroughsExpanded((expanded) => !expanded)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !walkthroughsExpanded) return;
          event.preventDefault();
          setWalkthroughsExpanded(false);
        }}
      >
        <span className="directory-chevron" aria-hidden="true">
          {walkthroughsExpanded ? "▾" : "▸"}
        </span>
        <span className="file-tree-icon-group review-tree-walkthrough-icon" aria-hidden="true">
          <WalkthroughIcon />
        </span>
        <span className="file-tree-label">ウォークスルー</span>
        <span className="review-tree-count">{walkthroughs.length}</span>
      </button>
      {walkthroughsExpanded && (
        <div className="review-tree-walkthrough-list">
          {walkthroughs.map((walkthrough) => (
            <button
              type="button"
              key={walkthrough.id}
              className={`file-tree-row review-tree-item review-tree-walkthrough${activeWalkthroughId === walkthrough.id ? " active" : ""}`}
              onMouseDown={(event) => {
                if (!event.metaKey && !event.ctrlKey) return;
                event.preventDefault();
                onOpen(walkthrough, true);
              }}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) return;
                onOpen(walkthrough, false);
              }}
              onContextMenu={(event) => {
                if (event.ctrlKey || event.metaKey) event.preventDefault();
              }}
              title={`${walkthrough.title}\n${walkthrough.authorLabel ?? "Agent"} · ${walkthrough.sourceOid.slice(0, 8)}`}
              aria-label={walkthrough.title}
            >
              <span className="directory-chevron" aria-hidden="true" />
              <span
                className="file-tree-icon-group review-tree-walkthrough-icon"
                aria-hidden="true"
              >
                <WalkthroughIcon />
              </span>
              <span className="file-tree-label">{walkthrough.title}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}
