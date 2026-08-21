import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type {
  BranchDocumentContent,
  BranchReview,
  BranchReviewComment,
  CodeReference,
  CommentPlacement,
  BranchSearchResponse,
  BranchWalkthrough,
  BranchWalkthroughSummary,
  IssueDocument,
  TreeEntry,
} from "../../domain/models.js";
import { api, ApiError, jsonRequest } from "../api.js";
import type { ActiveDocument } from "../document-workspace.js";
import { CommentMarkdown } from "../components/CommentMarkdown.js";
import { CommentThread } from "../components/CommentThread.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { FileTree, type FileTreeFile } from "../components/FileTree.js";
import { QuickOpenPalette } from "../components/QuickOpenPalette.js";
import type { ThemePreference } from "../theme.js";

interface BranchReviewResponse {
  branchReview: BranchReview;
  issues: IssueDocument[];
  walkthroughs: BranchWalkthroughSummary[];
}

interface BranchTreeResponse {
  entries: TreeEntry[];
}

interface BranchCommentsResponse {
  comments: Array<{ comment: BranchReviewComment; latestPlacement: CommentPlacement }>;
}

type BranchDocument =
  | {
      kind: "file";
      key: string;
      path: string;
      title: string;
      sourceOid: string | null;
      line: number | null;
    }
  | { kind: "issue"; key: string; issueId: string; title: string; line: number | null }
  | {
      kind: "walkthrough";
      key: string;
      walkthroughId: string;
      title: string;
      line: number | null;
    };

type Pane = "left" | "right";

const WalkthroughReadingSurface = lazy(async () => {
  const module = await import("../components/WalkthroughViewer.js");
  return { default: module.WalkthroughReadingSurface };
});

function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

function docForFile(
  path: string,
  sourceOid: string | null = null,
  line: number | null = null,
): BranchDocument {
  return {
    kind: "file",
    key: `file:${path}`,
    path,
    title: path.split("/").at(-1) ?? path,
    sourceOid,
    line,
  };
}

function BranchMarkdown({
  body,
  branchReviewId,
  sourceOid,
  sourcePath,
  references = [],
  themePreference,
  repositoryAssetsEnabled = true,
  onOpenCodeReference,
  onOpenRepositoryLink,
}: {
  body: string;
  branchReviewId: string;
  sourceOid: string;
  sourcePath?: string | null;
  references?: CodeReference[];
  themePreference: ThemePreference;
  repositoryAssetsEnabled?: boolean;
  onOpenCodeReference?: (reference: CodeReference, openInOtherPane: boolean) => void;
  onOpenRepositoryLink?: (path: string, sourceOid: string, openInOtherPane: boolean) => void;
}) {
  return (
    <article className="markdown-preview branch-markdown">
      <CommentMarkdown
        body={body}
        branchReviewId={branchReviewId}
        sourceOid={sourceOid}
        sourcePath={sourcePath ?? null}
        references={references}
        themePreference={themePreference}
        repositoryAssetsEnabled={repositoryAssetsEnabled}
        onOpenCodeReference={onOpenCodeReference}
        onOpenRepositoryLink={onOpenRepositoryLink}
      />
    </article>
  );
}

