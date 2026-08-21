import fuzzysort from "fuzzysort";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { changedFilePath } from "../../domain/changed-file.js";
import type {
  ChangedFile,
  ChangeKind,
  CodeReference,
  CommentPlacement,
  DocumentRef,
  IssueDocument,
  Walkthrough,
  WalkthroughReference,
} from "../../domain/models.js";
import {
  api,
  ApiError,
  type ChangedFilesResponse,
  type CommentsResponse,
  documentUrl,
  type DocumentResponse,
  jsonRequest,
  type PullRequestResponse,
  type SearchResponse,
  type TreeResponse,
  type WalkthroughResponse,
  type WalkthroughsResponse,
} from "../api.js";
import { CommentSidebar } from "../components/CommentSidebar.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import {
  decorateAllFilesWithChanges,
  FileTree,
  type FileTreeFile,
} from "../components/FileTree.js";
import { LazyLoadBoundary } from "../components/LazyLoadBoundary.js";
import { ReviewActionsMenu } from "../components/ReviewActionsMenu.js";
import { ReviewDocumentPane } from "../components/ReviewDocumentPane.js";
import { ReviewSidebar } from "../components/ReviewSidebar.js";
import { ReviewWorkspace } from "../components/ReviewWorkspace.js";
import type { DisplayMode, ViewerNavigationTarget } from "../components/DocumentViewer.js";
import { SearchPanel } from "../components/SearchPanel.js";
import type { AnySearchResult } from "../components/SearchPanel.js";
import { QuickOpenPalette } from "../components/QuickOpenPalette.js";
import type { ThemePreference } from "../theme.js";
import { viewerHeartbeatRequest } from "../viewer-session.js";
import { ReviewTreeItems } from "../components/WalkthroughPanel.js";
import type { AnyReviewComment, AnyWalkthrough, AnyWalkthroughSummary } from "../review-context.js";
import { reviewQueryKeys } from "../review-query-keys.js";
import {
  commitRangeOldOid,
  earliestIncludedCommitOid,
  normalizedCommitRange,
  pullRequestRangeStartOid,
} from "../commit-range.js";
import {
  currentCommitDocument,
  documentTabKey,
  initialDocumentWorkspace,
  normalizeDocumentPanes,
  type ActiveDocument,
  type DocumentPaneId,
} from "../document-workspace.js";
import {
  clearCommentDraftsForReview,
  deleteCommentDraftForIssue,
  deleteCommentReplyDraftsForComment,
} from "../comment-draft-store.js";
import { deriveDocumentViewerState } from "../document-viewer-state.js";
import { useDocumentWorkspace } from "../use-document-workspace.js";
import { useDebouncedValue } from "../use-debounced-value.js";
import { useThemePreference } from "../use-theme-preference.js";
import { useReviewSidebarSearch } from "../use-review-sidebar-search.js";
import { useQuickOpenShortcut } from "../use-quick-open-shortcut.js";
import { useReviewReadingHistory } from "../use-review-reading-history.js";
const DocumentViewer = lazy(async () => {
  const module = await import("../components/DocumentViewer.js");
  return { default: module.DocumentViewer };
});
const WalkthroughViewer = lazy(async () => {
  const module = await import("../components/WalkthroughViewer.js");
  return { default: module.WalkthroughViewer };
});
const BranchReviewApp = lazy(async () => {
  const module = await import("./BranchReviewApp.js");
  return { default: module.BranchReviewApp };
});

function changePath(change: ChangedFile): string {
  return changedFilePath(change) ?? "(unknown)";
}

function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

type DocumentDisplayMode = "full" | "diff";

