import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RvwService } from "../../src/application/rvw-service.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepository,
  RepositoryResetCounts,
  RepositoryReview,
  RepositoryIdentity,
} from "../../src/domain/models.js";
import { hashDocument } from "../../src/domain/pr-markdown.js";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import type { GitHubPort } from "../../src/infrastructure/github/github-client.js";
import {
  AGENT_SOCKET_PROTOCOL_VERSION,
  dispatchAgentSocketRequest,
  startAgentSocket,
  tryAgentSocketRequest,
} from "../../src/server/agent-socket.js";
import { createApp } from "../../src/server/app.js";
import { RvwError } from "../../src/shared/errors.js";
import {
  commitFile,
  configureTestGitRepository,
  createGitRepository,
  git,
} from "../fixtures/git-repository.js";

async function resetRepositoryReview(service: RvwService, repositoryReviewId: string) {
  const preview = await service.getRepositoryResetPreview(repositoryReviewId);
  return await service.resetRepositoryReview(repositoryReviewId, preview.confirmationToken);
}

async function resetRepositoryReviewAtPath(service: RvwService, repositoryPath: string) {
  const preview = await service.getRepositoryResetPreviewAtPath(repositoryPath);
  return await service.resetRepositoryReviewAtPath(repositoryPath, preview.confirmationToken);
}

async function removeRepositoryIssue(
  service: RvwService,
  repositoryPath: string,
  issueReference: string,
) {
  const preview = await service.getRepositoryIssueRemovalPreview(repositoryPath, issueReference);
  return await service.removeRepositoryIssue(
    repositoryPath,
    issueReference,
    preview.confirmationToken,
  );
}

async function deleteRepositoryWalkthrough(
  service: RvwService,
  repositoryReviewId: string,
  walkthroughId: string,
) {
  const walkthrough = service.getRepositoryWalkthrough(repositoryReviewId, walkthroughId);
  const preview = await service.getWalkthroughDeletePreview(walkthrough.ref);
  return await service.deleteRepositoryWalkthrough(
    repositoryReviewId,
    walkthroughId,
    preview.confirmationToken,
  );
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

class RepositoryGitHub implements GitHubPort {
  repositoryError: Error | null = null;
  repositoryFailureAfterBarrier: Error | null = null;
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
    throw new Error("Repository Review must not call the Pull Request API");
  }

  async getRepository(identity: RepositoryIdentity): Promise<GitHubRepository> {
    this.repositoryRequests += 1;
    expect(identity.canonicalName).toBe("acme/review-repo");
    if (this.repositoryError) throw this.repositoryError;
    const waitedAtBarrier = (await this.repositoryBarrier?.blockOnce()) ?? false;
    if (waitedAtBarrier && this.repositoryFailureAfterBarrier) {
      throw this.repositoryFailureAfterBarrier;
    }
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
    return Promise.reject(new Error("Repository Review must not fetch GitHub attachments"));
  }
}

class DeleteThenThrowGitClient extends GitClient {
  override async deleteRefs(repositoryPath: string, refs: string[]): Promise<number> {
    await super.deleteRefs(repositoryPath, refs);
    throw new Error("git update-ref exited after applying the transaction");
  }
}

class ThrowBeforeDeleteGitClient extends GitClient {
  override deleteRefs(): Promise<number> {
    return Promise.reject(new Error("git update-ref failed before applying the transaction"));
  }
}

class PauseBeforeRepositoryResetRefDeleteGitClient extends GitClient {
  readonly barrier = new OneShotBarrier();
  private deleteAttempts = 0;
  private failRetry = false;

  arm(failRetry = false): void {
    this.deleteAttempts = 0;
    this.failRetry = failRetry;
    this.barrier.arm();
  }

  override async deleteRefs(repositoryPath: string, refs: string[]): Promise<number> {
    this.deleteAttempts += 1;
    if (this.deleteAttempts === 1) await this.barrier.blockOnce();
    if (this.deleteAttempts === 2 && this.failRetry) {
      throw new Error("git update-ref retry failed before applying the transaction");
    }
    return await super.deleteRefs(repositoryPath, refs);
  }
}

class CountingRepositoryDocumentGitClient extends GitClient {
  activeDocumentReads = 0;
  maxActiveDocumentReads = 0;

  resetDocumentReadCounts(): void {
    this.activeDocumentReads = 0;
    this.maxActiveDocumentReads = 0;
  }

  override async readDocument(...args: Parameters<GitClient["readDocument"]>) {
    this.activeDocumentReads += 1;
    this.maxActiveDocumentReads = Math.max(this.maxActiveDocumentReads, this.activeDocumentReads);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await super.readDocument(...args);
    } finally {
      this.activeDocumentReads -= 1;
    }
  }
}

class VerifyRepositoryReviewRefBarrierGitClient extends GitClient {
  barrier: OneShotBarrier | null = null;

  override async verifyRepositoryReviewCommitRef(
    cwd: string,
    repositoryReviewId: string,
    oid: string,
  ) {
    const result = await super.verifyRepositoryReviewCommitRef(cwd, repositoryReviewId, oid);
    await this.barrier?.blockOnce();
    return result;
  }
}

class PauseOnNthRepositoryRefVerificationGitClient extends GitClient {
  readonly barrier = new OneShotBarrier();
  private verificationsBeforePause = 0;

  arm(verificationNumber: number): void {
    this.verificationsBeforePause = verificationNumber;
    this.barrier.arm();
  }

  override async verifyRepositoryReviewCommitRef(
    cwd: string,
    repositoryReviewId: string,
    oid: string,
  ) {
    const result = await super.verifyRepositoryReviewCommitRef(cwd, repositoryReviewId, oid);
    if (this.verificationsBeforePause > 0) {
      this.verificationsBeforePause -= 1;
      if (this.verificationsBeforePause === 0) await this.barrier.blockOnce();
    }
    return result;
  }
}

class FailInitialRepositoryReviewRefGitClient extends GitClient {
  private failed = false;

  override async ensureRepositoryReviewCommitRef(
    cwd: string,
    repositoryReviewId: string,
    oid: string,
  ) {
    if (!this.failed) {
      this.failed = true;
      throw new Error("injected initial retained-ref failure");
    }
    return await super.ensureRepositoryReviewCommitRef(cwd, repositoryReviewId, oid);
  }
}

class FailRepositoryReviewRefForOidGitClient extends GitClient {
  constructor(private readonly rejectedOid: string) {
    super();
  }

  override async ensureRepositoryReviewCommitRef(
    cwd: string,
    repositoryReviewId: string,
    oid: string,
  ) {
    if (oid === this.rejectedOid) throw new Error(`injected retained-ref failure for ${oid}`);
    return await super.ensureRepositoryReviewCommitRef(cwd, repositoryReviewId, oid);
  }
}

class PauseBeforeInitialRepositoryReviewRefGitClient extends GitClient {
  readonly barrier = new OneShotBarrier();

  override async ensureRepositoryReviewCommitRef(
    cwd: string,
    repositoryReviewId: string,
    oid: string,
  ) {
    await this.barrier.blockOnce();
    return await super.ensureRepositoryReviewCommitRef(cwd, repositoryReviewId, oid);
  }
}

class PauseRepositoryReviewRefForOidGitClient extends GitClient {
  readonly barrier = new OneShotBarrier();
  failAfterRelease = false;

  constructor(private readonly pausedOid: string) {
    super();
  }

  override async ensureRepositoryReviewCommitRef(
    cwd: string,
    repositoryReviewId: string,
    oid: string,
  ) {
    const retained = await super.ensureRepositoryReviewCommitRef(cwd, repositoryReviewId, oid);
    if (oid === this.pausedOid) {
      await this.barrier.blockOnce();
      if (this.failAfterRelease) throw new Error(`late retained-ref failure for ${oid}`);
    }
    return retained;
  }
}

class PauseBeforeRepositoryArtifactRetainGitClient extends GitClient {
  readonly barrier = new OneShotBarrier();
  private pauseNextArtifactRetain = false;

  arm(): void {
    this.pauseNextArtifactRetain = true;
    this.barrier.arm();
  }

  override async ensureRepositoryReviewCommitRef(
    cwd: string,
    repositoryReviewId: string,
    oid: string,
  ) {
    if (this.pauseNextArtifactRetain) {
      this.pauseNextArtifactRetain = false;
      await this.barrier.blockOnce();
    }
    return await super.ensureRepositoryReviewCommitRef(cwd, repositoryReviewId, oid);
  }
}

class PauseAfterRepositoryObjectCheckGitClient extends GitClient {
  readonly barrier = new OneShotBarrier();
  private pauseNextObjectCheck = false;

  arm(): void {
    this.pauseNextObjectCheck = true;
    this.barrier.arm();
  }

  override async hasObject(cwd: string, oid: string): Promise<boolean> {
    const available = await super.hasObject(cwd, oid);
    if (this.pauseNextObjectCheck) {
      this.pauseNextObjectCheck = false;
      await this.barrier.blockOnce();
    }
    return available;
  }
}

class PauseAfterRepositoryObjectForOidGitClient extends GitClient {
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

class RenameMatchingRemoteAfterFirstResolutionGitClient extends GitClient {
  private armed = false;
  private matchingResolutions = 0;

  arm(): void {
    this.armed = true;
    this.matchingResolutions = 0;
  }

  override async findBaseRepositoryIdentity(cwd: string, owner: string, repository: string) {
    const selected = await super.findBaseRepositoryIdentity(cwd, owner, repository);
    if (this.armed && ++this.matchingResolutions === 1) {
      git(cwd, "remote", "rename", "origin", "upstream");
    }
    return selected;
  }
}

class RepositoryRetainBarrierGitClient extends GitClient {
  private barrier: Promise<void> | null = null;
  private releaseBarrier: (() => void) | null = null;
  private arrivals = 0;

  armRetainBarrier(): void {
    this.arrivals = 0;
    this.barrier = new Promise((resolve) => {
      this.releaseBarrier = resolve;
    });
  }

  override async ensureRepositoryReviewCommitRef(
    cwd: string,
    repositoryReviewId: string,
    oid: string,
  ) {
    const retained = await super.ensureRepositoryReviewCommitRef(cwd, repositoryReviewId, oid);
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

describe("Repository Review", () => {
  const databases: RvwDatabase[] = [];
  afterEach(() => {
    while (databases.length) databases.pop()?.close();
  });

  function setup(gitClient: GitClient = new GitClient()) {
    const repositoryPath = createGitRepository("rvw-repository-review-");
    const sourceOid = git(repositoryPath, "rev-parse", "HEAD");
    const github = new RepositoryGitHub({
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

  async function createRelocationCandidate(
    service: RvwService,
    repositoryPath: string,
    repositoryReviewId: string,
    evidenceOids: string[],
    suffix: string,
  ): Promise<{ repositoryPath: string; gitCommonDir: string }> {
    const candidatePath = `${repositoryPath}-${suffix}`;
    git(path.dirname(repositoryPath), "clone", "--no-local", repositoryPath, candidatePath);
    configureTestGitRepository(candidatePath);
    git(candidatePath, "remote", "set-url", "origin", "https://github.com/acme/review-repo.git");
    for (const oid of evidenceOids) {
      git(
        candidatePath,
        "update-ref",
        service.git.repositoryReviewCommitRef(repositoryReviewId, oid),
        oid,
      );
    }
    const context = await service.git.repositoryContext(candidatePath);
    return { repositoryPath: context.worktreePath, gitCommonDir: context.gitCommonDir };
  }

  function httpApp(service: RvwService) {
    return createApp(service, {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });
  }

  async function repositorySnapshot(
    service: RvwService,
    database: RvwDatabase,
    repositoryPath: string,
    repositoryReviewId: string,
  ) {
    return {
      repositoryReview: database.getRepositoryReview(repositoryReviewId),
      issues: service.listRepositoryIssues(repositoryReviewId),
      comments: database.listRepositoryComments(repositoryReviewId),
      sequence: database.getReviewChangeSequence("repository", repositoryReviewId),
      refs: await service.git.listRefsByPrefix(
        repositoryPath,
        `refs/rvw/repository/${repositoryReviewId}/commits/`,
      ),
    };
  }

  it("loads Repository Review evidence once per review while classifying multiple retained refs", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const historicalOid = commitFile(
      repositoryPath,
      "historical.txt",
      "historical\n",
      "historical evidence",
    );
    await service.git.ensureRepositoryReviewCommitRef(
      repositoryPath,
      opened.repositoryReview.id,
      historicalOid,
    );
    const evidence = vi.spyOn(database, "listRepositoryReviewEvidenceOids");

    const report = await service.doctor(repositoryPath);

    expect(report.repositoryReviewRetainedRefs?.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ oid: opened.repositoryReview.sourceOid, status: "current" }),
        expect.objectContaining({ oid: historicalOid, status: "unreferenced" }),
      ]),
    );
    expect(evidence).toHaveBeenCalledTimes(1);
  });

  it("reuses one repository review across worktrees and survives a default branch rename", async () => {
    const { repositoryPath, sourceOid, github, service } = setup();
    const first = await service.openRepositoryReview(repositoryPath);
    expect(first).toMatchObject({
      fromCache: false,
      selectedRemote: {
        name: "origin",
        url: "https://github.com/acme/review-repo.git",
      },
      repositoryReview: { defaultBranchName: "main", sourceOid },
    });

    const worktree = `${repositoryPath}-worktree`;
    git(repositoryPath, "worktree", "add", "--detach", worktree, sourceOid);
    const reopened = await service.openRepositoryReview(worktree);
    expect(reopened.fromCache).toBe(true);
    expect(reopened.repositoryReview.id).toBe(first.repositoryReview.id);

    github.repository = { ...github.repository, defaultBranchName: "trunk" };
    const synchronized = await service.syncRepositoryReview(worktree);
    expect(synchronized.repositoryReview).toMatchObject({
      id: first.repositoryReview.id,
      defaultBranchName: "trunk",
    });
  });

  it("opens and synchronizes an existing review through its matching non-origin remote", async () => {
    const { repositoryPath, service } = setup();
    const first = await service.openRepositoryReview(repositoryPath);
    git(repositoryPath, "remote", "set-url", "origin", "git@github.com:reviewer/review-repo.git");
    const upstreamUrl = "https://github.com/acme/review-repo.git";
    git(repositoryPath, "remote", "add", "upstream", upstreamUrl);

    await expect(service.openRepositoryReview(repositoryPath)).resolves.toMatchObject({
      fromCache: true,
      repositoryReview: { id: first.repositoryReview.id },
      selectedRemote: { name: "upstream", url: upstreamUrl },
    });
    await expect(service.syncRepositoryReview(repositoryPath)).resolves.toMatchObject({
      repositoryReview: { id: first.repositoryReview.id },
      selectedRemote: { name: "upstream", url: upstreamUrl },
    });
    await expect(service.doctor(repositoryPath)).resolves.toMatchObject({
      git: {
        selectedRemote: {
          owner: "acme",
          repository: "review-repo",
          remoteName: "upstream",
          remoteUrl: upstreamUrl,
        },
      },
    });
  });

  it("returns the remote selected by the final synchronization boundary", async () => {
    const gitClient = new RenameMatchingRemoteAfterFirstResolutionGitClient();
    const { repositoryPath, service } = setup(gitClient);
    const opened = await service.openRepositoryReview(repositoryPath);
    gitClient.arm();

    await expect(service.syncRepositoryReview(repositoryPath)).resolves.toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
      selectedRemote: {
        name: "upstream",
        url: "https://github.com/acme/review-repo.git",
      },
    });
  });

