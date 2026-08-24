import path from "node:path";
import type { RepositoryReview, GitHubRepository, RepositoryIdentity } from "../domain/models.js";
import { RvwDatabase } from "../infrastructure/db/database.js";
import { GitClient, type RepositoryContext } from "../infrastructure/git/git-client.js";
import type { GitHubPort } from "../infrastructure/github/github-client.js";
import { GIT_OBJECT_ID_PATTERN } from "../shared/constants.js";
import { asRvwError, RvwError } from "../shared/errors.js";

export type RepositoryReviewResolutionPolicy =
  | { kind: "read" }
  | { kind: "synchronize" }
  | { kind: "destructive"; allowMissingInitialRef: boolean };

export interface ResolvedRepositoryReview {
  repositoryReview: RepositoryReview;
  repository: RepositoryContext;
  remoteIdentity: {
    owner: string;
    repository: string;
    remoteName: string;
    remoteUrl: string;
  } | null;
}

export interface RepositoryRelocationEvidenceStatus {
  requiredEvidenceCount: number;
  verifiedEvidenceCount: number;
  missingEvidence: Array<{
    sourceOid: string;
    retainedRefAvailable: boolean;
    gitObjectAvailable: boolean;
  }>;
}

export interface ResolvedRepositoryRelocation extends ResolvedRepositoryReview {
  relocationEvidence: RepositoryRelocationEvidenceStatus;
}

export interface RepositoryReviewOpenResult {
  repositoryReview: RepositoryReview;
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

async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => await worker()),
  );
  return results;
}

export class RepositoryReviewLifecycle {
  constructor(
    private readonly database: RvwDatabase,
    private readonly git: GitClient,
    private readonly github: GitHubPort,
  ) {}

  private async remoteIdentityForExisting(
    repositoryReview: RepositoryReview,
    repository: RepositoryContext,
  ): Promise<ResolvedRepositoryReview["remoteIdentity"]> {
    const matching = await this.git.findBaseRepositoryIdentity(
      repository.worktreePath,
      repositoryReview.owner,
      repositoryReview.repository,
    );
    return matching ?? (await this.git.tryBaseRepositoryIdentity(repository.worktreePath));
  }

  private repositoryMismatch(
    repositoryReview: RepositoryReview,
    repository: RepositoryContext,
    message: string,
    details: Record<string, unknown> = {},
  ): RvwError {
    return new RvwError("REPOSITORY_MISMATCH", message, {
      details: {
        repositoryReviewId: repositoryReview.id,
        registeredRepository: repositoryReview.canonicalName,
        registeredPath: repositoryReview.localRepositoryPath,
        registeredGitCommonDir: repositoryReview.gitCommonDir,
        currentPath: repository.worktreePath,
        currentGitCommonDir: repository.gitCommonDir,
        ...details,
      },
      suggestions: [
        `${repositoryReview.localRepositoryPath} または同じcloneのworktreeから実行してください。`,
        "cloneのdirectory移動とremote変更が重なった場合は、remoteを保存済みrepositoryへ戻してからrelocateしてください。",
        "repositoryのrename / transferまたはremote変更後は、元のbindingでRepository Reviewを明示resetしてから作り直してください。",
      ],
    });
  }

  private async liveRepositoryReviewNamespaces(
    repository: RepositoryContext,
  ): Promise<Array<{ repositoryReview: RepositoryReview; refs: string[] }>> {
    const refs = await this.git.listRefsByPrefix(repository.worktreePath, "refs/rvw/repository/");
    const refsByReviewId = new Map<string, string[]>();
    for (const ref of refs) {
      const match = /^refs\/rvw\/repository\/([^/]+)\//i.exec(ref);
      const reviewId = match?.[1]?.toLowerCase();
      if (!reviewId) continue;
      const owned = refsByReviewId.get(reviewId) ?? [];
      owned.push(ref);
      refsByReviewId.set(reviewId, owned);
    }
    const live: Array<{ repositoryReview: RepositoryReview; refs: string[] }> = [];
    for (const [reviewId, ownedRefs] of refsByReviewId) {
      const repositoryReview = this.database.getRepositoryReview(reviewId);
      if (repositoryReview) live.push({ repositoryReview, refs: ownedRefs });
    }
    return live;
  }