function CommitRangePicker({
  commits,
  selectedStartOid,
  selectedEndOid,
  latestHeadOid,
  specialSelected,
  specialSelectionLabel,
  onChange,
}: {
  commits: PullRequestResponse["commits"];
  selectedStartOid: string;
  selectedEndOid: string;
  latestHeadOid: string | null;
  specialSelected: boolean;
  specialSelectionLabel: string;
  onChange: (startOid: string, endOid: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dragAnchorOid, setDragAnchorOid] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const commitDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [],
  );
  const startIndex = commits.findIndex((commit) => commit.oid === selectedStartOid);
  const endIndex = commits.findIndex((commit) => commit.oid === selectedEndOid);
  const rangeValid = startIndex >= 0 && endIndex >= startIndex;
  const selectedCount = rangeValid ? endIndex - startIndex + 1 : 1;
  const startCommit = commits[startIndex];
  const endCommit = commits[endIndex];
  const latestSelected = selectedEndOid === latestHeadOid;
  const pullRequestSelected = rangeValid && startIndex === 0 && latestSelected;
  const selectionBadge = pullRequestSelected ? "PR全体" : latestSelected ? "最新" : null;
  const rangeSummary = specialSelected
    ? `${specialSelectionLabel} · ${shortOid(selectedEndOid)}`
    : selectedCount === 1
      ? `${endCommit?.subject ?? "commit"} · ${shortOid(selectedEndOid)}`
      : `${startCommit?.subject ?? "commit"} … ${endCommit?.subject ?? "commit"}`;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  useEffect(() => {
    if (!dragAnchorOid) return;
    const finishSelection = (): void => {
      setDragAnchorOid(null);
      setOpen(false);
    };
    window.addEventListener("pointerup", finishSelection, { once: true });
    window.addEventListener("pointercancel", finishSelection, { once: true });
    return () => {
      window.removeEventListener("pointerup", finishSelection);
      window.removeEventListener("pointercancel", finishSelection);
    };
  }, [dragAnchorOid]);

  const selectRange = (firstOid: string, secondOid: string): void => {
    const range = normalizedCommitRange(commits, firstOid, secondOid);
    if (range) onChange(range.startOid, range.endOid);
  };
  const beginPointerSelection = (
    event: ReactPointerEvent<HTMLButtonElement>,
    oid: string,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (event.shiftKey) {
      selectRange(selectedEndOid, oid);
      setOpen(false);
      return;
    }
    setDragAnchorOid(oid);
    onChange(oid, oid);
  };
  const extendPointerSelection = (oid: string): void => {
    if (dragAnchorOid) selectRange(dragAnchorOid, oid);
  };
  const selectWithKeyboard = (oid: string, extend: boolean): void => {
    selectRange(extend ? selectedEndOid : oid, oid);
    setOpen(false);
  };
  const earliestOid = commits[0]?.oid;
  const latestOid =
    latestHeadOid && commits.some((commit) => commit.oid === latestHeadOid)
      ? latestHeadOid
      : commits.at(-1)?.oid;

  return (
    <div className="commit-range-picker" ref={pickerRef}>
      <button
        className="commit-range-trigger"
        aria-label={`対象commit: ${rangeSummary}${selectedCount > 1 ? `、${selectedCount} commits` : ""}${selectionBadge ? `、${selectionBadge}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="commit-range-summary">{rangeSummary}</span>
        {selectedCount > 1 && <span className="commit-range-count">{selectedCount} commits</span>}
        {selectionBadge && <span className="commit-selection-badge">{selectionBadge}</span>}
        <span className="commit-range-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="commit-range-popover" role="dialog" aria-label="対象commitを選択">
          <div className="commit-range-shortcuts">
            <button
              disabled={!earliestOid || !latestOid}
              onClick={() => {
                if (earliestOid && latestOid) onChange(earliestOid, latestOid);
                setOpen(false);
              }}
            >
              PR全体
            </button>
            <button
              disabled={!latestOid}
              onClick={() => {
                if (latestOid) onChange(latestOid, latestOid);
                setOpen(false);
              }}
            >
              最新だけ
            </button>
          </div>
          <p className="commit-range-hint">クリックで1件・ドラッグで連続範囲を選択</p>
          <div className="commit-range-list" role="listbox" aria-multiselectable="true">
            {specialSelected && (
              <div className="commit-range-special" aria-current="true">
                {specialSelectionLabel} · {shortOid(selectedEndOid)}
              </div>
            )}
            {[...commits].reverse().map((commit, reverseIndex) => {
              const commitIndex = commits.length - reverseIndex - 1;
              const selected = rangeValid && commitIndex >= startIndex && commitIndex <= endIndex;
              const boundary = selected
                ? startIndex === endIndex
                  ? "single"
                  : commitIndex === endIndex
                    ? "end"
                    : commitIndex === startIndex
                      ? "start"
                      : "middle"
                : null;
              const isLatest = commit.oid === latestHeadOid;
              return (
                <button
                  className={`commit-range-option${selected ? " selected" : ""}${boundary ? ` commit-range-option--${boundary}` : ""}`}
                  role="option"
                  aria-selected={selected}
                  aria-label={`${commit.subject}、${shortOid(commit.oid)}${isLatest ? "、最新" : ""}`}
                  key={commit.oid}
                  onPointerDown={(event) => beginPointerSelection(event, commit.oid)}
                  onPointerEnter={() => extendPointerSelection(commit.oid)}
                  onClick={(event) => {
                    if (event.detail === 0) selectWithKeyboard(commit.oid, event.shiftKey);
                  }}
                >
                  <span className="commit-range-option-indicator" aria-hidden="true" />
                  <span className="commit-range-option-copy">
                    <strong>{commit.subject}</strong>
                    <span className="commit-range-option-meta">
                      <code>{shortOid(commit.oid)}</code>
                      <time dateTime={commit.authoredAt}>
                        {commitDateFormatter.format(new Date(commit.authoredAt))}
                      </time>
                    </span>
                  </span>
                  {isLatest && <span className="commit-latest-badge">最新</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewScopeBar({
  selectedOid,
  selectedStartOid,
  commits,
  latestHeadOid,
  specialSelected,
  specialSelectionLabel,
  documentDisplayMode,
  diffStyle,
  comparisonAvailable,
  diffViewAvailable,
  onCommitRangeChange,
  onDisplayModeChange,
  onDiffStyleChange,
}: {
  selectedOid: string;
  selectedStartOid: string;
  commits: PullRequestResponse["commits"];
  latestHeadOid: string | null;
  specialSelected: boolean;
  specialSelectionLabel: string;
  documentDisplayMode: DocumentDisplayMode;
  diffStyle: "unified" | "split";
  comparisonAvailable: boolean;
  diffViewAvailable: boolean;
  onCommitRangeChange: (startOid: string, endOid: string) => void;
  onDisplayModeChange: (mode: DocumentDisplayMode) => void;
  onDiffStyleChange: (diffStyle: "unified" | "split") => void;
}) {
  return (
    <section className="review-scope-bar" aria-label="レビュー範囲">
      <div className="review-scope-control review-scope-commits">
        <span>対象commit</span>
        <CommitRangePicker
          commits={commits}
          selectedStartOid={selectedStartOid}
          selectedEndOid={selectedOid}
          latestHeadOid={latestHeadOid}
          specialSelected={specialSelected}
          specialSelectionLabel={specialSelectionLabel}
          onChange={onCommitRangeChange}
        />
      </div>
      <div className="review-scope-control review-scope-display">
        <span>表示</span>
        <div className="segmented" aria-label="文書表示">
          <button
            className={documentDisplayMode === "full" ? "active" : ""}
            aria-pressed={documentDisplayMode === "full"}
            onClick={() => onDisplayModeChange("full")}
          >
            全文
          </button>
          <button
            className={documentDisplayMode === "diff" ? "active" : ""}
            aria-pressed={documentDisplayMode === "diff"}
            disabled={!comparisonAvailable}
            onClick={() => onDisplayModeChange("diff")}
          >
            変更
          </button>
        </div>
      </div>
      <div className="review-scope-control review-scope-style">
        <span>Diff表示</span>
        <div className="segmented diff-style-modes" aria-label="Diff表示">
          <button
            className={diffStyle === "unified" ? "active" : ""}
            aria-pressed={diffStyle === "unified"}
            disabled={!diffViewAvailable}
            onClick={() => {
              onDisplayModeChange("diff");
              onDiffStyleChange("unified");
            }}
          >
            stacked
          </button>
          <button
            className={diffStyle === "split" ? "active" : ""}
            aria-pressed={diffStyle === "split"}
            disabled={!diffViewAvailable}
            onClick={() => {
              onDisplayModeChange("diff");
              onDiffStyleChange("split");
            }}
          >
            split
          </button>
        </div>
      </div>
    </section>
  );
}

const SYNC_FEEDBACK_DURATION_MS = 3_000;

function pullRequestLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "PULL_REQUEST_NOT_FOUND") {
    return "Pull Requestが見つかりません。`rvw open`から起動し直してください。";
  }
  return error instanceof Error ? error.message : "PR commitがありません。";
}

function PullRequestApp({ initialThemePreference }: { initialThemePreference: ThemePreference }) {
  const queryClient = useQueryClient();
  const pullRequestIdParameter = new URL(window.location.href).searchParams.get("pullRequestId");
  const pullRequestIdValid = Boolean(
    pullRequestIdParameter &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      pullRequestIdParameter,
    ),
  );
  const pullRequestId = pullRequestIdValid ? pullRequestIdParameter : null;
  const reviewHistoryKey = pullRequestId ? `pull-request:${pullRequestId}` : null;
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [rangeStartOid, setRangeStartOid] = useState<string | null>(null);
  const [documentDisplayMode, setDocumentDisplayMode] = useState<DocumentDisplayMode>("full");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [codeExpanded, setCodeExpanded] = useState(true);
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [codeNavigationMode, setCodeNavigationMode] = useState<"files" | "search">("files");
  const [treeMode, setTreeMode] = useState<"changed" | "all">("changed");
  const [viewerNavigationTargets, setViewerNavigationTargets] = useState<
    Record<DocumentPaneId, ViewerNavigationTarget | null>
  >({ left: null, right: null });
  const viewerNavigationTargetsRef = useRef(viewerNavigationTargets);
  viewerNavigationTargetsRef.current = viewerNavigationTargets;
  const resetViewerNavigation = useCallback((paneIds: readonly DocumentPaneId[]): void => {
    const uniquePaneIds = [...new Set(paneIds)];
    const nextTargets = { ...viewerNavigationTargetsRef.current };
    for (const paneId of uniquePaneIds) {
      nextTargets[paneId] = null;
    }
    viewerNavigationTargetsRef.current = nextTargets;
    setViewerNavigationTargets((current) => {
      if (uniquePaneIds.every((paneId) => current[paneId] === null)) return current;
      return { ...current, ...Object.fromEntries(uniquePaneIds.map((paneId) => [paneId, null])) };
    });
  }, []);
  const {
    workspace: documentWorkspace,
    workspaceRef: documentWorkspaceRef,
    setWorkspace: setDocumentWorkspace,
    activateDocument: activateWorkspaceDocument,
    openDocument: openWorkspaceDocument,
    closeDocument,
    closePaneDocuments,
    moveDocument,
    dropDocument: dropWorkspaceDocument,
  } = useDocumentWorkspace(resetViewerNavigation);
  const [draggedDocumentKey, setDraggedDocumentKey] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [quickOpenReturnFocus, setQuickOpenReturnFocus] = useState<HTMLElement | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchMatchCase, setSearchMatchCase] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [issueReference, setIssueReference] = useState("");
  const [issueAddOpen, setIssueAddOpen] = useState(false);
  const [reviewStateRevision, setReviewStateRevision] = useState(0);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const {
    themePreference,
    selectThemePreference,
    query: themePreferenceQuery,
    mutation: themePreferenceMutation,
  } = useThemePreference(initialThemePreference);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const handleCommentActiveChange = useCallback((commentId: string, active: boolean): void => {
    setActiveCommentId((current) => (active ? commentId : current === commentId ? null : current));
  }, []);
  const attemptedInitialRefresh = useRef(false);
  const commitRangeTouched = useRef(false);
  const observedLatestHead = useRef<string | null>(null);
  const observedChangeSequence = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const codeReferenceRequestSequence = useRef<Record<DocumentPaneId, number>>({
    left: 0,
    right: 0,
  });
  const debouncedSearch = useDebouncedValue(searchText.trim(), 250);
  const openSidebarSearch = useReviewSidebarSearch({
    searchInputRef,
    onCodeExpandedChange: setCodeExpanded,
    onModeChange: setCodeNavigationMode,
  });
  const openDocuments = useMemo(
    () => [...documentWorkspace.documents.left, ...documentWorkspace.documents.right],
    [documentWorkspace.documents.left, documentWorkspace.documents.right],
  );
  const activePane = documentWorkspace.focusedPane;
  const activeDocument = documentWorkspace.active[activePane];
  const paneElements = useRef<Record<DocumentPaneId, HTMLElement | null>>({
    left: null,
    right: null,
  });
  const documentScrollPositions = useRef(new Map<string, number>());
  const {
    activateDocument,
    initializeReadingHistory,
    markLineNavigationApplied,
    navigateToDocument,
    navigateToMarkdownFragment,
    recordPaneScroll,
  } = useReviewReadingHistory({
    reviewKey: reviewHistoryKey,
    workspace: documentWorkspace,
    workspaceRef: documentWorkspaceRef,
    paneElements,
    documentScrollPositions,
    viewerNavigationTargets,
    setViewerNavigationTargets,
    openWorkspaceDocument,
    activateWorkspaceDocument,
    scrollRevision: reviewStateRevision,
  });

  const openDocument = useCallback(
    (document: ActiveDocument, targetPane?: DocumentPaneId): void =>
      navigateToDocument(document, targetPane),
    [navigateToDocument],
  );

  useEffect(() => {
    if (!syncFeedback) return;
    const timeoutId = window.setTimeout(() => setSyncFeedback(null), SYNC_FEEDBACK_DURATION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [syncFeedback]);

  const dropDocument = useCallback(
    (documentKey: string, sourcePane: DocumentPaneId, targetPane: DocumentPaneId): void => {
      dropWorkspaceDocument(documentKey, sourcePane, targetPane);
      setDraggedDocumentKey(null);
    },
    [dropWorkspaceDocument],
  );

  const pullRequestQuery = useQuery({
    queryKey: reviewQueryKeys.review("pull-request", pullRequestId),
    queryFn: async () => await api<PullRequestResponse>(`/api/pull-requests/${pullRequestId}`),
    enabled: Boolean(pullRequestId),
  });
  const commits = pullRequestQuery.data?.commits ?? [];
  const comparisonBaseOid = pullRequestQuery.data?.comparisonBaseOid ?? null;
  const latestHeadOid = pullRequestQuery.data?.headOid ?? null;
  const latestPullRequestTitle = pullRequestQuery.data?.pullRequest.latestTitle;

  useEffect(() => {
    document.title = latestPullRequestTitle ? `rvw: ${latestPullRequestTitle}` : "rvw";
  }, [latestPullRequestTitle]);

  const selectedIndex = commits.findIndex((commit) => commit.oid === selectedOid);
  const selectedCommit = commits[selectedIndex];
  const rangeStartIndex = commits.findIndex((commit) => commit.oid === rangeStartOid);
  const defaultRangeStartOid = selectedOid ? earliestIncludedCommitOid(commits, selectedOid) : null;
  const rangeStartValid = rangeStartIndex >= 0 && rangeStartIndex <= selectedIndex;
  const effectiveOldOid = commitRangeOldOid(commits, comparisonBaseOid, rangeStartOid);
  useEffect(() => {
    const previousLatest = observedLatestHead.current;
    if (latestHeadOid && (!selectedOid || selectedOid === previousLatest)) {
      const shouldKeepSingleCommit = Boolean(
        commitRangeTouched.current && selectedOid && rangeStartOid === selectedOid,
      );
      const preservedStartIsValid = commits.some((commit) => commit.oid === rangeStartOid);
      setSelectedOid(latestHeadOid);
      setRangeStartOid(
        !commitRangeTouched.current
          ? pullRequestRangeStartOid(commits, latestHeadOid)
          : shouldKeepSingleCommit
            ? latestHeadOid
            : preservedStartIsValid
              ? rangeStartOid
              : earliestIncludedCommitOid(commits, latestHeadOid),
      );
    }
    observedLatestHead.current = latestHeadOid;
  }, [commits, latestHeadOid, rangeStartOid, selectedOid]);
  useEffect(() => {
    if (!rangeStartValid) {
      setRangeStartOid(defaultRangeStartOid);
    }
  }, [defaultRangeStartOid, rangeStartValid]);

  const displayMode: DisplayMode =
    documentDisplayMode === "full" ? "full" : rangeStartIndex === 0 ? "pull-request" : "range";

  useEffect(() => {
    if (!pullRequestId || !pullRequestQuery.isSuccess || !selectedOid) return;
    initializeReadingHistory();
  }, [initializeReadingHistory, pullRequestId, pullRequestQuery.isSuccess, selectedOid]);

  useEffect(() => {
    const warnBeforeBrowserClose = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeBrowserClose);
    return () => window.removeEventListener("beforeunload", warnBeforeBrowserClose);
  }, []);
  useQuickOpenShortcut(() => {
    setQuickOpenReturnFocus(null);
    setQuickOpenVisible(true);
  });
  const selectCommitRange = (startOid: string, endOid: string): void => {
    const range = normalizedCommitRange(commits, startOid, endOid);
    if (!range) return;
    commitRangeTouched.current = true;
    setRangeStartOid(range.startOid);
    setSelectedOid(range.endOid);
    if (range.endOid !== selectedOid) {
      resetViewerNavigation(["left", "right"]);
      setDocumentWorkspace((current) => ({
        ...current,
        documents: {
          left: current.documents.left.map(currentCommitDocument),
          right: current.documents.right.map(currentCommitDocument),
        },
        active: {
          left: current.active.left ? currentCommitDocument(current.active.left) : null,
          right: current.active.right ? currentCommitDocument(current.active.right) : null,
        },
      }));
    }
  };

  const treeQuery = useQuery({
    queryKey: ["tree", pullRequestId, selectedOid],
    queryFn: async () =>
      await api<TreeResponse>(
        `/api/pull-requests/${pullRequestId}/tree?oid=${encodeURIComponent(selectedOid!)}`,
      ),
    enabled: Boolean(pullRequestId && selectedOid),
  });
  const changedQuery = useQuery({
    queryKey: ["changed-files", pullRequestId, effectiveOldOid, selectedOid],
    queryFn: async () =>
      await api<ChangedFilesResponse>(
        `/api/pull-requests/${pullRequestId}/changed-files?oldOid=${encodeURIComponent(effectiveOldOid!)}&newOid=${encodeURIComponent(selectedOid!)}`,
      ),
    enabled: Boolean(
      pullRequestId &&
      effectiveOldOid &&
      selectedOid &&
      selectedIndex >= 0 &&
      effectiveOldOid !== selectedOid,
    ),
  });
  const changeSequence = useQuery({
    queryKey: reviewQueryKeys.changeSequence(),
    queryFn: async () =>
      await api<{ changeSequence: number }>("/api/meta/change-sequence", viewerHeartbeatRequest()),
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
    networkMode: "always",
  });
  useEffect(() => {
    const nextSequence = changeSequence.data?.changeSequence;
    if (nextSequence === undefined) return;
    const previousSequence = observedChangeSequence.current;
    observedChangeSequence.current = nextSequence;
    if (previousSequence === null || previousSequence === nextSequence) return;
    void queryClient.invalidateQueries({ queryKey: ["pull-request"] });
    void queryClient.invalidateQueries({ queryKey: reviewQueryKeys.document() });
    void queryClient.invalidateQueries({ queryKey: reviewQueryKeys.annotations() });
    void queryClient.invalidateQueries({ queryKey: ["comment-placement"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    void queryClient.invalidateQueries({ queryKey: ["walkthroughs"] });
    void queryClient.invalidateQueries({ queryKey: ["walkthrough"] });
  }, [changeSequence.data?.changeSequence, queryClient]);
  const commentsQuery = useQuery({
    queryKey: reviewQueryKeys.comments(
      "pull-request",
      pullRequestId,
      changeSequence.data?.changeSequence,
    ),
    queryFn: async () =>
      await api<CommentsResponse>(`/api/pull-requests/${pullRequestId}/comments?resolved=all`),
    enabled: Boolean(pullRequestId),
    placeholderData: (previousData) =>
      previousData?.comments.every((comment) => comment.pullRequestId === pullRequestId)
        ? previousData
        : undefined,
  });
  const comments = commentsQuery.data?.comments ?? [];
  const unresolvedCommentCount = comments.filter((comment) => !comment.resolvedAt).length;
  const issuesQuery = useQuery({
    queryKey: reviewQueryKeys.issues(pullRequestId, changeSequence.data?.changeSequence),
    queryFn: async () =>
      await api<{ issues: IssueDocument[] }>(`/api/pull-requests/${pullRequestId}/issues`),
    enabled: Boolean(pullRequestId),
  });
  const issues = issuesQuery.data?.issues ?? [];
  const addIssueMutation = useMutation({
    mutationFn: async () =>
      await api(
        `/api/pull-requests/${pullRequestId}/issues`,
        jsonRequest({ issue: issueReference }),
      ),
    onSuccess: async () => {
      setIssueReference("");
      setIssueAddOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["issues", pullRequestId] });
    },
  });
  const removeIssueMutation = useMutation({
    mutationFn: async (issue: IssueDocument) => {
      const endpoint = `/api/pull-requests/${pullRequestId}/issues/${issue.id}`;
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
        `Issue #${issue.number} ${issue.title} をこのPull Request Reviewから削除します。\n\nIssue全体コメント ${preview.counts.issueWholeComments}\nIssue本文rangeコメント ${preview.counts.issueRangeComments}\n返信 ${preview.counts.replies}\n\nこの操作は元に戻せません。`,
      );
      if (!confirmed) return null;
      return await api(endpoint, {
        ...jsonRequest({ yes: true }),
        method: "DELETE",
      });
    },
    onSuccess: async (result, issue) => {
      if (!result || !pullRequestId) return;
      deleteCommentDraftForIssue(pullRequestId, issue.id);
      for (const comment of comments) {
        if (comment.target.kind === "issue" && comment.target.issueId === issue.id) {
          deleteCommentReplyDraftsForComment(pullRequestId, comment.id);
        }
      }
      for (const paneId of ["left", "right"] as const) {
        const openIssue = documentWorkspaceRef.current.documents[paneId].find(
          (document) => document.kind === "issue" && document.id === issue.id,
        );
        if (openIssue) closeDocument(openIssue, paneId);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["issues", pullRequestId] }),
        queryClient.invalidateQueries({ queryKey: ["comments"] }),
        queryClient.invalidateQueries({ queryKey: ["change-sequence"] }),
      ]);
    },
  });
  const walkthroughsQuery = useQuery({
    queryKey: ["walkthroughs", pullRequestId],
    queryFn: async () =>
      await api<WalkthroughsResponse>(`/api/pull-requests/${pullRequestId}/walkthroughs`),
    enabled: Boolean(pullRequestId),
  });
  const walkthroughs = walkthroughsQuery.data?.walkthroughs ?? [];
  useEffect(() => {
    if (!walkthroughsQuery.isSuccess) return;
    const summaries = new Map(walkthroughs.map((walkthrough) => [walkthrough.id, walkthrough]));
    setDocumentWorkspace((current) => {
      const rebind = (document: ActiveDocument | null): ActiveDocument | null => {
        if (document?.kind !== "walkthrough") return document;
        const summary = summaries.get(document.id);
        return summary
          ? {
              kind: "walkthrough",
              id: summary.id,
              title: summary.title,
              sourceOid: summary.sourceOid,
            }
          : null;
      };
      const documents = {
        left: current.documents.left
          .map(rebind)
          .filter((document): document is ActiveDocument => document !== null),
        right: current.documents.right
          .map(rebind)
          .filter((document): document is ActiveDocument => document !== null),
      };
      const activeDocument = (
        paneId: DocumentPaneId,
        document: ActiveDocument | null,
      ): ActiveDocument | null => {
        const rebound = rebind(document);
        if (
          rebound &&
          documents[paneId].some(
            (candidate) => documentTabKey(candidate) === documentTabKey(rebound),
          )
        ) {
          return rebound;
        }
        return documents[paneId][0] ?? null;
      };
      return normalizeDocumentPanes({
        ...current,
        documents: {
          left: documents.left,
          right: documents.right,
        },
        active: {
          left: activeDocument("left", current.active.left),
          right: activeDocument("right", current.active.right),
        },
      });
    });
  }, [walkthroughsQuery.data?.walkthroughs, walkthroughsQuery.isSuccess]);
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
      queryKey: ["walkthrough", pullRequestId, walkthroughId],
      queryFn: async () =>
        await api<WalkthroughResponse>(
          `/api/pull-requests/${pullRequestId}/walkthroughs/${walkthroughId}`,
        ),
      enabled: Boolean(pullRequestId),
    })),
  });
  const walkthroughDetails = new Map<string, Walkthrough>();
  const loadingWalkthroughIds = new Set<string>();
  openWalkthroughIds.forEach((walkthroughId, index) => {
    const query = walkthroughDetailQueries[index];
    const walkthrough = query?.data?.walkthrough;
    if (walkthrough) walkthroughDetails.set(walkthroughId, walkthrough);
    if (query?.isPending) loadingWalkthroughIds.add(walkthroughId);
  });

  const allFiles = useMemo<FileTreeFile[]>(() => {
    const changes = changedQuery.data?.files ?? [];
    return decorateAllFilesWithChanges(
      (treeQuery.data?.entries ?? []).map((entry) => ({
        path: entry.path,
        entryKind: entry.kind,
      })),
      changes,
    );
  }, [changedQuery.data?.files, treeQuery.data?.entries]);
  const files = useMemo<FileTreeFile[]>(() => {
    if (treeMode === "changed") {
      return (changedQuery.data?.files ?? []).map((change) => ({
        path: changePath(change),
        entryKind: "file",
        changeKind: change.kind,
      }));
    }
    return allFiles;
  }, [allFiles, changedQuery.data?.files, treeMode]);
  const tabChangeKinds = useMemo(() => {
    const kinds = new Map<string, ChangeKind>();
    for (const change of changedQuery.data?.files ?? []) {
      kinds.set(changePath(change), change.kind);
      if (change.oldPath) kinds.set(change.oldPath, change.kind);
      if (change.newPath) kinds.set(change.newPath, change.kind);
    }
    return kinds;
  }, [changedQuery.data?.files]);
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

  const searchQuery = useQuery({
    queryKey: [
      "search",
      pullRequestId,
      selectedOid,
      debouncedSearch,
      searchMatchCase,
      searchWholeWord,
    ],
    queryFn: async ({ signal }) => {
      const parameters = new URLSearchParams({
        oid: selectedOid!,
        q: debouncedSearch,
        matchCase: String(searchMatchCase),
        wholeWord: String(searchWholeWord),
      });
      return await api<SearchResponse>(
        `/api/pull-requests/${pullRequestId}/search?${parameters.toString()}`,
        { signal },
      );
    },
    enabled: Boolean(pullRequestId && selectedOid && debouncedSearch),
  });

  const refreshMutation = useMutation({
    mutationFn: async (options: { announce: boolean }) => {
      void options;
      return await api<PullRequestResponse>(
        `/api/pull-requests/${pullRequestId}/refresh`,
        jsonRequest({}),
      );
    },
    onSuccess: async (result, options) => {
      const wasAtLatest = selectedOid === latestHeadOid;
      const wasSingleCommit = rangeStartOid === selectedOid;
      const previousStartOid = rangeStartOid;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pull-request"] }),
        queryClient.invalidateQueries({ queryKey: ["document"] }),
        queryClient.invalidateQueries({ queryKey: ["annotations"] }),
        queryClient.invalidateQueries({ queryKey: ["comment-placement"] }),
        queryClient.invalidateQueries({ queryKey: ["search"] }),
      ]);
      if (wasAtLatest || !selectedOid) {
        setSelectedOid(result.headOid);
        const previousStartStillExists = result.commits.some(
          (commit) => commit.oid === previousStartOid,
        );
        setRangeStartOid(
          !commitRangeTouched.current
            ? pullRequestRangeStartOid(result.commits, result.headOid)
            : wasSingleCommit
              ? result.headOid
              : previousStartStillExists
                ? previousStartOid
                : earliestIncludedCommitOid(result.commits, result.headOid),
        );
      }
      if (options.announce) {
        setSyncFeedback(
          `GitHubと同期しました · ${new Intl.DateTimeFormat("ja-JP", {
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date())}`,
        );
      }
    },
  });
  useEffect(() => {
    if (!pullRequestQuery.data || attemptedInitialRefresh.current) return;
    attemptedInitialRefresh.current = true;
    refreshMutation.mutate({ announce: false });
  }, [pullRequestQuery.data]);

  const resetMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/pull-requests/${pullRequestId}/reset`,
        jsonRequest({ yes: false }),
      );
      const preview = (await response.json()) as {
        counts?: Record<string, number>;
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
        `ローカルレビュー状態を削除して再構築します。\n\nIssue membership ${counts.issueMemberships ?? 0}\nコメント ${counts.comments ?? 0}\n返信 ${counts.posts ?? 0}\nコメント内コード参照 ${counts.commentReferences ?? 0}\n対象 ${counts.targets ?? 0}\nウォークスルー ${counts.walkthroughs ?? 0}\nウォークスルーコード参照 ${counts.walkthroughReferences ?? 0}\nGit ref ${counts.gitRefs ?? 0}\n\nこの操作は元に戻せません。`,
      );
      if (!confirmed) return null;
      return await api<{
        pullRequest: PullRequestResponse["pullRequest"];
        commits: PullRequestResponse["commits"];
      }>(`/api/pull-requests/${pullRequestId}/reset`, jsonRequest({ yes: true }));
    },
    onSuccess: async (result) => {
      if (!result) return;
      clearCommentDraftsForReview(result.pullRequest.id);
      documentScrollPositions.current.clear();
      setReviewStateRevision((revision) => revision + 1);
      setDocumentWorkspace(initialDocumentWorkspace());
      resetViewerNavigation(["left", "right"]);
      commitRangeTouched.current = false;
      setSelectedOid(result.pullRequest.latestHeadOid);
      setRangeStartOid(pullRequestRangeStartOid(result.commits, result.pullRequest.latestHeadOid));
      setDocumentDisplayMode("full");
      await queryClient.invalidateQueries();
    },
  });

  const openFile = useCallback(
    (filePath: string, openInRightPane = false): void => {
      if (treeMode === "changed") setDocumentDisplayMode("diff");
      openDocument(
        {
          kind: "repository-file",
          path: filePath,
        },
        openInRightPane ? "right" : undefined,
      );
    },
    [openDocument, treeMode],
  );
  const openRepositoryMarkdownLink = useCallback(
    (filePath: string, sourceOid: string, targetPane: DocumentPaneId): void => {
      openDocument(
        {
          kind: "repository-file",
          path: filePath,
          sourceOid,
          comparisonPolicy: "exact-source",
        },
        targetPane,
      );
    },
    [openDocument],
  );
  const openRepositoryMarkdownLinkFromInteraction = useCallback(
    (filePath: string, sourceOid: string, openInRightPane: boolean): void =>
      openRepositoryMarkdownLink(filePath, sourceOid, openInRightPane ? "right" : "left"),
    [openRepositoryMarkdownLink],
  );
  const openSearchResult = (result: AnySearchResult, openInRightPane = false): void => {
    if ("branchReviewId" in result.document) return;
    const requestedDocument: ActiveDocument =
      result.document.kind === "pull-request-markdown"
        ? { kind: "pull-request-markdown" }
        : { kind: "repository-file", path: result.path };
    const workspace = documentWorkspaceRef.current;
    const documentKey = documentTabKey(requestedDocument);
    const targetPane = openInRightPane ? "right" : "left";
    const openDocumentWithSameSource = workspace.documents[targetPane].find((candidate) => {
      if (documentTabKey(candidate) !== documentKey) return false;
      return (
        candidate.kind !== "repository-file" ||
        candidate.sourceOid === undefined ||
        candidate.sourceOid === selectedOid
      );
    });
    const document = openDocumentWithSameSource ?? requestedDocument;
    const activeTarget = workspace.active[targetPane];
    const resetHorizontal = !activeTarget || documentTabKey(activeTarget) !== documentKey;
    navigateToDocument(document, targetPane, { kind: "line", line: result.line }, resetHorizontal);
  };
  const openCommentTarget = (
    comment: AnyReviewComment,
    placement: CommentPlacement | null,
    openInRightPane: boolean,
  ): void => {
    if ("branchReviewId" in comment) return;
    const target = comment.target;
    const targetPane: DocumentPaneId = openInRightPane ? "right" : "left";
    const navigate = (
      document: ActiveDocument,
      startLine: number | null,
      endLine: number | null,
    ): void => {
      navigateToDocument(document, targetPane, {
        kind: "line",
        line: startLine,
        ...(endLine === null ? {} : { endLine }),
      });
    };
    setCommentsExpanded(true);
    setActiveCommentId(comment.id);
    if (target.kind === "pull-request") {
      const document: ActiveDocument = { kind: "pull-request-markdown" };
      navigate(document, null, null);
      return;
    }
    const startLine = placement ? (placement.range?.startLine ?? null) : target.startLine;
    const endLine = placement ? (placement.range?.endLine ?? null) : target.endLine;
    if (target.kind === "walkthrough") {
      const walkthrough = walkthroughs.find((candidate) => candidate.id === target.walkthroughId);
      if (walkthrough) {
        const document: ActiveDocument = {
          kind: "walkthrough",
          id: walkthrough.id,
          title: walkthrough.title,
          sourceOid: walkthrough.sourceOid,
        };
        navigate(document, startLine, endLine);
      }
      return;
    }
    if (target.kind === "issue") {
      const issue = issues.find((candidate) => candidate.id === target.issueId);
      if (issue) {
        navigate(
          { kind: "issue", id: issue.id, number: issue.number, title: issue.title, url: issue.url },
          startLine,
          endLine,
        );
      }
      return;
    }
    if (target.documentKind === "pull-request-markdown") {
      const document: ActiveDocument = { kind: "pull-request-markdown" };
      navigate(document, startLine, endLine);
      return;
    }
    const document: ActiveDocument = {
      kind: "repository-file",
      path: target.path,
      sourceOid: target.sourceOid,
      comparisonPolicy: "exact-source",
    };
    navigate(document, startLine, endLine);
  };
  const openWalkthrough = useCallback(
    (walkthrough: AnyWalkthroughSummary, openInRightPane = false): void => {
      openDocument(
        {
          kind: "walkthrough",
          id: walkthrough.id,
          title: walkthrough.title,
          sourceOid: walkthrough.sourceOid,
        },
        openInRightPane ? "right" : undefined,
      );
    },
    [openDocument],
  );
  const openCodeReference = useCallback(
    async (
      pullRequestId: string,
      sourceOid: string,
      reference: CodeReference,
      targetPane: DocumentPaneId,
      comparisonPolicy: "exact-source" | "selected-range",
    ): Promise<string | null> => {
      codeReferenceRequestSequence.current[targetPane] += 1;
      const requestSequence = codeReferenceRequestSequence.current[targetPane];
      const targetNavigationRevision = documentWorkspaceRef.current.navigationRevision[targetPane];
      const requestIsCurrent = (): boolean =>
        requestSequence === codeReferenceRequestSequence.current[targetPane] &&
        documentWorkspaceRef.current.navigationRevision[targetPane] === targetNavigationRevision;
      const ref: DocumentRef = {
        kind: "repository-file",
        pullRequestId,
        sourceOid,
        path: reference.path,
      };
      try {
        const referencedDocument = await queryClient.fetchQuery({
          queryKey: ["document", ref],
          queryFn: async () => (await api<DocumentResponse>(documentUrl(ref))).document,
        });
        if (!requestIsCurrent()) return null;
        if (referencedDocument.availability !== "available") {
          return referencedDocument.availability === "missing"
            ? `リンク切れ · ${reference.path}`
            : `参照先を表示できません · ${reference.path}`;
        }
      } catch (error) {
        if (!requestIsCurrent()) return null;
        return error instanceof ApiError &&
          ["COMMIT_NOT_FOUND", "DOCUMENT_NOT_FOUND", "NOT_FOUND"].includes(error.code)
          ? `リンク切れ · ${reference.path}`
          : `参照先を開けません · ${reference.path}`;
      }
      const document: ActiveDocument = {
        kind: "repository-file",
        path: reference.path,
        sourceOid,
        comparisonPolicy,
      };
      const documentKey = documentTabKey(document);
      const activeTarget = documentWorkspaceRef.current.active[targetPane];
      const resetHorizontal = !activeTarget || documentTabKey(activeTarget) !== documentKey;
      navigateToDocument(
        document,
        targetPane,
        {
          kind: "line",
          line: reference.startLine,
          ...(reference.endLine === null ? {} : { endLine: reference.endLine }),
        },
        resetHorizontal,
      );
      return null;
    },
    [navigateToDocument, queryClient],
  );
  const openWalkthroughReference = useCallback(
    (
      walkthrough: AnyWalkthrough,
      reference: WalkthroughReference,
      targetPane: DocumentPaneId,
    ): Promise<string | null> => {
      if (!("pullRequestId" in walkthrough)) {
        return Promise.resolve(`参照先を開けません · ${reference.path}`);
      }
      return openCodeReference(
        walkthrough.pullRequestId,
        walkthrough.sourceOid,
        reference,
        targetPane,
        "selected-range",
      );
    },
    [openCodeReference],
  );
  const openWalkthroughReferenceFromInteraction = useCallback(
    (walkthrough: AnyWalkthrough, reference: WalkthroughReference, openInRightPane: boolean) =>
      openWalkthroughReference(walkthrough, reference, openInRightPane ? "right" : "left"),
    [openWalkthroughReference],
  );
  const openCommentCodeReference = useCallback(
    (
      sourceOid: string,
      reference: CodeReference,
      targetPane: DocumentPaneId,
    ): Promise<string | null> => {
      if (!pullRequestId) {
        return Promise.resolve(`参照先を開けません · ${reference.path}`);
      }
      return openCodeReference(pullRequestId, sourceOid, reference, targetPane, "exact-source");
    },
    [openCodeReference, pullRequestId],
  );
  const openCommentCodeReferenceFromInteraction = useCallback(
    (sourceOid: string, reference: CodeReference, openInRightPane: boolean) =>
      openCommentCodeReference(sourceOid, reference, openInRightPane ? "right" : "left"),
    [openCommentCodeReference],
  );

  if (!pullRequestIdParameter) {
    return (
      <main className="fatal-state">
        <h1>rvw</h1>
        <p>Pull Request IDがURLにありません。`rvw open`から起動してください。</p>
      </main>
    );
  }
  if (!pullRequestIdValid || !pullRequestId) {
    return (
      <main className="fatal-state">
        <h1>rvw</h1>
        <p>Pull Request IDの形式が正しくありません。`rvw open`から起動し直してください。</p>
      </main>
    );
  }
  if (pullRequestQuery.isLoading) {
    return (
      <main className="fatal-state">
        <h1>rvw</h1>
        <p>レビュー状態を読み込んでいます…</p>
      </main>
    );
  }
  if (pullRequestQuery.error || !pullRequestQuery.data || !selectedOid) {
    return (
      <main className="fatal-state">
        <h1>rvw</h1>
        <p>{pullRequestLoadErrorMessage(pullRequestQuery.error)}</p>
      </main>
    );
  }

  const pullRequest = pullRequestQuery.data.pullRequest;
  const viewerStateContext = {
    documentDisplayMode,
    displayMode,
    selectedOid,
    changedFiles: changedQuery.data?.files,
    changedFilesLoaded: changedQuery.isSuccess,
    walkthroughDetails,
    loadingWalkthroughIds,
  };
  const paneViewerStates = {
    left: deriveDocumentViewerState(documentWorkspace.active.left, viewerStateContext),
    right: deriveDocumentViewerState(documentWorkspace.active.right, viewerStateContext),
  };
  const specialSelected = selectedCommit === undefined;
  const comparisonAvailable = Boolean(
    !specialSelected &&
    effectiveOldOid &&
    effectiveOldOid !== selectedOid &&
    Object.values(documentWorkspace.active).some(
      (document) => document !== null && document.kind !== "walkthrough",
    ),
  );
  const diffViewAvailable = Boolean(
    comparisonAvailable &&
    Object.values(paneViewerStates).some(
      (state) => state.viewerDocument?.kind === "repository-file" && state.activeChange,
    ),
  );
  const actionError =
    refreshMutation.error ??
    resetMutation.error ??
    themePreferenceQuery.error ??
    themePreferenceMutation.error ??
    changeSequence.error;
  const rightPaneVisible =
    documentWorkspace.documents.right.length > 0 || draggedDocumentKey !== null;

  const renderDocumentPane = (paneId: DocumentPaneId) => {
    const paneDocuments = documentWorkspace.documents[paneId];
    const paneDocument = documentWorkspace.active[paneId];
    const paneViewerState = paneViewerStates[paneId];
    const paneViewerDocument = paneViewerState.viewerDocument;
    const content =
      paneViewerDocument?.kind === "walkthrough" && paneViewerState.walkthrough ? (
        <LazyLoadBoundary label="ウォークスルー">
          <Suspense
            fallback={<div className="viewer-loading">ウォークスルーを準備しています…</div>}
          >
            <WalkthroughViewer
              walkthrough={paneViewerState.walkthrough}
              comments={comments}
              activeCommentId={activeCommentId}
              navigationTarget={
                viewerNavigationTargets[paneId]?.documentKey === documentTabKey(paneViewerDocument)
                  ? viewerNavigationTargets[paneId]
                  : null
              }
              onNavigationApplied={(requestId) => markLineNavigationApplied(paneId, requestId)}
              themePreference={themePreference}
              onCommentActiveChange={handleCommentActiveChange}
              onOpenReference={openWalkthroughReferenceFromInteraction}
              onOpenCommentCodeReference={openCommentCodeReferenceFromInteraction}
              onOpenRepositoryLink={openRepositoryMarkdownLinkFromInteraction}
              onDeleted={() => closeDocument(paneViewerDocument, paneId)}
            />
          </Suspense>
        </LazyLoadBoundary>
      ) : paneViewerDocument?.kind === "walkthrough" ? (
        <div className="empty-document-viewer">
          <strong>
            {paneViewerState.walkthroughLoading
              ? "ウォークスルーを読み込んでいます…"
              : "ウォークスルーを読み込めませんでした。"}
          </strong>
          {!paneViewerState.walkthroughLoading && (
            <span>サイドバーからもう一度開いてください。</span>
          )}
        </div>
      ) : paneViewerDocument ? (
        <LazyLoadBoundary label="文書ビューアー">
          <Suspense fallback={<div className="viewer-loading">文書を準備しています…</div>}>
            <DocumentViewer
              key={
                paneViewerDocument.kind === "issue"
                  ? `${reviewStateRevision}:${paneId}:pull-request:${pullRequest.id}:issue:${paneViewerDocument.id}`
                  : `${reviewStateRevision}:${paneId}:${selectedOid}:${effectiveOldOid}:${paneViewerState.effectiveDisplayMode}:${documentTabKey(paneViewerDocument)}:${paneViewerDocument.kind === "repository-file" ? `${paneViewerDocument.sourceOid ?? ""}:${paneViewerDocument.comparisonPolicy ?? ""}` : ""}`
              }
              review={{ kind: "pull-request", id: pullRequest.id, sourceOid: selectedOid }}
              paneId={paneId}
              selectedOid={selectedOid}
              oldOid={effectiveOldOid}
              activeDocument={paneViewerDocument}
              documentRevision={
                paneViewerDocument.kind === "issue"
                  ? (issues.find((issue) => issue.id === paneViewerDocument.id)?.bodyHash ?? null)
                  : null
              }
              displayMode={paneViewerState.effectiveDisplayMode}
              diffStyle={diffStyle}
              comments={comments}
              activeCommentId={activeCommentId}
              fullViewNotice={
                paneViewerDocument.kind === "issue" &&
                issues.find((issue) => issue.id === paneViewerDocument.id)?.syncError
                  ? "Issue同期失敗 · 最終取得本文"
                  : paneViewerState.fullViewNotice
              }
              fullViewUnavailableMessage={paneViewerState.fullViewUnavailableMessage}
              themePreference={themePreference}
              onCommentActiveChange={handleCommentActiveChange}
              navigationTarget={
                viewerNavigationTargets[paneId]?.documentKey === documentTabKey(paneViewerDocument)
                  ? viewerNavigationTargets[paneId]
                  : null
              }
              onNavigationApplied={(requestId) => markLineNavigationApplied(paneId, requestId)}
              onOpenMarkdownFragment={(line, hash) =>
                navigateToMarkdownFragment(paneViewerDocument, paneId, line, hash)
              }
              onOpenCodeReference={openCommentCodeReferenceFromInteraction}
              onOpenRepositoryLink={openRepositoryMarkdownLinkFromInteraction}
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
        changeKindsByPath={tabChangeKinds}
        draggedDocumentKey={draggedDocumentKey}
        content={content}
        onPaneRef={(element) => {
          paneElements.current[paneId] = element;
        }}
        onScroll={(scrollTop) => {
          recordPaneScroll(paneId, paneViewerDocument, scrollTop);
        }}
        onFocus={() =>
          setDocumentWorkspace((current) =>
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
          <span>
            {pullRequest.owner}/{pullRequest.repository} · #{pullRequest.number}
          </span>
          <h1>
            <a href={pullRequest.url} target="_blank" rel="noopener noreferrer">
              {pullRequest.latestTitle}
            </a>
          </h1>
        </div>
        <ReviewScopeBar
          selectedOid={selectedOid}
          selectedStartOid={rangeStartOid ?? selectedOid}
          commits={commits}
          latestHeadOid={latestHeadOid}
          specialSelected={specialSelected}
          specialSelectionLabel={
            activeDocument?.kind === "walkthrough" ? "Walkthrough source" : "コメント元"
          }
          documentDisplayMode={documentDisplayMode}
          diffStyle={diffStyle}
          comparisonAvailable={comparisonAvailable}
          diffViewAvailable={diffViewAvailable}
          onCommitRangeChange={selectCommitRange}
          onDisplayModeChange={setDocumentDisplayMode}
          onDiffStyleChange={setDiffStyle}
        />
        <ReviewActionsMenu
          themePreference={themePreference}
          themePending={themePreferenceMutation.isPending}
          syncPending={refreshMutation.isPending}
          resetPending={resetMutation.isPending}
          onOpenQuickOpen={(returnFocusElement) => {
            setQuickOpenReturnFocus(returnFocusElement);
            setQuickOpenVisible(true);
          }}
          onSync={() => {
            setSyncFeedback(null);
            refreshMutation.mutate({ announce: true });
          }}
          onThemeChange={selectThemePreference}
          onReset={() => resetMutation.mutate()}
        />
      </header>
      {quickOpenVisible && (
        <QuickOpenPalette
          open
          returnFocusElement={quickOpenReturnFocus}
          files={allFiles}
          openDocuments={openDocuments}
          activeDocument={activeDocument}
          loading={treeQuery.isPending}
          error={treeQuery.error}
          onClose={() => setQuickOpenVisible(false)}
          onOpen={(document, openInRightPane) =>
            openDocument(document, openInRightPane ? "right" : "left")
          }
        />
      )}
      <ErrorNotice error={actionError} />
      {syncFeedback && (
        <div className="sync-feedback" role="status">
          {syncFeedback}
        </div>
      )}
      <ReviewWorkspace
        sidebar={
          <ReviewSidebar
            codeExpanded={codeExpanded}
            commentsExpanded={commentsExpanded}
            mode={codeNavigationMode}
            unresolvedCommentCount={unresolvedCommentCount}
            onOpenSearch={openSidebarSearch}
            onCodeExpandedChange={setCodeExpanded}
            onCommentsExpandedChange={setCommentsExpanded}
            onModeChange={setCodeNavigationMode}
            explorer={
              <div className="file-panel">
                <ReviewTreeItems
                  issues={issues}
                  walkthroughs={walkthroughs}
                  activeIssueId={activeDocument?.kind === "issue" ? activeDocument.id : null}
                  pullRequestActive={activeDocument?.kind === "pull-request-markdown"}
                  activeWalkthroughId={
                    activeDocument?.kind === "walkthrough" ? activeDocument.id : null
                  }
                  issueReference={issueReference}
                  issueAddOpen={issueAddOpen}
                  issueAdding={addIssueMutation.isPending}
                  removingIssueId={removeIssueMutation.variables?.id ?? null}
                  issueError={
                    issuesQuery.error ?? addIssueMutation.error ?? removeIssueMutation.error
                  }
                  onIssueReferenceChange={setIssueReference}
                  onIssueAddOpenChange={setIssueAddOpen}
                  onIssueAdd={() => addIssueMutation.mutate()}
                  onOpenIssue={(issue, openInRightPane) =>
                    openDocument(
                      {
                        kind: "issue",
                        id: issue.id,
                        number: issue.number,
                        title: issue.title,
                        url: issue.url,
                      },
                      openInRightPane ? "right" : "left",
                    )
                  }
                  onRemoveIssue={(issue) => removeIssueMutation.mutate(issue)}
                  onOpenPullRequest={(openInRightPane) =>
                    openDocument(
                      { kind: "pull-request-markdown" },
                      openInRightPane ? "right" : "left",
                    )
                  }
                  onOpen={openWalkthrough}
                />
                <ErrorNotice error={walkthroughsQuery.error} />
                <input
                  value={fileFilter}
                  onChange={(event) => setFileFilter(event.target.value)}
                  placeholder="ファイル名を検索"
                />
                <label className="file-scope-checkbox">
                  <input
                    type="checkbox"
                    checked={treeMode === "all"}
                    onChange={(event) => setTreeMode(event.target.checked ? "all" : "changed")}
                  />
                  <span>変更のないファイルも表示</span>
                </label>
                <ErrorNotice
                  error={treeMode === "changed" ? changedQuery.error : treeQuery.error}
                />
                <nav className="file-tree">
                  <FileTree
                    key={`${rangeStartOid}:${selectedOid}:${treeMode}:${treeMode === "changed" ? changedQuery.dataUpdatedAt : treeQuery.dataUpdatedAt}`}
                    files={filteredFiles}
                    activePath={
                      activeDocument?.kind === "repository-file" ? activeDocument.path : null
                    }
                    filtering={Boolean(fileFilter.trim())}
                    initiallyExpanded={treeMode === "changed" ? "all" : "active-file"}
                    onOpenFile={openFile}
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
                changeKindsByPath={tabChangeKinds}
                response={debouncedSearch ? searchQuery.data : undefined}
                isFetching={Boolean(debouncedSearch && searchQuery.isFetching)}
                error={debouncedSearch ? searchQuery.error : null}
                onQueryChange={setSearchText}
                onMatchCaseChange={setSearchMatchCase}
                onWholeWordChange={setSearchWholeWord}
                onOpenResult={openSearchResult}
              />
            }
            comments={
              <>
                <ErrorNotice error={commentsQuery.error} />
                <CommentSidebar
                  comments={comments}
                  walkthroughs={walkthroughs}
                  review={{ kind: "pull-request", id: pullRequest.id, sourceOid: selectedOid }}
                  themePreference={themePreference}
                  onCommentActiveChange={handleCommentActiveChange}
                  onOpenCodeReference={openCommentCodeReferenceFromInteraction}
                  onOpenTarget={openCommentTarget}
                  onOpenRepositoryLink={openRepositoryMarkdownLinkFromInteraction}
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

export function App({ initialThemePreference }: { initialThemePreference: ThemePreference }) {
  const branchReviewId = new URLSearchParams(window.location.search).get("branchReviewId");
  return branchReviewId ? (
    <Suspense fallback={<main className="fatal-state">Branch Reviewを準備しています…</main>}>
      <BranchReviewApp
        branchReviewId={branchReviewId}
        initialThemePreference={initialThemePreference}
      />
    </Suspense>
  ) : (
    <PullRequestApp initialThemePreference={initialThemePreference} />
  );
}
