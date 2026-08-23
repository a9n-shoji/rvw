import path from "node:path";
import type { BranchReview, GitHubRepository, RepositoryIdentity } from "../domain/models.js";
import { RvwDatabase } from "../infrastructure/db/database.js";
import { GitClient, type RepositoryContext } from "../infrastructure/git/git-client.js";
import type { GitHubPort } from "../infrastructure/github/github-client.js";
import { asRvwError, RvwError } from "../shared/errors.js";

export type BranchReviewResolutionPolicy =
  | { kind: "read" }
  | { kind: "synchronize" }
  | { kind: "destructive"; allowMissingInitialRef: boolean };

export interface ResolvedBranchReview {
  branchReview: BranchReview;
  repository: RepositoryContext;
  remoteIdentity: {
    owner: string;
    repository: string;
    remoteName: string;
    remoteUrl: string;
  } | null;
}

export interface BranchReviewOpenResult {
  branchReview: BranchReview;
  fromCache: boolean;
  selectedRemote: { name: string; url: string } | null;
}

function sameRepositoryIdentity(
  left: Pick<RepositoryIdentity, "owner" | "repository">,
  right: Pick<RepositoryIdentity, "owner" | "repository">,
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  );
}

function isRemoteMovedDuringSync(error: unknown): boolean {
  const rvwError = asRvwError(error);
  return (
    rvwError.code === "GITHUB_REPOSITORY_ERROR" &&
    (rvwError.details as { reason?: unknown } | undefined)?.reason === "REMOTE_MOVED_DURING_SYNC"
  );
}

export class BranchReviewLifecycle {
  constructor(
    private readonly database: RvwDatabase,
    private readonly git: GitClient,
    private readonly github: GitHubPort,
  ) {}

  private repositoryMismatch(
    branchReview: BranchReview,
    repository: RepositoryContext,
    message: string,
    details: Record<string, unknown> = {},
  ): RvwError {
    return new RvwError("REPOSITORY_MISMATCH", message, {
      details: {
        branchReviewId: branchReview.id,
        registeredRepository: branchReview.canonicalName,
        registeredPath: branchReview.localRepositoryPath,
        registeredGitCommonDir: branchReview.gitCommonDir,
        currentPath: repository.worktreePath,
        currentGitCommonDir: repository.gitCommonDir,
        ...details,
      },
      suggestions: [
        `${branchReview.localRepositoryPath} または同じcloneのworktreeから実行してください。`,
        "repositoryのrename / transferまたはremote変更後は、元のbindingでBranch Reviewを明示resetしてから作り直してください。",
      ],
    });
  }

  private assertGitCommonDir(branchReview: BranchReview, repository: RepositoryContext): void {
    if (path.resolve(branchReview.gitCommonDir) !== path.resolve(repository.gitCommonDir)) {
      throw this.repositoryMismatch(
        branchReview,
        repository,
        "このBranch Reviewは別の独立cloneへすでに登録されています。",
      );
    }
  }

  private assertCanonicalRemote(
    branchReview: BranchReview,
    repository: RepositoryContext,
    remoteIdentity: { owner: string; repository: string } | null,
  ): void {
    if (remoteIdentity && !sameRepositoryIdentity(branchReview, remoteIdentity)) {
      throw this.repositoryMismatch(
        branchReview,
        repository,
        "現在のGitHub remoteは保存済みBranch Reviewのrepositoryと一致しません。",
        {
          currentRepository: `${remoteIdentity.owner}/${remoteIdentity.repository}`,
        },
      );
    }
  }

