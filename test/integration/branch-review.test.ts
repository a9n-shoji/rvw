import { mkdirSync, mkdtempSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RvwService } from "../../src/application/rvw-service.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepository,
  RepositoryIdentity,
} from "../../src/domain/models.js";
import { hashDocument } from "../../src/domain/pr-markdown.js";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import type { GitHubPort } from "../../src/infrastructure/github/github-client.js";
import {
  dispatchAgentSocketRequest,
  startAgentSocket,
  tryAgentSocketRequest,
} from "../../src/server/agent-socket.js";
import { createApp } from "../../src/server/app.js";
import { RvwError } from "../../src/shared/errors.js";
import { commitFile, createGitRepository, git } from "../fixtures/git-repository.js";

async function resetBranchReview(service: RvwService, branchReviewId: string) {
  const preview = await service.getBranchResetPreview(branchReviewId);
  return await service.resetBranchReview(branchReviewId, preview.confirmationToken);
}

async function resetBranchReviewAtPath(service: RvwService, repositoryPath: string) {
  const preview = await service.getBranchResetPreviewAtPath(repositoryPath);
  return await service.resetBranchReviewAtPath(repositoryPath, preview.confirmationToken);
}

async function removeBranchIssue(
  service: RvwService,
  repositoryPath: string,
  issueReference: string,
) {
  const preview = await service.getBranchIssueRemovalPreview(repositoryPath, issueReference);
  return await service.removeBranchIssue(repositoryPath, issueReference, preview.confirmationToken);
}

function deleteBranchWalkthrough(
  service: RvwService,
  branchReviewId: string,
  walkthroughId: string,
) {
  const walkthrough = service.getBranchWalkthrough(branchReviewId, walkthroughId);
  const preview = service.getWalkthroughDeletePreview(walkthrough.ref);
  return service.deleteBranchWalkthrough(branchReviewId, walkthroughId, preview.confirmationToken);
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

  async blockOnce(): Promise<boolean> {
    if (!this.armed) return false;
    this.armed = false;
    this.markBlocked();
    await this.releasePromise;
    return true;
  }

  async waitUntilBlocked(): Promise<void> {
    await this.blocked;
  }

  release(): void {
    this.releaseBlocked();
  }
}

class BranchGitHub implements GitHubPort {
  repositoryError: Error | null = null;
  repositoryRequests = 0;
  issueFetchDelayMs = 0;
  activeIssueFetches = 0;
  maxActiveIssueFetches = 0;
  repositoryBarrier: OneShotBarrier | null = null;
  issueBarrier: OneShotBarrier | null = null;
  issueFailureAfterBarrier: Error | null = null;

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