function SourceLines({
  text,
  selection,
  navigationLine,
  pane,
  onSelectionChange,
}: {
  text: string;
  selection: { start: number; end: number } | null;
  navigationLine: number | null;
  pane: Pane;
  onSelectionChange: (selection: { start: number; end: number } | null) => void;
}) {
  const lines = text.split("\n");
  const selectLine = (line: number): void => {
    if (!selection || (selection.start !== selection.end && line !== selection.end)) {
      onSelectionChange({ start: line, end: line });
      return;
    }
    if (selection.start === selection.end && selection.start !== line) {
      onSelectionChange({
        start: Math.min(selection.start, line),
        end: Math.max(selection.start, line),
      });
      return;
    }
    onSelectionChange(null);
  };
  return (
    <pre className="branch-source-lines" aria-label="文書ソース">
      {lines.map((line, index) => {
        const lineNumber = index + 1;
        const selected =
          selection !== null && lineNumber >= selection.start && lineNumber <= selection.end;
        return (
          <button
            type="button"
            key={lineNumber}
            data-branch-line={lineNumber}
            data-branch-pane={pane}
            className={[
              selected ? "is-selected" : "",
              navigationLine === lineNumber ? "is-navigation-target" : "",
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
  );
}

function BranchCommentComposer({
  branchReview,
  document,
  selection,
  onCreated,
}: {
  branchReview: BranchReview;
  document: BranchDocument;
  selection: { start: number; end: number } | null;
  onCreated: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const readOnlyOldSource =
    document.kind === "file" &&
    document.sourceOid !== null &&
    document.sourceOid !== branchReview.sourceOid;
  const target =
    document.kind === "file"
      ? {
          kind: "document" as const,
          documentKind: "repository-file" as const,
          sourceOid: document.sourceOid ?? branchReview.sourceOid,
          path: document.path,
          startLine: selection?.start ?? null,
          endLine: selection?.end ?? null,
        }
      : document.kind === "issue"
        ? {
            kind: "issue" as const,
            issue: document.issueId,
            startLine: selection?.start ?? null,
            endLine: selection?.end ?? null,
          }
        : {
            kind: "walkthrough" as const,
            walkthroughId: document.walkthroughId,
            startLine: selection?.start ?? null,
            endLine: selection?.end ?? null,
          };
  const mutation = useMutation({
    mutationFn: async () =>
      await api(
        "/api/comments",
        jsonRequest({ branchReviewId: branchReview.id, target, body, authorLabel: "You" }),
      ),
    onSuccess: async () => {
      setBody("");
      await onCreated();
    },
  });
  if (readOnlyOldSource) {
    return (
      <p className="issue-stale-notice">
        この文書は古いexact sourceです。新しいcode commentはcurrent sourceで作成してください。
      </p>
    );
  }
  return (
    <div className="branch-document-comment">
      <label>
        {selection
          ? `選択行 L${selection.start}${selection.end === selection.start ? "" : `–${selection.end}`} へコメント`
          : "文書全体へコメント"}
      </label>
      <textarea
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="RVW Comment"
      />
      <button disabled={!body.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
        コメント
      </button>
      <ErrorNotice error={mutation.error} />
    </div>
  );
}

function BranchDocumentPane({
  pane,
  documents,
  activeKey,
  branchReview,
  onActivate,
  onClose,
  onCreated,
  comments,
  themePreference,
  onOpenDocument,
}: {
  pane: Pane;
  documents: BranchDocument[];
  activeKey: string | null;
  branchReview: BranchReview;
  onActivate: (document: BranchDocument) => void;
  onClose: (document: BranchDocument) => void;
  onCreated: () => Promise<void>;
  comments: BranchCommentsResponse["comments"];
  themePreference: ThemePreference;
  onOpenDocument: (document: BranchDocument, pane: Pane) => void;
}) {
  const document = documents.find((candidate) => candidate.key === activeKey) ?? null;
  const documentSourceOid =
    document?.kind === "file" ? (document.sourceOid ?? branchReview.sourceOid) : null;
  const [sourceMode, setSourceMode] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  useEffect(() => {
    const repositorySource =
      document?.kind === "file" && !document.path.toLowerCase().endsWith(".md");
    setSourceMode(Boolean(repositorySource || (document?.line ?? null) !== null));
    setSelection(null);
  }, [document?.key, document?.line, documentSourceOid]);
  useEffect(() => {
    if (!document?.line) return;
    const frame = window.requestAnimationFrame(() => {
      window.document
        .querySelector<HTMLElement>(
          `[data-branch-pane="${pane}"][data-branch-line="${document.line}"]`,
        )
        ?.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [document?.line, document?.key, pane, sourceMode]);
  const documentQuery = useQuery({
    queryKey: ["branch-document", branchReview.id, document?.key, documentSourceOid],
    queryFn: async () => {
      if (!document) throw new Error("document is required");
      if (document.kind === "walkthrough") {
        return await api<{ walkthrough: BranchWalkthrough }>(
          `/api/branch-reviews/${branchReview.id}/walkthroughs/${document.walkthroughId}`,
        );
      }
      const query = new URLSearchParams(
        document.kind === "issue"
          ? { kind: "issue-markdown", issueId: document.issueId }
          : {
              kind: "repository-file",
              sourceOid: documentSourceOid ?? branchReview.sourceOid,
              path: document.path,
            },
      );
      return await api<{ document: BranchDocumentContent }>(
        `/api/branch-reviews/${branchReview.id}/document?${query.toString()}`,
      );
    },
    enabled: Boolean(document),
  });
  const text =
    document?.kind === "walkthrough"
      ? (documentQuery.data as { walkthrough?: BranchWalkthrough } | undefined)?.walkthrough?.body
      : (documentQuery.data as { document?: BranchDocumentContent } | undefined)?.document?.text;
  const walkthrough =
    document?.kind === "walkthrough"
      ? (documentQuery.data as { walkthrough?: BranchWalkthrough } | undefined)?.walkthrough
      : null;
  const sourceOid =
    document?.kind === "file"
      ? (documentSourceOid ?? branchReview.sourceOid)
      : (walkthrough?.sourceOid ?? branchReview.sourceOid);
  const isMarkdown =
    document?.kind === "issue" ||
    document?.kind === "walkthrough" ||
    document?.path.toLowerCase().endsWith(".md");
  const documentComments = document
    ? comments.flatMap(({ comment, latestPlacement }) => {
        if (document.kind === "issue") {
          return comment.target.kind === "issue" && comment.target.issueId === document.issueId
            ? [{ comment, latestPlacement }]
            : [];
        }
        if (document.kind === "walkthrough") {
          return comment.target.kind === "walkthrough" &&
            comment.target.walkthroughId === document.walkthroughId
            ? [{ comment, latestPlacement }]
            : [];
        }
        if (comment.target.kind !== "document") return [];
        const historicalSource =
          document.sourceOid !== null && document.sourceOid !== branchReview.sourceOid;
        if (historicalSource) {
          if (
            comment.target.sourceOid !== document.sourceOid ||
            comment.target.path !== document.path
          ) {
            return [];
          }
          return [
            {
              comment,
              latestPlacement: {
                outdated: false as const,
                range:
                  comment.target.startLine === null
                    ? null
                    : {
                        startLine: comment.target.startLine,
                        endLine: comment.target.endLine ?? comment.target.startLine,
                      },
                path: comment.target.path,
              },
            },
          ];
        }
        return (latestPlacement.path ?? comment.target.path) === document.path
          ? [{ comment, latestPlacement }]
          : [];
      })
    : [];
  const walkthroughInlineComments =
    document?.kind === "walkthrough"
      ? documentComments.filter(
          ({ latestPlacement }) => !latestPlacement.outdated && latestPlacement.range !== null,
        )
      : [];
  const trailingDocumentComments =
    document?.kind === "walkthrough"
      ? documentComments.filter(
          ({ comment, latestPlacement }) =>
            latestPlacement.outdated ||
            (comment.target.kind === "walkthrough" && comment.target.startLine === null),
        )
      : documentComments;

  return (
    <section className="document-pane branch-document-pane" aria-label={`${pane} document pane`}>
      <div className="document-tabs-shell">
        <div className="document-tabs">
          {documents.map((candidate) => (
            <div
              key={candidate.key}
              className={`document-tab${candidate.key === activeKey ? " active" : ""}`}
            >
              <button className="document-tab-activate" onClick={() => onActivate(candidate)}>
                <span>{candidate.title}</span>
              </button>
              <button
                className="document-tab-close"
                aria-label={`${candidate.title}を閉じる`}
                onClick={() => onClose(candidate)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
      {!document ? (
        <div className="empty-document-viewer branch-empty-document">
          <strong>{pane === "left" ? "文書を選択してください" : "右ペイン"}</strong>
          <span>Cmd/Ctrl+クリックでIssue・Walkthrough・コードを並べられます。</span>
        </div>
      ) : documentQuery.isPending ? (
        <div className="empty-document-viewer">読み込んでいます…</div>
      ) : documentQuery.error || text === null || text === undefined ? (
        <div className="branch-document-error">
          <ErrorNotice error={documentQuery.error ?? new Error("この文書は表示できません。")} />
        </div>
      ) : (
        <>
          {isMarkdown && (
            <div className="branch-document-toolbar segmented compact">
              <button className={!sourceMode ? "active" : ""} onClick={() => setSourceMode(false)}>
                Preview
              </button>
              <button className={sourceMode ? "active" : ""} onClick={() => setSourceMode(true)}>
                Source
              </button>
            </div>
          )}
          <div className="branch-document-content">
            {document.kind === "walkthrough" && walkthrough && !sourceMode ? (
              <Suspense
                fallback={<div className="viewer-loading">Walkthroughを準備しています…</div>}
              >
                <WalkthroughReadingSurface
                  walkthrough={walkthrough}
                  placedComments={walkthroughInlineComments.map(({ comment, latestPlacement }) => ({
                    comment,
                    placement: latestPlacement,
                  }))}
                  themePreference={themePreference}
                  onOpenReference={(reference, openInOtherPane) =>
                    onOpenDocument(
                      docForFile(reference.path, walkthrough.sourceOid, reference.startLine),
                      openInOtherPane ? (pane === "left" ? "right" : "left") : pane,
                    )
                  }
                  onOpenCommentCodeReference={(referenceSourceOid, reference, openInOtherPane) => {
                    onOpenDocument(
                      docForFile(reference.path, referenceSourceOid, reference.startLine),
                      openInOtherPane ? (pane === "left" ? "right" : "left") : pane,
                    );
                    return Promise.resolve(null);
                  }}
                  onOpenRepositoryLink={(path, linkedSourceOid, openInOtherPane) =>
                    onOpenDocument(
                      docForFile(path, linkedSourceOid),
                      openInOtherPane ? (pane === "left" ? "right" : "left") : pane,
                    )
                  }
                />
              </Suspense>
            ) : isMarkdown && !sourceMode ? (
              <BranchMarkdown
                body={text}
                branchReviewId={branchReview.id}
                sourceOid={sourceOid}
                sourcePath={document.kind === "file" ? document.path : null}
                references={walkthrough?.references ?? []}
                themePreference={themePreference}
                repositoryAssetsEnabled={document.kind !== "issue"}
                onOpenCodeReference={(reference, openInOtherPane) =>
                  onOpenDocument(
                    docForFile(
                      reference.path,
                      walkthrough?.sourceOid ?? sourceOid,
                      reference.startLine,
                    ),
                    openInOtherPane ? (pane === "left" ? "right" : "left") : pane,
                  )
                }
                onOpenRepositoryLink={(path, linkedSourceOid, openInOtherPane) =>
                  onOpenDocument(
                    docForFile(path, linkedSourceOid),
                    openInOtherPane ? (pane === "left" ? "right" : "left") : pane,
                  )
                }
              />
            ) : (
              <SourceLines
                text={text}
                selection={selection}
                navigationLine={document.line}
                pane={pane}
                onSelectionChange={setSelection}
              />
            )}
            <BranchCommentComposer
              branchReview={branchReview}
              document={document}
              selection={sourceMode || !isMarkdown ? selection : null}
              onCreated={onCreated}
            />
            {trailingDocumentComments.length > 0 && (
              <section className="issue-inline-comments" aria-label="Document comments">
                <h3>RVW Comments</h3>
                {trailingDocumentComments.map(({ comment, latestPlacement }) => (
                  <CommentThread
                    key={comment.id}
                    comment={comment}
                    variant="inline"
                    placement={latestPlacement}
                    markdownSourceOid={sourceOid}
                    themePreference={themePreference}
                    onOpenCodeReference={(referenceSourceOid, reference, openInOtherPane) => {
                      onOpenDocument(
                        docForFile(reference.path, referenceSourceOid, reference.startLine),
                        openInOtherPane ? (pane === "left" ? "right" : "left") : pane,
                      );
                      return Promise.resolve(null);
                    }}
                    onOpenRepositoryLink={(path, linkedSourceOid, openInOtherPane) =>
                      onOpenDocument(
                        docForFile(path, linkedSourceOid),
                        openInOtherPane ? (pane === "left" ? "right" : "left") : pane,
                      )
                    }
                    onDeleted={() => void onCreated()}
                  />
                ))}
              </section>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function BranchReviewApp({
  branchReviewId,
  initialThemePreference,
}: {
  branchReviewId: string;
  initialThemePreference: ThemePreference;
}) {
  const queryClient = useQueryClient();
  const [documents, setDocuments] = useState<BranchDocument[]>([]);
  const [panes, setPanes] = useState<Record<string, Pane>>({});
  const [active, setActive] = useState<Record<Pane, string | null>>({ left: null, right: null });
  const [focusedPane, setFocusedPane] = useState<Pane>("left");
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [search, setSearch] = useState("");
  const [issueReference, setIssueReference] = useState("");
  const [branchComment, setBranchComment] = useState("");
  const attemptedInitialSync = useRef(false);
  const reviewQuery = useQuery({
    queryKey: ["branch-review", branchReviewId],
    queryFn: async () => await api<BranchReviewResponse>(`/api/branch-reviews/${branchReviewId}`),
  });
  const treeQuery = useQuery({
    queryKey: ["branch-tree", branchReviewId],
    queryFn: async () =>
      await api<BranchTreeResponse>(`/api/branch-reviews/${branchReviewId}/tree`),
  });
  const commentsQuery = useQuery({
    queryKey: ["comments", "branch", branchReviewId],
    queryFn: async () =>
      await api<BranchCommentsResponse>(
        `/api/branch-reviews/${branchReviewId}/comments?resolved=all`,
      ),
    refetchInterval: 2_000,
  });
  const searchQuery = useQuery({
    queryKey: ["branch-search", branchReviewId, search],
    queryFn: async () =>
      await api<BranchSearchResponse>(
        `/api/branch-reviews/${branchReviewId}/search?q=${encodeURIComponent(search)}`,
      ),
    enabled: Boolean(search.trim()),
  });
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["branch-review", branchReviewId] }),
      queryClient.invalidateQueries({ queryKey: ["branch-tree", branchReviewId] }),
      queryClient.invalidateQueries({ queryKey: ["branch-document", branchReviewId] }),
      queryClient.invalidateQueries({ queryKey: ["branch-search", branchReviewId] }),
      queryClient.invalidateQueries({ queryKey: ["comments", "branch", branchReviewId] }),
    ]);
  }, [branchReviewId, queryClient]);
  const syncMutation = useMutation({
    mutationFn: async () =>
      await api(`/api/branch-reviews/${branchReviewId}/sync`, jsonRequest({})),
    onSettled: async () => await refresh(),
  });
  useEffect(() => {
    if (!reviewQuery.data || attemptedInitialSync.current) return;
    attemptedInitialSync.current = true;
    syncMutation.mutate();
  }, [reviewQuery.data]);
  const issueMutation = useMutation({
    mutationFn: async () =>
      await api(
        `/api/branch-reviews/${branchReviewId}/issues`,
        jsonRequest({ issue: issueReference }),
      ),
    onSuccess: async () => {
      setIssueReference("");
      await refresh();
    },
  });
  const removeIssueMutation = useMutation({
    mutationFn: async (issue: IssueDocument) => {
      const endpoint = `/api/branch-reviews/${branchReviewId}/issues/${issue.id}`;
      const response = await fetch(endpoint, {
        ...jsonRequest({ yes: false }),
        method: "DELETE",
      });
      const preview = (await response.json()) as {
        counts?: {
          issueWholeComments: number;
          issueRangeComments: number;
          replies: number;
        };
        error?: { code: string; message: string; details?: unknown; suggestions?: string[] };
      };
      if (response.status !== 409 || !preview.counts) {
        throw new ApiError(
          preview.error?.message ?? `HTTP ${response.status}`,
          preview.error?.code ?? "HTTP_ERROR",
          preview.error?.details,
          preview.error?.suggestions ?? [],
        );
      }
      const confirmed = window.confirm(
        `Issue #${issue.number} ${issue.title} をこのBranch Reviewから削除します。\n\nIssue全体コメント ${preview.counts.issueWholeComments}\nIssue本文rangeコメント ${preview.counts.issueRangeComments}\n返信 ${preview.counts.replies}\n\nこの操作は元に戻せません。`,
      );
      if (!confirmed) return null;
      return await api(endpoint, {
        ...jsonRequest({ yes: true }),
        method: "DELETE",
      });
    },
    onSuccess: async (result, issue) => {
      if (!result) return;
      const key = `issue:${issue.id}`;
      setDocuments((current) => current.filter((document) => document.key !== key));
      setPanes((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setActive((current) => ({
        left: current.left === key ? null : current.left,
        right: current.right === key ? null : current.right,
      }));
      await refresh();
    },
  });
  const resetMutation = useMutation({
    mutationFn: async () => {
      const branchReview = reviewQuery.data?.branchReview;
      if (!branchReview) throw new ApiError("Branch Reviewを読み込めません。", "NOT_FOUND");
      const endpoint = `/api/branch-reviews/${branchReviewId}/reset`;
      const response = await fetch(endpoint, jsonRequest({ yes: false }));
      const preview = (await response.json()) as {
        counts?: Record<string, number>;
        retainedRefs?: string[];
        error?: { code: string; message: string; details?: unknown; suggestions?: string[] };
      };
      if (response.status !== 409 || !preview.counts) {
        throw new ApiError(
          preview.error?.message ?? `HTTP ${response.status}`,
          preview.error?.code ?? "HTTP_ERROR",
          preview.error?.details,
          preview.error?.suggestions ?? [],
        );
      }
      const counts = preview.counts;
      const confirmed = window.confirm(
        `Branch Reviewを削除します。\n\nIssue membership ${counts.issueMemberships ?? 0}\nIssueコメント ${counts.issueComments ?? 0}\nコードコメント ${counts.codeComments ?? 0}\nBranch全体コメント ${counts.reviewComments ?? 0}\nWalkthroughコメント ${counts.walkthroughComments ?? 0}\n投稿 ${counts.posts ?? 0}\nWalkthrough ${counts.walkthroughs ?? 0}\n解放候補Git ref ${preview.retainedRefs?.length ?? counts.gitRefs ?? 0}\n\nこの操作は元に戻せません。`,
      );
      if (!confirmed) return null;
      await api(endpoint, jsonRequest({ yes: true }));
      return await api<{ branchReview: BranchReview }>(
        "/api/branch-reviews/open",
        jsonRequest({ cwd: branchReview.localRepositoryPath }),
      );
    },
    onSuccess: (result) => {
      if (!result) return;
      const next = new URL(window.location.href);
      next.search = `?branchReviewId=${encodeURIComponent(result.branchReview.id)}`;
      window.location.replace(next.toString());
    },
  });
  const branchCommentMutation = useMutation({
    mutationFn: async () =>
      await api(
        "/api/comments",
        jsonRequest({
          branchReviewId,
          target: { kind: "branch" },
          body: branchComment,
          authorLabel: "You",
        }),
      ),
    onSuccess: async () => {
      setBranchComment("");
      await refresh();
    },
  });

  const openDocument = useCallback(
    (document: BranchDocument, pane: Pane = "left", pushHistory = true): void => {
      setDocuments((current) =>
        current.some((candidate) => candidate.key === document.key)
          ? current.map((candidate) => (candidate.key === document.key ? document : candidate))
          : [...current, document],
      );
      setPanes((current) => ({ ...current, [document.key]: pane }));
      setActive((current) => ({ ...current, [pane]: document.key }));
      setFocusedPane(pane);
      if (pushHistory) {
        window.history.pushState(
          { branchReviewHistory: branchReviewId, branchDocument: document, branchPane: pane },
          "",
          window.location.href,
        );
      }
    },
    [branchReviewId],
  );
  useEffect(() => {
    const currentState = window.history.state as Record<string, unknown> | null;
    if (currentState?.branchReviewHistory === branchReviewId) return;
    window.history.replaceState(
      {
        ...(currentState ?? {}),
        branchReviewHistory: branchReviewId,
        branchDocument: null,
        branchPane: "left",
      },
      "",
      window.location.href,
    );
  }, [branchReviewId]);
  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      const state = event.state as {
        branchReviewHistory?: string;
        branchDocument?: BranchDocument;
        branchPane?: Pane;
      } | null;
      if (state?.branchReviewHistory !== branchReviewId) return;
      if (!state.branchDocument) {
        const pane = state.branchPane ?? "left";
        setActive((current) => ({ ...current, [pane]: null }));
        setFocusedPane(pane);
        return;
      }
      openDocument(state.branchDocument, state.branchPane ?? "left", false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [branchReviewId, openDocument]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      setQuickOpenVisible(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const closeDocument = (document: BranchDocument): void => {
    const pane = panes[document.key] ?? "left";
    const remaining = documents.filter((candidate) => candidate.key !== document.key);
    setDocuments(remaining);
    setActive((current) => ({
      ...current,
      [pane]:
        current[pane] === document.key
          ? (remaining.find((candidate) => panes[candidate.key] === pane)?.key ?? null)
          : current[pane],
    }));
  };

  if (!/^[0-9a-f-]{36}$/i.test(branchReviewId)) {
    return <main className="fatal-state">Branch Review IDが不正です。</main>;
  }
  if (reviewQuery.isPending)
    return <main className="fatal-state">Branch Reviewを読み込んでいます…</main>;
  if (reviewQuery.error || !reviewQuery.data) {
    return (
      <main className="fatal-state">
        <ErrorNotice error={reviewQuery.error} />
      </main>
    );
  }

  const { branchReview, issues, walkthroughs } = reviewQuery.data;
  const files: FileTreeFile[] = (treeQuery.data?.entries ?? []).map((entry) => ({
    path: entry.path,
    entryKind: entry.kind,
  }));
  const filteredFiles = fileFilter
    ? files.filter((file) => file.path.toLowerCase().includes(fileFilter.toLowerCase()))
    : files;
  const comments = commentsQuery.data?.comments ?? [];
  const unresolved = comments.filter(({ comment }) => !comment.resolvedAt).length;
  const paneDocuments = (pane: Pane) =>
    documents.filter((document) => panes[document.key] === pane);
  const activeDocument = documents.find((document) => document.key === active[focusedPane]) ?? null;
  const quickOpenDocuments: ActiveDocument[] = documents.flatMap((document) =>
    document.kind === "file"
      ? [
          {
            kind: "repository-file" as const,
            path: document.path,
            ...(document.sourceOid ? { sourceOid: document.sourceOid } : {}),
          },
        ]
      : [],
  );
  const quickOpenActiveDocument: ActiveDocument | null =
    activeDocument?.kind === "file"
      ? {
          kind: "repository-file",
          path: activeDocument.path,
          ...(activeDocument.sourceOid ? { sourceOid: activeDocument.sourceOid } : {}),
        }
      : null;
  const otherPane = (pane: Pane): Pane => (pane === "left" ? "right" : "left");
  const openCommentTarget = (
    comment: BranchReviewComment,
    latestPlacement: CommentPlacement,
  ): void => {
    const target = comment.target;
    if (target.kind === "issue") {
      openDocument(
        {
          kind: "issue",
          key: `issue:${target.issueId}`,
          issueId: target.issueId,
          title: `#${target.issueNumber} ${target.issueTitle}`,
          line: latestPlacement.outdated
            ? target.startLine
            : (latestPlacement.range?.startLine ?? target.startLine),
        },
        focusedPane,
      );
    } else if (target.kind === "walkthrough") {
      openDocument(
        {
          kind: "walkthrough",
          key: `walkthrough:${target.walkthroughId}`,
          walkthroughId: target.walkthroughId,
          title: target.walkthroughTitle,
          line: latestPlacement.outdated
            ? target.startLine
            : (latestPlacement.range?.startLine ?? target.startLine),
        },
        focusedPane,
      );
    } else if (target.kind === "document") {
      openDocument(
        latestPlacement.outdated
          ? docForFile(target.path, target.sourceOid, target.startLine)
          : docForFile(
              latestPlacement.path ?? target.path,
              null,
              latestPlacement.range?.startLine ?? target.startLine,
            ),
        focusedPane,
      );
    }
  };

  return (
    <main className="app-shell branch-review-shell">
      <header className="topbar branch-topbar">
        <div className="brand">
          <span className="brand-mark">r</span>
          <strong>rvw</strong>
        </div>
        <div className="pr-heading">
          <span>{branchReview.canonicalName}</span>
          <h1>
            Branch Review · {branchReview.defaultBranchName} · {shortOid(branchReview.sourceOid)}
          </h1>
        </div>
        <div className="branch-topbar-actions">
          <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
            GitHubと同期
          </button>
          <button
            className="button--danger-quiet"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
          >
            リセット
          </button>
        </div>
      </header>
      <ErrorNotice error={syncMutation.error ?? resetMutation.error} />
      {branchReview.sourceSyncError && (
        <p className="issue-stale-notice branch-source-stale-notice">
          default branchの最新sourceを取得できなかったため、最後に同期できた
          {shortOid(branchReview.sourceOid)} を表示しています。
        </p>
      )}
      <QuickOpenPalette
        open={quickOpenVisible}
        files={files}
        openDocuments={quickOpenDocuments}
        activeDocument={quickOpenActiveDocument}
        activePane={focusedPane}
        loading={treeQuery.isPending}
        error={treeQuery.error}
        includePullRequestDocument={false}
        onClose={() => setQuickOpenVisible(false)}
        onOpen={(document) => {
          if (document.kind === "repository-file") {
            openDocument(docForFile(document.path), focusedPane);
          }
        }}
      />
      <div className="workspace branch-workspace">
        <aside className="sidebar branch-sidebar" aria-label="Branch Review sidebar">
          <section className="branch-sidebar-section">
            <h2>
              Issues <span>{issues.length}</span>
            </h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                issueMutation.mutate();
              }}
            >
              <input
                value={issueReference}
                onChange={(event) => setIssueReference(event.target.value)}
                placeholder="#142 または Issue URL"
              />
              <button disabled={!issueReference.trim() || issueMutation.isPending}>追加</button>
            </form>
            <ErrorNotice error={issueMutation.error ?? removeIssueMutation.error} />
            <nav className="branch-list">
              {issues.map((issue) => (
                <div className="issue-list-row" key={issue.id}>
                  <button
                    className="issue-list-open"
                    onClick={(event) =>
                      openDocument(
                        {
                          kind: "issue",
                          key: `issue:${issue.id}`,
                          issueId: issue.id,
                          title: `#${issue.number} ${issue.title}`,
                          line: null,
                        },
                        event.metaKey || event.ctrlKey ? otherPane(focusedPane) : focusedPane,
                      )
                    }
                  >
                    <strong>#{issue.number}</strong>
                    <span>{issue.title}</span>
                    <em>
                      {issue.state}
                      {issue.syncError ? " · stale" : ""}
                    </em>
                  </button>
                  <button
                    className="issue-list-remove"
                    aria-label={`#${issue.number}を削除`}
                    title="このreviewからIssueを削除"
                    disabled={
                      removeIssueMutation.isPending &&
                      removeIssueMutation.variables?.id === issue.id
                    }
                    onClick={() => removeIssueMutation.mutate(issue)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </nav>
          </section>
          <section className="branch-sidebar-section">
            <h2>
              Walkthroughs <span>{walkthroughs.length}</span>
            </h2>
            <nav className="branch-list">
              {walkthroughs.map((walkthrough) => (
                <button
                  key={walkthrough.id}
                  onClick={(event) =>
                    openDocument(
                      {
                        kind: "walkthrough",
                        key: `walkthrough:${walkthrough.id}`,
                        walkthroughId: walkthrough.id,
                        title: walkthrough.title,
                        line: null,
                      },
                      event.metaKey || event.ctrlKey ? otherPane(focusedPane) : focusedPane,
                    )
                  }
                >
                  <span>{walkthrough.title}</span>
                  {walkthrough.sourceOid !== branchReview.sourceOid && <em>Outdated</em>}
                </button>
              ))}
            </nav>
          </section>
          <section className="branch-sidebar-section branch-code-section">
            <h2>
              Files <span>{files.length}</span>
            </h2>
            <button className="button--quiet" onClick={() => setQuickOpenVisible(true)}>
              Quick Open
            </button>
            <input
              value={fileFilter}
              onChange={(event) => setFileFilter(event.target.value)}
              placeholder="ファイル名を検索"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="コード全文検索"
            />
            {search && (
              <nav className="branch-search-results">
                {(searchQuery.data?.results ?? []).slice(0, 80).map((result, index) => (
                  <button
                    key={`${result.path}:${result.line}:${index}`}
                    onClick={() =>
                      openDocument(docForFile(result.path, null, result.line), focusedPane)
                    }
                  >
                    <strong>
                      {result.path}:{result.line}
                    </strong>
                    <span>{result.text}</span>
                  </button>
                ))}
              </nav>
            )}
            {!search && (
              <FileTree
                files={filteredFiles}
                activePath={
                  documents.find((document) => document.key === active.left)?.kind === "file"
                    ? (
                        documents.find((document) => document.key === active.left) as Extract<
                          BranchDocument,
                          { kind: "file" }
                        >
                      ).path
                    : null
                }
                filtering={Boolean(fileFilter)}
                initiallyExpanded="active-file"
                onOpenFile={(path, right) =>
                  openDocument(docForFile(path), right ? otherPane(focusedPane) : focusedPane)
                }
              />
            )}
            <ErrorNotice error={treeQuery.error ?? searchQuery.error} />
          </section>
          <section className="branch-sidebar-section branch-comments-section">
            <h2>
              Comments <span>{unresolved}</span>
            </h2>
            <textarea
              rows={2}
              value={branchComment}
              onChange={(event) => setBranchComment(event.target.value)}
              placeholder="Branch Review全体へコメント"
            />
            <button
              disabled={!branchComment.trim() || branchCommentMutation.isPending}
              onClick={() => branchCommentMutation.mutate()}
            >
              全体コメントを追加
            </button>
            <ErrorNotice error={branchCommentMutation.error ?? commentsQuery.error} />
            {comments.map(({ comment, latestPlacement }) => (
              <CommentThread
                key={comment.id}
                comment={comment}
                placement={latestPlacement}
                themePreference={initialThemePreference}
                {...(comment.target.kind === "branch"
                  ? {}
                  : { onOpenTarget: () => openCommentTarget(comment, latestPlacement) })}
                onOpenCodeReference={(sourceOid, reference, openInOtherPane) => {
                  openDocument(
                    docForFile(reference.path, sourceOid, reference.startLine),
                    openInOtherPane ? otherPane(focusedPane) : focusedPane,
                  );
                  return Promise.resolve(null);
                }}
                onOpenRepositoryLink={(path, sourceOid, openInOtherPane) =>
                  openDocument(
                    docForFile(path, sourceOid),
                    openInOtherPane ? otherPane(focusedPane) : focusedPane,
                  )
                }
                onDeleted={() => void refresh()}
              />
            ))}
          </section>
        </aside>
        <div className="horizontal-resize-handle" aria-hidden="true" />
        <section className={`main-view${paneDocuments("right").length ? " two-pane" : ""}`}>
          <BranchDocumentPane
            pane="left"
            documents={paneDocuments("left")}
            activeKey={active.left}
            branchReview={branchReview}
            onActivate={(document) => {
              setActive((current) => ({ ...current, left: document.key }));
              setFocusedPane("left");
            }}
            onClose={closeDocument}
            onCreated={refresh}
            comments={comments}
            themePreference={initialThemePreference}
            onOpenDocument={(document, pane) => openDocument(document, pane)}
          />
          {paneDocuments("right").length > 0 && (
            <>
              <div className="horizontal-resize-handle pane-resize-handle" aria-hidden="true" />
              <BranchDocumentPane
                pane="right"
                documents={paneDocuments("right")}
                activeKey={active.right}
                branchReview={branchReview}
                onActivate={(document) => {
                  setActive((current) => ({ ...current, right: document.key }));
                  setFocusedPane("right");
                }}
                onClose={closeDocument}
                onCreated={refresh}
                comments={comments}
                themePreference={initialThemePreference}
                onOpenDocument={(document, pane) => openDocument(document, pane)}
              />
            </>
          )}
        </section>
      </div>
    </main>
  );
}
