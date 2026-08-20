import fuzzysort from "fuzzysort";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { changedFilePath } from "../../domain/changed-file.js";
import type {
  ChangedFile,
  ChangeKind,
  CodeReference,
  CommentPlacement,
  DocumentRef,
  ReviewComment,
  SearchResult,
  Walkthrough,
  WalkthroughReference,
  WalkthroughSummary,
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
  type ThemePreferenceResponse,
  type TreeResponse,
  type WalkthroughResponse,
  type WalkthroughsResponse,
} from "../api.js";
import { CommentSidebar } from "../components/CommentSidebar.js";
import { DocumentTabs } from "../components/DocumentTabs.js";
import { ErrorNotice } from "../components/ErrorNotice.js";
import {
  decorateAllFilesWithChanges,
  FileTree,
  type FileTreeFile,
} from "../components/FileTree.js";
import { FileEntryIcon } from "../components/FileIcon.js";
import { LazyLoadBoundary } from "../components/LazyLoadBoundary.js";
import type { DisplayMode, ViewerNavigationTarget } from "../components/DocumentViewer.js";
import { SearchPanel, SearchStackIcon } from "../components/SearchPanel.js";
import { QuickOpenPalette } from "../components/QuickOpenPalette.js";
import { applyThemePreference, storeThemePreference, type ThemePreference } from "../theme.js";
import { viewerHeartbeatRequest } from "../viewer-session.js";
import { WalkthroughIcon, WalkthroughPanel } from "../components/WalkthroughPanel.js";
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
  otherDocumentPane,
  removeDocumentFromWorkspace,
  type ActiveDocument,
  type DocumentPaneId,
} from "../document-workspace.js";
import { clearCommentDraftsForPullRequest } from "../comment-draft-store.js";
import { deriveDocumentViewerState } from "../document-viewer-state.js";
import { useDocumentWorkspace } from "../use-document-workspace.js";
import {
  parseReadingHistoryEntry,
  readingHistoryState,
  sameReadingDocument,
  type ReadingHistoryEntry,
  type ReadingLocator,
} from "../reading-history.js";
const DocumentViewer = lazy(async () => {
  const module = await import("../components/DocumentViewer.js");
  return { default: module.DocumentViewer };
});
const WalkthroughViewer = lazy(async () => {
  const module = await import("../components/WalkthroughViewer.js");
  return { default: module.WalkthroughViewer };
});

function changePath(change: ChangedFile): string {
  return changedFilePath(change) ?? "(unknown)";
}

function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

const DEFAULT_SIDEBAR_WIDTH = 330;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;
const MIN_MAIN_VIEW_WIDTH = 500;
const DEFAULT_PANE_SPLIT = 50;
const MIN_PANE_WIDTH = 280;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function initialSidebarWidth(): number {
  return window.innerWidth <= 850 ? 280 : DEFAULT_SIDEBAR_WIDTH;
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);
  return debouncedValue;
}

type DocumentDisplayMode = "full" | "diff";

interface AppliedLineNavigation {
  requestId: number;
  documentKey: string;
  pane: DocumentPaneId;
  top: number;
}

function SidebarCommentIcon() {
  return (
    <svg className="sidebar-stack-icon" aria-hidden="true" viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d="M1.75 2.5A1.75 1.75 0 0 1 3.5.75h9a1.75 1.75 0 0 1 1.75 1.75v7a1.75 1.75 0 0 1-1.75 1.75H7.06l-3.88 3.1A.75.75 0 0 1 2 13.77v-2.7A1.75 1.75 0 0 1 1.75 9.5v-7Zm1.75-.25a.25.25 0 0 0-.25.25v7c0 .14.11.25.25.25V12.2l3.03-2.42a.75.75 0 0 1 .47-.17h5.5a.25.25 0 0 0 .25-.25V2.5a.25.25 0 0 0-.25-.25h-9Z"
      />
    </svg>
  );
}

function SidebarChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg className="sidebar-stack-chevron" aria-hidden="true" viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d={
          expanded
            ? "M3.72 5.97a.75.75 0 0 1 1.06 0L8 9.19l3.22-3.22a.75.75 0 1 1 1.06 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0L3.72 7.03a.75.75 0 0 1 0-1.06Z"
            : "M5.97 3.72a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1 0 1.06l-3.75 3.75a.75.75 0 1 1-1.06-1.06L9.19 8 5.97 4.78a.75.75 0 0 1 0-1.06Z"
        }
      />
    </svg>
  );
}

function MoreActionsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="3" cy="8" r="1.4" fill="currentColor" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="13" cy="8" r="1.4" fill="currentColor" />
    </svg>
  );
}

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

const themeOptions: { preference: ThemePreference; label: string }[] = [
  { preference: "light", label: "ライトモード" },
  { preference: "dark", label: "ダークモード" },
  { preference: "system", label: "システム" },
];
const SYNC_FEEDBACK_DURATION_MS = 3_000;

function pullRequestLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "PULL_REQUEST_NOT_FOUND") {
    return "Pull Requestが見つかりません。`rvw open`から起動し直してください。";
  }
  return error instanceof Error ? error.message : "PR commitがありません。";
}

