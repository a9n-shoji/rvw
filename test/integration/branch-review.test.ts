import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RvwService } from "../../src/application/rvw-service.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepository,
  RepositoryIdentity,
} from "../../src/domain/models.js";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import type { GitHubPort } from "../../src/infrastructure/github/github-client.js";
import { commitFile, createGitRepository, git } from "../fixtures/git-repository.js";

class BranchGitHub implements GitHubPort {
  repositoryError: Error | null = null;

  constructor(
    public repository: GitHubRepository,
    readonly issues = new Map<number, GitHubIssue>(),
  ) {}

  doctor() {
    return Promise.resolve({ version: "gh fake", authenticated: true });
  }

  getPullRequest(): Promise<GitHubPullRequest> {
    throw new Error("Branch Review must not call the Pull Request API");
  }

  getRepository(identity: RepositoryIdentity): Promise<GitHubRepository> {
    expect(identity.canonicalName).toBe("acme/review-repo");
    if (this.repositoryError) throw this.repositoryError;
    return Promise.resolve(this.repository);
  }

  getIssue(number: number): Promise<GitHubIssue> {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`missing Issue #${number}`);
    return Promise.resolve(issue);
  }
}

class DeleteThenThrowGitClient extends GitClient {
  override async deleteRefsByPrefix(repositoryPath: string, prefix: string): Promise<number> {
    await super.deleteRefsByPrefix(repositoryPath, prefix);
    throw new Error("git update-ref exited after applying the transaction");
  }
}

class ThrowBeforeDeleteGitClient extends GitClient {
  override deleteRefsByPrefix(): Promise<number> {
    return Promise.reject(new Error("git update-ref failed before applying the transaction"));
  }
}

