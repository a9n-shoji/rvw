import type { DocumentRef } from "../domain/models.js";

function repositoryDocumentPullRequestId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("kind" in value)) return null;
  const ref = value as Partial<DocumentRef>;
  return ref.kind === "repository-file" && typeof ref.pullRequestId === "string"
    ? ref.pullRequestId
    : null;
}

function documentPlacementUsesRepository(queryKey: readonly unknown[]): boolean {
  if (queryKey[1] === "document") {
    const renderedRefs = queryKey[4];
    if (typeof renderedRefs !== "object" || renderedRefs === null) return false;
    const refs = renderedRefs as Record<string, unknown>;
    return ["new", "old"].some(
      (side) => side in refs && repositoryDocumentPullRequestId(refs[side]) !== null,
    );
  }
  if (queryKey[1] !== "sidebar" || !Array.isArray(queryKey[6])) return false;
  const fingerprint = queryKey[6] as unknown[];
  return fingerprint.some((entry) => {
    if (!Array.isArray(entry)) return false;
    const target: unknown = (entry as unknown[])[1];
    return (
      typeof target === "object" &&
      target !== null &&
      "kind" in target &&
      target.kind === "document" &&
      "documentKind" in target &&
      target.documentKind === "repository-file"
    );
  });
}

export function gitBackedQueryBelongsToPullRequest(
  queryKey: readonly unknown[],
  pullRequestId: string,
): boolean {
  switch (queryKey[0]) {
    case "tree":
    case "changed-files":
    case "diff":
    case "search":
    case "structure-reference-index":
    case "mermaid-reference-peek":
      return queryKey[1] === pullRequestId;
    case "document":
      return repositoryDocumentPullRequestId(queryKey[1]) === pullRequestId;
    case "comment-placements":
      return queryKey[2] === pullRequestId && documentPlacementUsesRepository(queryKey);
    default:
      return false;
  }
}