export function App({ initialThemePreference }: { initialThemePreference: ThemePreference }) {
  const queryClient = useQueryClient();
  const pullRequestIdParameter = new URL(window.location.href).searchParams.get("pullRequestId");
  const pullRequestIdValid = Boolean(
    pullRequestIdParameter &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      pullRequestIdParameter,
    ),
  );
  const pullRequestId = pullRequestIdValid ? pullRequestIdParameter : null;
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [rangeStartOid, setRangeStartOid] = useState<string | null>(null);
  const [documentDisplayMode, setDocumentDisplayMode] = useState<DocumentDisplayMode>("full");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [filesExpanded, setFilesExpanded] = useState(true);
  const [searchExpanded, setSearchExpanded] = useState(true);
  const [commentsExpanded, setCommentsExpanded] = useState(true);
  const [walkthroughsExpanded, setWalkthroughsExpanded] = useState(true);
  const [treeMode, setTreeMode] = useState<"changed" | "all">("changed");
  const [viewerNavigationTarget, setViewerNavigationTarget] =
    useState<ViewerNavigationTarget | null>(null);
  const viewerNavigationTargetRef = useRef(viewerNavigationTarget);
  const appliedLineNavigation = useRef<AppliedLineNavigation | null>(null);
  viewerNavigationTargetRef.current = viewerNavigationTarget;
  const resetViewerNavigation = useCallback((): void => {
    viewerNavigationTargetRef.current = null;
    appliedLineNavigation.current = null;
    setViewerNavigationTarget(null);
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
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [paneSplit, setPaneSplit] = useState(DEFAULT_PANE_SPLIT);
  const [resizingSurface, setResizingSurface] = useState<"sidebar" | "panes" | null>(null);
  const [draggedDocumentKey, setDraggedDocumentKey] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [quickOpenReturnFocus, setQuickOpenReturnFocus] = useState<HTMLElement | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchMatchCase, setSearchMatchCase] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [reviewStateRevision, setReviewStateRevision] = useState(0);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>(initialThemePreference);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const handleCommentActiveChange = useCallback((commentId: string, active: boolean): void => {
    setActiveCommentId((current) => (active ? commentId : current === commentId ? null : current));
  }, []);
  const attemptedInitialRefresh = useRef(false);
  const commitRangeTouched = useRef(false);
  const observedLatestHead = useRef<string | null>(null);
  const observedChangeSequence = useRef<number | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchNavigationSequence = useRef(0);
  const codeReferenceRequestSequence = useRef<Record<DocumentPaneId, number>>({
    left: 0,
    right: 0,
  });
  const debouncedSearch = useDebouncedValue(searchText.trim(), 250);
  const openDocuments = documentWorkspace.documents;
  const activePane = documentWorkspace.focusedPane;
  const activeDocument = documentWorkspace.active[activePane];
  const paneElements = useRef<Record<DocumentPaneId, HTMLElement | null>>({
    left: null,
    right: null,
  });
  const documentScrollPositions = useRef(new Map<string, number>());
  const readingHistoryReady = useRef(false);
  const readingHistoryScrollTimeout = useRef<number | null>(null);
  const leftActiveDocumentKey = documentWorkspace.active.left
    ? documentTabKey(documentWorkspace.active.left)
    : null;
  const rightActiveDocumentKey = documentWorkspace.active.right
    ? documentTabKey(documentWorkspace.active.right)
    : null;

  useLayoutEffect(() => {
    const pane = paneElements.current.left;
    if (!pane || !leftActiveDocumentKey) return;
    pane.scrollTop = documentScrollPositions.current.get(leftActiveDocumentKey) ?? 0;
  }, [leftActiveDocumentKey, reviewStateRevision]);
  useLayoutEffect(() => {
    const pane = paneElements.current.right;
    if (!pane || !rightActiveDocumentKey) return;
    pane.scrollTop = documentScrollPositions.current.get(rightActiveDocumentKey) ?? 0;
  }, [reviewStateRevision, rightActiveDocumentKey]);

  const currentReadingHistoryEntry = useCallback((): ReadingHistoryEntry | null => {
    if (!pullRequestId) return null;
    const workspace = documentWorkspaceRef.current;
    const pane = workspace.focusedPane;
    const document = workspace.active[pane];
    if (!document) return null;
    const documentKey = documentTabKey(document);
    const navigationTarget = viewerNavigationTargetRef.current;
    const scrollTop =
      paneElements.current[pane]?.scrollTop ??
      documentScrollPositions.current.get(documentKey) ??
      0;
    const lineNavigation = appliedLineNavigation.current;
    const lineNavigationStillAnchored = Boolean(
      navigationTarget?.documentKey === documentKey &&
      (!lineNavigation ||
        lineNavigation.requestId !== navigationTarget.requestId ||
        lineNavigation.documentKey !== documentKey ||
        lineNavigation.pane !== pane ||
        Math.abs(lineNavigation.top - scrollTop) <= 1),
    );
    const locator: ReadingLocator =
      navigationTarget?.documentKey === documentKey && lineNavigationStillAnchored
        ? {
            kind: "line",
            line: navigationTarget.line,
            ...(navigationTarget.endLine === undefined
              ? {}
              : { endLine: navigationTarget.endLine }),
          }
        : {
            kind: "scroll",
            top: scrollTop,
          };
    return {
      version: 1,
      pullRequestId,
      pane,
      document,
      locator,
    };
  }, [pullRequestId]);

  const markLineNavigationApplied = useCallback(
    (pane: DocumentPaneId, requestId: number): void => {
      const navigationTarget = viewerNavigationTargetRef.current;
      const workspace = documentWorkspaceRef.current;
      const document = workspace.active[pane];
      if (
        !navigationTarget ||
        navigationTarget.requestId !== requestId ||
        !document ||
        documentTabKey(document) !== navigationTarget.documentKey
      ) {
        return;
      }
      appliedLineNavigation.current = {
        requestId,
        documentKey: navigationTarget.documentKey,
        pane,
        top:
          paneElements.current[pane]?.scrollTop ??
          documentScrollPositions.current.get(navigationTarget.documentKey) ??
          0,
      };
    },
    [documentWorkspaceRef],
  );

  const cancelReadingHistoryScrollSnapshot = useCallback((): void => {
    if (readingHistoryScrollTimeout.current === null) return;
    window.clearTimeout(readingHistoryScrollTimeout.current);
    readingHistoryScrollTimeout.current = null;
  }, []);

  const replaceCurrentReadingHistory = useCallback((): void => {
    if (!readingHistoryReady.current) return;
    const entry = currentReadingHistoryEntry();
    if (!entry) return;
    window.history.replaceState(readingHistoryState(window.history.state, entry), "");
  }, [currentReadingHistoryEntry]);

  const scheduleReadingHistoryScrollSnapshot = useCallback((): void => {
    if (!readingHistoryReady.current) return;
    cancelReadingHistoryScrollSnapshot();
    readingHistoryScrollTimeout.current = window.setTimeout(() => {
      readingHistoryScrollTimeout.current = null;
      replaceCurrentReadingHistory();
    }, 150);
  }, [cancelReadingHistoryScrollSnapshot, replaceCurrentReadingHistory]);

  const pushReadingHistory = useCallback(
    (
      document: ActiveDocument,
      pane: DocumentPaneId,
      locator: ReadingLocator,
      hash?: string,
    ): void => {
      if (!pullRequestId || !readingHistoryReady.current) return;
      cancelReadingHistoryScrollSnapshot();
      const currentWorkspace = documentWorkspaceRef.current;
      const currentDocument = currentWorkspace.active[currentWorkspace.focusedPane];
      replaceCurrentReadingHistory();
      const destination: ReadingHistoryEntry = {
        version: 1,
        pullRequestId,
        pane,
        document,
        locator,
      };
      if (
        locator.kind === "scroll" &&
        currentDocument &&
        currentWorkspace.focusedPane === pane &&
        sameReadingDocument(currentDocument, document)
      ) {
        window.history.replaceState(readingHistoryState(window.history.state, destination), "");
        return;
      }
      const url = new URL(window.location.href);
      url.hash = hash ?? "";
      window.history.pushState(readingHistoryState(window.history.state, destination), "", url);
    },
    [cancelReadingHistoryScrollSnapshot, pullRequestId, replaceCurrentReadingHistory],
  );

  const requestLineNavigation = useCallback(
    (
      documentKey: string,
      locator: Extract<ReadingLocator, { kind: "line" }>,
      resetHorizontal: boolean,
    ) => {
      searchNavigationSequence.current += 1;
      const target: ViewerNavigationTarget = {
        documentKey,
        line: locator.line,
        ...(locator.endLine === undefined ? {} : { endLine: locator.endLine }),
        requestId: searchNavigationSequence.current,
        resetHorizontal,
      };
      appliedLineNavigation.current = null;
      viewerNavigationTargetRef.current = target;
      setViewerNavigationTarget(target);
    },
    [],
  );

  const navigateToDocument = useCallback(
    (
      document: ActiveDocument,
      targetPane?: DocumentPaneId,
      locator?: ReadingLocator,
      resetHorizontal = true,
    ): void => {
      const workspace = documentWorkspaceRef.current;
      const documentKey = documentTabKey(document);
      const pane = targetPane ?? workspace.panes[documentKey] ?? workspace.focusedPane;
      const destinationLocator =
        locator ??
        ({
          kind: "scroll",
          top: documentScrollPositions.current.get(documentKey) ?? 0,
        } satisfies ReadingLocator);
      pushReadingHistory(document, pane, destinationLocator);
      openWorkspaceDocument(document, pane);
      if (destinationLocator.kind === "line") {
        requestLineNavigation(documentKey, destinationLocator, resetHorizontal);
      }
    },
    [openWorkspaceDocument, pushReadingHistory, requestLineNavigation],
  );

  const navigateToMarkdownFragment = useCallback(
    (document: ActiveDocument, pane: DocumentPaneId, line: number, hash: string): void => {
      const documentKey = documentTabKey(document);
      const locator = { kind: "line", line } satisfies ReadingLocator;
      pushReadingHistory(document, pane, locator, hash);
      requestLineNavigation(documentKey, locator, true);
    },
    [pushReadingHistory, requestLineNavigation],
  );

  const openDocument = useCallback(
    (document: ActiveDocument, targetPane?: DocumentPaneId): void =>
      navigateToDocument(document, targetPane),
    [navigateToDocument],
  );

  const activateDocument = useCallback(
    (document: ActiveDocument, pane?: DocumentPaneId): void => {
      const workspace = documentWorkspaceRef.current;
      const targetPane = pane ?? workspace.panes[documentTabKey(document)] ?? workspace.focusedPane;
      pushReadingHistory(document, targetPane, {
        kind: "scroll",
        top: documentScrollPositions.current.get(documentTabKey(document)) ?? 0,
      });
      activateWorkspaceDocument(document, targetPane);
    },
    [activateWorkspaceDocument, pushReadingHistory],
  );

  useEffect(() => {
    if (!syncFeedback) return;
    const timeoutId = window.setTimeout(() => setSyncFeedback(null), SYNC_FEEDBACK_DURATION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [syncFeedback]);

  const dropDocument = useCallback(
    (documentKey: string, targetPane: DocumentPaneId): void => {
      dropWorkspaceDocument(documentKey, targetPane);
      setDraggedDocumentKey(null);
    },
    [dropWorkspaceDocument],
  );

  const updateSidebarWidth = (clientX: number, workspace: HTMLElement): void => {
    const bounds = workspace.getBoundingClientRect();
    const dynamicMaximum = Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, bounds.width - MIN_MAIN_VIEW_WIDTH),
    );
    setSidebarWidth(clamp(clientX - bounds.left, MIN_SIDEBAR_WIDTH, dynamicMaximum));
  };
  const updatePaneSplit = (clientX: number, mainView: HTMLElement): void => {
    const bounds = mainView.getBoundingClientRect();
    const minimumWidth = Math.min(MIN_PANE_WIDTH, Math.max(160, (bounds.width - 48) / 2));
    const minimumPercent = (minimumWidth / bounds.width) * 100;
    const nextPercent = ((clientX - bounds.left) / bounds.width) * 100;
    setPaneSplit(clamp(nextPercent, minimumPercent, 100 - minimumPercent));
  };
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizingSurface(null);
  };

  const themePreferenceQuery = useQuery({
    queryKey: ["theme-preference"],
    queryFn: async () => await api<ThemePreferenceResponse>("/api/preferences/theme"),
  });
  useEffect(() => {
    const preference = themePreferenceQuery.data?.themePreference;
    if (!preference) return;
    setThemePreference(preference);
    applyThemePreference(preference);
    storeThemePreference(preference);
  }, [themePreferenceQuery.data?.themePreference]);
  const themePreferenceMutation = useMutation({
    mutationFn: async (preference: ThemePreference) =>
      await api<ThemePreferenceResponse>(
        "/api/preferences/theme",
        jsonRequest({ themePreference: preference }),
      ),
    onSuccess: (response) => {
      queryClient.setQueryData(["theme-preference"], response);
    },
  });
  const selectThemePreference = (preference: ThemePreference): void => {
    setThemePreference(preference);
    applyThemePreference(preference);
    storeThemePreference(preference);
    themePreferenceMutation.mutate(preference);
  };

  const pullRequestQuery = useQuery({
    queryKey: ["pull-request", pullRequestId],
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

  const restoreReadingHistory = useCallback(
    (entry: ReadingHistoryEntry): void => {
      cancelReadingHistoryScrollSnapshot();
      const workspace = documentWorkspaceRef.current;
      const documentKey = documentTabKey(entry.document);
      const pane = workspace.panes[documentKey] ?? entry.pane;
      if (entry.locator.kind === "scroll") {
        documentScrollPositions.current.set(documentKey, entry.locator.top);
      }
      openWorkspaceDocument(entry.document, pane);
      if (entry.locator.kind === "line") {
        requestLineNavigation(documentKey, entry.locator, true);
        return;
      }
      const scrollTop = entry.locator.top;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const targetPane = documentWorkspaceRef.current.panes[documentKey] ?? pane;
          const paneElement = paneElements.current[targetPane];
          if (paneElement) paneElement.scrollTop = scrollTop;
        });
      });
    },
    [cancelReadingHistoryScrollSnapshot, openWorkspaceDocument, requestLineNavigation],
  );

  useEffect(() => {
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      cancelReadingHistoryScrollSnapshot();
      window.history.scrollRestoration = previousScrollRestoration;
    };
  }, [cancelReadingHistoryScrollSnapshot]);

  useEffect(() => {
    if (!pullRequestId) return;
    const restoreFromPopState = (event: PopStateEvent): void => {
      const entry = parseReadingHistoryEntry(event.state, pullRequestId);
      if (entry) restoreReadingHistory(entry);
    };
    window.addEventListener("popstate", restoreFromPopState);
    return () => window.removeEventListener("popstate", restoreFromPopState);
  }, [pullRequestId, restoreReadingHistory]);

  useEffect(() => {
    if (
      !pullRequestId ||
      !pullRequestQuery.isSuccess ||
      !selectedOid ||
      readingHistoryReady.current
    ) {
      return;
    }
    readingHistoryReady.current = true;
    const entry = currentReadingHistoryEntry();
    if (!entry) return;
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(readingHistoryState(window.history.state, entry), "", url);
  }, [currentReadingHistoryEntry, pullRequestId, pullRequestQuery.isSuccess, selectedOid]);

  useEffect(() => {
    const warnBeforeBrowserClose = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeBrowserClose);
    return () => window.removeEventListener("beforeunload", warnBeforeBrowserClose);
  }, []);
  useEffect(() => {
    const openQuickOpen = (event: KeyboardEvent): void => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "p"
      ) {
        return;
      }
      event.preventDefault();
      setActionsMenuOpen(false);
      setQuickOpenReturnFocus(null);
      setQuickOpenVisible(true);
    };
    document.addEventListener("keydown", openQuickOpen);
    return () => document.removeEventListener("keydown", openQuickOpen);
  }, []);
  useEffect(() => {
    const focusFullTextSearch = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "f") {
        return;
      }
      event.preventDefault();
      setSearchExpanded(true);
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    document.addEventListener("keydown", focusFullTextSearch);
    return () => document.removeEventListener("keydown", focusFullTextSearch);
  }, []);
  useLayoutEffect(() => {
    if (!actionsMenuOpen) return;
    actionsMenuRef.current
      ?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
      ?.focus();
  }, [actionsMenuOpen]);
  useEffect(() => {
    if (!actionsMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!actionsMenuRef.current?.contains(event.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setActionsMenuOpen(false);
      actionsMenuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionsMenuOpen]);
  const handleActionsMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)',
      ),
    ];
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  };
  const selectCommitRange = (startOid: string, endOid: string): void => {
    const range = normalizedCommitRange(commits, startOid, endOid);
    if (!range) return;
    commitRangeTouched.current = true;
    setRangeStartOid(range.startOid);
    setSelectedOid(range.endOid);
    if (range.endOid !== selectedOid) {
      setViewerNavigationTarget(null);
      setDocumentWorkspace((current) => ({
        ...current,
        documents: current.documents.map(currentCommitDocument),
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
    queryKey: ["change-sequence"],
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
    void queryClient.invalidateQueries({ queryKey: ["document"] });
    void queryClient.invalidateQueries({ queryKey: ["annotations"] });
    void queryClient.invalidateQueries({ queryKey: ["comment-placement"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    void queryClient.invalidateQueries({ queryKey: ["walkthroughs"] });
    void queryClient.invalidateQueries({ queryKey: ["walkthrough"] });
  }, [changeSequence.data?.changeSequence, queryClient]);
  const commentsQuery = useQuery({
    queryKey: ["comments", pullRequestId, changeSequence.data?.changeSequence],
    queryFn: async () =>
      await api<CommentsResponse>(`/api/pull-requests/${pullRequestId}/comments?resolved=all`),
    enabled: Boolean(pullRequestId),
    placeholderData: (previousData) =>
      previousData?.comments.every((comment) => comment.pullRequestId === pullRequestId)
        ? previousData
        : undefined,
  });
  const comments = commentsQuery.data?.comments ?? [];
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
      let reconciled = current;
      for (const document of current.documents) {
        if (document.kind === "walkthrough" && !summaries.has(document.id)) {
          reconciled = removeDocumentFromWorkspace(reconciled, document);
        }
      }
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
      return {
        ...reconciled,
        documents: reconciled.documents.map((document) => rebind(document)!),
        active: {
          left: rebind(reconciled.active.left),
          right: rebind(reconciled.active.right),
        },
      };
    });
  }, [walkthroughsQuery.data?.walkthroughs, walkthroughsQuery.isSuccess]);
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
        `ローカルレビュー状態を削除して再構築します。\n\nコメント ${counts.comments ?? 0}\n返信 ${counts.posts ?? 0}\nコメント内コード参照 ${counts.commentReferences ?? 0}\n対象 ${counts.targets ?? 0}\nウォークスルー ${counts.walkthroughs ?? 0}\nウォークスルーコード参照 ${counts.walkthroughReferences ?? 0}\nGit ref ${counts.gitRefs ?? 0}\n\nこの操作は元に戻せません。`,
      );
      if (!confirmed) return null;
      return await api<{
        pullRequest: PullRequestResponse["pullRequest"];
        commits: PullRequestResponse["commits"];
      }>(`/api/pull-requests/${pullRequestId}/reset`, jsonRequest({ yes: true }));
    },
    onSuccess: async (result) => {
      if (!result) return;
      clearCommentDraftsForPullRequest(result.pullRequest.id);
      documentScrollPositions.current.clear();
      setReviewStateRevision((revision) => revision + 1);
      setDocumentWorkspace(initialDocumentWorkspace());
      setViewerNavigationTarget(null);
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
  const openRepositoryMarkdownLinkFromLeftPane = useCallback(
    (filePath: string, sourceOid: string, openInOtherPane: boolean): void =>
      openRepositoryMarkdownLink(filePath, sourceOid, openInOtherPane ? "right" : "left"),
    [openRepositoryMarkdownLink],
  );
  const openRepositoryMarkdownLinkFromRightPane = useCallback(
    (filePath: string, sourceOid: string, openInOtherPane: boolean): void =>
      openRepositoryMarkdownLink(filePath, sourceOid, openInOtherPane ? "left" : "right"),
    [openRepositoryMarkdownLink],
  );
  const openRepositoryMarkdownLinkFromSidebar = useCallback(
    (filePath: string, sourceOid: string, openInOtherPane: boolean): void =>
      openRepositoryMarkdownLink(
        filePath,
        sourceOid,
        openInOtherPane ? "right" : documentWorkspaceRef.current.focusedPane,
      ),
    [openRepositoryMarkdownLink],
  );
  const openSearchResult = (result: SearchResult, openInRightPane = false): void => {
    const requestedDocument: ActiveDocument =
      result.document.kind === "pull-request-markdown"
        ? { kind: "pull-request-markdown" }
        : { kind: "repository-file", path: result.path };
    const workspace = documentWorkspaceRef.current;
    const documentKey = documentTabKey(requestedDocument);
    const openDocumentWithSameSource = workspace.documents.find((candidate) => {
      if (documentTabKey(candidate) !== documentKey) return false;
      return (
        candidate.kind !== "repository-file" ||
        candidate.sourceOid === undefined ||
        candidate.sourceOid === selectedOid
      );
    });
    const document = openDocumentWithSameSource ?? requestedDocument;
    const targetPane = openInRightPane
      ? "right"
      : (workspace.panes[documentKey] ?? workspace.focusedPane);
    const activeTarget = workspace.active[targetPane];
    const resetHorizontal = !activeTarget || documentTabKey(activeTarget) !== documentKey;
    navigateToDocument(document, targetPane, { kind: "line", line: result.line }, resetHorizontal);
  };
  const openCommentTarget = (comment: ReviewComment, placement: CommentPlacement | null): void => {
    const target = comment.target;
    const navigate = (
      document: ActiveDocument,
      startLine: number | null,
      endLine: number | null,
    ): void => {
      navigateToDocument(document, undefined, {
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
    (walkthrough: WalkthroughSummary, openInRightPane = false): void => {
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
      walkthrough: Walkthrough,
      reference: WalkthroughReference,
      targetPane: DocumentPaneId,
    ): Promise<string | null> =>
      openCodeReference(
        walkthrough.pullRequestId,
        walkthrough.sourceOid,
        reference,
        targetPane,
        "selected-range",
      ),
    [openCodeReference],
  );
  const openWalkthroughReferenceFromLeftPane = useCallback(
    (walkthrough: Walkthrough, reference: WalkthroughReference, openInOtherPane: boolean) =>
      openWalkthroughReference(walkthrough, reference, openInOtherPane ? "right" : "left"),
    [openWalkthroughReference],
  );
  const openWalkthroughReferenceFromRightPane = useCallback(
    (walkthrough: Walkthrough, reference: WalkthroughReference, openInOtherPane: boolean) =>
      openWalkthroughReference(walkthrough, reference, openInOtherPane ? "left" : "right"),
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
  const openCommentCodeReferenceFromLeftPane = useCallback(
    (sourceOid: string, reference: CodeReference, openInOtherPane: boolean) =>
      openCommentCodeReference(sourceOid, reference, openInOtherPane ? "right" : "left"),
    [openCommentCodeReference],
  );
  const openCommentCodeReferenceFromRightPane = useCallback(
    (sourceOid: string, reference: CodeReference, openInOtherPane: boolean) =>
      openCommentCodeReference(sourceOid, reference, openInOtherPane ? "left" : "right"),
    [openCommentCodeReference],
  );
  const openCommentCodeReferenceFromSidebar = useCallback(
    (sourceOid: string, reference: CodeReference, openInOtherPane: boolean) =>
      openCommentCodeReference(
        sourceOid,
        reference,
        openInOtherPane ? "right" : documentWorkspaceRef.current.focusedPane,
      ),
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
    openDocuments.some(
      (document) => documentWorkspace.panes[documentTabKey(document)] === "right",
    ) || draggedDocumentKey !== null;

  const renderDocumentPane = (paneId: DocumentPaneId) => {
    const paneDocuments = openDocuments.filter(
      (document) => (documentWorkspace.panes[documentTabKey(document)] ?? "left") === paneId,
    );
    const paneDocument = documentWorkspace.active[paneId];
    const paneViewerState = paneViewerStates[paneId];
    const paneViewerDocument = paneViewerState.viewerDocument;
    return (
      <section
        ref={(element) => {
          paneElements.current[paneId] = element;
        }}
        onScroll={(event) => {
          if (paneViewerDocument) {
            documentScrollPositions.current.set(
              documentTabKey(paneViewerDocument),
              event.currentTarget.scrollTop,
            );
            if (documentWorkspaceRef.current.focusedPane === paneId) {
              scheduleReadingHistoryScrollSnapshot();
            }
          }
        }}
        className={`document-pane${activePane === paneId ? " active" : ""}${paneDocuments.length === 0 ? " empty" : ""}`}
        data-pane={paneId}
        aria-label={`${paneId === "left" ? "左" : "右"}のコードペイン`}
        onPointerDown={() =>
          setDocumentWorkspace((current) =>
            current.focusedPane === paneId ? current : { ...current, focusedPane: paneId },
          )
        }
      >
        <DocumentTabs
          paneId={paneId}
          documents={paneDocuments}
          activeDocument={paneDocument}
          changeKindsByPath={tabChangeKinds}
          onActivate={(document) => activateDocument(document, paneId)}
          onClose={closeDocument}
          onCloseOthers={(document) => closePaneDocuments(paneId, document)}
          onCloseAll={() => closePaneDocuments(paneId)}
          onMove={moveDocument}
          onDropDocument={dropDocument}
          onDragStartDocument={setDraggedDocumentKey}
          onDragEndDocument={() => setDraggedDocumentKey(null)}
        />
        {paneViewerDocument?.kind === "walkthrough" && paneViewerState.walkthrough ? (
          <LazyLoadBoundary label="ウォークスルー">
            <Suspense
              fallback={<div className="viewer-loading">ウォークスルーを準備しています…</div>}
            >
              <WalkthroughViewer
                walkthrough={paneViewerState.walkthrough}
                comments={comments}
                activeCommentId={activeCommentId}
                navigationTarget={
                  viewerNavigationTarget?.documentKey === documentTabKey(paneViewerDocument)
                    ? viewerNavigationTarget
                    : null
                }
                onNavigationApplied={(requestId) => markLineNavigationApplied(paneId, requestId)}
                themePreference={themePreference}
                onCommentActiveChange={handleCommentActiveChange}
                onOpenReference={
                  paneId === "left"
                    ? openWalkthroughReferenceFromLeftPane
                    : openWalkthroughReferenceFromRightPane
                }
                onOpenCommentCodeReference={
                  paneId === "left"
                    ? openCommentCodeReferenceFromLeftPane
                    : openCommentCodeReferenceFromRightPane
                }
                onOpenRepositoryLink={
                  paneId === "left"
                    ? openRepositoryMarkdownLinkFromLeftPane
                    : openRepositoryMarkdownLinkFromRightPane
                }
                onDeleted={() => closeDocument(paneViewerDocument)}
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
                key={`${reviewStateRevision}:${paneId}:${selectedOid}:${effectiveOldOid}:${paneViewerState.effectiveDisplayMode}:${documentTabKey(paneViewerDocument)}:${paneViewerDocument.kind === "repository-file" ? `${paneViewerDocument.sourceOid ?? ""}:${paneViewerDocument.comparisonPolicy ?? ""}` : ""}`}
                pullRequestId={pullRequest.id}
                selectedOid={selectedOid}
                oldOid={effectiveOldOid}
                activeDocument={paneViewerDocument}
                displayMode={paneViewerState.effectiveDisplayMode}
                diffStyle={diffStyle}
                comments={comments}
                activeCommentId={activeCommentId}
                fullViewNotice={paneViewerState.fullViewNotice}
                fullViewUnavailableMessage={paneViewerState.fullViewUnavailableMessage}
                themePreference={themePreference}
                onCommentActiveChange={handleCommentActiveChange}
                navigationTarget={
                  viewerNavigationTarget?.documentKey === documentTabKey(paneViewerDocument)
                    ? viewerNavigationTarget
                    : null
                }
                onNavigationApplied={(requestId) => markLineNavigationApplied(paneId, requestId)}
                onOpenMarkdownFragment={(line, hash) =>
                  navigateToMarkdownFragment(paneViewerDocument, paneId, line, hash)
                }
                onOpenCodeReference={
                  paneId === "left"
                    ? openCommentCodeReferenceFromLeftPane
                    : openCommentCodeReferenceFromRightPane
                }
                onOpenRepositoryLink={(filePath, sourceOid, openInOtherPane) =>
                  openRepositoryMarkdownLink(
                    filePath,
                    sourceOid,
                    openInOtherPane ? otherDocumentPane(paneId) : paneId,
                  )
                }
              />
            </Suspense>
          </LazyLoadBoundary>
        ) : (
          <div className="empty-document-viewer document-pane-drop-target">
            <strong>
              {draggedDocumentKey ? "ここへドロップ" : `${paneId === "left" ? "左" : "右"}ペイン`}
            </strong>
            <span>タブを移動するか、Cmd/Ctrl+クリックで文書を開けます。</span>
          </div>
        )}
      </section>
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
        <div className="pr-heading">
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
        <div className="topbar-menu" ref={actionsMenuRef}>
          <button
            ref={actionsMenuButtonRef}
            className="topbar-menu-toggle"
            aria-label="その他の操作"
            aria-haspopup="menu"
            aria-expanded={actionsMenuOpen}
            onClick={() => setActionsMenuOpen((open) => !open)}
          >
            <MoreActionsIcon />
          </button>
          {actionsMenuOpen && (
            <div className="topbar-menu-popover" role="menu" onKeyDown={handleActionsMenuKeyDown}>
              <button
                role="menuitem"
                className="topbar-menu-command"
                onClick={() => {
                  setActionsMenuOpen(false);
                  setQuickOpenReturnFocus(actionsMenuButtonRef.current);
                  setQuickOpenVisible(true);
                }}
              >
                <span>ファイルを開く…</span>
                <kbd>⌘ / Ctrl P</kbd>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setActionsMenuOpen(false);
                  setSyncFeedback(null);
                  refreshMutation.mutate({ announce: true });
                }}
                disabled={refreshMutation.isPending}
              >
                GitHubと同期
              </button>
              <div className="topbar-menu-section" role="group" aria-label="UIテーマ">
                <span className="topbar-menu-section-label">UIテーマ</span>
                {themeOptions.map((option) => (
                  <button
                    key={option.preference}
                    role="menuitemradio"
                    aria-checked={themePreference === option.preference}
                    disabled={themePreferenceMutation.isPending}
                    onClick={() => {
                      selectThemePreference(option.preference);
                      setActionsMenuOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="topbar-menu-check" aria-hidden="true">
                      {themePreference === option.preference ? "✓" : ""}
                    </span>
                  </button>
                ))}
              </div>
              <button
                className="topbar-menu-danger"
                role="menuitem"
                onClick={() => {
                  setActionsMenuOpen(false);
                  resetMutation.mutate();
                }}
                disabled={resetMutation.isPending}
              >
                ローカル状態を削除して再構築
              </button>
            </div>
          )}
        </div>
      </header>
      {quickOpenVisible && (
        <QuickOpenPalette
          open
          returnFocusElement={quickOpenReturnFocus}
          files={allFiles}
          openDocuments={openDocuments}
          activeDocument={activeDocument}
          activePane={activePane}
          loading={treeQuery.isPending}
          error={treeQuery.error}
          onClose={() => setQuickOpenVisible(false)}
          onOpen={(document) => openDocument(document, activePane)}
        />
      )}
      <ErrorNotice error={actionError} />
      {syncFeedback && (
        <div className="sync-feedback" role="status">
          {syncFeedback}
        </div>
      )}
      <div
        className={`workspace${resizingSurface ? " is-resizing" : ""}`}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="sidebar" aria-label="レビューサイドバー">
          <section
            className={`sidebar-stack sidebar-stack--files${filesExpanded ? " is-expanded" : ""}`}
          >
            <button
              className="sidebar-stack-toggle"
              aria-expanded={filesExpanded}
              onClick={() => setFilesExpanded((expanded) => !expanded)}
            >
              <FileEntryIcon kind="file" />
              <span>ファイル</span>
              <SidebarChevron expanded={filesExpanded} />
            </button>
            <div className="sidebar-stack-body" hidden={!filesExpanded}>
              <div className="file-panel">
                <input
                  value={fileFilter}
                  onChange={(event) => setFileFilter(event.target.value)}
                  placeholder="ファイル名を検索"
                />
                <div className="segmented file-tree-mode">
                  <button
                    className={treeMode === "changed" ? "active" : ""}
                    onClick={() => setTreeMode("changed")}
                  >
                    変更ファイル
                  </button>
                  <button
                    className={treeMode === "all" ? "active" : ""}
                    onClick={() => setTreeMode("all")}
                  >
                    全ファイル
                  </button>
                </div>
                <ErrorNotice
                  error={treeMode === "changed" ? changedQuery.error : treeQuery.error}
                />
                <nav className="file-tree">
                  <button
                    className={`file-tree-row file-tree-file${activeDocument?.kind === "pull-request-markdown" ? " active" : ""}`}
                    onMouseDown={(event) => {
                      if (!event.metaKey && !event.ctrlKey) return;
                      event.preventDefault();
                      openDocument({ kind: "pull-request-markdown" }, "right");
                    }}
                    onClick={(event) => {
                      if (!event.metaKey && !event.ctrlKey) {
                        openDocument({ kind: "pull-request-markdown" });
                      }
                    }}
                    onContextMenu={(event) => {
                      if (event.ctrlKey || event.metaKey) event.preventDefault();
                    }}
                    aria-label="Pull Request.md"
                  >
                    <span className="directory-chevron" aria-hidden="true" />
                    <span className="file-tree-icon-group" aria-hidden="true">
                      <FileEntryIcon path="Pull Request.md" kind="file" />
                    </span>
                    <span className="file-tree-label">Pull Request.md</span>
                  </button>
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
            </div>
          </section>
          <section
            className={`sidebar-stack sidebar-stack--search${searchExpanded ? " is-expanded" : ""}`}
          >
            <button
              className="sidebar-stack-toggle"
              aria-expanded={searchExpanded}
              onClick={() => setSearchExpanded((expanded) => !expanded)}
            >
              <SearchStackIcon />
              <span>検索</span>
              {searchQuery.data && debouncedSearch && (
                <span className="sidebar-stack-count">{searchQuery.data.matchCount}</span>
              )}
              <SidebarChevron expanded={searchExpanded} />
            </button>
            <div className="sidebar-stack-body" hidden={!searchExpanded}>
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
            </div>
          </section>
          <section
            className={`sidebar-stack sidebar-stack--comments${commentsExpanded ? " is-expanded" : ""}`}
          >
            <button
              className="sidebar-stack-toggle"
              aria-expanded={commentsExpanded}
              onClick={() => setCommentsExpanded((expanded) => !expanded)}
            >
              <SidebarCommentIcon />
              <span>コメント</span>
              <span className="sidebar-stack-count">
                {comments.filter((comment) => !comment.resolvedAt).length}
              </span>
              <SidebarChevron expanded={commentsExpanded} />
            </button>
            <div className="sidebar-stack-body" hidden={!commentsExpanded}>
              <ErrorNotice error={commentsQuery.error} />
              <CommentSidebar
                comments={comments}
                walkthroughs={walkthroughs}
                pullRequestId={pullRequest.id}
                selectedOid={selectedOid}
                themePreference={themePreference}
                onCommentActiveChange={handleCommentActiveChange}
                onOpenCodeReference={openCommentCodeReferenceFromSidebar}
                onOpenTarget={openCommentTarget}
                onOpenRepositoryLink={openRepositoryMarkdownLinkFromSidebar}
              />
            </div>
          </section>
          <section
            className={`sidebar-stack sidebar-stack--walkthroughs${walkthroughsExpanded ? " is-expanded" : ""}`}
          >
            <button
              className="sidebar-stack-toggle"
              aria-expanded={walkthroughsExpanded}
              onClick={() => setWalkthroughsExpanded((expanded) => !expanded)}
            >
              <WalkthroughIcon className="sidebar-stack-icon" />
              <span>ウォークスルー</span>
              <span className="sidebar-stack-count">{walkthroughs.length}</span>
              <SidebarChevron expanded={walkthroughsExpanded} />
            </button>
            <div className="sidebar-stack-body" hidden={!walkthroughsExpanded}>
              <ErrorNotice error={walkthroughsQuery.error} />
              <WalkthroughPanel
                walkthroughs={walkthroughs}
                activeWalkthroughId={
                  activeDocument?.kind === "walkthrough" ? activeDocument.id : null
                }
                onOpen={openWalkthrough}
              />
            </div>
          </section>
        </aside>
        <div
          className={`horizontal-resize-handle sidebar-resize-handle${resizingSurface === "sidebar" ? " active" : ""}`}
          role="separator"
          aria-label="サイドバーの幅を変更"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizingSurface("sidebar");
            updateSidebarWidth(event.clientX, event.currentTarget.parentElement!);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            updateSidebarWidth(event.clientX, event.currentTarget.parentElement!);
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={() => setResizingSurface(null)}
          onDoubleClick={() => setSidebarWidth(initialSidebarWidth())}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setSidebarWidth((width) =>
              clamp(
                width + (event.key === "ArrowLeft" ? -16 : 16),
                MIN_SIDEBAR_WIDTH,
                MAX_SIDEBAR_WIDTH,
              ),
            );
          }}
        />
        <section
          id="review-main-content"
          tabIndex={-1}
          className={`main-view${rightPaneVisible ? " two-pane" : ""}${resizingSurface === "panes" ? " is-resizing" : ""}`}
          style={
            rightPaneVisible
              ? {
                  gridTemplateColumns: `minmax(${MIN_PANE_WIDTH}px, ${paneSplit}fr) 6px minmax(${MIN_PANE_WIDTH}px, ${100 - paneSplit}fr)`,
                }
              : undefined
          }
        >
          {renderDocumentPane("left")}
          {rightPaneVisible && (
            <div
              className={`horizontal-resize-handle pane-resize-handle${resizingSurface === "panes" ? " active" : ""}`}
              role="separator"
              aria-label="左右ペインの幅を変更"
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(paneSplit)}
              tabIndex={0}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                setResizingSurface("panes");
                updatePaneSplit(event.clientX, event.currentTarget.parentElement!);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                updatePaneSplit(event.clientX, event.currentTarget.parentElement!);
              }}
              onPointerUp={finishResize}
              onPointerCancel={finishResize}
              onLostPointerCapture={() => setResizingSurface(null)}
              onDoubleClick={() => setPaneSplit(DEFAULT_PANE_SPLIT)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setPaneSplit((split) =>
                  clamp(split + (event.key === "ArrowLeft" ? -2 : 2), 20, 80),
                );
              }}
            />
          )}
          {rightPaneVisible && renderDocumentPane("right")}
        </section>
      </div>
    </main>
  );
}