  async getRepository(identity: RepositoryIdentity): Promise<GitHubRepository> {
    this.repositoryRequests += 1;
    expect(identity.canonicalName).toBe("acme/review-repo");
    if (this.repositoryError) throw this.repositoryError;
    await this.repositoryBarrier?.blockOnce();
    return this.repository;
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    this.activeIssueFetches += 1;
    this.maxActiveIssueFetches = Math.max(this.maxActiveIssueFetches, this.activeIssueFetches);
    try {
      const waitedAtBarrier = (await this.issueBarrier?.blockOnce()) ?? false;
      if (waitedAtBarrier && this.issueFailureAfterBarrier) {
        throw this.issueFailureAfterBarrier;
      }
      if (this.issueFetchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.issueFetchDelayMs));
      }
      const issue = this.issues.get(number);
      if (!issue) throw new Error(`missing Issue #${number}`);
      return issue;
    } finally {
      this.activeIssueFetches -= 1;
    }
  }

  getAttachment() {
    return Promise.reject(new Error("Branch Review must not fetch GitHub attachments"));
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

class VerifyBranchRefBarrierGitClient extends GitClient {
  barrier: OneShotBarrier | null = null;

  override async verifyBranchCommitRef(cwd: string, branchReviewId: string, oid: string) {
    const result = await super.verifyBranchCommitRef(cwd, branchReviewId, oid);
    await this.barrier?.blockOnce();
    return result;
  }
}

class FailInitialBranchRefGitClient extends GitClient {
  private failed = false;

  override async ensureBranchCommitRef(cwd: string, branchReviewId: string, oid: string) {
    if (!this.failed) {
      this.failed = true;
      throw new Error("injected initial retained-ref failure");
    }
    return await super.ensureBranchCommitRef(cwd, branchReviewId, oid);
  }
}

class FailBranchRefForOidGitClient extends GitClient {
  constructor(private readonly rejectedOid: string) {
    super();
  }

  override async ensureBranchCommitRef(cwd: string, branchReviewId: string, oid: string) {
    if (oid === this.rejectedOid) throw new Error(`injected retained-ref failure for ${oid}`);
    return await super.ensureBranchCommitRef(cwd, branchReviewId, oid);
  }
}

class PauseBeforeInitialBranchRefGitClient extends GitClient {
  readonly barrier = new OneShotBarrier();

  override async ensureBranchCommitRef(cwd: string, branchReviewId: string, oid: string) {
    await this.barrier.blockOnce();
    return await super.ensureBranchCommitRef(cwd, branchReviewId, oid);
  }
}

class PauseBranchRefForOidGitClient extends GitClient {
  readonly barrier = new OneShotBarrier();
  failAfterRelease = false;

  constructor(private readonly pausedOid: string) {
    super();
  }

  override async ensureBranchCommitRef(cwd: string, branchReviewId: string, oid: string) {
    const retained = await super.ensureBranchCommitRef(cwd, branchReviewId, oid);
    if (oid === this.pausedOid) {
      await this.barrier.blockOnce();
      if (this.failAfterRelease) throw new Error(`late retained-ref failure for ${oid}`);
    }
    return retained;
  }
}

class PauseAfterBranchObjectForOidGitClient extends GitClient {
  readonly barrier = new OneShotBarrier();

  constructor(private readonly pausedOid: string) {
    super();
  }

  override async ensureBranchObject(input: Parameters<GitClient["ensureBranchObject"]>[0]) {
    await super.ensureBranchObject(input);
    if (input.oid === this.pausedOid) await this.barrier.blockOnce();
  }
}

class RemoteMoveOnceGitClient extends GitClient {
  ensureAttempts = 0;

  override async ensureBranchObject(input: Parameters<GitClient["ensureBranchObject"]>[0]) {
    this.ensureAttempts += 1;
    if (this.ensureAttempts === 1) {
      throw new RvwError(
        "GITHUB_REPOSITORY_ERROR",
        "取得中にdefault branch headが更新されました。",
        { details: { reason: "REMOTE_MOVED_DURING_SYNC" } },
      );
    }
    return await super.ensureBranchObject(input);
  }
}

class BranchRetainBarrierGitClient extends GitClient {
  private barrier: Promise<void> | null = null;
  private releaseBarrier: (() => void) | null = null;
  private arrivals = 0;

  armRetainBarrier(): void {
    this.arrivals = 0;
    this.barrier = new Promise((resolve) => {
      this.releaseBarrier = resolve;
    });
  }

  override async ensureBranchCommitRef(cwd: string, branchReviewId: string, oid: string) {
    const retained = await super.ensureBranchCommitRef(cwd, branchReviewId, oid);
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

function issue(
  number: number,
  body = `Requirement ${number}\nDetails`,
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

  function httpApp(service: RvwService) {
    return createApp(service, {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });
  }

  async function branchSnapshot(
    service: RvwService,
    database: RvwDatabase,
    repositoryPath: string,
    branchReviewId: string,
  ) {
    return {
      branchReview: database.getBranchReview(branchReviewId),
      issues: service.listBranchIssues(branchReviewId),
      comments: database.listBranchComments(branchReviewId),
      sequence: database.getReviewChangeSequence("branch", branchReviewId),
      refs: await service.git.listRefsByPrefix(
        repositoryPath,
        `refs/rvw/branch/${branchReviewId}/commits/`,
      ),
    };
  }

  it("loads Branch evidence once per review while classifying multiple retained refs", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const historicalOid = commitFile(
      repositoryPath,
      "historical.txt",
      "historical\n",
      "historical evidence",
    );
    await service.git.ensureBranchCommitRef(repositoryPath, opened.branchReview.id, historicalOid);
    const evidence = vi.spyOn(database, "listBranchEvidenceOids");

    const report = await service.doctor(repositoryPath);

    expect(report.branchRetainedRefs?.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ oid: opened.branchReview.sourceOid, status: "current" }),
        expect.objectContaining({ oid: historicalOid, status: "unreferenced" }),
      ]),
    );
    expect(evidence).toHaveBeenCalledTimes(1);
  });

  it("reuses one repository review across worktrees and survives a default branch rename", async () => {
    const { repositoryPath, sourceOid, github, service } = setup();
    const first = await service.openBranchReview(repositoryPath);
    expect(first).toMatchObject({
      fromCache: false,
      selectedRemote: {
        name: "origin",
        url: "https://github.com/acme/review-repo.git",
      },
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

  it("keeps destructive previews existing-only across direct, Agent socket, and HTTP boundaries", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.repositoryError = new Error("existing-only operations must not call GitHub");
    const sequence = database.getChangeSequence();
    const refs = await service.git.listRefsByPrefix(repositoryPath, "refs/rvw/branch/");

    await expect(service.getBranchResetPreviewAtPath(repositoryPath)).rejects.toMatchObject({
      code: "BRANCH_REVIEW_NOT_FOUND",
    });
    await expect(resetBranchReviewAtPath(service, repositoryPath)).rejects.toMatchObject({
      code: "BRANCH_REVIEW_NOT_FOUND",
    });
    await expect(
      service.getBranchIssueRemovalPreview(repositoryPath, "#142"),
    ).rejects.toMatchObject({ code: "BRANCH_REVIEW_NOT_FOUND" });
    await expect(removeBranchIssue(service, repositoryPath, "#142")).rejects.toMatchObject({
      code: "BRANCH_REVIEW_NOT_FOUND",
    });
    await expect(service.syncBranchReview(repositoryPath)).rejects.toMatchObject({
      code: "BRANCH_REVIEW_NOT_FOUND",
    });
    await expect(service.listBranchCommentContextsAtPath(repositoryPath)).rejects.toMatchObject({
      code: "BRANCH_REVIEW_NOT_FOUND",
    });

    for (const [operation, input] of [
      ["branch.reset.preview", { repositoryPath }],
      ["branch.reset", { repositoryPath, confirmed: true, confirmationToken: "a".repeat(64) }],
      ["branch.issue.remove.preview", { repositoryPath, issueReference: "#142" }],
      [
        "branch.issue.remove",
        {
          repositoryPath,
          issueReference: "#142",
          confirmed: true,
          confirmationToken: "a".repeat(64),
        },
      ],
    ] as const) {
      await expect(
        dispatchAgentSocketRequest(service, {
          protocolVersion: 1,
          operation,
          input,
        }),
      ).rejects.toMatchObject({ code: "BRANCH_REVIEW_NOT_FOUND" });
    }

    const app = createApp(service, {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });
    const resetResponse = await app.request(
      "http://127.0.0.1:4321/api/branch-reviews/00000000-0000-4000-8000-000000000000/reset",
      {
        method: "POST",
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        body: JSON.stringify({ yes: false }),
      },
    );
    expect(resetResponse.status).toBe(404);
    expect(await resetResponse.json()).toMatchObject({
      ok: false,
      error: { code: "BRANCH_REVIEW_NOT_FOUND" },
    });
    const issueResponse = await app.request(
      "http://127.0.0.1:4321/api/branch-reviews/00000000-0000-4000-8000-000000000000/issues/issue-142",
      {
        method: "DELETE",
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        body: JSON.stringify({ yes: false }),
      },
    );
    expect(issueResponse.status).toBe(404);
    expect(await issueResponse.json()).toMatchObject({
      ok: false,
      error: { code: "BRANCH_REVIEW_NOT_FOUND" },
    });

    expect(github.repositoryRequests).toBe(0);
    expect(database.findBranchReviewByIdentity("acme", "review-repo")).toBeNull();
    expect(database.getChangeSequence()).toBe(sequence);
    await expect(service.git.listRefsByPrefix(repositoryPath, "refs/rvw/branch/")).resolves.toEqual(
      refs,
    );
  });

  it("rejects stale destructive previews before Branch artifacts are deleted", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);
    const added = await service.addBranchIssue(repositoryPath, "#142");
    const walkthrough = (
      await service.publishWalkthrough({
        review: { kind: "branch", repository: "acme/review-repo" },
        sourceOid: opened.branchReview.sourceOid,
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
    const resetPreview = await service.getBranchResetPreview(opened.branchReview.id);
    const issuePreview = await service.getBranchIssueRemovalPreview(repositoryPath, "#142");
    const walkthroughPreview = service.getWalkthroughDeletePreview(walkthrough.ref);
    await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: { kind: "branch" },
      body: "Added after all previews.",
    });

    await expect(
      service.resetBranchReview(opened.branchReview.id, resetPreview.confirmationToken),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    await expect(
      service.removeBranchIssue(repositoryPath, "#142", issuePreview.confirmationToken),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    expect(() =>
      service.deleteBranchWalkthrough(
        opened.branchReview.id,
        walkthrough.id,
        walkthroughPreview.confirmationToken,
      ),
    ).toThrowError(expect.objectContaining({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 }));
    expect(database.getBranchReview(opened.branchReview.id)).not.toBeNull();
    expect(database.hasReviewIssue("branch", opened.branchReview.id, added.issue.id)).toBe(true);
    expect(database.getBranchWalkthrough(walkthrough.id)).not.toBeNull();

    const app = httpApp(service);
    const snapshot = await branchSnapshot(
      service,
      database,
      repositoryPath,
      opened.branchReview.id,
    );
    for (const request of [
      {
        endpoint: `/api/branch-reviews/${opened.branchReview.id}/reset`,
        method: "POST",
        confirmationToken: resetPreview.confirmationToken,
      },
      {
        endpoint: `/api/branch-reviews/${opened.branchReview.id}/issues/${added.issue.id}`,
        method: "DELETE",
        confirmationToken: issuePreview.confirmationToken,
      },
      {
        endpoint: `/api/branch-reviews/${opened.branchReview.id}/walkthroughs/${walkthrough.id}`,
        method: "DELETE",
        confirmationToken: walkthroughPreview.confirmationToken,
      },
    ]) {
      const response = await app.request(`http://127.0.0.1:4321${request.endpoint}`, {
        method: request.method,
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        body: JSON.stringify({ yes: true, confirmationToken: request.confirmationToken }),
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        ok: boolean;
        error: {
          code: string;
          details: {
            currentReviewChangeSequence: number;
            currentPreview: { reviewChangeSequence: number; confirmationToken: string };
          };
        };
      };
      expect(body).toMatchObject({
        ok: false,
        error: {
          code: "DESTRUCTIVE_PREVIEW_STALE",
          details: {
            currentReviewChangeSequence: snapshot.sequence,
            currentPreview: {
              reviewChangeSequence: snapshot.sequence,
            },
          },
        },
      });
      expect(body.error.details.currentPreview.confirmationToken).not.toBe(
        request.confirmationToken,
      );
    }
    expect(await branchSnapshot(service, database, repositoryPath, opened.branchReview.id)).toEqual(
      snapshot,
    );
  });

  it("keeps an HTTP sync bound to its stable Branch Review ID across reset and recreate", async () => {
    const { repositoryPath, github, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.repositoryBarrier = barrier;
    const app = httpApp(service);
    const request = app.request(
      `http://127.0.0.1:4321/api/branch-reviews/${opened.branchReview.id}/sync`,
      {
        method: "POST",
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    await barrier.waitUntilBlocked();

    await resetBranchReview(service, opened.branchReview.id);
    const replacement = await service.openBranchReview(repositoryPath);
    const before = await branchSnapshot(
      service,
      database,
      repositoryPath,
      replacement.branchReview.id,
    );
    barrier.release();

    const response = await request;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "BRANCH_REVIEW_NOT_FOUND" },
    });
    expect(
      await branchSnapshot(service, database, repositoryPath, replacement.branchReview.id),
    ).toEqual(before);
  });

  it("keeps an HTTP Issue addition bound to its stable Branch Review ID", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.issueBarrier = barrier;
    const app = httpApp(service);
    const request = app.request(
      `http://127.0.0.1:4321/api/branch-reviews/${opened.branchReview.id}/issues`,
      {
        method: "POST",
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        body: JSON.stringify({ issue: "#142" }),
      },
    );
    await barrier.waitUntilBlocked();

    await resetBranchReview(service, opened.branchReview.id);
    const replacement = await service.openBranchReview(repositoryPath);
    const before = await branchSnapshot(
      service,
      database,
      repositoryPath,
      replacement.branchReview.id,
    );
    barrier.release();

    const response = await request;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "BRANCH_REVIEW_NOT_FOUND" },
    });
    expect(database.findIssue("acme", "review-repo", 142)).toBeNull();
    expect(
      await branchSnapshot(service, database, repositoryPath, replacement.branchReview.id),
    ).toEqual(before);
  });

  it.each(["remove", "comments"] as const)(
    "keeps an HTTP %s operation bound to its stable Branch Review ID",
    async (operation) => {
      const gitClient = new VerifyBranchRefBarrierGitClient();
      const { repositoryPath, github, database, service } = setup(gitClient);
      github.issues.set(142, issue(142));
      const opened = await service.openBranchReview(repositoryPath);
      const added = await service.addBranchIssue(repositoryPath, "#142");
      await service.createBranchComment({
        branchReviewId: opened.branchReview.id,
        target: { kind: "branch" },
        body: "Old aggregate comment.",
      });
      const barrier = new OneShotBarrier();
      const removalPreview = await service.getBranchIssueRemovalPreviewById(
        opened.branchReview.id,
        added.issue.url,
      );
      barrier.arm();
      gitClient.barrier = barrier;
      const app = httpApp(service);
      const request =
        operation === "remove"
          ? app.request(
              `http://127.0.0.1:4321/api/branch-reviews/${opened.branchReview.id}/issues/${added.issue.id}`,
              {
                method: "DELETE",
                headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
                body: JSON.stringify({
                  yes: true,
                  confirmationToken: removalPreview.confirmationToken,
                }),
              },
            )
          : app.request(
              `http://127.0.0.1:4321/api/branch-reviews/${opened.branchReview.id}/comments`,
              { headers: { host: "127.0.0.1:4321" } },
            );
      await barrier.waitUntilBlocked();

      await resetBranchReview(service, opened.branchReview.id);
      const replacement = await service.openBranchReview(repositoryPath);
      await service.addBranchIssue(repositoryPath, "#142");
      await service.createBranchComment({
        branchReviewId: replacement.branchReview.id,
        target: { kind: "branch" },
        body: "Replacement aggregate comment.",
      });
      const before = await branchSnapshot(
        service,
        database,
        repositoryPath,
        replacement.branchReview.id,
      );
      barrier.release();

      const response = await request;
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "BRANCH_REVIEW_NOT_FOUND" },
      });
      expect(
        await branchSnapshot(service, database, repositoryPath, replacement.branchReview.id),
      ).toEqual(before);
      const socketInput =
        operation === "remove"
          ? {
              repositoryPath,
              issueReference: "#142",
              confirmed: true as const,
              confirmationToken: (
                await service.getBranchIssueRemovalPreview(repositoryPath, "#142")
              ).confirmationToken,
            }
          : { repositoryPath };
      await expect(
        dispatchAgentSocketRequest(service, {
          protocolVersion: 1,
          operation: operation === "remove" ? "branch.issue.remove" : "branch.comments",
          input: socketInput,
        }),
      ).resolves.toBeDefined();
    },
  );

  it("places Branch repository comments through the document-reference HTTP contract", async () => {
    const { repositoryPath, sourceOid, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const comment = await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid,
        path: "README.md",
        startLine: 1,
        endLine: 1,
      },
      body: "Keep this comment inline.",
    });
    const app = createApp(service, {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });
    const query = new URLSearchParams({
      kind: "repository-file",
      branchReviewId: opened.branchReview.id,
      sourceOid,
      path: "README.md",
    });

    const response = await app.request(
      `http://127.0.0.1:4321/api/comments/${comment.id}/placement?${query.toString()}`,
      { headers: { host: "127.0.0.1:4321" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      placement: {
        outdated: false,
        range: { startLine: 1, endLine: 1 },
        path: "README.md",
      },
    });
  });

  it("normalizes Issue bodies before hashing, displaying, and placing comments", async () => {
    const { repositoryPath, github, service } = setup();
    github.issues.set(142, issue(142, "First\r\nSecond\rThird"));
    const opened = await service.openBranchReview(repositoryPath);
    const added = await service.addBranchIssue(repositoryPath, "#142");

    expect(added.issue).toMatchObject({
      body: "First\nSecond\nThird",
      bodyHash: hashDocument("First\nSecond\nThird"),
    });
    await expect(
      service.getBranchDocument({
        kind: "issue-markdown",
        branchReviewId: opened.branchReview.id,
        issueId: added.issue.id,
      }),
    ).resolves.toMatchObject({ text: "First\nSecond\nThird" });

    const comment = await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: { kind: "issue", issue: "#142", startLine: 2, endLine: 2 },
      body: "Keep the normalized range current.",
    });
    expect(
      service.placeBranchIssueComment(opened.branchReview.id, comment, added.issue.id),
    ).toEqual({
      outdated: false,
      range: { startLine: 2, endLine: 2 },
      path: "#142",
    });
  });

  it.each([
    {
      label: "repository",
      returned: {
        ...issue(142),
        owner: "other",
        repository: "repo",
        canonicalName: "other/repo",
        url: "https://github.com/other/repo/issues/142",
      },
    },
    {
      label: "number",
      returned: {
        ...issue(143),
      },
    },
  ])(
    "rejects a fake GitHubPort Issue $label mismatch before cache writes",
    async ({ returned }) => {
      const { repositoryPath, github, database, service } = setup();
      const opened = await service.openBranchReview(repositoryPath);
      github.issues.set(142, returned);
      const sequence = database.getReviewChangeSequence("branch", opened.branchReview.id);

      await expect(service.addBranchIssue(repositoryPath, "#142")).rejects.toMatchObject({
        code: "GITHUB_ISSUE_ERROR",
        details: { reason: "ISSUE_IDENTITY_MISMATCH" },
      });
      expect(database.findIssue("acme", "review-repo", 142)).toBeNull();
      expect(service.listBranchIssues(opened.branchReview.id)).toEqual([]);
      expect(database.getReviewChangeSequence("branch", opened.branchReview.id)).toBe(sequence);
    },
  );

  it("keeps an existing Issue cache unchanged when refresh identity mismatches", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);
    const added = await service.addBranchIssue(repositoryPath, "#142");
    const cached = database.getIssue(added.issue.id);
    github.issues.set(142, {
      ...issue(142, "Wrong repository body"),
      owner: "other",
      repository: "repo",
      canonicalName: "other/repo",
      url: "https://github.com/other/repo/issues/142",
    });
    const sequence = database.getReviewChangeSequence("branch", opened.branchReview.id);

    const synchronized = await service.syncBranchReview(repositoryPath);
    expect(synchronized.issueResults).toHaveLength(1);
    expect(synchronized.issueResults[0]).toMatchObject({ ok: false, issue: cached });
    expect(synchronized.issueResults[0]?.ok).toBe(false);
    if (synchronized.issueResults[0]?.ok === false) {
      expect(synchronized.issueResults[0].error.code).toBe("GITHUB_ISSUE_ERROR");
    }
    expect(database.getIssue(added.issue.id)).toEqual(cached);
    expect(database.getReviewChangeSequence("branch", opened.branchReview.id)).toBe(sequence);
  });

  it("does not recreate a Branch Issue membership removed while sync is fetching it", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);
    const added = await service.addBranchIssue(repositoryPath, "#142");
    github.issues.set(142, issue(142, "Fetched after explicit removal"));
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.issueBarrier = barrier;

    const synchronization = service.syncBranchReview(repositoryPath);
    await barrier.waitUntilBlocked();
    await removeBranchIssue(service, repositoryPath, "#142");
    const sequenceAfterRemoval = database.getReviewChangeSequence("branch", opened.branchReview.id);
    const cacheAfterRemoval = database.getIssue(added.issue.id);
    barrier.release();

    const synchronized = await synchronization;
    expect(synchronized.issueResults).toEqual([
      expect.objectContaining({ ok: true, skipped: "membership-removed" }),
    ]);
    expect(service.listBranchIssues(opened.branchReview.id)).toEqual([]);
    expect(database.getIssue(added.issue.id)).toEqual(cacheAfterRemoval);
    expect(database.getReviewChangeSequence("branch", opened.branchReview.id)).toBe(
      sequenceAfterRemoval,
    );
  });

  it("does not warn when a Branch Issue fetch fails after its membership was removed", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);
    const added = await service.addBranchIssue(repositoryPath, "#142");
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.issueBarrier = barrier;
    github.issueFailureAfterBarrier = new Error("late GitHub failure");

    const synchronization = service.syncBranchReview(repositoryPath);
    await barrier.waitUntilBlocked();
    await removeBranchIssue(service, repositoryPath, "#142");
    const cacheAfterRemoval = database.getIssue(added.issue.id);
    const sequenceAfterRemoval = database.getReviewChangeSequence("branch", opened.branchReview.id);
    barrier.release();

    const synchronized = await synchronization;
    expect(synchronized.issueResults).toEqual([
      expect.objectContaining({ ok: true, skipped: "membership-removed" }),
    ]);
    expect(service.listBranchIssues(opened.branchReview.id)).toEqual([]);
    expect(database.getIssue(added.issue.id)).toEqual(cacheAfterRemoval);
    expect(database.getReviewChangeSequence("branch", opened.branchReview.id)).toBe(
      sequenceAfterRemoval,
    );
  });

  it("does not create a Branch Issue comment after its membership is concurrently removed", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    const fetchedIssue = issue(142);
    github.issues.set(142, fetchedIssue);
    const opened = await service.openBranchReview(repositoryPath);
    const added = await service.addBranchIssue(repositoryPath, "#142");
    const otherPullRequest = database.upsertPullRequest(
      {
        host: "github.com",
        owner: "acme",
        repository: "review-repo",
        number: 7,
        url: "https://github.com/acme/review-repo/pull/7",
        authorLogin: "reviewer",
        headRepositoryOwner: "acme",
        headRepositoryName: "review-repo",
        title: "Other Issue owner",
        body: "Review #142.",
        baseRefName: "main",
        baseOid: sourceOid,
        headRefName: "feature",
        headOid: sourceOid,
        updatedAt: "2026-08-20T00:00:00.000Z",
        state: "OPEN",
        isDraft: false,
      },
      {
        localRepositoryPath: repositoryPath,
        gitCommonDir: opened.branchReview.gitCommonDir,
      },
      sourceOid,
    );
    database.addReviewIssue("pull-request", otherPullRequest.id, fetchedIssue);
    const eventSequence = database.getLatestCommentPostEventSequence();
    let sequenceAfterRemoval = -1;
    const createBranchComment = database.createBranchComment.bind(database);
    vi.spyOn(database, "createBranchComment").mockImplementationOnce(
      (...args: Parameters<RvwDatabase["createBranchComment"]>) => {
        database.removeReviewIssue(
          "branch",
          opened.branchReview.id,
          added.issue.id,
          database.getReviewChangeSequence("branch", opened.branchReview.id),
        );
        sequenceAfterRemoval = database.getReviewChangeSequence("branch", opened.branchReview.id);
        return createBranchComment(...args);
      },
    );

    await expect(
      service.createBranchComment({
        branchReviewId: opened.branchReview.id,
        target: { kind: "issue", issue: "#142", startLine: null, endLine: null },
        body: "Must not outlive the membership checked by the application layer.",
      }),
    ).rejects.toMatchObject({ code: "ISSUE_NOT_FOUND", status: 404 });
    expect(database.hasReviewIssue("branch", opened.branchReview.id, added.issue.id)).toBe(false);
    expect(database.hasReviewIssue("pull-request", otherPullRequest.id, added.issue.id)).toBe(true);
    expect(database.getIssue(added.issue.id)).not.toBeNull();
    expect(database.listBranchComments(opened.branchReview.id)).toEqual([]);
    expect(database.listCommentPostEvents(eventSequence, 10)).toEqual([]);
    expect(database.getReviewChangeSequence("branch", opened.branchReview.id)).toBe(
      sequenceAfterRemoval,
    );
  });

  it("does not let a deleted Branch Review issue failure update replacement or shared owners", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);
    const added = await service.addBranchIssue(repositoryPath, "#142");
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
        body: "Manually tracked Issue.",
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
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.issueBarrier = barrier;
    github.issueFailureAfterBarrier = new Error("stale Branch Issue fetch failed");

    const staleSynchronization = service.syncBranchReview(repositoryPath);
    await barrier.waitUntilBlocked();
    await resetBranchReview(service, opened.branchReview.id);
    const replacement = await service.openBranchReview(repositoryPath);
    await service.addBranchIssue(repositoryPath, "#142");
    const replacementBefore = await branchSnapshot(
      service,
      database,
      repositoryPath,
      replacement.branchReview.id,
    );
    const pullRequestSequence = database.getReviewChangeSequence("pull-request", pullRequest.id);
    const sharedCache = database.getIssue(added.issue.id);
    barrier.release();

    await expect(staleSynchronization).rejects.toMatchObject({
      code: "BRANCH_REVIEW_NOT_FOUND",
    });
    expect(
      await branchSnapshot(service, database, repositoryPath, replacement.branchReview.id),
    ).toEqual(replacementBefore);
    expect(database.getReviewChangeSequence("pull-request", pullRequest.id)).toBe(
      pullRequestSequence,
    );
    expect(database.getIssue(added.issue.id)).toEqual(sharedCache);
  });

  it("validates Issue identity for Walkthrough membership fetches", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    github.issues.set(142, {
      ...issue(142),
      url: "https://github.com/other/repo/issues/142",
    });
    const sequence = database.getReviewChangeSequence("branch", opened.branchReview.id);

    await expect(
      service.publishWalkthrough({
        review: { kind: "branch", repository: "acme/review-repo" },
        sourceOid,
        title: "Must not publish",
        body: "Read [the fixture](rvw-ref:fixture).",
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
        issuesToAdd: ["#142"],
      }),
    ).rejects.toMatchObject({
      code: "GITHUB_ISSUE_ERROR",
      details: { reason: "ISSUE_IDENTITY_MISMATCH" },
    });
    expect(service.listBranchWalkthroughs(opened.branchReview.id)).toEqual([]);
    expect(service.listBranchIssues(opened.branchReview.id)).toEqual([]);
    expect(database.findIssue("acme", "review-repo", 142)).toBeNull();
    expect(database.getReviewChangeSequence("branch", opened.branchReview.id)).toBe(sequence);
  });

  it("rejects an independent clone without rebinding and permits it after an explicit reset", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const registered = database.getBranchReview(opened.branchReview.id);
    const retainedRefs = await service.git.listRefsByPrefix(
      repositoryPath,
      `refs/rvw/branch/${opened.branchReview.id}/commits/`,
    );
    const independentClone = createGitRepository("rvw-branch-independent-clone-");
    const independentContext = await service.git.repositoryContext(independentClone);

    await expect(service.openBranchReview(independentClone)).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
      details: {
        registeredPath: registered?.localRepositoryPath,
        currentPath: independentContext.worktreePath,
      },
    });
    for (const operation of [
      () => service.syncBranchReview(independentClone),
      () => service.addBranchIssue(independentClone, "#142"),
      () => service.getBranchResetPreviewAtPath(independentClone),
      () => resetBranchReviewAtPath(service, independentClone),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });
    }
    expect(database.getBranchReview(opened.branchReview.id)).toEqual(registered);
    await expect(
      service.git.listRefsByPrefix(
        repositoryPath,
        `refs/rvw/branch/${opened.branchReview.id}/commits/`,
      ),
    ).resolves.toEqual(retainedRefs);
    await expect(
      service.getBranchDocument({
        kind: "repository-file",
        branchReviewId: opened.branchReview.id,
        sourceOid,
        path: "README.md",
      }),
    ).resolves.toMatchObject({ text: "# Fixture\n" });

    await resetBranchReview(service, opened.branchReview.id);
    github.repository = {
      ...github.repository,
      defaultBranchOid: git(independentClone, "rev-parse", "HEAD"),
    };
    const recreated = await service.openBranchReview(independentClone);
    expect(recreated).toMatchObject({
      fromCache: false,
      branchReview: {
        localRepositoryPath: independentContext.worktreePath,
        gitCommonDir: independentContext.gitCommonDir,
      },
    });
    expect(recreated.branchReview.id).not.toBe(opened.branchReview.id);
  });

  it("fails closed before every mutation when the same clone remote changes identity", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    github.issues.set(143, issue(143));
    const opened = await service.openBranchReview(repositoryPath);
    await service.addBranchIssue(repositoryPath, "#142");
    const saved = database.getBranchReview(opened.branchReview.id);
    const sequence = database.getChangeSequence();
    const refs = await service.git.listRefsByPrefix(
      repositoryPath,
      `refs/rvw/branch/${opened.branchReview.id}/commits/`,
    );
    const githubRequests = github.repositoryRequests;
    git(repositoryPath, "remote", "set-url", "origin", "git@github.com:other-owner/other-repo.git");

    for (const operation of [
      () => service.openBranchReview(repositoryPath),
      () => service.syncBranchReview(repositoryPath),
      () => service.addBranchIssue(repositoryPath, "#143"),
      () => service.getBranchIssueRemovalPreview(repositoryPath, "#142"),
      () => removeBranchIssue(service, repositoryPath, "#142"),
      () => service.getBranchResetPreviewAtPath(repositoryPath),
      () => resetBranchReviewAtPath(service, repositoryPath),
      () => service.listBranchCommentContextsAtPath(repositoryPath),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });
    }
    for (const [operation, input] of [
      ["branch.sync", { repositoryPath }],
      ["branch.issue.add", { repositoryPath, issueReference: "#143" }],
      [
        "branch.issue.remove",
        {
          repositoryPath,
          issueReference: "#142",
          confirmed: true,
          confirmationToken: "a".repeat(64),
        },
      ],
      ["branch.reset.preview", { repositoryPath }],
      ["branch.reset", { repositoryPath, confirmed: true, confirmationToken: "a".repeat(64) }],
      ["branch.comments", { repositoryPath }],
    ] as const) {
      await expect(
        dispatchAgentSocketRequest(service, { protocolVersion: 1, operation, input }),
      ).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });
    }

    const app = createApp(service, {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });
    for (const endpoint of ["sync", "reset"]) {
      const response = await app.request(
        `http://127.0.0.1:4321/api/branch-reviews/${opened.branchReview.id}/${endpoint}`,
        {
          method: "POST",
          headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
          body: endpoint === "reset" ? JSON.stringify({ yes: false }) : JSON.stringify({}),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "REPOSITORY_MISMATCH" },
      });
    }

    expect(github.repositoryRequests).toBe(githubRequests);
    expect(database.getBranchReview(opened.branchReview.id)).toEqual(saved);
    expect(database.getChangeSequence()).toBe(sequence);
    await expect(
      service.git.listRefsByPrefix(
        repositoryPath,
        `refs/rvw/branch/${opened.branchReview.id}/commits/`,
      ),
    ).resolves.toEqual(refs);
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
      ...issue(142, "Canonical casing updated", "2026-08-20T01:00:00.000Z"),
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

  it("keeps Branch membership stale state in comment context and clears it through issuesToAdd", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);
    const added = await service.addBranchIssue(repositoryPath, "#142");
    const comment = await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: { kind: "issue", issue: "#142", startLine: 1, endLine: 1 },
      body: "Report the membership-specific stale state.",
    });
    database.setReviewIssueSyncError(
      "branch",
      opened.branchReview.id,
      added.issue.id,
      database.getIssueCacheGeneration(added.issue.id),
      "Branch-only refresh failure",
    );

    await expect(service.getAnyCommentReviewContext(comment.ref)).resolves.toMatchObject({
      issue: { number: 142, syncError: "Branch-only refresh failure", stale: true },
    });
    const ensured = await service.publishWalkthrough({
      review: { kind: "branch", repository: "acme/review-repo" },
      sourceOid: opened.branchReview.sourceOid,
      title: "Issue recovery",
      body: "Read [the repository](rvw-ref:source).",
      references: [
        {
          id: "source",
          label: "Repository",
          path: "README.md",
          startLine: 1,
          endLine: 1,
          description: null,
        },
      ],
      issuesToAdd: ["#142"],
    });
    expect(ensured.issuesAdded).toEqual([]);
    await expect(service.getAnyCommentReviewContext(comment.ref)).resolves.toMatchObject({
      issue: { number: 142, syncError: null, stale: false },
    });
  });

  it("keeps exact source comments, syncs Issue bodies, and emits Branch watch events", async () => {
    const { repositoryPath, github, service } = setup();
    github.issues.set(142, issue(142));
    github.issues.set(143, issue(143));
    const opened = await service.openBranchReview(repositoryPath);
    await service.addBranchIssue(repositoryPath, "#142");
    const published = await service.publishWalkthrough({
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
      issuesToAdd: ["#143"],
    });
    expect(published).toMatchObject({
      walkthrough: { branchReviewId: opened.branchReview.id },
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
    const wholeIssueComment = await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: { kind: "issue", issue: "#142", startLine: null, endLine: null },
      body: "Track this requirement as a whole.",
    });
    const issue142 = service
      .listBranchIssues(opened.branchReview.id)
      .find(({ number }) => number === 142)!;
    const issue143 = service
      .listBranchIssues(opened.branchReview.id)
      .find(({ number }) => number === 143)!;
    await expect(
      service.getBranchDocument({
        kind: "issue-markdown",
        branchReviewId: opened.branchReview.id,
        issueId: issue142.id,
      }),
    ).resolves.toMatchObject({ text: "Requirement 142\nDetails" });
    expect(service.placeBranchIssueComment(opened.branchReview.id, comment, issue142.id)).toEqual({
      outdated: false,
      range: { startLine: 1, endLine: 1 },
      path: "#142",
    });
    expect(service.placeBranchIssueComment(opened.branchReview.id, comment, issue143.id)).toEqual({
      outdated: true,
      range: null,
      path: null,
    });
    const events = service.listCommentPostEvents(undefined, 10);
    expect(events.events).toHaveLength(0);
    const replay = service.listCommentPostEvents(events.startCursor.replace(/:0$/, ":0"), 10);
    expect(replay.events).toEqual([]);
    const databaseEvents = service.database.listCommentPostEvents(0, 10);
    expect(databaseEvents.find((event) => event.commentRef === comment.ref)).toMatchObject({
      commentRef: comment.ref,
      context: {
        kind: "branch",
        branchReviewId: opened.branchReview.id,
        repository: "acme/review-repo",
      },
    });

    github.issues.set(142, issue(142, "Changed requirement\nDetails", "2026-08-20T01:00:00.000Z"));
    await service.syncBranchReview(repositoryPath);
    expect(
      service.placeBranchIssueComment(opened.branchReview.id, wholeIssueComment, issue142.id),
    ).toEqual({ outdated: false, range: null, path: "#142" });
    await expect(service.getAnyCommentReviewContext(comment.ref)).resolves.toMatchObject({
      context: {
        kind: "branch",
        branchReviewId: opened.branchReview.id,
        repository: "acme/review-repo",
      },
      issue: { number: 142, body: "Changed requirement\nDetails" },
      latestPlacement: { outdated: true },
    });
  });

  it("keeps Branch Walkthrough publish and update JSON shapes equal across direct and Agent socket transports", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    for (const number of [142, 143, 144, 145]) github.issues.set(number, issue(number));
    await service.openBranchReview(repositoryPath);
    const content = {
      sourceOid,
      title: "Direct transport",
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
    };
    const directPublish = await service.publishWalkthrough({
      review: { kind: "branch", repository: "acme/review-repo" },
      ...content,
      issuesToAdd: ["#142"],
    });
    const directUpdate = await service.updateWalkthrough(directPublish.walkthrough.ref, {
      ...content,
      title: "Direct update",
      issuesToAdd: ["#143"],
    });
    expect(JSON.parse(JSON.stringify(directPublish))).toMatchObject({
      walkthrough: { ref: directPublish.walkthrough.ref },
      issuesAdded: [{ number: 142 }],
    });
    expect(JSON.parse(JSON.stringify(directUpdate))).toMatchObject({
      walkthrough: { ref: directPublish.walkthrough.ref },
      issuesAdded: [{ number: 143 }],
    });

    const socketDirectory = mkdtempSync(path.join(os.tmpdir(), "rvw-branch-agent-socket-"));
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
          review: { kind: "branch", repository: "acme/review-repo" },
          ...content,
          title: "Socket transport",
          issuesToAdd: ["#144"],
        },
        { expectedDatabasePath: database.filePath },
      );
      if (!socketPublishResponse.available) throw new Error(socketPublishResponse.reason);
      const socketPublish = socketPublishResponse.result as typeof directPublish;
      const socketUpdateResponse = await tryAgentSocketRequest(
        "walkthrough.update",
        {
          uri: socketPublish.walkthrough.ref,
          content: { ...content, title: "Socket update", issuesToAdd: ["#145"] },
        },
        { expectedDatabasePath: database.filePath },
      );
      if (!socketUpdateResponse.available) throw new Error(socketUpdateResponse.reason);
      const socketUpdate = socketUpdateResponse.result as typeof directUpdate;

      expect(JSON.parse(JSON.stringify(socketPublish))).toMatchObject({
        walkthrough: { ref: socketPublish.walkthrough.ref },
        issuesAdded: [{ number: 144 }],
      });
      expect(JSON.parse(JSON.stringify(socketUpdate))).toMatchObject({
        walkthrough: { ref: socketPublish.walkthrough.ref },
        issuesAdded: [{ number: 145 }],
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

  it("returns current Branch metadata when the final reset CAS detects a concurrent sync", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const preview = await service.getBranchResetPreview(opened.branchReview.id);
    const resetBranchReviewInDatabase = database.resetBranchReview.bind(database);
    vi.spyOn(database, "resetBranchReview").mockImplementationOnce(
      (...args: Parameters<RvwDatabase["resetBranchReview"]>) => {
        database.setBranchSyncError(
          opened.branchReview.id,
          database.getBranchSourceSyncGeneration(opened.branchReview.id),
          "Concurrent synchronization failed.",
        );
        return resetBranchReviewInDatabase(...args);
      },
    );

    const error = (await service
      .resetBranchReview(opened.branchReview.id, preview.confirmationToken)
      .catch((caught: unknown) => caught)) as RvwError;
    expect(error).toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    expect(
      (
        error.details as {
          currentPreview: {
            branchReview: { sourceSyncError: string | null };
            reviewChangeSequence: number;
            confirmationToken: string;
          };
        }
      ).currentPreview,
    ).toMatchObject({
      branchReview: { sourceSyncError: "Concurrent synchronization failed." },
      reviewChangeSequence: database.getReviewChangeSequence("branch", opened.branchReview.id),
    });
    expect(
      (
        error.details as {
          currentPreview: { confirmationToken: string };
        }
      ).currentPreview.confirmationToken,
    ).not.toBe(preview.confirmationToken);
  });

  it("reports a concurrently requested Branch Issue in exactly one Walkthrough update", async () => {
    const gitClient = new BranchRetainBarrierGitClient();
    const { repositoryPath, sourceOid, github, service } = setup(gitClient);
    github.issues.set(142, issue(142));
    await service.openBranchReview(repositoryPath);
    const content = {
      sourceOid,
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
    };
    const first = await service.publishWalkthrough({
      review: { kind: "branch", repository: "acme/review-repo" },
      ...content,
      title: "Concurrent target A",
    });
    const second = await service.publishWalkthrough({
      review: { kind: "branch", repository: "acme/review-repo" },
      ...content,
      title: "Concurrent target B",
    });
    gitClient.armRetainBarrier();

    const results = await Promise.all([
      service.updateWalkthrough(first.walkthrough.ref, {
        ...content,
        title: "Concurrent update A",
        issuesToAdd: ["#142"],
      }),
      service.updateWalkthrough(second.walkthrough.ref, {
        ...content,
        title: "Concurrent update B",
        issuesToAdd: ["#142"],
      }),
    ]);

    expect(results.map((result) => result.issuesAdded.map((item) => item.number)).sort()).toEqual([
      [],
      [142],
    ]);
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
        issuesToAdd: ["#142", "#999"],
      }),
    ).rejects.toThrow("missing Issue #999");
    expect(service.listBranchWalkthroughs(opened.branchReview.id)).toEqual([]);
    expect(service.listBranchIssues(opened.branchReview.id)).toEqual([]);
  });

  it("places and deletes Branch Walkthrough comments through the shared viewer operations", async () => {
    const { repositoryPath, sourceOid, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const { walkthrough } = await service.publishWalkthrough({
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
    expect(deleteBranchWalkthrough(service, opened.branchReview.id, walkthrough.id)).toMatchObject({
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

    await expect(service.openBranchReview(repositoryPath)).resolves.toMatchObject({
      fromCache: true,
      branchReview: { id: opened.branchReview.id, sourceOid },
    });

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

  it("allows bound cached reads and local cleanup when the GitHub remote is unavailable", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);
    await service.addBranchIssue(repositoryPath, "#142");
    const repositoryRequests = github.repositoryRequests;
    git(repositoryPath, "remote", "remove", "origin");

    await expect(service.openBranchReview(repositoryPath)).resolves.toMatchObject({
      fromCache: true,
      branchReview: { id: opened.branchReview.id },
    });
    await expect(
      service.getBranchDocument({
        kind: "repository-file",
        branchReviewId: opened.branchReview.id,
        sourceOid,
        path: "README.md",
      }),
    ).resolves.toMatchObject({ availability: "available" });
    await expect(service.listBranchCommentContextsAtPath(repositoryPath)).resolves.toMatchObject({
      branchReview: { id: opened.branchReview.id },
    });
    await expect(service.syncBranchReview(repositoryPath)).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
    });
    await expect(service.addBranchIssue(repositoryPath, "#142")).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
    });
    expect(github.repositoryRequests).toBe(repositoryRequests);
    expect(database.getBranchReview(opened.branchReview.id)?.sourceSyncError).toBeNull();

    await expect(removeBranchIssue(service, repositoryPath, "#142")).resolves.toMatchObject({
      branchReview: { id: opened.branchReview.id },
    });
    await expect(resetBranchReviewAtPath(service, repositoryPath)).resolves.toMatchObject({
      branchReview: { id: opened.branchReview.id },
    });
  });

  it("moves a remote-less cached binding to another worktree in the same common directory", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const worktreeA = `${repositoryPath}-cached-a`;
    const worktreeB = `${repositoryPath}-cached-b`;
    git(repositoryPath, "worktree", "add", "--detach", worktreeA, sourceOid);
    git(repositoryPath, "worktree", "add", "--detach", worktreeB, sourceOid);
    const opened = await service.openBranchReview(worktreeA);
    const added = await service.addBranchIssue(worktreeA, "#142");
    const walkthrough = await service.publishWalkthrough({
      review: { kind: "branch", repository: "acme/review-repo" },
      sourceOid,
      title: "Cached worktree evidence",
      body: "Read [the fixture](rvw-ref:fixture).",
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
    });
    git(repositoryPath, "remote", "remove", "origin");
    git(repositoryPath, "worktree", "remove", "--force", worktreeA);

    const reopened = await service.openBranchReview(worktreeB);
    const worktreeBContext = await service.git.repositoryContext(worktreeB);
    expect(reopened).toMatchObject({
      fromCache: true,
      branchReview: {
        id: opened.branchReview.id,
        localRepositoryPath: worktreeBContext.worktreePath,
      },
    });
    const tree = await service.getBranchTree(opened.branchReview.id);
    expect(tree.entries.some((entry) => entry.path === "README.md")).toBe(true);
    await expect(
      service.getBranchDocument({
        kind: "repository-file",
        branchReviewId: opened.branchReview.id,
        sourceOid,
        path: "README.md",
      }),
    ).resolves.toMatchObject({ text: "# Fixture\n" });
    const search = await service.searchBranch(opened.branchReview.id, "Fixture", {
      matchCase: true,
      wholeWord: true,
    });
    expect(search.results.some((result) => result.path === "README.md")).toBe(true);
    const comment = await service.createBranchComment({
      branchReviewId: opened.branchReview.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid,
        path: "README.md",
        startLine: 1,
        endLine: 1,
      },
      body: "Place this from the surviving worktree.",
    });
    await expect(
      service.placeBranchCommentAtCommit(opened.branchReview.id, comment, sourceOid),
    ).resolves.toEqual({
      outdated: false,
      range: { startLine: 1, endLine: 1 },
      path: "README.md",
    });
    expect(
      service.getBranchWalkthrough(opened.branchReview.id, walkthrough.walkthrough.id),
    ).toEqual(walkthrough.walkthrough);
    expect(service.getReviewIssue("branch", opened.branchReview.id, added.issue.id)).toMatchObject({
      id: added.issue.id,
    });
    await expect(
      service.listBranchCommentContextsById(opened.branchReview.id),
    ).resolves.toHaveLength(1);

    const sequence = database.getReviewChangeSequence("branch", opened.branchReview.id);
    await expect(service.getBranchResetPreviewAtPath(worktreeB)).resolves.toMatchObject({
      branchReview: { id: opened.branchReview.id },
    });
    expect(database.getReviewChangeSequence("branch", opened.branchReview.id)).toBe(sequence);
    const independentClone = createGitRepository("rvw-branch-offline-independent-");
    git(independentClone, "remote", "remove", "origin");
    await expect(service.openBranchReview(independentClone)).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
    });
    await expect(resetBranchReviewAtPath(service, worktreeB)).resolves.toMatchObject({
      branchReview: { id: opened.branchReview.id },
    });
  });

  it("recovers process crashes before and after initial retained-ref creation", async () => {
    const { repositoryPath, github, database, service } = setup();
    const repository = await service.git.repositoryContext(repositoryPath);
    const beforeRef = database.beginBranchReviewInitialization(github.repository, {
      localRepositoryPath: repository.worktreePath,
      gitCommonDir: repository.gitCommonDir,
    }).branchReview;
    expect(beforeRef).toMatchObject({ initializationState: "pending", sourceSyncError: null });
    await expect(resetBranchReviewAtPath(service, repositoryPath)).resolves.toMatchObject({
      branchReview: { id: beforeRef.id },
      deleted: { branchReview: 1, gitRefs: 0 },
    });

    const afterRef = database.beginBranchReviewInitialization(github.repository, {
      localRepositoryPath: repository.worktreePath,
      gitCommonDir: repository.gitCommonDir,
    }).branchReview;
    await service.git.ensureBranchCommitRef(repositoryPath, afterRef.id, afterRef.sourceOid);
    const recovered = await service.openBranchReview(repositoryPath);
    expect(recovered).toMatchObject({
      fromCache: true,
      branchReview: { id: afterRef.id, initializationState: "ready", sourceSyncError: null },
    });
  });

  it("waits for an explicitly pending concurrent initialization beyond the old heuristic", async () => {
    const gitClient = new PauseBeforeInitialBranchRefGitClient();
    gitClient.barrier.arm();
    const { repositoryPath, database, service } = setup(gitClient);

    const firstOpen = service.openBranchReview(repositoryPath);
    await gitClient.barrier.waitUntilBlocked();
    expect(database.findBranchReviewByIdentity("acme", "review-repo")?.initializationState).toBe(
      "pending",
    );
    const startedAt = Date.now();
    const secondOpen = service.openBranchReview(repositoryPath);
    await new Promise((resolve) => setTimeout(resolve, 250));
    gitClient.barrier.release();

    const [first, second] = await Promise.all([firstOpen, secondOpen]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(second).toMatchObject({
      fromCache: true,
      branchReview: {
        id: first.branchReview.id,
        initializationState: "ready",
        sourceSyncError: null,
      },
    });
  });

  it("recovers an initial retained-ref failure through explicit Branch reset", async () => {
    const gitClient = new FailInitialBranchRefGitClient();
    const { repositoryPath, database, service } = setup(gitClient);

    await expect(service.openBranchReview(repositoryPath)).rejects.toMatchObject({
      code: "LOCAL_STATE_INCONSISTENT",
      details: {
        databaseUpdated: true,
        retainedRefCreated: false,
        repairableByExplicitReset: true,
      },
    });
    const uninitialized = database.findBranchReviewByIdentity("acme", "review-repo");
    expect(uninitialized).toMatchObject({ initializationState: "failed" });
    expect(uninitialized?.sourceSyncError).toBeTruthy();
    await expect(service.openBranchReview(repositoryPath)).rejects.toMatchObject({
      code: "LOCAL_STATE_INCONSISTENT",
    });
    await expect(service.syncBranchReview(repositoryPath)).rejects.toMatchObject({
      code: "LOCAL_STATE_INCONSISTENT",
    });
    const preview = await service.getBranchResetPreviewAtPath(repositoryPath);
    expect(preview).toMatchObject({
      branchReview: { id: uninitialized?.id },
      counts: { branchReview: 1, gitRefs: 0 },
    });
    await expect(resetBranchReviewAtPath(service, repositoryPath)).resolves.toMatchObject({
      branchReview: { id: uninitialized?.id },
      deleted: { branchReview: 1, gitRefs: 0 },
    });
    expect(database.getBranchReview(uninitialized!.id)).toBeNull();
    const recovered = await service.openBranchReview(repositoryPath);
    expect(recovered.branchReview.id).not.toBe(uninitialized!.id);
    await expect(
      service.git.verifyBranchCommitRef(
        repositoryPath,
        recovered.branchReview.id,
        recovered.branchReview.sourceOid,
      ),
    ).resolves.toBe(true);
  });

  it("cleans a delayed initial ref created after reset deleted its aggregate", async () => {
    const gitClient = new PauseBeforeInitialBranchRefGitClient();
    gitClient.barrier.arm();
    const { repositoryPath, database, service } = setup(gitClient);

    const opening = service.openBranchReview(repositoryPath);
    await gitClient.barrier.waitUntilBlocked();
    const pending = database.findBranchReviewByIdentity("acme", "review-repo");
    expect(pending).toMatchObject({ initializationState: "pending", sourceSyncError: null });
    await expect(resetBranchReviewAtPath(service, repositoryPath)).resolves.toMatchObject({
      branchReview: { id: pending!.id },
      deleted: { branchReview: 1, gitRefs: 0 },
    });

    gitClient.barrier.release();
    await expect(opening).rejects.toMatchObject({ code: "BRANCH_REVIEW_NOT_FOUND" });
    expect(database.getBranchReview(pending!.id)).toBeNull();
    await expect(
      service.git.listRefsByPrefix(repositoryPath, `refs/rvw/branch/${pending!.id}/commits/`),
    ).resolves.toEqual([]);
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
    removePullRequestIssue(service, pullRequest.url, "#142");
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
    const removed = await removeBranchIssue(service, repositoryPath, "#142");
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
    const unrelatedBranchRef = `refs/rvw/branch/00000000-0000-4000-8000-000000000099/commits/oid-${sourceOid}`;
    git(repositoryPath, "update-ref", unrelatedBranchRef, sourceOid);
    const preview = await service.getBranchResetPreview(opened.branchReview.id);
    expect(preview).toMatchObject({
      counts: {
        branchReview: 1,
        issueMemberships: 1,
        comments: 1,
        codeComments: 1,
        posts: 1,
        commentReferences: 0,
        targets: 1,
        walkthroughs: 1,
        walkthroughReferences: 1,
      },
      confirmationRequired: true,
    });
    expect(preview.retainedRefs.length).toBeGreaterThan(0);
    expect(preview.retainedRefs).not.toContain(unrelatedBranchRef);
    expect(preview.counts.gitRefs).toBe(preview.retainedRefs.length);

    const reset = await resetBranchReview(service, opened.branchReview.id);
    expect(reset.deleted.gitRefs).toBe(preview.retainedRefs.length);
    expect(database.getBranchReview(opened.branchReview.id)).toBeNull();
    expect(service.listPullRequestIssues(pullRequest.id)).toHaveLength(1);
    expect(database.getComment(retainedPullRequestIssueComment.id)).not.toBeNull();
    await expect(
      service.git.listRefsByPrefix(
        repositoryPath,
        `refs/rvw/branch/${opened.branchReview.id}/commits/`,
      ),
    ).resolves.toEqual([]);
    expect(git(repositoryPath, "rev-parse", "--verify", unrelatedBranchRef)).toBe(sourceOid);

    const recreated = await service.openBranchReview(repositoryPath);
    expect(recreated.branchReview.id).not.toBe(opened.branchReview.id);
    expect(service.listBranchIssues(recreated.branchReview.id)).toEqual([]);
  });

  it("notifies every owning Review only when a shared Issue cache changes", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openBranchReview(repositoryPath);
    await service.addBranchIssue(repositoryPath, "#142");
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

    const unchangedPullRequestSequence = database.getReviewChangeSequence(
      "pull-request",
      pullRequest.id,
    );
    await service.syncBranchReview(repositoryPath);
    expect(database.getReviewChangeSequence("pull-request", pullRequest.id)).toBe(
      unchangedPullRequestSequence,
    );

    github.issues.set(
      142,
      issue(142, "Requirement 142\nUpdated shared evidence", "2026-08-20T01:00:00.000Z"),
    );
    const branchSequence = database.getReviewChangeSequence("branch", opened.branchReview.id);
    await service.syncBranchReview(repositoryPath);

    expect(database.getReviewChangeSequence("pull-request", pullRequest.id)).toBeGreaterThan(
      unchangedPullRequestSequence,
    );
    expect(database.getReviewChangeSequence("branch", opened.branchReview.id)).toBeGreaterThan(
      branchSequence,
    );
    expect(service.listPullRequestIssues(pullRequest.id)).toEqual([
      expect.objectContaining({ body: "Requirement 142\nUpdated shared evidence" }),
    ]);
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
    github.maxActiveIssueFetches = 0;
    github.issueFetchDelayMs = 5;
    const synchronized = await service.syncBranchReview(repositoryPath);
    expect(github.maxActiveIssueFetches).toBe(8);
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
  }, 10_000);

  it("rejects locally available commits outside the current or retained Branch source", async () => {
    const { repositoryPath, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const unretainedOid = commitFile(
      repositoryPath,
      "topic-only.txt",
      "This commit was never synchronized as the default branch.\n",
      "local topic commit",
    );
    expect(await service.git.hasObject(repositoryPath, unretainedOid)).toBe(true);

    await expect(
      service.getBranchDocument({
        kind: "repository-file",
        branchReviewId: opened.branchReview.id,
        sourceOid: unretainedOid,
        path: "topic-only.txt",
      }),
    ).rejects.toMatchObject({ code: "COMMIT_NOT_FOUND" });

    await expect(
      service.createBranchComment({
        branchReviewId: opened.branchReview.id,
        target: {
          kind: "document",
          documentKind: "repository-file",
          sourceOid: opened.branchReview.sourceOid,
          path: "README.md",
          startLine: 1,
          endLine: 1,
        },
        body: "The local topic commit must not become Branch evidence.",
        relatedCommitOid: unretainedOid,
        references: [],
      }),
    ).rejects.toMatchObject({ code: "COMMIT_NOT_FOUND" });
  });

  it("accepts a reset when Git ref deletion reports an error after applying the transaction", async () => {
    const { repositoryPath, database, service } = setup(new DeleteThenThrowGitClient());
    const opened = await service.openBranchReview(repositoryPath);
    const preview = await service.getBranchResetPreview(opened.branchReview.id);
    expect(preview.retainedRefs.length).toBeGreaterThan(0);

    await expect(resetBranchReview(service, opened.branchReview.id)).resolves.toMatchObject({
      deleted: { gitRefs: preview.retainedRefs.length },
      removedRefs: preview.retainedRefs,
    });
    expect(database.getBranchReview(opened.branchReview.id)).toBeNull();
    await expect(
      service.git.listRefsByPrefix(
        repositoryPath,
        `refs/rvw/branch/${opened.branchReview.id}/commits/`,
      ),
    ).resolves.toEqual([]);
  });

  it("returns a completed-with-orphan-refs outcome when reset leaves retained refs behind", async () => {
    const { repositoryPath, service } = setup(new ThrowBeforeDeleteGitClient());
    const opened = await service.openBranchReview(repositoryPath);
    const preview = await service.getBranchResetPreview(opened.branchReview.id);

    await expect(resetBranchReview(service, opened.branchReview.id)).resolves.toMatchObject({
      outcome: {
        kind: "completed-with-orphan-refs",
        branchReviewDeleted: true,
        remainingRefs: preview.retainedRefs,
      },
    });
  });

  it("isolates orphan refs from a replacement Branch Review after reset failure", async () => {
    const { repositoryPath, github, database, service } = setup(new ThrowBeforeDeleteGitClient());
    const old = await service.openBranchReview(repositoryPath);
    const oldOid = old.branchReview.sourceOid;
    const nextOid = commitFile(repositoryPath, "README.md", "# Replacement\n", "replace source");
    github.repository = { ...github.repository, defaultBranchOid: nextOid };
    const oldPrefix = `refs/rvw/branch/${old.branchReview.id}/commits/`;
    const oldPreview = await service.getBranchResetPreview(old.branchReview.id);

    await expect(resetBranchReview(service, old.branchReview.id)).resolves.toMatchObject({
      outcome: {
        kind: "completed-with-orphan-refs",
        branchReviewDeleted: true,
        refPrefix: oldPrefix,
        remainingRefs: oldPreview.retainedRefs,
      },
    });
    expect(database.getBranchReview(old.branchReview.id)).toBeNull();
    const doctor = await service.doctor(repositoryPath);
    expect(doctor.branchRetainedRefs).not.toBeNull();
    for (const ref of oldPreview.retainedRefs) {
      expect(doctor.branchRetainedRefs?.refs).toContainEqual({
        ref,
        reviewId: old.branchReview.id,
        oid: oldOid,
        status: "orphan-review",
      });
    }
    await expect(service.git.listRefsByPrefix(repositoryPath, oldPrefix)).resolves.toEqual(
      oldPreview.retainedRefs,
    );

    const replacement = await service.openBranchReview(repositoryPath);
    const newPrefix = `refs/rvw/branch/${replacement.branchReview.id}/commits/`;
    expect(replacement.branchReview.id).not.toBe(old.branchReview.id);
    expect(newPrefix).not.toBe(oldPrefix);
    await expect(service.git.listRefsByPrefix(repositoryPath, newPrefix)).resolves.toEqual([
      expect.stringContaining(`oid-${nextOid}`),
    ]);
    await expect(
      service.git.verifyBranchCommitRef(repositoryPath, replacement.branchReview.id, oldOid),
    ).resolves.toBe(false);
    await expect(
      service.getBranchDocument({
        kind: "repository-file",
        branchReviewId: replacement.branchReview.id,
        sourceOid: oldOid,
        path: "README.md",
      }),
    ).rejects.toMatchObject({ code: "COMMIT_NOT_FOUND" });
    await expect(
      service.createBranchComment({
        branchReviewId: replacement.branchReview.id,
        target: {
          kind: "document",
          documentKind: "repository-file",
          sourceOid: nextOid,
          path: "README.md",
          startLine: 1,
          endLine: 1,
        },
        body: "Do not inherit the discarded aggregate evidence.",
        relatedCommitOid: oldOid,
      }),
    ).rejects.toMatchObject({ code: "COMMIT_NOT_FOUND" });
    await expect(
      service.publishWalkthrough({
        review: { kind: "branch", repository: "acme/review-repo" },
        sourceOid: oldOid,
        title: "Discarded source",
        body: "Read [the old source](rvw-ref:old).",
        references: [
          {
            id: "old",
            label: "Old source",
            path: "README.md",
            startLine: 1,
            endLine: 1,
            description: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const newRefs = await service.git.listRefsByPrefix(repositoryPath, newPrefix);
    await expect(resetBranchReview(service, old.branchReview.id)).rejects.toMatchObject({
      code: "BRANCH_REVIEW_NOT_FOUND",
    });
    await expect(service.git.listRefsByPrefix(repositoryPath, newPrefix)).resolves.toEqual(newRefs);
  });

  it("validates a stored repository path before deleting its Branch Review row", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const saved = database.getBranchReview(opened.branchReview.id);
    const sequence = database.getChangeSequence();
    const archivedPath = `${repositoryPath}-original`;
    renameSync(repositoryPath, archivedPath);
    mkdirSync(repositoryPath);
    git(repositoryPath, "init", "-b", "main");
    git(repositoryPath, "remote", "add", "origin", "https://github.com/acme/review-repo.git");

    await expect(resetBranchReview(service, opened.branchReview.id)).rejects.toMatchObject({
      code: "LOCAL_STATE_INCONSISTENT",
    });
    expect(database.getBranchReview(opened.branchReview.id)).toEqual(saved);
    expect(database.getChangeSequence()).toBe(sequence);
  });

  it("serializes concurrent first opens across independent database connections", async () => {
    const repositoryPath = createGitRepository("rvw-branch-concurrent-open-");
    const sourceOid = git(repositoryPath, "rev-parse", "HEAD");
    const repository = {
      host: "github.com" as const,
      owner: "acme",
      repository: "review-repo",
      canonicalName: "acme/review-repo",
      defaultBranchName: "main",
      defaultBranchOid: sourceOid,
    };
    const filePath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "rvw-branch-concurrent-db-")),
      "rvw.db",
    );
    const firstDatabase = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    const secondDatabase = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    databases.push(firstDatabase, secondDatabase);
    const firstService = new RvwService(
      firstDatabase,
      new GitClient(),
      new BranchGitHub(repository),
    );
    const secondService = new RvwService(
      secondDatabase,
      new GitClient(),
      new BranchGitHub(repository),
    );

    const [first, second] = await Promise.all([
      firstService.openBranchReview(repositoryPath),
      secondService.openBranchReview(repositoryPath),
    ]);

    expect(first.branchReview.id).toBe(second.branchReview.id);
    expect(firstDatabase.findBranchReviewByIdentity("ACME", "REVIEW-REPO")?.id).toBe(
      first.branchReview.id,
    );
    expect(secondDatabase.findBranchReviewByGitCommonDir(first.branchReview.gitCommonDir)?.id).toBe(
      first.branchReview.id,
    );
    expect(() =>
      firstDatabase.beginBranchReviewInitialization(
        {
          ...repository,
          owner: "other-owner",
          repository: "other-repo",
          canonicalName: "other-owner/other-repo",
        },
        {
          localRepositoryPath: repositoryPath,
          gitCommonDir: first.branchReview.gitCommonDir,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "REPOSITORY_MISMATCH" }));
    expect(() =>
      firstDatabase.beginBranchReviewInitialization(repository, {
        localRepositoryPath: "/independent-clone",
        gitCommonDir: "/independent-clone/.git",
      }),
    ).toThrowError(expect.objectContaining({ code: "REPOSITORY_MISMATCH" }));
  });

  it("discards a pre-aggregate snapshot before joining a concurrent first-open winner", async () => {
    const repositoryPath = createGitRepository("rvw-branch-pre-aggregate-snapshot-");
    const sourceX = git(repositoryPath, "rev-parse", "HEAD");
    const sourceY = commitFile(repositoryPath, "newer-source.txt", "newer\n", "newer source");
    const baseRepository = {
      host: "github.com" as const,
      owner: "acme",
      repository: "review-repo",
      canonicalName: "acme/review-repo",
      defaultBranchName: "main",
    };
    const filePath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "rvw-branch-pre-aggregate-db-")),
      "rvw.db",
    );
    const staleDatabase = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    const winnerDatabase = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    databases.push(staleDatabase, winnerDatabase);
    const staleGithub = new BranchGitHub({ ...baseRepository, defaultBranchOid: sourceX });
    const staleGit = new PauseAfterBranchObjectForOidGitClient(sourceX);
    staleGit.barrier.arm();
    const staleService = new RvwService(staleDatabase, staleGit, staleGithub);
    const winnerService = new RvwService(
      winnerDatabase,
      new GitClient(),
      new BranchGitHub({ ...baseRepository, defaultBranchOid: sourceY }),
    );

    const staleOpen = staleService.openBranchReview(repositoryPath);
    await staleGit.barrier.waitUntilBlocked();
    expect(staleDatabase.findBranchReviewByIdentity("acme", "review-repo")).toBeNull();

    const winner = await winnerService.openBranchReview(repositoryPath);
    expect(winner.branchReview.sourceOid).toBe(sourceY);
    staleGithub.repository = { ...baseRepository, defaultBranchOid: sourceY };
    staleGit.barrier.release();

    await expect(staleOpen).resolves.toMatchObject({
      branchReview: { id: winner.branchReview.id, sourceOid: sourceY },
    });
    expect(staleGithub.repositoryRequests).toBe(2);
    expect(staleDatabase.getBranchReview(winner.branchReview.id)).toMatchObject({
      sourceOid: sourceY,
      sourceSyncError: null,
    });
    await expect(
      staleGit.verifyBranchCommitRef(repositoryPath, winner.branchReview.id, sourceX),
    ).resolves.toBe(false);
    await expect(
      staleGit.verifyBranchCommitRef(repositoryPath, winner.branchReview.id, sourceY),
    ).resolves.toBe(true);
  });

  it("keeps historical evidence when a delayed initializer finishes after source advancement", async () => {
    const repositoryPath = createGitRepository("rvw-branch-delayed-initializer-");
    const sourceX = git(repositoryPath, "rev-parse", "HEAD");
    const sourceY = commitFile(repositoryPath, "later.txt", "later\n", "advance source");
    const baseRepository = {
      host: "github.com" as const,
      owner: "acme",
      repository: "review-repo",
      canonicalName: "acme/review-repo",
      defaultBranchName: "main",
    };
    const filePath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "rvw-branch-delayed-initializer-db-")),
      "rvw.db",
    );
    const delayedDatabase = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    const currentDatabase = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    databases.push(delayedDatabase, currentDatabase);
    const delayedGit = new PauseBranchRefForOidGitClient(sourceX);
    delayedGit.barrier.arm();
    const delayedService = new RvwService(
      delayedDatabase,
      delayedGit,
      new BranchGitHub({ ...baseRepository, defaultBranchOid: sourceX }),
    );
    const currentGithub = new BranchGitHub({ ...baseRepository, defaultBranchOid: sourceX });
    const currentService = new RvwService(currentDatabase, new GitClient(), currentGithub);

    const delayedOpen = delayedService.openBranchReview(repositoryPath);
    await delayedGit.barrier.waitUntilBlocked();
    const pending = delayedDatabase.findBranchReviewByIdentity("acme", "review-repo");
    expect(pending).toMatchObject({
      sourceOid: sourceX,
      initializationState: "pending",
      sourceSyncError: null,
    });

    const initialized = await currentService.openBranchReview(repositoryPath);
    expect(initialized.branchReview).toMatchObject({
      id: pending!.id,
      sourceOid: sourceX,
      initializationState: "ready",
      sourceSyncError: null,
    });
    const comment = await currentService.createBranchComment({
      branchReviewId: initialized.branchReview.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: sourceX,
        path: "README.md",
        startLine: 1,
        endLine: 1,
      },
      body: "This thread owns the initial exact source.",
    });

    currentGithub.repository = { ...baseRepository, defaultBranchOid: sourceY };
    await expect(currentService.syncBranchReview(repositoryPath)).resolves.toMatchObject({
      branchReview: { id: initialized.branchReview.id, sourceOid: sourceY },
    });
    delayedGit.barrier.release();

    await expect(delayedOpen).resolves.toMatchObject({
      branchReview: { id: initialized.branchReview.id, sourceOid: sourceY },
    });
    await expect(
      delayedGit.verifyBranchCommitRef(repositoryPath, initialized.branchReview.id, sourceX),
    ).resolves.toBe(true);
    await expect(
      delayedGit.verifyBranchCommitRef(repositoryPath, initialized.branchReview.id, sourceY),
    ).resolves.toBe(true);
    await expect(currentService.getAnyCommentReviewContext(comment.ref)).resolves.toMatchObject({
      context: { kind: "branch", branchReviewId: initialized.branchReview.id },
      exactSource: { sourceOid: sourceX, availability: "available" },
    });
    await expect(
      currentService.getBranchDocument({
        kind: "repository-file",
        branchReviewId: initialized.branchReview.id,
        sourceOid: sourceX,
        path: "README.md",
      }),
    ).resolves.toMatchObject({ availability: "available" });
  });

  it("publishes only the newest started Branch source sync", async () => {
    const { repositoryPath, github, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const sourceX = commitFile(repositoryPath, "source-x.txt", "x\n", "source X");
    const sourceY = commitFile(repositoryPath, "source-y.txt", "y\n", "source Y");
    const gitClient = new PauseBranchRefForOidGitClient(sourceX);
    const orderedService = new RvwService(database, gitClient, github);
    github.repository = { ...github.repository, defaultBranchOid: sourceX };
    gitClient.barrier.arm();

    const olderSync = orderedService.syncBranchReview(repositoryPath);
    await gitClient.barrier.waitUntilBlocked();
    github.repository = { ...github.repository, defaultBranchOid: sourceY };
    const newerSync = await orderedService.syncBranchReview(repositoryPath);
    expect(newerSync.branchReview).toMatchObject({
      id: opened.branchReview.id,
      sourceOid: sourceY,
    });

    gitClient.barrier.release();
    await expect(olderSync).resolves.toMatchObject({
      branchReview: { id: opened.branchReview.id, sourceOid: sourceY },
    });
    expect(database.getBranchReview(opened.branchReview.id)).toMatchObject({
      sourceOid: sourceY,
      sourceSyncError: null,
    });
  });

  it("does not let an older Branch source failure mark a newer success stale", async () => {
    const { repositoryPath, github, database, service } = setup();
    const opened = await service.openBranchReview(repositoryPath);
    const sourceX = commitFile(repositoryPath, "failing-x.txt", "x\n", "failing source X");
    const sourceY = commitFile(repositoryPath, "successful-y.txt", "y\n", "successful source Y");
    const gitClient = new PauseBranchRefForOidGitClient(sourceX);
    gitClient.failAfterRelease = true;
    const orderedService = new RvwService(database, gitClient, github);
    github.repository = { ...github.repository, defaultBranchOid: sourceX };
    gitClient.barrier.arm();

    const olderSync = orderedService.syncBranchReview(repositoryPath);
    await gitClient.barrier.waitUntilBlocked();
    github.repository = { ...github.repository, defaultBranchOid: sourceY };
    await orderedService.syncBranchReview(repositoryPath);
    const sequenceAfterNewerSuccess = database.getReviewChangeSequence(
      "branch",
      opened.branchReview.id,
    );

    gitClient.barrier.release();
    await expect(olderSync).rejects.toThrow(`late retained-ref failure for ${sourceX}`);
    expect(database.getBranchReview(opened.branchReview.id)).toMatchObject({
      sourceOid: sourceY,
      sourceSyncError: null,
    });
    expect(database.getReviewChangeSequence("branch", opened.branchReview.id)).toBe(
      sequenceAfterNewerSuccess,
    );
  });

  it("re-reads GitHub repository metadata once when the default branch moves during fetch", async () => {
    const gitClient = new RemoteMoveOnceGitClient();
    const { repositoryPath, github, service } = setup(gitClient);
    const firstSnapshot = { ...github.repository };
    const secondSource = commitFile(
      repositoryPath,
      "moved-during-fetch.txt",
      "new head\n",
      "move during fetch",
    );
    const secondSnapshot = { ...github.repository, defaultBranchOid: secondSource };
    let metadataRequests = 0;
    github.getRepository = () => {
      metadataRequests += 1;
      return Promise.resolve(metadataRequests === 1 ? firstSnapshot : secondSnapshot);
    };

    const opened = await service.openBranchReview(repositoryPath);
    expect(opened.branchReview.sourceOid).toBe(secondSource);
    expect(metadataRequests).toBe(2);
    expect(gitClient.ensureAttempts).toBe(2);
  });

  it("does not publish a concurrent first-open source before its owned ref exists", async () => {
    const repositoryPath = createGitRepository("rvw-branch-concurrent-oid-");
    const sourceX = git(repositoryPath, "rev-parse", "HEAD");
    const sourceY = commitFile(repositoryPath, "later.txt", "later\n", "advance default branch");
    const baseRepository = {
      host: "github.com" as const,
      owner: "acme",
      repository: "review-repo",
      canonicalName: "acme/review-repo",
      defaultBranchName: "main",
    };
    const filePath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "rvw-branch-concurrent-oid-db-")),
      "rvw.db",
    );
    const firstDatabase = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    const secondDatabase = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    databases.push(firstDatabase, secondDatabase);
    const firstService = new RvwService(
      firstDatabase,
      new GitClient(),
      new BranchGitHub({ ...baseRepository, defaultBranchOid: sourceX }),
    );
    const secondGithub = new BranchGitHub({ ...baseRepository, defaultBranchOid: sourceY });
    const repositoryBarrier = new OneShotBarrier();
    repositoryBarrier.arm();
    secondGithub.repositoryBarrier = repositoryBarrier;
    const secondService = new RvwService(
      secondDatabase,
      new FailBranchRefForOidGitClient(sourceY),
      secondGithub,
    );

    const secondOpen = secondService.openBranchReview(repositoryPath);
    await repositoryBarrier.waitUntilBlocked();
    expect(secondDatabase.findBranchReviewByIdentity("acme", "review-repo")).toBeNull();

    const firstOpen = await firstService.openBranchReview(repositoryPath);
    const firstSnapshot = firstDatabase.getBranchReview(firstOpen.branchReview.id);
    const sequence = firstDatabase.getReviewChangeSequence("branch", firstOpen.branchReview.id);
    expect(firstSnapshot).toMatchObject({ sourceOid: sourceX, sourceSyncError: null });
    await expect(
      firstService.git.verifyBranchCommitRef(repositoryPath, firstOpen.branchReview.id, sourceX),
    ).resolves.toBe(true);

    repositoryBarrier.release();
    await expect(secondOpen).rejects.toThrow(`injected retained-ref failure for ${sourceY}`);

    expect(secondDatabase.getBranchReview(firstOpen.branchReview.id)).toMatchObject({
      id: firstOpen.branchReview.id,
      sourceOid: sourceX,
      sourceSyncError: `injected retained-ref failure for ${sourceY}`,
    });
    expect(secondDatabase.getReviewChangeSequence("branch", firstOpen.branchReview.id)).toBe(
      sequence + 1,
    );
    await expect(
      secondService.git.verifyBranchCommitRef(repositoryPath, firstOpen.branchReview.id, sourceY),
    ).resolves.toBe(false);
    await expect(firstService.openBranchReview(repositoryPath)).resolves.toMatchObject({
      fromCache: true,
      branchReview: { id: firstOpen.branchReview.id, sourceOid: sourceX },
    });
  });
});
