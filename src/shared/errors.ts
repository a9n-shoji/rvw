export type RvwErrorCode =
  | "AGENT_SOCKET_UNAVAILABLE"
  | "BINARY_DOCUMENT"
  | "REPOSITORY_REVIEW_NOT_FOUND"
  | "COMMENT_DELETE_NOT_ALLOWED"
  | "COMMENT_NOT_FOUND"
  | "COMMENT_POST_NOT_FOUND"
  | "COMMIT_NOT_FOUND"
  | "CONTENT_TYPE_REQUIRED"
  | "DATABASE_ERROR"
  | "DESTRUCTIVE_PREVIEW_STALE"
  | "DOCUMENT_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "GH_NOT_AUTHENTICATED"
  | "GH_NOT_FOUND"
  | "GIT_NOT_FOUND"
  | "GITHUB_ERROR"
  | "GITHUB_ISSUE_ERROR"
  | "GITHUB_ISSUE_IS_PULL_REQUEST"
  | "GITHUB_PR_NOT_OPEN"
  | "GITHUB_REPOSITORY_ERROR"
  | "HOST_NOT_ALLOWED"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_RESULT_DELETED"
  | "INTERNAL_ERROR"
  | "INVALID_COMMENT_URI"
  | "INVALID_COMMIT_RANGE"
  | "INVALID_INPUT"
  | "INVALID_ORIGIN"
  | "ISSUE_NOT_FOUND"
  | "LOCAL_CHANGES_NOT_PUSHED"
  | "LOCAL_STATE_INCONSISTENT"
  | "NOT_FOUND"
  | "NOT_IN_GIT_REPOSITORY"
  | "PR_NOT_FOUND"
  | "PROCESS_FAILED"
  | "PROCESS_OUTPUT_LIMIT"
  | "PROCESS_TIMEOUT"
  | "REPOSITORY_MISMATCH"
  | "REPOSITORY_RELOCATION_CONFIRMATION_REQUIRED"
  | "REPOSITORY_RELOCATION_REQUIRED"
  | "RESET_CONFIRMATION_REQUIRED"
  | "SKILL_CONFLICT"
  | "SKILL_NOT_FOUND"
  | "STALE_PROTOCOL"
  | "UNSUPPORTED_IMAGE"
  | "WALKTHROUGH_DELETE_CONFIRMATION_REQUIRED";

export interface SerializedRvwError {
  code: RvwErrorCode;
  message: string;
  suggestions: string[];
  details?: unknown;
}

export class RvwError extends Error {
  readonly code: RvwErrorCode;
  readonly suggestions: string[];
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: RvwErrorCode,
    message: string,
    options: {
      cause?: unknown;
      details?: unknown;
      status?: number;
      suggestions?: string[];
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RvwError";
    this.code = code;
    this.suggestions = options.suggestions ?? [];
    this.status = options.status ?? 400;
    this.details = options.details;
  }

  toJSON(): SerializedRvwError {
    return {
      code: this.code,
      message: this.message,
      suggestions: this.suggestions,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function asRvwError(error: unknown): RvwError {
  if (error instanceof RvwError) return error;
  if (error instanceof Error) {
    return new RvwError("INTERNAL_ERROR", error.message, {
      cause: error,
      status: 500,
    });
  }
  return new RvwError("INTERNAL_ERROR", "予期しないエラーが発生しました。", {
    details: error,
    status: 500,
  });
}
