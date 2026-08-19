import { RvwError } from "../shared/errors.js";

const CURSOR_VERSION = 1;
const DATABASE_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface CommentWatchCursor {
  databaseId: string;
  sequence: number;
}

export function formatCommentWatchCursor(cursor: CommentWatchCursor): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, d: cursor.databaseId, s: cursor.sequence }),
    "utf8",
  ).toString("base64url");
}

export function parseCommentWatchCursor(value: string): CommentWatchCursor {
  try {
    if (value.length === 0 || value.length > 512) throw new Error("cursor length");
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      decoded.v !== CURSOR_VERSION ||
      typeof decoded.d !== "string" ||
      !DATABASE_ID_PATTERN.test(decoded.d) ||
      typeof decoded.s !== "number" ||
      !Number.isSafeInteger(decoded.s) ||
      decoded.s < 0
    ) {
      throw new Error("cursor shape");
    }
    return { databaseId: decoded.d, sequence: decoded.s };
  } catch (error) {
    throw new RvwError("INVALID_INPUT", "comment watch cursorが不正です。", { cause: error });
  }
}
