import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RvwService } from "../../src/application/rvw-service.js";
import { formatCommentWatchCursor } from "../../src/domain/comment-watch-cursor.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  RepositoryIdentity,
} from "../../src/domain/models.js";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import type { GitHubPort } from "../../src/infrastructure/github/github-client.js";
import { startAgentSocket, tryAgentSocketRequest } from "../../src/server/agent-socket.js";
import { RvwError } from "../../src/shared/errors.js";
import { commitFile, createGitRepository, git } from "../fixtures/git-repository.js";

async function resetPullRequest(service: RvwService, pullRequestId: string) {
  const preview = await service.getResetPreview(pullRequestId);
  return await service.resetPullRequest(pullRequestId, preview.confirmationToken);
}

function removePullRequestIssue(
  service: RvwService,
  pullRequestReference: string,
  issueReference: string,
) {
  const pullRequest = service.resolveStoredPullRequest(pullRequestReference);
  const preview = service.getIssueRemovalPreview("pull-request", pullRequest.id, issueReference);
  return service.removePullRequestIssue(
    pullRequestReference,
    issueReference,
    preview.confirmationToken,
  );
}

function deleteWalkthrough(service: RvwService, uri: string) {
  const preview = service.getWalkthroughDeletePreview(uri);
  return service.deleteWalkthroughByUri(uri, preview.confirmationToken);
}

class OneShotBarrier {
  private blocked: Promise<void>;
  private markBlocked!: () => void;
  private releasePromise: Promise<void>;
  private releaseBlocked!: () => void;
  private armed = false;

  constructor() {
    this.blocked = new Promise((resolve) => {
      this.markBlocked = resolve;
    });
    this.releasePromise = new Promise((resolve) => {
      this.releaseBlocked = resolve;
    });
  }

  arm(): void {
    this.armed = true;
  }

  async blockOnce(): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    this.markBlocked();
    await this.releasePromise;
  }

  async waitUntilBlocked(): Promise<void> {
    await this.blocked;
  }

  release(): void {
    this.releaseBlocked();
  }
}

class FakeGitHub implements GitHubPort {
  readonly issues = new Map<number, GitHubIssue>();
  readonly pullRequestIssueNumbers = new Set<number>();
  issueBarrier: OneShotBarrier | null = null;
  pullRequestBarrier: OneShotBarrier | null = null;

  constructor(public pullRequest: GitHubPullRequest) {}

  doctor() {
    return Promise.resolve({ version: "gh fake", authenticated: true });
  }

  async getPullRequest() {
    await this.pullRequestBarrier?.blockOnce();
    return this.pullRequest;
  }

  async getIssue(number: number, repository: RepositoryIdentity): Promise<GitHubIssue> {
    expect(repository.canonicalName).toBe("acme/review-repo");
    await this.issueBarrier?.blockOnce();
    if (this.pullRequestIssueNumbers.has(number)) {
      throw new RvwError(
        "GITHUB_ISSUE_IS_PULL_REQUEST",
        `#${number}はIssueではなくPull Requestです。`,
      );
    }
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`missing Issue #${number}`);
    return issue;
  }

  getAttachment() {
    return Promise.reject(new Error("not used"));
  }
}

class PullRequestRetainBarrierGitClient extends GitClient {
  private barrier: Promise<void> | null = null;
  private releaseBarrier: (() => void) | null = null;
  private arrivals = 0;

  armRetainBarrier(): void {
    this.arrivals = 0;
    this.barrier = new Promise((resolve) => {
      this.releaseBarrier = resolve;
    });
  }

  override async ensureCommitRef(cwd: string, number: number, oid: string) {
    const retained = await super.ensureCommitRef(cwd, number, oid);
    const barrier = this.barrier;
    if (!barrier) return retained;
    this.arrivals += 1;
    if (this.arrivals === 2) {
      this.barrier = null;
      this.releaseBarrier?.();
      this.releaseBarrier = null;
    }
    await barrier;
    return retained;
  }
}

class PausePullRequestRefGitClient extends GitClient {
  readonly barrier = new OneShotBarrier();

  override async ensureCommitRef(cwd: string, number: number, oid: string) {
    const retained = await super.ensureCommitRef(cwd, number, oid);
    await this.barrier.blockOnce();
    return retained;
  }
}

function githubIssue(
  number: number,
  body = `Issue ${number} body`,
  updatedAt = "2026-08-20T00:00:00.000Z",
): GitHubIssue {
  return {
    host: "github.com",
    owner: "acme",
    repository: "review-repo",
    canonicalName: "acme/review-repo",
    number,
    url: `https://github.com/acme/review-repo/issues/${number}`,
    title: `Issue ${number}`,
    body,
    state: "OPEN",
    updatedAt,
  };
}

function jsonShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [jsonShape(value[0])];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonShape(child)]));
  }
  return typeof value;
}

const openPr = (baseOid: string, headOid: string): GitHubPullRequest => ({
  host: "github.com",
  owner: "acme",
  repository: "review-repo",
  number: 7,
  url: "https://github.com/acme/review-repo/pull/7",
  authorLogin: "review-author",
  headRepositoryOwner: "acme",
  headRepositoryName: "review-repo",
  title: "Initial review",
  body: "Please review.",
  baseRefName: "main",
  baseOid,
  headRefName: "feature",
  headOid,
  updatedAt: "2026-08-08T00:00:00.000Z",
  state: "OPEN",
  isDraft: false,
});

