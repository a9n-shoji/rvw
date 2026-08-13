import { describe, expect, it } from "vitest";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import { commitRangeOldOid } from "../../src/web/commit-range.js";
import { commitFile, createGitRepository, git } from "../fixtures/git-repository.js";

describe("commit range with merge-back history", () => {
  it("anchors a PR-wide range at the comparison base instead of the merge first parent", async () => {
    const repository = createGitRepository("rvw-merge-back-range-");
    const client = new GitClient();

    git(repository, "switch", "-c", "feature");
    const featureBeforeMerge = commitFile(
      repository,
      "feature-before.txt",
      "feature before merge\n",
      "feature before merge",
    );

    git(repository, "switch", "main");
    const baseTip = commitFile(repository, "main-only.txt", "main only\n", "advance main");

    git(repository, "switch", "feature");
    git(repository, "merge", "--no-ff", "main", "-m", "Merge branch 'main' into feature");
    const mergeBack = git(repository, "rev-parse", "HEAD");
    const head = commitFile(
      repository,
      "feature-after.txt",
      "feature after merge\n",
      "feature after merge",
    );

    const comparisonBase = await client.mergeBase(repository, baseTip, head);
    const commits = await client.commits(repository, comparisonBase, head);

    expect(comparisonBase).toBe(baseTip);
    expect(commits.map((commit) => commit.oid)).toEqual([mergeBack, head]);
    expect(commits[0]?.parentOids).toEqual([featureBeforeMerge, baseTip]);

    const oldOid = commitRangeOldOid(commits, comparisonBase, commits[0]?.oid ?? null);
    expect(oldOid).toBe(baseTip);
    expect(
      (await client.changedFiles(repository, oldOid!, head)).map((change) => change.newPath),
    ).toEqual(["feature-after.txt", "feature-before.txt"]);
    expect(
      (await client.changedFiles(repository, featureBeforeMerge, head)).map(
        (change) => change.newPath,
      ),
    ).toEqual(["feature-after.txt", "main-only.txt"]);
  });

  it("keeps first-parent semantics for an intermediate merge absent from the current base", async () => {
    const repository = createGitRepository("rvw-intermediate-merge-range-");
    const client = new GitClient();
    const originalBase = git(repository, "rev-parse", "HEAD");

    git(repository, "switch", "-c", "feature");
    const featureBeforeMerge = commitFile(
      repository,
      "feature-before.txt",
      "feature before merge\n",
      "feature before merge",
    );

    git(repository, "switch", "main");
    commitFile(repository, "old-main-only.txt", "old main only\n", "advance old main");

    git(repository, "switch", "feature");
    git(repository, "merge", "--no-ff", "main", "-m", "Merge branch 'main' into feature");
    const intermediateMerge = git(repository, "rev-parse", "HEAD");
    const head = commitFile(
      repository,
      "feature-after.txt",
      "feature after merge\n",
      "feature after merge",
    );

    git(repository, "switch", "-c", "current-main", originalBase);
    const currentBaseTip = commitFile(
      repository,
      "current-main-only.txt",
      "current main only\n",
      "advance current main",
    );

    const comparisonBase = await client.mergeBase(repository, currentBaseTip, head);
    const commits = await client.commits(repository, comparisonBase, head);
    const mergeIndex = commits.findIndex((commit) => commit.oid === intermediateMerge);

    expect(comparisonBase).toBe(originalBase);
    expect(mergeIndex).toBeGreaterThan(0);
    expect(commitRangeOldOid(commits, comparisonBase, intermediateMerge)).toBe(featureBeforeMerge);
    expect(
      (await client.changedFiles(repository, featureBeforeMerge, head)).map(
        (change) => change.newPath,
      ),
    ).toEqual(["feature-after.txt", "old-main-only.txt"]);
  });
});
