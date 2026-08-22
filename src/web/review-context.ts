import type {
  BranchReviewComment,
  BranchWalkthrough,
  BranchWalkthroughSummary,
  ReviewComment,
  Walkthrough,
  WalkthroughSummary,
} from "../domain/models.js";

export type ReviewKind = "pull-request" | "branch";

export type ReviewIdentity =
  | { kind: "pull-request"; id: string; sourceOid: string }
  | { kind: "branch"; id: string; sourceOid: string };

export type AnyReviewComment = ReviewComment | BranchReviewComment;
export type AnyWalkthrough = Walkthrough | BranchWalkthrough;
export type AnyWalkthroughSummary = WalkthroughSummary | BranchWalkthroughSummary;

export function reviewIdForComment(comment: AnyReviewComment): string {
  return "pullRequestId" in comment ? comment.pullRequestId : comment.branchReviewId;
}

export function reviewCommentPayload(
  review: Pick<ReviewIdentity, "kind" | "id">,
): { pullRequestId: string } | { branchReviewId: string } {
  return review.kind === "pull-request"
    ? { pullRequestId: review.id }
    : { branchReviewId: review.id };
}

export function reviewIdForWalkthrough(walkthrough: AnyWalkthrough): string {
  return "pullRequestId" in walkthrough ? walkthrough.pullRequestId : walkthrough.branchReviewId;
}

export function reviewKindForWalkthrough(walkthrough: AnyWalkthrough): ReviewKind {
  return "pullRequestId" in walkthrough ? "pull-request" : "branch";
}
