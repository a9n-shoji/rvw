import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateReviewScope } from "../../src/web/review-query-invalidation.js";
import { reviewQueryKeys } from "../../src/web/review-query-keys.js";

describe("review query invalidation", () => {
  it("invalidates both Walkthrough list and detail within only the changed review", async () => {
    const queryClient = new QueryClient();
    const reviewId = "33333333-3333-4333-8333-333333333333";
    const otherReviewId = "44444444-4444-4444-8444-444444444444";
    const listKey = reviewQueryKeys.walkthroughs("repository", reviewId);
    const detailKey = reviewQueryKeys.walkthrough(
      "repository",
      reviewId,
      "66666666-6666-4666-8666-666666666666",
    );
    const otherDetailKey = reviewQueryKeys.walkthrough(
      "repository",
      otherReviewId,
      "77777777-7777-4777-8777-777777777777",
    );
    queryClient.setQueryData(listKey, { walkthroughs: [] });
    queryClient.setQueryData(detailKey, { walkthrough: { title: "old" } });
    queryClient.setQueryData(otherDetailKey, { walkthrough: { title: "other" } });

    await invalidateReviewScope(queryClient, "repository", reviewId);

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherDetailKey)?.isInvalidated).toBe(false);
  });
});
