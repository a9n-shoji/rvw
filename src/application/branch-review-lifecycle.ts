import path from "node:path";
import type { BranchReview, GitHubRepository, RepositoryIdentity } from "../domain/models.js";
import { RvwDatabase } from "../infrastructure/db/database.js";
import { GitClient, type RepositoryContext } from "../infrastructure/git/git-client.js";
import type { GitHubPort } from "../infrastructure/github/github-client.js";
import { BRANCH_REVIEW_INITIALIZATION_FAILED } from "../shared/constants.js";
import { asRvwError, RvwError } from "../shared/errors.js";

export type BranchReviewLifecyclePolicy =
  | "open-or-create"
  | "open-cached"
  | "resolve-existing"
  | "synchronize-existing"
  | "destructive-existing";

export interface ResolvedBranchReview {
  branchReview: BranchReview;
  repository: RepositoryContext;
  remoteIdentity: {
    owner: string;
    repository: string;
    remoteUrl: string;
  } | null;
}

export interface BranchReviewOpenResult {
  branchReview: BranchReview;
  fromCache: boolean;
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
  ): Promise<void> {
    // A concurrent first open may observe the committed DB row just before the winning process
    // creates the aggregate-owned ref. Recheck that narrow initialization window without ever
    // creating or fetching from an existing-only path.
    const recentlyCreated = Date.now() - Date.parse(branchReview.createdAt) < 5_000;
    const attempts = recentlyCreated ? 10 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (
        await this.git.verifyBranchCommitRef(
          repository.worktreePath,
          branchReview.id,
          branchReview.sourceOid,
        )
      ) {
        return;
      }
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new RvwError(
      "LOCAL_STATE_INCONSISTENT",
      "Branch Review所有のsource refがなく、保存済みGit evidenceを確認できません。",
      {
        status: 409,
        details: {
          branchReviewId: branchReview.id,
          repositoryPath: repository.worktreePath,
          sourceOid: branchReview.sourceOid,
          retainedRefAvailable: false,
        },
      },
    );
  }

  async resolveExistingAtPath(
    repositoryPath: string,
    options: {
      policy: Exclude<BranchReviewLifecyclePolicy, "open-or-create" | "open-cached">;
      expectedBranchReviewId?: string;
      allowUninitializedReset?: boolean;
    } = { policy: "resolve-existing" },
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

    const branchReview = expected ?? byCommonDir ?? byIdentity;
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
    if (!ownedSourceAvailable && options.allowUninitializedReset) {
      const prefix = `refs/rvw/branch/${branchReview.id.toLowerCase()}/commits/`;
      const retainedRefs = await this.git.listRefsByPrefix(repository.worktreePath, prefix);
      if (
        !branchReview.sourceSyncError?.startsWith(BRANCH_REVIEW_INITIALIZATION_FAILED) ||
        retainedRefs.length !== 0
      ) {
        await this.assertOwnedSourceRef(branchReview, repository);
      }
    } else if (!ownedSourceAvailable) {
      await this.assertOwnedSourceRef(branchReview, repository);
    }
    if (options.policy === "synchronize-existing" && !remoteIdentity) {
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
    const github = await this.github.getRepository(identity, repository.worktreePath);
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
    await this.git.ensureBranchObject({
      cwd: repository.worktreePath,
      remoteUrl,
      branchName: github.defaultBranchName,
      oid: github.defaultBranchOid,
    });
    if (existing) {
      return await this.publishExistingSource(repository, github, existing.id);
    }

    // Initial creation is deliberately create-only. If another process committed the aggregate
    // after our first lookup, this transaction returns that row unchanged; the candidate source
    // then follows the normal retain-before-publish path below.
    const initialization = this.database.beginBranchReviewInitialization(github, {
      localRepositoryPath: repository.worktreePath,
      gitCommonDir: repository.gitCommonDir,
    });
    if (!initialization.created) {
      return await this.publishExistingSource(repository, github, initialization.branchReview.id);
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
      const initializationError = `${BRANCH_REVIEW_INITIALIZATION_FAILED} ${rvwError.message}`;
      const failed = this.database.recordBranchReviewInitializationFailure(
        branchReview.id,
        github.defaultBranchOid,
        initializationError,
      );
      if (failed.sourceSyncError === null) {
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
            "対象repository pathを指定した rvw branch reset --yes で未初期化bindingを削除してから再実行してください。",
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
      if (retained.created && (!current || current.sourceOid !== github.defaultBranchOid)) {
        await this.git
          .deleteRef(repository.worktreePath, retained.ref, github.defaultBranchOid)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async publishExistingSource(
    repository: RepositoryContext,
    github: GitHubRepository,
    expectedBranchReviewId: string,
  ): Promise<BranchReview> {
    // Existing aggregates publish a source only after the same aggregate owns its exact ref.
    const retained = await this.git.ensureBranchCommitRef(
      repository.worktreePath,
      expectedBranchReviewId,
      github.defaultBranchOid,
    );
    try {
      return this.database.upsertBranchReview(
        github,
        {
          localRepositoryPath: repository.worktreePath,
          gitCommonDir: repository.gitCommonDir,
        },
        { expectedBranchReviewId },
      );
    } catch (error) {
      if (retained.created) {
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
    const stored = this.database.findBranchReviewByGitCommonDir(repository.gitCommonDir);
    if (stored) {
      this.assertCanonicalRemote(stored, repository, remoteIdentity);
      await this.assertOwnedSourceRef(stored, repository);
      const available = await this.git.hasObject(repository.worktreePath, stored.sourceOid);
      if (available) {
        const initialized = stored.sourceSyncError?.startsWith(BRANCH_REVIEW_INITIALIZATION_FAILED)
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
      return { branchReview, fromCache: false };
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
    return { branchReview, fromCache: false };
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
    const stored = this.database.findBranchReviewByGitCommonDir(repository.gitCommonDir);
    if (stored) {
      this.assertCanonicalRemote(stored, repository, remoteIdentity);
      await this.assertOwnedSourceRef(stored, repository);
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
      policy: "synchronize-existing",
      ...(expectedBranchReviewId ? { expectedBranchReviewId } : {}),
    });
    return await this.synchronizeSource(
      resolved.repository,
      resolved.remoteIdentity!,
      resolved.branchReview,
    );
  }
}
