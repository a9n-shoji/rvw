import fuzzysort from "fuzzysort";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RepositoryReview,
  RepositoryReviewSearchResponse,
  RepositoryWalkthrough,
  RepositoryWalkthroughSummary,
  CommentPlacement,
  IssueDocument,
} from "../../domain/models.js";
import {
  api,
  ApiError,
  jsonRequest,
  type RepositoryCommentsResponse,
  type RepositoryReviewResponse,
  type RepositorySyncResponse,
  type RepositoryTreeResponse,
} from "../api.js";
import { CommentSidebar } from "../components/CommentSidebar.js";
import type { ViewerNavigationTarget } from "../components/DocumentViewer.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import { FileTree, type FileTreeFile } from "../components/FileTree.js";
import { LazyLoadBoundary } from "../components/LazyLoadBoundary.js";
import { QuickOpenPalette } from "../components/QuickOpenPalette.js";
import { ReviewActionsMenu } from "../components/ReviewActionsMenu.js";
import { ReviewDocumentPane } from "../components/ReviewDocumentPane.js";
import { ReviewSidebar } from "../components/ReviewSidebar.js";
import { ReviewWorkspace } from "../components/ReviewWorkspace.js";
import { SearchPanel, type AnySearchResult } from "../components/SearchPanel.js";
import { ReviewTreeItems } from "../components/WalkthroughPanel.js";
import {
  clearCommentDraftsForReview,
  deleteCommentDraftForIssue,
  deleteCommentReplyDraftsForComment,
} from "../comment-draft-store.js";
import {
  documentTabKey,
  initialDocumentWorkspace,
  type ActiveDocument,
  type DocumentPaneId,
} from "../document-workspace.js";
import type { AnyReviewComment } from "../review-context.js";
import type { ReadingLocator } from "../reading-history.js";
import { invalidateReviewScope } from "../review-query-invalidation.js";
import { reviewQueryKeys } from "../review-query-keys.js";
import { issueSyncFailureFeedback } from "../review-sync-feedback.js";
import type { ThemePreference } from "../theme.js";
import { useDebouncedValue } from "../use-debounced-value.js";
import { useThemePreference } from "../use-theme-preference.js";
import { useReviewSidebarSearch } from "../use-review-sidebar-search.js";
import { useQuickOpenShortcut } from "../use-quick-open-shortcut.js";
import { useReviewReadingHistory } from "../use-review-reading-history.js";
import { useExactCodeReferenceNavigation } from "../use-exact-code-reference-navigation.js";
import { useWalkthroughDocumentReconciliation } from "../use-walkthrough-document-reconciliation.js";
import { useTemporaryFeedback } from "../use-temporary-feedback.js";
import { useAgentPostNotifications } from "../use-agent-post-notifications.js";
import { useDraftAwareDocumentWorkspace } from "../use-draft-aware-document-workspace.js";
import { viewerHeartbeatRequest } from "../viewer-session.js";

const DocumentViewer = lazy(async () => {
  const module = await import("../components/DocumentViewer.js");
  return { default: module.DocumentViewer };
});
const WalkthroughViewer = lazy(async () => {
  const module = await import("../components/WalkthroughViewer.js");
  return { default: module.WalkthroughViewer };
});

function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

function repositoryDocument(
  path: string,
  sourceOid?: string,
): Extract<ActiveDocument, { kind: "repository-file" }> {
  return {
    kind: "repository-file",
    path,
    ...(sourceOid ? { sourceOid, comparisonPolicy: "exact-source" as const } : {}),
  };
}

