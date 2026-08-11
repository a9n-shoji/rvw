import { describe, expect, it } from "vitest";
import { formatWalkthroughUri, parseWalkthroughUri } from "../../src/domain/walkthrough-uri.js";

describe("walkthrough URI", () => {
  it("round-trips a UUID and rejects malformed references", () => {
    const id = "70000000-0000-4000-8000-000000000001";
    expect(parseWalkthroughUri(formatWalkthroughUri(id))).toBe(id);
    expect(() => parseWalkthroughUri("rvw://walkthrough/not-a-uuid")).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});
