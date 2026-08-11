import type { CommitSummary } from "../domain/models.js";

function ancestorOids(commits: readonly CommitSummary[], oid: string): Set<string> {
  const byOid = new Map(commits.map((commit) => [commit.oid, commit]));
  const ancestors = new Set<string>();
  const pending = [...(byOid.get(oid)?.parentOids ?? [])];
  while (pending.length > 0) {
    const parent = pending.pop();
    if (!parent || ancestors.has(parent)) continue;
    ancestors.add(parent);
    pending.push(...(byOid.get(parent)?.parentOids ?? []));
  }
  return ancestors;
}

export function earliestIncludedCommitOid(
  commits: readonly CommitSummary[],
  oid: string,
): string | null {
  const ancestors = ancestorOids(commits, oid);
  return commits.find((commit) => commit.oid === oid || ancestors.has(commit.oid))?.oid ?? null;
}

export function pullRequestRangeStartOid(
  commits: readonly CommitSummary[],
  latestHeadOid: string | null,
): string | null {
  if (!latestHeadOid || !commits.some((commit) => commit.oid === latestHeadOid)) return null;
  return commits[0]?.oid ?? null;
}

export function normalizedCommitRange(
  commits: readonly CommitSummary[],
  firstOid: string,
  secondOid: string,
): { startOid: string; endOid: string } | null {
  const firstIndex = commits.findIndex((commit) => commit.oid === firstOid);
  const secondIndex = commits.findIndex((commit) => commit.oid === secondOid);
  if (firstIndex < 0 || secondIndex < 0) return null;
  const startIndex = Math.min(firstIndex, secondIndex);
  const endIndex = Math.max(firstIndex, secondIndex);
  return { startOid: commits[startIndex]!.oid, endOid: commits[endIndex]!.oid };
}
