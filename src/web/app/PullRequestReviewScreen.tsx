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
  SourceAnchor,
  Structure,
  StructureSummary,
  Walkthrough,
  WalkthroughReference,
  WalkthroughReferenceFileTarget,
  WalkthroughReferenceResolution,
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
  type StructureResponse,
  type StructuresResponse,
  type ThemePreferenceResponse,
  type TreeResponse,
  type WalkthroughResponse,
  type WalkthroughReferenceResolutionResponse,
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
import { PaneFindWidget } from "../components/PaneFindWidget.js";
import type { DisplayMode, ViewerNavigationTarget } from "../components/DocumentViewer.js";
import { SearchPanel } from "../components/SearchPanel.js";
import { QuickOpenPalette } from "../components/QuickOpenPalette.js";
import { applyThemePreference, storeThemePreference, type ThemePreference } from "../theme.js";
import { viewerHeartbeatRequest } from "../viewer-session.js";
import { ReviewTreeItems } from "../components/WalkthroughPanel.js";
import type { MermaidReferencePeekResolution } from "../components/MermaidExpandedView.js";
import {
  commitRangeOldOid,
  earliestIncludedCommitOid,
  normalizedCommitRange,
  pullRequestRangeStartOid,
} from "../commit-range.js";
import {
  currentCommitDocument,
  documentPaneIds,
  documentPaneTransitions,
  documentPaneTabKey,
  documentTabKey,
  initialDocumentWorkspace,
  moveDocumentToPane,
  normalizeDocumentPanes,
  preferredDocumentPane,
  removeDocumentFromWorkspace,
  type ActiveDocument,
  type DocumentPaneId,
  type DocumentWorkspaceState,
  type ReferenceDocumentContext,
} from "../document-workspace.js";
import {
  clearCommentDraftsForPullRequest,
  moveCommentDraftsForWorkspaceTransition,
} from "../comment-draft-store.js";
import { deriveDocumentViewerState } from "../document-viewer-state.js";
import { transferStructureSession } from "../structure-session.js";
import { useDocumentWorkspace } from "../use-document-workspace.js";
import {
  agentNotificationBody,
  browserNotificationPermission,
  readAgentNotificationsEnabled,
  scanAgentPostNotifications,
  storeAgentNotificationsEnabled,
} from "../agent-notifications.js";
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
const StructureViewer = lazy(async () => {
  const module = await import("../components/StructureViewer.js");
  return { default: module.StructureViewer };
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
// Keep these drag bounds aligned with the sidebar stack constraints in main.css.
const MIN_CODE_STACK_HEIGHT = 260;
const CODE_STACK_COMPACT_SHARE = 0.58;
const MIN_COMMENTS_STACK_HEIGHT = 210;
const COMMENTS_STACK_COMPACT_SHARE = 0.28;
const COLLAPSED_STACK_HEIGHT = 37;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function initialSidebarWidth(): number {
  return window.innerWidth <= 850 ? 280 : DEFAULT_SIDEBAR_WIDTH;
}

function commentsStackHeightBounds(
  sidebar: HTMLElement,
  codeExpanded: boolean,
): { minimum: number; maximum: number } {
  const sidebarHeight = sidebar.getBoundingClientRect().height;
  const minimum = Math.min(MIN_COMMENTS_STACK_HEIGHT, sidebarHeight * COMMENTS_STACK_COMPACT_SHARE);
  const reservedCodeHeight = codeExpanded
    ? Math.min(MIN_CODE_STACK_HEIGHT, sidebarHeight * CODE_STACK_COMPACT_SHARE)
    : COLLAPSED_STACK_HEIGHT;
  return {
    minimum,
    maximum: Math.max(minimum, sidebarHeight - reservedCodeHeight),
  };
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

function SidebarSearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.5 10.5 3.25 3.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SidebarBackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M9.75 3.25 5 8l4.75 4.75"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
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

export function PullRequestReviewScreen({
  initialThemePreference,
  pullRequestId,
  restoreReadingHistoryOnMount,
  onNavigateToList,
}: {
  initialThemePreference: ThemePreference;
  pullRequestId: string;
  restoreReadingHistoryOnMount: boolean;
  onNavigateToList: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [rangeStartOid, setRangeStartOid] = useState<string | null>(null);
  const [documentDisplayMode, setDocumentDisplayMode] = useState<DocumentDisplayMode>("full");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [codeExpanded, setCodeExpanded] = useState(true);
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [commentsHeight, setCommentsHeight] = useState<number | null>(null);
  const [commentsMeasuredHeight, setCommentsMeasuredHeight] = useState(COLLAPSED_STACK_HEIGHT);
  const [codeNavigationMode, setCodeNavigationMode] = useState<"files" | "search">("files");
  const [treeMode, setTreeMode] = useState<"changed" | "all">("changed");
  const [viewerNavigationTargets, setViewerNavigationTargets] = useState<
    Record<DocumentPaneId, ViewerNavigationTarget | null>
  >({ left: null, right: null });
  const viewerNavigationTargetsRef = useRef(viewerNavigationTargets);
  const appliedLineNavigation = useRef<Record<DocumentPaneId, AppliedLineNavigation | null>>({
    left: null,
    right: null,
  });
  viewerNavigationTargetsRef.current = viewerNavigationTargets;
  const resetViewerNavigation = useCallback((paneIds: readonly DocumentPaneId[]): void => {
    const uniquePaneIds = [...new Set(paneIds)];
    const nextTargets = { ...viewerNavigationTargetsRef.current };
    for (const paneId of uniquePaneIds) {
      nextTargets[paneId] = null;
      appliedLineNavigation.current[paneId] = null;
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
  } = useDocumentWorkspace(resetViewerNavigation);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [paneSplit, setPaneSplit] = useState(DEFAULT_PANE_SPLIT);
  const [resizingSurface, setResizingSurface] = useState<"sidebar" | "comments" | "panes" | null>(
    null,
  );
  const [draggedDocumentKey, setDraggedDocumentKey] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [quickOpenReturnFocus, setQuickOpenReturnFocus] = useState<HTMLElement | null>(null);
  const [paneFindState, setPaneFindState] = useState<
    Record<DocumentPaneId, { visible: boolean; openRequestId: number }>
  >({
    left: { visible: false, openRequestId: 0 },
    right: { visible: false, openRequestId: 0 },
  });
  const [searchText, setSearchText] = useState("");
  const [searchMatchCase, setSearchMatchCase] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [reviewStateRevision, setReviewStateRevision] = useState(0);
  const [draftWorkspaceRevision, setDraftWorkspaceRevision] = useState(0);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const [agentNotificationsEnabled, setAgentNotificationsEnabled] = useState(
    readAgentNotificationsEnabled,
  );
  const [themePreference, setThemePreference] = useState<ThemePreference>(initialThemePreference);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const handleCommentActiveChange = useCallback((commentId: string, active: boolean): void => {
    setActiveCommentId((current) => (active ? commentId : current === commentId ? null : current));
  }, []);
  const activateSidebarComment = useCallback((commentId: string): void => {
    setActiveCommentId(commentId);
    setCommentsExpanded(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            `.comment-sidebar [data-comment-id="${CSS.escape(commentId)}"]`,
          )
          ?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
      });
    });
  }, []);
  const attemptedInitialRefresh = useRef(false);
  const commitRangeTouched = useRef(false);
  const commitRangeInteractionRevision = useRef(0);
  const refreshInFlight = useRef(false);
  const commitRangeInteractionHeadOid = useRef<string | null>(null);
  const observedLatestHead = useRef<string | null>(null);
  const observedChangeSequence = useRef<number | null>(null);
  const observedAgentPostPullRequestId = useRef<string | null>(null);
  const observedAgentPostSnapshot = useRef<Map<string, string> | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const commentsStackRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchNavigationSequence = useRef(0);
  const codeReferenceRequestSequence = useRef<Record<DocumentPaneId, number>>({
    left: 0,
    right: 0,
  });
  useLayoutEffect(() => {
    if (!commentsExpanded || !commentsStackRef.current) return;
    const commentsStack = commentsStackRef.current;
    const sidebar = commentsStack.parentElement;
    const updateMeasuredHeight = (): void => {
      const nextHeight = Math.round(commentsStack.getBoundingClientRect().height);
      setCommentsMeasuredHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };
    updateMeasuredHeight();
    const commentsObserver = new ResizeObserver(updateMeasuredHeight);
    commentsObserver.observe(commentsStack);
    const clampManualHeight = (): void => {
      if (!sidebar) return;
      const heightBounds = commentsStackHeightBounds(sidebar, codeExpanded);
      setCommentsHeight((currentHeight) => {
        if (currentHeight === null) return currentHeight;
        return clamp(currentHeight, heightBounds.minimum, heightBounds.maximum);
      });
    };
    clampManualHeight();
    const sidebarObserver = new ResizeObserver(clampManualHeight);
    if (sidebar) sidebarObserver.observe(sidebar);
    return () => {
      commentsObserver.disconnect();
      sidebarObserver.disconnect();
    };
  }, [codeExpanded, commentsExpanded]);
  const debouncedSearch = useDebouncedValue(searchText.trim(), 250);
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
  const readingHistoryReady = useRef(false);
  const readingHistoryScrollTimeout = useRef<number | null>(null);
  const leftActiveDocumentKey = documentWorkspace.active.left
    ? documentPaneTabKey("left", documentWorkspace.active.left)
    : null;
  const rightActiveDocumentKey = documentWorkspace.active.right
    ? documentPaneTabKey("right", documentWorkspace.active.right)
    : null;
  const previousDocumentWorkspace = useRef(documentWorkspace);

  useLayoutEffect(() => {
    const previous = previousDocumentWorkspace.current;
    for (const transition of documentPaneTransitions(previous, documentWorkspace)) {
      if (
        previous.documents[transition.targetPane].some(
          (document) => documentTabKey(document) === documentTabKey(transition.targetDocument),
        )
      ) {
        continue;
      }
      const sourceTop = documentScrollPositions.current.get(
        documentPaneTabKey(transition.sourcePane, transition.sourceDocument),
      );
      if (sourceTop !== undefined) {
        documentScrollPositions.current.set(
          documentPaneTabKey(transition.targetPane, transition.targetDocument),
          sourceTop,
        );
      }
    }
    previousDocumentWorkspace.current = documentWorkspace;
  }, [documentWorkspace]);

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
    const paneDocumentKey = documentPaneTabKey(pane, document);
    const navigationTarget = viewerNavigationTargetsRef.current[pane];
    const scrollTop =
      paneElements.current[pane]?.scrollTop ??
      documentScrollPositions.current.get(paneDocumentKey) ??
      0;
    const lineNavigation = appliedLineNavigation.current[pane];
    const lineNavigationStillAnchored = Boolean(
      navigationTarget?.pane === pane &&
      navigationTarget.documentKey === documentKey &&
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
      const navigationTarget = viewerNavigationTargetsRef.current[pane];
      const workspace = documentWorkspaceRef.current;
      const document = workspace.active[pane];
      if (
        !navigationTarget ||
        navigationTarget.requestId !== requestId ||
        navigationTarget.pane !== pane ||
        !document ||
        documentTabKey(document) !== navigationTarget.documentKey
      ) {
        return;
      }
      appliedLineNavigation.current[pane] = {
        requestId,
        documentKey: navigationTarget.documentKey,
        pane,
        top:
          paneElements.current[pane]?.scrollTop ??
          documentScrollPositions.current.get(documentPaneTabKey(pane, document)) ??
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
      pane: DocumentPaneId,
      locator: Extract<ReadingLocator, { kind: "line" }>,
      resetHorizontal: boolean,
    ) => {
      searchNavigationSequence.current += 1;
      const target: ViewerNavigationTarget = {
        documentKey,
        pane,
        line: locator.line,
        ...(locator.endLine === undefined ? {} : { endLine: locator.endLine }),
        requestId: searchNavigationSequence.current,
        resetHorizontal,
      };
      appliedLineNavigation.current[pane] = null;
      const nextTargets = { ...viewerNavigationTargetsRef.current, [pane]: target };
      viewerNavigationTargetsRef.current = nextTargets;
      setViewerNavigationTargets(nextTargets);
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
      const documentKey = documentTabKey(document);
      const pane = targetPane ?? "left";
      const destinationLocator =
        locator ??
        ({
          kind: "scroll",
          top: documentScrollPositions.current.get(documentPaneTabKey(pane, document)) ?? 0,
        } satisfies ReadingLocator);
      pushReadingHistory(document, pane, destinationLocator);
      openWorkspaceDocument(document, pane);
      if (destinationLocator.kind === "line") {
        requestLineNavigation(documentKey, pane, destinationLocator, resetHorizontal);
      }
    },
    [openWorkspaceDocument, pushReadingHistory, requestLineNavigation],
  );

  const navigateToMarkdownFragment = useCallback(
    (document: ActiveDocument, pane: DocumentPaneId, line: number, hash: string): void => {
      const documentKey = documentTabKey(document);
      const locator = { kind: "line", line } satisfies ReadingLocator;
      pushReadingHistory(document, pane, locator, hash);
      requestLineNavigation(documentKey, pane, locator, true);
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
      const targetPane = pane ?? preferredDocumentPane(workspace, document);
      pushReadingHistory(document, targetPane, {
        kind: "scroll",
        top: documentScrollPositions.current.get(documentPaneTabKey(targetPane, document)) ?? 0,
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

  const applyDocumentWorkspaceTransition = useCallback(
    (
      nextWorkspace: DocumentWorkspaceState,
      navigationPanes: readonly DocumentPaneId[] = [],
    ): boolean => {
      const previousWorkspace = documentWorkspaceRef.current;
      if (nextWorkspace === previousWorkspace) return true;
      const paneTransitions = documentPaneTransitions(previousWorkspace, nextWorkspace);
      if (pullRequestId) {
        const result = moveCommentDraftsForWorkspaceTransition(
          pullRequestId,
          previousWorkspace,
          nextWorkspace,
        );
        if (result.status === "conflict") {
          setSyncFeedback(
            "移動先にも入力中のコメントまたは返信があります。どちらかを送信または消去してから移動してください。",
          );
          return false;
        }
        if (result.commentDraftsMoved) setDraftWorkspaceRevision((revision) => revision + 1);
      }
      for (const { sourceDocument, sourcePane, targetPane } of paneTransitions) {
        if (sourceDocument.kind !== "structure") continue;
        const targetAlreadyHadDocument = previousWorkspace.documents[targetPane].some(
          (document) => documentTabKey(document) === documentTabKey(sourceDocument),
        );
        if (!targetAlreadyHadDocument) {
          transferStructureSession(sourceDocument.id, sourcePane, targetPane);
        }
      }
      resetViewerNavigation([
        ...new Set([
          ...navigationPanes,
          ...paneTransitions.flatMap(({ sourcePane, targetPane }) => [sourcePane, targetPane]),
        ]),
      ]);
      documentWorkspaceRef.current = nextWorkspace;
      setDocumentWorkspace(() => nextWorkspace);
      return true;
    },
    [documentWorkspaceRef, pullRequestId, resetViewerNavigation, setDocumentWorkspace],
  );

  const closeDocumentWithDrafts = useCallback(
    (document: ActiveDocument, paneId?: DocumentPaneId): void => {
      const current = documentWorkspaceRef.current;
      applyDocumentWorkspaceTransition(
        removeDocumentFromWorkspace(current, document, paneId),
        paneId ? [paneId] : ["left", "right"],
      );
    },
    [applyDocumentWorkspaceTransition, documentWorkspaceRef],
  );

  const closePaneDocumentsWithDrafts = useCallback(
    (paneId: DocumentPaneId, keepDocument: ActiveDocument | null = null): void => {
      const current = documentWorkspaceRef.current;
      const keepKey = keepDocument ? documentTabKey(keepDocument) : null;
      const nextWorkspace = current.documents[paneId]
        .filter((document) => documentTabKey(document) !== keepKey)
        .reduce(
          (workspace, document) => removeDocumentFromWorkspace(workspace, document, paneId),
          current,
        );
      applyDocumentWorkspaceTransition(nextWorkspace, [paneId]);
    },
    [applyDocumentWorkspaceTransition, documentWorkspaceRef],
  );

  const moveDocumentWithDrafts = useCallback(
    (document: ActiveDocument, sourcePane: DocumentPaneId, targetPane: DocumentPaneId): void => {
      const nextWorkspace = moveDocumentToPane(
        documentWorkspaceRef.current,
        document,
        sourcePane,
        targetPane,
      );
      if (nextWorkspace === documentWorkspaceRef.current) return;
      applyDocumentWorkspaceTransition(nextWorkspace, [sourcePane, targetPane]);
    },
    [applyDocumentWorkspaceTransition, documentWorkspaceRef],
  );

  const dropDocument = useCallback(
    (documentKey: string, sourcePane: DocumentPaneId, targetPane: DocumentPaneId): void => {
      const document = documentWorkspaceRef.current.documents[sourcePane].find(
        (candidate) => documentTabKey(candidate) === documentKey,
      );
      if (document) moveDocumentWithDrafts(document, sourcePane, targetPane);
      setDraggedDocumentKey(null);
    },
    [documentWorkspaceRef, moveDocumentWithDrafts],
  );

  const updateSidebarWidth = (clientX: number, workspace: HTMLElement): void => {
    const bounds = workspace.getBoundingClientRect();
    const dynamicMaximum = Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, bounds.width - MIN_MAIN_VIEW_WIDTH),
    );
    setSidebarWidth(clamp(clientX - bounds.left, MIN_SIDEBAR_WIDTH, dynamicMaximum));
  };
  const updateCommentsHeight = (clientY: number, sidebar: HTMLElement): void => {
    const bounds = sidebar.getBoundingClientRect();
    const heightBounds = commentsStackHeightBounds(sidebar, codeExpanded);
    setCommentsHeight(clamp(bounds.bottom - clientY, heightBounds.minimum, heightBounds.maximum));
  };
  const adjustCommentsHeight = (delta: number): void => {
    const commentsStack = commentsStackRef.current;
    const sidebar = commentsStack?.parentElement;
    if (!commentsStack || !sidebar) return;
    const heightBounds = commentsStackHeightBounds(sidebar, codeExpanded);
    const currentHeight = commentsStack.getBoundingClientRect().height;
    setCommentsHeight(clamp(currentHeight + delta, heightBounds.minimum, heightBounds.maximum));
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
  const notificationPermission = browserNotificationPermission();
  const agentNotificationsActive =
    agentNotificationsEnabled && notificationPermission === "granted";
  const toggleAgentNotifications = async (): Promise<void> => {
    setActionsMenuOpen(false);
    if (agentNotificationsActive) {
      storeAgentNotificationsEnabled(false);
      setAgentNotificationsEnabled(false);
      setSyncFeedback("Agentのコメント通知をオフにしました。");
      return;
    }
    if (notificationPermission === "unsupported") {
      storeAgentNotificationsEnabled(false);
      setAgentNotificationsEnabled(false);
      setSyncFeedback("このブラウザはBrowser Notificationに対応していません。");
      return;
    }
    if (notificationPermission === "denied") {
      storeAgentNotificationsEnabled(false);
      setAgentNotificationsEnabled(false);
      setSyncFeedback("ブラウザのサイト設定で通知を許可してください。");
      return;
    }
    let permission: NotificationPermission;
    try {
      permission =
        notificationPermission === "granted" ? "granted" : await Notification.requestPermission();
    } catch (error) {
      console.warn("ブラウザへ通知permissionを要求できませんでした。", error);
      storeAgentNotificationsEnabled(false);
      setAgentNotificationsEnabled(false);
      setSyncFeedback("通知permissionを要求できませんでした。ブラウザの設定を確認してください。");
      return;
    }
    const enabled = permission === "granted";
    storeAgentNotificationsEnabled(enabled);
    setAgentNotificationsEnabled(enabled);
    setSyncFeedback(
      enabled
        ? "Agentのコメントをブラウザ通知します。"
        : "通知は許可されませんでした。ブラウザのサイト設定から変更できます。",
    );
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
    const suppressRefreshHeadFollow = Boolean(
      previousLatest &&
      latestHeadOid !== previousLatest &&
      commitRangeInteractionHeadOid.current === previousLatest,
    );
    if (
      latestHeadOid !== previousLatest &&
      commitRangeInteractionHeadOid.current === previousLatest
    ) {
      commitRangeInteractionHeadOid.current = null;
    }
    if (
      latestHeadOid &&
      !suppressRefreshHeadFollow &&
      (!selectedOid || selectedOid === previousLatest)
    ) {
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
      const openPanes = documentPaneIds(workspace, entry.document);
      const pane = openPanes.includes(entry.pane) ? entry.pane : (openPanes[0] ?? entry.pane);
      if (entry.locator.kind === "scroll") {
        documentScrollPositions.current.set(
          documentPaneTabKey(pane, entry.document),
          entry.locator.top,
        );
      }
      openWorkspaceDocument(entry.document, pane);
      if (entry.locator.kind === "line") {
        requestLineNavigation(documentKey, pane, entry.locator, true);
        return;
      }
      const scrollTop = entry.locator.top;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const paneElement = paneElements.current[pane];
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
    if (restoreReadingHistoryOnMount) {
      const retainedEntry = parseReadingHistoryEntry(window.history.state, pullRequestId);
      if (retainedEntry) {
        restoreReadingHistory(retainedEntry);
        return;
      }
    }
    const entry = currentReadingHistoryEntry();
    if (!entry) return;
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(readingHistoryState(window.history.state, entry), "", url);
  }, [
    currentReadingHistoryEntry,
    pullRequestId,
    pullRequestQuery.isSuccess,
    restoreReadingHistory,
    restoreReadingHistoryOnMount,
    selectedOid,
  ]);

  useEffect(() => {
    const openPaneFind = (event: KeyboardEvent): void => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "f"
      ) {
        return;
      }
      const workspace = documentWorkspaceRef.current;
      const pane = workspace.focusedPane;
      if (!workspace.active[pane]) return;
      const activeElement = document.activeElement;
      const paneElement = paneElements.current[pane];
      if (!paneElement || !(activeElement instanceof Node) || !paneElement.contains(activeElement))
        return;
      if (
        activeElement instanceof HTMLElement &&
        activeElement.matches("input, textarea, select, [contenteditable='true']") &&
        !activeElement.closest(".pane-find-widget")
      )
        return;
      event.preventDefault();
      setPaneFindState((current) => ({
        ...current,
        [pane]: {
          visible: true,
          openRequestId: current[pane].openRequestId + 1,
        },
      }));
    };
    document.addEventListener("keydown", openPaneFind);
    return () => document.removeEventListener("keydown", openPaneFind);
  }, [documentWorkspaceRef]);
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
      setCodeExpanded(true);
      setCodeNavigationMode("search");
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
    commitRangeInteractionRevision.current += 1;
    if (refreshInFlight.current) commitRangeInteractionHeadOid.current = latestHeadOid;
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
    void queryClient.invalidateQueries({ queryKey: ["structures"] });
    void queryClient.invalidateQueries({ queryKey: ["structure"] });
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
  useEffect(() => {
    if (!commentsQuery.isSuccess || !commentsQuery.data || !pullRequestId) return;
    if (observedAgentPostPullRequestId.current !== pullRequestId) {
      observedAgentPostPullRequestId.current = pullRequestId;
      observedAgentPostSnapshot.current = null;
    }
    const scan = scanAgentPostNotifications(
      observedAgentPostSnapshot.current,
      commentsQuery.data.comments,
    );
    observedAgentPostSnapshot.current = scan.snapshot;
    if (!agentNotificationsEnabled || browserNotificationPermission() !== "granted") return;
    for (const { post } of scan.notifications) {
      try {
        const notification = new Notification(`rvw · ${post.authorLabel}`, {
          body: agentNotificationBody(post.body),
          tag: `rvw-agent-post:${pullRequestId}:${post.id}`,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch (error) {
        console.warn("Agentのコメントをブラウザ通知できませんでした。", error);
      }
    }
  }, [agentNotificationsEnabled, commentsQuery.data, commentsQuery.isSuccess, pullRequestId]);
  const unresolvedCommentCount = comments.filter((comment) => !comment.resolvedAt).length;
  const walkthroughsQuery = useQuery({
    queryKey: ["walkthroughs", pullRequestId],
    queryFn: async () =>
      await api<WalkthroughsResponse>(`/api/pull-requests/${pullRequestId}/walkthroughs`),
    enabled: Boolean(pullRequestId),
  });
  const walkthroughs = walkthroughsQuery.data?.walkthroughs ?? [];
  const structuresQuery = useQuery({
    queryKey: ["structures", pullRequestId],
    queryFn: async () =>
      await api<StructuresResponse>(`/api/pull-requests/${pullRequestId}/structures`),
    enabled: Boolean(pullRequestId),
  });
  const structures = structuresQuery.data?.structures ?? [];
  useEffect(() => {
    if (!walkthroughsQuery.isSuccess) return;
    const summaries = new Map(walkthroughs.map((walkthrough) => [walkthrough.id, walkthrough]));
    const current = documentWorkspaceRef.current;
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
        documents[paneId].some((candidate) => documentTabKey(candidate) === documentTabKey(rebound))
      ) {
        return rebound;
      }
      return documents[paneId][0] ?? null;
    };
    applyDocumentWorkspaceTransition(
      normalizeDocumentPanes({
        ...current,
        documents,
        active: {
          left: activeDocument("left", current.active.left),
          right: activeDocument("right", current.active.right),
        },
      }),
    );
  }, [
    applyDocumentWorkspaceTransition,
    documentWorkspaceRef,
    walkthroughsQuery.data?.walkthroughs,
    walkthroughsQuery.isSuccess,
  ]);
  useEffect(() => {
    if (!structuresQuery.isSuccess) return;
    const summaries = new Map(structures.map((structure) => [structure.id, structure]));
    const current = documentWorkspaceRef.current;
    const rebind = (document: ActiveDocument | null): ActiveDocument | null => {
      if (document?.kind !== "structure") return document;
      const summary = summaries.get(document.id);
      return summary
        ? {
            kind: "structure",
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
        documents[paneId].some((candidate) => documentTabKey(candidate) === documentTabKey(rebound))
      ) {
        return rebound;
      }
      return documents[paneId][0] ?? null;
    };
    applyDocumentWorkspaceTransition(
      normalizeDocumentPanes({
        ...current,
        documents,
        active: {
          left: activeDocument("left", current.active.left),
          right: activeDocument("right", current.active.right),
        },
      }),
    );
  }, [
    applyDocumentWorkspaceTransition,
    documentWorkspaceRef,
    structuresQuery.data?.structures,
    structuresQuery.isSuccess,
  ]);
  const openWalkthroughIds = useMemo(
    () => [
      ...new Set(
        openDocuments.flatMap((document) =>
          document.kind === "walkthrough"
            ? [document.id]
            : document.kind === "repository-file" && document.referenceContext
              ? [document.referenceContext.walkthroughId]
              : [],
        ),
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
  const openStructureIds = useMemo(
    () => [
      ...new Set(
        openDocuments.flatMap((document) => (document.kind === "structure" ? [document.id] : [])),
      ),
    ],
    [openDocuments],
  );
  const structureDetailQueries = useQueries({
    queries: openStructureIds.map((structureId) => ({
      queryKey: ["structure", pullRequestId, structureId],
      queryFn: async () =>
        await api<StructureResponse>(
          `/api/pull-requests/${pullRequestId}/structures/${structureId}`,
        ),
      enabled: Boolean(pullRequestId),
    })),
  });
  const structureDetails = new Map<string, Structure>();
  const loadingStructureIds = new Set<string>();
  openStructureIds.forEach((structureId, index) => {
    const query = structureDetailQueries[index];
    const structure = query?.data?.structure;
    if (structure) structureDetails.set(structureId, structure);
    if (query?.isPending) loadingStructureIds.add(structureId);
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
    onMutate: () => {
      refreshInFlight.current = true;
      return {
        commitRangeInteractionRevision: commitRangeInteractionRevision.current,
        selectedOid,
        latestHeadOid,
        rangeStartOid,
      };
    },
    onSuccess: async (result, options, refreshStart) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["pull-request"] }),
        queryClient.invalidateQueries({ queryKey: ["document"] }),
        queryClient.invalidateQueries({ queryKey: ["annotations"] }),
        queryClient.invalidateQueries({ queryKey: ["comment-placement"] }),
        queryClient.invalidateQueries({ queryKey: ["search"] }),
      ]);
      const commitRangeUnchanged =
        refreshStart.commitRangeInteractionRevision === commitRangeInteractionRevision.current;
      const wasAtLatest = refreshStart.selectedOid === refreshStart.latestHeadOid;
      if (commitRangeUnchanged && (wasAtLatest || !refreshStart.selectedOid)) {
        setSelectedOid(result.headOid);
        const previousStartStillExists = result.commits.some(
          (commit) => commit.oid === refreshStart.rangeStartOid,
        );
        setRangeStartOid(
          !commitRangeTouched.current
            ? pullRequestRangeStartOid(result.commits, result.headOid)
            : refreshStart.rangeStartOid === refreshStart.selectedOid
              ? result.headOid
              : previousStartStillExists
                ? refreshStart.rangeStartOid
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
    onError: () => {
      commitRangeInteractionHeadOid.current = null;
    },
    onSettled: (result) => {
      refreshInFlight.current = false;
      if (
        result &&
        commitRangeInteractionHeadOid.current === result.headOid &&
        observedLatestHead.current === result.headOid
      ) {
        commitRangeInteractionHeadOid.current = null;
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
        `ローカルレビュー状態を削除して再構築します。\n\nコメント ${counts.comments ?? 0}\n返信 ${counts.posts ?? 0}\nコメント内コード参照 ${counts.commentReferences ?? 0}\n対象 ${counts.targets ?? 0}\nウォークスルー ${counts.walkthroughs ?? 0}\nウォークスルーコード参照 ${counts.walkthroughReferences ?? 0}\nStructure ${counts.structures ?? 0}\nGit ref ${counts.gitRefs ?? 0}\n\nこの操作は元に戻せません。`,
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
  const openSearchResult = (result: SearchResult, openInRightPane = false): void => {
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
    comment: ReviewComment,
    placement: CommentPlacement | null,
    openInRightPane: boolean,
  ): void => {
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
  const openStructure = useCallback(
    (structure: StructureSummary, openInRightPane = false): void => {
      openDocument(
        {
          kind: "structure",
          id: structure.id,
          title: structure.title,
          sourceOid: structure.sourceOid,
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
  const fetchWalkthroughReferenceResolution = useCallback(
    async (walkthroughId: string, referenceId: string): Promise<WalkthroughReferenceResolution> => {
      if (!pullRequestId) throw new Error("Pull Requestが選択されていません。");
      const { resolution } = await api<WalkthroughReferenceResolutionResponse>(
        `/api/pull-requests/${pullRequestId}/walkthroughs/${walkthroughId}/references/${encodeURIComponent(referenceId)}/resolve`,
      );
      return resolution;
    },
    [pullRequestId],
  );
  const resolveWalkthroughReference = useCallback(
    async (
      walkthroughId: string,
      referenceId: string,
      referencePath: string,
      targetPane: DocumentPaneId,
    ): Promise<string | null> => {
      if (!pullRequestId) return `参照先を開けません · ${referencePath}`;
      codeReferenceRequestSequence.current[targetPane] += 1;
      const requestSequence = codeReferenceRequestSequence.current[targetPane];
      const targetNavigationRevision = documentWorkspaceRef.current.navigationRevision[targetPane];
      const requestIsCurrent = (): boolean =>
        requestSequence === codeReferenceRequestSequence.current[targetPane] &&
        documentWorkspaceRef.current.navigationRevision[targetPane] === targetNavigationRevision;
      try {
        const resolution = await fetchWalkthroughReferenceResolution(walkthroughId, referenceId);
        if (!requestIsCurrent()) return null;
        if (resolution.document.availability !== "available") {
          return resolution.document.availability === "missing"
            ? `リンク切れ · ${referencePath}`
            : `参照先を表示できません · ${referencePath}`;
        }
        queryClient.setQueryData(["document", resolution.document.ref], resolution.document);
        const target = resolution.target;
        const document: ActiveDocument = {
          kind: "repository-file",
          path: target.path,
          oldPath: target.oldPath,
          newPath: target.newPath,
          sourceOid: target.sourceOid,
          comparisonPolicy: "reference-target",
          referenceContext: {
            outcome: resolution.outcome,
            walkthroughId,
            referenceId,
            anchorSourceOid: resolution.anchorSourceOid,
            latestHeadOid: resolution.latestHeadOid,
            referenceFingerprint: resolution.referenceFingerprint,
            diffBaseOid: target.diffBaseOid,
            hasDiff: target.hasDiff,
            latestFile: resolution.latestFile,
          },
        };
        const documentKey = documentTabKey(document);
        const activeTarget = documentWorkspaceRef.current.active[targetPane];
        const resetHorizontal = !activeTarget || documentTabKey(activeTarget) !== documentKey;
        navigateToDocument(
          document,
          targetPane,
          {
            kind: "line",
            line: target.startLine,
            ...(target.endLine === null ? {} : { endLine: target.endLine }),
          },
          resetHorizontal,
        );
        return null;
      } catch (error) {
        if (!requestIsCurrent()) return null;
        return error instanceof ApiError &&
          ["COMMIT_NOT_FOUND", "DOCUMENT_NOT_FOUND", "NOT_FOUND"].includes(error.code)
          ? `リンク切れ · ${referencePath}`
          : `参照先を開けません · ${referencePath}`;
      }
    },
    [fetchWalkthroughReferenceResolution, navigateToDocument, pullRequestId, queryClient],
  );
  const resolveWalkthroughReferenceForPeek = useCallback(
    async (
      walkthrough: Walkthrough,
      reference: WalkthroughReference,
    ): Promise<MermaidReferencePeekResolution> => {
      const resolution = await fetchWalkthroughReferenceResolution(walkthrough.id, reference.id);
      const target = resolution.target;
      return {
        sourceOid: target.sourceOid,
        reference: {
          ...reference,
          path: target.path,
          startLine: target.startLine,
          endLine: target.endLine,
        },
        document: resolution.document,
      };
    },
    [fetchWalkthroughReferenceResolution],
  );
  const openWalkthroughReference = useCallback(
    (
      walkthrough: Walkthrough,
      reference: WalkthroughReference,
      targetPane: DocumentPaneId,
    ): Promise<string | null> =>
      resolveWalkthroughReference(walkthrough.id, reference.id, reference.path, targetPane),
    [resolveWalkthroughReference],
  );
  const openWalkthroughReferenceFromInteraction = useCallback(
    (walkthrough: Walkthrough, reference: WalkthroughReference, openInRightPane: boolean) =>
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
  const openStructureAnchor = useCallback(
    (structure: Structure, anchor: SourceAnchor, openInRightPane: boolean) => {
      if (!pullRequestId) return Promise.resolve(`参照先を開けません · ${anchor.path}`);
      return openCodeReference(
        pullRequestId,
        structure.sourceOid,
        {
          id: "structure-source",
          label: anchor.path,
          path: anchor.path,
          startLine: anchor.startLine,
          endLine: anchor.endLine,
          description: null,
        },
        openInRightPane ? "right" : "left",
        "exact-source",
      );
    },
    [openCodeReference, pullRequestId],
  );
  const openLatestReferenceFile = useCallback(
    (target: WalkthroughReferenceFileTarget, targetPane: DocumentPaneId): void => {
      const document: ActiveDocument = {
        kind: "repository-file",
        path: target.path,
        oldPath: target.oldPath,
        newPath: target.newPath,
        sourceOid: target.sourceOid,
        comparisonPolicy: target.sourceOid === selectedOid ? "selected-range" : "exact-source",
      };
      const activeTarget = documentWorkspaceRef.current.active[targetPane];
      navigateToDocument(
        document,
        targetPane,
        { kind: "line", line: null },
        !activeTarget || documentTabKey(activeTarget) !== documentTabKey(document),
      );
    },
    [navigateToDocument, selectedOid],
  );
  const reresolveWalkthroughReference = useCallback(
    (
      context: ReferenceDocumentContext,
      referencePath: string,
      targetPane: DocumentPaneId,
    ): Promise<string | null> =>
      resolveWalkthroughReference(
        context.walkthroughId,
        context.referenceId,
        referencePath,
        targetPane,
      ),
    [resolveWalkthroughReference],
  );

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
    latestHeadOid: pullRequest.latestHeadOid,
    changedFiles: changedQuery.data?.files,
    changedFilesLoaded: changedQuery.isSuccess,
    walkthroughDetails,
    loadingWalkthroughIds,
    structureDetails,
    loadingStructureIds,
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
      (document) =>
        document !== null && document.kind !== "walkthrough" && document.kind !== "structure",
    ),
  );
  const diffViewAvailable = Boolean(
    comparisonAvailable &&
    Object.values(paneViewerStates).some(
      (state) =>
        state.viewerDocument?.kind === "repository-file" &&
        (state.activeChange ||
          (state.viewerDocument.referenceContext?.outcome === "source-fallback" &&
            state.viewerDocument.referenceContext.hasDiff)),
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
  const commentsHeightRange = commentsStackRef.current?.parentElement
    ? commentsStackHeightBounds(commentsStackRef.current.parentElement, codeExpanded)
    : { minimum: MIN_COMMENTS_STACK_HEIGHT, maximum: window.innerHeight };

  const renderDocumentPane = (paneId: DocumentPaneId) => {
    const paneDocuments = documentWorkspace.documents[paneId];
    const paneDocument = documentWorkspace.active[paneId];
    const paneViewerState = paneViewerStates[paneId];
    const paneViewerDocument = paneViewerState.viewerDocument;
    const referenceContext =
      paneViewerDocument?.kind === "repository-file"
        ? paneViewerDocument.referenceContext
        : undefined;
    const referenceUsesGlobalComparison =
      referenceContext?.outcome === "latest" &&
      referenceContext.latestHeadOid === selectedOid &&
      paneViewerState.effectiveDisplayMode !== "full";
    const paneSelectedOid =
      paneViewerDocument?.kind === "repository-file" &&
      referenceContext &&
      !referenceUsesGlobalComparison
        ? (paneViewerDocument.sourceOid ?? selectedOid)
        : selectedOid;
    const paneOldOid =
      referenceContext?.outcome === "source-fallback"
        ? referenceContext.diffBaseOid
        : effectiveOldOid;
    return (
      <section
        ref={(element) => {
          paneElements.current[paneId] = element;
        }}
        onScroll={(event) => {
          if (paneViewerDocument) {
            documentScrollPositions.current.set(
              documentPaneTabKey(paneId, paneViewerDocument),
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
        tabIndex={-1}
        onFocusCapture={() => {
          setDocumentWorkspace((current) =>
            current.focusedPane === paneId ? current : { ...current, focusedPane: paneId },
          );
        }}
        onPointerDown={(event) => {
          setDocumentWorkspace((current) =>
            current.focusedPane === paneId ? current : { ...current, focusedPane: paneId },
          );
          const target = event.target;
          if (
            event.button === 0 &&
            !(
              target instanceof Element &&
              target.closest("button, a, input, textarea, select, [contenteditable='true']")
            )
          ) {
            event.currentTarget.focus({ preventScroll: true });
          }
        }}
      >
        <DocumentTabs
          paneId={paneId}
          documents={paneDocuments}
          activeDocument={paneDocument}
          changeKindsByPath={tabChangeKinds}
          onActivate={(document) => activateDocument(document, paneId)}
          onClose={(document) => closeDocumentWithDrafts(document, paneId)}
          onCloseOthers={(document) => closePaneDocumentsWithDrafts(paneId, document)}
          onCloseAll={() => closePaneDocumentsWithDrafts(paneId)}
          onMove={(document, targetPane) => moveDocumentWithDrafts(document, paneId, targetPane)}
          onDropDocument={dropDocument}
          onDragStartDocument={setDraggedDocumentKey}
          onDragEndDocument={() => setDraggedDocumentKey(null)}
        />
        <PaneFindWidget
          paneId={paneId}
          paneElement={paneElements.current[paneId]}
          documentKey={paneViewerDocument ? documentTabKey(paneViewerDocument) : null}
          visible={paneFindState[paneId].visible}
          openRequestId={paneFindState[paneId].openRequestId}
          onClose={() => {
            setPaneFindState((current) => ({
              ...current,
              [paneId]: { ...current[paneId], visible: false },
            }));
            window.requestAnimationFrame(() => {
              paneElements.current[paneId]?.focus({ preventScroll: true });
            });
          }}
        />
        {paneViewerDocument?.kind === "structure" && paneViewerState.structure ? (
          <LazyLoadBoundary label="Structure">
            <Suspense fallback={<div className="viewer-loading">Structureを準備しています…</div>}>
              <StructureViewer
                key={`${paneId}:${paneViewerState.structure.id}`}
                paneId={paneId}
                pullRequestId={pullRequest.id}
                structure={paneViewerState.structure}
                changedFiles={changedQuery.data?.files ?? []}
                onOpenAnchor={(anchor, openInRightPane) =>
                  openStructureAnchor(paneViewerState.structure!, anchor, openInRightPane)
                }
                onDeleted={() => {
                  closeDocumentWithDrafts(paneViewerDocument, paneId);
                  void queryClient.invalidateQueries({ queryKey: ["structures", pullRequestId] });
                }}
              />
            </Suspense>
          </LazyLoadBoundary>
        ) : paneViewerDocument?.kind === "structure" ? (
          <div className="empty-document-viewer">
            <strong>
              {paneViewerState.structureLoading
                ? "Structureを読み込んでいます…"
                : "Structureを読み込めませんでした。"}
            </strong>
          </div>
        ) : paneViewerDocument?.kind === "walkthrough" && paneViewerState.walkthrough ? (
          <LazyLoadBoundary label="ウォークスルー">
            <Suspense
              fallback={<div className="viewer-loading">ウォークスルーを準備しています…</div>}
            >
              <WalkthroughViewer
                walkthrough={paneViewerState.walkthrough}
                paneId={paneId}
                comments={comments}
                activeCommentId={activeCommentId}
                navigationTarget={
                  viewerNavigationTargets[paneId]?.documentKey ===
                  documentTabKey(paneViewerDocument)
                    ? viewerNavigationTargets[paneId]
                    : null
                }
                onNavigationApplied={(requestId) => markLineNavigationApplied(paneId, requestId)}
                themePreference={themePreference}
                onCommentActiveChange={handleCommentActiveChange}
                onActivateComment={activateSidebarComment}
                onOpenReference={openWalkthroughReferenceFromInteraction}
                onResolveReferenceForPeek={resolveWalkthroughReferenceForPeek}
                onOpenCommentCodeReference={openCommentCodeReferenceFromInteraction}
                onOpenRepositoryLink={openRepositoryMarkdownLinkFromInteraction}
                onDeleted={() => closeDocumentWithDrafts(paneViewerDocument, paneId)}
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
                key={`${reviewStateRevision}:${draftWorkspaceRevision}:${paneId}:${paneSelectedOid}:${paneOldOid ?? ""}:${paneViewerState.effectiveDisplayMode}:${documentTabKey(paneViewerDocument)}:${paneViewerDocument.kind === "repository-file" ? `${paneViewerDocument.sourceOid ?? ""}:${paneViewerDocument.comparisonPolicy ?? ""}:${paneViewerDocument.referenceContext?.latestHeadOid ?? ""}` : ""}`}
                pullRequestId={pullRequest.id}
                paneId={paneId}
                latestHeadOid={pullRequest.latestHeadOid}
                selectedOid={paneSelectedOid}
                oldOid={paneOldOid}
                activeDocument={paneViewerDocument}
                displayMode={paneViewerState.effectiveDisplayMode}
                diffStyle={diffStyle}
                comments={comments}
                activeCommentId={activeCommentId}
                fullViewNotice={paneViewerState.fullViewNotice}
                fullViewUnavailableMessage={paneViewerState.fullViewUnavailableMessage}
                referenceStaleness={paneViewerState.referenceStaleness}
                themePreference={themePreference}
                onCommentActiveChange={handleCommentActiveChange}
                navigationTarget={
                  viewerNavigationTargets[paneId]?.documentKey ===
                  documentTabKey(paneViewerDocument)
                    ? viewerNavigationTargets[paneId]
                    : null
                }
                onNavigationApplied={(requestId) => markLineNavigationApplied(paneId, requestId)}
                onOpenMarkdownFragment={(line, hash) =>
                  navigateToMarkdownFragment(paneViewerDocument, paneId, line, hash)
                }
                onOpenCodeReference={openCommentCodeReferenceFromInteraction}
                onOpenRepositoryLink={openRepositoryMarkdownLinkFromInteraction}
                onOpenLatestReferenceFile={(target) => openLatestReferenceFile(target, paneId)}
                onReresolveWalkthroughReference={(context) =>
                  reresolveWalkthroughReference(
                    context,
                    paneViewerDocument.kind === "repository-file"
                      ? paneViewerDocument.path
                      : "Pull Request.md",
                    paneId,
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

  const listUrl = new URL(window.location.href);
  listUrl.hash = "";
  listUrl.searchParams.delete("pullRequestId");
  const listHref = `${listUrl.pathname}${listUrl.search}`;

  return (
    <main className="app-shell">
      <a className="skip-link" href="#review-main-content">
        レビュー本文へ移動
      </a>
      <header className="topbar">
        <a
          className="brand brand-button"
          aria-label="Pull Request一覧へ"
          href={listHref}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            event.preventDefault();
            cancelReadingHistoryScrollSnapshot();
            replaceCurrentReadingHistory();
            onNavigateToList();
          }}
        >
          <span className="brand-mark">r</span>
          <strong>rvw</strong>
        </a>
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
              <div className="topbar-menu-section" role="group" aria-label="通知">
                <span className="topbar-menu-section-label">通知</span>
                <button
                  role="menuitemcheckbox"
                  aria-checked={agentNotificationsActive}
                  onClick={() => void toggleAgentNotifications()}
                >
                  <span>Agentのコメントを通知</span>
                  <span className="topbar-menu-check" aria-hidden="true">
                    {agentNotificationsActive
                      ? "✓"
                      : notificationPermission === "denied"
                        ? "拒否"
                        : notificationPermission === "unsupported"
                          ? "未対応"
                          : ""}
                  </span>
                </button>
              </div>
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
      <div
        className={`workspace${resizingSurface ? " is-resizing" : ""}${resizingSurface === "comments" ? " is-row-resizing" : ""}`}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="sidebar" aria-label="レビューサイドバー">
          <section
            className={`sidebar-stack sidebar-stack--code${codeExpanded ? " is-expanded" : ""}`}
          >
            <div className="sidebar-stack-header">
              <button
                className="sidebar-stack-toggle"
                aria-expanded={codeExpanded}
                onClick={() => setCodeExpanded((expanded) => !expanded)}
              >
                <FileEntryIcon kind="file" />
                <span>{codeNavigationMode === "search" ? "コード検索" : "エクスプローラー"}</span>
                <SidebarChevron expanded={codeExpanded} />
              </button>
              <button
                type="button"
                className={`sidebar-stack-action${codeNavigationMode === "search" ? " active" : ""}`}
                aria-label={
                  codeNavigationMode === "search" ? "ファイルツリーに戻る" : "コード検索を開く"
                }
                aria-pressed={codeNavigationMode === "search"}
                title={
                  codeNavigationMode === "search"
                    ? "ファイルツリーに戻る"
                    : "コード検索 (⌘ / Ctrl Shift F)"
                }
                onClick={() => {
                  if (codeNavigationMode === "search") {
                    setCodeNavigationMode("files");
                    return;
                  }
                  setCodeExpanded(true);
                  setCodeNavigationMode("search");
                  window.requestAnimationFrame(() => {
                    searchInputRef.current?.focus();
                    searchInputRef.current?.select();
                  });
                }}
              >
                {codeNavigationMode === "search" ? <SidebarBackIcon /> : <SidebarSearchIcon />}
              </button>
            </div>
            <div
              className="sidebar-stack-body sidebar-code-body"
              hidden={!codeExpanded || codeNavigationMode !== "files"}
            >
              <div className="file-panel">
                <ReviewTreeItems
                  walkthroughs={walkthroughs}
                  structures={structures}
                  pullRequestActive={activeDocument?.kind === "pull-request-markdown"}
                  activeWalkthroughId={
                    activeDocument?.kind === "walkthrough" ? activeDocument.id : null
                  }
                  activeStructureId={
                    activeDocument?.kind === "structure" ? activeDocument.id : null
                  }
                  onOpenPullRequest={(openInRightPane) => {
                    if (openInRightPane) {
                      openDocument({ kind: "pull-request-markdown" }, "right");
                      return;
                    }
                    openDocument({ kind: "pull-request-markdown" });
                  }}
                  onOpen={openWalkthrough}
                  onOpenStructure={openStructure}
                />
                <ErrorNotice error={walkthroughsQuery.error} />
                <ErrorNotice error={structuresQuery.error} />
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
            </div>
            <div
              className="sidebar-stack-body sidebar-code-body"
              hidden={!codeExpanded || codeNavigationMode !== "search"}
            >
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
            ref={commentsStackRef}
            className={`sidebar-stack sidebar-stack--comments${commentsExpanded ? " is-expanded" : ""}`}
            style={
              commentsExpanded && commentsHeight !== null
                ? { flex: `0 0 ${commentsHeight}px` }
                : undefined
            }
          >
            {commentsExpanded && (
              <div
                className={`vertical-resize-handle comments-resize-handle${resizingSurface === "comments" ? " active" : ""}`}
                role="separator"
                aria-label="コメント欄の高さを変更"
                aria-orientation="horizontal"
                aria-valuemin={Math.round(commentsHeightRange.minimum)}
                aria-valuemax={Math.round(commentsHeightRange.maximum)}
                aria-valuenow={commentsMeasuredHeight}
                aria-valuetext={commentsHeight === null ? "自動" : undefined}
                tabIndex={0}
                title="ドラッグしてコメント欄の高さを変更（ダブルクリックまたはEscで自動調整）"
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setResizingSurface("comments");
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  const sidebar = event.currentTarget.closest<HTMLElement>(".sidebar");
                  if (sidebar) updateCommentsHeight(event.clientY, sidebar);
                }}
                onPointerUp={finishResize}
                onPointerCancel={finishResize}
                onLostPointerCapture={() => setResizingSurface(null)}
                onDoubleClick={() => setCommentsHeight(null)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setCommentsHeight(null);
                    return;
                  }
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  adjustCommentsHeight(event.key === "ArrowUp" ? 16 : -16);
                }}
              />
            )}
            <button
              className="sidebar-stack-toggle"
              aria-expanded={commentsExpanded}
              onClick={() => setCommentsExpanded((expanded) => !expanded)}
            >
              <SidebarCommentIcon />
              <span>コメント</span>
              <span className="sidebar-stack-count">{unresolvedCommentCount}</span>
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
                onOpenCodeReference={openCommentCodeReferenceFromInteraction}
                onOpenTarget={openCommentTarget}
                onOpenRepositoryLink={openRepositoryMarkdownLinkFromInteraction}
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