  it("does not build an extra Repository reset preview for a confirmed HTTP request", async () => {
    const { repositoryPath, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const preview = await service.getRepositoryResetPreview(opened.repositoryReview.id);
    const previewSpy = vi.spyOn(service, "getRepositoryResetPreview");

    const response = await httpApp(service).request(
      `http://127.0.0.1:4321/api/repository-reviews/${opened.repositoryReview.id}/reset`,
      {
        method: "POST",
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        body: JSON.stringify({ yes: true, confirmationToken: preview.confirmationToken }),
      },
    );

    expect(response.status).toBe(200);
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it("keeps destructive previews existing-only across direct, Agent socket, and HTTP boundaries", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.repositoryError = new Error("existing-only operations must not call GitHub");
    const sequence = database.getChangeSequence();
    const refs = await service.git.listRefsByPrefix(repositoryPath, "refs/rvw/repository/");

    await expect(service.getRepositoryResetPreviewAtPath(repositoryPath)).rejects.toMatchObject({
      code: "REPOSITORY_REVIEW_NOT_FOUND",
    });
    await expect(resetRepositoryReviewAtPath(service, repositoryPath)).rejects.toMatchObject({
      code: "REPOSITORY_REVIEW_NOT_FOUND",
    });
    await expect(
      service.getRepositoryIssueRemovalPreview(repositoryPath, "#142"),
    ).rejects.toMatchObject({ code: "REPOSITORY_REVIEW_NOT_FOUND" });
    await expect(removeRepositoryIssue(service, repositoryPath, "#142")).rejects.toMatchObject({
      code: "REPOSITORY_REVIEW_NOT_FOUND",
    });
    await expect(service.syncRepositoryReview(repositoryPath)).rejects.toMatchObject({
      code: "REPOSITORY_REVIEW_NOT_FOUND",
    });
    await expect(service.getRepositoryRelocationPreview(repositoryPath)).rejects.toMatchObject({
      code: "REPOSITORY_REVIEW_NOT_FOUND",
    });
    await expect(service.listRepositoryCommentContextsAtPath(repositoryPath)).rejects.toMatchObject(
      {
        code: "REPOSITORY_REVIEW_NOT_FOUND",
      },
    );

    for (const [operation, input] of [
      ["repository.relocate.preview", { repositoryPath }],
      [
        "repository.relocate",
        { repositoryPath, confirmed: true, confirmationToken: "a".repeat(64) },
      ],
      ["repository.reset.preview", { repositoryPath }],
      ["repository.reset", { repositoryPath, confirmed: true, confirmationToken: "a".repeat(64) }],
      ["repository.issue.remove.preview", { repositoryPath, issueReference: "#142" }],
      [
        "repository.issue.remove",
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
          protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
          operation,
          input,
        }),
      ).rejects.toMatchObject({ code: "REPOSITORY_REVIEW_NOT_FOUND" });
    }

    const app = createApp(service, {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });
    const resetResponse = await app.request(
      "http://127.0.0.1:4321/api/repository-reviews/00000000-0000-4000-8000-000000000000/reset",
      {
        method: "POST",
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        body: JSON.stringify({ yes: false }),
      },
    );
    expect(resetResponse.status).toBe(404);
    expect(await resetResponse.json()).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_REVIEW_NOT_FOUND" },
    });
    const issueResponse = await app.request(
      "http://127.0.0.1:4321/api/repository-reviews/00000000-0000-4000-8000-000000000000/issues/issue-142",
      {
        method: "DELETE",
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        body: JSON.stringify({ yes: false }),
      },
    );
    expect(issueResponse.status).toBe(404);
    expect(await issueResponse.json()).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_REVIEW_NOT_FOUND" },
    });

    expect(github.repositoryRequests).toBe(0);
    expect(database.findRepositoryReviewByIdentity("acme", "review-repo")).toBeNull();
    expect(database.getChangeSequence()).toBe(sequence);
    await expect(
      service.git.listRefsByPrefix(repositoryPath, "refs/rvw/repository/"),
    ).resolves.toEqual(refs);
  });

  it("rejects stale destructive previews before Repository Review artifacts are deleted", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    const added = await service.addRepositoryIssue(repositoryPath, "#142");
    const walkthrough = (
      await service.publishWalkthrough({
        review: { kind: "repository", repository: "acme/review-repo" },
        sourceOid: opened.repositoryReview.sourceOid,
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
    const resetPreview = await service.getRepositoryResetPreview(opened.repositoryReview.id);
    const issuePreview = await service.getRepositoryIssueRemovalPreview(repositoryPath, "#142");
    const walkthroughPreview = await service.getWalkthroughDeletePreview(walkthrough.ref);
    await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "repository" },
      body: "Added after all previews.",
    });

    await expect(
      service.resetRepositoryReview(opened.repositoryReview.id, resetPreview.confirmationToken),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    await expect(
      service.removeRepositoryIssue(repositoryPath, "#142", issuePreview.confirmationToken),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    await expect(
      service.deleteRepositoryWalkthrough(
        opened.repositoryReview.id,
        walkthrough.id,
        walkthroughPreview.confirmationToken,
      ),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).not.toBeNull();
    expect(database.hasReviewIssue("repository", opened.repositoryReview.id, added.issue.id)).toBe(
      true,
    );
    expect(database.getRepositoryWalkthrough(walkthrough.id)).not.toBeNull();

    const app = httpApp(service);
    const snapshot = await repositorySnapshot(
      service,
      database,
      repositoryPath,
      opened.repositoryReview.id,
    );
    for (const request of [
      {
        endpoint: `/api/repository-reviews/${opened.repositoryReview.id}/reset`,
        method: "POST",
        confirmationToken: resetPreview.confirmationToken,
      },
      {
        endpoint: `/api/repository-reviews/${opened.repositoryReview.id}/issues/${added.issue.id}`,
        method: "DELETE",
        confirmationToken: issuePreview.confirmationToken,
      },
      {
        endpoint: `/api/repository-reviews/${opened.repositoryReview.id}/walkthroughs/${walkthrough.id}`,
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
    expect(
      await repositorySnapshot(service, database, repositoryPath, opened.repositoryReview.id),
    ).toEqual(snapshot);
  });

  it("keeps an HTTP sync bound to its stable Repository Review ID across reset and recreate", async () => {
    const { repositoryPath, github, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.repositoryBarrier = barrier;
    const app = httpApp(service);
    const request = app.request(
      `http://127.0.0.1:4321/api/repository-reviews/${opened.repositoryReview.id}/sync`,
      {
        method: "POST",
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    await barrier.waitUntilBlocked();

    await resetRepositoryReview(service, opened.repositoryReview.id);
    const replacement = await service.openRepositoryReview(repositoryPath);
    const before = await repositorySnapshot(
      service,
      database,
      repositoryPath,
      replacement.repositoryReview.id,
    );
    barrier.release();

    const response = await request;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_REVIEW_NOT_FOUND" },
    });
    expect(
      await repositorySnapshot(service, database, repositoryPath, replacement.repositoryReview.id),
    ).toEqual(before);
  });

  it("keeps an HTTP Issue addition bound to its stable Repository Review ID", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.issueBarrier = barrier;
    const app = httpApp(service);
    const request = app.request(
      `http://127.0.0.1:4321/api/repository-reviews/${opened.repositoryReview.id}/issues`,
      {
        method: "POST",
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        body: JSON.stringify({ issue: "#142" }),
      },
    );
    await barrier.waitUntilBlocked();

    await resetRepositoryReview(service, opened.repositoryReview.id);
    const replacement = await service.openRepositoryReview(repositoryPath);
    const before = await repositorySnapshot(
      service,
      database,
      repositoryPath,
      replacement.repositoryReview.id,
    );
    barrier.release();

    const response = await request;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_REVIEW_NOT_FOUND" },
    });
    expect(database.findIssue("acme", "review-repo", 142)).toBeNull();
    expect(
      await repositorySnapshot(service, database, repositoryPath, replacement.repositoryReview.id),
    ).toEqual(before);
  });

  it.each(["remove", "comments"] as const)(
    "keeps an HTTP %s operation bound to its stable Repository Review ID",
    async (operation) => {
      const gitClient = new VerifyRepositoryReviewRefBarrierGitClient();
      const { repositoryPath, github, database, service } = setup(gitClient);
      github.issues.set(142, issue(142));
      const opened = await service.openRepositoryReview(repositoryPath);
      const added = await service.addRepositoryIssue(repositoryPath, "#142");
      await service.createRepositoryComment({
        repositoryReviewId: opened.repositoryReview.id,
        target: { kind: "repository" },
        body: "Old aggregate comment.",
      });
      const barrier = new OneShotBarrier();
      const removalPreview = await service.getRepositoryIssueRemovalPreviewById(
        opened.repositoryReview.id,
        added.issue.url,
      );
      barrier.arm();
      gitClient.barrier = barrier;
      const app = httpApp(service);
      const request =
        operation === "remove"
          ? app.request(
              `http://127.0.0.1:4321/api/repository-reviews/${opened.repositoryReview.id}/issues/${added.issue.id}`,
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
              `http://127.0.0.1:4321/api/repository-reviews/${opened.repositoryReview.id}/comments`,
              { headers: { host: "127.0.0.1:4321" } },
            );
      await barrier.waitUntilBlocked();

      await resetRepositoryReview(service, opened.repositoryReview.id);
      const replacement = await service.openRepositoryReview(repositoryPath);
      await service.addRepositoryIssue(repositoryPath, "#142");
      await service.createRepositoryComment({
        repositoryReviewId: replacement.repositoryReview.id,
        target: { kind: "repository" },
        body: "Replacement aggregate comment.",
      });
      const before = await repositorySnapshot(
        service,
        database,
        repositoryPath,
        replacement.repositoryReview.id,
      );
      barrier.release();

      const response = await request;
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "REPOSITORY_REVIEW_NOT_FOUND" },
      });
      expect(
        await repositorySnapshot(
          service,
          database,
          repositoryPath,
          replacement.repositoryReview.id,
        ),
      ).toEqual(before);
      const socketInput =
        operation === "remove"
          ? {
              repositoryPath,
              issueReference: "#142",
              confirmed: true as const,
              confirmationToken: (
                await service.getRepositoryIssueRemovalPreview(repositoryPath, "#142")
              ).confirmationToken,
            }
          : { repositoryPath };
      await expect(
        dispatchAgentSocketRequest(service, {
          protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
          operation: operation === "remove" ? "repository.issue.remove" : "repository.comments",
          input: socketInput,
        }),
      ).resolves.toBeDefined();
    },
  );

  it("places Repository Review repository comments through the document-reference HTTP contract", async () => {
    const { repositoryPath, sourceOid, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
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
      repositoryReviewId: opened.repositoryReview.id,
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

  it("persists the trusted modifier channel on Repository Review comment posts", async () => {
    const { repositoryPath, service } = setup();
    await service.openRepositoryReview(repositoryPath);
    const created = await service.createCommentForReference({
      review: { kind: "repository", repository: "acme/review-repo" },
      target: { kind: "repository" },
      body: "Agent-created Repository Review post",
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

  it("normalizes Issue bodies before hashing, displaying, and placing comments", async () => {
    const { repositoryPath, github, service } = setup();
    github.issues.set(142, issue(142, "First\r\nSecond\rThird"));
    const opened = await service.openRepositoryReview(repositoryPath);
    const added = await service.addRepositoryIssue(repositoryPath, "#142");

    expect(added.issue).toMatchObject({
      body: "First\nSecond\nThird",
      bodyHash: hashDocument("First\nSecond\nThird"),
    });
    await expect(
      service.getRepositoryReviewDocument({
        kind: "issue-markdown",
        repositoryReviewId: opened.repositoryReview.id,
        issueId: added.issue.id,
      }),
    ).resolves.toMatchObject({ text: "First\nSecond\nThird" });

    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "issue", issue: "#142", startLine: 2, endLine: 2 },
      body: "Keep the normalized range current.",
    });
    expect(
      service.placeRepositoryIssueComment(opened.repositoryReview.id, comment, added.issue.id),
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
      const opened = await service.openRepositoryReview(repositoryPath);
      github.issues.set(142, returned);
      const sequence = database.getReviewChangeSequence("repository", opened.repositoryReview.id);

      await expect(service.addRepositoryIssue(repositoryPath, "#142")).rejects.toMatchObject({
        code: "GITHUB_ISSUE_ERROR",
        details: { reason: "ISSUE_IDENTITY_MISMATCH" },
      });
      expect(database.findIssue("acme", "review-repo", 142)).toBeNull();
      expect(service.listRepositoryIssues(opened.repositoryReview.id)).toEqual([]);
      expect(database.getReviewChangeSequence("repository", opened.repositoryReview.id)).toBe(
        sequence,
      );
    },
  );

  it("keeps an existing Issue cache unchanged when refresh identity mismatches", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    const added = await service.addRepositoryIssue(repositoryPath, "#142");
    const cached = database.getIssue(added.issue.id);
    github.issues.set(142, {
      ...issue(142, "Wrong repository body"),
      owner: "other",
      repository: "repo",
      canonicalName: "other/repo",
      url: "https://github.com/other/repo/issues/142",
    });
    const sequence = database.getReviewChangeSequence("repository", opened.repositoryReview.id);

    const synchronized = await service.syncRepositoryReview(repositoryPath);
    expect(synchronized.issueResults).toHaveLength(1);
    expect(synchronized.issueResults[0]).toMatchObject({ ok: false, issue: cached });
    expect(synchronized.issueResults[0]?.ok).toBe(false);
    if (synchronized.issueResults[0]?.ok === false) {
      expect(synchronized.issueResults[0].error.code).toBe("GITHUB_ISSUE_ERROR");
    }
    expect(database.getIssue(added.issue.id)).toEqual(cached);
    expect(database.getReviewChangeSequence("repository", opened.repositoryReview.id)).toBe(
      sequence,
    );
  });

  it("does not recreate a Repository Issue membership removed while sync is fetching it", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    const added = await service.addRepositoryIssue(repositoryPath, "#142");
    github.issues.set(142, issue(142, "Fetched after explicit removal"));
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.issueBarrier = barrier;

    const synchronization = service.syncRepositoryReview(repositoryPath);
    await barrier.waitUntilBlocked();
    await removeRepositoryIssue(service, repositoryPath, "#142");
    const sequenceAfterRemoval = database.getReviewChangeSequence(
      "repository",
      opened.repositoryReview.id,
    );
    const cacheAfterRemoval = database.getIssue(added.issue.id);
    barrier.release();

    const synchronized = await synchronization;
    expect(synchronized.issueResults).toEqual([
      expect.objectContaining({ ok: true, skipped: "membership-removed" }),
    ]);
    expect(service.listRepositoryIssues(opened.repositoryReview.id)).toEqual([]);
    expect(database.getIssue(added.issue.id)).toEqual(cacheAfterRemoval);
    expect(database.getReviewChangeSequence("repository", opened.repositoryReview.id)).toBe(
      sequenceAfterRemoval,
    );
  });

  it("does not warn when a Repository Issue fetch fails after its membership was removed", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    const added = await service.addRepositoryIssue(repositoryPath, "#142");
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.issueBarrier = barrier;
    github.issueFailureAfterBarrier = new Error("late GitHub failure");

    const synchronization = service.syncRepositoryReview(repositoryPath);
    await barrier.waitUntilBlocked();
    await removeRepositoryIssue(service, repositoryPath, "#142");
    const cacheAfterRemoval = database.getIssue(added.issue.id);
    const sequenceAfterRemoval = database.getReviewChangeSequence(
      "repository",
      opened.repositoryReview.id,
    );
    barrier.release();

    const synchronized = await synchronization;
    expect(synchronized.issueResults).toEqual([
      expect.objectContaining({ ok: true, skipped: "membership-removed" }),
    ]);
    expect(service.listRepositoryIssues(opened.repositoryReview.id)).toEqual([]);
    expect(database.getIssue(added.issue.id)).toEqual(cacheAfterRemoval);
    expect(database.getReviewChangeSequence("repository", opened.repositoryReview.id)).toBe(
      sequenceAfterRemoval,
    );
  });

  it("does not create a Repository Issue comment after its membership is concurrently removed", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    const fetchedIssue = issue(142);
    github.issues.set(142, fetchedIssue);
    const opened = await service.openRepositoryReview(repositoryPath);
    const added = await service.addRepositoryIssue(repositoryPath, "#142");
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
        gitCommonDir: opened.repositoryReview.gitCommonDir,
      },
      sourceOid,
    );
    database.addReviewIssue("pull-request", otherPullRequest.id, fetchedIssue);
    const eventSequence = database.getLatestCommentPostEventSequence();
    let sequenceAfterRemoval = -1;
    const createRepositoryComment = database.createRepositoryComment.bind(database);
    vi.spyOn(database, "createRepositoryComment").mockImplementationOnce(
      (...args: Parameters<RvwDatabase["createRepositoryComment"]>) => {
        database.removeReviewIssue(
          "repository",
          opened.repositoryReview.id,
          added.issue.id,
          database.getReviewChangeSequence("repository", opened.repositoryReview.id),
        );
        sequenceAfterRemoval = database.getReviewChangeSequence(
          "repository",
          opened.repositoryReview.id,
        );
        return createRepositoryComment(...args);
      },
    );

    await expect(
      service.createRepositoryComment({
        repositoryReviewId: opened.repositoryReview.id,
        target: { kind: "issue", issue: "#142", startLine: null, endLine: null },
        body: "Must not outlive the membership checked by the application layer.",
      }),
    ).rejects.toMatchObject({ code: "ISSUE_NOT_FOUND", status: 404 });
    expect(database.hasReviewIssue("repository", opened.repositoryReview.id, added.issue.id)).toBe(
      false,
    );
    expect(database.hasReviewIssue("pull-request", otherPullRequest.id, added.issue.id)).toBe(true);
    expect(database.getIssue(added.issue.id)).not.toBeNull();
    expect(database.listRepositoryComments(opened.repositoryReview.id)).toEqual([]);
    expect(database.listCommentPostEvents(eventSequence, 10)).toEqual([]);
    expect(database.getReviewChangeSequence("repository", opened.repositoryReview.id)).toBe(
      sequenceAfterRemoval,
    );
  });

  it("does not let a deleted Repository Review issue failure update replacement or shared owners", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    const added = await service.addRepositoryIssue(repositoryPath, "#142");
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
      { localRepositoryPath: repositoryPath, gitCommonDir: opened.repositoryReview.gitCommonDir },
      sourceOid,
    );
    await service.addPullRequestIssue(pullRequest.url, "#142");
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.issueBarrier = barrier;
    github.issueFailureAfterBarrier = new Error("stale Repository Issue fetch failed");

    const staleSynchronization = service.syncRepositoryReview(repositoryPath);
    await barrier.waitUntilBlocked();
    await resetRepositoryReview(service, opened.repositoryReview.id);
    const replacement = await service.openRepositoryReview(repositoryPath);
    await service.addRepositoryIssue(repositoryPath, "#142");
    const replacementBefore = await repositorySnapshot(
      service,
      database,
      repositoryPath,
      replacement.repositoryReview.id,
    );
    const pullRequestSequence = database.getReviewChangeSequence("pull-request", pullRequest.id);
    const sharedCache = database.getIssue(added.issue.id);
    barrier.release();

    await expect(staleSynchronization).rejects.toMatchObject({
      code: "REPOSITORY_REVIEW_NOT_FOUND",
    });
    expect(
      await repositorySnapshot(service, database, repositoryPath, replacement.repositoryReview.id),
    ).toEqual(replacementBefore);
    expect(database.getReviewChangeSequence("pull-request", pullRequest.id)).toBe(
      pullRequestSequence,
    );
    expect(database.getIssue(added.issue.id)).toEqual(sharedCache);
  });

  it("validates Issue identity for Walkthrough membership fetches", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    github.issues.set(142, {
      ...issue(142),
      url: "https://github.com/other/repo/issues/142",
    });
    const sequence = database.getReviewChangeSequence("repository", opened.repositoryReview.id);

    await expect(
      service.publishWalkthrough({
        review: { kind: "repository", repository: "acme/review-repo" },
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
    expect(service.listRepositoryWalkthroughs(opened.repositoryReview.id)).toEqual([]);
    expect(service.listRepositoryIssues(opened.repositoryReview.id)).toEqual([]);
    expect(database.findIssue("acme", "review-repo", 142)).toBeNull();
    expect(database.getReviewChangeSequence("repository", opened.repositoryReview.id)).toBe(
      sequence,
    );
  });

  it("rejects an independent clone without rebinding and permits it after an explicit reset", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const registered = database.getRepositoryReview(opened.repositoryReview.id);
    const retainedRefs = await service.git.listRefsByPrefix(
      repositoryPath,
      `refs/rvw/repository/${opened.repositoryReview.id}/commits/`,
    );
    const independentClone = createGitRepository("rvw-branch-independent-clone-");
    const independentContext = await service.git.repositoryContext(independentClone);

    await expect(service.openRepositoryReview(independentClone)).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
      details: {
        registeredPath: registered?.localRepositoryPath,
        currentPath: independentContext.worktreePath,
      },
    });
    for (const operation of [
      () => service.syncRepositoryReview(independentClone),
      () => service.addRepositoryIssue(independentClone, "#142"),
      () => service.getRepositoryRelocationPreview(independentClone),
      () => service.getRepositoryResetPreviewAtPath(independentClone),
      () => resetRepositoryReviewAtPath(service, independentClone),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });
    }
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toEqual(registered);
    await expect(
      service.git.listRefsByPrefix(
        repositoryPath,
        `refs/rvw/repository/${opened.repositoryReview.id}/commits/`,
      ),
    ).resolves.toEqual(retainedRefs);
    await expect(
      service.getRepositoryReviewDocument({
        kind: "repository-file",
        repositoryReviewId: opened.repositoryReview.id,
        sourceOid,
        path: "README.md",
      }),
    ).resolves.toMatchObject({ text: "# Fixture\n" });

    await resetRepositoryReview(service, opened.repositoryReview.id);
    github.repository = {
      ...github.repository,
      defaultBranchOid: git(independentClone, "rev-parse", "HEAD"),
    };
    const recreated = await service.openRepositoryReview(independentClone);
    expect(recreated).toMatchObject({
      fromCache: false,
      repositoryReview: {
        localRepositoryPath: independentContext.worktreePath,
        gitCommonDir: independentContext.gitCommonDir,
      },
    });
    expect(recreated.repositoryReview.id).not.toBe(opened.repositoryReview.id);
  });

  it("forgets a lost clone binding and reopens a fresh clone with a new Review ID", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    await service.addRepositoryIssue(repositoryPath, "#142");
    await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "repository" },
      body: "This local artifact is intentionally discarded.",
    });
    const freshClone = await createRelocationCandidate(
      service,
      repositoryPath,
      opened.repositoryReview.id,
      [],
      "fresh-after-loss",
    );
    rmSync(repositoryPath, { recursive: true, force: true });

    await expect(service.openRepositoryReview(freshClone.repositoryPath)).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
    });
    await expect(
      service.getRepositoryRelocationPreview(freshClone.repositoryPath),
    ).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });
    await expect(
      service.getRepositoryResetPreviewAtPath(freshClone.repositoryPath),
    ).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });

    const preview = await service.getRepositoryForgetPreviewAtPath(freshClone.repositoryPath);
    expect(preview).toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
      counts: {
        repositoryReview: 1,
        issueMemberships: 1,
        comments: 1,
        posts: 1,
      },
      registeredLocation: {
        localRepositoryPath: opened.repositoryReview.localRepositoryPath,
        gitCommonDir: opened.repositoryReview.gitCommonDir,
      },
      candidateLocation: {
        localRepositoryPath: freshClone.repositoryPath,
        gitCommonDir: freshClone.gitCommonDir,
      },
      selectedRemote: {
        name: "origin",
        url: "https://github.com/acme/review-repo.git",
      },
      registeredBinding: { kind: "unavailable", currentGitCommonDir: null },
      refPrefix: `refs/rvw/repository/${opened.repositoryReview.id}/`,
      confirmationRequired: true,
    });
    expect(preview.counts).not.toHaveProperty("gitRefs");

    const forgotten = await dispatchAgentSocketRequest(service, {
      protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
      operation: "repository.forget",
      input: {
        repositoryPath: freshClone.repositoryPath,
        confirmed: true,
        confirmationToken: preview.confirmationToken,
      },
    });
    expect(forgotten).toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
      deleted: { repositoryReview: 1, issueMemberships: 1, comments: 1, posts: 1 },
      candidateLocation: {
        localRepositoryPath: freshClone.repositoryPath,
        gitCommonDir: freshClone.gitCommonDir,
      },
      outcome: {
        kind: "completed-with-unreachable-orphan-refs",
        repositoryReviewDeleted: true,
        registeredRepositoryPath: opened.repositoryReview.localRepositoryPath,
        registeredGitCommonDir: opened.repositoryReview.gitCommonDir,
        refPrefix: `refs/rvw/repository/${opened.repositoryReview.id}/`,
        remainingRefs: null,
        cleanupAvailable: false,
      },
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toBeNull();

    const recreated = await service.openRepositoryReview(freshClone.repositoryPath);
    expect(recreated.repositoryReview).toMatchObject({
      localRepositoryPath: freshClone.repositoryPath,
      gitCommonDir: freshClone.gitCommonDir,
    });
    expect(recreated.repositoryReview.id).not.toBe(opened.repositoryReview.id);
    expect(service.listRepositoryIssues(recreated.repositoryReview.id)).toEqual([]);
    expect(service.listRepositoryComments(recreated.repositoryReview.id)).toEqual([]);
  });

  it("refuses to forget a Review found only through a secondary remote", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "repository" },
      body: "This artifact must survive a mismatched forget candidate.",
    });
    const freshClone = await createRelocationCandidate(
      service,
      repositoryPath,
      opened.repositoryReview.id,
      [],
      "forget-fork-origin",
    );
    git(freshClone.repositoryPath, "remote", "rename", "origin", "upstream");
    git(
      freshClone.repositoryPath,
      "remote",
      "add",
      "origin",
      "https://github.com/reviewer/review-repo.git",
    );
    rmSync(repositoryPath, { recursive: true, force: true });

    await expect(
      service.getRepositoryForgetPreviewAtPath(freshClone.repositoryPath),
    ).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
      details: {
        selectedRemote: {
          name: "origin",
          url: "https://github.com/reviewer/review-repo.git",
        },
        selectedRepository: "reviewer/review-repo",
        secondaryRepositoryReviews: [
          {
            repositoryReviewId: opened.repositoryReview.id,
            canonicalName: "acme/review-repo",
            remoteName: "upstream",
            remoteUrl: "https://github.com/acme/review-repo.git",
          },
        ],
      },
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toEqual(
      opened.repositoryReview,
    );
    expect(service.listRepositoryComments(opened.repositoryReview.id)).toHaveLength(1);
  });

  it("refuses lost-binding recovery while the registered clone is still available", async () => {
    const { repositoryPath, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const freshClone = await createRelocationCandidate(
      service,
      repositoryPath,
      opened.repositoryReview.id,
      [],
      "forget-while-live",
    );

    await expect(
      service.getRepositoryForgetPreviewAtPath(freshClone.repositoryPath),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: {
        repositoryReviewId: opened.repositoryReview.id,
        registeredGitCommonDir: opened.repositoryReview.gitCommonDir,
      },
    });
  });

  it("recognizes a fresh clone recreated at the saved filesystem path as a replaced binding", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const stagedClone = await createRelocationCandidate(
      service,
      repositoryPath,
      opened.repositoryReview.id,
      [],
      "same-path-replacement",
    );
    rmSync(repositoryPath, { recursive: true, force: true });
    renameSync(stagedClone.repositoryPath, repositoryPath);
    const replacement = await service.git.repositoryContext(repositoryPath);
    expect(replacement.gitCommonDir).toBe(opened.repositoryReview.gitCommonDir);

    const preview = await service.getRepositoryForgetPreviewAtPath(repositoryPath);
    expect(preview).toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
      candidateLocation: {
        localRepositoryPath: replacement.worktreePath,
        gitCommonDir: replacement.gitCommonDir,
      },
      registeredBinding: {
        kind: "replaced",
        currentGitCommonDir: replacement.gitCommonDir,
      },
    });
    await expect(
      service.forgetRepositoryReviewAtPath(repositoryPath, preview.confirmationToken),
    ).resolves.toMatchObject({
      outcome: { kind: "completed-with-unreachable-orphan-refs" },
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toBeNull();

    const recreated = await service.openRepositoryReview(repositoryPath);
    expect(recreated.repositoryReview.id).not.toBe(opened.repositoryReview.id);
  });

  it("returns a current forget preview when its final SQLite CAS loses a race", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const freshClone = await createRelocationCandidate(
      service,
      repositoryPath,
      opened.repositoryReview.id,
      [],
      "forget-cas",
    );
    rmSync(repositoryPath, { recursive: true, force: true });
    const preview = await service.getRepositoryForgetPreviewAtPath(freshClone.repositoryPath);
    const forgetInDatabase = database.forgetRepositoryReview.bind(database);
    vi.spyOn(database, "forgetRepositoryReview").mockImplementationOnce(
      (...args: Parameters<RvwDatabase["forgetRepositoryReview"]>) => {
        database.incrementChangeSequence({
          kind: "repository",
          reviewId: opened.repositoryReview.id,
        });
        return forgetInDatabase(...args);
      },
    );

    const error = (await service
      .forgetRepositoryReviewAtPath(freshClone.repositoryPath, preview.confirmationToken)
      .catch((caught: unknown) => caught)) as RvwError;
    expect(error).toMatchObject({
      code: "DESTRUCTIVE_PREVIEW_STALE",
      status: 409,
      details: {
        currentPreview: {
          repositoryReview: { id: opened.repositoryReview.id },
          candidateLocation: {
            localRepositoryPath: freshClone.repositoryPath,
            gitCommonDir: freshClone.gitCommonDir,
          },
          registeredBinding: { kind: "unavailable" },
        },
      },
    });
    expect(
      (error.details as { currentPreview: { confirmationToken: string } }).currentPreview
        .confirmationToken,
    ).not.toBe(preview.confirmationToken);
    expect(database.getRepositoryReview(opened.repositoryReview.id)).not.toBeNull();
  });

  it("requires explicit relocation after a clone directory move and restores every bound operation", async () => {
    const { repositoryPath, sourceOid, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const movedPath = `${repositoryPath}-moved`;
    renameSync(repositoryPath, movedPath);
    const movedContext = await service.git.repositoryContext(movedPath);

    await expect(service.openRepositoryReview(movedPath)).rejects.toMatchObject({
      code: "REPOSITORY_RELOCATION_REQUIRED",
      details: {
        repositoryReviewId: opened.repositoryReview.id,
        candidatePath: movedContext.worktreePath,
        candidateGitCommonDir: movedContext.gitCommonDir,
        retainedSourceAvailable: true,
        sourceObjectAvailable: true,
      },
    });

    const preview = await service.getRepositoryRelocationPreview(movedPath);
    expect(preview).toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
      previousLocation: {
        localRepositoryPath: opened.repositoryReview.localRepositoryPath,
        gitCommonDir: opened.repositoryReview.gitCommonDir,
      },
      candidateLocation: {
        localRepositoryPath: movedContext.worktreePath,
        gitCommonDir: movedContext.gitCommonDir,
      },
      sourceOid,
      requiredEvidenceCount: 1,
      verifiedEvidenceCount: 1,
      missingEvidence: [],
      confirmationRequired: true,
    });
    database.incrementChangeSequence({
      kind: "repository",
      reviewId: opened.repositoryReview.id,
    });
    await expect(
      service.relocateRepositoryReviewAtPath(movedPath, preview.confirmationToken),
    ).rejects.toMatchObject({
      code: "DESTRUCTIVE_PREVIEW_STALE",
      status: 409,
      details: {
        currentPreview: {
          repositoryReview: { id: opened.repositoryReview.id },
          candidateLocation: { gitCommonDir: movedContext.gitCommonDir },
        },
      },
    });
    const currentPreview = await service.getRepositoryRelocationPreview(movedPath);
    const relocated = await dispatchAgentSocketRequest(service, {
      protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
      operation: "repository.relocate",
      input: {
        repositoryPath: movedPath,
        confirmed: true,
        confirmationToken: currentPreview.confirmationToken,
      },
    });
    expect(relocated).toMatchObject({
      repositoryReview: {
        id: opened.repositoryReview.id,
        localRepositoryPath: movedContext.worktreePath,
        gitCommonDir: movedContext.gitCommonDir,
      },
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toMatchObject({
      localRepositoryPath: movedContext.worktreePath,
      gitCommonDir: movedContext.gitCommonDir,
      sourceOid,
    });

    await expect(service.openRepositoryReview(movedPath)).resolves.toMatchObject({
      fromCache: true,
      repositoryReview: { id: opened.repositoryReview.id },
    });
    await expect(service.syncRepositoryReview(movedPath)).resolves.toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id, sourceOid },
    });
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid,
        path: "README.md",
        startLine: 1,
        endLine: 1,
      },
      body: "The relocated clone remains reviewable.",
    });
    await expect(service.listRepositoryCommentContextsAtPath(movedPath)).resolves.toMatchObject({
      comments: [{ comment: { id: comment.id } }],
    });
    await expect(resetRepositoryReviewAtPath(service, movedPath)).resolves.toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
      outcome: { kind: "completed" },
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toBeNull();
  });

  it("does not let a stale cached open roll a completed relocation back", async () => {
    const gitClient = new PauseAfterRepositoryObjectCheckGitClient();
    const { repositoryPath, sourceOid, database, service } = setup(gitClient);
    const opened = await service.openRepositoryReview(repositoryPath);
    const cachedWorktree = `${repositoryPath}-stale-cached-open`;
    git(repositoryPath, "worktree", "add", "--detach", cachedWorktree, sourceOid);
    const candidate = await createRelocationCandidate(
      service,
      repositoryPath,
      opened.repositoryReview.id,
      [sourceOid],
      "cached-open-relocation",
    );
    gitClient.arm();

    const staleOpen = service.openRepositoryReview(cachedWorktree);
    await gitClient.barrier.waitUntilBlocked();
    const preview = await service.getRepositoryRelocationPreview(candidate.repositoryPath);
    await service.relocateRepositoryReviewAtPath(
      candidate.repositoryPath,
      preview.confirmationToken,
    );

    gitClient.barrier.release();
    await expect(staleOpen).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
      status: 409,
      details: {
        repositoryReviewId: opened.repositoryReview.id,
        expectedGitCommonDir: opened.repositoryReview.gitCommonDir,
        currentGitCommonDir: candidate.gitCommonDir,
      },
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toMatchObject({
      localRepositoryPath: candidate.repositoryPath,
      gitCommonDir: candidate.gitCommonDir,
    });
  });

  it("rejects historical Comment evidence retained in the old clone after relocation wins", async () => {
    const repositoryPath = createGitRepository("rvw-repository-artifact-relocation-");
    const historicalOid = git(repositoryPath, "rev-parse", "HEAD");
    const gitClient = new PauseRepositoryReviewRefForOidGitClient(historicalOid);
    const github = new RepositoryGitHub({
      host: "github.com",
      owner: "acme",
      repository: "review-repo",
      canonicalName: "acme/review-repo",
      defaultBranchName: "main",
      defaultBranchOid: historicalOid,
    });
    const database = new RvwDatabase({
      filePath: path.join(mkdtempSync(path.join(os.tmpdir(), "rvw-branch-db-")), "rvw.db"),
      migrationsDirectory: "./migrations",
    });
    databases.push(database);
    const service = new RvwService(database, gitClient, github);
    const opened = await service.openRepositoryReview(repositoryPath);
    const currentOid = commitFile(
      repositoryPath,
      "README.md",
      "# Fixture\n\nCurrent.\n",
      "current",
    );
    github.repository = { ...github.repository, defaultBranchOid: currentOid };
    await service.syncRepositoryReview(repositoryPath);
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "repository" },
      body: "Investigate the historical implementation.",
    });
    const candidate = await createRelocationCandidate(
      service,
      repositoryPath,
      opened.repositoryReview.id,
      [currentOid],
      "artifact-relocation",
    );
    expect(
      await service.git.verifyRepositoryReviewCommitRef(
        candidate.repositoryPath,
        opened.repositoryReview.id,
        historicalOid,
      ),
    ).toBe(false);
    gitClient.barrier.arm();

    const staleReply = service.replyToComment(comment.ref, {
      body: "This reply must not publish stale-clone evidence.",
      relatedCommitOid: historicalOid,
    });
    await gitClient.barrier.waitUntilBlocked();
    const preview = await service.getRepositoryRelocationPreview(candidate.repositoryPath);
    expect(preview).toMatchObject({ requiredEvidenceCount: 1, missingEvidence: [] });
    await service.relocateRepositoryReviewAtPath(
      candidate.repositoryPath,
      preview.confirmationToken,
    );

    gitClient.barrier.release();
    await expect(staleReply).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
      status: 409,
      details: {
        repositoryReviewId: opened.repositoryReview.id,
        expectedGitCommonDir: opened.repositoryReview.gitCommonDir,
        currentGitCommonDir: candidate.gitCommonDir,
      },
    });
    expect(database.getRepositoryComment(comment.id)?.posts).toHaveLength(1);
    expect(database.listRepositoryReviewEvidenceOids(opened.repositoryReview.id)).toEqual([
      currentOid,
    ]);
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toMatchObject({
      gitCommonDir: candidate.gitCommonDir,
    });
  });

  it("does not publish an old-clone source sync error after relocation", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const candidate = await createRelocationCandidate(
      service,
      repositoryPath,
      opened.repositoryReview.id,
      [sourceOid],
      "source-error-relocation",
    );
    const generationBeforeSync = database.getRepositorySourceSyncGeneration(
      opened.repositoryReview.id,
    );
    const barrier = new OneShotBarrier();
    barrier.arm();
    github.repositoryBarrier = barrier;
    github.repositoryFailureAfterBarrier = new Error("old clone fetch failed");

    const staleSync = service.syncRepositoryReview(repositoryPath);
    await barrier.waitUntilBlocked();
    expect(database.getRepositorySourceSyncGeneration(opened.repositoryReview.id)).toBe(
      generationBeforeSync + 1,
    );
    const preview = await service.getRepositoryRelocationPreview(candidate.repositoryPath);
    await service.relocateRepositoryReviewAtPath(
      candidate.repositoryPath,
      preview.confirmationToken,
    );
    expect(database.getRepositorySourceSyncGeneration(opened.repositoryReview.id)).toBe(
      generationBeforeSync + 2,
    );

    barrier.release();
    await expect(staleSync).rejects.toThrow("old clone fetch failed");
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toMatchObject({
      gitCommonDir: candidate.gitCommonDir,
      sourceSyncError: null,
    });
  });

  it("does not let an old-clone sync acquire a generation after relocation", async () => {
    const gitClient = new PauseOnNthRepositoryRefVerificationGitClient();
    const { repositoryPath, sourceOid, github, database, service } = setup(gitClient);
    const opened = await service.openRepositoryReview(repositoryPath);
    const nextSourceOid = commitFile(
      repositoryPath,
      "README.md",
      "# Fixture\n\nFresh binding source.\n",
      "fresh binding source",
    );
    const candidate = await createRelocationCandidate(
      service,
      repositoryPath,
      opened.repositoryReview.id,
      [sourceOid],
      "source-begin-relocation",
    );
    const generationBeforeRace = database.getRepositorySourceSyncGeneration(
      opened.repositoryReview.id,
    );
    const githubRequestsBeforeRace = github.repositoryRequests;
    gitClient.arm(2);

    const staleSync = service.syncRepositoryReview(repositoryPath);
    await gitClient.barrier.waitUntilBlocked();
    expect(github.repositoryRequests).toBe(githubRequestsBeforeRace);

    const preview = await service.getRepositoryRelocationPreview(candidate.repositoryPath);
    await service.relocateRepositoryReviewAtPath(
      candidate.repositoryPath,
      preview.confirmationToken,
    );
    expect(database.getRepositorySourceSyncGeneration(opened.repositoryReview.id)).toBe(
      generationBeforeRace + 1,
    );

    github.repository = { ...github.repository, defaultBranchOid: nextSourceOid };
    const freshSourceBarrier = new OneShotBarrier();
    freshSourceBarrier.arm();
    github.repositoryBarrier = freshSourceBarrier;
    const freshSync = service.syncRepositoryReview(candidate.repositoryPath);
    await freshSourceBarrier.waitUntilBlocked();
    const freshGeneration = generationBeforeRace + 2;
    expect(database.getRepositorySourceSyncGeneration(opened.repositoryReview.id)).toBe(
      freshGeneration,
    );
    expect(github.repositoryRequests).toBe(githubRequestsBeforeRace + 1);

    gitClient.barrier.release();
    await expect(staleSync).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
      status: 409,
      details: {
        repositoryReviewId: opened.repositoryReview.id,
        expectedGitCommonDir: opened.repositoryReview.gitCommonDir,
        currentGitCommonDir: candidate.gitCommonDir,
      },
    });
    expect(database.getRepositorySourceSyncGeneration(opened.repositoryReview.id)).toBe(
      freshGeneration,
    );
    expect(github.repositoryRequests).toBe(githubRequestsBeforeRace + 1);
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toMatchObject({
      gitCommonDir: candidate.gitCommonDir,
      sourceOid,
      sourceSyncError: null,
    });

    freshSourceBarrier.release();
    await expect(freshSync).resolves.toMatchObject({
      repositoryReview: {
        id: opened.repositoryReview.id,
        gitCommonDir: candidate.gitCommonDir,
        sourceOid: nextSourceOid,
        sourceSyncError: null,
      },
    });
    expect(database.getRepositorySourceSyncGeneration(opened.repositoryReview.id)).toBe(
      freshGeneration,
    );
  });

  it("relocates a moved review through its matching non-origin remote", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const movedPath = `${repositoryPath}-moved-fork`;
    renameSync(repositoryPath, movedPath);
    git(movedPath, "remote", "set-url", "origin", "git@github.com:reviewer/review-repo.git");
    const upstreamUrl = "https://github.com/acme/review-repo.git";
    git(movedPath, "remote", "add", "upstream", upstreamUrl);
    const movedContext = await service.git.repositoryContext(movedPath);

    await expect(service.openRepositoryReview(movedPath)).rejects.toMatchObject({
      code: "REPOSITORY_RELOCATION_REQUIRED",
      details: {
        repositoryReviewId: opened.repositoryReview.id,
        candidateGitCommonDir: movedContext.gitCommonDir,
      },
    });

    const preview = await service.getRepositoryRelocationPreview(movedPath);
    expect(preview).toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
      selectedRemote: { name: "upstream", url: upstreamUrl },
      missingEvidence: [],
    });
    await expect(
      service.relocateRepositoryReviewAtPath(movedPath, preview.confirmationToken),
    ).resolves.toMatchObject({
      repositoryReview: {
        id: opened.repositoryReview.id,
        gitCommonDir: movedContext.gitCommonDir,
      },
      selectedRemote: { name: "upstream", url: upstreamUrl },
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toMatchObject({
      gitCommonDir: movedContext.gitCommonDir,
    });
  });

  it("does not create a second Review when a moved clone also changes remote identity", async () => {
    const { repositoryPath, database, github, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const before = await repositorySnapshot(
      service,
      database,
      repositoryPath,
      opened.repositoryReview.id,
    );
    const sequence = database.getChangeSequence();
    const repositoryRequests = github.repositoryRequests;
    const movedPath = `${repositoryPath}-moved-remote`;
    renameSync(repositoryPath, movedPath);
    git(movedPath, "remote", "set-url", "origin", "git@github.com:other-owner/other-repo.git");

    for (const operation of [
      () => service.openRepositoryReview(movedPath),
      () => service.addRepositoryIssue(movedPath, "#142"),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "REPOSITORY_MISMATCH",
        details: {
          repositoryReviewId: opened.repositoryReview.id,
          currentRepository: "other-owner/other-repo",
        },
      });
    }
    expect(github.repositoryRequests).toBe(repositoryRequests);
    expect(database.findRepositoryReviewByIdentity("other-owner", "other-repo")).toBeNull();
    expect(database.getChangeSequence()).toBe(sequence);
    await expect(
      repositorySnapshot(service, database, movedPath, opened.repositoryReview.id),
    ).resolves.toEqual(before);
  });

  it("does not create a second Review when a moved clone loses its remote", async () => {
    const { repositoryPath, database, github, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const before = await repositorySnapshot(
      service,
      database,
      repositoryPath,
      opened.repositoryReview.id,
    );
    const sequence = database.getChangeSequence();
    const repositoryRequests = github.repositoryRequests;
    const movedPath = `${repositoryPath}-moved-offline`;
    renameSync(repositoryPath, movedPath);
    git(movedPath, "remote", "remove", "origin");

    await expect(service.openRepositoryReview(movedPath)).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
      details: {
        repositoryReviewId: opened.repositoryReview.id,
        currentRepository: null,
      },
    });
    await expect(service.getRepositoryRelocationPreview(movedPath)).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
    });
    expect(github.repositoryRequests).toBe(repositoryRequests);
    expect(database.getChangeSequence()).toBe(sequence);
    await expect(
      repositorySnapshot(service, database, movedPath, opened.repositoryReview.id),
    ).resolves.toEqual(before);
  });

  it("rejects relocation when any DB-referenced historical evidence is missing", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid,
        path: "README.md",
        startLine: 1,
        endLine: 1,
      },
      body: "Retain the historical source.",
    });
    await service.publishWalkthrough({
      review: { kind: "repository", repository: "acme/review-repo" },
      sourceOid,
      title: "Historical relocation evidence",
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
    const nextOid = commitFile(repositoryPath, "README.md", "# Fixture\n\nNext.\n", "next");
    github.repository = { ...github.repository, defaultBranchOid: nextOid };
    await service.syncRepositoryReview(repositoryPath);
    const saved = database.getRepositoryReview(opened.repositoryReview.id);
    const sequence = database.getChangeSequence();
    const movedPath = `${repositoryPath}-incomplete-evidence`;
    renameSync(repositoryPath, movedPath);
    git(
      movedPath,
      "update-ref",
      "-d",
      service.git.repositoryReviewCommitRef(opened.repositoryReview.id, sourceOid),
    );
    expect(await service.git.hasObject(movedPath, sourceOid)).toBe(true);

    await expect(service.openRepositoryReview(movedPath)).rejects.toMatchObject({
      code: "REPOSITORY_RELOCATION_REQUIRED",
    });
    await expect(service.getRepositoryRelocationPreview(movedPath)).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
      details: {
        requiredEvidenceCount: 2,
        verifiedEvidenceCount: 1,
        missingEvidence: [
          {
            sourceOid,
            retainedRefAvailable: false,
            gitObjectAvailable: true,
          },
        ],
      },
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toEqual(saved);
    expect(database.getChangeSequence()).toBe(sequence);
  });

  it("returns a current relocation preview when the final SQLite CAS loses a race", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const movedPath = `${repositoryPath}-relocation-cas`;
    renameSync(repositoryPath, movedPath);
    const preview = await service.getRepositoryRelocationPreview(movedPath);
    const relocateInDatabase = database.relocateRepositoryReview.bind(database);
    vi.spyOn(database, "relocateRepositoryReview").mockImplementationOnce(
      (...args: Parameters<RvwDatabase["relocateRepositoryReview"]>) => {
        database.incrementChangeSequence({
          kind: "repository",
          reviewId: opened.repositoryReview.id,
        });
        return relocateInDatabase(...args);
      },
    );

    const error = (await service
      .relocateRepositoryReviewAtPath(movedPath, preview.confirmationToken)
      .catch((caught: unknown) => caught)) as RvwError;
    expect(error).toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    const currentPreview = (
      error.details as {
        currentPreview: {
          repositoryReview: { id: string };
          reviewChangeSequence: number;
          requiredEvidenceCount: number;
          verifiedEvidenceCount: number;
          missingEvidence: unknown[];
          confirmationToken: string;
        };
      }
    ).currentPreview;
    expect(currentPreview).toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
      reviewChangeSequence: database.getReviewChangeSequence(
        "repository",
        opened.repositoryReview.id,
      ),
      requiredEvidenceCount: 1,
      verifiedEvidenceCount: 1,
      missingEvidence: [],
    });
    expect(currentPreview.confirmationToken).not.toBe(preview.confirmationToken);
  });

  it("fails closed before every mutation when the same clone remote changes identity", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    github.issues.set(143, issue(143));
    const opened = await service.openRepositoryReview(repositoryPath);
    await service.addRepositoryIssue(repositoryPath, "#142");
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "repository" },
      body: "Keep this artifact bound to the original repository.",
    });
    const reply = await service.replyToComment(comment.ref, { body: "Bound reply." });
    const walkthroughContent = {
      sourceOid: opened.repositoryReview.sourceOid,
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
    };
    const { walkthrough } = await service.publishWalkthrough({
      review: { kind: "repository", repository: "acme/review-repo" },
      ...walkthroughContent,
      title: "Bound walkthrough",
    });
    const walkthroughPreview = await service.getWalkthroughDeletePreview(walkthrough.ref);
    const saved = database.getRepositoryReview(opened.repositoryReview.id);
    const sequence = database.getChangeSequence();
    const refs = await service.git.listRefsByPrefix(
      repositoryPath,
      `refs/rvw/repository/${opened.repositoryReview.id}/commits/`,
    );
    const githubRequests = github.repositoryRequests;
    git(repositoryPath, "remote", "set-url", "origin", "git@github.com:other-owner/other-repo.git");

    for (const operation of [
      () => service.openRepositoryReview(repositoryPath),
      () => service.syncRepositoryReview(repositoryPath),
      () => service.addRepositoryIssue(repositoryPath, "#143"),
      () => service.getRepositoryIssueRemovalPreview(repositoryPath, "#142"),
      () => removeRepositoryIssue(service, repositoryPath, "#142"),
      () => service.getRepositoryResetPreviewAtPath(repositoryPath),
      () => resetRepositoryReviewAtPath(service, repositoryPath),
      () => service.listRepositoryCommentContextsAtPath(repositoryPath),
      () => service.setCommentResolved(comment.ref, true),
      () => service.deleteReply(comment.id, reply.id),
      () => service.deleteComment(comment.ref),
      () => service.getWalkthroughDeletePreview(walkthrough.ref),
      () =>
        service.deleteRepositoryWalkthrough(
          opened.repositoryReview.id,
          walkthrough.id,
          walkthroughPreview.confirmationToken,
        ),
      () =>
        service.updateWalkthrough(walkthrough.ref, {
          ...walkthroughContent,
          title: "Must not update through the replaced remote",
          issuesToAdd: ["#143"],
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });
    }
    for (const [operation, input] of [
      ["repository.sync", { repositoryPath }],
      ["repository.relocate.preview", { repositoryPath }],
      ["repository.issue.add", { repositoryPath, issueReference: "#143" }],
      [
        "repository.issue.remove",
        {
          repositoryPath,
          issueReference: "#142",
          confirmed: true,
          confirmationToken: "a".repeat(64),
        },
      ],
      ["repository.reset.preview", { repositoryPath }],
      ["repository.reset", { repositoryPath, confirmed: true, confirmationToken: "a".repeat(64) }],
      ["repository.comments", { repositoryPath }],
      ["comment.resolve", { uri: comment.ref }],
      ["walkthrough.delete.preview", { uri: walkthrough.ref }],
      [
        "walkthrough.delete",
        {
          uri: walkthrough.ref,
          confirmed: true,
          confirmationToken: walkthroughPreview.confirmationToken,
        },
      ],
    ] as const) {
      await expect(
        dispatchAgentSocketRequest(service, {
          protocolVersion: AGENT_SOCKET_PROTOCOL_VERSION,
          operation,
          input,
        }),
      ).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });
    }

    const app = createApp(service, {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });
    for (const endpoint of ["sync", "reset"]) {
      const response = await app.request(
        `http://127.0.0.1:4321/api/repository-reviews/${opened.repositoryReview.id}/${endpoint}`,
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
    for (const request of [
      { method: "POST", endpoint: `/api/comments/${comment.id}/resolve`, body: undefined },
      {
        method: "DELETE",
        endpoint: `/api/comments/${comment.id}/posts/${reply.id}`,
        body: undefined,
      },
      { method: "DELETE", endpoint: `/api/comments/${comment.id}`, body: undefined },
      {
        method: "DELETE",
        endpoint: `/api/repository-reviews/${opened.repositoryReview.id}/walkthroughs/${walkthrough.id}`,
        body: JSON.stringify({
          yes: true,
          confirmationToken: walkthroughPreview.confirmationToken,
        }),
      },
    ]) {
      const response = await app.request(`http://127.0.0.1:4321${request.endpoint}`, {
        method: request.method,
        headers: { host: "127.0.0.1:4321", "content-type": "application/json" },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "REPOSITORY_MISMATCH" },
      });
    }

    expect(github.repositoryRequests).toBe(githubRequests);
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toEqual(saved);
    expect(database.getChangeSequence()).toBe(sequence);
    await expect(
      service.git.listRefsByPrefix(
        repositoryPath,
        `refs/rvw/repository/${opened.repositoryReview.id}/commits/`,
      ),
    ).resolves.toEqual(refs);
    expect(database.getRepositoryComment(comment.id)).not.toBeNull();
    expect(database.getRepositoryWalkthrough(walkthrough.id)).not.toBeNull();
  });

  it("preserves canonical identities when GitHub changes repository casing", async () => {
    const { repositoryPath, github, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    const added = await service.addRepositoryIssue(repositoryPath, "#142");

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

    const synchronized = await service.syncRepositoryReview(repositoryPath);
    expect(synchronized.repositoryReview).toMatchObject({
      id: opened.repositoryReview.id,
      canonicalName: "Acme/Review-Repo",
    });
    expect(service.listRepositoryIssues(opened.repositoryReview.id)).toEqual([
      expect.objectContaining({
        id: added.issue.id,
        canonicalName: "Acme/Review-Repo",
        body: "Canonical casing updated",
      }),
    ]);
  });

  it("keeps Repository Review membership stale state in comment context and clears it through issuesToAdd", async () => {
    const { repositoryPath, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    const added = await service.addRepositoryIssue(repositoryPath, "#142");
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "issue", issue: "#142", startLine: 1, endLine: 1 },
      body: "Report the membership-specific stale state.",
    });
    database.setReviewIssueSyncError(
      "repository",
      opened.repositoryReview.id,
      added.issue.id,
      database.getIssueCacheGeneration(added.issue.id),
      "Repository Review-only refresh failure",
    );

    await expect(service.getAnyCommentReviewContext(comment.ref)).resolves.toMatchObject({
      issue: { number: 142, syncError: "Repository Review-only refresh failure", stale: true },
    });
    const ensured = await service.publishWalkthrough({
      review: { kind: "repository", repository: "acme/review-repo" },
      sourceOid: opened.repositoryReview.sourceOid,
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

  it("keeps exact source comments, syncs Issue bodies, and emits Repository Review watch events", async () => {
    const { repositoryPath, github, service } = setup();
    github.issues.set(142, issue(142));
    github.issues.set(143, issue(143));
    const opened = await service.openRepositoryReview(repositoryPath);
    await service.addRepositoryIssue(repositoryPath, "#142");
    const published = await service.publishWalkthrough({
      review: { kind: "repository", repository: "acme/review-repo" },
      sourceOid: opened.repositoryReview.sourceOid,
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
      walkthrough: { repositoryReviewId: opened.repositoryReview.id },
      issuesAdded: [{ number: 143 }],
    });
    expect(
      service.listRepositoryIssues(opened.repositoryReview.id).map(({ number }) => number),
    ).toEqual([143, 142]);
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "issue", issue: "#142", startLine: 1, endLine: 1 },
      body: "Confirm this requirement against the implementation.",
    });
    const wholeIssueComment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "issue", issue: "#142", startLine: null, endLine: null },
      body: "Track this requirement as a whole.",
    });
    const issue142 = service
      .listRepositoryIssues(opened.repositoryReview.id)
      .find(({ number }) => number === 142)!;
    const issue143 = service
      .listRepositoryIssues(opened.repositoryReview.id)
      .find(({ number }) => number === 143)!;
    await expect(
      service.getRepositoryReviewDocument({
        kind: "issue-markdown",
        repositoryReviewId: opened.repositoryReview.id,
        issueId: issue142.id,
      }),
    ).resolves.toMatchObject({ text: "Requirement 142\nDetails" });
    expect(
      service.placeRepositoryIssueComment(opened.repositoryReview.id, comment, issue142.id),
    ).toEqual({
      outdated: false,
      range: { startLine: 1, endLine: 1 },
      path: "#142",
    });
    expect(
      service.placeRepositoryIssueComment(opened.repositoryReview.id, comment, issue143.id),
    ).toEqual({
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
        kind: "repository",
        repositoryReviewId: opened.repositoryReview.id,
        repository: "acme/review-repo",
      },
    });

    github.issues.set(142, issue(142, "Changed requirement\nDetails", "2026-08-20T01:00:00.000Z"));
    await service.syncRepositoryReview(repositoryPath);
    expect(
      service.placeRepositoryIssueComment(
        opened.repositoryReview.id,
        wholeIssueComment,
        issue142.id,
      ),
    ).toEqual({ outdated: false, range: null, path: "#142" });
    await expect(service.getAnyCommentReviewContext(comment.ref)).resolves.toMatchObject({
      context: {
        kind: "repository",
        repositoryReviewId: opened.repositoryReview.id,
        repository: "acme/review-repo",
      },
      issue: { number: 142, body: "Changed requirement\nDetails" },
      latestPlacement: { outdated: true },
    });
  });

  it("keeps Repository Walkthrough publish and update JSON shapes equal across direct and Agent socket transports", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    for (const number of [142, 143, 144, 145]) github.issues.set(number, issue(number));
    await service.openRepositoryReview(repositoryPath);
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
      review: { kind: "repository", repository: "acme/review-repo" },
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
          review: { kind: "repository", repository: "acme/review-repo" },
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

  it("returns current Repository Review metadata when the final reset CAS detects a concurrent sync", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const preview = await service.getRepositoryResetPreview(opened.repositoryReview.id);
    const resetRepositoryReviewInDatabase = database.resetRepositoryReview.bind(database);
    vi.spyOn(database, "resetRepositoryReview").mockImplementationOnce(
      (...args: Parameters<RvwDatabase["resetRepositoryReview"]>) => {
        database.setRepositorySyncError(
          opened.repositoryReview.id,
          database.getRepositorySourceSyncGeneration(opened.repositoryReview.id),
          "Concurrent synchronization failed.",
        );
        return resetRepositoryReviewInDatabase(...args);
      },
    );

    const error = (await service
      .resetRepositoryReview(opened.repositoryReview.id, preview.confirmationToken)
      .catch((caught: unknown) => caught)) as RvwError;
    expect(error).toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    expect(
      (
        error.details as {
          currentPreview: {
            repositoryReview: { sourceSyncError: string | null };
            reviewChangeSequence: number;
            confirmationToken: string;
          };
        }
      ).currentPreview,
    ).toMatchObject({
      repositoryReview: { sourceSyncError: "Concurrent synchronization failed." },
      reviewChangeSequence: database.getReviewChangeSequence(
        "repository",
        opened.repositoryReview.id,
      ),
    });
    expect(
      (
        error.details as {
          currentPreview: { confirmationToken: string };
        }
      ).currentPreview.confirmationToken,
    ).not.toBe(preview.confirmationToken);
  });

  it("re-resolves the current clone when relocation wins the final reset CAS", async () => {
    const { repositoryPath, sourceOid, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const prefix = `refs/rvw/repository/${opened.repositoryReview.id}/commits/`;
    const candidate = await createRelocationCandidate(
      service,
      repositoryPath,
      opened.repositoryReview.id,
      [sourceOid],
      "reset-cas-relocation",
    );
    const candidateOnlyOid = commitFile(
      candidate.repositoryPath,
      "candidate-only.txt",
      "candidate binding\n",
      "candidate-only evidence",
    );
    const candidateOnlyRef = (
      await service.git.ensureRepositoryReviewCommitRef(
        candidate.repositoryPath,
        opened.repositoryReview.id,
        candidateOnlyOid,
      )
    ).ref;
    const sourceRef = service.git.repositoryReviewCommitRef(opened.repositoryReview.id, sourceOid);
    const preview = await service.getRepositoryResetPreview(opened.repositoryReview.id);
    const resetRepositoryReviewInDatabase = database.resetRepositoryReview.bind(database);
    vi.spyOn(database, "resetRepositoryReview").mockImplementationOnce(
      (...args: Parameters<RvwDatabase["resetRepositoryReview"]>) => {
        const current = database.getRepositoryReview(opened.repositoryReview.id);
        if (!current) throw new Error("missing Repository Review before relocation race");
        database.relocateRepositoryReview(
          current.id,
          {
            localRepositoryPath: current.localRepositoryPath,
            gitCommonDir: current.gitCommonDir,
            reviewChangeSequence: database.getReviewChangeSequence("repository", current.id),
          },
          {
            localRepositoryPath: candidate.repositoryPath,
            gitCommonDir: candidate.gitCommonDir,
          },
        );
        return resetRepositoryReviewInDatabase(...args);
      },
    );

    const error = (await service
      .resetRepositoryReview(opened.repositoryReview.id, preview.confirmationToken)
      .catch((caught: unknown) => caught)) as RvwError;
    expect(error).toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    const currentPreview = (
      error.details as {
        currentPreview: {
          repositoryReview: RepositoryReview;
          counts: RepositoryResetCounts;
          retainedRefs: string[];
          reviewChangeSequence: number;
          confirmationToken: string;
        };
      }
    ).currentPreview;
    expect(currentPreview).toMatchObject({
      repositoryReview: {
        id: opened.repositoryReview.id,
        localRepositoryPath: candidate.repositoryPath,
        gitCommonDir: candidate.gitCommonDir,
      },
      counts: { gitRefs: 2 },
      reviewChangeSequence: database.getReviewChangeSequence(
        "repository",
        opened.repositoryReview.id,
      ),
    });
    expect(currentPreview.retainedRefs).toEqual(
      expect.arrayContaining([sourceRef, candidateOnlyRef]),
    );
    expect(currentPreview.confirmationToken).not.toBe(preview.confirmationToken);
    await expect(service.git.listRefsByPrefix(repositoryPath, prefix)).resolves.toEqual([
      sourceRef,
    ]);
  });

  it("preserves the final reset CAS error when its current preview cannot be rebuilt", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const preview = await service.getRepositoryResetPreview(opened.repositoryReview.id);
    const resetRepositoryReviewInDatabase = database.resetRepositoryReview.bind(database);
    vi.spyOn(database, "resetRepositoryReview").mockImplementationOnce(
      (...args: Parameters<RvwDatabase["resetRepositoryReview"]>) => {
        database.incrementChangeSequence({
          kind: "repository",
          reviewId: opened.repositoryReview.id,
        });
        renameSync(repositoryPath, `${repositoryPath}-unavailable-during-stale-preview`);
        return resetRepositoryReviewInDatabase(...args);
      },
    );

    const error = (await service
      .resetRepositoryReview(opened.repositoryReview.id, preview.confirmationToken)
      .catch((caught: unknown) => caught)) as RvwError;
    expect(error).toMatchObject({ code: "DESTRUCTIVE_PREVIEW_STALE", status: 409 });
    expect(error.details).not.toHaveProperty("currentPreview");
    expect(database.getRepositoryReview(opened.repositoryReview.id)).not.toBeNull();
  });

  it("reports a concurrently requested Repository Issue in exactly one Walkthrough update", async () => {
    const gitClient = new RepositoryRetainBarrierGitClient();
    const { repositoryPath, sourceOid, github, service } = setup(gitClient);
    github.issues.set(142, issue(142));
    await service.openRepositoryReview(repositoryPath);
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
      review: { kind: "repository", repository: "acme/review-repo" },
      ...content,
      title: "Concurrent target A",
    });
    const second = await service.publishWalkthrough({
      review: { kind: "repository", repository: "acme/review-repo" },
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
    const opened = await service.openRepositoryReview(repositoryPath);

    await expect(
      service.publishWalkthrough({
        review: { kind: "repository", repository: "acme/review-repo" },
        sourceOid: opened.repositoryReview.sourceOid,
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
    expect(service.listRepositoryWalkthroughs(opened.repositoryReview.id)).toEqual([]);
    expect(service.listRepositoryIssues(opened.repositoryReview.id)).toEqual([]);
  });

  it("requires a resolvable canonical remote before Walkthroughs add Issue memberships", async () => {
    const { repositoryPath, github, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    const content = {
      sourceOid: opened.repositoryReview.sourceOid,
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
    };
    const published = await service.publishWalkthrough({
      review: { kind: "repository", repository: "acme/review-repo" },
      ...content,
      title: "Cached local walkthrough",
    });
    git(repositoryPath, "remote", "remove", "origin");

    await expect(
      service.publishWalkthrough({
        review: { kind: "repository", repository: "acme/review-repo" },
        ...content,
        title: "Must require the remote",
        issuesToAdd: ["#142"],
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });
    await expect(
      service.updateWalkthrough(published.walkthrough.ref, {
        ...content,
        title: "Must still require the remote",
        issuesToAdd: ["#142"],
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });
    expect(service.listRepositoryIssues(opened.repositoryReview.id)).toEqual([]);
    expect(
      service.getRepositoryWalkthrough(opened.repositoryReview.id, published.walkthrough.id),
    ).toMatchObject({ title: "Cached local walkthrough" });
  });

  it("bounds Walkthrough Issue additions before making GitHub requests", async () => {
    const { repositoryPath, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const request = {
      review: { kind: "repository" as const, repository: "acme/review-repo" },
      sourceOid: opened.repositoryReview.sourceOid,
      title: "Bounded Issue additions",
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
    };

    await expect(
      service.publishWalkthrough({
        ...request,
        issuesToAdd: Array.from({ length: 51 }, (_, index) => `#${index + 1}`),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.publishWalkthrough({ ...request, issuesToAdd: [`#${"1".repeat(256)}`] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(service.listRepositoryWalkthroughs(opened.repositoryReview.id)).toEqual([]);
  });

  it("places and deletes Repository Walkthrough comments through the shared viewer operations", async () => {
    const { repositoryPath, sourceOid, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const { walkthrough } = await service.publishWalkthrough({
      review: { kind: "repository", repository: "acme/review-repo" },
      sourceOid,
      title: "Repository Review walkthrough",
      body: "# Repository Review walkthrough\n\nRead [the source](rvw-ref:source).",
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
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "walkthrough", walkthroughId: walkthrough.id, startLine: 3, endLine: 3 },
      body: "Check this step.",
    });

    expect(
      service.placeRepositoryWalkthroughComment(
        opened.repositoryReview.id,
        comment,
        walkthrough.id,
      ),
    ).toEqual({ outdated: false, range: { startLine: 3, endLine: 3 }, path: null });
    await expect(
      deleteRepositoryWalkthrough(service, opened.repositoryReview.id, walkthrough.id),
    ).resolves.toMatchObject({
      id: walkthrough.id,
      repositoryReviewId: opened.repositoryReview.id,
      counts: { comments: 1, posts: 1, references: 1 },
    });
    expect(database.getRepositoryWalkthrough(walkthrough.id)).toBeNull();
    expect(database.getRepositoryComment(comment.id)).toBeNull();
  });

  it("keeps the last source readable and records an explicit sync error", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    github.repositoryError = new Error("repository metadata unavailable");

    await expect(service.openRepositoryReview(repositoryPath)).resolves.toMatchObject({
      fromCache: true,
      repositoryReview: { id: opened.repositoryReview.id, sourceOid },
    });

    await expect(service.syncRepositoryReview(repositoryPath)).rejects.toThrow(
      "repository metadata unavailable",
    );
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toMatchObject({
      sourceOid,
      sourceSyncError: "repository metadata unavailable",
    });
    await expect(
      service.getRepositoryReviewDocument({
        kind: "repository-file",
        repositoryReviewId: opened.repositoryReview.id,
        sourceOid,
        path: "README.md",
      }),
    ).resolves.toMatchObject({ availability: "available" });
  });

  it("allows bound cached reads and local cleanup when the GitHub remote is unavailable", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    await service.addRepositoryIssue(repositoryPath, "#142");
    const resolvedComment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "repository" },
      body: "Resolve this from the verified local binding.",
    });
    const deletedComment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "repository" },
      body: "Delete this from the verified local binding.",
    });
    const reply = await service.replyToComment(resolvedComment.ref, {
      body: "Delete only this reply.",
    });
    const { walkthrough } = await service.publishWalkthrough({
      review: { kind: "repository", repository: "acme/review-repo" },
      sourceOid,
      title: "Delete from local binding",
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
    });
    const repositoryRequests = github.repositoryRequests;
    git(repositoryPath, "remote", "remove", "origin");

    await expect(service.openRepositoryReview(repositoryPath)).resolves.toMatchObject({
      fromCache: true,
      repositoryReview: { id: opened.repositoryReview.id },
    });
    await expect(
      service.getRepositoryReviewDocument({
        kind: "repository-file",
        repositoryReviewId: opened.repositoryReview.id,
        sourceOid,
        path: "README.md",
      }),
    ).resolves.toMatchObject({ availability: "available" });
    await expect(
      service.listRepositoryCommentContextsAtPath(repositoryPath),
    ).resolves.toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
    });
    await expect(service.syncRepositoryReview(repositoryPath)).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
    });
    await expect(service.addRepositoryIssue(repositoryPath, "#142")).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
    });
    expect(github.repositoryRequests).toBe(repositoryRequests);
    expect(database.getRepositoryReview(opened.repositoryReview.id)?.sourceSyncError).toBeNull();

    const resolved = await service.setCommentResolved(resolvedComment.ref, true);
    expect(resolved.resolvedAt).not.toBeNull();
    await expect(service.deleteReply(resolvedComment.id, reply.id)).resolves.toMatchObject({
      postId: reply.id,
    });
    await expect(service.deleteComment(deletedComment.ref)).resolves.toMatchObject({
      id: deletedComment.id,
    });
    const currentWalkthroughPreview = await service.getWalkthroughDeletePreview(walkthrough.ref);
    await expect(
      service.deleteRepositoryWalkthrough(
        opened.repositoryReview.id,
        walkthrough.id,
        currentWalkthroughPreview.confirmationToken,
      ),
    ).resolves.toMatchObject({ id: walkthrough.id });

    await expect(removeRepositoryIssue(service, repositoryPath, "#142")).resolves.toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
    });
    await expect(resetRepositoryReviewAtPath(service, repositoryPath)).resolves.toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
    });
  });

  it("moves a remote-less cached binding to another worktree in the same common directory", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const worktreeA = `${repositoryPath}-cached-a`;
    const worktreeB = `${repositoryPath}-cached-b`;
    git(repositoryPath, "worktree", "add", "--detach", worktreeA, sourceOid);
    git(repositoryPath, "worktree", "add", "--detach", worktreeB, sourceOid);
    const opened = await service.openRepositoryReview(worktreeA);
    const added = await service.addRepositoryIssue(worktreeA, "#142");
    const walkthrough = await service.publishWalkthrough({
      review: { kind: "repository", repository: "acme/review-repo" },
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

    const reopened = await service.openRepositoryReview(worktreeB);
    const worktreeBContext = await service.git.repositoryContext(worktreeB);
    expect(reopened).toMatchObject({
      fromCache: true,
      repositoryReview: {
        id: opened.repositoryReview.id,
        localRepositoryPath: worktreeBContext.worktreePath,
      },
    });
    const tree = await service.getRepositoryTree(opened.repositoryReview.id);
    expect(tree.entries.some((entry) => entry.path === "README.md")).toBe(true);
    await expect(
      service.getRepositoryReviewDocument({
        kind: "repository-file",
        repositoryReviewId: opened.repositoryReview.id,
        sourceOid,
        path: "README.md",
      }),
    ).resolves.toMatchObject({ text: "# Fixture\n" });
    const search = await service.searchRepositoryReview(opened.repositoryReview.id, "Fixture", {
      matchCase: true,
      wholeWord: true,
    });
    expect(search.results.some((result) => result.path === "README.md")).toBe(true);
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
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
      service.placeRepositoryCommentAtCommit(opened.repositoryReview.id, comment, sourceOid),
    ).resolves.toEqual({
      outdated: false,
      range: { startLine: 1, endLine: 1 },
      path: "README.md",
    });
    expect(
      service.getRepositoryWalkthrough(opened.repositoryReview.id, walkthrough.walkthrough.id),
    ).toEqual(walkthrough.walkthrough);
    expect(
      service.getReviewIssue("repository", opened.repositoryReview.id, added.issue.id),
    ).toMatchObject({
      id: added.issue.id,
    });
    await expect(
      service.listRepositoryCommentContextsById(opened.repositoryReview.id),
    ).resolves.toHaveLength(1);

    const sequence = database.getReviewChangeSequence("repository", opened.repositoryReview.id);
    await expect(service.getRepositoryResetPreviewAtPath(worktreeB)).resolves.toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
    });
    expect(database.getReviewChangeSequence("repository", opened.repositoryReview.id)).toBe(
      sequence,
    );
    const independentClone = createGitRepository("rvw-branch-offline-independent-");
    git(independentClone, "remote", "remove", "origin");
    await expect(service.openRepositoryReview(independentClone)).rejects.toMatchObject({
      code: "REPOSITORY_MISMATCH",
    });
    await expect(resetRepositoryReviewAtPath(service, worktreeB)).resolves.toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
    });
  });

  it("uses the resolved worktree for path-based comments without persisting its location", async () => {
    const { repositoryPath, sourceOid, database, service } = setup();
    const worktreeA = `${repositoryPath}-comments-a`;
    const worktreeB = `${repositoryPath}-comments-b`;
    git(repositoryPath, "worktree", "add", "--detach", worktreeA, sourceOid);
    git(repositoryPath, "worktree", "add", "--detach", worktreeB, sourceOid);
    const opened = await service.openRepositoryReview(worktreeA);
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid,
        path: "README.md",
        startLine: 1,
        endLine: 1,
      },
      body: "Place this from the explicitly resolved worktree.",
    });
    const saved = database.getRepositoryReview(opened.repositoryReview.id);
    const sequence = database.getReviewChangeSequence("repository", opened.repositoryReview.id);
    git(repositoryPath, "remote", "remove", "origin");
    git(repositoryPath, "worktree", "remove", "--force", worktreeA);

    await expect(service.listRepositoryCommentContextsAtPath(worktreeB)).resolves.toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id },
      comments: [
        {
          comment: { id: comment.id },
          latestPlacement: {
            outdated: false,
            range: { startLine: 1, endLine: 1 },
            path: "README.md",
          },
        },
      ],
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toEqual(saved);
    expect(database.getReviewChangeSequence("repository", opened.repositoryReview.id)).toBe(
      sequence,
    );
  });

  it("recovers process crashes before and after initial retained-ref creation", async () => {
    const { repositoryPath, github, database, service } = setup();
    const repository = await service.git.repositoryContext(repositoryPath);
    const beforeRef = database.beginRepositoryReviewInitialization(github.repository, {
      localRepositoryPath: repository.worktreePath,
      gitCommonDir: repository.gitCommonDir,
    }).repositoryReview;
    expect(beforeRef).toMatchObject({ initializationState: "pending", sourceSyncError: null });
    await expect(resetRepositoryReviewAtPath(service, repositoryPath)).resolves.toMatchObject({
      repositoryReview: { id: beforeRef.id },
      deleted: { repositoryReview: 1, gitRefs: 0 },
    });

    const afterRef = database.beginRepositoryReviewInitialization(github.repository, {
      localRepositoryPath: repository.worktreePath,
      gitCommonDir: repository.gitCommonDir,
    }).repositoryReview;
    await service.git.ensureRepositoryReviewCommitRef(
      repositoryPath,
      afterRef.id,
      afterRef.sourceOid,
    );
    const recovered = await service.openRepositoryReview(repositoryPath);
    expect(recovered).toMatchObject({
      fromCache: true,
      repositoryReview: { id: afterRef.id, initializationState: "ready", sourceSyncError: null },
    });
  });

  it("waits for an explicitly pending concurrent initialization beyond the old heuristic", async () => {
    const gitClient = new PauseBeforeInitialRepositoryReviewRefGitClient();
    gitClient.barrier.arm();
    const { repositoryPath, database, service } = setup(gitClient);

    const firstOpen = service.openRepositoryReview(repositoryPath);
    await gitClient.barrier.waitUntilBlocked();
    expect(
      database.findRepositoryReviewByIdentity("acme", "review-repo")?.initializationState,
    ).toBe("pending");
    const startedAt = Date.now();
    const secondOpen = service.openRepositoryReview(repositoryPath);
    await new Promise((resolve) => setTimeout(resolve, 250));
    gitClient.barrier.release();

    const [first, second] = await Promise.all([firstOpen, secondOpen]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(second).toMatchObject({
      fromCache: true,
      repositoryReview: {
        id: first.repositoryReview.id,
        initializationState: "ready",
        sourceSyncError: null,
      },
    });
  });

  it("recovers an initial retained-ref failure through explicit Repository Review reset", async () => {
    const gitClient = new FailInitialRepositoryReviewRefGitClient();
    const { repositoryPath, database, service } = setup(gitClient);

    await expect(service.openRepositoryReview(repositoryPath)).rejects.toMatchObject({
      code: "LOCAL_STATE_INCONSISTENT",
      details: {
        databaseUpdated: true,
        retainedRefCreated: false,
        repairableByExplicitReset: true,
      },
    });
    const uninitialized = database.findRepositoryReviewByIdentity("acme", "review-repo");
    expect(uninitialized).toMatchObject({ initializationState: "failed" });
    expect(uninitialized?.sourceSyncError).toBeTruthy();
    await expect(service.openRepositoryReview(repositoryPath)).rejects.toMatchObject({
      code: "LOCAL_STATE_INCONSISTENT",
    });
    await expect(service.syncRepositoryReview(repositoryPath)).rejects.toMatchObject({
      code: "LOCAL_STATE_INCONSISTENT",
    });
    const preview = await service.getRepositoryResetPreviewAtPath(repositoryPath);
    expect(preview).toMatchObject({
      repositoryReview: { id: uninitialized?.id },
      counts: { repositoryReview: 1, gitRefs: 0 },
    });
    await expect(resetRepositoryReviewAtPath(service, repositoryPath)).resolves.toMatchObject({
      repositoryReview: { id: uninitialized?.id },
      deleted: { repositoryReview: 1, gitRefs: 0 },
    });
    expect(database.getRepositoryReview(uninitialized!.id)).toBeNull();
    const recovered = await service.openRepositoryReview(repositoryPath);
    expect(recovered.repositoryReview.id).not.toBe(uninitialized!.id);
    await expect(
      service.git.verifyRepositoryReviewCommitRef(
        repositoryPath,
        recovered.repositoryReview.id,
        recovered.repositoryReview.sourceOid,
      ),
    ).resolves.toBe(true);
  });

  it("cleans a delayed initial ref created after reset deleted its aggregate", async () => {
    const gitClient = new PauseBeforeInitialRepositoryReviewRefGitClient();
    gitClient.barrier.arm();
    const { repositoryPath, database, service } = setup(gitClient);

    const opening = service.openRepositoryReview(repositoryPath);
    await gitClient.barrier.waitUntilBlocked();
    const pending = database.findRepositoryReviewByIdentity("acme", "review-repo");
    expect(pending).toMatchObject({ initializationState: "pending", sourceSyncError: null });
    await expect(resetRepositoryReviewAtPath(service, repositoryPath)).resolves.toMatchObject({
      repositoryReview: { id: pending!.id },
      deleted: { repositoryReview: 1, gitRefs: 0 },
    });

    gitClient.barrier.release();
    await expect(opening).rejects.toMatchObject({ code: "REPOSITORY_REVIEW_NOT_FOUND" });
    expect(database.getRepositoryReview(pending!.id)).toBeNull();
    await expect(
      service.git.listRefsByPrefix(repositoryPath, `refs/rvw/repository/${pending!.id}/commits/`),
    ).resolves.toEqual([]);
  });

  it("removes only owned Issue artifacts and resets only the Repository Review", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    github.issues.set(142, issue(142));
    github.issues.set(143, issue(143));
    const opened = await service.openRepositoryReview(repositoryPath);
    await service.addRepositoryIssue(repositoryPath, "#142");
    const repositoryIssueComment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "issue", issue: "#142", startLine: 1, endLine: 1 },
      body: "Repository Review-owned Issue comment.",
    });
    await service.replyToComment(repositoryIssueComment.ref, { body: "Repository Review reply." });

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
      { localRepositoryPath: repositoryPath, gitCommonDir: opened.repositoryReview.gitCommonDir },
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
    expect(service.listRepositoryIssues(opened.repositoryReview.id)).toEqual([
      expect.objectContaining({ number: 142 }),
    ]);
    await service.addPullRequestIssue(pullRequest.url, "#142");
    const retainedPullRequestIssueComment = await service.createComment({
      pullRequestId: pullRequest.id,
      target: { kind: "issue", issue: "#142", startLine: null, endLine: null },
      body: "PR comment retained across Repository Review deletion.",
    });

    expect(
      service.getIssueRemovalPreview("repository", opened.repositoryReview.id, "#142"),
    ).toMatchObject({
      issue: { number: 142 },
      counts: { issueWholeComments: 0, issueRangeComments: 1, replies: 1 },
      confirmationRequired: true,
    });
    const removed = await removeRepositoryIssue(service, repositoryPath, "#142");
    expect(removed.deleted).toEqual({
      issueWholeComments: 0,
      issueRangeComments: 1,
      replies: 1,
    });
    expect(service.listRepositoryIssues(opened.repositoryReview.id)).toEqual([]);
    expect(database.getRepositoryComment(repositoryIssueComment.id)).toBeNull();
    expect(service.listPullRequestIssues(pullRequest.id)).toEqual([
      expect.objectContaining({ number: 142 }),
    ]);
    expect(database.getComment(retainedPullRequestIssueComment.id)).not.toBeNull();
    expect(database.getIssue(removed.issue.id)).not.toBeNull();

    await service.addRepositoryIssue(repositoryPath, "#143");
    await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid,
        path: "README.md",
        startLine: 1,
        endLine: 1,
      },
      body: "Repository Review code comment.",
    });
    await service.publishWalkthrough({
      review: { kind: "repository", repository: "acme/review-repo" },
      sourceOid,
      title: "Disposable Repository Review walkthrough",
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
    const unrelatedRepositoryRef = `refs/rvw/repository/00000000-0000-4000-8000-000000000099/commits/oid-${sourceOid}`;
    git(repositoryPath, "update-ref", unrelatedRepositoryRef, sourceOid);
    const preview = await service.getRepositoryResetPreview(opened.repositoryReview.id);
    expect(preview).toMatchObject({
      counts: {
        repositoryReview: 1,
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
    expect(preview.retainedRefs).not.toContain(unrelatedRepositoryRef);
    expect(preview.counts.gitRefs).toBe(preview.retainedRefs.length);

    const reset = await resetRepositoryReview(service, opened.repositoryReview.id);
    expect(reset.deleted.gitRefs).toBe(preview.retainedRefs.length);
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toBeNull();
    expect(service.listPullRequestIssues(pullRequest.id)).toHaveLength(1);
    expect(database.getComment(retainedPullRequestIssueComment.id)).not.toBeNull();
    await expect(
      service.git.listRefsByPrefix(
        repositoryPath,
        `refs/rvw/repository/${opened.repositoryReview.id}/commits/`,
      ),
    ).resolves.toEqual([]);
    expect(git(repositoryPath, "rev-parse", "--verify", unrelatedRepositoryRef)).toBe(sourceOid);

    const recreated = await service.openRepositoryReview(repositoryPath);
    expect(recreated.repositoryReview.id).not.toBe(opened.repositoryReview.id);
    expect(service.listRepositoryIssues(recreated.repositoryReview.id)).toEqual([]);
  });

  it("notifies every owning Review only when a shared Issue cache changes", async () => {
    const { repositoryPath, sourceOid, github, database, service } = setup();
    github.issues.set(142, issue(142));
    const opened = await service.openRepositoryReview(repositoryPath);
    await service.addRepositoryIssue(repositoryPath, "#142");
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
      { localRepositoryPath: repositoryPath, gitCommonDir: opened.repositoryReview.gitCommonDir },
      sourceOid,
    );
    await service.addPullRequestIssue(pullRequest.url, "#142");

    const unchangedPullRequestSequence = database.getReviewChangeSequence(
      "pull-request",
      pullRequest.id,
    );
    await service.syncRepositoryReview(repositoryPath);
    expect(database.getReviewChangeSequence("pull-request", pullRequest.id)).toBe(
      unchangedPullRequestSequence,
    );

    github.issues.set(
      142,
      issue(142, "Requirement 142\nUpdated shared evidence", "2026-08-20T01:00:00.000Z"),
    );
    const repositorySequence = database.getReviewChangeSequence(
      "repository",
      opened.repositoryReview.id,
    );
    await service.syncRepositoryReview(repositoryPath);

    expect(database.getReviewChangeSequence("pull-request", pullRequest.id)).toBeGreaterThan(
      unchangedPullRequestSequence,
    );
    expect(
      database.getReviewChangeSequence("repository", opened.repositoryReview.id),
    ).toBeGreaterThan(repositorySequence);
    expect(service.listPullRequestIssues(pullRequest.id)).toEqual([
      expect.objectContaining({ body: "Requirement 142\nUpdated shared evidence" }),
    ]);
  });

  it("advances only the source snapshot and retains more than one hundred Issue memberships", async () => {
    const { repositoryPath, github, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    for (let number = 1; number <= 105; number += 1) {
      github.issues.set(number, issue(number));
      await service.addRepositoryIssue(repositoryPath, `#${number}`);
    }
    expect(service.listRepositoryIssues(opened.repositoryReview.id)).toHaveLength(105);
    expect(
      service
        .listRepositoryIssues(opened.repositoryReview.id)
        .slice(0, 3)
        .map(({ number }) => number),
    ).toEqual([105, 104, 103]);

    const previousHead = git(repositoryPath, "rev-parse", "HEAD");
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
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
    const synchronized = await service.syncRepositoryReview(repositoryPath);
    expect(github.maxActiveIssueFetches).toBe(8);
    expect(synchronized.repositoryReview.sourceOid).toBe(nextHead);
    expect(git(repositoryPath, "rev-parse", "HEAD")).toBe(previousHead);
    expect(await service.git.hasObject(repositoryPath, nextHead)).toBe(true);
    await expect(
      service.placeRepositoryCommentAtCommit(opened.repositoryReview.id, comment, previousHead),
    ).resolves.toEqual({
      outdated: false,
      range: { startLine: 1, endLine: 1 },
      path: "README.md",
    });
    await expect(service.getAnyCommentReviewContext(comment.ref)).resolves.toMatchObject({
      latestPlacement: { outdated: false, range: { startLine: 2, endLine: 2 } },
    });
    const historicalDocument = await service.getRepositoryReviewDocument({
      kind: "repository-file",
      repositoryReviewId: opened.repositoryReview.id,
      sourceOid: previousHead,
      path: "README.md",
    });
    expect(historicalDocument.text).toContain(previousReadme);
  }, 10_000);

  it("rejects locally available commits outside the current or retained Repository Review source", async () => {
    const { repositoryPath, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const unretainedOid = commitFile(
      repositoryPath,
      "topic-only.txt",
      "This commit was never synchronized as the default branch.\n",
      "local topic commit",
    );
    expect(await service.git.hasObject(repositoryPath, unretainedOid)).toBe(true);

    await expect(
      service.getRepositoryReviewDocument({
        kind: "repository-file",
        repositoryReviewId: opened.repositoryReview.id,
        sourceOid: unretainedOid,
        path: "topic-only.txt",
      }),
    ).rejects.toMatchObject({ code: "COMMIT_NOT_FOUND" });

    await expect(
      service.createRepositoryComment({
        repositoryReviewId: opened.repositoryReview.id,
        target: {
          kind: "document",
          documentKind: "repository-file",
          sourceOid: opened.repositoryReview.sourceOid,
          path: "README.md",
          startLine: 1,
          endLine: 1,
        },
        body: "The local topic commit must not become Repository Review evidence.",
        relatedCommitOid: unretainedOid,
        references: [],
      }),
    ).rejects.toMatchObject({ code: "COMMIT_NOT_FOUND" });
  });

  it("rejects historical Comment reads when the review-owned ref is missing but the object remains", async () => {
    const { repositoryPath, sourceOid, github, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const comment = await service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid,
        path: "README.md",
        startLine: 1,
        endLine: 1,
      },
      body: "This historical source must remain allowlisted.",
    });
    const nextOid = commitFile(repositoryPath, "README.md", "# Fixture\n\nNext source.\n", "next");
    github.repository = { ...github.repository, defaultBranchOid: nextOid };
    await service.syncRepositoryReview(repositoryPath);
    const historicalRef = service.git.repositoryReviewCommitRef(
      opened.repositoryReview.id,
      sourceOid,
    );
    git(repositoryPath, "update-ref", "-d", historicalRef);
    expect(await service.git.hasObject(repositoryPath, sourceOid)).toBe(true);

    await expect(
      service.getRepositoryReviewDocument({
        kind: "repository-file",
        repositoryReviewId: opened.repositoryReview.id,
        sourceOid,
        path: "README.md",
      }),
    ).rejects.toMatchObject({
      code: "COMMIT_NOT_FOUND",
      details: { sourceOid, retainedRefAvailable: false, gitObjectAvailable: true },
    });
    await expect(
      service.placeRepositoryCommentAtCommit(opened.repositoryReview.id, comment, nextOid),
    ).rejects.toMatchObject({ code: "COMMIT_NOT_FOUND", details: { sourceOid } });
    await expect(service.getAnyCommentReviewContext(comment.ref)).rejects.toMatchObject({
      code: "COMMIT_NOT_FOUND",
      details: { sourceOid },
    });
    await expect(
      service.listRepositoryCommentContextsById(opened.repositoryReview.id, false),
    ).rejects.toMatchObject({ code: "COMMIT_NOT_FOUND", details: { sourceOid } });

    const app = httpApp(service);
    const placement = await app.request(
      `http://127.0.0.1:4321/api/comments/${comment.id}/placement?${new URLSearchParams({
        kind: "repository-file",
        repositoryReviewId: opened.repositoryReview.id,
        sourceOid: nextOid,
        path: "README.md",
      }).toString()}`,
      { headers: { host: "127.0.0.1:4321" } },
    );
    expect(placement.status).toBe(404);
    await expect(placement.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "COMMIT_NOT_FOUND", details: { sourceOid } },
    });
  });

  it("bounds Repository Review Comment placement Git reads", async () => {
    const gitClient = new CountingRepositoryDocumentGitClient();
    const { repositoryPath, github, service } = setup(gitClient);
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(path.join(repositoryPath, `file-${index}.txt`), `line ${index}\n`, "utf8");
    }
    git(repositoryPath, "add", ".");
    git(repositoryPath, "commit", "-m", "add placement fixtures");
    const sourceOid = git(repositoryPath, "rev-parse", "HEAD");
    github.repository = { ...github.repository, defaultBranchOid: sourceOid };
    const opened = await service.openRepositoryReview(repositoryPath);
    for (let index = 0; index < 12; index += 1) {
      await service.createRepositoryComment({
        repositoryReviewId: opened.repositoryReview.id,
        target: {
          kind: "document",
          documentKind: "repository-file",
          sourceOid,
          path: `file-${index}.txt`,
          startLine: 1,
          endLine: 1,
        },
        body: `Comment ${index}`,
      });
    }
    const nextOid = commitFile(repositoryPath, "README.md", "# Fixture\n\nAdvance.\n", "advance");
    github.repository = { ...github.repository, defaultBranchOid: nextOid };
    await service.syncRepositoryReview(repositoryPath);
    gitClient.resetDocumentReadCounts();

    await expect(
      service.listRepositoryCommentContextsById(opened.repositoryReview.id),
    ).resolves.toHaveLength(12);
    expect(gitClient.maxActiveDocumentReads).toBeGreaterThan(1);
    expect(gitClient.maxActiveDocumentReads).toBeLessThanOrEqual(8);
  });

  it("accepts a reset when Git ref deletion reports an error after applying the transaction", async () => {
    const { repositoryPath, database, service } = setup(new DeleteThenThrowGitClient());
    const opened = await service.openRepositoryReview(repositoryPath);
    const preview = await service.getRepositoryResetPreview(opened.repositoryReview.id);
    expect(preview.retainedRefs.length).toBeGreaterThan(0);

    await expect(resetRepositoryReview(service, opened.repositoryReview.id)).resolves.toMatchObject(
      {
        deleted: { gitRefs: preview.retainedRefs.length },
        removedRefs: preview.retainedRefs,
      },
    );
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toBeNull();
    await expect(
      service.git.listRefsByPrefix(
        repositoryPath,
        `refs/rvw/repository/${opened.repositoryReview.id}/commits/`,
      ),
    ).resolves.toEqual([]);
  });

  it("returns a completed-with-orphan-refs outcome when reset leaves retained refs behind", async () => {
    const { repositoryPath, service } = setup(new ThrowBeforeDeleteGitClient());
    const opened = await service.openRepositoryReview(repositoryPath);
    const preview = await service.getRepositoryResetPreview(opened.repositoryReview.id);

    await expect(resetRepositoryReview(service, opened.repositoryReview.id)).resolves.toMatchObject(
      {
        outcome: {
          kind: "completed-with-orphan-refs",
          repositoryReviewDeleted: true,
          remainingRefs: preview.retainedRefs,
        },
      },
    );
  });

  it("post-checks and removes a ref retained after reset cleanup listed the namespace", async () => {
    const gitClient = new PauseBeforeRepositoryResetRefDeleteGitClient();
    const { repositoryPath, database, service } = setup(gitClient);
    const opened = await service.openRepositoryReview(repositoryPath);
    const lateOid = commitFile(
      repositoryPath,
      "late-evidence.txt",
      "late evidence\n",
      "late reset evidence",
    );
    const prefix = `refs/rvw/repository/${opened.repositoryReview.id}/commits/`;
    gitClient.arm();

    const reset = resetRepositoryReview(service, opened.repositoryReview.id);
    await gitClient.barrier.waitUntilBlocked();
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toBeNull();
    const lateRef = (
      await service.git.ensureRepositoryReviewCommitRef(
        repositoryPath,
        opened.repositoryReview.id,
        lateOid,
      )
    ).ref;
    gitClient.barrier.release();

    const result = await reset;
    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.removedRefs).not.toContain(lateRef);
    expect(result.deleted.gitRefs).toBe(result.removedRefs.length);
    await expect(service.git.listRefsByPrefix(repositoryPath, prefix)).resolves.toEqual([]);
  });

  it("reports a ref retained after reset cleanup when the bounded retry fails", async () => {
    const gitClient = new PauseBeforeRepositoryResetRefDeleteGitClient();
    const { repositoryPath, database, service } = setup(gitClient);
    const opened = await service.openRepositoryReview(repositoryPath);
    const lateOid = commitFile(
      repositoryPath,
      "orphan-evidence.txt",
      "orphan evidence\n",
      "orphan reset evidence",
    );
    const prefix = `refs/rvw/repository/${opened.repositoryReview.id}/commits/`;
    gitClient.arm(true);

    const reset = resetRepositoryReview(service, opened.repositoryReview.id);
    await gitClient.barrier.waitUntilBlocked();
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toBeNull();
    const lateRef = (
      await service.git.ensureRepositoryReviewCommitRef(
        repositoryPath,
        opened.repositoryReview.id,
        lateOid,
      )
    ).ref;
    gitClient.barrier.release();

    const result = await reset;
    expect(result.outcome).toEqual({
      kind: "completed-with-orphan-refs",
      repositoryReviewDeleted: true,
      remainingRefs: [lateRef],
      refPrefix: prefix,
      repositoryPath: opened.repositoryReview.localRepositoryPath,
      manualCleanupPossible: true,
    });
    expect(result.removedRefs).not.toContain(lateRef);
    expect(result.deleted.gitRefs).toBe(result.removedRefs.length);
    await expect(service.git.listRefsByPrefix(repositoryPath, prefix)).resolves.toEqual([lateRef]);
  });

  it("removes a ref recreated by an artifact writer after its Repository Review was reset", async () => {
    const gitClient = new PauseBeforeRepositoryArtifactRetainGitClient();
    const { repositoryPath, database, service } = setup(gitClient);
    const opened = await service.openRepositoryReview(repositoryPath);
    const prefix = `refs/rvw/repository/${opened.repositoryReview.id}/commits/`;
    gitClient.arm();

    const writer = service.createRepositoryComment({
      repositoryReviewId: opened.repositoryReview.id,
      target: { kind: "repository" },
      body: "This late writer must not leave an orphan ref.",
      relatedCommitOid: opened.repositoryReview.sourceOid,
    });
    await gitClient.barrier.waitUntilBlocked();
    await resetRepositoryReview(service, opened.repositoryReview.id);
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toBeNull();
    await expect(service.git.listRefsByPrefix(repositoryPath, prefix)).resolves.toEqual([]);

    gitClient.barrier.release();
    await expect(writer).rejects.toBeDefined();
    await expect(service.git.listRefsByPrefix(repositoryPath, prefix)).resolves.toEqual([]);
  });

  it("isolates orphan refs from a replacement Repository Review after reset failure", async () => {
    const { repositoryPath, github, database, service } = setup(new ThrowBeforeDeleteGitClient());
    const old = await service.openRepositoryReview(repositoryPath);
    const oldOid = old.repositoryReview.sourceOid;
    const nextOid = commitFile(repositoryPath, "README.md", "# Replacement\n", "replace source");
    github.repository = { ...github.repository, defaultBranchOid: nextOid };
    const oldPrefix = `refs/rvw/repository/${old.repositoryReview.id}/commits/`;
    const oldPreview = await service.getRepositoryResetPreview(old.repositoryReview.id);

    await expect(resetRepositoryReview(service, old.repositoryReview.id)).resolves.toMatchObject({
      outcome: {
        kind: "completed-with-orphan-refs",
        repositoryReviewDeleted: true,
        refPrefix: oldPrefix,
        remainingRefs: oldPreview.retainedRefs,
      },
    });
    expect(database.getRepositoryReview(old.repositoryReview.id)).toBeNull();
    const doctor = await service.doctor(repositoryPath);
    expect(doctor.repositoryReviewRetainedRefs).not.toBeNull();
    for (const ref of oldPreview.retainedRefs) {
      expect(doctor.repositoryReviewRetainedRefs?.refs).toContainEqual({
        ref,
        reviewId: old.repositoryReview.id,
        oid: oldOid,
        status: "orphan-review",
      });
    }
    await expect(service.git.listRefsByPrefix(repositoryPath, oldPrefix)).resolves.toEqual(
      oldPreview.retainedRefs,
    );

    const replacement = await service.openRepositoryReview(repositoryPath);
    const newPrefix = `refs/rvw/repository/${replacement.repositoryReview.id}/commits/`;
    expect(replacement.repositoryReview.id).not.toBe(old.repositoryReview.id);
    expect(newPrefix).not.toBe(oldPrefix);
    await expect(service.git.listRefsByPrefix(repositoryPath, newPrefix)).resolves.toEqual([
      expect.stringContaining(`oid-${nextOid}`),
    ]);
    await expect(
      service.git.verifyRepositoryReviewCommitRef(
        repositoryPath,
        replacement.repositoryReview.id,
        oldOid,
      ),
    ).resolves.toBe(false);
    await expect(
      service.getRepositoryReviewDocument({
        kind: "repository-file",
        repositoryReviewId: replacement.repositoryReview.id,
        sourceOid: oldOid,
        path: "README.md",
      }),
    ).rejects.toMatchObject({ code: "COMMIT_NOT_FOUND" });
    await expect(
      service.createRepositoryComment({
        repositoryReviewId: replacement.repositoryReview.id,
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
        review: { kind: "repository", repository: "acme/review-repo" },
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
    await expect(resetRepositoryReview(service, old.repositoryReview.id)).rejects.toMatchObject({
      code: "REPOSITORY_REVIEW_NOT_FOUND",
    });
    await expect(service.git.listRefsByPrefix(repositoryPath, newPrefix)).resolves.toEqual(newRefs);
  });

  it("validates a stored repository path before deleting its Repository Review row", async () => {
    const { repositoryPath, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const saved = database.getRepositoryReview(opened.repositoryReview.id);
    const sequence = database.getChangeSequence();
    const archivedPath = `${repositoryPath}-original`;
    renameSync(repositoryPath, archivedPath);
    mkdirSync(repositoryPath);
    git(repositoryPath, "init", "-b", "main");
    git(repositoryPath, "remote", "add", "origin", "https://github.com/acme/review-repo.git");

    await expect(resetRepositoryReview(service, opened.repositoryReview.id)).rejects.toMatchObject({
      code: "LOCAL_STATE_INCONSISTENT",
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toEqual(saved);
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
      new RepositoryGitHub(repository),
    );
    const secondService = new RvwService(
      secondDatabase,
      new GitClient(),
      new RepositoryGitHub(repository),
    );

    const [first, second] = await Promise.all([
      firstService.openRepositoryReview(repositoryPath),
      secondService.openRepositoryReview(repositoryPath),
    ]);

    expect(first.repositoryReview.id).toBe(second.repositoryReview.id);
    expect(firstDatabase.findRepositoryReviewByIdentity("ACME", "REVIEW-REPO")?.id).toBe(
      first.repositoryReview.id,
    );
    expect(
      secondDatabase.findRepositoryReviewByGitCommonDir(first.repositoryReview.gitCommonDir)?.id,
    ).toBe(first.repositoryReview.id);
    expect(() =>
      firstDatabase.beginRepositoryReviewInitialization(
        {
          ...repository,
          owner: "other-owner",
          repository: "other-repo",
          canonicalName: "other-owner/other-repo",
        },
        {
          localRepositoryPath: repositoryPath,
          gitCommonDir: first.repositoryReview.gitCommonDir,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "REPOSITORY_MISMATCH" }));
    expect(() =>
      firstDatabase.beginRepositoryReviewInitialization(repository, {
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
    const staleGithub = new RepositoryGitHub({ ...baseRepository, defaultBranchOid: sourceX });
    const staleGit = new PauseAfterRepositoryObjectForOidGitClient(sourceX);
    staleGit.barrier.arm();
    const staleService = new RvwService(staleDatabase, staleGit, staleGithub);
    const winnerService = new RvwService(
      winnerDatabase,
      new GitClient(),
      new RepositoryGitHub({ ...baseRepository, defaultBranchOid: sourceY }),
    );

    const staleOpen = staleService.openRepositoryReview(repositoryPath);
    await staleGit.barrier.waitUntilBlocked();
    expect(staleDatabase.findRepositoryReviewByIdentity("acme", "review-repo")).toBeNull();

    const winner = await winnerService.openRepositoryReview(repositoryPath);
    expect(winner.repositoryReview.sourceOid).toBe(sourceY);
    staleGithub.repository = { ...baseRepository, defaultBranchOid: sourceY };
    staleGit.barrier.release();

    await expect(staleOpen).resolves.toMatchObject({
      repositoryReview: { id: winner.repositoryReview.id, sourceOid: sourceY },
    });
    expect(staleGithub.repositoryRequests).toBe(2);
    expect(staleDatabase.getRepositoryReview(winner.repositoryReview.id)).toMatchObject({
      sourceOid: sourceY,
      sourceSyncError: null,
    });
    await expect(
      staleGit.verifyRepositoryReviewCommitRef(repositoryPath, winner.repositoryReview.id, sourceX),
    ).resolves.toBe(false);
    await expect(
      staleGit.verifyRepositoryReviewCommitRef(repositoryPath, winner.repositoryReview.id, sourceY),
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
    const delayedGit = new PauseRepositoryReviewRefForOidGitClient(sourceX);
    delayedGit.barrier.arm();
    const delayedService = new RvwService(
      delayedDatabase,
      delayedGit,
      new RepositoryGitHub({ ...baseRepository, defaultBranchOid: sourceX }),
    );
    const currentGithub = new RepositoryGitHub({ ...baseRepository, defaultBranchOid: sourceX });
    const currentService = new RvwService(currentDatabase, new GitClient(), currentGithub);

    const delayedOpen = delayedService.openRepositoryReview(repositoryPath);
    await delayedGit.barrier.waitUntilBlocked();
    const pending = delayedDatabase.findRepositoryReviewByIdentity("acme", "review-repo");
    expect(pending).toMatchObject({
      sourceOid: sourceX,
      initializationState: "pending",
      sourceSyncError: null,
    });

    const initialized = await currentService.openRepositoryReview(repositoryPath);
    expect(initialized.repositoryReview).toMatchObject({
      id: pending!.id,
      sourceOid: sourceX,
      initializationState: "ready",
      sourceSyncError: null,
    });
    const comment = await currentService.createRepositoryComment({
      repositoryReviewId: initialized.repositoryReview.id,
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
    await expect(currentService.syncRepositoryReview(repositoryPath)).resolves.toMatchObject({
      repositoryReview: { id: initialized.repositoryReview.id, sourceOid: sourceY },
    });
    delayedGit.barrier.release();

    await expect(delayedOpen).resolves.toMatchObject({
      repositoryReview: { id: initialized.repositoryReview.id, sourceOid: sourceY },
    });
    await expect(
      delayedGit.verifyRepositoryReviewCommitRef(
        repositoryPath,
        initialized.repositoryReview.id,
        sourceX,
      ),
    ).resolves.toBe(true);
    await expect(
      delayedGit.verifyRepositoryReviewCommitRef(
        repositoryPath,
        initialized.repositoryReview.id,
        sourceY,
      ),
    ).resolves.toBe(true);
    await expect(currentService.getAnyCommentReviewContext(comment.ref)).resolves.toMatchObject({
      context: { kind: "repository", repositoryReviewId: initialized.repositoryReview.id },
      exactSource: { sourceOid: sourceX, availability: "available" },
    });
    await expect(
      currentService.getRepositoryReviewDocument({
        kind: "repository-file",
        repositoryReviewId: initialized.repositoryReview.id,
        sourceOid: sourceX,
        path: "README.md",
      }),
    ).resolves.toMatchObject({ availability: "available" });
  });

  it("publishes only the newest started Repository Review source sync", async () => {
    const { repositoryPath, github, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const sourceX = commitFile(repositoryPath, "source-x.txt", "x\n", "source X");
    const sourceY = commitFile(repositoryPath, "source-y.txt", "y\n", "source Y");
    const gitClient = new PauseRepositoryReviewRefForOidGitClient(sourceX);
    const orderedService = new RvwService(database, gitClient, github);
    github.repository = { ...github.repository, defaultBranchOid: sourceX };
    gitClient.barrier.arm();

    const olderSync = orderedService.syncRepositoryReview(repositoryPath);
    await gitClient.barrier.waitUntilBlocked();
    github.repository = { ...github.repository, defaultBranchOid: sourceY };
    const newerSync = await orderedService.syncRepositoryReview(repositoryPath);
    expect(newerSync.repositoryReview).toMatchObject({
      id: opened.repositoryReview.id,
      sourceOid: sourceY,
    });

    gitClient.barrier.release();
    await expect(olderSync).resolves.toMatchObject({
      repositoryReview: { id: opened.repositoryReview.id, sourceOid: sourceY },
    });
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toMatchObject({
      sourceOid: sourceY,
      sourceSyncError: null,
    });
  });

  it("does not let an older Repository Review source failure mark a newer success stale", async () => {
    const { repositoryPath, github, database, service } = setup();
    const opened = await service.openRepositoryReview(repositoryPath);
    const sourceX = commitFile(repositoryPath, "failing-x.txt", "x\n", "failing source X");
    const sourceY = commitFile(repositoryPath, "successful-y.txt", "y\n", "successful source Y");
    const gitClient = new PauseRepositoryReviewRefForOidGitClient(sourceX);
    gitClient.failAfterRelease = true;
    const orderedService = new RvwService(database, gitClient, github);
    github.repository = { ...github.repository, defaultBranchOid: sourceX };
    gitClient.barrier.arm();

    const olderSync = orderedService.syncRepositoryReview(repositoryPath);
    await gitClient.barrier.waitUntilBlocked();
    github.repository = { ...github.repository, defaultBranchOid: sourceY };
    await orderedService.syncRepositoryReview(repositoryPath);
    const sequenceAfterNewerSuccess = database.getReviewChangeSequence(
      "repository",
      opened.repositoryReview.id,
    );

    gitClient.barrier.release();
    await expect(olderSync).rejects.toThrow(`late retained-ref failure for ${sourceX}`);
    expect(database.getRepositoryReview(opened.repositoryReview.id)).toMatchObject({
      sourceOid: sourceY,
      sourceSyncError: null,
    });
    expect(database.getReviewChangeSequence("repository", opened.repositoryReview.id)).toBe(
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

    const opened = await service.openRepositoryReview(repositoryPath);
    expect(opened.repositoryReview.sourceOid).toBe(secondSource);
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
      new RepositoryGitHub({ ...baseRepository, defaultBranchOid: sourceX }),
    );
    const secondGithub = new RepositoryGitHub({ ...baseRepository, defaultBranchOid: sourceY });
    const repositoryBarrier = new OneShotBarrier();
    repositoryBarrier.arm();
    secondGithub.repositoryBarrier = repositoryBarrier;
    const secondService = new RvwService(
      secondDatabase,
      new FailRepositoryReviewRefForOidGitClient(sourceY),
      secondGithub,
    );

    const secondOpen = secondService.openRepositoryReview(repositoryPath);
    await repositoryBarrier.waitUntilBlocked();
    expect(secondDatabase.findRepositoryReviewByIdentity("acme", "review-repo")).toBeNull();

    const firstOpen = await firstService.openRepositoryReview(repositoryPath);
    const firstSnapshot = firstDatabase.getRepositoryReview(firstOpen.repositoryReview.id);
    const sequence = firstDatabase.getReviewChangeSequence(
      "repository",
      firstOpen.repositoryReview.id,
    );
    expect(firstSnapshot).toMatchObject({ sourceOid: sourceX, sourceSyncError: null });
    await expect(
      firstService.git.verifyRepositoryReviewCommitRef(
        repositoryPath,
        firstOpen.repositoryReview.id,
        sourceX,
      ),
    ).resolves.toBe(true);

    repositoryBarrier.release();
    await expect(secondOpen).rejects.toThrow(`injected retained-ref failure for ${sourceY}`);

    expect(secondDatabase.getRepositoryReview(firstOpen.repositoryReview.id)).toMatchObject({
      id: firstOpen.repositoryReview.id,
      sourceOid: sourceX,
      sourceSyncError: `injected retained-ref failure for ${sourceY}`,
    });
    expect(
      secondDatabase.getReviewChangeSequence("repository", firstOpen.repositoryReview.id),
    ).toBe(sequence + 1);
    await expect(
      secondService.git.verifyRepositoryReviewCommitRef(
        repositoryPath,
        firstOpen.repositoryReview.id,
        sourceY,
      ),
    ).resolves.toBe(false);
    await expect(firstService.openRepositoryReview(repositoryPath)).resolves.toMatchObject({
      fromCache: true,
      repositoryReview: { id: firstOpen.repositoryReview.id, sourceOid: sourceX },
    });
  });
});
