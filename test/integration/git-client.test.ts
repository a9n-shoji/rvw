import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import { createGitRepository, git } from "../fixtures/git-repository.js";

describe("GitClient with real git", () => {
  it("gives exactly one concurrent creator ownership of an exact retained ref", async () => {
    const repository = createGitRepository("rvw-ref-cas-");
    const oid = git(repository, "rev-parse", "HEAD");
    const branchReviewId = "11111111-1111-4111-8111-111111111111";

    const retained = await Promise.all(
      Array.from({ length: 8 }, () =>
        new GitClient().ensureBranchCommitRef(repository, branchReviewId, oid),
      ),
    );

    expect(retained.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(retained.map(({ ref }) => ref))).toEqual(
      new Set([`refs/rvw/branch/${branchReviewId}/commits/oid-${oid}`]),
    );
  });

  it("reads trees, special files, rename diffs, search and internal refs", async () => {
    const repository = createGitRepository();
    const client = new GitClient();
    const base = git(repository, "rev-parse", "HEAD");
    writeFileSync(path.join(repository, "alpha.txt"), "alpha\r\nbeta\r\n");
    writeFileSync(path.join(repository, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(path.join(repository, "empty.txt"), "");
    writeFileSync(path.join(repository, "large.txt"), "x".repeat(1024 * 1024 + 1));
    writeFileSync(path.join(repository, "odd\nname.txt"), "needle in odd file\n");
    writeFileSync(path.join(repository, "search.txt"), "Needle needle needles _needle\n");
    symlinkSync("alpha.txt", path.join(repository, "link.txt"));
    git(repository, "add", "-A");
    git(repository, "commit", "-m", "special files");
    const special = git(repository, "rev-parse", "HEAD");
    git(repository, "mv", "alpha.txt", "renamed.txt");
    git(repository, "commit", "-m", "rename");
    const head = git(repository, "rev-parse", "HEAD");
    git(repository, "update-index", "--add", "--cacheinfo", `160000,${base},module`);
    git(repository, "commit", "-m", "gitlink");
    const withGitlink = git(repository, "rev-parse", "HEAD");

    const context = await client.repositoryContext(repository);
    expect(context.gitCommonDir).toBe(path.join(realpathSync(repository), ".git"));
    const tree = await client.tree(repository, withGitlink);
    expect(tree.find((entry) => entry.path === "link.txt")?.kind).toBe("symlink");
    expect(tree.find((entry) => entry.path === "module")?.kind).toBe("submodule");

    const text = await client.readDocument(repository, special, "alpha.txt");
    expect(text.text).toBe("alpha\nbeta\n");
    expect(text.normalizedLineEndings).toBe(true);
    expect((await client.readDocument(repository, special, "binary.bin")).availability).toBe(
      "binary",
    );
    expect((await client.readDocument(repository, special, "empty.txt")).text).toBe("");
    expect((await client.readDocument(repository, special, "large.txt")).availability).toBe(
      "too-large",
    );
    expect((await client.readDocument(repository, special, "link.txt")).text).toBe("alpha.txt");
    expect((await client.readDocument(repository, withGitlink, "module")).text).toBe(base);

    const changes = await client.changedFiles(repository, special, head);
    expect(changes).toContainEqual({
      kind: "renamed",
      status: "R100",
      similarity: 100,
      oldPath: "alpha.txt",
      newPath: "renamed.txt",
    });
    const search = await client.search(repository, withGitlink, "needle", {
      matchCase: true,
      wholeWord: false,
    });
    expect(search.results).toContainEqual({
      path: "odd\nname.txt",
      line: 1,
      text: "needle in odd file",
      matches: [{ start: 0, end: 6 }],
    });
    expect(search.results).toContainEqual({
      path: "search.txt",
      line: 1,
      text: "Needle needle needles _needle",
      matches: [
        { start: 7, end: 13 },
        { start: 14, end: 20 },
        { start: 23, end: 29 },
      ],
    });
    const wholeWordSearch = await client.search(repository, withGitlink, "needle", {
      matchCase: false,
      wholeWord: true,
    });
    expect(wholeWordSearch.results).toContainEqual({
      path: "search.txt",
      line: 1,
      text: "Needle needle needles _needle",
      matches: [
        { start: 0, end: 6 },
        { start: 7, end: 13 },
      ],
    });

    await client.ensureCommitRef(repository, 7, withGitlink);
    expect(await client.verifyCommitRef(repository, 7, withGitlink)).toBe(true);
    expect(await client.deleteRefsByPrefix(repository, "refs/rvw/pr/7/")).toBe(1);
    expect(await client.verifyCommitRef(repository, 7, withGitlink)).toBe(false);

    const commits = await client.commits(repository, base, withGitlink);
    expect(commits.map(({ subject }) => subject)).toEqual(["special files", "rename", "gitlink"]);

    chmodSync(repository, 0o755);
  });

  it("fetches through operation refs without changing FETCH_HEAD", async () => {
    const source = createGitRepository("rvw-fetch-source-");
    const base = git(source, "rev-parse", "HEAD");
    git(source, "switch", "-c", "feature");
    writeFileSync(path.join(source, "feature.txt"), "feature\n");
    git(source, "add", "feature.txt");
    git(source, "commit", "-m", "feature");
    const head = git(source, "rev-parse", "HEAD");

    const remote = mkdtempSync(path.join(os.tmpdir(), "rvw-fetch-remote-"));
    git(remote, "init", "--bare");
    git(source, "push", remote, `${base}:refs/heads/main`);
    git(source, "push", remote, `${head}:refs/pull/7/head`);

    const local = mkdtempSync(path.join(os.tmpdir(), "rvw-fetch-local-"));
    git(local, "init", "-b", "main");
    writeFileSync(path.join(local, ".git", "FETCH_HEAD"), "keep-this-fetch-head\n");

    const client = new GitClient();
    await client.ensurePullRequestObjects({
      cwd: local,
      remoteUrl: remote,
      number: 7,
      baseRefName: "main",
      baseOid: base,
      headOid: head,
    });

    expect(readFileSync(path.join(local, ".git", "FETCH_HEAD"), "utf8")).toBe(
      "keep-this-fetch-head\n",
    );
    expect(await client.hasObject(local, base)).toBe(true);
    expect(await client.hasObject(local, head)).toBe(true);
    expect(await client.listRefsByPrefix(local, "refs/rvw/tmp/")).toEqual([]);
  });
});
