import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RvwService } from "../../src/application/rvw-service.js";
import { formatCommentWatchCursor } from "../../src/domain/comment-watch-cursor.js";
import type { GitHubPullRequest, Structure } from "../../src/domain/models.js";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import type { GitHubPort } from "../../src/infrastructure/github/github-client.js";
import { commitFile, createGitRepository, git } from "../fixtures/git-repository.js";

class FakeGitHub implements GitHubPort {
  constructor(public pullRequest: GitHubPullRequest) {}

  doctor() {
    return Promise.resolve({ version: "gh fake", authenticated: true });
  }

  getPullRequestStatuses(references: readonly string[]) {
    return Promise.resolve(
      references.map(() => ({
        status: "fulfilled" as const,
        value: {
          state: this.pullRequest.state,
          isDraft: this.pullRequest.isDraft,
        },
      })),
    );
  }

  getPullRequest(_reference?: string, _cwd?: string, options: { allowClosed?: boolean } = {}) {
    if (this.pullRequest.state !== "OPEN" && !options.allowClosed) {
      return Promise.reject(new Error("Pull Request is not open"));
    }
    return Promise.resolve(this.pullRequest);
  }

  getAttachment() {
    return Promise.reject(new Error("not used"));
  }
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
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  state: "OPEN",
  isDraft: false,
});

