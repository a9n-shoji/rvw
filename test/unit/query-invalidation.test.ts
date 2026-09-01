import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { cancelAndInvalidateQueries } from "../../src/web/query-invalidation.js";

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
