import type {
  ChangedFile,
  CommitSummary,
  CommentPlacement,
  CommentTarget,
  DeletedWalkthrough,
  DocumentContent,
  DocumentRef,
  PullRequest,
  ReviewComment,
  SearchResponse,
  TreeEntry,
  Walkthrough,
  WalkthroughSummary,
} from "../domain/models.js";
import type { ThemePreference } from "../shared/preferences.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
    readonly suggestions: string[] = [],
  ) {
    super(message);
  }
}

const localServerUnavailableMessage =
  "rvwのローカルサーバーに接続できません。表示済みの内容はそのまま保持されています。`rvw open`から起動し直してください。";

function isLocalServerConnectionError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("load failed") ||
    message.includes("networkerror")
  );
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (isLocalServerConnectionError(error)) {
      throw new ApiError(localServerUnavailableMessage, "LOCAL_SERVER_UNAVAILABLE");
    }
    throw error;
  }
  const body = (await response.json()) as {
    ok: boolean;
    error?: { code: string; message: string; details?: unknown; suggestions?: string[] };
  } & T;
  if (!response.ok || !body.ok) {
    throw new ApiError(
      body.error?.message ?? `HTTP ${response.status}`,
      body.error?.code ?? "HTTP_ERROR",
      body.error?.details,
      body.error?.suggestions ?? [],
    );
  }
  return body;
}

export function jsonRequest(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

export function documentUrl(ref: DocumentRef): string {
  const search = new URLSearchParams({ kind: ref.kind, pullRequestId: ref.pullRequestId });
  if (ref.kind === "repository-file") {
    search.set("sourceOid", ref.sourceOid);
    search.set("path", ref.path);
  } else if (ref.kind === "issue-markdown") {
    search.set("issueId", ref.issueId);
  }
  return `/api/pull-requests/${ref.pullRequestId}/document?${search.toString()}`;
}

export interface PullRequestResponse {
  pullRequest: PullRequest;
  comparisonBaseOid: string;
  headOid: string;
  commits: CommitSummary[];
}

export interface ThemePreferenceResponse {
  themePreference: ThemePreference;
}

export interface TreeResponse {
  virtual: "Pull Request.md";
  entries: TreeEntry[];
}

export interface ChangedFilesResponse {
  oldOid: string;
  newOid: string;
  files: ChangedFile[];
}

export interface DocumentResponse {
  document: DocumentContent;
}

export interface DiffResponse {
  diff: {
    old: DocumentContent | null;
    new: DocumentContent | null;
  };
}

export interface CommentsResponse {
  comments: ReviewComment[];
}

export interface WalkthroughsResponse {
  walkthroughs: WalkthroughSummary[];
}

export interface WalkthroughResponse {
  walkthrough: Walkthrough;
}

export interface DeleteWalkthroughResponse {
  deleted: DeletedWalkthrough;
}

export interface PlacementResponse {
  placement: CommentPlacement;
}

export type { CommentTarget, SearchResponse };