  private async assertRepositoryReviewNamespaceAvailableForCreation(
    repository: RepositoryContext,
  ): Promise<void> {
    const liveNamespaces = await this.liveRepositoryReviewNamespaces(repository);
    if (liveNamespaces.length === 0) return;
    if (liveNamespaces.length > 1) {
      throw new RvwError(
        "LOCAL_STATE_INCONSISTENT",
        "candidate cloneに複数のlive Repository Review namespaceがあります。",
        {
          status: 409,
          details: {
            candidatePath: repository.worktreePath,
            candidateGitCommonDir: repository.gitCommonDir,
            liveRepositoryReviewIds: liveNamespaces.map(
              ({ repositoryReview }) => repositoryReview.id,
            ),
          },
        },
      );
    }
    const { repositoryReview, refs } = liveNamespaces[0]!;
    const existingRemoteIdentity = await this.remoteIdentityForExisting(
      repositoryReview,
      repository,
    );
    if (
      existingRemoteIdentity &&
      sameRepositoryIdentity(repositoryReview, existingRemoteIdentity)
    ) {
      await this.assertGitCommonDir(repositoryReview, repository, existingRemoteIdentity);
    }
    throw this.repositoryMismatch(
      repositoryReview,
      repository,
      "candidate cloneには別bindingのlive Repository Review namespaceが残っています。",
      {
        liveRepositoryReviewRefs: refs,
        ...(existingRemoteIdentity
          ? {
              currentRepository: `${existingRemoteIdentity.owner}/${existingRemoteIdentity.repository}`,
            }
          : { currentRepository: null }),
      },
    );
  }

  private async assertGitCommonDir(
    repositoryReview: RepositoryReview,
    repository: RepositoryContext,
    remoteIdentity: { owner: string; repository: string } | null,
  ): Promise<void> {
    if (path.resolve(repositoryReview.gitCommonDir) === path.resolve(repository.gitCommonDir)) {
      return;
    }
    const sameCanonicalRepository =
      remoteIdentity !== null && sameRepositoryIdentity(repositoryReview, remoteIdentity);
    const [retainedSourceAvailable, sourceObjectAvailable] = sameCanonicalRepository
      ? await Promise.all([
          this.git.verifyRepositoryReviewCommitRef(
            repository.worktreePath,
            repositoryReview.id,
            repositoryReview.sourceOid,
          ),
          this.git.hasObject(repository.worktreePath, repositoryReview.sourceOid),
        ])
      : [false, false];
    if (retainedSourceAvailable && sourceObjectAvailable) {
      throw new RvwError(
        "REPOSITORY_RELOCATION_REQUIRED",
        "同じRepository Review evidenceを持つ移動後のcloneを検出しました。明示relocateが必要です。",
        {
          status: 409,
          details: {
            repositoryReviewId: repositoryReview.id,
            registeredRepository: repositoryReview.canonicalName,
            registeredPath: repositoryReview.localRepositoryPath,
            registeredGitCommonDir: repositoryReview.gitCommonDir,
            candidatePath: repository.worktreePath,
            candidateGitCommonDir: repository.gitCommonDir,
            sourceOid: repositoryReview.sourceOid,
            retainedSourceAvailable,
            sourceObjectAvailable,
          },
          suggestions: [
            "rvw repository relocate --repository <moved-path> --json で移動先bindingを確認してください。",
          ],
        },
      );
    }
    throw this.repositoryMismatch(
      repositoryReview,
      repository,
      "このRepository Reviewは別の独立cloneへすでに登録されています。",
      { retainedSourceAvailable, sourceObjectAvailable },
    );
  }

  private assertCanonicalRemote(
    repositoryReview: RepositoryReview,
    repository: RepositoryContext,
    remoteIdentity: { owner: string; repository: string } | null,
  ): void {
    if (remoteIdentity && !sameRepositoryIdentity(repositoryReview, remoteIdentity)) {
      throw this.repositoryMismatch(
        repositoryReview,
        repository,
        "現在のGitHub remoteは保存済みRepository Reviewのrepositoryと一致しません。",
        {
          currentRepository: `${remoteIdentity.owner}/${remoteIdentity.repository}`,
        },
      );
    }
  }

