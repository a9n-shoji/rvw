import type { BranchDocumentRef, DocumentRef } from "../domain/models.js";
import type { ReviewKind } from "./review-context.js";

type ReviewDocumentRef = DocumentRef | BranchDocumentRef;

function optionalTail(value: unknown): [] | [unknown] {
  return value === undefined ? [] : [value];
}

export const reviewQueryKeys = {
  changeSequence: () => ["change-sequence"] as const,
  review: (kind: ReviewKind, reviewId: string | null) =>
    kind === "pull-request"
      ? (["pull-request", reviewId] as const)
      : (["branch-review", reviewId] as const),
  tree: (kind: ReviewKind, reviewId: string, sourceOid?: string) =>
    kind === "pull-request"
      ? (["tree", reviewId, sourceOid] as const)
      : (["branch-tree", reviewId] as const),
  document: (ref?: ReviewDocumentRef) =>
    ref === undefined ? (["document"] as const) : (["document", ref] as const),
  annotations: () => ["annotations"] as const,
  comments: (kind: ReviewKind, reviewId: string | null, changeSequence?: number) =>
    kind === "pull-request"
      ? (["comments", reviewId, ...optionalTail(changeSequence)] as const)
      : (["comments", "branch", reviewId, ...optionalTail(changeSequence)] as const),
  issues: (reviewId: string | null, changeSequence?: number) =>
    ["issues", reviewId, ...optionalTail(changeSequence)] as const,
  commentPlacement: (kind: ReviewKind, reviewId: string) =>
    ["comment-placement", kind, reviewId] as const,
  search: (kind: ReviewKind, reviewId: string) =>
    kind === "pull-request"
      ? (["search", reviewId] as const)
      : (["branch-search", reviewId] as const),
  walkthroughs: (kind: ReviewKind, reviewId: string) =>
    kind === "pull-request"
      ? (["walkthroughs", reviewId] as const)
      : (["walkthrough", "branch", reviewId] as const),
};
