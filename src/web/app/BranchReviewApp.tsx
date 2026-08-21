import fuzzysort from "fuzzysort";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BranchDocumentContent,
  BranchReview,
  BranchReviewComment,
  BranchSearchResponse,
  BranchWalkthrough,
  BranchWalkthroughSummary,
  CodeReference,
  CommentPlacement,
  IssueDocument,
  TreeEntry,
} from "../../domain/models.js";
import { api, ApiError, jsonRequest } from "../api.js";
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
  otherDocumentPane,
  type ActiveDocument,
  type DocumentPaneId,
} from "../document-workspace.js";
import {
  parseReadingHistoryEntry,
  readingHistoryState,
  sameReadingDocument,
  type ReadingHistoryEntry,
  type ReadingLocator,
} from "../reading-history.js";
import type { AnyReviewComment } from "../review-context.js";
import { reviewQueryKeys } from "../review-query-keys.js";
import type { ThemePreference } from "../theme.js";
import { useDebouncedValue } from "../use-debounced-value.js";
import { useDocumentWorkspace } from "../use-document-workspace.js";
import { useThemePreference } from "../use-theme-preference.js";
import { useReviewSidebarSearch } from "../use-review-sidebar-search.js";
import { useQuickOpenShortcut } from "../use-quick-open-shortcut.js";
import { viewerHeartbeatRequest } from "../viewer-session.js";

const DocumentViewer = lazy(async () => {
  const module = await import("../components/DocumentViewer.js");
  return { default: module.DocumentViewer };
});
const WalkthroughViewer = lazy(async () => {
  const module = await import("../components/WalkthroughViewer.js");
  return { default: module.WalkthroughViewer };
});

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

