import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../../src/domain/models.js";
import {
  commitRangeOldOid,
  earliestIncludedCommitOid,
  normalizedCommitRange,
  pullRequestRangeStartOid,
} from "../../src/web/commit-range.js";

function commit(oid: string, parentOids: string[]): CommitSummary {
  return {
    oid,
    parentOids,
    subject: oid,
    authorName: "Reviewer",
    authoredAt: "2026-08-11T00:00:00.000Z",
  };
}

describe("commit range", () => {
  const commits = [commit("a", []), commit("b", ["a"]), commit("c", ["b"])];

  it("normalizes selection endpoints into repository history order", () => {
    expect(normalizedCommitRange(commits, "c", "a")).toEqual({
      startOid: "a",
      endOid: "c",
    });
  });

  it("rejects a range containing an unknown endpoint", () => {
    expect(normalizedCommitRange(commits, "a", "missing")).toBeNull();
  });

  it("finds the earliest listed ancestor included by a selected commit", () => {
    expect(earliestIncludedCommitOid(commits, "c")).toBe("a");
    expect(earliestIncludedCommitOid(commits, "missing")).toBeNull();
  });

  it("walks every parent of a merge commit", () => {
    const merged = [
      commit("a", []),
      commit("b", ["a"]),
      commit("c", ["a"]),
      commit("d", ["b", "c"]),
    ];

    expect(earliestIncludedCommitOid(merged, "d")).toBe("a");
  });

  it("uses the first PR commit only when the latest head belongs to the current list", () => {
    expect(pullRequestRangeStartOid(commits, "c")).toBe("a");
    expect(pullRequestRangeStartOid(commits, "old-head")).toBeNull();
    expect(pullRequestRangeStartOid(commits, null)).toBeNull();
  });

  it("uses the PR comparison base when the range starts at the first listed commit", () => {
    const mergeBack = [commit("merge", ["feature-before-merge", "comparison-base"])];

    expect(commitRangeOldOid(mergeBack, "comparison-base", "merge")).toBe("comparison-base");
  });

  it("uses the first parent when a range starts after the first listed commit", () => {
    const mergeInTheMiddle = [
      commit("feature-before-merge", ["comparison-base"]),
      commit("merge", ["feature-before-merge", "merged-branch"]),
      commit("feature-after-merge", ["merge"]),
    ];

    expect(commitRangeOldOid(mergeInTheMiddle, "comparison-base", "merge")).toBe(
      "feature-before-merge",
    );
    expect(commitRangeOldOid(mergeInTheMiddle, "comparison-base", "missing")).toBeNull();
    expect(commitRangeOldOid(mergeInTheMiddle, "comparison-base", null)).toBeNull();
  });
});
