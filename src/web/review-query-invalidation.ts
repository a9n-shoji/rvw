import type { QueryClient } from "@tanstack/react-query";
import type { ReviewKind } from "./review-context.js";
import { reviewQueryKeys } from "./review-query-keys.js";

export async function invalidateReviewScope(
  queryClient: QueryClient,
  kind: ReviewKind,
  reviewId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: reviewQueryKeys.review(kind, reviewId) }),
    queryClient.invalidateQueries({ queryKey: reviewQueryKeys.document() }),
    queryClient.invalidateQueries({ queryKey: reviewQueryKeys.annotations() }),
    queryClient.invalidateQueries({ queryKey: reviewQueryKeys.comments(kind, reviewId) }),
    queryClient.invalidateQueries({
      queryKey: reviewQueryKeys.commentPlacement(kind, reviewId),
    }),
    queryClient.invalidateQueries({ queryKey: reviewQueryKeys.searchScope(kind, reviewId) }),
    queryClient.invalidateQueries({
      queryKey: reviewQueryKeys.walkthroughScope(kind, reviewId),
    }),
  ]);
}