function issue(number: number, body = `Requirement ${number}\nDetails`): GitHubIssue {
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

describe("Branch Review", () => {
  const databases: RvwDatabase[] = [];
  afterEach(() => {
    while (databases.length) databases.pop()?.close();
  });

  function setup(gitClient: GitClient = new GitClient()) {
    const repositoryPath = createGitRepository("rvw-branch-review-");
    const sourceOid = git(repositoryPath, "rev-parse", "HEAD");
    const github = new BranchGitHub({
      host: "github.com",
      owner: "acme",
      repository: "review-repo",
      canonicalName: "acme/review-repo",
      defaultBranchName: "main",
      defaultBranchOid: sourceOid,
    });
    const database = new RvwDatabase({
      filePath: path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-branch-db-")), "rvw.db"),
      migrationsDirectory: "./migrations",
    });
    databases.push(database);
    return {
      repositoryPath,
      sourceOid,
      github,
      database,
      service: new RvwService(database, gitClient, github),
    };
  }

  it("reuses one repository review across worktrees and survives a default branch rename", async () => {
    const { repositoryPath, sourceOid, github, service } = setup();
    const first = await service.openBranchReview(repositoryPath);
    expect(first).toMatchObject({
      fromCache: false,
      branchReview: { defaultBranchName: "main", sourceOid },
    });

    const worktree = `${repositoryPath}-worktree`;
    git(repositoryPath, "worktree", "add", "--detach", worktree, sourceOid);
    const reopened = await service.openBranchReview(worktree);
    expect(reopened.fromCache).toBe(true);
    expect(reopened.branchReview.id).toBe(first.branchReview.id);

    github.repository = { ...github.repository, defaultBranchName: "trunk" };
    const synchronized = await service.syncBranchReview(worktree);
    expect(synchronized.branchReview).toMatchObject({
      id: first.branchReview.id,
      defaultBranchName: "trunk",
    });
  });

  it("preserves canonical identities when GitHub changes repository casing", async () => {
    const { repositoryPath, github, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);
    const added = await service.addBranchIssue(repositoryPath, "#142");

    github.repository = {
      ...github.repository,
      owner: "Acme",
      repository: "Review-Repo",
      canonicalName: "Acme/Review-Repo",
    };
    github.issues.set(142, {
      ...issue(142, "Canonical casing updated"),
      owner: "Acme",
      repository: "Review-Repo",
      canonicalName: "Acme/Review-Repo",
      url: "https://github.com/Acme/Review-Repo/issues/142",
    });

    const synchronized = await service.syncBranchReview(repositoryPath);
    expect(synchronized.branchReview).toMatchObject({
      id: opened.branchReview.id,
      canonicalName: "Acme/Review-Repo",
    });
    expect(service.listBranchIssues(opened.branchReview.id)).toEqual([
      expect.objectContaining({
        id: added.issue.id,
        canonicalName: "Acme/Review-Repo",
        body: "Canonical casing updated",
      }),
    ]);
  });

  it("keeps exact source comments, syncs Issue bodies, and emits Branch watch events", async () => {
    const { repositoryPath, github, service } = setup();
    github.issues.set(142, issue(142));
    github.issues.set(143, issue(143));
    const opened = await service.openBranchReview(repositoryPath);
    await service.addBranchIssue(repositoryPath, "#142");
    const walkthrough = await service.publishWalkthrough({
      review: { kind: "branch", repository: "acme/review-repo" },
      sourceOid: opened.branchReview.sourceOid,
      title: "Current fixture",
      body: "Start at [the fixture](rvw-ref:fixture).",
      references: [
        {
          id: "fixture",
          label: "Fixture",
          path: "README.md",
          startLine: 1,
          endLine: 1,
          description: null,
        },
      ],
      issues: ["#143"],
    });
    expect(walkthrough).toMatchObject({
      branchReviewId: opened.branchReview.id,
      issuesAdded: [{ number: 143 }],
    });
    expect(service.listBranchIssues(opened.branchReview.id).map(({ number }) => number)).toEqual([
      143, 142,
    ]);
    const comment = await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: { kind: "issue", issue: "#142", startLine: 1, endLine: 1 },
      body: "Confirm this requirement against the implementation.",
    });
    const events = service.listCommentPostEvents(undefined, 10);
    expect(events.events).toHaveLength(0);
    const replay = service.listCommentPostEvents(events.startCursor.replace(/:0$/, ":0"), 10);
    expect(replay.events).toEqual([]);
    const databaseEvents = service.database.listCommentPostEvents(0, 10);
    expect(databaseEvents.at(-1)).toMatchObject({
      commentRef: comment.ref,
      context: { kind: "branch", repository: "acme/review-repo" },
    });

    github.issues.set(142, issue(142, "Changed requirement\nDetails"));
    await service.syncBranchReview(repositoryPath);
    await expect(service.getAnyCommentReviewContext(comment.ref)).resolves.toMatchObject({
      context: { kind: "branch", repository: "acme/review-repo" },
      issue: { number: 142, body: "Changed requirement\nDetails" },
      latestPlacement: { outdated: true },
    });
  });

  it("does not partially publish a Walkthrough when one requested Issue fails", async () => {
    const { repositoryPath, github, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);

    await expect(
      service.publishWalkthrough({
        review: { kind: "branch", repository: "acme/review-repo" },
        sourceOid: opened.branchReview.sourceOid,
        title: "Must remain atomic",
        body: "Read [the repository](rvw-ref:repository).",
        references: [
          {
            id: "repository",
            label: "Repository",
            path: "README.md",
            startLine: 1,
            endLine: 1,
            description: null,
          },
        ],
        issues: ["#142", "#999"],
      }),
    ).rejects.toThrow("missing Issue #999");
    expect(service.listBranchWalkthroughs(opened.branchReview.id)).toEqual([]);
    expect(service.listBranchIssues(opened.branchReview.id)).toEqual([]);
  });

  it("places and deletes Branch Walkthrough comments through the shared viewer operations", async () => {
    const { repositoryPath, sourceOid, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const walkthrough = await service.publishWalkthrough({
      review: { kind: "branch", repository: "acme/review-repo" },
      sourceOid,
      title: "Branch walkthrough",
      body: "# Branch walkthrough\n\nRead [the source](rvw-ref:source).",
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
    });
    const comment = await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: { kind: "walkthrough", walkthroughId: walkthrough.id, startLine: 3, endLine: 3 },
      body: "Check this step.",
    });

    expect(
      service.placeBranchWalkthroughComment(opened.branchReview.id, comment, walkthrough.id),
    ).toEqual({ outdated: false, range: { startLine: 3, endLine: 3 }, path: null });
    expect(service.deleteBranchWalkthrough(opened.branchReview.id, walkthrough.id)).toMatchObject({
      id: walkthrough.id,
      branchReviewId: opened.branchReview.id,
      counts: { comments: 1, posts: 1, references: 1 },
    });
    expect(database.getBranchWalkthrough(walkthrough.id)).toBeNull();
    expect(database.getBranchComment(comment.id)).toBeNull();
  });

  it("keeps the last source readable and records an explicit sync error", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    github.repositoryError = new Error("repository metadata unavailable");

    await expect(service.syncBranchReview(repositoryPath)).rejects.toThrow(
      "repository metadata unavailable",
    );
    expect(database.getBranchReview(opened.branchReview.id)).toMatchObject({
      sourceOid,
      sourceSyncError: "repository metadata unavailable",
    });
    await expect(
      service.getBranchDocument({
        kind: "repository-file",
        branchReviewId: opened.branchReview.id,
        sourceOid,
        path: "README.md",
      }),
    ).resolves.toMatchObject({ availability: "available" });
  });

  it("removes only owned Issue artifacts and resets only the Branch Review", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    github.issues.set(142, issue(142));
    github.issues.set(143, issue(143));
    const opened = await service.openBranchReview(repositoryPath);
    await service.addBranchIssue(repositoryPath, "#142");
    const branchIssueComment = await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: { kind: "issue", issue: "#142", startLine: 1, endLine: 1 },
      body: "Branch-owned Issue comment.",
    });
    await service.replyToComment(branchIssueComment.ref, { body: "Branch reply." });

    const pullRequest = database.upsertPullRequest(
      {
        host: "github.com",
        owner: "acme",
        repository: "review-repo",
        number: 7,
        url: "https://github.com/acme/review-repo/pull/7",
        authorLogin: "reviewer",
        headRepositoryOwner: "acme",
        headRepositoryName: "review-repo",
        title: "Shared Issue review",
        body: "Review #142.",
        baseRefName: "main",
        baseOid: sourceOid,
        headRefName: "feature",
        headOid: sourceOid,
        updatedAt: "2026-08-20T00:00:00.000Z",
        state: "OPEN",
        isDraft: false,
      },
      { localRepositoryPath: repositoryPath, gitCommonDir: opened.branchReview.gitCommonDir },
      sourceOid,
    );
    await service.addPullRequestIssue(pullRequest.url, "#142");
    const removedPullRequestIssueComment = await service.createComment({
      pullRequestId: pullRequest.id,
      target: { kind: "issue", issue: "#142", startLine: null, endLine: null },
      body: "PR-owned Issue comment.",
    });

    expect(service.getIssueRemovalPreview("pull-request", pullRequest.id, "#142")).toMatchObject({
      counts: { issueWholeComments: 1, issueRangeComments: 0, replies: 0 },
      confirmationRequired: true,
    });
    service.removePullRequestIssue(pullRequest.url, "#142");
    expect(service.listPullRequestIssues(pullRequest.id)).toEqual([]);
    expect(database.getComment(removedPullRequestIssueComment.id)).toBeNull();
    expect(service.listBranchIssues(opened.branchReview.id)).toEqual([
      expect.objectContaining({ number: 142 }),
    ]);
    await service.addPullRequestIssue(pullRequest.url, "#142");
    const retainedPullRequestIssueComment = await service.createComment({
      pullRequestId: pullRequest.id,
      target: { kind: "issue", issue: "#142", startLine: null, endLine: null },
      body: "PR comment retained across Branch deletion.",
    });

    expect(service.getIssueRemovalPreview("branch", opened.branchReview.id, "#142")).toMatchObject({
      issue: { number: 142 },
      counts: { issueWholeComments: 0, issueRangeComments: 1, replies: 1 },
      confirmationRequired: true,
    });
    const removed = await service.removeBranchIssue(repositoryPath, "#142");
    expect(removed.deleted).toEqual({
      issueWholeComments: 0,
      issueRangeComments: 1,
      replies: 1,
    });
    expect(service.listBranchIssues(opened.branchReview.id)).toEqual([]);
    expect(database.getBranchComment(branchIssueComment.id)).toBeNull();
    expect(service.listPullRequestIssues(pullRequest.id)).toEqual([
      expect.objectContaining({ number: 142 }),
    ]);
    expect(database.getComment(retainedPullRequestIssueComment.id)).not.toBeNull();
    expect(database.getIssue(removed.issue.id)).not.toBeNull();

    await service.addBranchIssue(repositoryPath, "#143");
    await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid,
        path: "README.md",
        startLine: 1,
        endLine: 1,
      },
      body: "Branch code comment.",
    });
    await service.publishWalkthrough({
      review: { kind: "branch", repository: "acme/review-repo" },
      sourceOid,
      title: "Disposable Branch walkthrough",
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
    });
    const preview = await service.getBranchResetPreview(opened.branchReview.id);
    expect(preview).toMatchObject({
      counts: {
        branchReview: 1,
        issueMemberships: 1,
        codeComments: 1,
        walkthroughs: 1,
      },
      confirmationRequired: true,
    });
    expect(preview.retainedRefs.length).toBeGreaterThan(0);

    const reset = await service.resetBranchReview(opened.branchReview.id);
    expect(reset.deleted.gitRefs).toBe(preview.retainedRefs.length);
    expect(database.getBranchReview(opened.branchReview.id)).toBeNull();
    expect(service.listPullRequestIssues(pullRequest.id)).toHaveLength(1);
    expect(database.getComment(retainedPullRequestIssueComment.id)).not.toBeNull();
    await expect(
      service.git.listRefsByPrefix(repositoryPath, "refs/rvw/branch/acme/review-repo/commits/"),
    ).resolves.toEqual([]);

    const recreated = await service.openBranchReview(repositoryPath);
    expect(recreated.branchReview.id).not.toBe(opened.branchReview.id);
    expect(service.listBranchIssues(recreated.branchReview.id)).toEqual([]);
  });

  it("advances only the source snapshot and retains more than one hundred Issue memberships", async () => {
    const { repositoryPath, github, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    for (let number = 1; number <= 105; number += 1) {
      github.issues.set(number, issue(number));
      await service.addBranchIssue(repositoryPath, `#${number}`);
    }
    expect(service.listBranchIssues(opened.branchReview.id)).toHaveLength(105);
    expect(
      service
        .listBranchIssues(opened.branchReview.id)
        .slice(0, 3)
        .map(({ number }) => number),
    ).toEqual([105, 104, 103]);

    const previousHead = git(repositoryPath, "rev-parse", "HEAD");
    const comment = await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: previousHead,
        path: "README.md",
        startLine: 1,
        endLine: 1,
      },
      body: "Keep this source anchor.",
    });
    const previousReadme = git(repositoryPath, "show", `${previousHead}:README.md`);
    const nextHead = commitFile(
      repositoryPath,
      "README.md",
      `Inserted line\n${previousReadme}\n`,
      "advance",
    );
    github.repository = { ...github.repository, defaultBranchOid: nextHead };
    git(repositoryPath, "reset", "--hard", previousHead);
    const synchronized = await service.syncBranchReview(repositoryPath);
    expect(synchronized.branchReview.sourceOid).toBe(nextHead);
    expect(git(repositoryPath, "rev-parse", "HEAD")).toBe(previousHead);
    expect(await service.git.hasObject(repositoryPath, nextHead)).toBe(true);
    await expect(
      service.placeBranchCommentAtCommit(opened.branchReview.id, comment, previousHead),
    ).resolves.toEqual({
      outdated: false,
      range: { startLine: 1, endLine: 1 },
      path: "README.md",
    });
    await expect(service.getAnyCommentReviewContext(comment.ref)).resolves.toMatchObject({
      latestPlacement: { outdated: false, range: { startLine: 2, endLine: 2 } },
    });
    const historicalDocument = await service.getBranchDocument({
      kind: "repository-file",
      branchReviewId: opened.branchReview.id,
      sourceOid: previousHead,
      path: "README.md",
    });
    expect(historicalDocument.text).toContain(previousReadme);
  });

  it("accepts a reset when Git ref deletion reports an error after applying the transaction", async () => {
    const { repositoryPath, database, service } = setup(new DeleteThenThrowGitClient());
    const opened = await service.openBranchReview(repositoryPath);
    const preview = await service.getBranchResetPreview(opened.branchReview.id);
    expect(preview.retainedRefs.length).toBeGreaterThan(0);

    await expect(service.resetBranchReview(opened.branchReview.id)).resolves.toMatchObject({
      deleted: { gitRefs: preview.retainedRefs.length },
      removedRefs: preview.retainedRefs,
    });
    expect(database.getBranchReview(opened.branchReview.id)).toBeNull();
    await expect(
      service.git.listRefsByPrefix(repositoryPath, "refs/rvw/branch/acme/review-repo/commits/"),
    ).resolves.toEqual([]);
  });

  it("reports inconsistent local state when reset leaves retained refs behind", async () => {
    const { repositoryPath, service } = setup(new ThrowBeforeDeleteGitClient());
    const opened = await service.openBranchReview(repositoryPath);
    const preview = await service.getBranchResetPreview(opened.branchReview.id);

    await expect(service.resetBranchReview(opened.branchReview.id)).rejects.toMatchObject({
      code: "LOCAL_STATE_INCONSISTENT",
      details: {
        branchReviewDeleted: true,
        retainedRefs: preview.retainedRefs,
        remainingRefs: preview.retainedRefs,
      },
    });
  });
});
