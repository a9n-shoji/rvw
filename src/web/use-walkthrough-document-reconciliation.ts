import { useEffect } from "react";
import {
  documentTabKey,
  normalizeDocumentPanes,
  type ActiveDocument,
  type DocumentPaneId,
  type DocumentWorkspaceState,
} from "./document-workspace.js";

interface WalkthroughDocumentSummary {
  id: string;
  title: string;
  sourceOid: string;
}

type WorkspaceUpdate =
  DocumentWorkspaceState | ((current: DocumentWorkspaceState) => DocumentWorkspaceState);

export function useWalkthroughDocumentReconciliation({
  walkthroughs,
  enabled,
  setWorkspace,
}: {
  walkthroughs: readonly WalkthroughDocumentSummary[];
  enabled: boolean;
  setWorkspace: (update: WorkspaceUpdate) => void;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const summaries = new Map(walkthroughs.map((walkthrough) => [walkthrough.id, walkthrough]));
    setWorkspace((current) => {
      let changed = false;
      const rebind = (document: ActiveDocument): ActiveDocument | null => {
        if (document.kind !== "walkthrough") return document;
        const summary = summaries.get(document.id);
        if (!summary) {
          changed = true;
          return null;
        }
        if (document.title === summary.title && document.sourceOid === summary.sourceOid) {
          return document;
        }
        changed = true;
        return {
          kind: "walkthrough",
          id: summary.id,
          title: summary.title,
          sourceOid: summary.sourceOid,
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
            const candidate = documents[paneId].find(
              (document) => documentTabKey(document) === key,
            );
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
    });
  }, [enabled, setWorkspace, walkthroughs]);
}