describe("RvwService commit workflow", () => {
  const databases: RvwDatabase[] = [];
  afterEach(() => {
    while (databases.length) databases.pop()?.close();
  });

  function setup(prefix = "rvw-commit-", gitClient: GitClient = new GitClient()) {
    const repository = createGitRepository(prefix);
    const base = git(repository, "rev-parse", "HEAD");
    git(repository, "switch", "-c", "feature");
    const firstHead = commitFile(repository, "src.txt", "first\nsecond\n", "first change");
    const fake = new FakeGitHub(openPr(base, firstHead));
    const dbFile = path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-db-")), "rvw.db");
    const database = new RvwDatabase({ filePath: dbFile, migrationsDirectory: "./migrations" });
    databases.push(database);
    return {
      repository,
      base,
      firstHead,
      fake,
      database,
      service: new RvwService(database, gitClient, fake),
    };
  }

  it("doctor performs a database write probe without changing review state", async () => {
    const { repository, database, service } = setup("rvw-doctor-write-probe-");
    const changeSequence = database.getChangeSequence();

    await expect(service.doctor(repository)).resolves.toMatchObject({
      ok: true,
      databaseWriteProbe: { ok: true, error: null },
    });
    expect(database.getChangeSequence()).toBe(changeSequence);
  });

  it("reports 64-character Branch retained-ref OIDs instead of silently dropping them", async () => {
    const { repository, service } = setup("rvw-doctor-sha256-ref-");
    const oid = "a".repeat(64);
    const reviewId = "11111111-1111-4111-8111-111111111111";
    vi.spyOn(service.git, "listRefsByPrefix").mockResolvedValue([
      `refs/rvw/branch/${reviewId}/commits/oid-${oid}`,
    ]);

    await expect(service.doctor(repository)).resolves.toMatchObject({
      branchRetainedRefs: {
        refs: [{ reviewId, oid, status: "orphan-review" }],
      },
    });
  });

  it("adds only direct same-repository Issue references from the PR body and never removes them", async () => {
    const { repository, fake, service } = setup("rvw-pr-direct-issues-");
    fake.issues.set(142, githubIssue(142, "Requirement with a nested #77 reference."));
    fake.issues.set(99, githubIssue(99));
    fake.issues.set(88, githubIssue(88));
    fake.issues.set(66, githubIssue(66));
    fake.issues.set(55, githubIssue(55));
    fake.issues.set(44, githubIssue(44));
    fake.pullRequest = {
      ...fake.pullRequest,
      body: [
        "Closes #142.",
        "Also acme/review-repo#99.",
        "See [the tracked issue](https://github.com/acme/review-repo/issues/88).",
        "Ignore other/repository#77.",
        "Inline code is not a relation: `#66`.",
        "```text",
        "Closes #55",
        "```",
        "<code>#44</code>",
      ].join("\n"),
    };

    const opened = await service.openPullRequest(undefined, repository);
    expect(
      service.listPullRequestIssues(opened.pullRequest.id).map(({ number }) => number),
    ).toEqual([142, 99, 88]);
    const issue142 = service
      .listPullRequestIssues(opened.pullRequest.id)
      .find(({ number }) => number === 142)!;
    const issue99 = service
      .listPullRequestIssues(opened.pullRequest.id)
      .find(({ number }) => number === 99)!;
    await expect(
      service.getDocument({
        kind: "issue-markdown",
        pullRequestId: opened.pullRequest.id,
        issueId: issue142.id,
      }),
    ).resolves.toMatchObject({ text: "Requirement with a nested #77 reference." });
    const issueComment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: { kind: "issue", issue: "#142", startLine: 1, endLine: 1 },
      body: "Review this requirement.",
    });
    const wholeIssueComment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: { kind: "issue", issue: "#142", startLine: null, endLine: null },
      body: "Track the requirement as a whole.",
    });
    await expect(
      service.placeComment(issueComment, {
        kind: "issue-markdown",
        pullRequestId: opened.pullRequest.id,
        issueId: issue142.id,
      }),
    ).resolves.toEqual({ outdated: false, range: { startLine: 1, endLine: 1 }, path: "#142" });
    await expect(
      service.placeComment(issueComment, {
        kind: "issue-markdown",
        pullRequestId: opened.pullRequest.id,
        issueId: issue99.id,
      }),
    ).resolves.toEqual({ outdated: true, range: null, path: null });

    fake.issues.set(142, githubIssue(142, "Updated requirement body.", "2026-08-20T01:00:00.000Z"));
    await service.refreshPullRequest(opened.pullRequest.id);
    await expect(
      service.placeCommentAtCommit(issueComment, opened.pullRequest.latestHeadOid),
    ).resolves.toEqual({ outdated: true, range: null, path: "#142" });
    await expect(
      service.placeCommentAtCommit(wholeIssueComment, opened.pullRequest.latestHeadOid),
    ).resolves.toEqual({ outdated: false, range: null, path: "#142" });

    fake.pullRequest = { ...fake.pullRequest, body: "References removed from the PR body." };
    await service.refreshPullRequest(opened.pullRequest.id);
    expect(
      service.listPullRequestIssues(opened.pullRequest.id).map(({ number }) => number),
    ).toEqual([142, 99, 88]);
    expect(service.listPullRequestIssues(opened.pullRequest.id)).not.toContainEqual(
      expect.objectContaining({ number: 77 }),
    );

    fake.pullRequestIssueNumbers.add(44);
    fake.pullRequest = {
      ...fake.pullRequest,
      body: "Closes #44\nCloses #404",
    };
    const partial = await service.refreshPullRequest(opened.pullRequest.id);
    const pullRequestFailure = partial.issueResults.find(({ reference }) => reference === "#44");
    expect(pullRequestFailure).toMatchObject({ issue: null, ok: false });
    expect(pullRequestFailure?.ok === false ? pullRequestFailure.error.code : null).toBe(
      "GITHUB_ISSUE_IS_PULL_REQUEST",
    );
    expect(partial.issueResults.find(({ reference }) => reference === "#404")).toMatchObject({
      issue: null,
      ok: false,
    });
    expect(
      service.listPullRequestIssues(opened.pullRequest.id).map(({ number }) => number),
    ).toEqual([142, 99, 88]);
    await expect(
      service.addPullRequestIssue(opened.pullRequest.url, "other/repository#142"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.addPullRequestIssue(opened.pullRequest.url, "#44")).rejects.toMatchObject({
      code: "GITHUB_ISSUE_IS_PULL_REQUEST",
    });

    fake.issues.delete(142);
    fake.pullRequest = { ...fake.pullRequest, body: "Closes #142" };
    const stale = await service.refreshPullRequest(opened.pullRequest.id);
    const staleResults = stale.issueResults.filter(({ reference }) => reference === "#142");
    expect(staleResults).toHaveLength(1);
    expect(staleResults[0]).toMatchObject({
      ok: false,
      issue: { number: 142, syncError: "missing Issue #142" },
    });
    await expect(service.getAnyCommentReviewContext(issueComment.ref)).resolves.toMatchObject({
      issue: { number: 142, syncError: "missing Issue #142", stale: true },
    });

    fake.issues.set(142, githubIssue(142, "Requirement with a nested #77 reference."));
    const ensured = await service.publishWalkthrough({
      review: { kind: "pull-request", pullRequest: opened.pullRequest.url },
      sourceOid: opened.pullRequest.latestHeadOid,
      title: "Issue recovery",
      body: "Read [the source](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "Source",
          path: "src.txt",
          startLine: 1,
          endLine: 1,
          description: null,
        },
      ],
      issuesToAdd: ["#142"],
    });
    expect(ensured.issuesAdded).toEqual([]);
    await expect(service.getAnyCommentReviewContext(issueComment.ref)).resolves.toMatchObject({
      issue: { number: 142, syncError: null, stale: false },
    });
  });

  it("does not recreate removed manual PR Issue memberships while refreshing them", async () => {
    const { repository, fake, database, service } = setup("rvw-pr-issue-removal-race-");
    fake.issues.set(142, githubIssue(142));
    const opened = await service.openPullRequest(undefined, repository);
    const added = await service.addPullRequestIssue(opened.pullRequest.url, "#142");
    fake.issues.set(
      142,
      githubIssue(142, "Fetched after explicit removal", "2026-08-20T01:00:00.000Z"),
    );
    const barrier = new OneShotBarrier();
    barrier.arm();
    fake.issueBarrier = barrier;

    const refresh = service.refreshPullRequest(opened.pullRequest.id);
    await barrier.waitUntilBlocked();
    removePullRequestIssue(service, opened.pullRequest.url, "#142");
    const cacheAfterRemoval = database.getIssue(added.issue.id);
    barrier.release();

    const refreshed = await refresh;
    expect(refreshed.issueResults).toEqual([
      expect.objectContaining({ ok: true, skipped: "membership-removed" }),
    ]);
    expect(service.listPullRequestIssues(opened.pullRequest.id)).toEqual([]);
    expect(database.getIssue(added.issue.id)).toEqual(cacheAfterRemoval);

    fake.pullRequest = { ...fake.pullRequest, body: "Closes #142" };
    await service.refreshPullRequest(opened.pullRequest.id);
    expect(service.listPullRequestIssues(opened.pullRequest.id)).toEqual([
      expect.objectContaining({ number: 142, body: "Fetched after explicit removal" }),
    ]);
  });

  it("repairs an equal-version Issue cache conflict only after two matching GitHub reads", async () => {
    const { repository, fake, database, service } = setup("rvw-pr-issue-force-repair-");
    const initial = githubIssue(142, "Initial body", "2026-08-20T01:00:00.000Z");
    fake.issues.set(142, initial);
    const opened = await service.openPullRequest(undefined, repository);
    const added = await service.addPullRequestIssue(opened.pullRequest.url, "#142");
    fake.issues.set(142, {
      ...initial,
      title: "Corrected title",
      body: "Corrected body at the same GitHub updatedAt",
    });

    await expect(service.refreshPullRequest(opened.pullRequest.id)).resolves.toMatchObject({
      issueResults: [expect.objectContaining({ ok: false })],
    });
    expect(database.getIssue(added.issue.id)).toMatchObject({
      title: initial.title,
      body: initial.body,
    });
    await expect(
      service.forceRepairPullRequestIssue(opened.pullRequest.url, "#142"),
    ).resolves.toMatchObject({
      repaired: true,
      verifiedReads: 2,
      issue: {
        title: "Corrected title",
        body: "Corrected body at the same GitHub updatedAt",
      },
    });
  });

  it("does not force-repair an Issue cache from two different GitHub snapshots", async () => {
    const { repository, fake, database, service } = setup("rvw-pr-issue-unstable-repair-");
    const initial = githubIssue(142, "Initial body", "2026-08-20T01:00:00.000Z");
    fake.issues.set(142, initial);
    const opened = await service.openPullRequest(undefined, repository);
    const added = await service.addPullRequestIssue(opened.pullRequest.url, "#142");
    const before = database.getIssue(added.issue.id);
    vi.spyOn(fake, "getIssue")
      .mockResolvedValueOnce({ ...initial, body: "First repair read" })
      .mockResolvedValueOnce({ ...initial, body: "Second repair read" });

    await expect(
      service.forceRepairPullRequestIssue(opened.pullRequest.url, "#142"),
    ).rejects.toMatchObject({
      code: "GITHUB_ISSUE_ERROR",
      details: { reason: "ISSUE_REPAIR_SNAPSHOT_UNSTABLE", number: 142 },
    });
    expect(database.getIssue(added.issue.id)).toEqual(before);
  });

  it("does not let force repair overwrite a cache accepted after its two-read attempt began", async () => {
    const { repository, fake, database, service } = setup("rvw-pr-issue-stale-repair-");
    const initial = githubIssue(142, "Initial body", "2026-08-20T01:00:00.000Z");
    fake.issues.set(142, initial);
    const opened = await service.openPullRequest(undefined, repository);
    const added = await service.addPullRequestIssue(opened.pullRequest.url, "#142");
    fake.issues.set(142, {
      ...initial,
      body: "Stable but stale repair candidate",
    });
    const barrier = new OneShotBarrier();
    barrier.arm();
    fake.issueBarrier = barrier;

    const repair = service.forceRepairPullRequestIssue(opened.pullRequest.url, "#142");
    await barrier.waitUntilBlocked();
    const newer = githubIssue(142, "Newer accepted body", "2026-08-20T02:00:00.000Z");
    expect(
      database.refreshReviewIssue("pull-request", opened.pullRequest.id, added.issue.id, newer),
    ).toMatchObject({ refreshed: true, issue: { body: "Newer accepted body" } });
    barrier.release();

    await expect(repair).rejects.toMatchObject({
      code: "GITHUB_ISSUE_ERROR",
      details: { reason: "ISSUE_REPAIR_STALE", issueId: added.issue.id },
    });
    expect(database.getIssue(added.issue.id)).toMatchObject({
      body: "Newer accepted body",
      updatedAt: newer.updatedAt,
    });
  });

  it("does not report a failed PR Issue refresh after its membership was removed", async () => {
    const { repository, fake, database, service } = setup("rvw-pr-issue-failure-removal-race-");
    fake.issues.set(142, githubIssue(142));
    const opened = await service.openPullRequest(undefined, repository);
    const added = await service.addPullRequestIssue(opened.pullRequest.url, "#142");
    const barrier = new OneShotBarrier();
    barrier.arm();
    fake.issueBarrier = barrier;

    const refresh = service.refreshPullRequest(opened.pullRequest.id);
    await barrier.waitUntilBlocked();
    removePullRequestIssue(service, opened.pullRequest.url, "#142");
    fake.issues.delete(142);
    const cacheAfterRemoval = database.getIssue(added.issue.id);
    const sequenceAfterRemoval = database.getReviewChangeSequence(
      "pull-request",
      opened.pullRequest.id,
    );
    barrier.release();

    const refreshed = await refresh;
    expect(refreshed.issueResults).toEqual([
      expect.objectContaining({ ok: true, skipped: "membership-removed" }),
    ]);
    expect(service.listPullRequestIssues(opened.pullRequest.id)).toEqual([]);
    expect(database.getIssue(added.issue.id)).toEqual(cacheAfterRemoval);
    expect(database.getReviewChangeSequence("pull-request", opened.pullRequest.id)).toBe(
      sequenceAfterRemoval,
    );
  });

  it("uses commits as history, keeps PR markdown latest, syncs comment updates, and resets", async () => {
    const { repository, base, firstHead, fake, service } = setup();
    const opened = await service.openPullRequest(undefined, repository);
    expect(opened.fromCache).toBe(false);
    expect((await service.getPullRequestView(opened.pullRequest.id)).commits).toMatchObject([
      { oid: firstHead, subject: "first change" },
    ]);

    const comment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: firstHead,
        path: "src.txt",
        startLine: 2,
        endLine: 2,
      },
      body: "Please preserve this line.",
      authorLabel: "You",
    });

    const secondHead = commitFile(
      repository,
      "src.txt",
      "inserted\nfirst\nsecond\n",
      "insert a line",
    );
    fake.pullRequest = {
      ...fake.pullRequest,
      title: "Updated review",
      body: "Only the latest body is shown.",
      headOid: secondHead,
      updatedAt: "2026-08-08T01:00:00.000Z",
    };
    const refreshed = await service.refreshPullRequest(opened.pullRequest.id);
    expect(refreshed.commits.map(({ oid }) => oid)).toEqual([firstHead, secondHead]);
    expect(
      (
        await service.getDocument({
          kind: "pull-request-markdown",
          pullRequestId: opened.pullRequest.id,
        })
      ).text,
    ).toContain("Only the latest body is shown.");
    const changedFiles = vi.spyOn(service.git, "changedFiles");
    expect(
      await service.placeCommentAtCommit(service.getCommentByUri(comment.ref).comment, secondHead),
    ).toEqual({
      outdated: false,
      range: { startLine: 3, endLine: 3 },
      path: "src.txt",
    });
    expect(changedFiles).toHaveBeenCalledOnce();

    const synced = await service.syncPullRequest({
      pullRequest: fake.pullRequest.url,
      commentUpdates: [
        {
          commentRef: comment.ref,
          reply: "Preserved in the latest commit.",
          resolve: true,
          authorLabel: "Codex",
        },
      ],
    });
    expect(synced.commentUpdatesApplied).toBe(1);
    const updatedComment = service.getCommentByUri(comment.ref).comment;
    expect(updatedComment.resolvedAt).not.toBeNull();
    expect(updatedComment.posts[1]).toMatchObject({ relatedCommitOid: secondHead });

    const worktree = `${repository}-worktree`;
    git(repository, "worktree", "add", "--detach", worktree, secondHead);
    const cached = await service.openPullRequest(undefined, worktree);
    expect(cached.fromCache).toBe(true);
    expect(cached.pullRequest.gitCommonDir).toBe(opened.pullRequest.gitCommonDir);

    fake.issues.set(142, githubIssue(142));
    await service.addPullRequestIssue(opened.pullRequest.url, "#142");

    const preview = await service.getResetPreview(opened.pullRequest.id);
    expect(preview.counts).toMatchObject({
      issueMemberships: 1,
      comments: 1,
      posts: 2,
      targets: 1,
      gitRefs: 0,
    });
    expect(preview.retainedRefs).toHaveLength(2);
    expect(preview.retainedRefsPreserved).toBe(true);
    const reset = await resetPullRequest(service, opened.pullRequest.id);
    expect(reset.pullRequest.latestComparisonBaseOid).toBe(base);
    expect(reset.commits.map(({ oid }) => oid)).toEqual([firstHead, secondHead]);
    expect(service.listComments(opened.pullRequest.id)).toHaveLength(0);
    expect(service.listPullRequestIssues(opened.pullRequest.id)).toHaveLength(0);
    const afterResetPreview = await service.getResetPreview(opened.pullRequest.id);
    expect(afterResetPreview.counts.gitRefs).toBe(0);
    expect(afterResetPreview.retainedRefs).toHaveLength(2);
  });

  it("reopens an explicitly registered PR outside a repository", async () => {
    const { repository, fake, service } = setup("rvw-open-outside-");
    const opened = await service.openPullRequest(undefined, repository);
    const outsideRepository = mkdtempSync(path.join(os.tmpdir(), "rvw-outside-repository-"));

    const reopened = await service.openPullRequest(fake.pullRequest.url, outsideRepository);

    expect(reopened.fromCache).toBe(true);
    expect(reopened.pullRequest.id).toBe(opened.pullRequest.id);
    expect(reopened.pullRequest.localRepositoryPath).toBe(opened.pullRequest.localRepositoryPath);
  });

  it("uses the saved binding for an explicit PR opened from an unrelated repository", async () => {
    const { repository, fake, service } = setup("rvw-open-unrelated-");
    const opened = await service.openPullRequest(undefined, repository);
    const unrelatedRepository = createGitRepository("rvw-unrelated-repository-");

    const reopened = await service.openPullRequest(fake.pullRequest.url, unrelatedRepository);

    expect(reopened.fromCache).toBe(true);
    expect(reopened.pullRequest.id).toBe(opened.pullRequest.id);
    expect(reopened.pullRequest.localRepositoryPath).toBe(opened.pullRequest.localRepositoryPath);
  });

  it("upgrades a released DB's symlinked PR binding to real paths on cached open", async () => {
    const { repository, fake, database, service } = setup("rvw-pr-legacy-symlink-");
    const opened = await service.openPullRequest(undefined, repository);
    const links = mkdtempSync(path.join(os.tmpdir(), "rvw-pr-legacy-link-"));
    const linkedRepository = path.join(links, "repository");
    symlinkSync(repository, linkedRepository, "dir");
    const raw = new DatabaseSync(database.filePath);
    raw
      .prepare(
        "UPDATE pull_requests SET local_repository_path = ?, git_common_dir = ? WHERE id = ?",
      )
      .run(linkedRepository, path.join(linkedRepository, ".git"), opened.pullRequest.id);
    raw.close();

    const reopened = await service.openPullRequest(fake.pullRequest.url, repository);

    expect(reopened.fromCache).toBe(true);
    expect(reopened.pullRequest).toMatchObject({
      id: opened.pullRequest.id,
      localRepositoryPath: realpathSync(repository),
      gitCommonDir: realpathSync(path.join(repository, ".git")),
    });
  });

  it("rejects stale destructive previews before Pull Request artifacts are deleted", async () => {
    const { repository, fake, database, service } = setup("rvw-pr-destructive-token-");
    const opened = await service.openPullRequest(undefined, repository);
    fake.issues.set(142, githubIssue(142));
    const added = await service.addPullRequestIssue(opened.pullRequest.url, "#142");
    const walkthrough = (
      await service.publishWalkthrough({
        review: { kind: "pull-request", pullRequest: opened.pullRequest.url },
        sourceOid: opened.pullRequest.latestHeadOid,
        title: "Destructive preview",
        body: "Read [the source](rvw-ref:source).",
        references: [
          {
            id: "source",
            label: "Source",
            path: "README.md",
            startLine: 1,
            endLine: 1,
            description: null,
          },
        ],
      })
    ).walkthrough;
    const resetPreview = await service.getResetPreview(opened.pullRequest.id);
    const issuePreview = service.getIssueRemovalPreview(
      "pull-request",
      opened.pullRequest.id,
      "#142",
    );
    const walkthroughPreview = service.getWalkthroughDeletePreview(walkthrough.ref);
    await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: { kind: "pull-request" },
      body: "Added after all previews.",
    });

    await expect(
      service.resetPullRequest(opened.pullRequest.id, resetPreview.confirmationToken),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    expect(() =>
      service.removePullRequestIssue(
        opened.pullRequest.url,
        "#142",
        issuePreview.confirmationToken,
      ),
    ).toThrowError(expect.objectContaining({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 }));
    expect(() =>
      service.deleteWalkthroughByUri(walkthrough.ref, walkthroughPreview.confirmationToken),
    ).toThrowError(expect.objectContaining({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 }));
    expect(database.hasReviewIssue("pull-request", opened.pullRequest.id, added.issue.id)).toBe(
      true,
    );
    expect(database.getWalkthrough(walkthrough.id)).not.toBeNull();
  });

  it("returns a fresh preview when the final SQLite destructive CAS detects a race", async () => {
    const { repository, fake, database, service } = setup("rvw-final-cas-preview-");
    const opened = await service.openPullRequest(undefined, repository);
    fake.issues.set(142, githubIssue(142));
    const added = await service.addPullRequestIssue(opened.pullRequest.url, "#142");
    const issuePreview = service.getIssueRemovalPreview(
      "pull-request",
      opened.pullRequest.id,
      "#142",
    );
    const removeReviewIssue = database.removeReviewIssue.bind(database);
    const removeSpy = vi
      .spyOn(database, "removeReviewIssue")
      .mockImplementationOnce((...args: Parameters<RvwDatabase["removeReviewIssue"]>) => {
        database.incrementChangeSequence({
          kind: "pull-request",
          reviewId: opened.pullRequest.id,
        });
        return removeReviewIssue(...args);
      });

    const issueError = (() => {
      try {
        service.removePullRequestIssue(
          opened.pullRequest.url,
          "#142",
          issuePreview.confirmationToken,
        );
        return null;
      } catch (error) {
        return error as RvwError;
      }
    })();
    expect(issueError?.code).toBe("DESTRUCTIVE_PREVIEW_STALE");
    expect(issueError?.status).toBe(409);
    const currentIssuePreview = (
      issueError?.details as {
        currentPreview: { issue: { id: string }; confirmationToken: string };
      }
    ).currentPreview;
    expect(currentIssuePreview.issue.id).toBe(added.issue.id);
    expect(typeof currentIssuePreview.confirmationToken).toBe("string");
    removeSpy.mockRestore();

    const walkthrough = (
      await service.publishWalkthrough({
        review: { kind: "pull-request", pullRequest: opened.pullRequest.url },
        sourceOid: opened.pullRequest.latestHeadOid,
        title: "Final CAS",
        body: "Read [the source](rvw-ref:source).",
        references: [
          {
            id: "source",
            label: "Source",
            path: "src.txt",
            startLine: 1,
            endLine: 1,
            description: null,
          },
        ],
      })
    ).walkthrough;
    const walkthroughPreview = service.getWalkthroughDeletePreview(walkthrough.ref);
    const deleteWalkthrough = database.deleteWalkthrough.bind(database);
    vi.spyOn(database, "deleteWalkthrough").mockImplementationOnce(
      (...args: Parameters<RvwDatabase["deleteWalkthrough"]>) => {
        database.incrementChangeSequence({
          kind: "pull-request",
          reviewId: opened.pullRequest.id,
        });
        return deleteWalkthrough(...args);
      },
    );

    const walkthroughError = (() => {
      try {
        service.deleteWalkthroughByUri(walkthrough.ref, walkthroughPreview.confirmationToken);
        return null;
      } catch (error) {
        return error as RvwError;
      }
    })();
    expect(walkthroughError?.code).toBe("DESTRUCTIVE_PREVIEW_STALE");
    expect(walkthroughError?.status).toBe(409);
    const currentWalkthroughPreview = (
      walkthroughError?.details as { currentPreview: { confirmationToken: string } }
    ).currentPreview;
    expect(typeof currentWalkthroughPreview.confirmationToken).toBe("string");
  });

  it("preserves PR refs when a concurrent writer wins the final reset sequence CAS", async () => {
    const gitClient = new PausePullRequestRefGitClient();
    const { repository, database, service } = setup("rvw-pr-reset-ref-race-", gitClient);
    const opened = await service.openPullRequest(undefined, repository);
    const preview = await service.getResetPreview(opened.pullRequest.id);
    const refsBefore = await service.git.listRefsByPrefix(
      repository,
      `refs/rvw/pr/${opened.pullRequest.number}/`,
    );
    gitClient.barrier.arm();

    const reset = service.resetPullRequest(opened.pullRequest.id, preview.confirmationToken);
    await gitClient.barrier.waitUntilBlocked();
    const comment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: { kind: "pull-request" },
      body: "Created after reset retained its head and before its SQLite CAS.",
    });
    gitClient.barrier.release();

    const stale = (await reset.catch((error: unknown) => error)) as RvwError;
    expect(stale.code).toBe("DESTRUCTIVE_PREVIEW_STALE");
    expect(stale.status).toBe(409);
    const currentResetPreview = (
      stale.details as {
        currentPreview: { reviewChangeSequence: number; confirmationToken: string };
      }
    ).currentPreview;
    expect(typeof currentResetPreview.reviewChangeSequence).toBe("number");
    expect(typeof currentResetPreview.confirmationToken).toBe("string");
    expect(currentResetPreview.confirmationToken).not.toBe(preview.confirmationToken);
    expect(database.getComment(comment.id)).not.toBeNull();
    await expect(
      service.git.listRefsByPrefix(repository, `refs/rvw/pr/${opened.pullRequest.number}/`),
    ).resolves.toEqual(refsBefore);
  });

  it("keeps historical PR evidence available to a writer linearized after reset", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-pr-reset-writer-after-");
    const opened = await service.openPullRequest(undefined, repository);
    const secondHead = commitFile(repository, "src.txt", "first\nsecond\nthird\n", "advance");
    fake.pullRequest = {
      ...fake.pullRequest,
      headOid: secondHead,
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    await service.refreshPullRequest(opened.pullRequest.id);
    const refsBefore = await service.git.listRefsByPrefix(
      repository,
      `refs/rvw/pr/${opened.pullRequest.number}/`,
    );
    expect(refsBefore).toHaveLength(2);

    const preview = await service.getResetPreview(opened.pullRequest.id);
    expect(preview).toMatchObject({
      counts: { gitRefs: 0 },
      retainedRefs: refsBefore,
      retainedRefsPreserved: true,
    });
    await service.resetPullRequest(opened.pullRequest.id, preview.confirmationToken);

    const historical = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: firstHead,
        path: "src.txt",
        startLine: 1,
        endLine: 1,
      },
      body: "Created after reset against retained historical evidence.",
    });
    expect(historical.target).toMatchObject({ sourceOid: firstHead });
    await expect(
      service.git.listRefsByPrefix(repository, `refs/rvw/pr/${opened.pullRequest.number}/`),
    ).resolves.toEqual(refsBefore);
  });

  it("keeps a numeric PR reference scoped to the current repository", async () => {
    const { repository, database, service } = setup("rvw-open-number-scope-first-");
    const first = await service.openPullRequest(undefined, repository);
    const otherRepository = createGitRepository("rvw-open-number-scope-second-");
    git(
      otherRepository,
      "remote",
      "set-url",
      "origin",
      "https://github.com/other-owner/other-repository.git",
    );
    const otherBase = git(otherRepository, "rev-parse", "HEAD");
    git(otherRepository, "switch", "-c", "feature");
    const otherHead = commitFile(otherRepository, "other.txt", "other\n", "other change");
    const otherGithub = new FakeGitHub({
      ...openPr(otherBase, otherHead),
      owner: "other-owner",
      repository: "other-repository",
      url: "https://github.com/other-owner/other-repository/pull/7",
    });
    const otherService = new RvwService(database, new GitClient(), otherGithub);

    const second = await otherService.openPullRequest("7", otherRepository);

    expect(second.fromCache).toBe(false);
    expect(second.pullRequest.id).not.toBe(first.pullRequest.id);
    expect(second.pullRequest.owner).toBe("other-owner");
    expect(path.basename(second.pullRequest.localRepositoryPath)).toBe(
      path.basename(otherRepository),
    );
  });

  it("reports dirty entries and can synchronize through an explicitly selected clean worktree", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-sync-worktree-");
    const opened = await service.openPullRequest(undefined, repository);
    writeFileSync(path.join(repository, "untracked-agent-worktree.txt"), "unrelated\n");

    await expect(
      service.syncPullRequest({ pullRequest: fake.pullRequest.url }),
    ).rejects.toMatchObject({
      code: "LOCAL_CHANGES_NOT_PUSHED",
      details: {
        localRepositoryPath: opened.pullRequest.localRepositoryPath,
        dirtyEntries: ["?? untracked-agent-worktree.txt"],
      },
    });

    await expect(
      service.syncPullRequest({
        pullRequest: fake.pullRequest.url,
        allowUntracked: true,
      }),
    ).resolves.toMatchObject({ commentUpdatesApplied: 0 });

    const cleanWorktree = `${repository}-clean-worktree`;
    git(repository, "worktree", "add", "--detach", cleanWorktree, firstHead);
    const attached = await service.attachPullRequest(fake.pullRequest.url, cleanWorktree);
    expect(path.basename(attached.localRepositoryPath)).toBe(path.basename(cleanWorktree));
    await expect(
      service.syncPullRequest({
        pullRequest: fake.pullRequest.url,
        repositoryPath: cleanWorktree,
      }),
    ).resolves.toMatchObject({
      pullRequest: { localRepositoryPath: attached.localRepositoryPath },
    });
  });

  it("synchronizes a clean local PR branch that is simply behind GitHub", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-sync-behind-");
    await service.openPullRequest(undefined, repository);
    const githubHead = commitFile(repository, "src.txt", "first\nsecond\nthird\n", "remote commit");
    fake.pullRequest = { ...fake.pullRequest, headOid: githubHead };
    git(repository, "reset", "--hard", firstHead);

    const synced = await service.syncPullRequest({ pullRequest: fake.pullRequest.url });

    expect(synced.pullRequest.latestHeadOid).toBe(githubHead);
    expect(git(repository, "rev-parse", "HEAD")).toBe(firstHead);
  });

  it("synchronizes a force-pushed GitHub head when local HEAD is the last cached GitHub head", async () => {
    const { repository, base, firstHead, fake, service } = setup("rvw-sync-force-push-");
    await service.openPullRequest(undefined, repository);
    git(repository, "switch", "-C", "feature", base);
    const rewrittenHead = commitFile(repository, "src.txt", "rewritten\n", "rewritten remote head");
    fake.pullRequest = { ...fake.pullRequest, headOid: rewrittenHead };
    git(repository, "reset", "--hard", firstHead);

    const synced = await service.syncPullRequest({ pullRequest: fake.pullRequest.url });

    expect(synced.pullRequest.latestHeadOid).toBe(rewrittenHead);
    expect(git(repository, "rev-parse", "HEAD")).toBe(firstHead);
  });

  it("reports live GitHub drift without mutating the cached PR snapshot", async () => {
    const { repository, fake, service } = setup("rvw-comment-live-");
    const opened = await service.openPullRequest(undefined, repository);
    const comment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: { kind: "pull-request" },
      body: "Check the current PR intent.",
    });
    fake.pullRequest = {
      ...fake.pullRequest,
      title: "Live title not synchronized yet",
      body: "Live body not synchronized yet.",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };

    await expect(service.getCommentReviewContext(comment.ref)).resolves.toMatchObject({
      pullRequest: { latestTitle: "Initial review" },
      githubState: { liveCheckedAt: null, staleAgainstGitHub: null, live: null },
    });
    const liveContext = await service.getCommentReviewContext(comment.ref, { live: true });
    expect(liveContext).toMatchObject({
      pullRequest: { latestTitle: "Initial review" },
      githubState: {
        staleAgainstGitHub: true,
        live: { title: "Live title not synchronized yet" },
      },
    });
    expect(typeof liveContext.githubState.liveCheckedAt).toBe("string");
    expect(service.getPullRequest(opened.pullRequest.id).latestTitle).toBe("Initial review");
  });

  it("allows file comments on binary and oversized files while rejecting line comments", async () => {
    const { repository, fake, service } = setup("rvw-unavailable-comments-");
    writeFileSync(path.join(repository, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(path.join(repository, "large.txt"), "x".repeat(1024 * 1024 + 1));
    git(repository, "add", "--", "binary.bin", "large.txt");
    git(repository, "commit", "-m", "add unavailable documents");
    const specialHead = git(repository, "rev-parse", "HEAD");
    fake.pullRequest = { ...fake.pullRequest, headOid: specialHead };
    const opened = await service.openPullRequest(undefined, repository);

    for (const [filePath, availability] of [
      ["binary.bin", "binary"],
      ["large.txt", "too-large"],
    ] as const) {
      const fileComment = await service.createComment({
        pullRequestId: opened.pullRequest.id,
        target: {
          kind: "document",
          documentKind: "repository-file",
          sourceOid: specialHead,
          path: filePath,
          startLine: null,
          endLine: null,
        },
        body: `${filePath} should be reviewed as a file.`,
      });
      await expect(service.placeCommentAtCommit(fileComment, specialHead)).resolves.toEqual({
        outdated: false,
        range: null,
        path: filePath,
      });
      await expect(service.getCommentReviewContext(fileComment.ref)).resolves.toMatchObject({
        exactSource: { availability, excerpt: null },
      });

      await expect(
        service.createComment({
          pullRequestId: opened.pullRequest.id,
          target: {
            kind: "document",
            documentKind: "repository-file",
            sourceOid: specialHead,
            path: filePath,
            startLine: 1,
            endLine: 1,
          },
          body: "A line comment must not be accepted.",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "表示できない文書には行コメントを作成できません。",
      });
    }
  });

  it("creates an Agent comment through a registered Pull Request reference", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-agent-comment-create-");
    await service.openPullRequest(undefined, repository);

    const comment = await service.createCommentForReference({
      pullRequest: fake.pullRequest.url,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: firstHead,
        path: "src.txt",
        startLine: 2,
        endLine: 2,
      },
      body: "Keep the second line observable to callers.",
      authorLabel: "Codex",
    });

    expect(comment.ref).toMatch(/^rvw:\/\/comment\//);
    expect(comment).toMatchObject({
      createdHeadOid: firstHead,
      resolvedAt: null,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: firstHead,
        path: "src.txt",
        startLine: 2,
        endLine: 2,
      },
      posts: [
        {
          body: "Keep the second line observable to callers.",
          authorLabel: "Codex",
          isRoot: true,
        },
      ],
    });
  });

  it("persists, validates, edits, and synchronizes post-level code references", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-comment-code-references-");
    const opened = await service.openPullRequest(undefined, repository);
    const sourceReference = {
      id: "source",
      label: "Source implementation",
      path: "src.txt",
      startLine: 1,
      endLine: 2,
      description: "The exact implementation discussed in this post",
    };

    const comment = await service.createCommentForReference({
      pullRequest: fake.pullRequest.url,
      target: { kind: "pull-request" },
      body: "Inspect [the source](rvw-ref:source).",
      relatedCommitOid: firstHead,
      references: [sourceReference],
      authorLabel: "Codex",
    });
    expect(comment.posts[0]).toMatchObject({
      relatedCommitOid: firstHead,
      references: [sourceReference],
    });
    expect(service.getCommentByUri(comment.ref).comment.posts[0]?.references).toEqual([
      sourceReference,
    ]);

    const reply = await service.replyToComment(comment.ref, {
      body: "The relevant range is still [the source](rvw-ref:source).",
      relatedCommitOid: firstHead,
      references: [{ ...sourceReference, label: "Reply source" }],
    });
    expect(reply).toMatchObject({
      relatedCommitOid: firstHead,
      references: [{ id: "source", label: "Reply source" }],
    });

    await expect(
      service.editCommentPost(comment.ref, reply.id, {
        body: "The whole file supplies the context: [source](rvw-ref:file).",
        references: [
          {
            id: "file",
            label: "Source file",
            path: "src.txt",
            startLine: null,
            endLine: null,
            description: null,
          },
        ],
      }),
    ).resolves.toMatchObject({
      relatedCommitOid: firstHead,
      references: [{ id: "file", startLine: null, endLine: null }],
    });
    await expect(
      service.updateCommentPost(comment.id, reply.id, "The reference was removed."),
    ).resolves.toMatchObject({ references: [] });

    await expect(
      service.replyToComment(comment.ref, {
        body: "Missing exact commit: [source](rvw-ref:source).",
        references: [sourceReference],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.replyToComment(comment.ref, {
        body: "This body does not use its declaration.",
        relatedCommitOid: firstHead,
        references: [sourceReference],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "code referenceが本文から参照されていません: source",
    });

    const secondHead = commitFile(repository, "src.txt", "first\nsecond\nthird\n", "extend source");
    fake.pullRequest = { ...fake.pullRequest, headOid: secondHead };
    await service.syncPullRequest({
      pullRequest: fake.pullRequest.url,
      commentUpdates: [
        {
          commentRef: comment.ref,
          reply: "The synchronized result is [here](rvw-ref:result).",
          resolve: false,
          references: [
            {
              id: "result",
              label: "Synchronized source",
              path: "src.txt",
              startLine: 3,
              endLine: 3,
              description: null,
            },
          ],
        },
      ],
    });
    expect(service.getCommentByUri(comment.ref).comment.posts.at(-1)).toMatchObject({
      relatedCommitOid: secondHead,
      references: [{ id: "result", startLine: 3, endLine: 3 }],
    });
    await expect(service.getResetPreview(opened.pullRequest.id)).resolves.toMatchObject({
      counts: { commentReferences: 2 },
    });
  });

  it("enforces the shared author label limit at the application boundary", async () => {
    const { repository, service } = setup("rvw-author-label-");
    const opened = await service.openPullRequest(undefined, repository);

    await expect(
      service.createComment({
        pullRequestId: opened.pullRequest.id,
        target: { kind: "pull-request" },
        body: "Review note",
        authorLabel: "x".repeat(101),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("returns Agent-ready comment context and keeps resolved replies resolved", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-comment-context-");
    const opened = await service.openPullRequest(undefined, repository);
    const codeComment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: firstHead,
        path: "src.txt",
        startLine: 2,
        endLine: 2,
      },
      body: "Keep the second line.",
    });
    const unresolvedComment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: { kind: "pull-request" },
      body: "Explain the overall intent.",
    });

    const secondHead = commitFile(
      repository,
      "src.txt",
      "inserted\nfirst\nsecond\n",
      "insert context",
    );
    fake.pullRequest = {
      ...fake.pullRequest,
      title: "Agent-ready review",
      body: "The latest intent is available to comment readers.",
      headOid: secondHead,
    };
    await service.refreshPullRequest(opened.pullRequest.id);

    service.setCommentResolved(codeComment.ref, true);
    await service.replyToComment(codeComment.ref, {
      body: "A follow-up on the resolved thread.",
      authorLabel: "Codex",
    });

    const context = await service.getCommentReviewContext(codeComment.ref);
    expect(context.pullRequest).toMatchObject({
      latestTitle: "Agent-ready review",
      latestBody: "The latest intent is available to comment readers.",
      latestBaseRefName: "main",
      latestHeadRefName: "feature",
    });
    expect(context.latestPlacement).toEqual({
      outdated: false,
      range: { startLine: 3, endLine: 3 },
      path: "src.txt",
    });
    expect(context.exactSource).toMatchObject({
      sourceOid: firstHead,
      path: "src.txt",
      availability: "available",
      excerpt: {
        startLine: 1,
        endLine: 3,
        text: "first\nsecond\n",
        truncatedBefore: false,
        truncatedAfter: false,
      },
    });
    expect(context.comment.resolvedAt).not.toBeNull();
    expect(context.comment.posts.at(-1)).toMatchObject({ authorLabel: "Codex" });

    const changedHead = commitFile(
      repository,
      "src.txt",
      "inserted\nfirst\nchanged\n",
      "change reviewed line",
    );
    fake.pullRequest = { ...fake.pullRequest, headOid: changedHead };
    await service.refreshPullRequest(opened.pullRequest.id);
    await expect(service.getCommentReviewContext(codeComment.ref)).resolves.toMatchObject({
      latestPlacement: { outdated: true, range: null, path: "src.txt" },
      exactSource: { sourceOid: firstHead, excerpt: { text: "first\nsecond\n" } },
    });

    const unresolved = await service.listCommentReviewContexts(opened.pullRequest.url, false, {
      limit: 1,
      offset: 0,
    });
    expect(unresolved.comments.map(({ comment }) => comment.ref)).toEqual([unresolvedComment.ref]);
    expect(unresolved.comments[0]?.latestPlacement).toEqual({
      outdated: false,
      range: null,
      path: null,
    });
    expect(unresolved.comments[0]).toMatchObject({
      rootPost: { body: "Explain the overall intent.", isRoot: true },
      postCount: 1,
    });
    expect(unresolved.comments[0]?.comment).not.toHaveProperty("posts");
    expect(unresolved.page).toEqual({
      offset: 0,
      limit: 1,
      returned: 1,
      total: 1,
      hasMore: false,
      nextOffset: null,
    });
    await expect(service.listCommentReviewContexts(opened.pullRequest.url)).resolves.toMatchObject({
      comments: [
        { comment: { ref: codeComment.ref } },
        { comment: { ref: unresolvedComment.ref } },
      ],
      page: { offset: 0, limit: 50, returned: 2, total: 2, hasMore: false, nextOffset: null },
    });

    const firstPage = await service.listCommentReviewContexts(opened.pullRequest.url, undefined, {
      limit: 1,
      offset: 0,
    });
    expect(firstPage.page).toEqual({
      offset: 0,
      limit: 1,
      returned: 1,
      total: 2,
      hasMore: true,
      nextOffset: 1,
    });
    const secondPage = await service.listCommentReviewContexts(opened.pullRequest.url, undefined, {
      limit: 1,
      offset: firstPage.page.nextOffset ?? 0,
    });
    expect(secondPage.comments.map(({ comment }) => comment.ref)).toEqual([unresolvedComment.ref]);
    expect(secondPage.page.hasMore).toBe(false);
  });

  it("publishes and replaces commit-fixed walkthroughs in place while preserving whole-document comments", async () => {
    const { repository, firstHead, service } = setup("rvw-walkthrough-");
    const opened = await service.openPullRequest(undefined, repository);
    const repositoryAsset = await service.getRepositoryAsset(
      opened.pullRequest.id,
      firstHead,
      "src.txt",
    );
    expect(repositoryAsset.content.toString("utf8")).toBe("first\nsecond\n");

    const { walkthrough } = await service.publishWalkthrough({
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "Source flow",
      body: [
        "Start at [the source](rvw-ref:source). `rvw-ref:ignored`",
        "",
        "```mermaid",
        "flowchart TD",
        "  Source[Source]",
        "```",
      ].join("\n"),
      authorLabel: "Codex",
      diagramBindings: { Source: "source" },
      references: [
        {
          id: "source",
          label: "source entry",
          path: "src.txt",
          startLine: 1,
          endLine: 2,
          description: "The exact committed implementation",
        },
      ],
    });

    expect(walkthrough).toMatchObject({
      ref: `rvw://walkthrough/${walkthrough.id}`,
      pullRequestId: opened.pullRequest.id,
      sourceOid: firstHead,
      diagramBindings: { Source: "source" },
      references: [{ id: "source", startLine: 1, endLine: 2 }],
    });
    expect(service.listWalkthroughs(opened.pullRequest.id)).toEqual([
      {
        id: walkthrough.id,
        pullRequestId: opened.pullRequest.id,
        sourceOid: firstHead,
        title: "Source flow",
        authorLabel: "Codex",
        referenceCount: 1,
        createdAt: walkthrough.createdAt,
      },
    ]);
    expect(service.getWalkthrough(opened.pullRequest.id, walkthrough.id)).toEqual(walkthrough);
    const walkthroughComment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: { kind: "walkthrough", walkthroughId: walkthrough.id },
      body: "Explain why the outbox belongs here.",
      authorLabel: "You",
    });
    expect(walkthroughComment.target).toEqual({
      kind: "walkthrough",
      walkthroughId: walkthrough.id,
      walkthroughTitle: "Source flow",
      sourceDocumentHash: null,
      quotedText: null,
      startLine: null,
      endLine: null,
    });
    await expect(service.placeCommentAtCommit(walkthroughComment, firstHead)).resolves.toEqual({
      outdated: false,
      range: null,
      path: null,
    });
    const lineComment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: {
        kind: "walkthrough",
        walkthroughId: walkthrough.id,
        startLine: 1,
        endLine: 1,
      },
      body: "Keep this explanation attached to its line.",
      authorLabel: "You",
    });
    expect(lineComment.target).toMatchObject({
      kind: "walkthrough",
      walkthroughId: walkthrough.id,
      quotedText: "Start at [the source](rvw-ref:source). `rvw-ref:ignored`",
      startLine: 1,
      endLine: 1,
    });
    await service.updateWalkthrough(walkthrough.ref, {
      sourceOid: firstHead,
      title: "Source flow moved",
      body: [
        "New context",
        "Start at [the source](rvw-ref:source). `rvw-ref:ignored`",
        "",
        "```mermaid",
        "flowchart TD",
        "  Source[Source]",
        "```",
      ].join("\n"),
      diagramBindings: { Source: "source" },
      references: walkthrough.references,
    });
    await expect(service.placeCommentAtCommit(lineComment, firstHead)).resolves.toEqual({
      outdated: false,
      range: { startLine: 2, endLine: 2 },
      path: null,
    });
    const { walkthrough: updatedWalkthrough } = await service.updateWalkthrough(walkthrough.ref, {
      sourceOid: firstHead,
      title: "Source flow explained",
      body: [
        "The updated explanation covers [the source file](rvw-ref:source_file).",
        "",
        "```mermaid",
        "flowchart TD",
        "  Entry[Entry]",
        "```",
      ].join("\n"),
      diagramBindings: { Entry: "source_file" },
      references: [
        {
          id: "source_file",
          label: "source file",
          path: "src.txt",
          startLine: null,
          endLine: null,
          description: "Updated after reviewer feedback",
        },
      ],
    });
    expect(updatedWalkthrough).toMatchObject({
      id: walkthrough.id,
      ref: walkthrough.ref,
      title: "Source flow explained",
      authorLabel: "Codex",
      createdAt: walkthrough.createdAt,
      diagramBindings: { Entry: "source_file" },
      references: [{ id: "source_file", startLine: null, endLine: null }],
    });
    expect(service.listWalkthroughs(opened.pullRequest.id)).toHaveLength(1);
    expect(service.getCommentByUri(walkthroughComment.ref).comment.target).toEqual({
      kind: "walkthrough",
      walkthroughId: walkthrough.id,
      walkthroughTitle: "Source flow explained",
      sourceDocumentHash: null,
      quotedText: null,
      startLine: null,
      endLine: null,
    });
    await expect(service.placeCommentAtCommit(lineComment, firstHead)).resolves.toEqual({
      outdated: true,
      range: null,
      path: null,
    });
    expect(service.getWalkthroughByUri(walkthrough.ref).walkthrough.body).toContain(
      "updated explanation",
    );
    expect((await service.getResetPreview(opened.pullRequest.id)).counts).toMatchObject({
      comments: 2,
      walkthroughs: 1,
      walkthroughReferences: 1,
    });

    await expect(
      service.publishWalkthrough({
        pullRequest: opened.pullRequest.url,
        sourceOid: firstHead,
        title: "Broken reference",
        body: "[Missing](rvw-ref:missing)",
        references: [
          {
            id: "source",
            label: "source entry",
            path: "src.txt",
            startLine: 1,
            endLine: 1,
            description: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    for (const body of ["[Bad](rvw-ref:1bad)", "[Suffix](rvw-ref:source.extra)"]) {
      await expect(
        service.publishWalkthrough({
          pullRequest: opened.pullRequest.url,
          sourceOid: firstHead,
          title: "Malformed reference",
          body,
          references: [
            {
              id: "source",
              label: "source entry",
              path: "src.txt",
              startLine: 1,
              endLine: 1,
              description: null,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }

    await resetPullRequest(service, opened.pullRequest.id);
    expect(service.listWalkthroughs(opened.pullRequest.id)).toEqual([]);
    expect(service.listComments(opened.pullRequest.id)).toEqual([]);
  });

  it("keeps Pull Request Walkthrough publish and update JSON shapes equal across direct and Agent socket transports", async () => {
    const { repository, firstHead, fake, database, service } = setup(
      "rvw-pr-walkthrough-transport-",
    );
    fake.issues.set(142, githubIssue(142));
    fake.issues.set(143, githubIssue(143));
    const opened = await service.openPullRequest(undefined, repository);
    const content = {
      sourceOid: firstHead,
      title: "Direct transport",
      body: "Read [the source](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "Source",
          path: "src.txt",
          startLine: 1,
          endLine: 1,
          description: null,
        },
      ],
    };
    const directPublish = await service.publishWalkthrough({
      review: { kind: "pull-request", pullRequest: opened.pullRequest.url },
      ...content,
      issuesToAdd: ["#142"],
    });
    const directUpdate = await service.updateWalkthrough(directPublish.walkthrough.ref, {
      ...content,
      title: "Direct update",
      issuesToAdd: ["#142"],
    });
    expect(JSON.parse(JSON.stringify(directPublish))).toMatchObject({
      walkthrough: { ref: directPublish.walkthrough.ref },
      issuesAdded: [{ number: 142 }],
    });
    expect(JSON.parse(JSON.stringify(directUpdate))).toMatchObject({
      walkthrough: { ref: directPublish.walkthrough.ref },
      issuesAdded: [],
    });

    const socketDirectory = mkdtempSync(path.join(os.tmpdir(), "rvw-pr-agent-socket-"));
    const previousSocketPath = process.env.RVW_AGENT_SOCKET_PATH;
    process.env.RVW_AGENT_SOCKET_PATH = path.join(socketDirectory, "agent.sock");
    let running: Awaited<ReturnType<typeof startAgentSocket>>;
    try {
      running = await startAgentSocket(service);
    } catch (error) {
      if (previousSocketPath === undefined) delete process.env.RVW_AGENT_SOCKET_PATH;
      else process.env.RVW_AGENT_SOCKET_PATH = previousSocketPath;
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    try {
      const socketPublishResponse = await tryAgentSocketRequest(
        "walkthrough.publish",
        {
          review: { kind: "pull-request", pullRequest: opened.pullRequest.url },
          ...content,
          title: "Socket transport",
          issuesToAdd: ["#143"],
        },
        { expectedDatabasePath: database.filePath },
      );
      if (!socketPublishResponse.available) throw new Error(socketPublishResponse.reason);
      const socketPublish = socketPublishResponse.result as typeof directPublish;
      const socketUpdateResponse = await tryAgentSocketRequest(
        "walkthrough.update",
        {
          uri: socketPublish.walkthrough.ref,
          content: { ...content, title: "Socket update", issuesToAdd: ["#143"] },
        },
        { expectedDatabasePath: database.filePath },
      );
      if (!socketUpdateResponse.available) throw new Error(socketUpdateResponse.reason);
      const socketUpdate = socketUpdateResponse.result as typeof directUpdate;

      expect(JSON.parse(JSON.stringify(socketPublish))).toMatchObject({
        walkthrough: { ref: socketPublish.walkthrough.ref },
        issuesAdded: [{ number: 143 }],
      });
      expect(JSON.parse(JSON.stringify(socketUpdate))).toMatchObject({
        walkthrough: { ref: socketPublish.walkthrough.ref },
        issuesAdded: [],
      });
      expect(jsonShape(JSON.parse(JSON.stringify(socketPublish)))).toEqual(
        jsonShape(JSON.parse(JSON.stringify(directPublish))),
      );
      expect(jsonShape(JSON.parse(JSON.stringify(socketUpdate)))).toEqual(
        jsonShape(JSON.parse(JSON.stringify(directUpdate))),
      );
    } finally {
      await running.close();
      if (previousSocketPath === undefined) delete process.env.RVW_AGENT_SOCKET_PATH;
      else process.env.RVW_AGENT_SOCKET_PATH = previousSocketPath;
    }
  });

  it("reports a concurrently requested Pull Request Issue in exactly one Walkthrough mutation", async () => {
    const gitClient = new PullRequestRetainBarrierGitClient();
    const { repository, firstHead, fake, service } = setup(
      "rvw-pr-walkthrough-concurrency-",
      gitClient,
    );
    fake.issues.set(142, githubIssue(142));
    const opened = await service.openPullRequest(undefined, repository);
    const content = {
      review: { kind: "pull-request" as const, pullRequest: opened.pullRequest.url },
      sourceOid: firstHead,
      body: "Read [the source](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "Source",
          path: "src.txt",
          startLine: 1,
          endLine: 1,
          description: null,
        },
      ],
      issuesToAdd: ["#142"],
    };
    gitClient.armRetainBarrier();

    const results = await Promise.all([
      service.publishWalkthrough({ ...content, title: "Concurrent A" }),
      service.publishWalkthrough({ ...content, title: "Concurrent B" }),
    ]);

    expect(results.map((result) => result.issuesAdded.map((issue) => issue.number)).sort()).toEqual(
      [[], [142]],
    );
  });

  it("rejects walkthrough references that no Markdown link or Mermaid binding uses", async () => {
    const { repository, firstHead, service } = setup("rvw-walkthrough-unused-reference-");
    const opened = await service.openPullRequest(undefined, repository);
    const body = [
      "Open [the source](rvw-ref:source).",
      "",
      "```mermaid",
      "flowchart TD",
      "  Diagram[Diagram]",
      "```",
    ].join("\n");
    const references = [
      {
        id: "source",
        label: "source entry",
        path: "src.txt",
        startLine: 1,
        endLine: 1,
        description: null,
      },
      {
        id: "diagram",
        label: "diagram detail",
        path: "src.txt",
        startLine: 2,
        endLine: 2,
        description: null,
      },
    ];
    const { walkthrough } = await service.publishWalkthrough({
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "Reachable references",
      body,
      diagramBindings: { Diagram: "diagram" },
      references,
    });

    await expect(
      service.publishWalkthrough({
        pullRequest: opened.pullRequest.url,
        sourceOid: firstHead,
        title: "Phantom diagram binding",
        body: [
          "Open [the source](rvw-ref:source).",
          "",
          "```mermaid",
          "flowchart TD",
          "  Actual[Diagram]",
          "```",
        ].join("\n"),
        diagramBindings: { Diagram: "diagram" },
        references,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Mermaid nodeが本文のflowchartまたはclassDiagramに見つかりません: Diagram",
    });

    await expect(
      service.publishWalkthrough({
        pullRequest: opened.pullRequest.url,
        sourceOid: firstHead,
        title: "Bare diagram endpoints",
        body: [
          "Open [the source](rvw-ref:source).",
          "",
          "```mermaid",
          "flowchart TD",
          "  Left --> Right",
          "```",
        ].join("\n"),
        diagramBindings: { Right: "diagram" },
        references,
      }),
    ).resolves.toMatchObject({ walkthrough: { diagramBindings: { Right: "diagram" } } });

    await expect(
      service.publishWalkthrough({
        pullRequest: opened.pullRequest.url,
        sourceOid: firstHead,
        title: "Class diagram binding",
        body: [
          "Open [the source](rvw-ref:source).",
          "",
          "```mermaid",
          "classDiagram",
          "  class Actual",
          "```",
        ].join("\n"),
        diagramBindings: { Actual: "diagram" },
        references,
      }),
    ).resolves.toMatchObject({ walkthrough: { diagramBindings: { Actual: "diagram" } } });

    await expect(
      service.updateWalkthrough(walkthrough.ref, {
        sourceOid: firstHead,
        title: "Missing diagram binding",
        body,
        references,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "code referenceが本文またはbindingから参照されていません: diagram",
    });

    await expect(
      service.publishWalkthrough({
        pullRequest: opened.pullRequest.url,
        sourceOid: firstHead,
        title: "Unused reference",
        body: "Open [the source](rvw-ref:source).",
        references: [
          {
            id: "source",
            label: "source entry",
            path: "src.txt",
            startLine: 1,
            endLine: 1,
            description: null,
          },
          {
            id: "unused",
            label: "unused detail",
            path: "src.txt",
            startLine: null,
            endLine: null,
            description: null,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "code referenceが本文またはbindingから参照されていません: unused",
    });
  });

  it("deletes a walkthrough and its comments without deleting retained commit refs", async () => {
    const { repository, firstHead, service } = setup("rvw-walkthrough-delete-");
    const opened = await service.openPullRequest(undefined, repository);
    const { walkthrough } = await service.publishWalkthrough({
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "Temporary explanation",
      body: "Open [the source](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "source entry",
          path: "src.txt",
          startLine: 1,
          endLine: 1,
          description: null,
        },
      ],
    });
    const comment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: { kind: "walkthrough", walkthroughId: walkthrough.id },
      body: "This is no longer needed.",
    });
    await service.replyToComment(comment.ref, { body: "Confirmed." });

    expect(service.getWalkthroughDeletePreview(walkthrough.ref)).toMatchObject({
      walkthrough: { id: walkthrough.id },
      counts: { comments: 1, posts: 2, references: 1 },
      confirmationRequired: true,
    });
    expect(deleteWalkthrough(service, walkthrough.ref)).toEqual({
      id: walkthrough.id,
      ref: walkthrough.ref,
      pullRequestId: opened.pullRequest.id,
      counts: { comments: 1, posts: 2, references: 1 },
    });
    expect(service.listWalkthroughs(opened.pullRequest.id)).toEqual([]);
    expect(service.listComments(opened.pullRequest.id)).toEqual([]);
    expect(() => service.getWalkthroughByUri(walkthrough.ref)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    await expect(service.git.verifyCommitRef(repository, 7, firstHead)).resolves.toBe(true);
  });

  it("removes a newly-created commit ref when walkthrough persistence fails", async () => {
    const { repository, firstHead, database, service } = setup("rvw-walkthrough-rollback-");
    const opened = await service.openPullRequest(undefined, repository);
    const secondHead = commitFile(repository, "src.txt", "first\nsecond\nthird\n", "second change");
    vi.spyOn(database, "createWalkthrough").mockImplementationOnce(() => {
      throw new Error("database write failed");
    });

    await expect(
      service.publishWalkthrough({
        pullRequest: opened.pullRequest.url,
        sourceOid: secondHead,
        title: "Will fail",
        body: "[Source](rvw-ref:source)",
        references: [
          {
            id: "source",
            label: "source entry",
            path: "src.txt",
            startLine: 1,
            endLine: 1,
            description: null,
          },
        ],
      }),
    ).rejects.toThrow("database write failed");
    await expect(service.git.verifyCommitRef(repository, 7, secondHead)).resolves.toBe(false);
    await expect(service.git.verifyCommitRef(repository, 7, firstHead)).resolves.toBe(true);
  });

  it("accepts a force-pushed head while retaining the old commit ref", async () => {
    const { repository, base, firstHead, fake, service } = setup("rvw-force-push-");
    const opened = await service.openPullRequest(undefined, repository);
    const comment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: firstHead,
        path: "src.txt",
        startLine: 1,
        endLine: 1,
      },
      body: "Old history comment",
    });

    git(repository, "switch", "-C", "feature", base);
    const rewrittenHead = commitFile(repository, "src.txt", "rewritten\n", "rewritten change");
    fake.pullRequest = { ...fake.pullRequest, headOid: rewrittenHead };

    const refreshed = await service.refreshPullRequest(opened.pullRequest.id);
    expect(refreshed.commits).toMatchObject([{ oid: rewrittenHead, subject: "rewritten change" }]);
    const client = new GitClient();
    expect(await client.verifyCommitRef(repository, 7, firstHead)).toBe(true);
    expect(await client.verifyCommitRef(repository, 7, rewrittenHead)).toBe(true);
    expect(
      await service.placeCommentAtCommit(service.getCommentByUri(comment.ref).comment, firstHead),
    ).toEqual({ outdated: false, range: { startLine: 1, endLine: 1 }, path: "src.txt" });
  });

  it("searches the destination tree and latest PR markdown with explicit options", async () => {
    const { repository, firstHead, service } = setup("rvw-search-");
    const opened = await service.openPullRequest(undefined, repository);

    const insensitive = await service.search(opened.pullRequest.id, firstHead, "REVIEW", {
      matchCase: false,
      wholeWord: true,
    });
    expect(insensitive.results).toMatchObject([
      { path: "Pull Request.md", line: 1, matches: [{ start: 10, end: 16 }] },
      { path: "Pull Request.md", line: 3, matches: [{ start: 7, end: 13 }] },
    ]);
    expect(insensitive.matchCount).toBe(2);

    const sensitive = await service.search(opened.pullRequest.id, firstHead, "REVIEW", {
      matchCase: true,
      wholeWord: false,
    });
    expect(sensitive.results).toEqual([]);
    expect(sensitive.matchCount).toBe(0);
  });

  it("edits posts, deletes individual replies, and cascades thread deletion to replies", async () => {
    const { repository, firstHead, service } = setup("rvw-comment-delete-");
    const opened = await service.openPullRequest(undefined, repository);
    const deletable = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: { kind: "pull-request" },
      body: "Temporary comment",
      authorLabel: "You",
    });

    expect(service.deleteComment(deletable.ref)).toEqual({
      id: deletable.id,
      ref: deletable.ref,
    });
    expect(service.listComments(opened.pullRequest.id)).toHaveLength(0);

    const replied = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: firstHead,
        path: "src.txt",
        startLine: 1,
        endLine: 1,
      },
      body: "Keep this thread",
    });
    const reply = await service.replyToComment(replied.id, { body: "A reply" });

    await expect(
      service.updateCommentPost(replied.id, replied.posts[0]!.id, "Updated root"),
    ).resolves.toMatchObject({ body: "Updated root" });
    await expect(
      service.updateCommentPost(replied.id, reply.id, "Updated reply"),
    ).resolves.toMatchObject({
      body: "Updated reply",
    });
    await expect(
      service.editCommentPost(replied.ref, reply.id, {
        body: "✅ Addressed",
        relatedCommitOid: firstHead,
      }),
    ).resolves.toMatchObject({ body: "✅ Addressed", relatedCommitOid: firstHead });
    await expect(
      service.editCommentPost(replied.ref, reply.id, { body: "✅ Addressed again" }),
    ).resolves.toMatchObject({ body: "✅ Addressed again", relatedCommitOid: firstHead });
    await expect(
      service.editCommentPost(replied.ref, reply.id, {
        body: "🔎 Checking again",
        relatedCommitOid: null,
      }),
    ).resolves.toMatchObject({ body: "🔎 Checking again", relatedCommitOid: null });
    await expect(
      service.editCommentPost(replied.ref, reply.id, {
        body: "Invalid commit",
        relatedCommitOid: "f".repeat(40),
      }),
    ).rejects.toBeDefined();
    const disposableReply = await service.replyToComment(replied.id, {
      body: "Disposable reply",
    });

    expect(() => service.deleteReply(replied.id, replied.posts[0]!.id)).toThrowError(
      expect.objectContaining({ code: "COMMENT_DELETE_NOT_ALLOWED" }),
    );

    expect(service.deleteReply(replied.id, disposableReply.id)).toEqual({
      commentId: replied.id,
      postId: disposableReply.id,
    });
    expect(service.database.listCommentPosts(replied.id)).toHaveLength(2);
    expect(service.deleteComment(replied.id)).toEqual({
      id: replied.id,
      ref: replied.ref,
    });
    expect(service.database.listCommentPosts(replied.id)).toHaveLength(0);
    expect(service.listComments(opened.pullRequest.id)).toHaveLength(0);
  });

  it("anchors a new watch at current state and replays later posts from its cursor", async () => {
    const { repository, service } = setup("rvw-comment-watch-");
    const opened = await service.openPullRequest(undefined, repository);
    const comment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: { kind: "pull-request" },
      body: "Existing at startup",
    });

    const anchored = service.listCommentPostEvents();
    expect(anchored).toMatchObject({ anchoredAtCurrent: true, events: [] });
    expect(() =>
      service.listCommentPostEvents(
        formatCommentWatchCursor({ databaseId: anchored.databaseId, sequence: 999 }),
      ),
    ).toThrow("最新eventより先");

    const reply = await service.replyToComment(comment.ref, {
      body: "Created after startup",
      authorLabel: "You",
      idempotencyKey: "watch-task:comment-1",
    });
    const replayed = service.listCommentPostEvents(anchored.cursor);
    expect(replayed).toMatchObject({
      anchoredAtCurrent: false,
      hasMore: false,
      events: [
        {
          event: {
            commentRef: comment.ref,
            postId: reply.id,
            context: {
              kind: "pull-request",
              pullRequestId: opened.pullRequest.id,
              pullRequestUrl: opened.pullRequest.url,
            },
            deleted: false,
          },
        },
      ],
    });

    const retried = await service.replyToComment(comment.ref, {
      body: "Created after startup",
      authorLabel: "You",
      idempotencyKey: "watch-task:comment-1",
    });
    expect(retried.id).toBe(reply.id);
    expect(service.listCommentPostEvents(replayed.cursor).events).toEqual([]);

    service.deleteReply(comment.id, reply.id);
    expect(service.listCommentPostEvents(anchored.cursor).events).toMatchObject([
      { event: { postId: reply.id, deleted: true } },
    ]);
    await expect(
      service.replyToComment(comment.ref, {
        body: "Created after startup",
        authorLabel: "You",
        idempotencyKey: "watch-task:comment-1",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_RESULT_DELETED" });
  });

  it("reuses durable 0.2.x PR reply idempotency hashes after migration", async () => {
    const repository = createGitRepository("rvw-pr-idempotency-migration-");
    const base = git(repository, "rev-parse", "HEAD");
    git(repository, "switch", "-c", "feature");
    const firstHead = commitFile(repository, "src.txt", "migration\n", "migration fixture");
    const fake = new FakeGitHub(openPr(base, firstHead));
    const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), "rvw-pr-legacy-ledger-"));
    const legacyMigrationsDirectory = path.join(fixtureDirectory, "migrations");
    mkdirSync(legacyMigrationsDirectory);
    const migrationFiles = [
      "001_initial.sql",
      "002_commit_model.sql",
      "003_editable_comment_posts.sql",
      "004_walkthroughs.sql",
      "005_walkthrough_comments.sql",
      "006_theme_preference.sql",
      "007_file_level_walkthrough_references.sql",
      "008_walkthrough_line_comments.sql",
      "009_comment_watch.sql",
      "010_comment_post_references.sql",
    ];
    for (const filename of migrationFiles) {
      writeFileSync(
        path.join(legacyMigrationsDirectory, filename),
        readFileSync(path.join("migrations", filename)),
      );
    }
    const dbFile = path.join(fixtureDirectory, "rvw.db");
    const legacyDatabase = new RvwDatabase({
      filePath: dbFile,
      migrationsDirectory: legacyMigrationsDirectory,
    });
    const repositoryContext = await new GitClient().repositoryContext(repository);
    const pullRequest = legacyDatabase.upsertPullRequest(
      fake.pullRequest,
      {
        localRepositoryPath: repositoryContext.worktreePath,
        gitCommonDir: repositoryContext.gitCommonDir,
      },
      base,
    );
    legacyDatabase.close();

    const directCommentId = "11111111-1111-4111-8111-111111111111";
    const syncCommentId = "22222222-2222-4222-8222-222222222222";
    const directReplyId = "33333333-3333-4333-8333-333333333333";
    const syncReplyId = "44444444-4444-4444-8444-444444444444";
    const directBody = "Durable direct reply";
    const syncBody = "Durable sync reply";
    const directKey = "released-0.2.x-direct-key";
    const syncKey = "released-0.2.x-sync-key";
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    const now = "2026-08-20T00:00:00.000Z";
    const raw = new DatabaseSync(dbFile);
    const insertComment = raw.prepare(
      `INSERT INTO comments(
        id, pull_request_id, created_head_oid, resolved_at, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?)`,
    );
    const insertPost = raw.prepare(
      `INSERT INTO comment_posts(
        id, comment_id, body, related_commit_oid, author_label, is_root, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const legacyComments: Array<[string, string, string]> = [
      [directCommentId, "55555555-5555-4555-8555-555555555555", "Direct retry target"],
      [syncCommentId, "66666666-6666-4666-8666-666666666666", "Sync retry target"],
    ];
    for (const [commentId, rootId, rootBody] of legacyComments) {
      insertComment.run(commentId, pullRequest.id, firstHead, now, now);
      raw
        .prepare("INSERT INTO comment_targets(comment_id, target_kind) VALUES (?, ?)")
        .run(commentId, "pull_request");
      insertPost.run(rootId, commentId, rootBody, null, null, 1, now, now);
    }
    insertPost.run(directReplyId, directCommentId, directBody, null, null, 0, now, now);
    insertPost.run(syncReplyId, syncCommentId, syncBody, firstHead, "Codex", 0, now, now);
    const insertEvent = raw.prepare(
      `INSERT INTO comment_post_events(post_id, comment_ref, pull_request_url, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    insertEvent.run(directReplyId, `rvw://comment/${directCommentId}`, pullRequest.url, now);
    insertEvent.run(syncReplyId, `rvw://comment/${syncCommentId}`, pullRequest.url, now);
    const insertLedger = raw.prepare(
      "INSERT INTO comment_reply_idempotency(key_hash, request_hash, post_id, created_at) VALUES (?, ?, ?, ?)",
    );
    insertLedger.run(
      sha256(directKey),
      sha256(
        JSON.stringify({
          operation: "comment.reply",
          commentId: directCommentId,
          body: directBody,
          relatedCommitOid: null,
          authorLabel: null,
          references: [],
        }),
      ),
      directReplyId,
      now,
    );
    insertLedger.run(
      sha256(syncKey),
      sha256(
        JSON.stringify({
          operation: "pr.sync.comment-update",
          commentId: syncCommentId,
          reply: syncBody,
          resolve: false,
          authorLabel: "Codex",
          references: [],
        }),
      ),
      syncReplyId,
      now,
    );
    raw.close();

    const database = new RvwDatabase({ filePath: dbFile, migrationsDirectory: "./migrations" });
    databases.push(database);
    const service = new RvwService(database, new GitClient(), fake);
    const eventSequence = database.getLatestCommentPostEventSequence();

    await expect(
      service.replyToComment(`rvw://comment/${directCommentId}`, {
        body: directBody,
        idempotencyKey: directKey,
      }),
    ).resolves.toMatchObject({ id: directReplyId });
    const synced = await service.syncPullRequest({
      pullRequest: fake.pullRequest.url,
      commentUpdates: [
        {
          commentRef: `rvw://comment/${syncCommentId}`,
          reply: syncBody,
          resolve: false,
          authorLabel: "Codex",
          idempotencyKey: syncKey,
        },
      ],
    });

    expect(synced.commentUpdatesApplied).toBe(1);
    expect(database.listCommentPosts(directCommentId)).toHaveLength(2);
    expect(database.listCommentPosts(syncCommentId)).toHaveLength(2);
    expect(database.listCommentPosts(syncCommentId)[1]).toMatchObject({ id: syncReplyId });
    expect(database.getLatestCommentPostEventSequence()).toBe(eventSequence);
  });

  it("keeps only latest PR markdown and repositions a unique quoted selection", async () => {
    const { repository, fake, service } = setup("rvw-pr-markdown-");
    const opened = await service.openPullRequest(undefined, repository);
    const comment = await service.createComment({
      pullRequestId: opened.pullRequest.id,
      target: {
        kind: "document",
        documentKind: "pull-request-markdown",
        startLine: 3,
        endLine: 3,
      },
      body: "Keep this requirement.",
    });
    expect(comment.target).toMatchObject({
      documentKind: "pull-request-markdown",
      quotedText: "Please review.",
    });

    fake.pullRequest = {
      ...fake.pullRequest,
      title: "Renamed review",
      body: "New introduction.\nPlease review.",
      updatedAt: "2026-08-08T03:00:00.000Z",
    };
    await service.refreshPullRequest(opened.pullRequest.id);
    expect(
      (
        await service.getDocument({
          kind: "pull-request-markdown",
          pullRequestId: opened.pullRequest.id,
        })
      ).text,
    ).toBe("# Renamed review\n\nNew introduction.\nPlease review.");
    expect(
      await service.placeComment(comment, {
        kind: "pull-request-markdown",
        pullRequestId: opened.pullRequest.id,
      }),
    ).toEqual({ outdated: false, range: { startLine: 4, endLine: 4 }, path: "Pull Request.md" });
  });
});
