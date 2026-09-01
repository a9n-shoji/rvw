import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  cancelAndInvalidateQueries,
  invalidateFailedPlacementQueries,
  placementQueryHasFailures,
} from "../../src/web/query-invalidation.js";

describe("cancelAndInvalidateQueries", () => {
  it("starts a new generation when the first fetch has no cached data", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const resolvers: Array<(value: string) => void> = [];
    const queryFn = () =>
      new Promise<string>((resolve) => {
        resolvers.push(resolve);
      });
    const observer = new QueryObserver(queryClient, {
      queryKey: ["generation-race"],
      queryFn,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));

      const invalidation = cancelAndInvalidateQueries(queryClient, {
        queryKey: ["generation-race"],
        exact: true,
      });
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));

      resolvers[0]!("stale");
      resolvers[1]!("fresh");
      await invalidation;

      expect(queryClient.getQueryData(["generation-race"])).toBe("fresh");
    } finally {
      unsubscribe();
    }
  });
});

describe("placement failure recovery", () => {
  const successfulPlacement = {
    pullRequestContentFingerprint: "a".repeat(64),
    comments: [{ commentId: "healthy", placements: [], failures: [] }],
    missingCommentIds: [],
  };
  const partialPlacement = {
    ...successfulPlacement,
    comments: [
      ...successfulPlacement.comments,
      {
        commentId: "recoverable",
        placements: [],
        failures: [
          {
            destination: { kind: "commit", oid: "b".repeat(40) },
            error: { code: "COMMIT_NOT_FOUND", message: "missing", suggestions: [] },
          },
        ],
      },
    ],
  };

  it("recognizes direct and wrapped partial placement responses", () => {
    expect(placementQueryHasFailures(successfulPlacement)).toBe(false);
    expect(placementQueryHasFailures(partialPlacement)).toBe(true);
    expect(
      placementQueryHasFailures({ contentFingerprint: "a".repeat(64), response: partialPlacement }),
    ).toBe(true);
  });

  it("invalidates only cached placement queries containing item failures", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["comment-placements", "sidebar", "failed"], partialPlacement);
    queryClient.setQueryData(["comment-placements", "sidebar", "healthy"], successfulPlacement);
    queryClient.setQueryData(["comments", "unrelated"], partialPlacement);

    await invalidateFailedPlacementQueries(queryClient);

    expect(
      queryClient.getQueryState(["comment-placements", "sidebar", "failed"])?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(["comment-placements", "sidebar", "healthy"])?.isInvalidated,
    ).toBe(false);
    expect(queryClient.getQueryState(["comments", "unrelated"])?.isInvalidated).toBe(false);
  });
});
