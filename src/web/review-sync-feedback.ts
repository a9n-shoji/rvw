export interface ReviewIssueSyncFailure {
  reference?: string;
  issue: { number: number } | null;
  error: { message: string };
}

export function issueSyncFailureFeedback(
  failures: readonly ReviewIssueSyncFailure[],
): string | null {
  if (failures.length === 0) return null;
  const details = failures
    .map(({ issue, reference, error }) => {
      const label = issue ? `#${issue.number}` : (reference ?? "Issue");
      return `${label}: ${error.message}`;
    })
    .join(" / ");
  return `Issue ${failures.length}件の更新に失敗しました（${details}）。`;
}
