import type { InvalidateQueryFilters, QueryClient } from "@tanstack/react-query";

export async function cancelAndInvalidateQueries(
  queryClient: QueryClient,
  filters: InvalidateQueryFilters,
): Promise<void> {
  await queryClient.cancelQueries(filters);
  await queryClient.invalidateQueries(filters);
}
