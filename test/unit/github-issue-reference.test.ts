import { describe, expect, it } from "vitest";
import { parseIssueReference } from "../../src/infrastructure/github/github-client.js";

const repository = { owner: "acme", repository: "review-repo" };

describe("GitHub Issue references", () => {
  it.each([
    ["#142", { owner: "acme", repository: "review-repo", number: 142 }],
    ["acme/review-repo#19", { owner: "acme", repository: "review-repo", number: 19 }],
    [
      "https://github.com/acme/review-repo/issues/7#issuecomment-1",
      { owner: "acme", repository: "review-repo", number: 7 },
    ],
  ])("canonicalizes %s", (reference, expected) => {
    expect(parseIssueReference(reference, repository)).toEqual(expected);
  });

  it.each([
    "142",
    "https://github.com/acme/review-repo/pull/142",
    "https://github.example/acme/review-repo/issues/142",
  ])("rejects unsupported reference %s", (reference) => {
    expect(() => parseIssueReference(reference, repository)).toThrow(/Issue参照が不正/);
  });
});
