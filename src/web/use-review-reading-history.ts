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
  documentPaneIds,
  documentPaneTransitions,
  documentPaneTabKey,
  documentTabKey,
  preferredDocumentPane,
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
  viewerNavigationTargets: Record<DocumentPaneId, ViewerNavigationTarget | null>;
  setViewerNavigationTargets: Dispatch<
    SetStateAction<Record<DocumentPaneId, ViewerNavigationTarget | null>>
  >;
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
  viewerNavigationTargets,
  setViewerNavigationTargets,
  openWorkspaceDocument,
  activateWorkspaceDocument,
  scrollRevision = 0,
}: ReviewReadingHistoryOptions) {
  const initializedReviewKey = useRef<string | null>(null);
  const scrollSnapshotTimeout = useRef<number | null>(null);
  const navigationSequence = useRef(0);
  const navigationTargetsRef = useRef(viewerNavigationTargets);
  const appliedLineNavigation = useRef<Record<DocumentPaneId, AppliedLineNavigation | null>>({
    left: null,
    right: null,
  });
  navigationTargetsRef.current = viewerNavigationTargets;
  for (const pane of ["left", "right"] as const) {
    if (!viewerNavigationTargets[pane]) appliedLineNavigation.current[pane] = null;
  }

  const leftActiveDocumentKey = workspace.active.left
    ? documentPaneTabKey("left", workspace.active.left)
    : null;
  const rightActiveDocumentKey = workspace.active.right
    ? documentPaneTabKey("right", workspace.active.right)
    : null;
  const previousWorkspace = useRef(workspace);

  useLayoutEffect(() => {
    const previous = previousWorkspace.current;
    for (const transition of documentPaneTransitions(previous, workspace)) {
      if (
        previous.documents[transition.targetPane].some(
          (document) => documentTabKey(document) === documentTabKey(transition.targetDocument),
        )
      ) {
        continue;
      }
      const sourceTop = documentScrollPositions.current?.get(
        documentPaneTabKey(transition.sourcePane, transition.sourceDocument),
      );
      if (sourceTop !== undefined) {
        documentScrollPositions.current?.set(
          documentPaneTabKey(transition.targetPane, transition.targetDocument),
          sourceTop,
        );
      }
    }
    previousWorkspace.current = workspace;
  }, [documentScrollPositions, workspace]);

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
    const paneDocumentKey = documentPaneTabKey(pane, document);
    const navigationTarget = navigationTargetsRef.current[pane];
    const scrollTop =
      paneElements.current?.[pane]?.scrollTop ??
      documentScrollPositions.current?.get(paneDocumentKey) ??
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
      const navigationTarget = navigationTargetsRef.current[pane];
      const currentWorkspace = workspaceRef.current;
      const document = currentWorkspace?.active[pane];
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
          paneElements.current?.[pane]?.scrollTop ??
          documentScrollPositions.current?.get(documentPaneTabKey(pane, document)) ??
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
      pane: DocumentPaneId,
      locator: Extract<ReadingLocator, { kind: "line" }>,
      resetHorizontal: boolean,
    ): void => {
      navigationSequence.current += 1;
      const target: ViewerNavigationTarget = {
        documentKey,
        pane,
        line: locator.line,
        ...(locator.endLine === undefined ? {} : { endLine: locator.endLine }),
        requestId: navigationSequence.current,
        resetHorizontal,
      };
      appliedLineNavigation.current[pane] = null;
      const nextTargets = { ...navigationTargetsRef.current, [pane]: target };
      navigationTargetsRef.current = nextTargets;
      setViewerNavigationTargets(nextTargets);
    },
    [setViewerNavigationTargets],
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
          top: documentScrollPositions.current?.get(documentPaneTabKey(pane, document)) ?? 0,
        } satisfies ReadingLocator);
      pushReadingHistory(document, pane, destinationLocator);
      openWorkspaceDocument(document, pane);
      if (destinationLocator.kind === "line") {
        requestLineNavigation(documentKey, pane, destinationLocator, resetHorizontal);
      }
    },
    [documentScrollPositions, openWorkspaceDocument, pushReadingHistory, requestLineNavigation],
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

  const activateDocument = useCallback(
    (document: ActiveDocument, pane?: DocumentPaneId): void => {
      const currentWorkspace = workspaceRef.current;
      if (!currentWorkspace) return;
      const targetPane = pane ?? preferredDocumentPane(currentWorkspace, document);
      pushReadingHistory(document, targetPane, {
        kind: "scroll",
        top: documentScrollPositions.current?.get(documentPaneTabKey(targetPane, document)) ?? 0,
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
      const openPanes = documentPaneIds(currentWorkspace, entry.document);
      const pane = openPanes.includes(entry.pane) ? entry.pane : (openPanes[0] ?? entry.pane);
      if (entry.locator.kind === "scroll") {
        documentScrollPositions.current?.set(
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
          const paneElement = paneElements.current?.[pane];
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
      documentScrollPositions.current?.set(documentPaneTabKey(pane, document), scrollTop);
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