  private async assertOwnedSourceRef(
    repositoryReview: RepositoryReview,
    repository: RepositoryContext,
  ): Promise<RepositoryReview> {
    // Only the explicit pending marker permits waiting. A normal or failed aggregate with no owned
    // ref is inconsistent immediately, independent of wall-clock distance from createdAt.
    const deadline = Date.now() + 5_000;
    let current = repositoryReview;
    while (true) {
      if (
        await this.git.verifyRepositoryReviewCommitRef(
          repository.worktreePath,
          current.id,
          current.sourceOid,
        )
      ) {
        return current;
      }
      if (current.initializationState !== "pending" || Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const refreshed = this.database.getRepositoryReview(current.id);
      if (!refreshed) {
        throw new RvwError("REPOSITORY_REVIEW_NOT_FOUND", "Repository Reviewが見つかりません。", {
          status: 404,
        });
      }
      current = refreshed;
    }
    throw new RvwError(
      "LOCAL_STATE_INCONSISTENT",
      "Repository Review所有のsource refがなく、保存済みGit evidenceを確認できません。",
      {
        status: 409,
        details: {
          repositoryReviewId: current.id,
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
      policy: RepositoryReviewResolutionPolicy;
      expectedRepositoryReviewId?: string;
    } = { policy: { kind: "read" } },
  ): Promise<ResolvedRepositoryReview> {
    const repository = await this.git.repositoryContext(repositoryPath);
    const byCommonDir = this.database.findRepositoryReviewByGitCommonDir(repository.gitCommonDir);
    const expected = options.expectedRepositoryReviewId
      ? this.database.getRepositoryReview(options.expectedRepositoryReviewId)
      : null;
    if (options.expectedRepositoryReviewId && !expected) {
      throw new RvwError("REPOSITORY_REVIEW_NOT_FOUND", "Repository Reviewが見つかりません。", {
        status: 404,
      });
    }
    const bound = expected ?? byCommonDir;
    const remoteIdentity = bound
      ? await this.remoteIdentityForExisting(bound, repository)
      : await this.git.tryBaseRepositoryIdentity(repository.worktreePath);
    const byIdentity = remoteIdentity
      ? this.database.findRepositoryReviewByIdentity(
          remoteIdentity.owner,
          remoteIdentity.repository,
        )
      : null;
    if (byCommonDir && byIdentity && byCommonDir.id !== byIdentity.id) {
      throw this.repositoryMismatch(
        byCommonDir,
        repository,
        "Git common directoryとcanonical repositoryが異なるRepository Reviewを指しています。",
        { canonicalRepositoryReviewId: byIdentity.id },
      );
    }

    let repositoryReview = expected ?? byCommonDir ?? byIdentity;
    if (!repositoryReview) {
      throw new RvwError(
        "REPOSITORY_REVIEW_NOT_FOUND",
        "保存済みRepository Reviewが見つかりません。",
        {
          status: 404,
          details: {
            repositoryPath: repository.worktreePath,
            gitCommonDir: repository.gitCommonDir,
            ...(remoteIdentity
              ? { currentRepository: `${remoteIdentity.owner}/${remoteIdentity.repository}` }
              : {}),
          },
          suggestions: ["対象repositoryで rvw repository open を実行してください。"],
        },
      );
    }

    await this.assertGitCommonDir(repositoryReview, repository, remoteIdentity);
    this.assertCanonicalRemote(repositoryReview, repository, remoteIdentity);
    const ownedSourceAvailable = await this.git.verifyRepositoryReviewCommitRef(
      repository.worktreePath,
      repositoryReview.id,
      repositoryReview.sourceOid,
    );
    if (
      !ownedSourceAvailable &&
      options.policy.kind === "destructive" &&
      options.policy.allowMissingInitialRef
    ) {
      const prefix = `refs/rvw/repository/${repositoryReview.id.toLowerCase()}/commits/`;
      const retainedRefs = await this.git.listRefsByPrefix(repository.worktreePath, prefix);
      if (repositoryReview.initializationState === "ready" || retainedRefs.length !== 0) {
        repositoryReview = await this.assertOwnedSourceRef(repositoryReview, repository);
      }
    } else if (!ownedSourceAvailable) {
      repositoryReview = await this.assertOwnedSourceRef(repositoryReview, repository);
    }
    if (options.policy.kind === "synchronize" && !remoteIdentity) {
      throw this.repositoryMismatch(
        repositoryReview,
        repository,
        "Repository Reviewの同期に必要なGitHub remote identityを解決できません。",
      );
    }
    return { repositoryReview, repository, remoteIdentity };
  }

  private async repositoryRelocationEvidenceStatus(
    repositoryReview: RepositoryReview,
    repository: RepositoryContext,
  ): Promise<RepositoryRelocationEvidenceStatus> {
    const requiredEvidenceOids = this.database.listRepositoryReviewEvidenceOids(
      repositoryReview.id,
    );
    const statuses = await mapWithConcurrency(requiredEvidenceOids, 8, async (sourceOid) => {
      if (!GIT_OBJECT_ID_PATTERN.test(sourceOid)) {
        return {
          sourceOid,
          retainedRefAvailable: false,
          gitObjectAvailable: false,
        };
      }
      const [retainedRefAvailable, gitObjectAvailable] = await Promise.all([
        this.git.verifyRepositoryReviewCommitRef(
          repository.worktreePath,
          repositoryReview.id,
          sourceOid,
        ),
        this.git.hasObject(repository.worktreePath, sourceOid),
      ]);
      return { sourceOid, retainedRefAvailable, gitObjectAvailable };
    });
    const missingEvidence = statuses.filter(
      ({ retainedRefAvailable, gitObjectAvailable }) =>
        !retainedRefAvailable || !gitObjectAvailable,
    );
    return {
      requiredEvidenceCount: statuses.length,
      verifiedEvidenceCount: statuses.length - missingEvidence.length,
      missingEvidence,
    };
  }

  async resolveRelocationCandidate(repositoryPath: string): Promise<ResolvedRepositoryRelocation> {
    const repository = await this.git.repositoryContext(repositoryPath);
    const boundAtCandidate = this.database.findRepositoryReviewByGitCommonDir(
      repository.gitCommonDir,
    );
    const liveNamespaces = await this.liveRepositoryReviewNamespaces(repository);
    if (liveNamespaces.length > 1) {
      throw new RvwError(
        "LOCAL_STATE_INCONSISTENT",
        "candidate cloneに複数のlive Repository Review namespaceがあります。",
        {
          status: 409,
          details: {
            candidatePath: repository.worktreePath,
            candidateGitCommonDir: repository.gitCommonDir,
            liveRepositoryReviewIds: liveNamespaces.map(
              ({ repositoryReview }) => repositoryReview.id,
            ),
          },
        },
      );
    }
    const byNamespace = liveNamespaces[0]?.repositoryReview ?? null;
    if (byNamespace && boundAtCandidate && byNamespace.id !== boundAtCandidate.id) {
      throw this.repositoryMismatch(
        boundAtCandidate,
        repository,
        "移動先Git common directoryとlive namespaceが異なるRepository Reviewを指しています。",
        { namespaceRepositoryReviewId: byNamespace.id },
      );
    }
    let repositoryReview = byNamespace ?? boundAtCandidate;
    let remoteIdentity: ResolvedRepositoryReview["remoteIdentity"];
    if (repositoryReview) {
      remoteIdentity = await this.remoteIdentityForExisting(repositoryReview, repository);
    } else {
      remoteIdentity = await this.git.tryBaseRepositoryIdentity(repository.worktreePath);
      repositoryReview = remoteIdentity
        ? this.database.findRepositoryReviewByIdentity(
            remoteIdentity.owner,
            remoteIdentity.repository,
          )
        : null;
    }
    if (!remoteIdentity) {
      throw new RvwError(
        "REPOSITORY_MISMATCH",
        "relocationにはcanonical GitHub remote identityが必要です。",
        {
          details: {
            ...(repositoryReview ? { repositoryReviewId: repositoryReview.id } : {}),
            candidatePath: repository.worktreePath,
            candidateGitCommonDir: repository.gitCommonDir,
          },
        },
      );
    }
    if (!repositoryReview) {
      throw new RvwError(
        "REPOSITORY_REVIEW_NOT_FOUND",
        "移動対象のRepository Reviewが見つかりません。",
        { status: 404 },
      );
    }
    this.assertCanonicalRemote(repositoryReview, repository, remoteIdentity);
    if (path.resolve(repositoryReview.gitCommonDir) === path.resolve(repository.gitCommonDir)) {
      throw new RvwError(
        "INVALID_INPUT",
        "Repository Reviewはすでにこのcloneへ登録されています。",
        {
          details: {
            repositoryReviewId: repositoryReview.id,
            repositoryPath: repository.worktreePath,
            gitCommonDir: repository.gitCommonDir,
          },
        },
      );
    }
    const relocationEvidence = await this.repositoryRelocationEvidenceStatus(
      repositoryReview,
      repository,
    );
    if (relocationEvidence.missingEvidence.length > 0) {
      throw this.repositoryMismatch(
        repositoryReview,
        repository,
        "移動先cloneでRepository Reviewが参照する全exact source evidenceを確認できません。",
        { ...relocationEvidence },
      );
    }
    return { repositoryReview, repository, remoteIdentity, relocationEvidence };
  }

  private async synchronizeSource(
    repository: RepositoryContext,
    remoteIdentity: { owner: string; repository: string; remoteUrl: string },
    existing: RepositoryReview | null,
  ): Promise<RepositoryReview> {
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
          repositoryReviewId: existing.id,
          generation: this.database.beginRepositorySourceSync(existing.id),
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
      const initialization = this.database.beginRepositoryReviewInitialization(github, {
        localRepositoryPath: repository.worktreePath,
        gitCommonDir: repository.gitCommonDir,
      });
      if (!initialization.created) {
        // The first snapshot was observed before this aggregate existed. It must not be assigned a
        // generation after the fact: a concurrent initializer may already have published a newer
        // source. First finish observing that initializer, then allocate the generation before
        // taking a fresh GitHub snapshot.
        let concurrent = await this.assertOwnedSourceRef(
          initialization.repositoryReview,
          repository,
        );
        if (concurrent.initializationState !== "ready") {
          concurrent = this.database.completeRepositoryReviewInitialization(
            concurrent.id,
            concurrent.sourceOid,
          );
        }
        sourceAttempt = {
          repositoryReviewId: concurrent.id,
          generation: this.database.beginRepositorySourceSync(concurrent.id),
        };
        const latest = await this.fetchAndEnsureSource(repository, identity, concurrent);
        return await this.publishExistingSource(
          repository,
          latest,
          concurrent.id,
          sourceAttempt.generation,
        );
      }
      const repositoryReview = initialization.repositoryReview;

      let retained: Awaited<ReturnType<GitClient["ensureRepositoryReviewCommitRef"]>>;
      try {
        retained = await this.git.ensureRepositoryReviewCommitRef(
          repository.worktreePath,
          repositoryReview.id,
          github.defaultBranchOid,
        );
      } catch (error) {
        const rvwError = asRvwError(error);
        const retainedByConcurrentOpen = await this.git.verifyRepositoryReviewCommitRef(
          repository.worktreePath,
          repositoryReview.id,
          github.defaultBranchOid,
        );
        if (retainedByConcurrentOpen) {
          return this.database.completeRepositoryReviewInitialization(
            repositoryReview.id,
            github.defaultBranchOid,
          );
        }
        const initializationError = rvwError.message;
        const failed = this.database.recordRepositoryReviewInitializationFailure(
          repositoryReview.id,
          github.defaultBranchOid,
          initializationError,
        );
        if (failed.initializationState === "ready") {
          const retainedAfterConcurrentCompletion = await this.git.verifyRepositoryReviewCommitRef(
            repository.worktreePath,
            failed.id,
            github.defaultBranchOid,
          );
          if (retainedAfterConcurrentCompletion) return failed;
          throw new RvwError(
            "LOCAL_STATE_INCONSISTENT",
            "Repository Review初期化は完了扱いですが、review-owned retained refがありません。",
            {
              cause: error,
              status: 409,
              details: {
                repositoryReviewId: failed.id,
                sourceOid: github.defaultBranchOid,
                retainedRefCreated: false,
              },
            },
          );
        }
        throw new RvwError(
          "LOCAL_STATE_INCONSISTENT",
          "Repository Review sourceは保存されましたが、review-owned retained refを作成できませんでした。",
          {
            cause: error,
            status: 409,
            details: {
              repositoryReviewId: repositoryReview.id,
              databaseUpdated: true,
              retainedRefCreated: false,
              repairableByExplicitReset: true,
              repositoryPath: repository.worktreePath,
            },
            suggestions: [
              "details.repositoryPathを対象にrepository reset previewを取得し、返された確認tokenで未初期化bindingを削除してください。",
            ],
          },
        );
      }
      try {
        return this.database.completeRepositoryReviewInitialization(
          repositoryReview.id,
          github.defaultBranchOid,
        );
      } catch (error) {
        const current = this.database.getRepositoryReview(repositoryReview.id);
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
        rvwError.code !== "REPOSITORY_REVIEW_NOT_FOUND"
      ) {
        this.database.setRepositorySyncError(
          sourceAttempt.repositoryReviewId,
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
    existing: RepositoryReview | null,
  ): Promise<GitHubRepository> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const github = await this.github.getRepository!(identity, repository.worktreePath);
      if (!sameRepositoryIdentity(identity, github)) {
        const bound =
          existing ??
          this.database.findRepositoryReviewByIdentity(identity.owner, identity.repository);
        if (bound) {
          throw this.repositoryMismatch(
            bound,
            repository,
            "GitHub repositoryのrename / transferはRepository Reviewへ自動追従しません。",
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
    expectedRepositoryReviewId: string,
    expectedSourceSyncGeneration: number,
  ): Promise<RepositoryReview> {
    // Existing aggregates publish a source only after the same aggregate owns its exact ref.
    const retained = await this.git.ensureRepositoryReviewCommitRef(
      repository.worktreePath,
      expectedRepositoryReviewId,
      github.defaultBranchOid,
    );
    try {
      return this.database.publishRepositoryReviewSource(
        github,
        {
          localRepositoryPath: repository.worktreePath,
          gitCommonDir: repository.gitCommonDir,
        },
        { expectedRepositoryReviewId, expectedSourceSyncGeneration },
      ).repositoryReview;
    } catch (error) {
      // A stale source attempt may have created a ref that a concurrent artifact now references.
      // Keep all evidence while this aggregate exists; compensate only after the expected
      // aggregate itself disappeared (for example, a concurrent reset).
      if (retained.created && !this.database.getRepositoryReview(expectedRepositoryReviewId)) {
        await this.git
          .deleteRef(repository.worktreePath, retained.ref, github.defaultBranchOid)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async openAtPath(repositoryPath: string): Promise<RepositoryReviewOpenResult> {
    const repository = await this.git.repositoryContext(repositoryPath);
    let stored = this.database.findRepositoryReviewByGitCommonDir(repository.gitCommonDir);
    if (stored) {
      const remoteIdentity = await this.remoteIdentityForExisting(stored, repository);
      this.assertCanonicalRemote(stored, repository, remoteIdentity);
      stored = await this.assertOwnedSourceRef(stored, repository);
      const available = await this.git.hasObject(repository.worktreePath, stored.sourceOid);
      if (available) {
        const initialized =
          stored.initializationState !== "ready"
            ? this.database.completeRepositoryReviewInitialization(stored.id, stored.sourceOid)
            : stored;
        const locationChanged =
          path.resolve(initialized.localRepositoryPath) !== path.resolve(repository.worktreePath);
        return {
          repositoryReview: locationChanged
            ? this.database.updateRepositoryReviewLocation(initialized.id, {
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
          "cached Repository Review source objectを確認できません。",
          {
            details: {
              repositoryReviewId: stored.id,
              sourceOid: stored.sourceOid,
              gitObjectAvailable: available,
              retainedRefAvailable: true,
            },
            suggestions: ["GitHub remoteを復元し、Repository Reviewを明示resetしてください。"],
          },
        );
      }
      const repositoryReview = await this.synchronizeSource(repository, remoteIdentity, stored);
      return {
        repositoryReview,
        fromCache: false,
        selectedRemote: { name: remoteIdentity.remoteName, url: remoteIdentity.remoteUrl },
      };
    }

    const remoteIdentity = await this.git.tryBaseRepositoryIdentity(repository.worktreePath);
    if (!remoteIdentity) {
      await this.assertRepositoryReviewNamespaceAvailableForCreation(repository);
      throw new RvwError(
        "REPOSITORY_MISMATCH",
        "Repository Reviewの作成に必要なGitHub remote identityを解決できません。",
        { suggestions: ["対象repositoryのorigin remoteを確認してください。"] },
      );
    }
    await this.assertRepositoryReviewNamespaceAvailableForCreation(repository);
    const sameIdentity = this.database.findRepositoryReviewByIdentity(
      remoteIdentity.owner,
      remoteIdentity.repository,
    );
    if (sameIdentity) await this.assertGitCommonDir(sameIdentity, repository, remoteIdentity);
    const repositoryReview = await this.synchronizeSource(repository, remoteIdentity, sameIdentity);
    return {
      repositoryReview,
      fromCache: false,
      selectedRemote: { name: remoteIdentity.remoteName, url: remoteIdentity.remoteUrl },
    };
  }

  async openForExplicitMutation(repositoryPath: string): Promise<RepositoryReview> {
    const repository = await this.git.repositoryContext(repositoryPath);
    let stored = this.database.findRepositoryReviewByGitCommonDir(repository.gitCommonDir);
    if (stored) {
      const remoteIdentity = await this.remoteIdentityForExisting(stored, repository);
      this.assertCanonicalRemote(stored, repository, remoteIdentity);
      if (!remoteIdentity) {
        throw this.repositoryMismatch(
          stored,
          repository,
          "Repository Reviewの追加操作に必要なGitHub remote identityを解決できません。",
        );
      }
      stored = await this.assertOwnedSourceRef(stored, repository);
      return path.resolve(stored.localRepositoryPath) === path.resolve(repository.worktreePath)
        ? stored
        : this.database.updateRepositoryReviewLocation(stored.id, {
            localRepositoryPath: repository.worktreePath,
            gitCommonDir: repository.gitCommonDir,
          });
    }
    const remoteIdentity = await this.git.tryBaseRepositoryIdentity(repository.worktreePath);
    if (!remoteIdentity) {
      await this.assertRepositoryReviewNamespaceAvailableForCreation(repository);
      throw new RvwError(
        "REPOSITORY_MISMATCH",
        "Repository Reviewの追加操作に必要なGitHub remote identityを解決できません。",
        { suggestions: ["対象repositoryのorigin remoteを確認してください。"] },
      );
    }
    await this.assertRepositoryReviewNamespaceAvailableForCreation(repository);
    const sameIdentity = this.database.findRepositoryReviewByIdentity(
      remoteIdentity.owner,
      remoteIdentity.repository,
    );
    if (sameIdentity) await this.assertGitCommonDir(sameIdentity, repository, remoteIdentity);
    return await this.synchronizeSource(repository, remoteIdentity, sameIdentity);
  }

  async synchronizeExisting(
    repositoryPath: string,
    expectedRepositoryReviewId?: string,
  ): Promise<RepositoryReview> {
    const resolved = await this.resolveExistingAtPath(repositoryPath, {
      policy: { kind: "synchronize" },
      ...(expectedRepositoryReviewId ? { expectedRepositoryReviewId } : {}),
    });
    return await this.synchronizeSource(
      resolved.repository,
      resolved.remoteIdentity!,
      resolved.repositoryReview,
    );
  }
}