describe("RvwService commit workflow", () => {
  const databases: RvwDatabase[] = [];
  afterEach(() => {
    while (databases.length) databases.pop()?.close();
  });

  function setup(prefix = "rvw-commit-") {
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
      service: new RvwService(database, new GitClient(), fake),
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

  it("refreshes the Open status working set and preserves content on partial failure", async () => {
    const { repository, base, firstHead, fake, database, service } = setup();
    const opened = await service.openPullRequest(undefined, repository);
    const secondGithub: GitHubPullRequest = {
      ...fake.pullRequest,
      number: 8,
      url: "https://github.com/acme/review-repo/pull/8",
      title: "Second cached title",
      headOid: firstHead,
      isDraft: true,
    };
    const second = database.upsertPullRequest(
      secondGithub,
      {
        localRepositoryPath: opened.pullRequest.localRepositoryPath,
        gitCommonDir: opened.pullRequest.gitCommonDir,
      },
      base,
    );
    const closed = database.upsertPullRequest(
      {
        ...secondGithub,
        owner: "closed",
        number: 9,
        url: "https://github.com/closed/review-repo/pull/9",
        title: "Closed cached title",
        state: "CLOSED",
        isDraft: false,
      },
      {
        localRepositoryPath: opened.pullRequest.localRepositoryPath,
        gitCommonDir: opened.pullRequest.gitCommonDir,
      },
      base,
    );
    const merged = database.upsertPullRequest(
      {
        ...secondGithub,
        owner: "merged",
        number: 10,
        url: "https://github.com/merged/review-repo/pull/10",
        title: "Merged cached title",
        state: "MERGED",
        isDraft: false,
      },
      {
        localRepositoryPath: opened.pullRequest.localRepositoryPath,
        gitCommonDir: opened.pullRequest.gitCommonDir,
      },
      base,
    );
    const requestedReferences: string[] = [];
    const statusGithub: GitHubPort = {
      doctor: () => Promise.resolve({ version: "gh fake", authenticated: true }),
      getPullRequest: () => Promise.reject(new Error("not used")),
      getPullRequestStatuses(references) {
        requestedReferences.push(...references);
        return Promise.resolve(
          references.map((reference) =>
            reference === opened.pullRequest.url
              ? {
                  status: "fulfilled" as const,
                  value: { state: "CLOSED" as const, isDraft: false },
                }
              : { status: "rejected" as const, error: new Error("temporary GitHub failure") },
          ),
        );
      },
      getAttachment: () => Promise.reject(new Error("not used")),
    };
    const statusService = new RvwService(database, new GitClient(), statusGithub);
    const changeSequence = database.getChangeSequence();

    await expect(statusService.refreshPullRequestStatuses()).resolves.toMatchObject({
      attempted: 2,
      updated: 1,
      failures: [
        {
          pullRequestId: second.id,
          owner: "acme",
          repository: "review-repo",
          number: 8,
          error: { code: "INTERNAL_ERROR", message: "temporary GitHub failure" },
        },
      ],
    });
    expect(requestedReferences.sort()).toEqual([opened.pullRequest.url, second.url].sort());
    expect(database.getPullRequest(opened.pullRequest.id)).toMatchObject({
      latestTitle: "Initial review",
      latestBody: "Please review.",
      latestHeadOid: firstHead,
      githubState: "CLOSED",
      githubIsDraft: false,
    });
    expect(database.getPullRequest(second.id)).toMatchObject({
      latestTitle: "Second cached title",
      githubState: "OPEN",
      githubIsDraft: true,
    });
    expect(database.getPullRequest(closed.id)).toMatchObject({
      latestTitle: "Closed cached title",
      githubState: "CLOSED",
    });
    expect(database.getPullRequest(merged.id)).toMatchObject({
      latestTitle: "Merged cached title",
      githubState: "MERGED",
    });
    expect(database.getChangeSequence()).toBe(changeSequence + 1);
  });

  it("skips GitHub when no saved Pull Request needs a status refresh", async () => {
    const { repository, database, service } = setup("rvw-empty-status-working-set-");
    const opened = await service.openPullRequest(undefined, repository);
    database.updatePullRequestGitHubStatuses([
      { pullRequestId: opened.pullRequest.id, state: "CLOSED", isDraft: false },
    ]);
    let githubCalled = false;
    const statusGithub: GitHubPort = {
      doctor: () => Promise.resolve({ version: "gh fake", authenticated: true }),
      getPullRequest: () => Promise.reject(new Error("not used")),
      getPullRequestStatuses: () => {
        githubCalled = true;
        return Promise.reject(new Error("must not query GitHub"));
      },
      getAttachment: () => Promise.reject(new Error("not used")),
    };

    await expect(
      new RvwService(database, new GitClient(), statusGithub).refreshPullRequestStatuses(),
    ).resolves.toEqual({ attempted: 0, updated: 0, failures: [] });
    expect(githubCalled).toBe(false);
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

    const preview = await service.getResetPreview(opened.pullRequest.id);
    expect(preview.counts).toMatchObject({ comments: 1, posts: 2, targets: 1, gitRefs: 2 });
    const reset = await service.resetPullRequest(opened.pullRequest.id);
    expect(reset.pullRequest.latestComparisonBaseOid).toBe(base);
    expect(reset.commits.map(({ oid }) => oid)).toEqual([firstHead, secondHead]);
    expect(service.listComments(opened.pullRequest.id)).toHaveLength(0);
    expect((await service.getResetPreview(opened.pullRequest.id)).counts.gitRefs).toBe(1);
  });

  it("resolves 100 comment placements with request-scoped Git and document caches", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-placement-batch-");
    const opened = await service.openPullRequest(undefined, repository);
    const comments = [];
    for (let index = 0; index < 100; index += 1) {
      comments.push(
        await service.createComment({
          pullRequestId: opened.pullRequest.id,
          target: {
            kind: "document",
            documentKind: "repository-file",
            sourceOid: firstHead,
            path: "src.txt",
            startLine: 2,
            endLine: 2,
          },
          body: `Comment ${index + 1}`,
          authorLabel: "You",
        }),
      );
    }
    const secondHead = commitFile(
      repository,
      "src.txt",
      "inserted\nfirst\nsecond\n",
      "move placement source",
    );
    fake.pullRequest = { ...fake.pullRequest, headOid: secondHead };
    await service.refreshPullRequest(opened.pullRequest.id);
    const hasObject = vi.spyOn(service.git, "hasObject");
    const changedFiles = vi.spyOn(service.git, "changedFiles");
    const readDocument = vi.spyOn(service.git, "readDocument");
    const missingId = "00000000-0000-4000-8000-000000000099";

    for (const comment of comments) {
      await service.placeCommentAtCommit(comment, secondHead);
    }
    expect(hasObject).toHaveBeenCalledTimes(200);
    expect(changedFiles).toHaveBeenCalledTimes(100);
    expect(readDocument).toHaveBeenCalledTimes(200);
    hasObject.mockClear();
    changedFiles.mockClear();
    readDocument.mockClear();

    const resolved = await service.resolveCommentPlacements(
      opened.pullRequest.id,
      [...comments.map((comment) => comment.id), comments[0]!.id, missingId],
      [
        {
          kind: "document",
          ref: {
            kind: "repository-file",
            pullRequestId: opened.pullRequest.id,
            sourceOid: secondHead,
            path: "src.txt",
          },
        },
        {
          kind: "document",
          ref: {
            kind: "repository-file",
            pullRequestId: opened.pullRequest.id,
            sourceOid: firstHead,
            path: "src.txt",
          },
        },
      ],
    );

    expect(resolved.comments.map(({ commentId }) => commentId)).toEqual(
      comments.map(({ id }) => id),
    );
    expect(resolved.missingCommentIds).toEqual([missingId]);
    expect(resolved.comments[0]!.placements.map(({ placement }) => placement)).toEqual([
      { outdated: false, range: { startLine: 3, endLine: 3 }, path: "src.txt" },
      { outdated: false, range: { startLine: 2, endLine: 2 }, path: "src.txt" },
    ]);
    expect(hasObject).toHaveBeenCalledTimes(2);
    expect(changedFiles).toHaveBeenCalledOnce();
    expect(readDocument).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("reopens an explicitly registered PR outside a repository", async () => {
    const { repository, fake, service } = setup("rvw-open-outside-");
    const opened = await service.openPullRequest(undefined, repository);
    const outsideRepository = mkdtempSync(path.join(os.tmpdir(), "rvw-outside-repository-"));

    const reopened = await service.openPullRequest(fake.pullRequest.url, outsideRepository);

    expect(reopened.fromCache).toBe(true);
    expect(reopened.pullRequest.id).toBe(opened.pullRequest.id);
    expect(reopened.pullRequest.localRepositoryPath).toBe(opened.pullRequest.localRepositoryPath);
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

  it("rejects a new closed Pull Request but lets individual refresh update saved states", async () => {
    const unopened = setup("rvw-unopened-closed-");
    unopened.fake.pullRequest = { ...unopened.fake.pullRequest, state: "CLOSED" };
    await expect(unopened.service.openPullRequest(undefined, unopened.repository)).rejects.toThrow(
      "Pull Request is not open",
    );

    const saved = setup("rvw-saved-merged-");
    const opened = await saved.service.openPullRequest(undefined, saved.repository);
    saved.fake.pullRequest = {
      ...saved.fake.pullRequest,
      state: "MERGED",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };

    const refreshed = await saved.service.refreshPullRequest(opened.pullRequest.id);

    expect(refreshed.pullRequest).toMatchObject({
      githubState: "MERGED",
      githubIsDraft: false,
    });
    expect(saved.service.listPullRequests({ hideClosedOrMerged: false }).items[0]).toMatchObject({
      githubState: "MERGED",
      githubIsDraft: false,
    });

    saved.fake.pullRequest = {
      ...saved.fake.pullRequest,
      state: "OPEN",
      isDraft: true,
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    const reopened = await saved.service.refreshPullRequest(opened.pullRequest.id);

    expect(reopened.pullRequest).toMatchObject({
      githubState: "OPEN",
      githubIsDraft: true,
    });
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

  it("persists the trusted modifier channel on comment posts", async () => {
    const { repository, service } = setup("rvw-comment-modifier-");
    const opened = await service.openPullRequest(undefined, repository);
    const created = await service.createCommentForReference({
      pullRequest: opened.pullRequest.url,
      target: { kind: "pull-request" },
      body: "Agent-created root post",
      authorLabel: "Codex",
    });
    expect(created.posts[0]).toMatchObject({ lastModifiedBy: "agent" });

    const reply = await service.replyToComment(created.ref, {
      body: "Agent reply",
      authorLabel: "Codex",
      lastModifiedBy: "agent",
    });
    expect(reply).toMatchObject({ lastModifiedBy: "agent" });

    const edited = await service.editCommentPost(created.ref, reply.id, {
      body: "Human correction",
      lastModifiedBy: "human",
    });
    expect(edited).toMatchObject({ authorLabel: "Codex", lastModifiedBy: "human" });
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

    const walkthrough = await service.publishWalkthrough({
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
    const updatedWalkthrough = await service.updateWalkthrough(walkthrough.ref, {
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

    await service.resetPullRequest(opened.pullRequest.id);
    expect(service.listWalkthroughs(opened.pullRequest.id)).toEqual([]);
    expect(service.listComments(opened.pullRequest.id)).toEqual([]);
  });

  it("maps a Walkthrough reference directly from its anchor to the latest head", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-walkthrough-reference-latest-");
    const opened = await service.openPullRequest(undefined, repository);
    const walkthrough = await service.publishWalkthrough({
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "Latest source flow",
      body: "Inspect [the second line](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "second line",
          path: "src.txt",
          startLine: 2,
          endLine: 2,
          description: null,
        },
      ],
    });
    const latestHead = commitFile(
      repository,
      "src.txt",
      "inserted\nfirst\nsecond\n",
      "insert line",
    );
    fake.pullRequest = { ...fake.pullRequest, headOid: latestHead };
    await service.refreshPullRequest(opened.pullRequest.id);

    const changedFiles = vi.spyOn(service.git, "changedFiles");
    const changedFilesWithCopies = vi.spyOn(service.git, "changedFilesWithCopies");
    const firstParent = vi.spyOn(service.git, "firstParent");
    const documentReads = vi.spyOn(service.git, "readDocument");
    await expect(
      service.resolveWalkthroughReference(opened.pullRequest.id, walkthrough.id, "source"),
    ).resolves.toMatchObject({
      outcome: "latest",
      anchorSourceOid: firstHead,
      latestHeadOid: latestHead,
      target: {
        sourceOid: latestHead,
        path: "src.txt",
        diffBaseOid: null,
        oldPath: "src.txt",
        newPath: "src.txt",
        hasDiff: false,
        startLine: 3,
        endLine: 3,
      },
      latestFile: null,
      document: {
        ref: { sourceOid: latestHead, path: "src.txt" },
        text: "inserted\nfirst\nsecond\n",
      },
    });
    expect(changedFiles).not.toHaveBeenCalled();
    expect(changedFilesWithCopies).not.toHaveBeenCalled();
    expect(firstParent).not.toHaveBeenCalled();
    expect(documentReads).toHaveBeenCalledTimes(2);
  });

  it("falls back to the anchor and offers the latest file when the range changed", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-walkthrough-reference-fallback-");
    const opened = await service.openPullRequest(undefined, repository);
    const walkthrough = await service.publishWalkthrough({
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "Fallback source flow",
      body: "Inspect [the second line](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "second line",
          path: "src.txt",
          startLine: 2,
          endLine: 2,
          description: null,
        },
      ],
    });
    const latestHead = commitFile(repository, "src.txt", "first\nchanged\n", "change line");
    fake.pullRequest = { ...fake.pullRequest, headOid: latestHead };
    await service.refreshPullRequest(opened.pullRequest.id);

    await expect(
      service.resolveWalkthroughReference(opened.pullRequest.id, walkthrough.id, "source"),
    ).resolves.toMatchObject({
      outcome: "source-fallback",
      target: {
        sourceOid: firstHead,
        path: "src.txt",
        startLine: 2,
        endLine: 2,
      },
      latestFile: {
        sourceOid: latestHead,
        path: "src.txt",
        diffBaseOid: null,
        hasDiff: false,
      },
      document: {
        ref: { sourceOid: firstHead, path: "src.txt" },
        text: "first\nsecond\n",
      },
    });
  });

  it.each([
    ["binary", Buffer.from([0, 1, 2, 3])],
    ["too-large", "x".repeat(1024 * 1024 + 1)],
  ])("falls back for a file-level reference when latest is %s", async (availability, content) => {
    const { repository, firstHead, fake, service } = setup(
      `rvw-walkthrough-reference-${availability}-`,
    );
    const opened = await service.openPullRequest(undefined, repository);
    const walkthrough = await service.publishWalkthrough({
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "File-level fallback",
      body: "Inspect [the source file](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "source file",
          path: "src.txt",
          startLine: null,
          endLine: null,
          description: null,
        },
      ],
    });
    writeFileSync(path.join(repository, "src.txt"), content);
    git(repository, "add", "--", "src.txt");
    git(repository, "commit", "-m", `make source ${availability}`);
    const latestHead = git(repository, "rev-parse", "HEAD");
    fake.pullRequest = { ...fake.pullRequest, headOid: latestHead };
    await service.refreshPullRequest(opened.pullRequest.id);

    await expect(
      service.resolveWalkthroughReference(opened.pullRequest.id, walkthrough.id, "source"),
    ).resolves.toMatchObject({
      outcome: "source-fallback",
      target: {
        sourceOid: firstHead,
        path: "src.txt",
        startLine: null,
        endLine: null,
      },
      latestFile: {
        sourceOid: latestHead,
        path: "src.txt",
      },
      document: {
        availability: "available",
        ref: { sourceOid: firstHead, path: "src.txt" },
        text: "first\nsecond\n",
      },
    });
  });

  it("follows a directly detectable rename at the latest head", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-walkthrough-reference-rename-");
    const opened = await service.openPullRequest(undefined, repository);
    const walkthrough = await service.publishWalkthrough({
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "Renamed source flow",
      body: "Inspect [the source](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "source",
          path: "src.txt",
          startLine: 1,
          endLine: 2,
          description: null,
        },
      ],
    });
    git(repository, "mv", "src.txt", "renamed.txt");
    git(repository, "commit", "-m", "rename source");
    const latestHead = git(repository, "rev-parse", "HEAD");
    fake.pullRequest = { ...fake.pullRequest, headOid: latestHead };
    await service.refreshPullRequest(opened.pullRequest.id);

    const documentReads = vi.spyOn(service.git, "readDocument");
    await expect(
      service.resolveWalkthroughReference(opened.pullRequest.id, walkthrough.id, "source"),
    ).resolves.toMatchObject({
      outcome: "latest",
      target: {
        sourceOid: latestHead,
        path: "renamed.txt",
        diffBaseOid: null,
        oldPath: "renamed.txt",
        newPath: "renamed.txt",
        hasDiff: false,
        startLine: 1,
        endLine: 2,
      },
    });
    expect(documentReads).toHaveBeenCalledTimes(3);
  });

  it("falls back when a removed source has multiple identical successor paths", async () => {
    const { repository, firstHead, fake, service } = setup(
      "rvw-walkthrough-reference-ambiguous-copy-",
    );
    const opened = await service.openPullRequest(undefined, repository);
    const walkthrough = await service.publishWalkthrough({
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "Ambiguous successor flow",
      body: "Inspect [the source](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "source",
          path: "src.txt",
          startLine: 1,
          endLine: 2,
          description: null,
        },
      ],
    });
    git(repository, "rm", "--", "src.txt");
    writeFileSync(path.join(repository, "successor-a.txt"), "first\nsecond\n");
    writeFileSync(path.join(repository, "successor-b.txt"), "first\nsecond\n");
    git(repository, "add", "-A");
    git(repository, "commit", "-m", "replace source with two copies");
    const latestHead = git(repository, "rev-parse", "HEAD");
    fake.pullRequest = { ...fake.pullRequest, headOid: latestHead };
    await service.refreshPullRequest(opened.pullRequest.id);

    const copyAwareChanges = vi.spyOn(service.git, "changedFilesWithCopies");
    await expect(
      service.resolveWalkthroughReference(opened.pullRequest.id, walkthrough.id, "source"),
    ).resolves.toMatchObject({
      outcome: "source-fallback",
      target: {
        sourceOid: firstHead,
        path: "src.txt",
        startLine: 1,
        endLine: 2,
      },
      latestFile: null,
      document: {
        ref: { sourceOid: firstHead, path: "src.txt" },
      },
    });
    expect(copyAwareChanges).toHaveBeenCalledOnce();
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
    const walkthrough = await service.publishWalkthrough({
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
      message: "Mermaid binding対象が本文の対応diagramに見つかりません: Diagram",
    });

    for (const phantomStyle of [
      {
        title: "State style is not a binding target",
        body: [
          "Open [the source](rvw-ref:source).",
          "",
          "```mermaid",
          "stateDiagram-v2",
          "  Still:::notMoving --> Moving:::movement",
          "```",
        ].join("\n"),
        diagramBindings: { notMoving: "diagram" },
      },
      {
        title: "ER style is not a binding target",
        body: [
          "Open [the source](rvw-ref:source).",
          "",
          "```mermaid",
          "erDiagram",
          "  PERSON:::model,aggregate ||--|| CAR : owns",
          "```",
        ].join("\n"),
        diagramBindings: { model: "diagram" },
      },
    ]) {
      const [phantomId] = Object.keys(phantomStyle.diagramBindings);
      await expect(
        service.publishWalkthrough({
          pullRequest: opened.pullRequest.url,
          sourceOid: firstHead,
          ...phantomStyle,
          references,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: `Mermaid binding対象が本文の対応diagramに見つかりません: ${phantomId}`,
      });
    }

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
    ).resolves.toMatchObject({ diagramBindings: { Right: "diagram" } });

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
    ).resolves.toMatchObject({ diagramBindings: { Actual: "diagram" } });

    for (const supported of [
      {
        title: "Flowchart IDs overlapping other diagram keywords",
        body: [
          "Open [the source](rvw-ref:source).",
          "",
          "```mermaid",
          "flowchart LR",
          "  service[Service]:::backend --> state[State]:::workflow",
          "```",
        ].join("\n"),
        diagramBindings: { service: "diagram", state: "source" },
      },
      {
        title: "Sequence diagram bindings",
        body: [
          "Open [the source](rvw-ref:source).",
          "",
          "```mermaid",
          "sequenceDiagram",
          '  participant C@{ "type": "boundary" } as Controller',
          "  actor U as User",
          "  U->>C: request",
          "```",
        ].join("\n"),
        diagramBindings: { C: "diagram", U: "source" },
      },
      {
        title: "State diagram binding",
        body: [
          "Open [the source](rvw-ref:source).",
          "",
          "```mermaid",
          "stateDiagram-v2",
          "  Idle",
          "  Draft:::notMoving --> Approved:::movement",
          "```",
        ].join("\n"),
        diagramBindings: { Idle: "source", Draft: "diagram", Approved: "source" },
      },
      {
        title: "ER diagram binding",
        body: [
          "Open [the source](rvw-ref:source).",
          "",
          "```mermaid",
          "erDiagram",
          "  p[Person] {",
          "    string name",
          "  }",
          "  p 1 to zero or more ORDER : places",
          "  HOUSE",
          "  PERSON:::model,aggregate ||--|| CAR:::vehicle,asset : owns",
          "```",
        ].join("\n"),
        diagramBindings: { p: "diagram", ORDER: "source", HOUSE: "diagram", PERSON: "source" },
      },
      {
        title: "Architecture diagram binding",
        body: [
          "Open [the source](rvw-ref:source).",
          "",
          "```mermaid",
          "architecture-beta",
          "  service worker(server)[Worker]",
          "```",
        ].join("\n"),
        diagramBindings: { worker: "diagram" },
      },
    ]) {
      await expect(
        service.publishWalkthrough({
          pullRequest: opened.pullRequest.url,
          sourceOid: firstHead,
          ...supported,
          references,
        }),
      ).resolves.toMatchObject({ diagramBindings: supported.diagramBindings });
    }

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
    const walkthrough = await service.publishWalkthrough({
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
    expect(service.deleteWalkthroughByUri(walkthrough.ref)).toEqual({
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
            pullRequestUrl: opened.pullRequest.url,
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

  it("publishes, replaces, reads, and deletes an exact-source Structure", async () => {
    const { repository, firstHead, fake, database, service } = setup("rvw-structure-");
    const opened = await service.openPullRequest(undefined, repository);
    const publishInput = {
      idempotencyKey: "structure-publish-source-relationships",
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "Source relationships",
      scope: "Relationships around src.txt. Build configuration is excluded.",
      originNodeId: "source",
      nodes: [
        {
          id: "source",
          label: "src.txt",
          description: "The exact source document",
          kind: "document",
          notation: "class" as const,
          anchor: { path: "src.txt", startLine: 1, endLine: 2 },
        },
        { id: "consumer", label: "Consumer", description: "   ", kind: " concept " },
        { id: "obsolete", label: "Obsolete claim" },
      ],
      edges: [
        {
          id: "reads-source",
          from: "consumer",
          to: "source",
          label: "reads",
          directed: true,
          anchors: [{ path: "src.txt" }],
        },
        {
          id: "documents-obsolete",
          from: "source",
          to: "obsolete",
          label: "documents",
          directed: true,
        },
      ],
    };
    await expect(
      service.publishStructure({
        ...publishInput,
        idempotencyKey: "structure-origin-without-anchor",
        originNodeId: "consumer",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.publishStructure({
        ...publishInput,
        idempotencyKey: "structure-disconnected-graph",
        edges: publishInput.edges.filter((edge) => edge.id === "documents-obsolete"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const structure = await service.publishStructure(publishInput);
    await expect(service.publishStructure(publishInput)).resolves.toEqual(structure);
    await expect(
      service.publishStructure({ ...publishInput, title: "Conflicting retry" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    expect(structure).toMatchObject({
      ref: `rvw://structure/${structure.id}`,
      pullRequestId: opened.pullRequest.id,
      sourceOid: firstHead,
      originNodeId: "source",
      nodes: [
        {
          id: "source",
          notation: "class",
          anchor: { path: "src.txt", startLine: 1, endLine: 2 },
        },
        { id: "consumer", description: null, kind: "concept", notation: "plain", anchor: null },
        { id: "obsolete", notation: "plain", anchor: null },
      ],
      edges: [
        { id: "reads-source", anchors: [{ startLine: null, endLine: null }] },
        { id: "documents-obsolete" },
      ],
    });
    expect(service.listStructures(opened.pullRequest.id)).toEqual([
      {
        id: structure.id,
        ref: structure.ref,
        pullRequestId: opened.pullRequest.id,
        sourceOid: firstHead,
        title: "Source relationships",
        scope: "Relationships around src.txt. Build configuration is excluded.",
        createdAt: structure.createdAt,
        updatedAt: structure.updatedAt,
      },
    ]);
    expect(service.getStructureByUri(structure.ref).structure).toEqual(structure);

    const updated = await service.updateStructure(structure.ref, {
      expectedUpdatedAt: structure.updatedAt,
      sourceOid: firstHead,
      title: "Source boundary",
      scope: "The same subject with a corrected consumer claim.",
      originNodeId: "source",
      nodes: [
        {
          id: "source",
          label: "src.txt",
          description: "The exact source document",
          anchor: { path: "src.txt", startLine: 1, endLine: 2 },
        },
        { id: "consumer", label: "Updated consumer" },
        { id: "validator", label: "Validator", anchor: { path: "src.txt" } },
      ],
      edges: [
        {
          id: "validates-source",
          from: "validator",
          to: "source",
          label: "validates",
          directed: true,
        },
        {
          id: "serves-consumer",
          from: "source",
          to: "consumer",
          label: "serves",
          directed: true,
        },
      ],
    });
    expect(updated).toMatchObject({
      id: structure.id,
      ref: structure.ref,
      createdAt: structure.createdAt,
      title: "Source boundary",
      nodes: [{ id: "source" }, { id: "consumer" }, { id: "validator" }],
      edges: [{ id: "validates-source" }, { id: "serves-consumer" }],
    });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(structure.updatedAt));
    expect(updated.edges.some((edge) => edge.id === "reads-source")).toBe(false);

    await expect(
      service.updateStructure(structure.ref, {
        expectedUpdatedAt: updated.updatedAt,
        sourceOid: firstHead,
        title: "Reused retired node",
        scope: "A retired identity must never point at a new claim.",
        originNodeId: "source",
        nodes: [...updated.nodes, { id: "obsolete", label: "Different claim" }],
        edges: updated.edges,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.updateStructure(structure.ref, {
        expectedUpdatedAt: updated.updatedAt,
        sourceOid: firstHead,
        title: "Reused retired relation",
        scope: "A retired relation identity must not be rebound.",
        originNodeId: "source",
        nodes: updated.nodes,
        edges: [
          ...updated.edges,
          {
            id: "reads-source",
            from: "consumer",
            to: "source",
            label: "reads again",
            directed: true,
            anchors: [{ path: "src.txt" }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      service.updateStructure(structure.ref, {
        expectedUpdatedAt: structure.updatedAt,
        sourceOid: firstHead,
        title: "Stale replacement",
        scope: "This writer read the previous value.",
        originNodeId: "source",
        nodes: [{ id: "source", label: "Stale", anchor: { path: "src.txt" } }],
        edges: [],
      }),
    ).rejects.toMatchObject({
      code: "STRUCTURE_CONFLICT",
      status: 409,
      details: { expectedUpdatedAt: structure.updatedAt, currentUpdatedAt: updated.updatedAt },
    });

    await expect(
      service.updateStructure(structure.ref, {
        expectedUpdatedAt: updated.updatedAt,
        sourceOid: firstHead,
        title: "Invalid source",
        scope: "Reject an out-of-document anchor.",
        originNodeId: "source",
        nodes: [
          {
            id: "source",
            label: "src.txt",
            anchor: { path: "src.txt", startLine: 99, endLine: 99 },
          },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(service.getStructureByUri(structure.ref).structure).toEqual(updated);

    const secondPr = database.upsertPullRequest(
      { ...fake.pullRequest, number: 8, url: "https://github.com/acme/review-repo/pull/8" },
      {
        localRepositoryPath: opened.pullRequest.localRepositoryPath,
        gitCommonDir: opened.pullRequest.gitCommonDir,
      },
      opened.pullRequest.latestComparisonBaseOid,
    );
    expect(() => service.getStructure(secondPr.id, structure.id)).toThrow(/見つかりません/);
    const deletePreview = service.getStructureDeletePreview(structure.ref);
    expect(deletePreview).toMatchObject({
      counts: { nodes: 3, edges: 2, anchors: 2 },
      confirmationRequired: true,
    });
    const concurrentResults = await Promise.allSettled(
      ["First", "Second"].map((writer) =>
        service.updateStructure(structure.ref, {
          expectedUpdatedAt: updated.updatedAt,
          sourceOid: firstHead,
          title: `${writer} concurrent replacement`,
          scope: "Only one writer from the same current value may succeed.",
          nodes: updated.nodes,
          edges: updated.edges,
          originNodeId: updated.originNodeId,
        }),
      ),
    );
    const fulfilled = concurrentResults.filter(
      (result): result is PromiseFulfilledResult<Structure> => result.status === "fulfilled",
    );
    const rejected = concurrentResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "STRUCTURE_CONFLICT", status: 409 });
    const concurrentlyUpdated = fulfilled[0]!.value;
    expect(() =>
      service.deleteStructureByUri(structure.ref, deletePreview.structure.updatedAt),
    ).toThrowError(expect.objectContaining({ code: "STRUCTURE_CONFLICT", status: 409 }));
    expect(
      service.deleteStructureByUri(structure.ref, concurrentlyUpdated.updatedAt),
    ).toMatchObject({
      id: structure.id,
      ref: structure.ref,
      counts: { nodes: 3, edges: 2, anchors: 2 },
    });
    expect(service.listStructures(opened.pullRequest.id)).toEqual([]);
    await expect(service.publishStructure(publishInput)).rejects.toMatchObject({
      code: "IDEMPOTENCY_RESULT_DELETED",
    });
    expect(git(repository, "rev-parse", `refs/rvw/pr/7/commits/oid-${firstHead}`)).toBe(firstHead);
  });

  it("maps a verified Structure anchor directly to the latest head", async () => {
    const { repository, firstHead, fake, service } = setup("rvw-structure-anchor-latest-");
    const opened = await service.openPullRequest(undefined, repository);
    const structure = await service.publishStructure({
      idempotencyKey: "structure-anchor-latest",
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "Latest source structure",
      scope: "The source file and its current location.",
      originNodeId: "source",
      nodes: [
        {
          id: "source",
          label: "Source range",
          anchor: { path: "src.txt", startLine: 2, endLine: 2 },
        },
      ],
      edges: [],
    });
    const sameCommitDocumentReads = vi.spyOn(service.git, "readDocument");
    await expect(
      service.resolveStructureSource(opened.pullRequest.id, structure.id, {
        kind: "node",
        nodeId: "source",
      }),
    ).resolves.toMatchObject({
      outcome: "latest",
      document: { ref: { sourceOid: firstHead, path: "src.txt" } },
    });
    expect(sameCommitDocumentReads).toHaveBeenCalledOnce();
    sameCommitDocumentReads.mockRestore();
    const latestHead = commitFile(
      repository,
      "src.txt",
      "inserted\nfirst\nsecond\n",
      "insert before Structure anchor",
    );
    fake.pullRequest = { ...fake.pullRequest, headOid: latestHead };
    await service.refreshPullRequest(opened.pullRequest.id);

    await expect(
      service.resolveStructureSource(opened.pullRequest.id, structure.id, {
        kind: "node",
        nodeId: "source",
      }),
    ).resolves.toMatchObject({
      outcome: "latest",
      anchorSourceOid: firstHead,
      latestHeadOid: latestHead,
      target: {
        sourceOid: latestHead,
        path: "src.txt",
        startLine: 3,
        endLine: 3,
      },
      document: {
        ref: { sourceOid: latestHead, path: "src.txt" },
        text: "inserted\nfirst\nsecond\n",
      },
      resolvedAnchor: { path: "src.txt", startLine: 2, endLine: 2 },
    });
    await expect(
      service.resolveStructureSource(opened.pullRequest.id, structure.id, {
        kind: "node",
        nodeId: "missing",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    const updated = await service.updateStructure(structure.ref, {
      expectedUpdatedAt: structure.updatedAt,
      sourceOid: firstHead,
      title: structure.title,
      scope: structure.scope,
      originNodeId: "source",
      nodes: [
        {
          id: "source",
          label: "Source range moved",
          anchor: { path: "src.txt", startLine: 1, endLine: 1 },
        },
        {
          id: "other",
          label: "Other claim reusing the old range",
          anchor: { path: "src.txt", startLine: 2, endLine: 2 },
        },
      ],
      edges: [
        {
          id: "source-to-other",
          from: "source",
          to: "other",
          label: "feeds",
          directed: true,
          anchors: [{ path: "src.txt", startLine: 1, endLine: 1 }],
        },
      ],
    });

    await expect(
      service.resolveStructureSource(opened.pullRequest.id, updated.id, {
        kind: "node",
        nodeId: "source",
      }),
    ).resolves.toMatchObject({
      resolvedAnchor: { path: "src.txt", startLine: 1, endLine: 1 },
    });
    await expect(
      service.resolveStructureSource(opened.pullRequest.id, updated.id, {
        kind: "edge",
        edgeId: "source-to-other",
        anchorIndex: 0,
      }),
    ).resolves.toMatchObject({
      resolvedAnchor: { path: "src.txt", startLine: 1, endLine: 1 },
    });
  });

  it("derives ordered rename-aware file backlinks from Node anchors", async () => {
    const { repository, base, fake, database, service } = setup("rvw-structure-backlinks-");
    const opened = await service.openPullRequest(undefined, repository);
    writeFileSync(
      path.join(repository, "src.txt"),
      Array.from({ length: 10 }, (_, index) => `source line ${index + 1}`).join("\n") + "\n",
    );
    writeFileSync(path.join(repository, "origin.txt"), "behavior origin\n");
    writeFileSync(path.join(repository, "edge-only.txt"), "edge evidence\n");
    writeFileSync(
      path.join(repository, "copy-source.txt"),
      Array.from({ length: 10 }, (_, index) => `copy line ${index + 1}`).join("\n") + "\n",
    );
    git(repository, "add", "src.txt", "origin.txt", "edge-only.txt", "copy-source.txt");
    git(repository, "commit", "-m", "add Structure backlink sources");
    const sourceOid = git(repository, "rev-parse", "HEAD");

    const nearestStructure = await service.publishStructure({
      idempotencyKey: "structure-backlink-nearest",
      pullRequest: opened.pullRequest.url,
      sourceOid,
      title: "Nearest matching claim",
      scope: "Select the source claim nearest to the behavior origin.",
      originNodeId: "origin",
      nodes: [
        { id: "origin", label: "Origin", anchor: { path: "origin.txt" } },
        {
          id: "near",
          label: "Near source",
          anchor: { path: "src.txt", startLine: 5, endLine: 5 },
        },
        { id: "middle", label: "Middle" },
        {
          id: "far",
          label: "Far source",
          anchor: { path: "src.txt", startLine: 6, endLine: 6 },
        },
      ],
      edges: [
        { id: "origin-near", from: "near", to: "origin", label: "enters", directed: true },
        { id: "origin-middle", from: "origin", to: "middle", label: "uses", directed: true },
        { id: "middle-far", from: "middle", to: "far", label: "uses", directed: true },
      ],
    });
    const edgeOnlyStructure = await service.publishStructure({
      idempotencyKey: "structure-backlink-edge-only",
      pullRequest: opened.pullRequest.url,
      sourceOid,
      title: "Edge-only evidence",
      scope: "The target file appears only on an Edge.",
      originNodeId: "origin",
      nodes: [{ id: "origin", label: "Edge origin", anchor: { path: "edge-only.txt" } }],
      edges: [
        {
          id: "self-evidence",
          from: "origin",
          to: "origin",
          label: "documents",
          directed: false,
          anchors: [{ path: "src.txt" }],
        },
      ],
    });
    const originStructure = await service.publishStructure({
      idempotencyKey: "structure-backlink-origin",
      pullRequest: opened.pullRequest.url,
      sourceOid,
      title: "Matching origin",
      scope: "The behavior origin itself is in the target file.",
      originNodeId: "source-origin",
      nodes: [
        { id: "source-origin", label: "Source origin", anchor: { path: "src.txt" } },
        { id: "other", label: "Other" },
      ],
      edges: [
        {
          id: "source-other",
          from: "source-origin",
          to: "other",
          label: "uses",
          directed: true,
        },
      ],
    });
    const ambiguousStructure = await service.publishStructure({
      idempotencyKey: "structure-backlink-ambiguous-copy",
      pullRequest: opened.pullRequest.url,
      sourceOid,
      title: "Ambiguous copy source",
      scope: "A copied file must not be guessed.",
      originNodeId: "copy-origin",
      nodes: [{ id: "copy-origin", label: "Copy origin", anchor: { path: "copy-source.txt" } }],
      edges: [],
    });

    const exactReferences = await service.listFileStructureReferences(
      opened.pullRequest.id,
      sourceOid,
      "src.txt",
    );
    expect(exactReferences.map((reference) => reference.structure.id)).toEqual(
      service
        .listStructures(opened.pullRequest.id)
        .filter((summary) => [nearestStructure.id, originStructure.id].includes(summary.id))
        .map((summary) => summary.id),
    );
    expect(
      exactReferences.find((reference) => reference.structure.id === nearestStructure.id),
    ).toMatchObject({
      structure: { id: nearestStructure.id },
      targetNodeId: "near",
      targetNodeLabel: "Near source",
      matchingNodeCount: 2,
    });
    expect(
      exactReferences.find((reference) => reference.structure.id === originStructure.id),
    ).toMatchObject({
      structure: { id: originStructure.id },
      targetNodeId: "source-origin",
      targetNodeLabel: "Source origin",
      matchingNodeCount: 1,
    });

    git(repository, "mv", "src.txt", "renamed-src.txt");
    writeFileSync(
      path.join(repository, "renamed-src.txt"),
      Array.from({ length: 10 }, (_, index) =>
        index === 4 ? "updated source line five" : `source line ${index + 1}`,
      ).join("\n") + "\n",
    );
    git(repository, "rm", "copy-source.txt");
    const copiedContents =
      Array.from({ length: 10 }, (_, index) => `copy line ${index + 1}`).join("\n") + "\n";
    writeFileSync(path.join(repository, "copy-a.txt"), copiedContents);
    writeFileSync(path.join(repository, "copy-b.txt"), copiedContents);
    git(repository, "add", "renamed-src.txt", "copy-a.txt", "copy-b.txt");
    git(repository, "commit", "-m", "rename and copy backlink sources");
    const targetOid = git(repository, "rev-parse", "HEAD");

    const copyAwareChanges = vi.spyOn(service.git, "changedFilesWithCopies");
    const documentReads = vi.spyOn(service.git, "readDocument");
    const renamedReferences = await service.listFileStructureReferences(
      opened.pullRequest.id,
      targetOid,
      "renamed-src.txt",
    );
    expect(copyAwareChanges).toHaveBeenCalledTimes(1);
    expect(copyAwareChanges).toHaveBeenCalledWith(
      opened.pullRequest.localRepositoryPath,
      sourceOid,
      targetOid,
    );
    expect(documentReads).not.toHaveBeenCalled();
    expect(renamedReferences.map((reference) => reference.structure.id)).toEqual(
      service
        .listStructures(opened.pullRequest.id)
        .filter((summary) => [nearestStructure.id, originStructure.id].includes(summary.id))
        .map((summary) => summary.id),
    );
    expect(
      renamedReferences.find((reference) => reference.structure.id === nearestStructure.id),
    ).toMatchObject({
      structure: { id: nearestStructure.id },
      targetNodeId: "near",
      matchingNodeCount: 2,
    });
    expect(
      renamedReferences.find((reference) => reference.structure.id === originStructure.id),
    ).toMatchObject({
      structure: { id: originStructure.id },
      targetNodeId: "source-origin",
      matchingNodeCount: 1,
    });
    expect(
      renamedReferences.some((reference) => reference.structure.id === edgeOnlyStructure.id),
    ).toBe(false);
    const ambiguousReferences = await service.listFileStructureReferences(
      opened.pullRequest.id,
      targetOid,
      "copy-a.txt",
    );
    expect(
      ambiguousReferences.some((reference) => reference.structure.id === ambiguousStructure.id),
    ).toBe(false);
    await expect(
      service.listFileStructureReferences(opened.pullRequest.id, targetOid, "missing.txt"),
    ).resolves.toEqual([]);

    const secondPullRequest = database.upsertPullRequest(
      {
        ...fake.pullRequest,
        number: 8,
        url: "https://github.com/acme/review-repo/pull/8",
        headOid: targetOid,
      },
      {
        localRepositoryPath: opened.pullRequest.localRepositoryPath,
        gitCommonDir: opened.pullRequest.gitCommonDir,
      },
      base,
    );
    await expect(
      service.listFileStructureReferences(secondPullRequest.id, targetOid, "renamed-src.txt"),
    ).resolves.toEqual([]);
    await expect(
      service.listFileStructureReferences(opened.pullRequest.id, "f".repeat(40), "src.txt"),
    ).rejects.toMatchObject({ code: "COMMIT_NOT_FOUND", status: 404 });
    await expect(
      service.listFileStructureReferences(opened.pullRequest.id, targetOid, "../src.txt"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("returns an empty Structure backlink index without Git work when no Structure exists", async () => {
    const { repository, firstHead, service } = setup("rvw-empty-structure-index-");
    const opened = await service.openPullRequest(undefined, repository);
    const hasObject = vi.spyOn(service.git, "hasObject");
    const tree = vi.spyOn(service.git, "tree");
    const changedFilesWithCopies = vi.spyOn(service.git, "changedFilesWithCopies");

    await expect(
      service.listFileStructureReferenceIndex(opened.pullRequest.id, firstHead),
    ).resolves.toEqual({ sourceOid: firstHead, entries: [] });
    expect(hasObject).not.toHaveBeenCalled();
    expect(tree).not.toHaveBeenCalled();
    expect(changedFilesWithCopies).not.toHaveBeenCalled();
  });

  it("uses one Structure revision for each file backlink while Git resolution is pending", async () => {
    const { repository, fake, service } = setup("rvw-structure-backlink-snapshot-");
    const opened = await service.openPullRequest(undefined, repository);
    writeFileSync(path.join(repository, "blocking.txt"), "blocking source\n");
    writeFileSync(path.join(repository, "stable.txt"), "stable source\n");
    git(repository, "add", "blocking.txt", "stable.txt");
    git(repository, "commit", "-m", "add backlink snapshot sources");
    const sourceOid = git(repository, "rev-parse", "HEAD");
    fake.pullRequest = { ...fake.pullRequest, headOid: sourceOid };
    await service.refreshPullRequest(opened.pullRequest.id);

    for (const suffix of ["one", "two"]) {
      await service.publishStructure({
        idempotencyKey: `structure-backlink-snapshot-${suffix}`,
        pullRequest: opened.pullRequest.url,
        sourceOid,
        title: `Snapshot ${suffix}`,
        scope: "A Structure whose backlink revision must remain internally consistent.",
        originNodeId: "origin",
        nodes: [{ id: "origin", label: `Snapshot ${suffix}`, anchor: { path: "stable.txt" } }],
        edges: [],
      });
    }
    const ordered = service
      .listStructures(opened.pullRequest.id)
      .map((summary) => service.getStructure(opened.pullRequest.id, summary.id));
    const blockerBeforeLookup = await service.updateStructure(ordered[0]!.ref, {
      expectedUpdatedAt: ordered[0]!.updatedAt,
      sourceOid,
      title: ordered[0]!.title,
      scope: ordered[0]!.scope,
      originNodeId: "origin",
      nodes: [{ id: "origin", label: "Blocking source", anchor: { path: "blocking.txt" } }],
      edges: [],
    });
    const followerBeforeLookup = ordered[1]!;

    git(repository, "mv", "blocking.txt", "renamed-blocking.txt");
    git(repository, "commit", "-m", "rename blocking backlink source");
    const targetOid = git(repository, "rev-parse", "HEAD");

    let releaseGitResolution = (): void => {};
    let reportGitResolutionStarted = (): void => {};
    const gitResolutionStarted = new Promise<void>((resolve) => {
      reportGitResolutionStarted = resolve;
    });
    const gitResolutionGate = new Promise<void>((resolve) => {
      releaseGitResolution = resolve;
    });
    const originalChangedFilesWithCopies = service.git.changedFilesWithCopies.bind(service.git);
    vi.spyOn(service.git, "changedFilesWithCopies").mockImplementation(async (...arguments_) => {
      reportGitResolutionStarted();
      await gitResolutionGate;
      return await originalChangedFilesWithCopies(...arguments_);
    });

    const lookup = service.listFileStructureReferences(
      opened.pullRequest.id,
      targetOid,
      "renamed-blocking.txt",
    );
    await gitResolutionStarted;
    const followerAfterLookupStarted = await service.updateStructure(followerBeforeLookup.ref, {
      expectedUpdatedAt: followerBeforeLookup.updatedAt,
      sourceOid: targetOid,
      title: followerBeforeLookup.title,
      scope: followerBeforeLookup.scope,
      originNodeId: "origin",
      nodes: [
        {
          id: "origin",
          label: "Concurrently added backlink",
          anchor: { path: "renamed-blocking.txt" },
        },
      ],
      edges: [],
    });
    releaseGitResolution();

    const references = await lookup;
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      structure: {
        id: blockerBeforeLookup.id,
        updatedAt: blockerBeforeLookup.updatedAt,
      },
      targetNodeId: "origin",
    });
    expect(
      references.some((reference) => reference.structure.id === followerAfterLookupStarted.id),
    ).toBe(false);
  });

  it("allows a Structure publish operation to start fresh after PR reset", async () => {
    const { repository, firstHead, service } = setup("rvw-structure-reset-idempotency-");
    const opened = await service.openPullRequest(undefined, repository);
    const publishInput = {
      idempotencyKey: "structure-reset-republish",
      pullRequest: opened.pullRequest.url,
      sourceOid: firstHead,
      title: "Resettable behavior",
      scope: "A single source-established behavior origin.",
      originNodeId: "entry",
      nodes: [
        {
          id: "entry",
          label: "Entry",
          anchor: { path: "src.txt", startLine: 1, endLine: 1 },
        },
      ],
      edges: [],
    };
    const beforeReset = await service.publishStructure(publishInput);

    await service.resetPullRequest(opened.pullRequest.id);

    const afterReset = await service.publishStructure(publishInput);
    expect(afterReset.id).not.toBe(beforeReset.id);
    expect(afterReset.ref).not.toBe(beforeReset.ref);
  });
});
