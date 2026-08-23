export interface ReviewIssueSyncFailure {
  reference?: string;
  issue: { number: number } | null;
  error: { message: string };
}

const MAX_VISIBLE_FAILURES = 3;

export function issueSyncFailureFeedback(
  failures: readonly ReviewIssueSyncFailure[],
): string | null {
  if (failures.length === 0) return null;
  const details = failures.slice(0, MAX_VISIBLE_FAILURES).map(({ issue, reference, error }) => {
    const label = issue ? `#${issue.number}` : (reference ?? "Issue");
    return `${label}: ${error.message}`;
  });
  const omitted = failures.length - details.length;
  if (omitted > 0) details.push(`ほか${omitted}件`);
  return `Issue ${failures.length}件の更新に失敗しました（${details.join(" / ")}）。`;
}