export function BranchReviewApp({
  branchReviewId,
  initialThemePreference,
}: {
  branchReviewId: string;
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
  const [viewerNavigationTarget, setViewerNavigationTarget] =
    useState<ViewerNavigationTarget | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const navigationSequence = useRef(0);
  const attemptedInitialSync = useRef(false);
  const observedChangeSequence = useRef<number | null>(null);
  const readingHistoryReady = useRef(false);
  const paneElements = useRef<Record<DocumentPaneId, HTMLElement | null>>({
    left: null,
    right: null,
  });
  const documentScrollPositions = useRef(new Map<string, number>());
  const resetViewerNavigation = useCallback((): void => setViewerNavigationTarget(null), []);
  const {
    workspace,
    workspaceRef,
    setWorkspace,
    activateDocument: activateWorkspaceDocument,
    openDocument: openWorkspaceDocument,
    closeDocument,
    closePaneDocuments,
    moveDocument,
    dropDocument,
  } = useDocumentWorkspace(resetViewerNavigation, null);
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
  const reviewHistoryKey = `branch:${branchReviewId}`;

  const reviewQuery = useQuery({
    queryKey: reviewQueryKeys.review("branch", branchReviewId),
    queryFn: async () => await api<BranchReviewResponse>(`/api/branch-reviews/${branchReviewId}`),
  });
  const treeQuery = useQuery({
    queryKey: reviewQueryKeys.tree("branch", branchReviewId),
    queryFn: async () =>
      await api<BranchTreeResponse>(`/api/branch-reviews/${branchReviewId}/tree`),
  });
  const changeSequence = useQuery({
    queryKey: reviewQueryKeys.changeSequence(),
    queryFn: async () =>
      await api<{ changeSequence: number }>("/api/meta/change-sequence", viewerHeartbeatRequest()),
    refetchInterval: 1_000,
    refetchIntervalInBackground: true,
    networkMode: "always",
  });
  const commentsQuery = useQuery({
    queryKey: reviewQueryKeys.comments(
      "branch",
      branchReviewId,
      changeSequence.data?.changeSequence,
    ),
    queryFn: async () =>
      await api<BranchCommentsResponse>(
        `/api/branch-reviews/${branchReviewId}/comments?resolved=all`,
      ),
  });
  const searchQuery = useQuery({
    queryKey: ["branch-search", branchReviewId, debouncedSearch, searchMatchCase, searchWholeWord],
    queryFn: async ({ signal }) => {
      const parameters = new URLSearchParams({
        q: debouncedSearch,
        matchCase: String(searchMatchCase),
        wholeWord: String(searchWholeWord),
      });
      return await api<BranchSearchResponse>(
        `/api/branch-reviews/${branchReviewId}/search?${parameters.toString()}`,
        { signal },
      );
    },
    enabled: Boolean(debouncedSearch),
    placeholderData: (previousData) => previousData,
  });

  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: reviewQueryKeys.review("branch", branchReviewId) }),
      queryClient.invalidateQueries({ queryKey: reviewQueryKeys.tree("branch", branchReviewId) }),
      queryClient.invalidateQueries({ queryKey: reviewQueryKeys.document() }),
      queryClient.invalidateQueries({ queryKey: reviewQueryKeys.annotations() }),
      queryClient.invalidateQueries({ queryKey: reviewQueryKeys.search("branch", branchReviewId) }),
      queryClient.invalidateQueries({
        queryKey: reviewQueryKeys.comments("branch", branchReviewId),
      }),
      queryClient.invalidateQueries({
        queryKey: reviewQueryKeys.commentPlacement("branch", branchReviewId),
      }),
      queryClient.invalidateQueries({
        queryKey: reviewQueryKeys.walkthroughs("branch", branchReviewId),
      }),
    ]);
  }, [branchReviewId, queryClient]);

  useEffect(() => {
    const nextSequence = changeSequence.data?.changeSequence;
    if (nextSequence === undefined) return;
    const previousSequence = observedChangeSequence.current;
    observedChangeSequence.current = nextSequence;
    if (previousSequence === null || previousSequence === nextSequence) return;
    void refresh();
  }, [changeSequence.data?.changeSequence, refresh]);

  const syncMutation = useMutation({
    mutationFn: async () =>
      await api<{ branchReview: BranchReview }>(
        `/api/branch-reviews/${branchReviewId}/sync`,
        jsonRequest({}),
      ),
    onSuccess: async ({ branchReview }) => {
      setSyncFeedback(
        `${branchReview.defaultBranchName} · ${shortOid(branchReview.sourceOid)} に同期しました。`,
      );
      window.setTimeout(() => setSyncFeedback(null), 3_000);
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
        `/api/branch-reviews/${branchReviewId}/issues`,
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
      deleteCommentDraftForIssue(branchReviewId, issue.id);
      for (const comment of comments) {
        if (comment.target.kind === "issue" && comment.target.issueId === issue.id) {
          deleteCommentReplyDraftsForComment(branchReviewId, comment.id);
        }
      }
      const openIssue = workspaceRef.current.documents.find(
        (document) => document.kind === "issue" && document.id === issue.id,
      );
      if (openIssue) closeDocument(openIssue);
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
      clearCommentDraftsForReview(branchReviewId);
      const next = new URL(window.location.href);
      next.search = `?branchReviewId=${encodeURIComponent(result.branchReview.id)}`;
      window.location.replace(next.toString());
    },
  });

  const currentReadingHistoryEntry = useCallback((): ReadingHistoryEntry | null => {
    const current = workspaceRef.current;
    const pane = current.focusedPane;
    const document = current.active[pane];
    if (!document) return null;
    return {
      version: 1,
      reviewKey: reviewHistoryKey,
      pane,
      document,
      locator: {
        kind: "scroll",
        top:
          paneElements.current[pane]?.scrollTop ??
          documentScrollPositions.current.get(documentTabKey(document)) ??
          0,
      },
    };
  }, [reviewHistoryKey, workspaceRef]);
  const requestNavigation = useCallback(
    (document: ActiveDocument, locator: ReadingLocator): void => {
      navigationSequence.current += 1;
      setViewerNavigationTarget({
        documentKey: documentTabKey(document),
        line: locator.kind === "line" ? locator.line : null,
        ...(locator.kind === "line" && locator.endLine !== undefined
          ? { endLine: locator.endLine }
          : {}),
        requestId: navigationSequence.current,
        resetHorizontal: true,
      });
    },
    [],
  );
  const navigateToDocument = useCallback(
    (
      document: ActiveDocument,
      targetPane?: DocumentPaneId,
      locator: ReadingLocator = { kind: "line", line: null },
      pushHistory = true,
    ): void => {
      const current = workspaceRef.current;
      const pane = targetPane ?? current.panes[documentTabKey(document)] ?? current.focusedPane;
      if (pushHistory && readingHistoryReady.current) {
        const currentEntry = currentReadingHistoryEntry();
        if (currentEntry) {
          window.history.replaceState(readingHistoryState(window.history.state, currentEntry), "");
        }
      }
      openWorkspaceDocument(document, pane);
      requestNavigation(document, locator);
      if (pushHistory && readingHistoryReady.current) {
        const destination: ReadingHistoryEntry = {
          version: 1,
          reviewKey: reviewHistoryKey,
          pane,
          document,
          locator,
        };
        const currentDocument = current.active[current.focusedPane];
        const replace =
          currentDocument &&
          current.focusedPane === pane &&
          sameReadingDocument(currentDocument, document);
        const state = readingHistoryState(window.history.state, destination);
        if (replace) window.history.replaceState(state, "");
        else window.history.pushState(state, "", window.location.href);
      }
    },
    [
      currentReadingHistoryEntry,
      openWorkspaceDocument,
      requestNavigation,
      reviewHistoryKey,
      workspaceRef,
    ],
  );
  useEffect(() => {
    readingHistoryReady.current = true;
    const restore = (event: PopStateEvent): void => {
      const entry = parseReadingHistoryEntry(event.state, reviewHistoryKey);
      if (!entry) return;
      openWorkspaceDocument(entry.document, entry.pane);
      requestNavigation(entry.document, entry.locator);
      if (entry.locator.kind === "scroll") {
        const scrollTop = entry.locator.top;
        window.requestAnimationFrame(() => {
          const pane = paneElements.current[entry.pane];
          if (pane) pane.scrollTop = scrollTop;
        });
      }
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [openWorkspaceDocument, requestNavigation, reviewHistoryKey]);
  useEffect(() => {
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    const warnBeforeBrowserClose = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeBrowserClose);
    return () => {
      window.history.scrollRestoration = previousScrollRestoration;
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
  const openDocuments = workspace.documents;
  const activePane = workspace.focusedPane;
  const activeDocument = workspace.active[activePane];
  const openWalkthroughIds = useMemo(
    () =>
      openDocuments
        .filter(
          (document): document is Extract<ActiveDocument, { kind: "walkthrough" }> =>
            document.kind === "walkthrough",
        )
        .map((document) => document.id),
    [openDocuments],
  );
  const walkthroughDetailQueries = useQueries({
    queries: openWalkthroughIds.map((walkthroughId) => ({
      queryKey: ["walkthrough", "branch", branchReviewId, walkthroughId],
      queryFn: async () =>
        await api<{ walkthrough: BranchWalkthrough }>(
          `/api/branch-reviews/${branchReviewId}/walkthroughs/${walkthroughId}`,
        ),
    })),
  });

  if (!/^[0-9a-f-]{36}$/i.test(branchReviewId)) {
    return <main className="fatal-state">Branch Review IDが不正です。</main>;
  }
  if (reviewQuery.isPending) {
    return <main className="fatal-state">Branch Reviewを読み込んでいます…</main>;
  }
  if (reviewQuery.error || !reviewQuery.data) {
    return (
      <main className="fatal-state">
        <ErrorNotice error={reviewQuery.error} />
      </main>
    );
  }

  const { branchReview, issues, walkthroughs } = reviewQuery.data;
  const review = {
    kind: "branch" as const,
    id: branchReview.id,
    sourceOid: branchReview.sourceOid,
  };
  const commentsWithPlacement = commentsQuery.data?.comments ?? [];
  const comments = commentsWithPlacement.map(({ comment }) => comment);
  const placements = new Map(
    commentsWithPlacement.map(({ comment, latestPlacement }) => [comment.id, latestPlacement]),
  );
  const unresolvedCommentCount = comments.filter((comment) => comment.resolvedAt === null).length;
  const walkthroughDetails = new Map<string, BranchWalkthrough>();
  const loadingWalkthroughIds = new Set<string>();
  openWalkthroughIds.forEach((walkthroughId, index) => {
    const query = walkthroughDetailQueries[index];
    if (query?.data?.walkthrough) walkthroughDetails.set(walkthroughId, query.data.walkthrough);
    if (query?.isPending) loadingWalkthroughIds.add(walkthroughId);
  });
  const rightPaneVisible =
    openDocuments.some((document) => workspace.panes[documentTabKey(document)] === "right") ||
    draggedDocumentKey !== null;
  const openFile = (
    path: string,
    openInRightPane = false,
    sourceOid?: string,
    line: number | null = null,
  ): void => {
    navigateToDocument(repositoryDocument(path, sourceOid), openInRightPane ? "right" : undefined, {
      kind: "line",
      line,
    });
  };
  const openIssue = (issue: IssueDocument, openInOtherPane: boolean): void => {
    navigateToDocument(
      { kind: "issue", id: issue.id, number: issue.number, title: issue.title, url: issue.url },
      openInOtherPane ? "right" : undefined,
    );
  };
  const openWalkthrough = (
    walkthrough: BranchWalkthroughSummary,
    openInOtherPane: boolean,
  ): void => {
    navigateToDocument(
      {
        kind: "walkthrough",
        id: walkthrough.id,
        title: walkthrough.title,
        sourceOid: walkthrough.sourceOid,
      },
      openInOtherPane ? "right" : undefined,
    );
  };
  const openCodeReference = async (
    sourceOid: string,
    reference: CodeReference,
    targetPane: DocumentPaneId,
  ): Promise<string | null> => {
    const parameters = new URLSearchParams({
      kind: "repository-file",
      sourceOid,
      path: reference.path,
    });
    try {
      const response = await api<{ document: BranchDocumentContent }>(
        `/api/branch-reviews/${branchReview.id}/document?${parameters.toString()}`,
      );
      if (response.document.availability !== "available") {
        return `参照先を開けません · ${reference.path}`;
      }
      navigateToDocument(repositoryDocument(reference.path, sourceOid), targetPane, {
        kind: "line",
        line: reference.startLine,
        ...(reference.endLine === null ? {} : { endLine: reference.endLine }),
      });
      return null;
    } catch (error) {
      return error instanceof ApiError && error.code === "NOT_FOUND"
        ? `参照切れ · ${reference.path}`
        : `参照先を取得できません · ${reference.path}`;
    }
  };
  const openCommentTarget = (
    comment: AnyReviewComment,
    placement: CommentPlacement | null,
  ): void => {
    if (!("branchReviewId" in comment)) return;
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
    if (target.kind === "branch") return;
    if (target.kind === "issue") {
      navigateToDocument(
        {
          kind: "issue",
          id: target.issueId,
          number: target.issueNumber,
          title: target.issueTitle,
          url: target.issueUrl,
        },
        undefined,
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
        undefined,
        locator,
      );
      return;
    }
    navigateToDocument(
      placement?.outdated
        ? repositoryDocument(target.path, target.sourceOid)
        : repositoryDocument(placement?.path ?? target.path),
      undefined,
      locator,
    );
  };
  const handleCommentActiveChange = (commentId: string, active: boolean): void => {
    setActiveCommentId((current) => (active ? commentId : current === commentId ? null : current));
  };
  const openRepositoryLink = (
    path: string,
    sourceOid: string,
    openInOtherPane: boolean,
    sourcePane: DocumentPaneId = activePane,
  ): void => {
    navigateToDocument(
      repositoryDocument(path, sourceOid),
      openInOtherPane ? otherDocumentPane(sourcePane) : sourcePane,
    );
  };
  const renderDocumentPane = (paneId: DocumentPaneId) => {
    const paneDocuments = openDocuments.filter(
      (document) => (workspace.panes[documentTabKey(document)] ?? "left") === paneId,
    );
    const paneDocument = workspace.active[paneId];
    const content =
      paneDocument?.kind === "walkthrough" && walkthroughDetails.get(paneDocument.id) ? (
        <LazyLoadBoundary label="ウォークスルー">
          <Suspense
            fallback={<div className="viewer-loading">ウォークスルーを準備しています…</div>}
          >
            <WalkthroughViewer
              walkthrough={walkthroughDetails.get(paneDocument.id)!}
              comments={comments}
              activeCommentId={activeCommentId}
              navigationTarget={
                viewerNavigationTarget?.documentKey === documentTabKey(paneDocument)
                  ? viewerNavigationTarget
                  : null
              }
              onNavigationApplied={() => undefined}
              themePreference={themePreference}
              onCommentActiveChange={handleCommentActiveChange}
              onOpenReference={(walkthrough, reference, openInOtherPane) =>
                openCodeReference(
                  walkthrough.sourceOid,
                  reference,
                  openInOtherPane ? otherDocumentPane(paneId) : paneId,
                )
              }
              onOpenCommentCodeReference={(sourceOid, reference, openInOtherPane) =>
                openCodeReference(
                  sourceOid,
                  reference,
                  openInOtherPane ? otherDocumentPane(paneId) : paneId,
                )
              }
              onOpenRepositoryLink={(path, sourceOid, openInOtherPane) =>
                openRepositoryLink(path, sourceOid, openInOtherPane, paneId)
              }
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
                  ? `${paneId}:branch:${branchReview.id}:issue:${paneDocument.id}`
                  : `${paneId}:branch:${branchReview.id}:repository-file:${paneDocument.path}:${paneDocument.sourceOid ?? branchReview.sourceOid}:${paneDocument.comparisonPolicy ?? ""}`
              }
              review={review}
              selectedOid={branchReview.sourceOid}
              oldOid={null}
              activeDocument={paneDocument}
              documentRevision={
                paneDocument.kind === "issue"
                  ? (issues.find((issue) => issue.id === paneDocument.id)?.bodyHash ?? null)
                  : null
              }
              displayMode="full"
              diffStyle="unified"
              comments={comments}
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
                viewerNavigationTarget?.documentKey === documentTabKey(paneDocument)
                  ? viewerNavigationTarget
                  : null
              }
              onNavigationApplied={() => undefined}
              onOpenMarkdownFragment={(line) =>
                navigateToDocument(paneDocument, paneId, { kind: "line", line })
              }
              onOpenCodeReference={(sourceOid, reference, openInOtherPane) =>
                openCodeReference(
                  sourceOid,
                  reference,
                  openInOtherPane ? otherDocumentPane(paneId) : paneId,
                )
              }
              onOpenRepositoryLink={(path, sourceOid, openInOtherPane) =>
                openRepositoryLink(path, sourceOid, openInOtherPane, paneId)
              }
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
          if (paneDocument) {
            documentScrollPositions.current.set(documentTabKey(paneDocument), scrollTop);
          }
        }}
        onFocus={() =>
          setWorkspace((current) =>
            current.focusedPane === paneId ? current : { ...current, focusedPane: paneId },
          )
        }
        onActivate={(document) => {
          const current = currentReadingHistoryEntry();
          if (current) {
            window.history.replaceState(readingHistoryState(window.history.state, current), "");
          }
          activateWorkspaceDocument(document, paneId);
          requestNavigation(document, {
            kind: "scroll",
            top: documentScrollPositions.current.get(documentTabKey(document)) ?? 0,
          });
        }}
        onClose={closeDocument}
        onCloseOthers={(document) => closePaneDocuments(paneId, document)}
        onCloseAll={() => closePaneDocuments(paneId)}
        onMove={moveDocument}
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
          <span>{branchReview.canonicalName}</span>
          <h1>
            Branch Review · {branchReview.defaultBranchName} · {shortOid(branchReview.sourceOid)}
          </h1>
        </div>
        <div className="review-scope-spacer" />
        <ReviewActionsMenu
          themePreference={themePreference}
          themePending={themeMutation.isPending}
          syncPending={syncMutation.isPending}
          resetPending={resetMutation.isPending}
          resetLabel="Branch Reviewを削除して再構築"
          onOpenQuickOpen={(returnFocusElement) => {
            setQuickOpenReturnFocus(returnFocusElement);
            setQuickOpenVisible(true);
          }}
          onSync={() => {
            setSyncFeedback(null);
            syncMutation.mutate();
          }}
          onThemeChange={selectThemePreference}
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
          activePane={activePane}
          loading={treeQuery.isPending}
          error={treeQuery.error}
          includePullRequestDocument={false}
          onClose={() => setQuickOpenVisible(false)}
          onOpen={(document) => navigateToDocument(document, activePane)}
        />
      )}
      <ErrorNotice error={actionError} />
      {syncFeedback && (
        <div className="sync-feedback" role="status">
          {syncFeedback}
        </div>
      )}
      {branchReview.sourceSyncError && (
        <p className="issue-stale-notice">
          default branchの最新sourceを取得できなかったため、最後に同期できた
          {shortOid(branchReview.sourceOid)} を表示しています。
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
                    openWalkthrough(walkthrough as BranchWalkthroughSummary, openInRightPane)
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
                  if (!("branchReviewId" in result.document)) return;
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
                  onOpenCodeReference={(sourceOid, reference, openInOtherPane) =>
                    openCodeReference(sourceOid, reference, openInOtherPane ? "right" : activePane)
                  }
                  onOpenTarget={openCommentTarget}
                  onOpenRepositoryLink={(path, sourceOid, openInOtherPane) =>
                    openRepositoryLink(path, sourceOid, openInOtherPane)
                  }
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
