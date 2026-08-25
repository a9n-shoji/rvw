import { useEffect } from "react";
import {
  documentTabKey,
  normalizeDocumentPanes,
  type ActiveDocument,
  type DocumentPaneId,
  type DocumentWorkspaceState,
} from "./document-workspace.js";

interface IssueDocumentSummary {
  id: string;
  number: number;
  title: string;
  url: string;
}

interface WalkthroughDocumentSummary {
  id: string;
  title: string;
  sourceOid: string;
}

interface ReviewDocumentSummaries {
  issues: readonly IssueDocumentSummary[];
  issuesEnabled: boolean;
  walkthroughs: readonly WalkthroughDocumentSummary[];
  walkthroughsEnabled: boolean;
}

type WorkspaceUpdate =
  DocumentWorkspaceState | ((current: DocumentWorkspaceState) => DocumentWorkspaceState);

export function reconcileReviewDocumentWorkspace(
  current: DocumentWorkspaceState,
  summaries: ReviewDocumentSummaries,
): DocumentWorkspaceState {
  if (!summaries.issuesEnabled && !summaries.walkthroughsEnabled) return current;
  const issues = new Map(summaries.issues.map((issue) => [issue.id, issue]));
  const walkthroughs = new Map(
    summaries.walkthroughs.map((walkthrough) => [walkthrough.id, walkthrough]),
  );
  let changed = false;
  const rebind = (document: ActiveDocument): ActiveDocument | null => {
    if (document.kind === "issue" && summaries.issuesEnabled) {
      const issue = issues.get(document.id);
      // Issue removal has a draft-aware close path. A refresh only reconciles metadata for
      // memberships that still exist, so an external removal cannot silently discard a draft.
      if (!issue) return document;
      if (
        document.number === issue.number &&
        document.title === issue.title &&
        document.url === issue.url
      ) {
        return document;
      }
      changed = true;
      return {
        kind: "issue",
        id: issue.id,
        number: issue.number,
        title: issue.title,
        url: issue.url,
      };
    }
    if (document.kind !== "walkthrough" || !summaries.walkthroughsEnabled) return document;
    const walkthrough = walkthroughs.get(document.id);
    if (!walkthrough) {
      changed = true;
      return null;
    }
    if (document.title === walkthrough.title && document.sourceOid === walkthrough.sourceOid) {
      return document;
    }
    changed = true;
    return {
      kind: "walkthrough",
      id: walkthrough.id,
      title: walkthrough.title,
      sourceOid: walkthrough.sourceOid,
    };
  };
  const documents = {
    left: current.documents.left
      .map(rebind)
      .filter((document): document is ActiveDocument => document !== null),
    right: current.documents.right
      .map(rebind)
      .filter((document): document is ActiveDocument => document !== null),
  };
  if (!changed) return current;
  const activeDocument = (paneId: DocumentPaneId): ActiveDocument | null => {
    const active = current.active[paneId];
    if (active) {
      const rebound = rebind(active);
      if (rebound) {
        const key = documentTabKey(rebound);
        const candidate = documents[paneId].find((document) => documentTabKey(document) === key);
        if (candidate) return candidate;
      }
    }
    return documents[paneId][0] ?? null;
  };
  return normalizeDocumentPanes({
    ...current,
    documents,
    active: {
      left: activeDocument("left"),
      right: activeDocument("right"),
    },
  });
}

export function useReviewDocumentReconciliation({
  issues,
  issuesEnabled,
  walkthroughs,
  walkthroughsEnabled,
  setWorkspace,
}: ReviewDocumentSummaries & {
  setWorkspace: (update: WorkspaceUpdate) => void;
}): void {
  useEffect(() => {
    if (!issuesEnabled && !walkthroughsEnabled) return;
    setWorkspace((current) =>
      reconcileReviewDocumentWorkspace(current, {
        issues,
        issuesEnabled,
        walkthroughs,
        walkthroughsEnabled,
      }),
    );
  }, [issues, issuesEnabled, setWorkspace, walkthroughs, walkthroughsEnabled]);
}
