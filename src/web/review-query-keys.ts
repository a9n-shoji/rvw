import type { RepositoryReviewDocumentRef, DocumentRef } from "../domain/models.js";
import type { ReviewKind } from "./review-context.js";

type ReviewDocumentRef = DocumentRef | RepositoryReviewDocumentRef;

function optionalTail(value: unknown): [] | [unknown] {
  return value === undefined ? [] : [value];
}

export const reviewQueryKeys = {
  changeSequence: (kind?: ReviewKind, reviewId?: string | null) =>
    kind && reviewId
      ? (["change-sequence", kind, reviewId] as const)
      : (["change-sequence"] as const),
  review: (kind: ReviewKind, reviewId: string | null) =>
    kind === "pull-request"
      ? (["pull-request", reviewId] as const)
      : (["repository-review", reviewId] as const),
  tree: (kind: ReviewKind, reviewId: string, sourceOid?: string) =>
    kind === "pull-request"
      ? (["tree", reviewId, sourceOid] as const)
      : (["repository-tree", reviewId, sourceOid] as const),
  document: (ref?: ReviewDocumentRef) =>
    ref === undefined ? (["document"] as const) : (["document", ref] as const),
  annotations: () => ["annotations"] as const,
  allReviews: (kind: ReviewKind) =>
    kind === "pull-request" ? (["pull-request"] as const) : (["repository-review"] as const),
  allComments: () => ["comments"] as const,
  allCommentPlacements: () => ["comment-placement"] as const,
  comments: (kind: ReviewKind, reviewId: string | null, changeSequence?: number) =>
    kind === "pull-request"
      ? (["comments", reviewId, ...optionalTail(changeSequence)] as const)
      : (["comments", "repository", reviewId, ...optionalTail(changeSequence)] as const),
  issues: (kind: ReviewKind, reviewId: string | null, changeSequence?: number) =>
    ["issues", kind, reviewId, ...optionalTail(changeSequence)] as const,
  commentPlacement: (kind: ReviewKind, reviewId: string, commentId?: string, sourceOid?: string) =>
    [
      "comment-placement",
      kind,
      reviewId,
      ...optionalTail(commentId),
      ...optionalTail(sourceOid),
    ] as const,
  search: (
    kind: ReviewKind,
    reviewId: string,
    sourceOid?: string,
    query?: string,
    matchCase?: boolean,
    wholeWord?: boolean,
  ) => ["search", kind, reviewId, sourceOid, query, matchCase, wholeWord] as const,
  searchScope: (kind: ReviewKind, reviewId: string) => ["search", kind, reviewId] as const,
  walkthroughScope: (kind: ReviewKind, reviewId: string) =>
    ["walkthrough", kind, reviewId] as const,
  walkthroughs: (kind: ReviewKind, reviewId: string) =>
    ["walkthrough", kind, reviewId, "list"] as const,
  walkthrough: (kind: ReviewKind, reviewId: string, walkthroughId: string) =>
    ["walkthrough", kind, reviewId, walkthroughId] as const,
  changedFiles: (reviewId: string | null, oldOid?: string, newOid?: string) =>
    ["changed-files", reviewId, oldOid, newOid] as const,
};