export function RepositoryReviewApp({
  repositoryReviewId,
  initialThemePreference,
}: {
  repositoryReviewId: string;
  initialThemePreference: ThemePreference;
}) {
  const queryClient = useQueryClient();
  const [codeExpanded, setCodeExpanded] = useState(true);
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<"files" | "search">("files");
  const [fileFilter, setFileFilter] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchMatchCase, setSearchMatchCase] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [issueReference, setIssueReference] = useState("");
  const [issueAddOpen, setIssueAddOpen] = useState(false);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [quickOpenReturnFocus, setQuickOpenReturnFocus] = useState<HTMLElement | null>(null);
  const [draggedDocumentKey, setDraggedDocumentKey] = useState<string | null>(null);
  const [viewerNavigationTargets, setViewerNavigationTargets] = useState<
    Record<DocumentPaneId, ViewerNavigationTarget | null>
  >({ left: null, right: null });
  const viewerNavigationTargetsRef = useRef(viewerNavigationTargets);
  viewerNavigationTargetsRef.current = viewerNavigationTargets;
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [syncFeedbackWarning, setSyncFeedbackWarning] = useState(false);
  const [resetRecovery, setResetRecovery] = useState<{
    repositoryPath: string;
    reopenError: unknown;
    orphanRefs: {
      remainingRefs: string[] | null;
      refPrefix: string;
    } | null;
  } | null>(null);
  const {
    feedback: syncFeedback,
    showFeedback: showSyncFeedback,
    clearFeedback: clearSyncFeedback,
  } = useTemporaryFeedback();
  const showDraftConflict = useCallback(
    (message: string): void => {
      setSyncFeedbackWarning(true);
      showSyncFeedback(message);
    },
    [showSyncFeedback],
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const attemptedInitialSync = useRef(false);
  const observedChangeSequence = useRef<number | null>(null);
  const paneElements = useRef<Record<DocumentPaneId, HTMLElement | null>>({
    left: null,
    right: null,
  });
  const documentScrollPositions = useRef(new Map<string, number>());
  const reviewHistoryKey = `repository:${repositoryReviewId}`;
  const resetViewerNavigation = useCallback((paneIds: readonly DocumentPaneId[]): void => {
    const uniquePaneIds = [...new Set(paneIds)];
    const nextTargets = { ...viewerNavigationTargetsRef.current };
    for (const paneId of uniquePaneIds) nextTargets[paneId] = null;
    viewerNavigationTargetsRef.current = nextTargets;
    setViewerNavigationTargets((current) => {
      if (uniquePaneIds.every((paneId) => current[paneId] === null)) return current;
      return { ...current, ...Object.fromEntries(uniquePaneIds.map((paneId) => [paneId, null])) };
    });
  }, []);
  const {
    workspace,
    workspaceRef,
    setWorkspace,
    activateDocument: activateWorkspaceDocument,
    openDocument: openWorkspaceDocument,
    closeDocument,
    closePaneDocuments,
    moveDocument,
    dropDocument: dropDocumentWithDrafts,
    draftWorkspaceRevision,
  } = useDraftAwareDocumentWorkspace({
    reviewId: repositoryReviewId,
    onDocumentNavigation: resetViewerNavigation,
    onDraftConflict: showDraftConflict,
    initialDocument: null,
  });
  const dropDocument = useCallback(
    (documentKey: string, sourcePane: DocumentPaneId, targetPane: DocumentPaneId): void => {
      dropDocumentWithDrafts(documentKey, sourcePane, targetPane);
      setDraggedDocumentKey(null);
    },
    [dropDocumentWithDrafts],
  );
  const {
    activateDocument,
    initializeReadingHistory,
    markLineNavigationApplied,
    navigateToDocument,
    navigateToMarkdownFragment,
    recordPaneScroll,
  } = useReviewReadingHistory({
    reviewKey: reviewHistoryKey,
    workspace,
    workspaceRef,
    paneElements,
    documentScrollPositions,
    viewerNavigationTargets,
    setViewerNavigationTargets,
    openWorkspaceDocument,
    activateWorkspaceDocument,
  });
  const openCodeReference = useExactCodeReferenceNavigation({
    reviewKind: "repository",
    reviewId: repositoryReviewId,
    workspaceRef,
    navigateToDocument,
  });
  const {
    themePreference,
    selectThemePreference,
    query: themeQuery,
    mutation: themeMutation,
  } = useThemePreference(initialThemePreference);
  const debouncedSearch = useDebouncedValue(searchText.trim(), 250);
  const openSidebarSearch = useReviewSidebarSearch({
    searchInputRef,
    onCodeExpandedChange: setCodeExpanded,
    onModeChange: setSidebarMode,
  });
  const reviewQuery = useQuery({
    queryKey: reviewQueryKeys.review("repository", repositoryReviewId),
    queryFn: async () =>
      await api<RepositoryReviewResponse>(`/api/repository-reviews/${repositoryReviewId}`),
  });
  const treeQuery = useQuery({
    queryKey: reviewQueryKeys.tree(
      "repository",
      repositoryReviewId,
      reviewQuery.data?.repositoryReview.sourceOid,
    ),
    queryFn: async () =>
      await api<RepositoryTreeResponse>(`/api/repository-reviews/${repositoryReviewId}/tree`),
    enabled: Boolean(reviewQuery.data),
  });
  const changeSequence = useQuery({
    queryKey: reviewQueryKeys.changeSequence("repository", repositoryReviewId),
    queryFn: async () =>
      await api<{ changeSequence: number; reviewChangeSequence: number }>(
        `/api/meta/change-sequence?reviewKind=repository&reviewId=${encodeURIComponent(repositoryReviewId)}`,
        viewerHeartbeatRequest(),
      ),
    refetchInterval: 1_000,
    refetchIntervalInBackground: true,
    networkMode: "always",
  });
  const commentsQuery = useQuery({
    queryKey: reviewQueryKeys.comments(
      "repository",
      repositoryReviewId,
      changeSequence.data?.reviewChangeSequence,
    ),
    queryFn: async () =>
      await api<RepositoryCommentsResponse>(
        `/api/repository-reviews/${repositoryReviewId}/comments?resolved=all`,
      ),
  });
  const commentsWithPlacement = useMemo(
    () => commentsQuery.data?.comments ?? [],
    [commentsQuery.data?.comments],
  );
  const comments = useMemo(
    () => commentsWithPlacement.map(({ comment }) => comment),
    [commentsWithPlacement],
  );
  const agentPostNotifications = useAgentPostNotifications({
    reviewKind: "repository",
    reviewId: repositoryReviewId,
    comments,
    commentsReady: commentsQuery.isSuccess,
    showFeedback: showSyncFeedback,
  });
  const searchQuery = useQuery({
    queryKey: reviewQueryKeys.search(
      "repository",
      repositoryReviewId,
      reviewQuery.data?.repositoryReview.sourceOid,
      debouncedSearch,
      searchMatchCase,
      searchWholeWord,
    ),
    queryFn: async ({ signal }) => {
      const parameters = new URLSearchParams({
        q: debouncedSearch,
        matchCase: String(searchMatchCase),
        wholeWord: String(searchWholeWord),
      });
      return await api<RepositoryReviewSearchResponse>(
        `/api/repository-reviews/${repositoryReviewId}/search?${parameters.toString()}`,
        { signal },
      );
    },
    enabled: Boolean(debouncedSearch),
    placeholderData: (previousData) => previousData,
  });

  const refresh = useCallback(async (): Promise<void> => {
    await invalidateReviewScope(queryClient, "repository", repositoryReviewId);
  }, [repositoryReviewId, queryClient]);

  useEffect(() => {
    const nextSequence = changeSequence.data?.reviewChangeSequence;
    if (nextSequence === undefined) return;
    const previousSequence = observedChangeSequence.current;
    observedChangeSequence.current = nextSequence;
    if (previousSequence === null || previousSequence === nextSequence) return;
    void refresh();
  }, [changeSequence.data?.reviewChangeSequence, refresh]);

  const syncMutation = useMutation({
    mutationFn: async () =>
      await api<RepositorySyncResponse>(
        `/api/repository-reviews/${repositoryReviewId}/sync`,
        jsonRequest({}),
      ),
    onSuccess: async ({ repositoryReview, issueResults }) => {
      const failures = issueResults.filter((result) => !result.ok);
      setSyncFeedbackWarning(failures.length > 0);
      const sourceFeedback = `${repositoryReview.defaultBranchName} · ${shortOid(repositoryReview.sourceOid)} に同期しました。`;
      const issueFeedback = issueSyncFailureFeedback(failures);
      showSyncFeedback(issueFeedback ? `${sourceFeedback} ${issueFeedback}` : sourceFeedback);
      await refresh();
    },
    onError: async () => await refresh(),
  });
  useEffect(() => {
    if (!reviewQuery.data || attemptedInitialSync.current) return;
    attemptedInitialSync.current = true;
    syncMutation.mutate();
  }, [reviewQuery.data]);

  const issueMutation = useMutation({
    mutationFn: async () =>
      await api(
        `/api/repository-reviews/${repositoryReviewId}/issues`,
        jsonRequest({ issue: issueReference }),
      ),
    onSuccess: async () => {
      setIssueReference("");
      setIssueAddOpen(false);
      await refresh();
    },
  });
  const removeIssueMutation = useMutation({
    mutationFn: async (issue: IssueDocument) => {
      const endpoint = `/api/repository-reviews/${repositoryReviewId}/issues/${issue.id}`;
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
        confirmationToken?: string;
        error?: { code: string; message: string; details?: unknown; suggestions?: string[] };
      };
      if (response.status !== 409 || !preview.counts || !preview.confirmationToken) {
        throw new ApiError(
          preview.error?.message ?? `HTTP ${response.status}`,
          preview.error?.code ?? "HTTP_ERROR",
          preview.error?.details,
          preview.error?.suggestions ?? [],
        );
      }
      const confirmed = window.confirm(
        `Issue #${issue.number} ${issue.title} をこのRepository Reviewから削除します。\n\nIssue全体コメント ${preview.counts.issueWholeComments}\nIssue本文rangeコメント ${preview.counts.issueRangeComments}\n返信 ${preview.counts.replies}\n\nこの操作は元に戻せません。`,
      );
      if (!confirmed) return null;
      return await api(endpoint, {
        ...jsonRequest({ yes: true, confirmationToken: preview.confirmationToken }),
        method: "DELETE",
      });
    },
    onSuccess: async (result, issue) => {
      if (!result) return;
      deleteCommentDraftForIssue(repositoryReviewId, issue.id);
      for (const comment of comments) {
        if (comment.target.kind === "issue" && comment.target.issueId === issue.id) {
          deleteCommentReplyDraftsForComment(repositoryReviewId, comment.id);
        }
      }
      for (const paneId of ["left", "right"] as const) {
        const openIssue = workspaceRef.current.documents[paneId].find(
          (document) => document.kind === "issue" && document.id === issue.id,
        );
        if (openIssue) closeDocument(openIssue, paneId);
      }
      await refresh();
    },
  });
  const resetMutation = useMutation({
    mutationFn: async () => {
      const repositoryReview = reviewQuery.data?.repositoryReview;
      if (!repositoryReview) throw new ApiError("Repository Reviewを読み込めません。", "NOT_FOUND");
      const endpoint = `/api/repository-reviews/${repositoryReviewId}/reset`;
      const response = await fetch(endpoint, jsonRequest({ yes: false }));
      const preview = (await response.json()) as {
        counts?: Record<string, number>;
        retainedRefs?: string[];
        confirmationToken?: string;
        error?: { code: string; message: string; details?: unknown; suggestions?: string[] };
      };
      if (response.status !== 409 || !preview.counts || !preview.confirmationToken) {
        throw new ApiError(
          preview.error?.message ?? `HTTP ${response.status}`,
          preview.error?.code ?? "HTTP_ERROR",
          preview.error?.details,
          preview.error?.suggestions ?? [],
        );
      }
      const counts = preview.counts;
      const confirmed = window.confirm(
        `Repository Reviewを削除します。\n\nIssue membership ${counts.issueMemberships ?? 0}\nコメント合計 ${counts.comments ?? 0}\nIssueコメント ${counts.issueComments ?? 0}\nコードコメント ${counts.codeComments ?? 0}\nRepository Review全体コメント ${counts.reviewComments ?? 0}\nWalkthroughコメント ${counts.walkthroughComments ?? 0}\n投稿 ${counts.posts ?? 0}\nコメント内コード参照 ${counts.commentReferences ?? 0}\nコメント対象 ${counts.targets ?? 0}\nWalkthrough ${counts.walkthroughs ?? 0}\nWalkthroughコード参照 ${counts.walkthroughReferences ?? 0}\n解放候補Git ref ${preview.retainedRefs?.length ?? counts.gitRefs ?? 0}\n\nこの操作は元に戻せません。`,
      );
      if (!confirmed) return null;
      const reset = await api<{
        outcome:
          | { kind: "completed" }
          | {
              kind: "completed-with-orphan-refs";
              remainingRefs: string[] | null;
              refPrefix: string;
            };
      }>(endpoint, jsonRequest({ yes: true, confirmationToken: preview.confirmationToken }));
      if (reset.outcome.kind === "completed-with-orphan-refs") {
        return {
          kind: "reset-complete" as const,
          repositoryPath: repositoryReview.localRepositoryPath,
          reopenError: null,
          orphanRefs: reset.outcome,
        };
      }
      try {
        const reopened = await api<{ repositoryReview: RepositoryReview }>(
          "/api/repository-reviews/open",
          jsonRequest({ cwd: repositoryReview.localRepositoryPath }),
        );
        return { kind: "reopened" as const, repositoryReview: reopened.repositoryReview };
      } catch (reopenError) {
        return {
          kind: "reset-complete" as const,
          repositoryPath: repositoryReview.localRepositoryPath,
          reopenError,
          orphanRefs: null,
        };
      }
    },
    onSuccess: (result) => {
      if (!result) return;
      clearCommentDraftsForReview(repositoryReviewId);
      documentScrollPositions.current.clear();
      setWorkspace(initialDocumentWorkspace());
      resetViewerNavigation(["left", "right"]);
      if (result.kind === "reset-complete") {
        setResetRecovery(result);
        return;
      }
      const next = new URL(window.location.href);
      next.search = `?repositoryReviewId=${encodeURIComponent(result.repositoryReview.id)}`;
      window.location.replace(next.toString());
    },
  });

  useEffect(() => {
    if (reviewQuery.isSuccess) initializeReadingHistory();
  }, [initializeReadingHistory, reviewQuery.isSuccess]);
  useEffect(() => {
    const warnBeforeBrowserClose = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeBrowserClose);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeBrowserClose);
    };
  }, []);
  useQuickOpenShortcut(() => {
    setQuickOpenReturnFocus(null);
    setQuickOpenVisible(true);
  });

  const files = useMemo<FileTreeFile[]>(
    () =>
      (treeQuery.data?.entries ?? []).map((entry) => ({
        path: entry.path,
        entryKind: entry.kind,
      })),
    [treeQuery.data?.entries],
  );
  const filteredFiles = useMemo(() => {
    if (!fileFilter.trim()) return files;
    const matches = new Set(
      fuzzysort
        .go(
          fileFilter,
          files.map((file) => file.path),
          { limit: 100 },
        )
        .map((result) => result.target),
    );
    return files.filter((file) => matches.has(file.path));
  }, [fileFilter, files]);
  const openDocuments = useMemo(
    () => [...workspace.documents.left, ...workspace.documents.right],
    [workspace.documents.left, workspace.documents.right],
  );
  const activePane = workspace.focusedPane;
  const activeDocument = workspace.active[activePane];
  const openWalkthroughIds = useMemo(
    () => [
      ...new Set(
        openDocuments
          .filter(
            (document): document is Extract<ActiveDocument, { kind: "walkthrough" }> =>
              document.kind === "walkthrough",
          )
          .map((document) => document.id),
      ),
    ],
    [openDocuments],
  );
  const walkthroughDetailQueries = useQueries({
    queries: openWalkthroughIds.map((walkthroughId) => ({
      queryKey: reviewQueryKeys.walkthrough("repository", repositoryReviewId, walkthroughId),
      queryFn: async () =>
        await api<{ walkthrough: RepositoryWalkthrough }>(
          `/api/repository-reviews/${repositoryReviewId}/walkthroughs/${walkthroughId}`,
        ),
    })),
  });
  const walkthroughs = reviewQuery.data?.walkthroughs ?? [];
  useWalkthroughDocumentReconciliation({
    walkthroughs,
    enabled: reviewQuery.isSuccess,
    setWorkspace,
  });

  if (resetRecovery) {
    return (
      <main className="fatal-state">
        <h1>Repository Reviewのresetは完了しました</h1>
        {resetRecovery.orphanRefs && (
          <div role="alert">
            <p>
              review-owned Git
              refの一部を削除できませんでした。残存refは新しいReviewから隔離されています。
              cleanup対象prefix: <code>{resetRecovery.orphanRefs.refPrefix}</code>
            </p>
            {resetRecovery.orphanRefs.remainingRefs !== null && (
              <p>残存ref: {resetRecovery.orphanRefs.remainingRefs.join(", ") || "なし"}</p>
            )}
          </div>
        )}
        <p>
          repository <code>{resetRecovery.repositoryPath}</code> で <code>rvw repository open</code>
          を実行してRepository Reviewを再作成してください。
        </p>
        {resetRecovery.reopenError !== null && <ErrorNotice error={resetRecovery.reopenError} />}
      </main>
    );
  }
  if (reviewQuery.isPending) {
    return <main className="fatal-state">Repository Reviewを読み込んでいます…</main>;
  }
  if (reviewQuery.error || !reviewQuery.data) {
    return (
      <main className="fatal-state">
        <ErrorNotice error={reviewQuery.error} />
      </main>
    );
  }

  const { repositoryReview, issues } = reviewQuery.data;
  const review = {
    kind: "repository" as const,
    id: repositoryReview.id,
    sourceOid: repositoryReview.sourceOid,
  };
  const placements = new Map(
    commentsWithPlacement.map(({ comment, latestPlacement }) => [comment.id, latestPlacement]),
  );
  const unresolvedCommentCount = comments.filter((comment) => comment.resolvedAt === null).length;
  const walkthroughDetails = new Map<string, RepositoryWalkthrough>();
  const loadingWalkthroughIds = new Set<string>();
  openWalkthroughIds.forEach((walkthroughId, index) => {
    const query = walkthroughDetailQueries[index];
    if (query?.data?.walkthrough) walkthroughDetails.set(walkthroughId, query.data.walkthrough);
    if (query?.isPending) loadingWalkthroughIds.add(walkthroughId);
  });
  const rightPaneVisible = workspace.documents.right.length > 0 || draggedDocumentKey !== null;
  const openFile = (
    path: string,
    openInRightPane = false,
    sourceOid?: string,
    line: number | null = null,
  ): void => {
    navigateToDocument(repositoryDocument(path, sourceOid), openInRightPane ? "right" : "left", {
      kind: "line",
      line,
    });
  };
  const openIssue = (issue: IssueDocument, openInRightPane: boolean): void => {
    navigateToDocument(
      { kind: "issue", id: issue.id, number: issue.number, title: issue.title, url: issue.url },
      openInRightPane ? "right" : "left",
    );
  };
  const openWalkthrough = (
    walkthrough: RepositoryWalkthroughSummary,
    openInRightPane: boolean,
  ): void => {
    navigateToDocument(
      {
        kind: "walkthrough",
        id: walkthrough.id,
        title: walkthrough.title,
        sourceOid: walkthrough.sourceOid,
      },
      openInRightPane ? "right" : "left",
    );
  };
  const openCommentTarget = (
    comment: AnyReviewComment,
    placement: CommentPlacement | null,
    openInRightPane: boolean,
  ): void => {
    if (!("repositoryReviewId" in comment)) return;
    setCommentsExpanded(true);
    setActiveCommentId(comment.id);
    const target = comment.target;
    const startLine = placement?.outdated
      ? "startLine" in target
        ? target.startLine
        : null
      : (placement?.range?.startLine ?? ("startLine" in target ? target.startLine : null));
    const endLine = placement?.outdated
      ? "endLine" in target
        ? target.endLine
        : null
      : (placement?.range?.endLine ?? ("endLine" in target ? target.endLine : null));
    const locator: ReadingLocator = {
      kind: "line",
      line: startLine,
      ...(endLine === null ? {} : { endLine }),
    };
    const targetPane: DocumentPaneId = openInRightPane ? "right" : "left";
    if (target.kind === "repository") return;
    if (target.kind === "issue") {
      navigateToDocument(
        {
          kind: "issue",
          id: target.issueId,
          number: target.issueNumber,
          title: target.issueTitle,
          url: target.issueUrl,
        },
        targetPane,
        locator,
      );
      return;
    }
    if (target.kind === "walkthrough") {
      const walkthrough = walkthroughs.find((candidate) => candidate.id === target.walkthroughId);
      if (!walkthrough) return;
      navigateToDocument(
        {
          kind: "walkthrough",
          id: walkthrough.id,
          title: walkthrough.title,
          sourceOid: walkthrough.sourceOid,
        },
        targetPane,
        locator,
      );
      return;
    }
    navigateToDocument(
      placement?.outdated
        ? repositoryDocument(target.path, target.sourceOid)
        : repositoryDocument(placement?.path ?? target.path),
      targetPane,
      locator,
    );
  };
  const handleCommentActiveChange = (commentId: string, active: boolean): void => {
    setActiveCommentId((current) => (active ? commentId : current === commentId ? null : current));
  };
  const openRepositoryLink = (path: string, sourceOid: string, openInRightPane: boolean): void => {
    navigateToDocument(repositoryDocument(path, sourceOid), openInRightPane ? "right" : "left");
  };
  const renderDocumentPane = (paneId: DocumentPaneId) => {
    const paneDocuments = workspace.documents[paneId];
    const paneDocument = workspace.active[paneId];
    const content =
      paneDocument?.kind === "walkthrough" && walkthroughDetails.get(paneDocument.id) ? (
        <LazyLoadBoundary label="ウォークスルー">
          <Suspense
            fallback={<div className="viewer-loading">ウォークスルーを準備しています…</div>}
          >
            <WalkthroughViewer
              walkthrough={walkthroughDetails.get(paneDocument.id)!}
              paneId={paneId}
              comments={comments}
              commentPlacements={placements}
              activeCommentId={activeCommentId}
              navigationTarget={
                viewerNavigationTargets[paneId]?.documentKey === documentTabKey(paneDocument)
                  ? viewerNavigationTargets[paneId]
                  : null
              }
              onNavigationApplied={(requestId) => markLineNavigationApplied(paneId, requestId)}
              themePreference={themePreference}
              onCommentActiveChange={handleCommentActiveChange}
              onOpenReference={(walkthrough, reference, openInRightPane) =>
                openCodeReference(
                  walkthrough.sourceOid,
                  reference,
                  openInRightPane ? "right" : "left",
                  "exact-source",
                )
              }
              onOpenCommentCodeReference={(sourceOid, reference, openInRightPane) =>
                openCodeReference(
                  sourceOid,
                  reference,
                  openInRightPane ? "right" : "left",
                  "exact-source",
                )
              }
              onOpenRepositoryLink={openRepositoryLink}
              onDeleted={() => {
                closeDocument(paneDocument);
                void refresh();
              }}
            />
          </Suspense>
        </LazyLoadBoundary>
      ) : paneDocument?.kind === "walkthrough" ? (
        <div className="empty-document-viewer">
          <strong>
            {loadingWalkthroughIds.has(paneDocument.id)
              ? "ウォークスルーを読み込んでいます…"
              : "ウォークスルーを読み込めませんでした。"}
          </strong>
          {!loadingWalkthroughIds.has(paneDocument.id) && (
            <span>サイドバーからもう一度開いてください。</span>
          )}
        </div>
      ) : paneDocument?.kind === "repository-file" || paneDocument?.kind === "issue" ? (
        <LazyLoadBoundary label="文書ビューアー">
          <Suspense fallback={<div className="viewer-loading">文書を準備しています…</div>}>
            <DocumentViewer
              key={
                paneDocument.kind === "issue"
                  ? `${draftWorkspaceRevision}:${paneId}:repository:${repositoryReview.id}:issue:${paneDocument.id}`
                  : `${draftWorkspaceRevision}:${paneId}:repository:${repositoryReview.id}:repository-file:${paneDocument.path}:${paneDocument.sourceOid ?? "current"}:${paneDocument.comparisonPolicy ?? ""}`
              }
              review={review}
              paneId={paneId}
              selectedOid={repositoryReview.sourceOid}
              oldOid={null}
              activeDocument={paneDocument}
              documentRevision={
                paneDocument.kind === "issue"
                  ? (issues.find((issue) => issue.id === paneDocument.id)?.bodyHash ?? null)
                  : (paneDocument.sourceOid ?? repositoryReview.sourceOid)
              }
              displayMode="full"
              diffStyle="unified"
              comments={comments}
              commentPlacements={placements}
              activeCommentId={activeCommentId}
              fullViewNotice={
                paneDocument.kind === "issue" &&
                issues.find((issue) => issue.id === paneDocument.id)?.syncError
                  ? "Issue同期失敗 · 最終取得本文"
                  : null
              }
              themePreference={themePreference}
              onCommentActiveChange={handleCommentActiveChange}
              navigationTarget={
                viewerNavigationTargets[paneId]?.documentKey === documentTabKey(paneDocument)
                  ? viewerNavigationTargets[paneId]
                  : null
              }
              onNavigationApplied={(requestId) => markLineNavigationApplied(paneId, requestId)}
              onOpenMarkdownFragment={(line, hash) =>
                navigateToMarkdownFragment(paneDocument, paneId, line, hash)
              }
              onOpenCodeReference={(sourceOid, reference, openInRightPane) =>
                openCodeReference(
                  sourceOid,
                  reference,
                  openInRightPane ? "right" : "left",
                  "exact-source",
                )
              }
              onOpenRepositoryLink={openRepositoryLink}
            />
          </Suspense>
        </LazyLoadBoundary>
      ) : null;
    return (
      <ReviewDocumentPane
        paneId={paneId}
        documents={paneDocuments}
        activeDocument={paneDocument}
        focusedPane={activePane}
        changeKindsByPath={new Map()}
        draggedDocumentKey={draggedDocumentKey}
        content={content}
        onPaneRef={(element) => {
          paneElements.current[paneId] = element;
        }}
        onScroll={(scrollTop) => {
          recordPaneScroll(paneId, paneDocument, scrollTop);
        }}
        onFocus={() =>
          setWorkspace((current) =>
            current.focusedPane === paneId ? current : { ...current, focusedPane: paneId },
          )
        }
        onActivate={(document) => activateDocument(document, paneId)}
        onClose={(document) => closeDocument(document, paneId)}
        onCloseOthers={(document) => closePaneDocuments(paneId, document)}
        onCloseAll={() => closePaneDocuments(paneId)}
        onMove={(document, targetPane) => moveDocument(document, paneId, targetPane)}
        onDropDocument={dropDocument}
        onDragStartDocument={setDraggedDocumentKey}
        onDragEndDocument={() => setDraggedDocumentKey(null)}
      />
    );
  };

  const actionError =
    syncMutation.error ??
    resetMutation.error ??
    themeQuery.error ??
    themeMutation.error ??
    changeSequence.error;
  return (
    <main className="app-shell">
      <a className="skip-link" href="#review-main-content">
        レビュー本文へ移動
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">r</span>
          <strong>rvw</strong>
        </div>
        <div className="review-heading">
          <span title={reviewQuery.data.selectedRemote?.url}>
            {repositoryReview.canonicalName}
            {reviewQuery.data.selectedRemote
              ? ` · remote ${reviewQuery.data.selectedRemote.name}`
              : " · remote unavailable"}
          </span>
          <h1>
            Repository Review · {repositoryReview.defaultBranchName} ·{" "}
            {shortOid(repositoryReview.sourceOid)}
          </h1>
        </div>
        <div className="review-scope-spacer" />
        <ReviewActionsMenu
          themePreference={themePreference}
          themePending={themeMutation.isPending}
          syncPending={syncMutation.isPending}
          resetPending={resetMutation.isPending}
          agentNotificationStatus={agentPostNotifications.status}
          resetLabel="Repository Reviewを削除して再構築"
          onOpenQuickOpen={(returnFocusElement) => {
            setQuickOpenReturnFocus(returnFocusElement);
            setQuickOpenVisible(true);
          }}
          onSync={() => {
            setSyncFeedbackWarning(false);
            clearSyncFeedback();
            syncMutation.mutate();
          }}
          onThemeChange={selectThemePreference}
          onToggleAgentNotifications={() => {
            setSyncFeedbackWarning(false);
            void agentPostNotifications.toggle();
          }}
          onReset={() => resetMutation.mutate()}
        />
      </header>
      {quickOpenVisible && (
        <QuickOpenPalette
          open
          returnFocusElement={quickOpenReturnFocus}
          files={files}
          openDocuments={openDocuments}
          activeDocument={activeDocument}
          loading={treeQuery.isPending}
          error={treeQuery.error}
          includePullRequestDocument={false}
          onClose={() => setQuickOpenVisible(false)}
          onOpen={(document, openInRightPane) =>
            navigateToDocument(document, openInRightPane ? "right" : "left")
          }
        />
      )}
      <ErrorNotice error={actionError} />
      {syncFeedback && (
        <div
          className={`sync-feedback${syncFeedbackWarning ? " sync-feedback-warning" : ""}`}
          role="status"
        >
          {syncFeedback}
        </div>
      )}
      {repositoryReview.sourceSyncError && (
        <p className="issue-stale-notice">
          default branchの最新sourceを取得できなかったため、最後に同期できた
          {shortOid(repositoryReview.sourceOid)} を表示しています。
        </p>
      )}
      <ReviewWorkspace
        sidebar={
          <ReviewSidebar
            codeExpanded={codeExpanded}
            commentsExpanded={commentsExpanded}
            mode={sidebarMode}
            unresolvedCommentCount={unresolvedCommentCount}
            onOpenSearch={openSidebarSearch}
            onCodeExpandedChange={setCodeExpanded}
            onCommentsExpandedChange={setCommentsExpanded}
            onModeChange={setSidebarMode}
            explorer={
              <div className="file-panel">
                <ReviewTreeItems
                  issues={issues}
                  walkthroughs={walkthroughs}
                  includePullRequestDocument={false}
                  activeIssueId={activeDocument?.kind === "issue" ? activeDocument.id : null}
                  pullRequestActive={false}
                  activeWalkthroughId={
                    activeDocument?.kind === "walkthrough" ? activeDocument.id : null
                  }
                  issueReference={issueReference}
                  issueAddOpen={issueAddOpen}
                  issueAdding={issueMutation.isPending}
                  removingIssueId={removeIssueMutation.variables?.id ?? null}
                  issueError={issueMutation.error ?? removeIssueMutation.error}
                  onIssueReferenceChange={setIssueReference}
                  onIssueAddOpenChange={setIssueAddOpen}
                  onIssueAdd={() => issueMutation.mutate()}
                  onOpenIssue={openIssue}
                  onRemoveIssue={(issue) => removeIssueMutation.mutate(issue)}
                  onOpenPullRequest={() => undefined}
                  onOpen={(walkthrough, openInRightPane) =>
                    openWalkthrough(walkthrough as RepositoryWalkthroughSummary, openInRightPane)
                  }
                />
                <input
                  value={fileFilter}
                  onChange={(event) => setFileFilter(event.target.value)}
                  placeholder="ファイル名を検索"
                />
                <ErrorNotice error={treeQuery.error} />
                <nav className="file-tree">
                  <FileTree
                    files={filteredFiles}
                    activePath={
                      activeDocument?.kind === "repository-file" ? activeDocument.path : null
                    }
                    filtering={Boolean(fileFilter.trim())}
                    initiallyExpanded="active-file"
                    onOpenFile={(path, openInRightPane) => openFile(path, openInRightPane)}
                  />
                </nav>
              </div>
            }
            search={
              <SearchPanel
                inputRef={searchInputRef}
                query={searchText}
                matchCase={searchMatchCase}
                wholeWord={searchWholeWord}
                changeKindsByPath={new Map()}
                response={debouncedSearch ? searchQuery.data : undefined}
                isFetching={Boolean(debouncedSearch && searchQuery.isFetching)}
                error={debouncedSearch ? searchQuery.error : null}
                onQueryChange={setSearchText}
                onMatchCaseChange={setSearchMatchCase}
                onWholeWordChange={setSearchWholeWord}
                onOpenResult={(result: AnySearchResult, openInRightPane) => {
                  if (!("repositoryReviewId" in result.document)) return;
                  openFile(result.path, openInRightPane, result.document.sourceOid, result.line);
                }}
              />
            }
            comments={
              <>
                <ErrorNotice error={commentsQuery.error} />
                <CommentSidebar
                  comments={comments}
                  walkthroughs={walkthroughs}
                  review={review}
                  loadPlacement={(comment) =>
                    Promise.resolve(
                      placements.get(comment.id) ?? {
                        outdated: true,
                        range: null,
                        path: null,
                      },
                    )
                  }
                  themePreference={themePreference}
                  onCommentActiveChange={handleCommentActiveChange}
                  onOpenCodeReference={(sourceOid, reference, openInRightPane) =>
                    openCodeReference(
                      sourceOid,
                      reference,
                      openInRightPane ? "right" : "left",
                      "exact-source",
                    )
                  }
                  onOpenTarget={openCommentTarget}
                  onOpenRepositoryLink={openRepositoryLink}
                />
              </>
            }
          />
        }
        leftPane={renderDocumentPane("left")}
        {...(rightPaneVisible ? { rightPane: renderDocumentPane("right") } : {})}
      />
    </main>
  );
}
