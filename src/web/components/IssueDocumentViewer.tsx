import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { IssueDocument, ReviewComment } from "../../domain/models.js";
import { api, jsonRequest } from "../api.js";
import type { ThemePreference } from "../theme.js";
import { CommentThread } from "./CommentThread.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { MarkdownImagePlaceholder } from "./MarkdownImagePlaceholder.js";
import type { ViewerNavigationTarget } from "./DocumentViewer.js";

export function IssueDocumentViewer({
  pullRequestId,
  issue,
  comments,
  themePreference,
  navigationTarget,
  onNavigationApplied,
}: {
  pullRequestId: string;
  issue: IssueDocument;
  comments: ReviewComment[];
  themePreference: ThemePreference;
  navigationTarget?: ViewerNavigationTarget | null;
  onNavigationApplied: (requestId: number) => void;
}) {
  const queryClient = useQueryClient();
  const viewerRef = useRef<HTMLDivElement>(null);
  const appliedNavigationRequest = useRef<number | null>(null);
  const [sourceMode, setSourceMode] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [body, setBody] = useState("");
  useLayoutEffect(() => {
    if (!navigationTarget || appliedNavigationRequest.current === navigationTarget.requestId) {
      return;
    }
    const requestId = navigationTarget.requestId;
    setSourceMode(navigationTarget.line !== null);
    const frame = window.requestAnimationFrame(() => {
      const target =
        navigationTarget.line === null
          ? viewerRef.current
          : viewerRef.current?.querySelector<HTMLElement>(
              `[data-issue-line="${navigationTarget.line}"]`,
            );
      if (!target) return;
      target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
      appliedNavigationRequest.current = requestId;
      onNavigationApplied(requestId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationTarget, onNavigationApplied, sourceMode]);
  const mutation = useMutation({
    mutationFn: async () =>
      await api(
        "/api/comments",
        jsonRequest({
          pullRequestId,
          target: {
            kind: "issue",
            issue: issue.url,
            startLine: sourceMode ? (selection?.start ?? null) : null,
            endLine: sourceMode ? (selection?.end ?? null) : null,
          },
          body,
          authorLabel: "You",
        }),
      ),
    onSuccess: async () => {
      setBody("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["comments"] }),
        queryClient.invalidateQueries({ queryKey: ["change-sequence"] }),
      ]);
    },
  });
  const issueComments = comments.filter(
    (
      comment,
    ): comment is ReviewComment & {
      target: Extract<ReviewComment["target"], { kind: "issue" }>;
    } => comment.target.kind === "issue" && comment.target.issueId === issue.id,
  );
  const lines = issue.body.split("\n");
  const selectLine = (line: number): void => {
    if (!selection) {
      setSelection({ start: line, end: line });
      return;
    }
    if (selection.start === selection.end && selection.start !== line) {
      setSelection({
        start: Math.min(selection.start, line),
        end: Math.max(selection.start, line),
      });
      return;
    }
    setSelection(null);
  };
  return (
    <div className="issue-document-viewer" ref={viewerRef}>
      <header className="issue-document-header">
        <div>
          <span>GitHub Issue · {issue.state}</span>
          <h2>
            <a href={issue.url} target="_blank" rel="noopener noreferrer">
              #{issue.number} {issue.title}
            </a>
          </h2>
        </div>
        <div className="segmented compact">
          <button className={!sourceMode ? "active" : ""} onClick={() => setSourceMode(false)}>
            Preview
          </button>
          <button className={sourceMode ? "active" : ""} onClick={() => setSourceMode(true)}>
            Source
          </button>
        </div>
      </header>
      {issue.syncError && (
        <p className="issue-stale-notice">
          最新同期に失敗したため、最後に取得できた本文を表示しています。
        </p>
      )}
      {sourceMode ? (
        <pre className="branch-source-lines">
          {lines.map((line, index) => {
            const lineNumber = index + 1;
            const selected =
              selection !== null && lineNumber >= selection.start && lineNumber <= selection.end;
            return (
              <button
                type="button"
                key={lineNumber}
                data-issue-line={lineNumber}
                className={[
                  selected ? "is-selected" : "",
                  navigationTarget?.line === lineNumber ? "is-navigation-target" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => selectLine(lineNumber)}
              >
                <span>{lineNumber}</span>
                <code>{line || " "}</code>
              </button>
            );
          })}
        </pre>
      ) : (
        <article className="markdown-preview branch-markdown">
          <ReactMarkdown
            rehypePlugins={[rehypeSanitize]}
            remarkPlugins={[remarkGfm]}
            components={{
              img: ({ alt, title }) => (
                <MarkdownImagePlaceholder alt={alt} title={title} sourceAttributes={{}} />
              ),
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {issue.body}
          </ReactMarkdown>
        </article>
      )}
      <div className="branch-document-comment">
        <label>
          {sourceMode && selection
            ? `Issue本文 L${selection.start}${selection.end === selection.start ? "" : `–${selection.end}`} へコメント`
            : "Issue全体へコメント"}
        </label>
        <textarea rows={3} value={body} onChange={(event) => setBody(event.target.value)} />
        <button disabled={!body.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
          コメント
        </button>
        <ErrorNotice error={mutation.error} />
      </div>
      {issueComments.length > 0 && (
        <section className="issue-inline-comments">
          <h3>RVW Comments</h3>
          {issueComments.map((comment) => (
            <CommentThread
              key={comment.id}
              comment={comment}
              themePreference={themePreference}
              placement={
                comment.target.sourceDocumentHash === issue.bodyHash
                  ? {
                      outdated: false,
                      range:
                        comment.target.startLine === null
                          ? null
                          : {
                              startLine: comment.target.startLine,
                              endLine: comment.target.endLine ?? comment.target.startLine,
                            },
                      path: `#${issue.number}`,
                    }
                  : { outdated: true, range: null, path: `#${issue.number}` }
              }
            />
          ))}
        </section>
      )}
    </div>
  );
}
