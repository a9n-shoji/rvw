import type { GitHubIssue, RepositoryIdentity } from "../domain/models.js";
import { RvwError } from "./errors.js";

export interface ExpectedGitHubIssueIdentity extends Pick<
  RepositoryIdentity,
  "owner" | "repository"
> {
  number: number;
}

function sameValue(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function identityMismatch(
  expected: ExpectedGitHubIssueIdentity,
  actual: Record<string, unknown>,
): RvwError {
  return new RvwError(
    "GITHUB_ISSUE_ERROR",
    "GitHub Issue responseのrepository identityがrequestと一致しません。",
    {
      status: 502,
      details: {
        reason: "ISSUE_IDENTITY_MISMATCH",
        expected,
        actual,
      },
    },
  );
}

export function parseGitHubIssueUrl(url: string): ExpectedGitHubIssueIdentity {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/.exec(url);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new RvwError("GITHUB_ISSUE_ERROR", "GitHub Issue responseのURLが不正です。", {
      status: 502,
      details: { reason: "ISSUE_IDENTITY_MISMATCH", url },
    });
  }
  return { owner: match[1], repository: match[2], number: Number(match[3]) };
}

export function assertFetchedIssueIdentity(
  expected: ExpectedGitHubIssueIdentity,
  issue: GitHubIssue,
): GitHubIssue {
  const fromUrl = parseGitHubIssueUrl(issue.url);
  if (
    !sameValue(issue.owner, expected.owner) ||
    !sameValue(issue.repository, expected.repository) ||
    issue.number !== expected.number ||
    !sameValue(fromUrl.owner, expected.owner) ||
    !sameValue(fromUrl.repository, expected.repository) ||
    fromUrl.number !== expected.number ||
    !sameValue(issue.canonicalName, `${issue.owner}/${issue.repository}`)
  ) {
    throw identityMismatch(expected, {
      owner: issue.owner,
      repository: issue.repository,
      canonicalName: issue.canonicalName,
      number: issue.number,
      url: issue.url,
    });
  }
  return issue;
}

export function isIssueIdentityMismatch(error: unknown): boolean {
  return (
    error instanceof RvwError &&
    error.code === "GITHUB_ISSUE_ERROR" &&
    typeof error.details === "object" &&
    error.details !== null &&
    "reason" in error.details &&
    error.details.reason === "ISSUE_IDENTITY_MISMATCH"
  );
}
