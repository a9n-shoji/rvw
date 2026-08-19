import { describe, expect, it } from "vitest";
import {
  formatCommentWatchCursor,
  parseCommentWatchCursor,
} from "../../src/domain/comment-watch-cursor.js";

describe("comment watch cursor", () => {
  it("round-trips a database-scoped event position", () => {
    const value = { databaseId: "0123456789abcdef0123456789abcdef", sequence: 42 };
    expect(parseCommentWatchCursor(formatCommentWatchCursor(value))).toEqual(value);
  });

  it.each(["", "not-base64", Buffer.from('{"v":2}').toString("base64url")])(
    "rejects malformed cursor %s",
    (value) => {
      expect(() => parseCommentWatchCursor(value)).toThrow("cursorが不正");
    },
  );
});
