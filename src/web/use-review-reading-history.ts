import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ViewerNavigationTarget } from "./components/DocumentViewer.js";
import {
  documentTabKey,
  type ActiveDocument,
  type DocumentPaneId,
  type DocumentWorkspaceState,
} from "./document-workspace.js";
import {
  parseReadingHistoryEntry,
  readingHistoryState,
  sameReadingDocument,
  type ReadingHistoryEntry,
  type ReadingLocator,
} from "./reading-history.js";

interface AppliedLineNavigation {
  requestId: number;
  documentKey: string;
  pane: DocumentPaneId;
  top: number;
}

interface ReviewReadingHistoryOptions {
  reviewKey: string | null;
  workspace: DocumentWorkspaceState;
  workspaceRef: RefObject<DocumentWorkspaceState>;
  paneElements: RefObject<Record<DocumentPaneId, HTMLElement | null>>;
  documentScrollPositions: RefObject<Map<string, number>>;
  viewerNavigationTarget: ViewerNavigationTarget | null;
  setViewerNavigationTarget: Dispatch<SetStateAction<ViewerNavigationTarget | null>>;
  openWorkspaceDocument: (document: ActiveDocument, pane?: DocumentPaneId) => void;
  activateWorkspaceDocument: (document: ActiveDocument, pane?: DocumentPaneId) => void;
  scrollRevision?: number;
}

