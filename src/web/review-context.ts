import type {
  RepositoryReviewComment,
  RepositoryWalkthrough,
  RepositoryWalkthroughSummary,
  ReviewComment,
  Walkthrough,
  WalkthroughSummary,
} from "../domain/models.js";

export type ReviewKind = "pull-request" | "repository";

export type ReviewIdentity =
  | { kind: "pull-request"; id: string; sourceOid: string }
  | { kind: "repository"; id: string; sourceOid: string };

export type AnyReviewComment = ReviewComment | RepositoryReviewComment;
export type AnyWalkthrough = Walkthrough | RepositoryWalkthrough;
export type AnyWalkthroughSummary = WalkthroughSummary | RepositoryWalkthroughSummary;

export function reviewIdForComment(comment: AnyReviewComment): string {
  return "pullRequestId" in comment ? comment.pullRequestId : comment.repositoryReviewId;
}

export function reviewCommentPayload(
  review: Pick<ReviewIdentity, "kind" | "id">,
): { pullRequestId: string } | { repositoryReviewId: string } {
  return review.kind === "pull-request"
    ? { pullRequestId: review.id }
    : { repositoryReviewId: review.id };
}

export function reviewIdForWalkthrough(walkthrough: AnyWalkthrough): string {
  return "pullRequestId" in walkthrough
    ? walkthrough.pullRequestId
    : walkthrough.repositoryReviewId;
}

export function reviewKindForWalkthrough(walkthrough: AnyWalkthrough): ReviewKind {
  return "pullRequestId" in walkthrough ? "pull-request" : "repository";
}
