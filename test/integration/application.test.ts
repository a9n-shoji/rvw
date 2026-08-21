import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { RvwError } from "../../src/shared/errors.js";
import { commitFile, createGitRepository, git } from "../fixtures/git-repository.js";

class FakeGitHub implements GitHubPort {
  readonly issues = new Map<number, GitHubIssue>();
  readonly pullRequestIssueNumbers = new Set<number>();

  constructor(public pullRequest: GitHubPullRequest) {}

  doctor() {
    return Promise.resolve({ version: "gh fake", authenticated: true });
  }

  getPullRequest() {
    return Promise.resolve(this.pullRequest);
  }

  getIssue(number: number, repository: RepositoryIdentity): Promise<GitHubIssue> {
    expect(repository.canonicalName).toBe("acme/review-repo");
    if (this.pullRequestIssueNumbers.has(number)) {
      throw new RvwError(
        "GITHUB_ISSUE_IS_PULL_REQUEST",
        `#${number}はIssueではなくPull Requestです。`,
      );
    }
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`missing Issue #${number}`);
    return Promise.resolve(issue);
  }
}

function githubIssue(number: number, body = `Issue ${number} body`): GitHubIssue {
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
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
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

  it("adds only direct same-repository Issue references from the PR body and never removes them", async () => {
    const { repository, fake, service } = setup("rvw-pr-direct-issues-");
    fake.issues.set(142, githubIssue(142, "Requirement with a nested #77 reference."));
    fake.issues.set(99, githubIssue(99));
    fake.issues.set(88, githubIssue(88));
    fake.pullRequest = {
      ...fake.pullRequest,
      body: [
        "Closes #142.",
        "Also acme/review-repo#99.",
        "See https://github.com/acme/review-repo/issues/88.",
        "Ignore other/repository#77.",
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
      gitRefs: 2,
    });
    const reset = await service.resetPullRequest(opened.pullRequest.id);
    expect(reset.pullRequest.latestComparisonBaseOid).toBe(base);
    expect(reset.commits.map(({ oid }) => oid)).toEqual([firstHead, secondHead]);
    expect(service.listComments(opened.pullRequest.id)).toHaveLength(0);
    expect(service.listPullRequestIssues(opened.pullRequest.id)).toHaveLength(0);
    expect((await service.getResetPreview(opened.pullRequest.id)).counts.gitRefs).toBe(1);
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
});