export function useReviewReadingHistory({
  reviewKey,
  workspace,
  workspaceRef,
  paneElements,
  documentScrollPositions,
  viewerNavigationTarget,
  setViewerNavigationTarget,
  openWorkspaceDocument,
  activateWorkspaceDocument,
  scrollRevision = 0,
}: ReviewReadingHistoryOptions) {
  const initializedReviewKey = useRef<string | null>(null);
  const scrollSnapshotTimeout = useRef<number | null>(null);
  const navigationSequence = useRef(0);
  const navigationTargetRef = useRef(viewerNavigationTarget);
  const appliedLineNavigation = useRef<AppliedLineNavigation | null>(null);
  navigationTargetRef.current = viewerNavigationTarget;
  if (!viewerNavigationTarget) appliedLineNavigation.current = null;

  const leftActiveDocumentKey = workspace.active.left
    ? documentTabKey(workspace.active.left)
    : null;
  const rightActiveDocumentKey = workspace.active.right
    ? documentTabKey(workspace.active.right)
    : null;

  useLayoutEffect(() => {
    const pane = paneElements.current?.left;
    if (!pane || !leftActiveDocumentKey) return;
    pane.scrollTop = documentScrollPositions.current?.get(leftActiveDocumentKey) ?? 0;
  }, [documentScrollPositions, leftActiveDocumentKey, paneElements, scrollRevision]);

  useLayoutEffect(() => {
    const pane = paneElements.current?.right;
    if (!pane || !rightActiveDocumentKey) return;
    pane.scrollTop = documentScrollPositions.current?.get(rightActiveDocumentKey) ?? 0;
  }, [documentScrollPositions, paneElements, rightActiveDocumentKey, scrollRevision]);

  const currentReadingHistoryEntry = useCallback((): ReadingHistoryEntry | null => {
    if (!reviewKey) return null;
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace) return null;
    const pane = currentWorkspace.focusedPane;
    const document = currentWorkspace.active[pane];
    if (!document) return null;
    const documentKey = documentTabKey(document);
    const navigationTarget = navigationTargetRef.current;
    const scrollTop =
      paneElements.current?.[pane]?.scrollTop ??
      documentScrollPositions.current?.get(documentKey) ??
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
        : { kind: "scroll", top: scrollTop };
    return {
      version: 1,
      reviewKey,
      pane,
      document,
      locator,
    };
  }, [documentScrollPositions, paneElements, reviewKey, workspaceRef]);

  const markLineNavigationApplied = useCallback(
    (pane: DocumentPaneId, requestId: number): void => {
      const navigationTarget = navigationTargetRef.current;
      const currentWorkspace = workspaceRef.current;
      const document = currentWorkspace?.active[pane];
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
          paneElements.current?.[pane]?.scrollTop ??
          documentScrollPositions.current?.get(navigationTarget.documentKey) ??
          0,
      };
    },
    [documentScrollPositions, paneElements, workspaceRef],
  );

  const cancelScrollSnapshot = useCallback((): void => {
    if (scrollSnapshotTimeout.current === null) return;
    window.clearTimeout(scrollSnapshotTimeout.current);
    scrollSnapshotTimeout.current = null;
  }, []);

  const replaceCurrentReadingHistory = useCallback((): void => {
    if (!reviewKey || initializedReviewKey.current !== reviewKey) return;
    const entry = currentReadingHistoryEntry();
    if (!entry) return;
    window.history.replaceState(readingHistoryState(window.history.state, entry), "");
  }, [currentReadingHistoryEntry, reviewKey]);

  const scheduleReadingHistoryScrollSnapshot = useCallback((): void => {
    if (!reviewKey || initializedReviewKey.current !== reviewKey) return;
    cancelScrollSnapshot();
    scrollSnapshotTimeout.current = window.setTimeout(() => {
      scrollSnapshotTimeout.current = null;
      replaceCurrentReadingHistory();
    }, 150);
  }, [cancelScrollSnapshot, replaceCurrentReadingHistory, reviewKey]);

  const pushReadingHistory = useCallback(
    (
      document: ActiveDocument,
      pane: DocumentPaneId,
      locator: ReadingLocator,
      hash?: string,
    ): void => {
      if (!reviewKey || initializedReviewKey.current !== reviewKey) return;
      cancelScrollSnapshot();
      const currentWorkspace = workspaceRef.current;
      if (!currentWorkspace) return;
      const currentDocument = currentWorkspace.active[currentWorkspace.focusedPane];
      replaceCurrentReadingHistory();
      const destination: ReadingHistoryEntry = {
        version: 1,
        reviewKey,
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
    [cancelScrollSnapshot, replaceCurrentReadingHistory, reviewKey, workspaceRef],
  );

  const requestLineNavigation = useCallback(
    (
      documentKey: string,
      locator: Extract<ReadingLocator, { kind: "line" }>,
      resetHorizontal: boolean,
    ): void => {
      navigationSequence.current += 1;
      const target: ViewerNavigationTarget = {
        documentKey,
        line: locator.line,
        ...(locator.endLine === undefined ? {} : { endLine: locator.endLine }),
        requestId: navigationSequence.current,
        resetHorizontal,
      };
      appliedLineNavigation.current = null;
      navigationTargetRef.current = target;
      setViewerNavigationTarget(target);
    },
    [setViewerNavigationTarget],
  );

  const navigateToDocument = useCallback(
    (
      document: ActiveDocument,
      targetPane?: DocumentPaneId,
      locator?: ReadingLocator,
      resetHorizontal = true,
    ): void => {
      const currentWorkspace = workspaceRef.current;
      if (!currentWorkspace) return;
      const documentKey = documentTabKey(document);
      const pane =
        targetPane ?? currentWorkspace.panes[documentKey] ?? currentWorkspace.focusedPane;
      const destinationLocator =
        locator ??
        ({
          kind: "scroll",
          top: documentScrollPositions.current?.get(documentKey) ?? 0,
        } satisfies ReadingLocator);
      pushReadingHistory(document, pane, destinationLocator);
      openWorkspaceDocument(document, pane);
      if (destinationLocator.kind === "line") {
        requestLineNavigation(documentKey, destinationLocator, resetHorizontal);
      }
    },
    [
      documentScrollPositions,
      openWorkspaceDocument,
      pushReadingHistory,
      requestLineNavigation,
      workspaceRef,
    ],
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

  const activateDocument = useCallback(
    (document: ActiveDocument, pane?: DocumentPaneId): void => {
      const currentWorkspace = workspaceRef.current;
      if (!currentWorkspace) return;
      const targetPane =
        pane ?? currentWorkspace.panes[documentTabKey(document)] ?? currentWorkspace.focusedPane;
      pushReadingHistory(document, targetPane, {
        kind: "scroll",
        top: documentScrollPositions.current?.get(documentTabKey(document)) ?? 0,
      });
      activateWorkspaceDocument(document, targetPane);
    },
    [activateWorkspaceDocument, documentScrollPositions, pushReadingHistory, workspaceRef],
  );

  const restoreReadingHistory = useCallback(
    (entry: ReadingHistoryEntry): void => {
      cancelScrollSnapshot();
      const currentWorkspace = workspaceRef.current;
      if (!currentWorkspace) return;
      const documentKey = documentTabKey(entry.document);
      const pane = currentWorkspace.panes[documentKey] ?? entry.pane;
      if (entry.locator.kind === "scroll") {
        documentScrollPositions.current?.set(documentKey, entry.locator.top);
      }
      openWorkspaceDocument(entry.document, pane);
      if (entry.locator.kind === "line") {
        requestLineNavigation(documentKey, entry.locator, true);
        return;
      }
      const scrollTop = entry.locator.top;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const targetPane = workspaceRef.current?.panes[documentKey] ?? pane;
          const paneElement = paneElements.current?.[targetPane];
          if (paneElement) paneElement.scrollTop = scrollTop;
        });
      });
    },
    [
      cancelScrollSnapshot,
      documentScrollPositions,
      openWorkspaceDocument,
      paneElements,
      requestLineNavigation,
      workspaceRef,
    ],
  );

  const initializeReadingHistory = useCallback((): void => {
    if (!reviewKey || initializedReviewKey.current === reviewKey) return;
    initializedReviewKey.current = reviewKey;
    const entry = currentReadingHistoryEntry();
    if (!entry) return;
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(readingHistoryState(window.history.state, entry), "", url);
  }, [currentReadingHistoryEntry, reviewKey]);

  const recordPaneScroll = useCallback(
    (pane: DocumentPaneId, document: ActiveDocument | null, scrollTop: number): void => {
      if (!document) return;
      documentScrollPositions.current?.set(documentTabKey(document), scrollTop);
      if (workspaceRef.current?.focusedPane === pane) {
        scheduleReadingHistoryScrollSnapshot();
      }
    },
    [documentScrollPositions, scheduleReadingHistoryScrollSnapshot, workspaceRef],
  );

  useEffect(() => {
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      cancelScrollSnapshot();
      window.history.scrollRestoration = previousScrollRestoration;
    };
  }, [cancelScrollSnapshot]);

  useEffect(() => {
    if (!reviewKey) return;
    const restoreFromPopState = (event: PopStateEvent): void => {
      const entry = parseReadingHistoryEntry(event.state, reviewKey);
      if (entry) restoreReadingHistory(entry);
    };
    window.addEventListener("popstate", restoreFromPopState);
    return () => window.removeEventListener("popstate", restoreFromPopState);
  }, [restoreReadingHistory, reviewKey]);

  return {
    activateDocument,
    currentReadingHistoryEntry,
    initializeReadingHistory,
    markLineNavigationApplied,
    navigateToDocument,
    navigateToMarkdownFragment,
    recordPaneScroll,
    requestLineNavigation,
  };
}
