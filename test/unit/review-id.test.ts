import { describe, expect, it } from "vitest";
import { parseReviewId } from "../../src/web/review-id.js";

describe("review ID parsing", () => {
  it.each([
    "11111111-1111-4111-8111-111111111111",
    "33333333-3333-4333-8333-333333333333",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  ])("accepts a supported UUID %s", (value) => {
    expect(parseReviewId(value)).toBe(value);
  });

  it.each([
    null,
    "not-a-uuid",
    "111111111111-4111-8111-111111111111",
    "11111111-1111-0111-8111-111111111111",
    "11111111-1111-4111-7111-111111111111",
  ])("rejects an invalid Review ID %s", (value) => {
    expect(parseReviewId(value)).toBeNull();
  });
});
