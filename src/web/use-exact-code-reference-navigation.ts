import { useCallback, useRef, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  RepositoryReviewDocumentContent,
  RepositoryReviewDocumentRef,
  CodeReference,
  DocumentContent,
  DocumentRef,
} from "../domain/models.js";
import { ApiError, api, documentUrl } from "./api.js";
import {
  documentTabKey,
  type ActiveDocument,
  type DocumentPaneId,
  type DocumentWorkspaceState,
} from "./document-workspace.js";
import type { ReadingLocator } from "./reading-history.js";
import { reviewQueryKeys } from "./review-query-keys.js";
import type { ReviewKind } from "./review-context.js";

function repositoryReviewDocumentUrl(ref: RepositoryReviewDocumentRef): string {
  const search = new URLSearchParams({ kind: ref.kind });
  if (ref.kind === "repository-file") {
    search.set("sourceOid", ref.sourceOid);
    search.set("path", ref.path);
  } else {
    search.set("issueId", ref.issueId);
  }
  return `/api/repository-reviews/${ref.repositoryReviewId}/document?${search.toString()}`;
}

export function useExactCodeReferenceNavigation({
  reviewKind,
  reviewId,
  workspaceRef,
  navigateToDocument,
}: {
  reviewKind: ReviewKind;
  reviewId: string | null;
  workspaceRef: RefObject<DocumentWorkspaceState>;
  navigateToDocument: (
    document: ActiveDocument,
    targetPane?: DocumentPaneId,
    locator?: ReadingLocator,
    resetHorizontal?: boolean,
  ) => boolean;
}) {
  const queryClient = useQueryClient();
  const requestSequence = useRef<Record<DocumentPaneId, number>>({ left: 0, right: 0 });

  return useCallback(
    async (
      sourceOid: string,
      reference: CodeReference,
      targetPane: DocumentPaneId,
      comparisonPolicy: "exact-source" | "selected-range",
    ): Promise<string | null> => {
      if (!reviewId) return `参照先を開けません · ${reference.path}`;
      requestSequence.current[targetPane] += 1;
      const currentRequest = requestSequence.current[targetPane];
      const targetNavigationRevision = workspaceRef.current.navigationRevision[targetPane];
      const requestIsCurrent = (): boolean =>
        currentRequest === requestSequence.current[targetPane] &&
        workspaceRef.current.navigationRevision[targetPane] === targetNavigationRevision;
      const request: { ref: DocumentRef | RepositoryReviewDocumentRef; url: string } = (() => {
        if (reviewKind === "pull-request") {
          const ref: DocumentRef = {
            kind: "repository-file",
            pullRequestId: reviewId,
            sourceOid,
            path: reference.path,
          };
          return { ref, url: documentUrl(ref) };
        }
        const ref: RepositoryReviewDocumentRef = {
          kind: "repository-file",
          repositoryReviewId: reviewId,
          sourceOid,
          path: reference.path,
        };
        return { ref, url: repositoryReviewDocumentUrl(ref) };
      })();
      try {
        const referencedDocument = await queryClient.fetchQuery({
          queryKey: reviewQueryKeys.document(request.ref),
          queryFn: async () =>
            (
              await api<{ document: DocumentContent | RepositoryReviewDocumentContent }>(
                request.url,
              )
            ).document,
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
      const activeTarget = workspaceRef.current.active[targetPane];
      navigateToDocument(
        document,
        targetPane,
        {
          kind: "line",
          line: reference.startLine,
          ...(reference.endLine === null ? {} : { endLine: reference.endLine }),
        },
        !activeTarget || documentTabKey(activeTarget) !== documentTabKey(document),
      );
      return null;
    },
    [navigateToDocument, queryClient, reviewId, reviewKind, workspaceRef],
  );
}
