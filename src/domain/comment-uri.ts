import { RvwError } from "../shared/errors.js";

const COMMENT_URI =
  /^rvw:\/\/comment\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function formatCommentUri(commentId: string): string {
  return `rvw://comment/${commentId}`;
}

export function parseCommentUri(uri: string): string {
  const match = COMMENT_URI.exec(uri);
  if (!match?.[1]) {
    throw new RvwError("INVALID_COMMENT_URI", `コメント参照が不正です: ${uri}`);
  }
  return match[1];
}