  private async assertOwnedSourceRef(
    branchReview: BranchReview,
    repository: RepositoryContext,
  ): Promise<BranchReview> {
    // Only the explicit pending marker permits waiting. A normal or failed aggregate with no owned
    // ref is inconsistent immediately, independent of wall-clock distance from createdAt.
    const deadline = Date.now() + 5_000;
    let current = branchReview;
    while (true) {
      if (
        await this.git.verifyBranchCommitRef(repository.worktreePath, current.id, current.sourceOid)
      ) {
        return current;
      }
      if (current.initializationState !== "pending" || Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const refreshed = this.database.getBranchReview(current.id);
      if (!refreshed) {
        throw new RvwError("BRANCH_REVIEW_NOT_FOUND", "Branch Reviewが見つかりません。", {
          status: 404,
        });
      }
      current = refreshed;
    }
    throw new RvwError(
      "LOCAL_STATE_INCONSISTENT",
      "Branch Review所有のsource refがなく、保存済みGit evidenceを確認できません。",
      {
        status: 409,
        details: {
          branchReviewId: current.id,
          repositoryPath: repository.worktreePath,
          sourceOid: current.sourceOid,
          retainedRefAvailable: false,
          initializationStatus:
            current.initializationState === "pending"
              ? "pending-timeout"
              : current.initializationState === "failed"
                ? "failed"
                : "not-initializing",
          retryable: current.initializationState === "pending",
        },
      },
    );
  }

  async resolveExistingAtPath(
    repositoryPath: string,
    options: {
      policy: BranchReviewResolutionPolicy;
      expectedBranchReviewId?: string;
    } = { policy: { kind: "read" } },
  ): Promise<ResolvedBranchReview> {
    const repository = await this.git.repositoryContext(repositoryPath);
    const remoteIdentity = await this.git.tryBaseRepositoryIdentity(repository.worktreePath);
    const byCommonDir = this.database.findBranchReviewByGitCommonDir(repository.gitCommonDir);
    const byIdentity = remoteIdentity
      ? this.database.findBranchReviewByIdentity(remoteIdentity.owner, remoteIdentity.repository)
      : null;
    const expected = options.expectedBranchReviewId
      ? this.database.getBranchReview(options.expectedBranchReviewId)
      : null;

    if (options.expectedBranchReviewId && !expected) {
      throw new RvwError("BRANCH_REVIEW_NOT_FOUND", "Branch Reviewが見つかりません。", {
        status: 404,
      });
    }
    if (byCommonDir && byIdentity && byCommonDir.id !== byIdentity.id) {
      throw this.repositoryMismatch(
        byCommonDir,
        repository,
        "Git common directoryとcanonical repositoryが異なるBranch Reviewを指しています。",
        { canonicalBranchReviewId: byIdentity.id },
      );
    }

    let branchReview = expected ?? byCommonDir ?? byIdentity;
    if (!branchReview) {
      throw new RvwError("BRANCH_REVIEW_NOT_FOUND", "保存済みBranch Reviewが見つかりません。", {
        status: 404,
        details: {
          repositoryPath: repository.worktreePath,
          gitCommonDir: repository.gitCommonDir,
          ...(remoteIdentity
            ? { currentRepository: `${remoteIdentity.owner}/${remoteIdentity.repository}` }
            : {}),
        },
        suggestions: ["対象repositoryで rvw branch open を実行してください。"],
      });
    }

    this.assertGitCommonDir(branchReview, repository);
    this.assertCanonicalRemote(branchReview, repository, remoteIdentity);
    const ownedSourceAvailable = await this.git.verifyBranchCommitRef(
      repository.worktreePath,
      branchReview.id,
      branchReview.sourceOid,
    );
    if (
      !ownedSourceAvailable &&
      options.policy.kind === "destructive" &&
      options.policy.allowMissingInitialRef
    ) {
      const prefix = `refs/rvw/branch/${branchReview.id.toLowerCase()}/commits/`;
      const retainedRefs = await this.git.listRefsByPrefix(repository.worktreePath, prefix);
      if (branchReview.initializationState === "ready" || retainedRefs.length !== 0) {
        branchReview = await this.assertOwnedSourceRef(branchReview, repository);
      }
    } else if (!ownedSourceAvailable) {
      branchReview = await this.assertOwnedSourceRef(branchReview, repository);
    }
    if (options.policy.kind === "synchronize" && !remoteIdentity) {
      throw this.repositoryMismatch(
        branchReview,
        repository,
        "Branch Reviewの同期に必要なGitHub remote identityを解決できません。",
      );
    }
    return { branchReview, repository, remoteIdentity };
  }

  private async synchronizeSource(
    repository: RepositoryContext,
    remoteIdentity: { owner: string; repository: string; remoteUrl: string },
    existing: BranchReview | null,
  ): Promise<BranchReview> {
    if (!this.github.getRepository) {
      throw new RvwError("GITHUB_REPOSITORY_ERROR", "GitHub repository取得が利用できません。");
    }
    const identity = {
      host: "github.com" as const,
      owner: remoteIdentity.owner,
      repository: remoteIdentity.repository,
      canonicalName: `${remoteIdentity.owner}/${remoteIdentity.repository}`,
    };
    let sourceAttempt = existing
      ? {
          branchReviewId: existing.id,
          generation: this.database.beginBranchSourceSync(existing.id),
        }
      : null;
    try {
      const github = await this.fetchAndEnsureSource(repository, identity, existing);
      if (existing) {
        return await this.publishExistingSource(
          repository,
          github,
          existing.id,
          sourceAttempt!.generation,
        );
      }

      // Initial creation is deliberately create-only. If another process committed the aggregate
      // after our first lookup, this transaction returns that row unchanged. The pre-aggregate
      // snapshot is then discarded before the normal generated source-sync path starts below.
      const initialization = this.database.beginBranchReviewInitialization(github, {
        localRepositoryPath: repository.worktreePath,
        gitCommonDir: repository.gitCommonDir,
      });
      if (!initialization.created) {
        // The first snapshot was observed before this aggregate existed. It must not be assigned a
        // generation after the fact: a concurrent initializer may already have published a newer
        // source. First finish observing that initializer, then allocate the generation before
        // taking a fresh GitHub snapshot.
        let concurrent = await this.assertOwnedSourceRef(initialization.branchReview, repository);
        if (concurrent.initializationState !== "ready") {
          concurrent = this.database.completeBranchReviewInitialization(
            concurrent.id,
            concurrent.sourceOid,
          );
        }
        sourceAttempt = {
          branchReviewId: concurrent.id,
          generation: this.database.beginBranchSourceSync(concurrent.id),
        };
        const latest = await this.fetchAndEnsureSource(repository, identity, concurrent);
        return await this.publishExistingSource(
          repository,
          latest,
          concurrent.id,
          sourceAttempt.generation,
        );
      }
      const branchReview = initialization.branchReview;

      let retained: Awaited<ReturnType<GitClient["ensureBranchCommitRef"]>>;
      try {
        retained = await this.git.ensureBranchCommitRef(
          repository.worktreePath,
          branchReview.id,
          github.defaultBranchOid,
        );
      } catch (error) {
        const rvwError = asRvwError(error);
        const retainedByConcurrentOpen = await this.git.verifyBranchCommitRef(
          repository.worktreePath,
          branchReview.id,
          github.defaultBranchOid,
        );
        if (retainedByConcurrentOpen) {
          return this.database.completeBranchReviewInitialization(
            branchReview.id,
            github.defaultBranchOid,
          );
        }
        const initializationError = rvwError.message;
        const failed = this.database.recordBranchReviewInitializationFailure(
          branchReview.id,
          github.defaultBranchOid,
          initializationError,
        );
        if (failed.initializationState === "ready") {
          const retainedAfterConcurrentCompletion = await this.git.verifyBranchCommitRef(
            repository.worktreePath,
            failed.id,
            github.defaultBranchOid,
          );
          if (retainedAfterConcurrentCompletion) return failed;
          throw new RvwError(
            "LOCAL_STATE_INCONSISTENT",
            "Branch Review初期化は完了扱いですが、review-owned retained refがありません。",
            {
              cause: error,
              status: 409,
              details: {
                branchReviewId: failed.id,
                sourceOid: github.defaultBranchOid,
                retainedRefCreated: false,
              },
            },
          );
        }
        throw new RvwError(
          "LOCAL_STATE_INCONSISTENT",
          "Branch sourceは保存されましたが、review-owned retained refを作成できませんでした。",
          {
            cause: error,
            status: 409,
            details: {
              branchReviewId: branchReview.id,
              databaseUpdated: true,
              retainedRefCreated: false,
              repairableByExplicitReset: true,
              repositoryPath: repository.worktreePath,
            },
            suggestions: [
              "details.repositoryPathを対象にbranch reset previewを取得し、返された確認tokenで未初期化bindingを削除してください。",
            ],
          },
        );
      }
      try {
        return this.database.completeBranchReviewInitialization(
          branchReview.id,
          github.defaultBranchOid,
        );
      } catch (error) {
        const current = this.database.getBranchReview(branchReview.id);
        // `created` only describes this Git command. Once the aggregate still exists, another
        // opener or a later artifact may already rely on this exact historical source. Source
        // advancement is therefore never a reason to compensate the ref; only aggregate removal
        // makes this initializer-owned namespace orphaned.
        if (retained.created && !current) {
          await this.git
            .deleteRef(repository.worktreePath, retained.ref, github.defaultBranchOid)
            .catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      const rvwError = asRvwError(error);
      if (
        sourceAttempt &&
        rvwError.code !== "REPOSITORY_MISMATCH" &&
        rvwError.code !== "BRANCH_REVIEW_NOT_FOUND"
      ) {
        this.database.setBranchSyncError(
          sourceAttempt.branchReviewId,
          sourceAttempt.generation,
          rvwError.message,
        );
      }
      throw error;
    }
  }

  private async fetchAndEnsureSource(
    repository: RepositoryContext,
    identity: RepositoryIdentity,
    existing: BranchReview | null,
  ): Promise<GitHubRepository> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const github = await this.github.getRepository!(identity, repository.worktreePath);
      if (!sameRepositoryIdentity(identity, github)) {
        const bound =
          existing ?? this.database.findBranchReviewByIdentity(identity.owner, identity.repository);
        if (bound) {
          throw this.repositoryMismatch(
            bound,
            repository,
            "GitHub repositoryのrename / transferはBranch Reviewへ自動追従しません。",
            { githubRepository: github.canonicalName },
          );
        }
        throw new RvwError(
          "REPOSITORY_MISMATCH",
          "local remoteとGitHub repository metadataのidentityが一致しません。",
          {
            details: {
              currentRepository: identity.canonicalName,
              githubRepository: github.canonicalName,
            },
          },
        );
      }
      const remoteUrl = await this.git.assertBaseRepository(
        repository.worktreePath,
        github.owner,
        github.repository,
      );
      try {
        await this.git.ensureBranchObject({
          cwd: repository.worktreePath,
          remoteUrl,
          branchName: github.defaultBranchName,
          oid: github.defaultBranchOid,
        });
        return github;
      } catch (error) {
        if (attempt === 0 && isRemoteMovedDuringSync(error)) continue;
        throw error;
      }
    }
    throw new RvwError(
      "GITHUB_REPOSITORY_ERROR",
      "同期中にdefault branchが繰り返し更新されたため、安定したsource snapshotを取得できませんでした。",
      { details: { reason: "REMOTE_MOVED_DURING_SYNC" } },
    );
  }

  private async publishExistingSource(
    repository: RepositoryContext,
    github: GitHubRepository,
    expectedBranchReviewId: string,
    expectedSourceSyncGeneration: number,
  ): Promise<BranchReview> {
    // Existing aggregates publish a source only after the same aggregate owns its exact ref.
    const retained = await this.git.ensureBranchCommitRef(
      repository.worktreePath,
      expectedBranchReviewId,
      github.defaultBranchOid,
    );
    try {
      return this.database.publishBranchReviewSource(
        github,
        {
          localRepositoryPath: repository.worktreePath,
          gitCommonDir: repository.gitCommonDir,
        },
        { expectedBranchReviewId, expectedSourceSyncGeneration },
      ).branchReview;
    } catch (error) {
      // A stale source attempt may have created a ref that a concurrent artifact now references.
      // Keep all evidence while this aggregate exists; compensate only after the expected
      // aggregate itself disappeared (for example, a concurrent reset).
      if (retained.created && !this.database.getBranchReview(expectedBranchReviewId)) {
        await this.git
          .deleteRef(repository.worktreePath, retained.ref, github.defaultBranchOid)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async openAtPath(repositoryPath: string): Promise<BranchReviewOpenResult> {
    const repository = await this.git.repositoryContext(repositoryPath);
    const remoteIdentity = await this.git.tryBaseRepositoryIdentity(repository.worktreePath);
    let stored = this.database.findBranchReviewByGitCommonDir(repository.gitCommonDir);
    if (stored) {
      this.assertCanonicalRemote(stored, repository, remoteIdentity);
      stored = await this.assertOwnedSourceRef(stored, repository);
      const available = await this.git.hasObject(repository.worktreePath, stored.sourceOid);
      if (available) {
        const initialized =
          stored.initializationState !== "ready"
            ? this.database.completeBranchReviewInitialization(stored.id, stored.sourceOid)
            : stored;
        const locationChanged =
          path.resolve(initialized.localRepositoryPath) !== path.resolve(repository.worktreePath);
        return {
          branchReview: locationChanged
            ? this.database.updateBranchRepositoryLocation(initialized.id, {
                localRepositoryPath: repository.worktreePath,
                gitCommonDir: repository.gitCommonDir,
              })
            : initialized,
          fromCache: true,
          selectedRemote: remoteIdentity
            ? { name: remoteIdentity.remoteName, url: remoteIdentity.remoteUrl }
            : null,
        };
      }
      if (!remoteIdentity) {
        throw new RvwError(
          "LOCAL_STATE_INCONSISTENT",
          "cached Branch source objectを確認できません。",
          {
            details: {
              branchReviewId: stored.id,
              sourceOid: stored.sourceOid,
              gitObjectAvailable: available,
              retainedRefAvailable: true,
            },
            suggestions: ["GitHub remoteを復元し、Branch Reviewを明示resetしてください。"],
          },
        );
      }
      const branchReview = await this.synchronizeSource(repository, remoteIdentity, stored);
      return {
        branchReview,
        fromCache: false,
        selectedRemote: { name: remoteIdentity.remoteName, url: remoteIdentity.remoteUrl },
      };
    }

    if (!remoteIdentity) {
      throw new RvwError(
        "REPOSITORY_MISMATCH",
        "Branch Reviewの作成に必要なGitHub remote identityを解決できません。",
        { suggestions: ["対象repositoryのorigin remoteを確認してください。"] },
      );
    }
    const sameIdentity = this.database.findBranchReviewByIdentity(
      remoteIdentity.owner,
      remoteIdentity.repository,
    );
    if (sameIdentity) this.assertGitCommonDir(sameIdentity, repository);
    const branchReview = await this.synchronizeSource(repository, remoteIdentity, sameIdentity);
    return {
      branchReview,
      fromCache: false,
      selectedRemote: { name: remoteIdentity.remoteName, url: remoteIdentity.remoteUrl },
    };
  }

  async openForExplicitMutation(repositoryPath: string): Promise<BranchReview> {
    const repository = await this.git.repositoryContext(repositoryPath);
    const remoteIdentity = await this.git.tryBaseRepositoryIdentity(repository.worktreePath);
    if (!remoteIdentity) {
      throw new RvwError(
        "REPOSITORY_MISMATCH",
        "Branch Reviewの追加操作に必要なGitHub remote identityを解決できません。",
        { suggestions: ["対象repositoryのorigin remoteを確認してください。"] },
      );
    }
    let stored = this.database.findBranchReviewByGitCommonDir(repository.gitCommonDir);
    if (stored) {
      this.assertCanonicalRemote(stored, repository, remoteIdentity);
      stored = await this.assertOwnedSourceRef(stored, repository);
      return path.resolve(stored.localRepositoryPath) === path.resolve(repository.worktreePath)
        ? stored
        : this.database.updateBranchRepositoryLocation(stored.id, {
            localRepositoryPath: repository.worktreePath,
            gitCommonDir: repository.gitCommonDir,
          });
    }
    const sameIdentity = this.database.findBranchReviewByIdentity(
      remoteIdentity.owner,
      remoteIdentity.repository,
    );
    if (sameIdentity) this.assertGitCommonDir(sameIdentity, repository);
    return await this.synchronizeSource(repository, remoteIdentity, sameIdentity);
  }

  async synchronizeExisting(
    repositoryPath: string,
    expectedBranchReviewId?: string,
  ): Promise<BranchReview> {
    const resolved = await this.resolveExistingAtPath(repositoryPath, {
      policy: { kind: "synchronize" },
      ...(expectedBranchReviewId ? { expectedBranchReviewId } : {}),
    });
    return await this.synchronizeSource(
      resolved.repository,
      resolved.remoteIdentity!,
      resolved.branchReview,
    );
  }
}
