import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import envPaths from "env-paths";
import type {
  BranchCommentTarget,
  BranchResetCounts,
  BranchReview,
  BranchReviewComment,
  BranchWalkthrough,
  BranchWalkthroughSummary,
  CodeReference,
  CommentPost,
  CommentPostEvent,
  CommentTarget,
  DeletedBranchWalkthrough,
  DeletedWalkthrough,
  GitHubIssue,
  GitHubPullRequest,
  IssueDocument,
  IssueRemovalCounts,
  PullRequest,
  ResetCounts,
  ReviewComment,
  Walkthrough,
  WalkthroughDeleteCounts,
  WalkthroughReference,
  WalkthroughSummary,
} from "../../domain/models.js";
import { formatCommentUri } from "../../domain/comment-uri.js";
import { hashDocument, normalizeLf } from "../../domain/pr-markdown.js";
import { formatWalkthroughUri } from "../../domain/walkthrough-uri.js";
import { RvwError } from "../../shared/errors.js";
import { isThemePreference, type ThemePreference } from "../../shared/preferences.js";

type DbRow = Record<string, SQLInputValue>;

export interface CommentPageItem {
  comment: Omit<ReviewComment, "posts">;
  rootPost: CommentPost;
  postCount: number;
}

export interface CommentPage {
  comments: CommentPageItem[];
  total: number;
}

function stringValue(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new RvwError("DATABASE_ERROR", `DB列 ${key} が不正です。`);
  return value;
}

function nullableString(row: DbRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new RvwError("DATABASE_ERROR", `DB列 ${key} が不正です。`);
  return value;
}

function numberValue(row: DbRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new RvwError("DATABASE_ERROR", `DB列 ${key} が不正です。`);
  }
  return Number(value);
}

function nullableNumber(row: DbRow, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new RvwError("DATABASE_ERROR", `DB列 ${key} が不正です。`);
  }
  return Number(value);
}

function stringRecordValue(row: DbRow, key: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(stringValue(row, key));
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.values(value).some((entry) => typeof entry !== "string")
    ) {
      throw new Error("not a string record");
    }
    return value as Record<string, string>;
  } catch (error) {
    throw new RvwError("DATABASE_ERROR", `DB列 ${key} が不正です。`, { cause: error });
  }
}

function mapPullRequest(row: DbRow): PullRequest {
  return {
    id: stringValue(row, "id"),
    host: "github.com",
    owner: stringValue(row, "owner"),
    repository: stringValue(row, "repository"),
    number: numberValue(row, "number"),
    url: stringValue(row, "github_url"),
    latestAuthorLogin: nullableString(row, "latest_author_login"),
    latestHeadRepositoryOwner: nullableString(row, "latest_head_repository_owner"),
    latestHeadRepositoryName: nullableString(row, "latest_head_repository_name"),
    localRepositoryPath: stringValue(row, "local_repository_path"),
    gitCommonDir: stringValue(row, "git_common_dir"),
    latestTitle: stringValue(row, "latest_title"),
    latestBody: stringValue(row, "latest_body"),
    latestBaseRefName: stringValue(row, "latest_base_ref_name"),
    latestHeadRefName: stringValue(row, "latest_head_ref_name"),
    latestBaseOid: stringValue(row, "latest_base_oid"),
    latestComparisonBaseOid: stringValue(row, "latest_comparison_base_oid"),
    latestHeadOid: stringValue(row, "latest_head_oid"),
    githubUpdatedAt: stringValue(row, "github_updated_at"),
    fetchedAt: stringValue(row, "fetched_at"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  };
}

function mapBranchReview(row: DbRow): BranchReview {
  return {
    id: stringValue(row, "id"),
    host: "github.com",
    owner: stringValue(row, "owner"),
    repository: stringValue(row, "repository"),
    canonicalName: stringValue(row, "canonical_name"),
    localRepositoryPath: stringValue(row, "local_repository_path"),
    gitCommonDir: stringValue(row, "git_common_dir"),
    defaultBranchName: stringValue(row, "default_branch_name"),
    sourceOid: stringValue(row, "source_oid"),
    githubFetchedAt: stringValue(row, "github_fetched_at"),
    sourceSyncError: nullableString(row, "source_sync_error"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  };
}

function mapIssue(row: DbRow): IssueDocument {
  return {
    id: stringValue(row, "id"),
    host: "github.com",
    owner: stringValue(row, "owner"),
    repository: stringValue(row, "repository"),
    canonicalName: stringValue(row, "canonical_name"),
    number: numberValue(row, "number"),
    url: stringValue(row, "github_url"),
    title: stringValue(row, "title"),
    body: stringValue(row, "body"),
    state: stringValue(row, "state") === "OPEN" ? "OPEN" : "CLOSED",
    updatedAt: stringValue(row, "github_updated_at"),
    bodyHash: stringValue(row, "body_hash"),
    fetchedAt: stringValue(row, "fetched_at"),
    syncError: nullableString(row, "sync_error"),
    stale: nullableString(row, "sync_error") !== null,
  };
}

function mapCodeReference(row: DbRow): CodeReference {
  return {
    id: stringValue(row, "reference_id"),
    label: stringValue(row, "label"),
    path: stringValue(row, "file_path"),
    startLine: nullableNumber(row, "start_line"),
    endLine: nullableNumber(row, "end_line"),
    description: nullableString(row, "description"),
  };
}

function mapCommentPost(row: DbRow, references: CodeReference[] = []): CommentPost {
  return {
    id: stringValue(row, "id"),
    commentId: stringValue(row, "comment_id"),
    body: stringValue(row, "body"),
    relatedCommitOid: nullableString(row, "related_commit_oid"),
    references,
    authorLabel: nullableString(row, "author_label"),
    isRoot: numberValue(row, "is_root") === 1,
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
  };
}

function hashIdempotencyKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function findMigrationsDirectory(explicit: string | undefined): string {
  if (explicit) return explicit;
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "../migrations"),
    path.resolve(moduleDirectory, "../../../migrations"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new RvwError("DATABASE_ERROR", "migrations directoryが見つかりません。");
  return found;
}

export interface DatabaseOptions {
  filePath?: string;
  migrationsDirectory?: string;
}

export interface DatabasePathConfiguration {
  filePath: string;
  configured: boolean;
}

export function databasePathConfiguration(filePath?: string): DatabasePathConfiguration {
  const configuredFilePath = filePath ?? process.env.RVW_DATABASE_PATH;
  return {
    filePath: configuredFilePath ?? path.join(envPaths("rvw").data, "rvw.db"),
    configured: configuredFilePath !== undefined,
  };
}

function securityIssue(
  targetPath: string,
  expectedMode: number,
): { mode: string; expectedMode: string; owner: number; expectedOwner: number } | null {
  if (process.platform === "win32" || process.getuid === undefined) return null;
  const stat = statSync(targetPath);
  const mode = stat.mode & 0o777;
  const owner = stat.uid;
  const expectedOwner = process.getuid();
  if (mode === expectedMode && owner === expectedOwner) return null;
  return {
    mode: mode.toString(8).padStart(4, "0"),
    expectedMode: expectedMode.toString(8).padStart(4, "0"),
    owner,
    expectedOwner,
  };
}

export interface DatabasePathPermissionStatus {
  path: string;
  mode: string | null;
  expectedMode: string;
  owner: number | null;
  expectedOwner: number | null;
  safe: boolean | null;
}

export interface DatabasePermissionStatus {
  managedByRvw: boolean;
  directory: DatabasePathPermissionStatus | null;
  file: DatabasePathPermissionStatus | null;
  warning: string | null;
}

function pathPermissionStatus(
  targetPath: string,
  expectedMode: number,
): DatabasePathPermissionStatus {
  const expectedModeText = expectedMode.toString(8).padStart(4, "0");
  if (process.platform === "win32" || process.getuid === undefined) {
    return {
      path: targetPath,
      mode: null,
      expectedMode: expectedModeText,
      owner: null,
      expectedOwner: null,
      safe: null,
    };
  }
  const stat = statSync(targetPath);
  const mode = stat.mode & 0o777;
  const expectedOwner = process.getuid();
  return {
    path: targetPath,
    mode: mode.toString(8).padStart(4, "0"),
    expectedMode: expectedModeText,
    owner: stat.uid,
    expectedOwner,
    safe: mode === expectedMode && stat.uid === expectedOwner,
  };
}

export function assertSecureExistingPath(
  targetPath: string,
  expectedMode: number,
  label: string,
): void {
  const issue = securityIssue(targetPath, expectedMode);
  if (!issue) return;
  throw new RvwError("DATABASE_ERROR", `${label}の権限またはownerが安全ではありません。`, {
    details: { path: targetPath, ...issue },
    suggestions: [
      `${targetPath} のownerを現在のユーザー、権限を${issue.expectedMode}に修正してください。`,
      "明示的に管理する別のDBを使う場合はRVW_DATABASE_PATHを設定できます。",
    ],
  });
}

export function secureNewPath(
  targetPath: string,
  expectedMode: number,
  label: string,
  chmod: (path: string, mode: number) => void = chmodSync,
): void {
  try {
    chmod(targetPath, expectedMode);
  } catch (error) {
    // Some managed environments reject chmod even when the created path already has the safe mode.
    const issue = securityIssue(targetPath, expectedMode);
    if (!issue) return;
    throw new RvwError("DATABASE_ERROR", `${label}を安全な権限へ設定できませんでした。`, {
      cause: error,
      details: { path: targetPath, ...issue },
      suggestions: [
        `${targetPath} のownerを現在のユーザー、権限を${issue.expectedMode}に修正してください。`,
        "明示的に管理する別のDBを使う場合はRVW_DATABASE_PATHを設定できます。",
      ],
    });
  }
  assertSecureExistingPath(targetPath, expectedMode, label);
}

export interface NewCommentInput {
  pullRequestId: string;
  createdHeadOid: string;
  target: CommentTarget;
  body: string;
  relatedCommitOid?: string | null;
  references?: CodeReference[];
  authorLabel?: string | null;
}

export interface CommentUpdateInput {
  commentId: string;
  reply: string;
  resolve: boolean;
  authorLabel?: string | null;
  references?: CodeReference[];
  idempotencyKey?: string;
  idempotencyRequestHash?: string;
}

export interface NewWalkthroughInput {
  pullRequestId: string;
  sourceOid: string;
  title: string;
  body: string;
  authorLabel?: string | null;
  diagramBindings: Record<string, string>;
  references: WalkthroughReference[];
}

export interface NewBranchCommentInput {
  branchReviewId: string;
  createdSourceOid: string;
  target: BranchCommentTarget;
  body: string;
  relatedCommitOid?: string | null;
  references?: CodeReference[];
  authorLabel?: string | null;
}

export interface NewBranchWalkthroughInput {
  branchReviewId: string;
  sourceOid: string;
  title: string;
  body: string;
  authorLabel?: string | null;
  diagramBindings: Record<string, string>;
  references: WalkthroughReference[];
}

export class RvwDatabase {
  readonly filePath: string;
  readonly configuredPath: boolean;
  private readonly database: DatabaseSync;

  constructor(options: DatabaseOptions = {}) {
    const configuration = databasePathConfiguration(options.filePath);
    const configuredFilePath = configuration.configured ? configuration.filePath : undefined;
    const filePath = configuration.filePath;
    this.filePath = filePath;
    this.configuredPath = configuredFilePath !== undefined;
    if (filePath !== ":memory:") {
      const dataDirectory = path.dirname(filePath);
      const directoryExisted = existsSync(dataDirectory);
      mkdirSync(dataDirectory, {
        recursive: true,
        mode: 0o700,
      });
      if (!configuredFilePath) {
        if (directoryExisted) assertSecureExistingPath(dataDirectory, 0o700, "DB directory");
        else secureNewPath(dataDirectory, 0o700, "DB directory");
      } else if (!directoryExisted) {
        // Creation mode is not a later chmod; caller-managed existing paths remain untouched.
        assertSecureExistingPath(dataDirectory, 0o700, "configured DB directory");
      }
    }
    let fileExisted = filePath !== ":memory:" && existsSync(filePath);
    if (filePath !== ":memory:" && configuredFilePath && !fileExisted) {
      try {
        const descriptor = openSync(filePath, "wx", 0o600);
        closeSync(descriptor);
        assertSecureExistingPath(filePath, 0o600, "configured DB file");
        fileExisted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        fileExisted = true;
      }
    }
    if (filePath !== ":memory:" && !configuredFilePath && fileExisted) {
      assertSecureExistingPath(filePath, 0o600, "DB file");
    }
    this.database = new DatabaseSync(filePath);
    if (filePath !== ":memory:" && !configuredFilePath && !fileExisted) {
      secureNewPath(filePath, 0o600, "DB file");
    }
    this.database.exec("PRAGMA busy_timeout = 5000;");
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate(findMigrationsDirectory(options.migrationsDirectory));
  }

  close(): void {
    this.database.close();
  }

  permissionStatus(): DatabasePermissionStatus {
    if (this.filePath === ":memory:") {
      return { managedByRvw: false, directory: null, file: null, warning: null };
    }
    const directory = pathPermissionStatus(path.dirname(this.filePath), 0o700);
    const file = pathPermissionStatus(this.filePath, 0o600);
    const unsafe = directory.safe === false || file.safe === false;
    return {
      managedByRvw: !this.configuredPath,
      directory,
      file,
      warning:
        this.configuredPath && unsafe
          ? "RVW_DATABASE_PATHは呼び出し側管理です。rvwはchmodしませんが、0700のdirectoryと0600のfileを推奨します。"
          : null,
    };
  }

  writeProbe(): { ok: true; error: null } | { ok: false; error: ReturnType<RvwError["toJSON"]> } {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database.exec("UPDATE app_meta SET value = value WHERE key = 'change_sequence'");
      this.database.exec("ROLLBACK");
      return { ok: true, error: null };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the write-probe error.
      }
      return {
        ok: false,
        error: new RvwError("DATABASE_ERROR", "databaseへの実書き込み試験に失敗しました。", {
          cause: error,
          details: { databasePath: this.filePath },
        }).toJSON(),
      };
    }
  }

  private migrate(directory: string): void {
    const migrationTableExists = this.database
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as DbRow | undefined;
    const applied = new Set<number>();
    if (migrationTableExists) {
      for (const row of this.database
        .prepare("SELECT version FROM schema_migrations")
        .all() as DbRow[]) {
        applied.add(numberValue(row, "version"));
      }
    }
    const migrations = readdirSync(directory)
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort();
    for (const filename of migrations) {
      const version = Number(filename.split("_")[0]);
      if (applied.has(version)) continue;
      const sql = readFileSync(path.join(directory, filename), "utf8");
      try {
        this.database.exec("BEGIN IMMEDIATE");
        // Another rvw process may have applied this migration while this connection waited.
        const migrationTableExistsAfterLock = this.database
          .prepare(
            "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
          )
          .get() as DbRow | undefined;
        const alreadyApplied = migrationTableExistsAfterLock
          ? (this.database
              .prepare("SELECT 1 AS found FROM schema_migrations WHERE version = ?")
              .get(version) as DbRow | undefined)
          : undefined;
        if (!alreadyApplied) {
          this.database.exec(sql);
          this.database
            .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
            .run(version, new Date().toISOString());
        }
        this.database.exec("COMMIT");
        applied.add(version);
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the migration error.
        }
        throw new RvwError("DATABASE_ERROR", `DB migration ${filename} に失敗しました。`, {
          cause: error,
          status: 500,
        });
      }
    }
  }

  immediateTransaction<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the callback error.
      }
      throw error;
    }
  }

  private insertReviewCommentEvent(
    postId: string,
    commentRef: string,
    context:
      | { kind: "pull-request"; pullRequestId: string; pullRequestUrl: string }
      | { kind: "branch"; branchReviewId: string; repository: string },
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO review_comment_post_events(
          post_id, comment_ref, review_kind, review_id, pull_request_url, repository, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        postId,
        commentRef,
        context.kind,
        context.kind === "pull-request" ? context.pullRequestId : context.branchReviewId,
        context.kind === "pull-request" ? context.pullRequestUrl : null,
        context.kind === "branch" ? context.repository : null,
        createdAt,
      );
  }

  private incrementGlobalChangeSequence(): void {
    this.database
      .prepare(
        "UPDATE app_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'change_sequence'",
      )
      .run();
  }

  private incrementReviewChangeSequence(context: {
    kind: "pull-request" | "branch";
    reviewId: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO app_meta(key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE
         SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
      )
      .run(`review_change_sequence:${context.kind}:${context.reviewId}`);
  }

  incrementChangeSequence(context?: { kind: "pull-request" | "branch"; reviewId: string }): number {
    this.incrementGlobalChangeSequence();
    if (context) this.incrementReviewChangeSequence(context);
    return this.getChangeSequence();
  }

  getChangeSequence(): number {
    const row = this.database
      .prepare("SELECT value FROM app_meta WHERE key = 'change_sequence'")
      .get() as DbRow;
    return Number(stringValue(row, "value"));
  }

  getReviewChangeSequence(kind: "pull-request" | "branch", reviewId: string): number {
    const row = this.database
      .prepare("SELECT value FROM app_meta WHERE key = ?")
      .get(`review_change_sequence:${kind}:${reviewId}`) as DbRow | undefined;
    return row ? Number(stringValue(row, "value")) : 0;
  }

  getCommentWatchDatabaseId(): string {
    const row = this.database
      .prepare("SELECT value FROM app_meta WHERE key = 'comment_watch_database_id'")
      .get() as DbRow | undefined;
    if (!row) throw new RvwError("DATABASE_ERROR", "comment watchのdatabase IDがありません。");
    return stringValue(row, "value");
  }

  getLatestCommentPostEventSequence(): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM review_comment_post_events")
      .get() as DbRow;
    return numberValue(row, "sequence");
  }

  listCommentPostEvents(afterSequence: number, limit: number): CommentPostEvent[] {
    const rows = this.database
      .prepare(
        `SELECT e.*, CASE WHEN p.id IS NULL AND bp.id IS NULL THEN 1 ELSE 0 END AS deleted
        FROM review_comment_post_events e
        LEFT JOIN comment_posts p ON e.review_kind = 'pull-request' AND p.id = e.post_id
        LEFT JOIN branch_comment_posts bp ON e.review_kind = 'branch' AND bp.id = e.post_id
        WHERE e.sequence > ?
        ORDER BY e.sequence ASC
        LIMIT ?`,
      )
      .all(afterSequence, limit) as DbRow[];
    return rows.map((row) => ({
      sequence: numberValue(row, "sequence"),
      createdAt: stringValue(row, "created_at"),
      postId: stringValue(row, "post_id"),
      commentRef: stringValue(row, "comment_ref"),
      context:
        stringValue(row, "review_kind") === "pull-request"
          ? {
              kind: "pull-request",
              pullRequestId: stringValue(row, "review_id"),
              pullRequestUrl: stringValue(row, "pull_request_url"),
            }
          : {
              kind: "branch",
              branchReviewId: stringValue(row, "review_id"),
              repository: stringValue(row, "repository"),
            },
      deleted: numberValue(row, "deleted") === 1,
    }));
  }

  getThemePreference(): ThemePreference {
    const row = this.database
      .prepare("SELECT value FROM app_meta WHERE key = 'theme_preference'")
      .get() as DbRow | undefined;
    if (!row) {
      throw new RvwError("DATABASE_ERROR", "テーマ設定がDBにありません。");
    }
    const value = stringValue(row, "value");
    if (!isThemePreference(value)) {
      throw new RvwError("DATABASE_ERROR", "DBのテーマ設定が不正です。");
    }
    return value;
  }

  setThemePreference(preference: ThemePreference): ThemePreference {
    const result = this.database
      .prepare("UPDATE app_meta SET value = ? WHERE key = 'theme_preference'")
      .run(preference);
    if (Number(result.changes) !== 1) {
      throw new RvwError("DATABASE_ERROR", "テーマ設定をDBへ保存できませんでした。");
    }
    return this.getThemePreference();
  }

  findPullRequestByIdentity(owner: string, repository: string, number: number): PullRequest | null {
    const row = this.database
      .prepare(
        "SELECT * FROM pull_requests WHERE host = 'github.com' AND lower(owner) = lower(?) AND lower(repository) = lower(?) AND number = ?",
      )
      .get(owner, repository, number) as DbRow | undefined;
    return row ? mapPullRequest(row) : null;
  }

  findPullRequestsByGitCommonDir(gitCommonDir: string): PullRequest[] {
    return (
      this.database
        .prepare("SELECT * FROM pull_requests WHERE git_common_dir = ? ORDER BY updated_at DESC")
        .all(gitCommonDir) as DbRow[]
    ).map(mapPullRequest);
  }

  getPullRequest(id: string): PullRequest | null {
    const row = this.database.prepare("SELECT * FROM pull_requests WHERE id = ?").get(id) as
      DbRow | undefined;
    return row ? mapPullRequest(row) : null;
  }

  listPullRequests(): PullRequest[] {
    return (
      this.database.prepare("SELECT * FROM pull_requests ORDER BY updated_at DESC").all() as DbRow[]
    ).map(mapPullRequest);
  }

  getBranchReview(id: string): BranchReview | null {
    const row = this.database.prepare("SELECT * FROM branch_reviews WHERE id = ?").get(id) as
      DbRow | undefined;
    return row ? mapBranchReview(row) : null;
  }

  findBranchReviewByGitCommonDir(gitCommonDir: string): BranchReview | null {
    const row = this.database
      .prepare("SELECT * FROM branch_reviews WHERE git_common_dir = ?")
      .get(gitCommonDir) as DbRow | undefined;
    return row ? mapBranchReview(row) : null;
  }

  findBranchReviewByIdentity(owner: string, repository: string): BranchReview | null {
    const row = this.database
      .prepare(
        "SELECT * FROM branch_reviews WHERE host = 'github.com' AND lower(owner) = lower(?) AND lower(repository) = lower(?)",
      )
      .get(owner, repository) as DbRow | undefined;
    return row ? mapBranchReview(row) : null;
  }

  upsertBranchReview(
    github: {
      owner: string;
      repository: string;
      canonicalName: string;
      defaultBranchName: string;
      defaultBranchOid: string;
    },
    repositoryLocation: { localRepositoryPath: string; gitCommonDir: string },
  ): BranchReview {
    const now = new Date().toISOString();
    let id: string;
    try {
      id = this.immediateTransaction(() => {
        const byIdentity = this.findBranchReviewByIdentity(github.owner, github.repository);
        const byGitCommonDir = this.findBranchReviewByGitCommonDir(repositoryLocation.gitCommonDir);
        if (byIdentity && byGitCommonDir && byIdentity.id !== byGitCommonDir.id) {
          throw new RvwError(
            "REPOSITORY_MISMATCH",
            "canonical repositoryとGit common directoryが異なるBranch Reviewへ登録されています。",
            {
              details: {
                canonicalBranchReviewId: byIdentity.id,
                localBranchReviewId: byGitCommonDir.id,
              },
            },
          );
        }
        if (
          byIdentity &&
          path.resolve(byIdentity.gitCommonDir) !== path.resolve(repositoryLocation.gitCommonDir)
        ) {
          throw new RvwError(
            "REPOSITORY_MISMATCH",
            "このcanonical repositoryのBranch Reviewは別の独立cloneへ登録されています。",
            {
              details: {
                branchReviewId: byIdentity.id,
                registeredGitCommonDir: byIdentity.gitCommonDir,
                currentGitCommonDir: repositoryLocation.gitCommonDir,
              },
            },
          );
        }
        if (
          byGitCommonDir &&
          (byGitCommonDir.owner.toLowerCase() !== github.owner.toLowerCase() ||
            byGitCommonDir.repository.toLowerCase() !== github.repository.toLowerCase())
        ) {
          throw new RvwError(
            "REPOSITORY_MISMATCH",
            "このGit common directoryは別のcanonical repositoryへ登録されています。",
            {
              details: {
                branchReviewId: byGitCommonDir.id,
                registeredRepository: byGitCommonDir.canonicalName,
                currentRepository: github.canonicalName,
              },
            },
          );
        }

        const existing = byIdentity ?? byGitCommonDir;
        const selectedId = existing?.id ?? randomUUID();
        if (existing) {
          this.database
            .prepare(
              `UPDATE branch_reviews SET
                owner = ?, repository = ?, canonical_name = ?, local_repository_path = ?,
                git_common_dir = ?, default_branch_name = ?, source_oid = ?, github_fetched_at = ?,
                source_sync_error = NULL, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              github.owner,
              github.repository,
              github.canonicalName,
              repositoryLocation.localRepositoryPath,
              repositoryLocation.gitCommonDir,
              github.defaultBranchName,
              github.defaultBranchOid,
              now,
              now,
              selectedId,
            );
        } else {
          this.database
            .prepare(
              `INSERT INTO branch_reviews(
                id, host, owner, repository, canonical_name, local_repository_path, git_common_dir,
                default_branch_name, source_oid, github_fetched_at, source_sync_error, created_at, updated_at
              ) VALUES (?, 'github.com', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            )
            .run(
              selectedId,
              github.owner,
              github.repository,
              github.canonicalName,
              repositoryLocation.localRepositoryPath,
              repositoryLocation.gitCommonDir,
              github.defaultBranchName,
              github.defaultBranchOid,
              now,
              now,
              now,
            );
        }
        this.incrementChangeSequence({ kind: "branch", reviewId: selectedId });
        return selectedId;
      });
    } catch (error) {
      if (error instanceof RvwError) throw error;
      if (/constraint/i.test(error instanceof Error ? error.message : String(error))) {
        throw new RvwError(
          "DATABASE_ERROR",
          "Branch Review identityを一意に保存できませんでした。",
          { cause: error },
        );
      }
      throw error;
    }
    const result = this.getBranchReview(id);
    if (!result) throw new RvwError("DATABASE_ERROR", "Branch Reviewを読み出せません。");
    return result;
  }

  updateBranchRepositoryLocation(
    id: string,
    repository: { localRepositoryPath: string; gitCommonDir: string },
  ): BranchReview {
    const now = new Date().toISOString();
    this.immediateTransaction(() => {
      const result = this.database
        .prepare(
          "UPDATE branch_reviews SET local_repository_path = ?, git_common_dir = ?, updated_at = ? WHERE id = ?",
        )
        .run(repository.localRepositoryPath, repository.gitCommonDir, now, id);
      if (Number(result.changes) !== 1) {
        throw new RvwError("BRANCH_REVIEW_NOT_FOUND", "Branch Reviewが見つかりません。");
      }
      this.incrementChangeSequence({ kind: "branch", reviewId: id });
    });
    const result = this.getBranchReview(id);
    if (!result) throw new RvwError("BRANCH_REVIEW_NOT_FOUND", "Branch Reviewが見つかりません。");
    return result;
  }

  setBranchSyncError(id: string, message: string): BranchReview {
    this.immediateTransaction(() => {
      const result = this.database
        .prepare("UPDATE branch_reviews SET source_sync_error = ?, updated_at = ? WHERE id = ?")
        .run(message, new Date().toISOString(), id);
      if (Number(result.changes) !== 1) {
        throw new RvwError("BRANCH_REVIEW_NOT_FOUND", "Branch Reviewが見つかりません。");
      }
      this.incrementChangeSequence({ kind: "branch", reviewId: id });
    });
    const review = this.getBranchReview(id);
    if (!review) throw new RvwError("BRANCH_REVIEW_NOT_FOUND", "Branch Reviewが見つかりません。");
    return review;
  }

  getIssue(id: string): IssueDocument | null {
    const row = this.database.prepare("SELECT * FROM github_issues WHERE id = ?").get(id) as
      DbRow | undefined;
    return row ? mapIssue(row) : null;
  }

  findIssue(owner: string, repository: string, number: number): IssueDocument | null {
    const row = this.database
      .prepare(
        "SELECT * FROM github_issues WHERE host = 'github.com' AND lower(owner) = lower(?) AND lower(repository) = lower(?) AND number = ?",
      )
      .get(owner, repository, number) as DbRow | undefined;
    return row ? mapIssue(row) : null;
  }

  private writeIssue(issue: GitHubIssue): {
    issue: IssueDocument;
    changed: boolean;
    previouslyCached: boolean;
  } {
    const existing = this.findIssue(issue.owner, issue.repository, issue.number);
    const id = existing?.id ?? randomUUID();
    const fetchedAt = new Date().toISOString();
    const body = normalizeLf(issue.body);
    this.database
      .prepare(
        `INSERT INTO github_issues(
          id, host, owner, repository, canonical_name, number, github_url, title, body, state,
          github_updated_at, body_hash, fetched_at, sync_error
        ) VALUES (?, 'github.com', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          owner = excluded.owner,
          repository = excluded.repository,
          canonical_name = excluded.canonical_name,
          github_url = excluded.github_url,
          title = excluded.title,
          body = excluded.body,
          state = excluded.state,
          github_updated_at = excluded.github_updated_at,
          body_hash = excluded.body_hash,
          fetched_at = excluded.fetched_at,
          sync_error = NULL`,
      )
      .run(
        id,
        issue.owner,
        issue.repository,
        issue.canonicalName,
        issue.number,
        issue.url,
        issue.title,
        body,
        issue.state,
        issue.updatedAt,
        hashDocument(body),
        fetchedAt,
      );
    const result = this.findIssue(issue.owner, issue.repository, issue.number);
    if (!result) throw new RvwError("DATABASE_ERROR", "Issue cacheを読み出せません。");
    return {
      issue: result,
      previouslyCached: existing !== null,
      changed:
        existing === null ||
        existing.canonicalName !== result.canonicalName ||
        existing.url !== result.url ||
        existing.title !== result.title ||
        existing.bodyHash !== result.bodyHash ||
        existing.state !== result.state ||
        existing.updatedAt !== result.updatedAt ||
        existing.syncError !== result.syncError,
    };
  }

  upsertIssue(issue: GitHubIssue): IssueDocument {
    return this.writeIssue(issue).issue;
  }

  private issueMembershipStorage(reviewKind: "pull-request" | "branch"): {
    table: "pull_request_issues" | "branch_review_issues";
    reviewColumn: "pull_request_id" | "branch_review_id";
  } {
    return reviewKind === "pull-request"
      ? { table: "pull_request_issues", reviewColumn: "pull_request_id" }
      : { table: "branch_review_issues", reviewColumn: "branch_review_id" };
  }

  private notifyIssueReviewChanges(
    issueId: string,
    exclude?: { kind: "pull-request" | "branch"; reviewId: string },
  ): void {
    const contexts = (
      this.database
        .prepare(
          `SELECT 'pull-request' AS review_kind, pull_request_id AS review_id
           FROM pull_request_issues WHERE issue_id = ?
           UNION ALL
           SELECT 'branch' AS review_kind, branch_review_id AS review_id
           FROM branch_review_issues WHERE issue_id = ?`,
        )
        .all(issueId, issueId) as DbRow[]
    )
      .map((row) => ({
        kind: stringValue(row, "review_kind") as "pull-request" | "branch",
        reviewId: stringValue(row, "review_id"),
      }))
      .filter(
        (context) =>
          !exclude || context.kind !== exclude.kind || context.reviewId !== exclude.reviewId,
      );
    if (contexts.length === 0) return;
    this.incrementGlobalChangeSequence();
    for (const context of contexts) this.incrementReviewChangeSequence(context);
  }

  setIssueSyncError(issueId: string, message: string): IssueDocument {
    return this.immediateTransaction(() => {
      const current = this.getIssue(issueId);
      if (!current) throw new RvwError("ISSUE_NOT_FOUND", "Issueが見つかりません。");
      if (current.syncError === message) return current;
      this.database
        .prepare("UPDATE github_issues SET sync_error = ? WHERE id = ?")
        .run(message, issueId);
      this.notifyIssueReviewChanges(issueId);
      const issue = this.getIssue(issueId);
      if (!issue) throw new RvwError("ISSUE_NOT_FOUND", "Issueが見つかりません。");
      return issue;
    });
  }

  addReviewIssue(
    reviewKind: "pull-request" | "branch",
    reviewId: string,
    issue: GitHubIssue,
  ): { issue: IssueDocument; added: boolean } {
    return this.immediateTransaction(() => {
      const written = this.writeIssue(issue);
      const cached = written.issue;
      const { table, reviewColumn } = this.issueMembershipStorage(reviewKind);
      const result = this.database
        .prepare(
          `INSERT INTO ${table}(${reviewColumn}, issue_id, added_at)
           VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(reviewId, cached.id, new Date().toISOString());
      const added = Number(result.changes) === 1;
      if (written.changed && written.previouslyCached) {
        this.notifyIssueReviewChanges(cached.id);
      } else if (added) {
        this.incrementChangeSequence({ kind: reviewKind, reviewId });
      }
      return { issue: cached, added };
    });
  }

  private writeReviewIssueMemberships(
    reviewKind: "pull-request" | "branch",
    reviewId: string,
    issues: GitHubIssue[],
  ): IssueDocument[] {
    const added: IssueDocument[] = [];
    const { table, reviewColumn } = this.issueMembershipStorage(reviewKind);
    for (const issue of issues) {
      const written = this.writeIssue(issue);
      const cached = written.issue;
      const membership = this.database
        .prepare(
          `INSERT INTO ${table}(${reviewColumn}, issue_id, added_at)
           VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(reviewId, cached.id, new Date().toISOString());
      if (Number(membership.changes) === 1) added.push(cached);
      if (written.changed && written.previouslyCached) {
        this.notifyIssueReviewChanges(cached.id, { kind: reviewKind, reviewId });
      }
    }
    return added;
  }

  listReviewIssues(reviewKind: "pull-request" | "branch", reviewId: string): IssueDocument[] {
    const { table, reviewColumn } = this.issueMembershipStorage(reviewKind);
    return (
      this.database
        .prepare(
          `SELECT i.* FROM github_issues i
           JOIN ${table} ri ON ri.issue_id = i.id
           WHERE ri.${reviewColumn} = ?
           ORDER BY i.number DESC`,
        )
        .all(reviewId) as DbRow[]
    ).map(mapIssue);
  }

  hasReviewIssue(
    reviewKind: "pull-request" | "branch",
    reviewId: string,
    issueId: string,
  ): boolean {
    const { table, reviewColumn } = this.issueMembershipStorage(reviewKind);
    return Boolean(
      this.database
        .prepare(`SELECT 1 AS found FROM ${table} WHERE ${reviewColumn} = ? AND issue_id = ?`)
        .get(reviewId, issueId),
    );
  }

  getIssueRemovalCounts(
    reviewKind: "pull-request" | "branch",
    reviewId: string,
    issueId: string,
  ): IssueRemovalCounts {
    const commentTable = reviewKind === "pull-request" ? "comments" : "branch_comments";
    const targetTable =
      reviewKind === "pull-request" ? "comment_targets" : "branch_comment_targets";
    const postTable = reviewKind === "pull-request" ? "comment_posts" : "branch_comment_posts";
    const reviewColumn = reviewKind === "pull-request" ? "pull_request_id" : "branch_review_id";
    const row = this.database
      .prepare(
        `SELECT
          count(DISTINCT CASE WHEN t.start_line IS NULL THEN c.id END) AS issue_whole_comments,
          count(DISTINCT CASE WHEN t.start_line IS NOT NULL THEN c.id END) AS issue_range_comments,
          count(DISTINCT CASE WHEN p.is_root = 0 THEN p.id END) AS replies
         FROM ${commentTable} c
         JOIN ${targetTable} t ON t.comment_id = c.id
         LEFT JOIN ${postTable} p ON p.comment_id = c.id
         WHERE c.${reviewColumn} = ? AND t.target_kind = 'issue' AND t.issue_id = ?`,
      )
      .get(reviewId, issueId) as DbRow;
    return {
      issueWholeComments: numberValue(row, "issue_whole_comments"),
      issueRangeComments: numberValue(row, "issue_range_comments"),
      replies: numberValue(row, "replies"),
    };
  }

  removeReviewIssue(
    reviewKind: "pull-request" | "branch",
    reviewId: string,
    issueId: string,
  ): IssueRemovalCounts {
    return this.immediateTransaction(() => {
      if (!this.hasReviewIssue(reviewKind, reviewId, issueId)) {
        throw new RvwError("ISSUE_NOT_FOUND", "このreviewにIssueが登録されていません。", {
          status: 404,
        });
      }
      const counts = this.getIssueRemovalCounts(reviewKind, reviewId, issueId);
      if (reviewKind === "pull-request") {
        this.database
          .prepare(
            `DELETE FROM comments
             WHERE pull_request_id = ? AND id IN (
               SELECT comment_id FROM comment_targets
               WHERE target_kind = 'issue' AND issue_id = ?
             )`,
          )
          .run(reviewId, issueId);
      } else {
        this.database
          .prepare(
            `DELETE FROM branch_comments
             WHERE branch_review_id = ? AND id IN (
               SELECT comment_id FROM branch_comment_targets
               WHERE target_kind = 'issue' AND issue_id = ?
             )`,
          )
          .run(reviewId, issueId);
      }
      const { table, reviewColumn } = this.issueMembershipStorage(reviewKind);
      const membership = this.database
        .prepare(`DELETE FROM ${table} WHERE ${reviewColumn} = ? AND issue_id = ?`)
        .run(reviewId, issueId);
      if (Number(membership.changes) !== 1) {
        throw new RvwError("DATABASE_ERROR", "Issue membershipを削除できませんでした。");
      }
      this.incrementChangeSequence({ kind: reviewKind, reviewId });
      return counts;
    });
  }

  getBranchResetCounts(branchReviewId: string, gitRefs: number): BranchResetCounts {
    const row = this.database
      .prepare(
        `SELECT
          (SELECT count(*) FROM branch_reviews WHERE id = ?) AS branch_review,
          (SELECT count(*) FROM branch_review_issues WHERE branch_review_id = ?) AS issue_memberships,
          (SELECT count(*) FROM branch_comments c JOIN branch_comment_targets t ON t.comment_id = c.id WHERE c.branch_review_id = ? AND t.target_kind = 'issue') AS issue_comments,
          (SELECT count(*) FROM branch_comments c JOIN branch_comment_targets t ON t.comment_id = c.id WHERE c.branch_review_id = ? AND t.target_kind = 'repository_file') AS code_comments,
          (SELECT count(*) FROM branch_comments c JOIN branch_comment_targets t ON t.comment_id = c.id WHERE c.branch_review_id = ? AND t.target_kind = 'branch') AS review_comments,
          (SELECT count(*) FROM branch_comments c JOIN branch_comment_targets t ON t.comment_id = c.id WHERE c.branch_review_id = ? AND t.target_kind = 'walkthrough') AS walkthrough_comments,
          (SELECT count(*) FROM branch_comment_posts p JOIN branch_comments c ON c.id = p.comment_id WHERE c.branch_review_id = ?) AS posts,
          (SELECT count(*) FROM branch_walkthroughs WHERE branch_review_id = ?) AS walkthroughs`,
      )
      .get(
        branchReviewId,
        branchReviewId,
        branchReviewId,
        branchReviewId,
        branchReviewId,
        branchReviewId,
        branchReviewId,
        branchReviewId,
      ) as DbRow;
    return {
      branchReview: numberValue(row, "branch_review"),
      issueMemberships: numberValue(row, "issue_memberships"),
      issueComments: numberValue(row, "issue_comments"),
      codeComments: numberValue(row, "code_comments"),
      reviewComments: numberValue(row, "review_comments"),
      walkthroughComments: numberValue(row, "walkthrough_comments"),
      posts: numberValue(row, "posts"),
      walkthroughs: numberValue(row, "walkthroughs"),
      gitRefs,
    };
  }

  resetBranchReview(branchReviewId: string, gitRefs: number): BranchResetCounts {
    return this.immediateTransaction(() => {
      if (!this.getBranchReview(branchReviewId)) {
        throw new RvwError("BRANCH_REVIEW_NOT_FOUND", "Branch Reviewが見つかりません。", {
          status: 404,
        });
      }
      const counts = this.getBranchResetCounts(branchReviewId, gitRefs);
      this.database
        .prepare("DELETE FROM branch_comments WHERE branch_review_id = ?")
        .run(branchReviewId);
      this.database
        .prepare("DELETE FROM branch_walkthroughs WHERE branch_review_id = ?")
        .run(branchReviewId);
      const review = this.database
        .prepare("DELETE FROM branch_reviews WHERE id = ?")
        .run(branchReviewId);
      if (Number(review.changes) !== 1) {
        throw new RvwError("DATABASE_ERROR", "Branch Reviewを削除できませんでした。");
      }
      this.incrementChangeSequence({ kind: "branch", reviewId: branchReviewId });
      return counts;
    });
  }

  updateRepositoryLocation(
    id: string,
    repository: { localRepositoryPath: string; gitCommonDir: string },
  ): PullRequest {
    this.immediateTransaction(() => {
      const result = this.database
        .prepare(
          "UPDATE pull_requests SET local_repository_path = ?, git_common_dir = ?, updated_at = ? WHERE id = ?",
        )
        .run(repository.localRepositoryPath, repository.gitCommonDir, new Date().toISOString(), id);
      if (Number(result.changes) === 0)
        throw new RvwError("PR_NOT_FOUND", "Pull Requestが見つかりません。");
      this.incrementChangeSequence({ kind: "pull-request", reviewId: id });
    });
    const pullRequest = this.getPullRequest(id);
    if (!pullRequest) throw new RvwError("PR_NOT_FOUND", "Pull Requestが見つかりません。");
    return pullRequest;
  }

  private writePullRequest(
    github: GitHubPullRequest,
    repository: { localRepositoryPath: string; gitCommonDir: string },
    comparisonBaseOid: string,
  ): string {
    const now = new Date().toISOString();
    const existing = this.findPullRequestByIdentity(github.owner, github.repository, github.number);
    const id = existing?.id ?? randomUUID();
    this.database
      .prepare(
        `INSERT INTO pull_requests(
          id, host, owner, repository, number, github_url,
          local_repository_path, git_common_dir,
          latest_author_login, latest_head_repository_owner, latest_head_repository_name,
          latest_title, latest_body, latest_base_ref_name, latest_head_ref_name,
          latest_base_oid, latest_head_oid, github_updated_at, fetched_at,
          created_at, updated_at, latest_comparison_base_oid
        ) VALUES (?, 'github.com', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host, owner, repository, number) DO UPDATE SET
          github_url = excluded.github_url,
          local_repository_path = excluded.local_repository_path,
          git_common_dir = excluded.git_common_dir,
          latest_author_login = excluded.latest_author_login,
          latest_head_repository_owner = excluded.latest_head_repository_owner,
          latest_head_repository_name = excluded.latest_head_repository_name,
          latest_title = excluded.latest_title,
          latest_body = excluded.latest_body,
          latest_base_ref_name = excluded.latest_base_ref_name,
          latest_head_ref_name = excluded.latest_head_ref_name,
          latest_base_oid = excluded.latest_base_oid,
          latest_comparison_base_oid = excluded.latest_comparison_base_oid,
          latest_head_oid = excluded.latest_head_oid,
          github_updated_at = excluded.github_updated_at,
          fetched_at = excluded.fetched_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        github.owner,
        github.repository,
        github.number,
        github.url,
        repository.localRepositoryPath,
        repository.gitCommonDir,
        github.authorLogin,
        github.headRepositoryOwner,
        github.headRepositoryName,
        github.title,
        github.body,
        github.baseRefName,
        github.headRefName,
        github.baseOid,
        github.headOid,
        github.updatedAt,
        now,
        existing?.createdAt ?? now,
        now,
        comparisonBaseOid,
      );
    return id;
  }

  upsertPullRequest(
    github: GitHubPullRequest,
    repository: { localRepositoryPath: string; gitCommonDir: string },
    comparisonBaseOid: string,
  ): PullRequest {
    const id = this.immediateTransaction(() => {
      const writtenId = this.writePullRequest(github, repository, comparisonBaseOid);
      this.incrementChangeSequence({ kind: "pull-request", reviewId: writtenId });
      return writtenId;
    });
    const pullRequest = this.getPullRequest(id);
    if (!pullRequest)
      throw new RvwError("DATABASE_ERROR", "保存したPull Requestを読み出せません。");
    return pullRequest;
  }

  syncPullRequestAndComments(
    github: GitHubPullRequest,
    repository: { localRepositoryPath: string; gitCommonDir: string },
    comparisonBaseOid: string,
    updates: CommentUpdateInput[],
  ): PullRequest {
    const id = this.immediateTransaction(() => {
      const writtenId = this.writePullRequest(github, repository, comparisonBaseOid);
      this.applyCommentUpdates(updates, github.headOid);
      this.incrementChangeSequence({ kind: "pull-request", reviewId: writtenId });
      return writtenId;
    });
    const pullRequest = this.getPullRequest(id);
    if (!pullRequest)
      throw new RvwError("DATABASE_ERROR", "同期したPull Requestを読み出せません。");
    return pullRequest;
  }

  resetPullRequest(
    github: GitHubPullRequest,
    repository: { localRepositoryPath: string; gitCommonDir: string },
    comparisonBaseOid: string,
  ): PullRequest {
    const id = this.immediateTransaction(() => {
      const writtenId = this.writePullRequest(github, repository, comparisonBaseOid);
      this.deletePullRequestHistory(writtenId);
      this.incrementChangeSequence({ kind: "pull-request", reviewId: writtenId });
      return writtenId;
    });
    const pullRequest = this.getPullRequest(id);
    if (!pullRequest)
      throw new RvwError("DATABASE_ERROR", "再構築したPull Requestを読み出せません。");
    return pullRequest;
  }

  getResetCounts(pullRequestId: string, gitRefs: number): ResetCounts {
    const issueMemberships = this.database
      .prepare("SELECT count(*) AS count FROM pull_request_issues WHERE pull_request_id = ?")
      .get(pullRequestId) as DbRow;
    const comments = this.database
      .prepare("SELECT count(*) AS count FROM comments WHERE pull_request_id = ?")
      .get(pullRequestId) as DbRow;
    const posts = this.database
      .prepare(
        "SELECT count(*) AS count FROM comment_posts WHERE comment_id IN (SELECT id FROM comments WHERE pull_request_id = ?)",
      )
      .get(pullRequestId) as DbRow;
    const commentReferences = this.database
      .prepare(
        `SELECT count(*) AS count
         FROM comment_post_references
         WHERE post_id IN (
           SELECT posts.id
           FROM comment_posts AS posts
           JOIN comments ON comments.id = posts.comment_id
           WHERE comments.pull_request_id = ?
         )`,
      )
      .get(pullRequestId) as DbRow;
    const targets = this.database
      .prepare(
        "SELECT count(*) AS count FROM comment_targets WHERE comment_id IN (SELECT id FROM comments WHERE pull_request_id = ?)",
      )
      .get(pullRequestId) as DbRow;
    const walkthroughs = this.database
      .prepare("SELECT count(*) AS count FROM walkthroughs WHERE pull_request_id = ?")
      .get(pullRequestId) as DbRow;
    const walkthroughReferences = this.database
      .prepare(
        "SELECT count(*) AS count FROM walkthrough_references WHERE walkthrough_id IN (SELECT id FROM walkthroughs WHERE pull_request_id = ?)",
      )
      .get(pullRequestId) as DbRow;
    return {
      issueMemberships: numberValue(issueMemberships, "count"),
      comments: numberValue(comments, "count"),
      posts: numberValue(posts, "count"),
      commentReferences: numberValue(commentReferences, "count"),
      targets: numberValue(targets, "count"),
      walkthroughs: numberValue(walkthroughs, "count"),
      walkthroughReferences: numberValue(walkthroughReferences, "count"),
      gitRefs,
    };
  }

  deletePullRequestHistory(pullRequestId: string): void {
    this.database.prepare("DELETE FROM comments WHERE pull_request_id = ?").run(pullRequestId);
    this.database.prepare("DELETE FROM walkthroughs WHERE pull_request_id = ?").run(pullRequestId);
    this.database
      .prepare("DELETE FROM pull_request_issues WHERE pull_request_id = ?")
      .run(pullRequestId);
  }

  private codeReferenceStorage(
    kind: "comment-post" | "walkthrough" | "branch-comment-post" | "branch-walkthrough",
  ): {
    table:
      | "comment_post_references"
      | "walkthrough_references"
      | "branch_comment_post_references"
      | "branch_walkthrough_references";
    ownerColumn: "post_id" | "walkthrough_id";
  } {
    if (kind === "comment-post") {
      return { table: "comment_post_references", ownerColumn: "post_id" };
    }
    if (kind === "branch-comment-post") {
      return { table: "branch_comment_post_references", ownerColumn: "post_id" };
    }
    if (kind === "branch-walkthrough") {
      return { table: "branch_walkthrough_references", ownerColumn: "walkthrough_id" };
    }
    return { table: "walkthrough_references", ownerColumn: "walkthrough_id" };
  }

  private listCodeReferences(
    kind: "comment-post" | "walkthrough" | "branch-comment-post" | "branch-walkthrough",
    ownerId: string,
  ): CodeReference[] {
    const { table, ownerColumn } = this.codeReferenceStorage(kind);
    return (
      this.database
        .prepare(`SELECT * FROM ${table} WHERE ${ownerColumn} = ? ORDER BY sort_order ASC`)
        .all(ownerId) as DbRow[]
    ).map(mapCodeReference);
  }

  private listCodeReferencesForOwners(
    kind: "comment-post" | "branch-comment-post",
    ownerIds: string[],
  ): Map<string, CodeReference[]> {
    const referencesByOwner = new Map(ownerIds.map((ownerId) => [ownerId, [] as CodeReference[]]));
    if (ownerIds.length === 0) return referencesByOwner;
    const { table, ownerColumn } = this.codeReferenceStorage(kind);
    const placeholders = ownerIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT *, ${ownerColumn} AS reference_owner_id
         FROM ${table}
         WHERE ${ownerColumn} IN (${placeholders})
         ORDER BY ${ownerColumn} ASC, sort_order ASC`,
      )
      .all(...ownerIds) as DbRow[];
    for (const row of rows) {
      referencesByOwner.get(stringValue(row, "reference_owner_id"))?.push(mapCodeReference(row));
    }
    return referencesByOwner;
  }

  private listPostsForComments(
    kind: "comment-post" | "branch-comment-post",
    commentIds: string[],
  ): Map<string, CommentPost[]> {
    const postsByComment = new Map(commentIds.map((commentId) => [commentId, [] as CommentPost[]]));
    if (commentIds.length === 0) return postsByComment;
    const table = kind === "comment-post" ? "comment_posts" : "branch_comment_posts";
    const placeholders = commentIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT * FROM ${table}
         WHERE comment_id IN (${placeholders})
         ORDER BY comment_id ASC, is_root DESC, created_at ASC, id ASC`,
      )
      .all(...commentIds) as DbRow[];
    const referencesByPost = this.listCodeReferencesForOwners(
      kind,
      rows.map((row) => stringValue(row, "id")),
    );
    for (const row of rows) {
      const postId = stringValue(row, "id");
      postsByComment
        .get(stringValue(row, "comment_id"))
        ?.push(mapCommentPost(row, referencesByPost.get(postId) ?? []));
    }
    return postsByComment;
  }

  private insertCodeReferences(
    kind: "comment-post" | "walkthrough" | "branch-comment-post" | "branch-walkthrough",
    ownerId: string,
    references: CodeReference[],
  ): void {
    if (references.length === 0) return;
    const { table, ownerColumn } = this.codeReferenceStorage(kind);
    const insertReference = this.database.prepare(
      `INSERT INTO ${table}(
        ${ownerColumn}, reference_id, label, file_path, start_line, end_line,
        description, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    references.forEach((reference, index) => {
      insertReference.run(
        ownerId,
        reference.id,
        reference.label,
        reference.path,
        reference.startLine,
        reference.endLine,
        reference.description,
        index,
      );
    });
  }

  private mapWalkthrough(row: DbRow): Walkthrough {
    const id = stringValue(row, "id");
    return {
      id,
      ref: formatWalkthroughUri(id),
      pullRequestId: stringValue(row, "pull_request_id"),
      sourceOid: stringValue(row, "source_oid"),
      title: stringValue(row, "title"),
      body: stringValue(row, "body"),
      authorLabel: nullableString(row, "author_label"),
      diagramBindings: stringRecordValue(row, "diagram_bindings_json"),
      references: this.listCodeReferences("walkthrough", id),
      createdAt: stringValue(row, "created_at"),
    };
  }

  getWalkthrough(id: string): Walkthrough | null {
    const row = this.database.prepare("SELECT * FROM walkthroughs WHERE id = ?").get(id) as
      DbRow | undefined;
    return row ? this.mapWalkthrough(row) : null;
  }

  listWalkthroughs(pullRequestId: string): WalkthroughSummary[] {
    return (
      this.database
        .prepare(
          `SELECT walkthroughs.*, COUNT(walkthrough_references.reference_id) AS reference_count
           FROM walkthroughs
           LEFT JOIN walkthrough_references
             ON walkthrough_references.walkthrough_id = walkthroughs.id
           WHERE walkthroughs.pull_request_id = ?
           GROUP BY walkthroughs.id
           ORDER BY walkthroughs.created_at DESC, walkthroughs.id DESC`,
        )
        .all(pullRequestId) as DbRow[]
    ).map((row) => ({
      id: stringValue(row, "id"),
      pullRequestId: stringValue(row, "pull_request_id"),
      sourceOid: stringValue(row, "source_oid"),
      title: stringValue(row, "title"),
      authorLabel: nullableString(row, "author_label"),
      referenceCount: numberValue(row, "reference_count"),
      createdAt: stringValue(row, "created_at"),
    }));
  }

  createWalkthrough(
    input: NewWalkthroughInput,
    issues: GitHubIssue[] = [],
  ): { walkthrough: Walkthrough; issuesAdded: IssueDocument[] } {
    const id = randomUUID();
    const now = new Date().toISOString();
    const issuesAdded = this.immediateTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO walkthroughs(
            id, pull_request_id, source_oid, title, body, author_label,
            diagram_bindings_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.pullRequestId,
          input.sourceOid,
          input.title,
          input.body,
          input.authorLabel ?? null,
          JSON.stringify(input.diagramBindings),
          now,
        );
      this.insertCodeReferences("walkthrough", id, input.references);
      const added = this.writeReviewIssueMemberships("pull-request", input.pullRequestId, issues);
      this.incrementChangeSequence({ kind: "pull-request", reviewId: input.pullRequestId });
      return added;
    });
    const walkthrough = this.getWalkthrough(id);
    if (!walkthrough) {
      throw new RvwError("DATABASE_ERROR", "保存したwalkthroughを読み出せません。");
    }
    return { walkthrough, issuesAdded };
  }

  updateWalkthrough(
    id: string,
    input: Omit<NewWalkthroughInput, "pullRequestId">,
    issues: GitHubIssue[] = [],
  ): { walkthrough: Walkthrough; issuesAdded: IssueDocument[] } {
    const issuesAdded = this.immediateTransaction(() => {
      const result = this.database
        .prepare(
          `UPDATE walkthroughs
           SET source_oid = ?, title = ?, body = ?, author_label = ?, diagram_bindings_json = ?
           WHERE id = ?`,
        )
        .run(
          input.sourceOid,
          input.title,
          input.body,
          input.authorLabel ?? null,
          JSON.stringify(input.diagramBindings),
          id,
        );
      if (Number(result.changes) === 0) {
        throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。", { status: 404 });
      }
      this.database.prepare("DELETE FROM walkthrough_references WHERE walkthrough_id = ?").run(id);
      this.insertCodeReferences("walkthrough", id, input.references);
      const walkthrough = this.getWalkthrough(id);
      if (!walkthrough) throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。");
      const added = this.writeReviewIssueMemberships(
        "pull-request",
        walkthrough.pullRequestId,
        issues,
      );
      this.incrementChangeSequence({
        kind: "pull-request",
        reviewId: walkthrough.pullRequestId,
      });
      return added;
    });
    const walkthrough = this.getWalkthrough(id);
    if (!walkthrough) {
      throw new RvwError("DATABASE_ERROR", "更新したwalkthroughを読み出せません。");
    }
    return { walkthrough, issuesAdded };
  }

  getWalkthroughDeleteCounts(id: string): WalkthroughDeleteCounts {
    const comments = this.database
      .prepare("SELECT count(*) AS count FROM comment_targets WHERE walkthrough_id = ?")
      .get(id) as DbRow;
    const posts = this.database
      .prepare(
        `SELECT count(*) AS count
         FROM comment_posts
         WHERE comment_id IN (
           SELECT comment_id FROM comment_targets WHERE walkthrough_id = ?
         )`,
      )
      .get(id) as DbRow;
    const references = this.database
      .prepare("SELECT count(*) AS count FROM walkthrough_references WHERE walkthrough_id = ?")
      .get(id) as DbRow;
    return {
      comments: numberValue(comments, "count"),
      posts: numberValue(posts, "count"),
      references: numberValue(references, "count"),
    };
  }

  deleteWalkthrough(id: string): DeletedWalkthrough {
    return this.immediateTransaction(() => {
      const walkthrough = this.getWalkthrough(id);
      if (!walkthrough) {
        throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。", { status: 404 });
      }
      const counts = this.getWalkthroughDeleteCounts(id);
      this.database
        .prepare(
          `DELETE FROM comments
           WHERE id IN (SELECT comment_id FROM comment_targets WHERE walkthrough_id = ?)`,
        )
        .run(id);
      this.database.prepare("DELETE FROM walkthroughs WHERE id = ?").run(id);
      this.incrementChangeSequence({
        kind: "pull-request",
        reviewId: walkthrough.pullRequestId,
      });
      return {
        id: walkthrough.id,
        ref: walkthrough.ref,
        pullRequestId: walkthrough.pullRequestId,
        counts,
      };
    });
  }

  createComment(input: NewCommentInput): ReviewComment {
    const now = new Date().toISOString();
    const id = randomUUID();
    const postId = randomUUID();
    const pullRequest = this.getPullRequest(input.pullRequestId);
    if (!pullRequest) throw new RvwError("PR_NOT_FOUND", "Pull Requestが見つかりません。");
    this.immediateTransaction(() => {
      this.database
        .prepare(
          "INSERT INTO comments(id, pull_request_id, created_head_oid, resolved_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
        )
        .run(id, input.pullRequestId, input.createdHeadOid, now, now);
      this.insertCommentTarget(id, input.target);
      this.database
        .prepare(
          "INSERT INTO comment_posts(id, comment_id, body, related_commit_oid, author_label, is_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
        )
        .run(
          postId,
          id,
          input.body,
          input.relatedCommitOid ?? null,
          input.authorLabel ?? null,
          now,
          now,
        );
      this.insertCodeReferences("comment-post", postId, input.references ?? []);
      this.insertReviewCommentEvent(
        postId,
        formatCommentUri(id),
        { kind: "pull-request", pullRequestId: pullRequest.id, pullRequestUrl: pullRequest.url },
        now,
      );
      this.incrementChangeSequence({ kind: "pull-request", reviewId: input.pullRequestId });
    });
    const comment = this.getComment(id);
    if (!comment) throw new RvwError("DATABASE_ERROR", "保存したコメントを読み出せません。");
    return comment;
  }

  private insertCommentTarget(commentId: string, target: CommentTarget): void {
    if (target.kind === "pull-request") {
      this.database
        .prepare("INSERT INTO comment_targets(comment_id, target_kind) VALUES (?, ?)")
        .run(commentId, "pull_request");
      return;
    }
    if (target.kind === "issue") {
      this.database
        .prepare(
          `INSERT INTO comment_targets(
            comment_id, target_kind, issue_id, source_document_hash, quoted_text,
            start_line, end_line
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          commentId,
          "issue",
          target.issueId,
          target.sourceDocumentHash,
          target.quotedText,
          target.startLine,
          target.endLine,
        );
      return;
    }
    if (target.kind === "walkthrough") {
      this.database
        .prepare(
          `INSERT INTO comment_targets(
            comment_id, target_kind, walkthrough_id, source_document_hash, quoted_text,
            start_line, end_line
          ) VALUES (?, 'walkthrough', ?, ?, ?, ?, ?)`,
        )
        .run(
          commentId,
          target.walkthroughId,
          target.sourceDocumentHash,
          target.quotedText,
          target.startLine,
          target.endLine,
        );
      return;
    }
    if (target.documentKind === "pull-request-markdown") {
      this.database
        .prepare(
          `INSERT INTO comment_targets(
            comment_id, target_kind, document_kind, source_document_hash, quoted_text,
            start_line, end_line
          ) VALUES (?, 'document', 'pull_request_markdown', ?, ?, ?, ?)`,
        )
        .run(
          commentId,
          target.sourceDocumentHash,
          target.quotedText,
          target.startLine,
          target.endLine,
        );
      return;
    }
    this.database
      .prepare(
        `INSERT INTO comment_targets(
          comment_id, target_kind, document_kind, source_oid, file_path, start_line, end_line
        ) VALUES (?, 'document', 'repository_file', ?, ?, ?, ?)`,
      )
      .run(commentId, target.sourceOid, target.path, target.startLine, target.endLine);
  }

  private mapCommentWithoutPosts(row: DbRow): Omit<ReviewComment, "posts"> {
    const id = stringValue(row, "id");
    const targetKind = stringValue(row, "target_kind");
    let target: CommentTarget;
    if (targetKind === "issue") {
      target = {
        kind: "issue",
        issueId: stringValue(row, "issue_id"),
        issueUrl: stringValue(row, "issue_url"),
        issueNumber: numberValue(row, "issue_number"),
        issueTitle: stringValue(row, "issue_title"),
        sourceDocumentHash: stringValue(row, "source_document_hash"),
        quotedText: nullableString(row, "quoted_text"),
        startLine: nullableNumber(row, "start_line"),
        endLine: nullableNumber(row, "end_line"),
      };
    } else if (targetKind === "pull_request") {
      target = { kind: "pull-request" };
    } else if (targetKind === "walkthrough") {
      target = {
        kind: "walkthrough",
        walkthroughId: stringValue(row, "walkthrough_id"),
        walkthroughTitle: stringValue(row, "walkthrough_title"),
        sourceDocumentHash: nullableString(row, "source_document_hash"),
        quotedText: nullableString(row, "quoted_text"),
        startLine: nullableNumber(row, "start_line"),
        endLine: nullableNumber(row, "end_line"),
      };
    } else if (stringValue(row, "document_kind") === "pull_request_markdown") {
      target = {
        kind: "document",
        documentKind: "pull-request-markdown",
        sourceDocumentHash: stringValue(row, "source_document_hash"),
        quotedText: nullableString(row, "quoted_text"),
        startLine: row.start_line === null ? null : numberValue(row, "start_line"),
        endLine: row.end_line === null ? null : numberValue(row, "end_line"),
      };
    } else {
      target = {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: stringValue(row, "source_oid"),
        path: stringValue(row, "file_path"),
        startLine: row.start_line === null ? null : numberValue(row, "start_line"),
        endLine: row.end_line === null ? null : numberValue(row, "end_line"),
      };
    }
    return {
      id,
      ref: formatCommentUri(id),
      pullRequestId: stringValue(row, "pull_request_id"),
      createdHeadOid: stringValue(row, "created_head_oid"),
      resolvedAt: nullableString(row, "resolved_at"),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
      target,
    };
  }

  private mapComment(row: DbRow): ReviewComment {
    const comment = this.mapCommentWithoutPosts(row);
    return { ...comment, posts: this.listCommentPosts(comment.id) };
  }

  getComment(id: string): ReviewComment | null {
    const row = this.database
      .prepare(
        `SELECT c.*, t.target_kind, t.document_kind, t.source_oid, t.file_path,
          t.source_document_hash, t.quoted_text, t.walkthrough_id, t.issue_id,
          t.start_line, t.end_line,
          w.title AS walkthrough_title,
          i.github_url AS issue_url, i.number AS issue_number, i.title AS issue_title
        FROM comments c
        JOIN comment_targets t ON t.comment_id = c.id
        LEFT JOIN walkthroughs w ON w.id = t.walkthrough_id
        LEFT JOIN github_issues i ON i.id = t.issue_id
        WHERE c.id = ?`,
      )
      .get(id) as DbRow | undefined;
    return row ? this.mapComment(row) : null;
  }

  listComments(pullRequestId: string, resolved?: boolean): ReviewComment[] {
    const where =
      resolved === undefined
        ? ""
        : resolved
          ? " AND c.resolved_at IS NOT NULL"
          : " AND c.resolved_at IS NULL";
    const rows = this.database
      .prepare(
        `SELECT c.*, t.target_kind, t.document_kind, t.source_oid, t.file_path,
            t.source_document_hash, t.quoted_text, t.walkthrough_id, t.issue_id,
            t.start_line, t.end_line,
            w.title AS walkthrough_title,
            i.github_url AS issue_url, i.number AS issue_number, i.title AS issue_title
          FROM comments c
          JOIN comment_targets t ON t.comment_id = c.id
          LEFT JOIN walkthroughs w ON w.id = t.walkthrough_id
          LEFT JOIN github_issues i ON i.id = t.issue_id
          WHERE c.pull_request_id = ?${where} ORDER BY c.updated_at DESC`,
      )
      .all(pullRequestId) as DbRow[];
    const comments = rows.map((row) => this.mapCommentWithoutPosts(row));
    const postsByComment = this.listPostsForComments(
      "comment-post",
      comments.map((comment) => comment.id),
    );
    return comments.map((comment) => ({
      ...comment,
      posts: postsByComment.get(comment.id) ?? [],
    }));
  }

  listCommentPage(
    pullRequestId: string,
    resolved: boolean | undefined,
    limit: number,
    offset: number,
  ): CommentPage {
    const where =
      resolved === undefined
        ? ""
        : resolved
          ? " AND c.resolved_at IS NOT NULL"
          : " AND c.resolved_at IS NULL";
    const totalRow = this.database
      .prepare(`SELECT COUNT(*) AS total FROM comments c WHERE c.pull_request_id = ?${where}`)
      .get(pullRequestId) as DbRow;
    const comments = (
      this.database
        .prepare(
          `SELECT c.*, t.target_kind, t.document_kind, t.source_oid, t.file_path,
            t.source_document_hash, t.quoted_text, t.walkthrough_id, t.issue_id,
            t.start_line, t.end_line,
            w.title AS walkthrough_title,
            i.github_url AS issue_url, i.number AS issue_number, i.title AS issue_title,
            root.id AS root_id, root.body AS root_body,
            root.related_commit_oid AS root_related_commit_oid,
            root.author_label AS root_author_label, root.created_at AS root_created_at,
            root.updated_at AS root_updated_at,
            (SELECT COUNT(*) FROM comment_posts p WHERE p.comment_id = c.id) AS post_count
          FROM comments c
          JOIN comment_targets t ON t.comment_id = c.id
          JOIN comment_posts root ON root.comment_id = c.id AND root.is_root = 1
          LEFT JOIN walkthroughs w ON w.id = t.walkthrough_id
          LEFT JOIN github_issues i ON i.id = t.issue_id
          WHERE c.pull_request_id = ?${where}
          ORDER BY c.updated_at DESC, c.id DESC
          LIMIT ? OFFSET ?`,
        )
        .all(pullRequestId, limit, offset) as DbRow[]
    ).map((row) => {
      const comment = this.mapCommentWithoutPosts(row);
      return {
        comment,
        rootPost: {
          id: stringValue(row, "root_id"),
          commentId: comment.id,
          body: stringValue(row, "root_body"),
          relatedCommitOid: nullableString(row, "root_related_commit_oid"),
          references: [],
          authorLabel: nullableString(row, "root_author_label"),
          isRoot: true,
          createdAt: stringValue(row, "root_created_at"),
          updatedAt: stringValue(row, "root_updated_at"),
        },
        postCount: numberValue(row, "post_count"),
      };
    });
    return { comments, total: numberValue(totalRow, "total") };
  }

  listCommentPosts(commentId: string): CommentPost[] {
    return this.listPostsForComments("comment-post", [commentId]).get(commentId) ?? [];
  }

  private getCommentPost(postId: string): CommentPost | null {
    const row = this.database.prepare("SELECT * FROM comment_posts WHERE id = ?").get(postId) as
      DbRow | undefined;
    return row ? mapCommentPost(row, this.listCodeReferences("comment-post", postId)) : null;
  }

  insertReply(
    commentId: string,
    input: {
      body: string;
      relatedCommitOid?: string | null;
      authorLabel?: string | null;
      references?: CodeReference[];
      idempotencyKey?: string;
      idempotencyRequestHash?: string;
    },
    incrementSequence = true,
  ): CommentPost {
    let result: CommentPost | undefined;
    const write = (): void => {
      const comment = this.getComment(commentId);
      if (!comment) {
        throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
      }
      const pullRequest = this.getPullRequest(comment.pullRequestId);
      if (!pullRequest) throw new RvwError("PR_NOT_FOUND", "Pull Requestが見つかりません。");
      const relatedCommitOid = input.relatedCommitOid ?? null;
      const authorLabel = input.authorLabel ?? null;
      const idempotencyKeyHash =
        input.idempotencyKey === undefined ? null : hashIdempotencyKey(input.idempotencyKey);
      const idempotencyRequestHash =
        idempotencyKeyHash === null
          ? null
          : (input.idempotencyRequestHash ??
            hashIdempotencyKey(
              JSON.stringify({
                operation: "comment.reply",
                commentId,
                body: input.body,
                relatedCommitOid,
                authorLabel,
                references: input.references ?? [],
              }),
            ));
      if (idempotencyKeyHash !== null) {
        const existingRow = this.database
          .prepare("SELECT * FROM comment_reply_idempotency WHERE key_hash = ?")
          .get(idempotencyKeyHash) as DbRow | undefined;
        if (existingRow) {
          if (stringValue(existingRow, "request_hash") !== idempotencyRequestHash) {
            throw new RvwError(
              "IDEMPOTENCY_CONFLICT",
              "同じidempotencyKeyが別のcomment replyに使用されています。",
            );
          }
          const postId = stringValue(existingRow, "post_id");
          const existing = this.getCommentPost(postId);
          if (!existing) {
            throw new RvwError(
              "IDEMPOTENCY_RESULT_DELETED",
              "このidempotencyKeyで作成したcomment replyは既に削除されています。",
              { details: { postId } },
            );
          }
          result = existing;
          return;
        }
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.database
        .prepare(
          "INSERT INTO comment_posts(id, comment_id, body, related_commit_oid, author_label, is_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .run(id, commentId, input.body, relatedCommitOid, authorLabel, now, now);
      this.insertCodeReferences("comment-post", id, input.references ?? []);
      this.insertReviewCommentEvent(
        id,
        comment.ref,
        { kind: "pull-request", pullRequestId: pullRequest.id, pullRequestUrl: pullRequest.url },
        now,
      );
      if (idempotencyKeyHash !== null && idempotencyRequestHash !== null) {
        this.database
          .prepare(
            "INSERT INTO comment_reply_idempotency(key_hash, request_hash, post_id, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(idempotencyKeyHash, idempotencyRequestHash, id, now);
      }
      this.database.prepare("UPDATE comments SET updated_at = ? WHERE id = ?").run(now, commentId);
      if (incrementSequence) {
        this.incrementChangeSequence({ kind: "pull-request", reviewId: comment.pullRequestId });
      }
      result = {
        id,
        commentId,
        body: input.body,
        relatedCommitOid,
        references: input.references ?? [],
        authorLabel,
        isRoot: false,
        createdAt: now,
        updatedAt: now,
      };
    };
    if (incrementSequence) this.immediateTransaction(write);
    else write();
    if (!result) throw new RvwError("DATABASE_ERROR", "返信結果を読み出せません。");
    return result;
  }

  updateCommentPost(
    commentId: string,
    postId: string,
    body: string,
    relatedCommitOid?: string | null,
    references?: CodeReference[],
  ): CommentPost {
    const now = new Date().toISOString();
    const comment = this.getComment(commentId);
    if (!comment) throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
    this.immediateTransaction(() => {
      const result =
        relatedCommitOid === undefined
          ? this.database
              .prepare(
                "UPDATE comment_posts SET body = ?, updated_at = ? WHERE id = ? AND comment_id = ?",
              )
              .run(body, now, postId, commentId)
          : this.database
              .prepare(
                `UPDATE comment_posts SET body = ?, related_commit_oid = ?, updated_at = ?
                WHERE id = ? AND comment_id = ?`,
              )
              .run(body, relatedCommitOid, now, postId, commentId);
      if (Number(result.changes) === 0) {
        throw new RvwError("COMMENT_POST_NOT_FOUND", "コメント投稿が見つかりません。", {
          status: 404,
        });
      }
      if (references !== undefined) {
        this.database.prepare("DELETE FROM comment_post_references WHERE post_id = ?").run(postId);
        this.insertCodeReferences("comment-post", postId, references);
      }
      this.database.prepare("UPDATE comments SET updated_at = ? WHERE id = ?").run(now, commentId);
      this.incrementChangeSequence({ kind: "pull-request", reviewId: comment.pullRequestId });
    });
    const post = this.getCommentPost(postId);
    if (!post) {
      throw new RvwError("COMMENT_POST_NOT_FOUND", "コメント投稿が見つかりません。", {
        status: 404,
      });
    }
    return post;
  }

  deleteReply(commentId: string, postId: string): { commentId: string; postId: string } {
    const comment = this.getComment(commentId);
    if (!comment) {
      throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
    }
    const post = comment.posts.find((candidate) => candidate.id === postId);
    if (!post) {
      throw new RvwError("COMMENT_POST_NOT_FOUND", "コメント投稿が見つかりません。", {
        status: 404,
      });
    }
    if (post.isRoot) {
      throw new RvwError(
        "COMMENT_DELETE_NOT_ALLOWED",
        "最初のコメントは返信として削除できません。スレッドの削除を使用してください。",
        { status: 409 },
      );
    }
    const now = new Date().toISOString();
    this.immediateTransaction(() => {
      this.database
        .prepare("DELETE FROM comment_posts WHERE id = ? AND comment_id = ?")
        .run(postId, commentId);
      this.database.prepare("UPDATE comments SET updated_at = ? WHERE id = ?").run(now, commentId);
      this.incrementChangeSequence({ kind: "pull-request", reviewId: comment.pullRequestId });
    });
    return { commentId, postId };
  }

  setCommentResolved(
    commentId: string,
    resolved: boolean,
    incrementSequence = true,
  ): ReviewComment {
    const now = new Date().toISOString();
    const current = this.getComment(commentId);
    if (!current) throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
    const write = (): void => {
      const result = this.database
        .prepare("UPDATE comments SET resolved_at = ?, updated_at = ? WHERE id = ?")
        .run(resolved ? now : null, now, commentId);
      if (Number(result.changes) === 0)
        throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
      if (incrementSequence) {
        this.incrementChangeSequence({ kind: "pull-request", reviewId: current.pullRequestId });
      }
    };
    if (incrementSequence) this.immediateTransaction(write);
    else write();
    const comment = this.getComment(commentId);
    if (!comment) throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
    return comment;
  }

  deleteComment(commentId: string): { id: string; ref: string } {
    const comment = this.getComment(commentId);
    if (!comment) {
      throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。", { status: 404 });
    }
    this.immediateTransaction(() => {
      this.database.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
      this.incrementChangeSequence({ kind: "pull-request", reviewId: comment.pullRequestId });
    });
    return { id: comment.id, ref: comment.ref };
  }

  applyCommentUpdates(updates: CommentUpdateInput[], relatedCommitOid: string): void {
    for (const update of updates) {
      if (update.reply.trim().length > 0) {
        this.insertReply(
          update.commentId,
          {
            body: update.reply,
            relatedCommitOid,
            references: update.references ?? [],
            authorLabel: update.authorLabel ?? "Agent",
            ...(update.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: update.idempotencyKey }),
            ...(update.idempotencyRequestHash === undefined
              ? {}
              : { idempotencyRequestHash: update.idempotencyRequestHash }),
          },
          false,
        );
      } else if (!this.getComment(update.commentId)) {
        throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
      }
      if (update.resolve) this.setCommentResolved(update.commentId, true, false);
    }
  }

  private mapBranchWalkthrough(row: DbRow): BranchWalkthrough {
    const id = stringValue(row, "id");
    return {
      id,
      ref: formatWalkthroughUri(id),
      branchReviewId: stringValue(row, "branch_review_id"),
      sourceOid: stringValue(row, "source_oid"),
      title: stringValue(row, "title"),
      body: stringValue(row, "body"),
      authorLabel: nullableString(row, "author_label"),
      diagramBindings: stringRecordValue(row, "diagram_bindings_json"),
      references: this.listCodeReferences("branch-walkthrough", id),
      createdAt: stringValue(row, "created_at"),
    };
  }

  getBranchWalkthrough(id: string): BranchWalkthrough | null {
    const row = this.database.prepare("SELECT * FROM branch_walkthroughs WHERE id = ?").get(id) as
      DbRow | undefined;
    return row ? this.mapBranchWalkthrough(row) : null;
  }

  listBranchWalkthroughs(branchReviewId: string): BranchWalkthroughSummary[] {
    return (
      this.database
        .prepare(
          `SELECT w.*,
            (SELECT COUNT(*) FROM branch_walkthrough_references r WHERE r.walkthrough_id = w.id) AS reference_count
           FROM branch_walkthroughs w
           WHERE w.branch_review_id = ?
           ORDER BY w.created_at DESC, w.id DESC`,
        )
        .all(branchReviewId) as DbRow[]
    ).map((row) => ({
      id: stringValue(row, "id"),
      branchReviewId: stringValue(row, "branch_review_id"),
      sourceOid: stringValue(row, "source_oid"),
      title: stringValue(row, "title"),
      authorLabel: nullableString(row, "author_label"),
      referenceCount: numberValue(row, "reference_count"),
      createdAt: stringValue(row, "created_at"),
    }));
  }

  createBranchWalkthrough(
    input: NewBranchWalkthroughInput,
    issues: GitHubIssue[] = [],
  ): { walkthrough: BranchWalkthrough; issuesAdded: IssueDocument[] } {
    const id = randomUUID();
    const issuesAdded = this.immediateTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO branch_walkthroughs(
            id, branch_review_id, source_oid, title, body, author_label, diagram_bindings_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.branchReviewId,
          input.sourceOid,
          input.title,
          input.body,
          input.authorLabel ?? null,
          JSON.stringify(input.diagramBindings),
          new Date().toISOString(),
        );
      this.insertCodeReferences("branch-walkthrough", id, input.references);
      const added = this.writeReviewIssueMemberships("branch", input.branchReviewId, issues);
      this.incrementChangeSequence({ kind: "branch", reviewId: input.branchReviewId });
      return added;
    });
    const walkthrough = this.getBranchWalkthrough(id);
    if (!walkthrough) throw new RvwError("DATABASE_ERROR", "Walkthroughを読み出せません。");
    return { walkthrough, issuesAdded };
  }

  updateBranchWalkthrough(
    id: string,
    input: Omit<NewBranchWalkthroughInput, "branchReviewId">,
    issues: GitHubIssue[] = [],
  ): { walkthrough: BranchWalkthrough; issuesAdded: IssueDocument[] } {
    const issuesAdded = this.immediateTransaction(() => {
      const result = this.database
        .prepare(
          `UPDATE branch_walkthroughs
           SET source_oid = ?, title = ?, body = ?, author_label = ?, diagram_bindings_json = ?
           WHERE id = ?`,
        )
        .run(
          input.sourceOid,
          input.title,
          input.body,
          input.authorLabel ?? null,
          JSON.stringify(input.diagramBindings),
          id,
        );
      if (Number(result.changes) !== 1) {
        throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。", { status: 404 });
      }
      this.database
        .prepare("DELETE FROM branch_walkthrough_references WHERE walkthrough_id = ?")
        .run(id);
      this.insertCodeReferences("branch-walkthrough", id, input.references);
      const walkthrough = this.getBranchWalkthrough(id);
      if (!walkthrough) throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。");
      const added = this.writeReviewIssueMemberships("branch", walkthrough.branchReviewId, issues);
      this.incrementChangeSequence({ kind: "branch", reviewId: walkthrough.branchReviewId });
      return added;
    });
    const walkthrough = this.getBranchWalkthrough(id);
    if (!walkthrough) throw new RvwError("DATABASE_ERROR", "Walkthroughを読み出せません。");
    return { walkthrough, issuesAdded };
  }

  getBranchWalkthroughDeleteCounts(id: string): WalkthroughDeleteCounts {
    const comments = this.database
      .prepare("SELECT count(*) AS count FROM branch_comment_targets WHERE walkthrough_id = ?")
      .get(id) as DbRow;
    const posts = this.database
      .prepare(
        `SELECT count(*) AS count
         FROM branch_comment_posts
         WHERE comment_id IN (
           SELECT comment_id FROM branch_comment_targets WHERE walkthrough_id = ?
         )`,
      )
      .get(id) as DbRow;
    const references = this.database
      .prepare(
        "SELECT count(*) AS count FROM branch_walkthrough_references WHERE walkthrough_id = ?",
      )
      .get(id) as DbRow;
    return {
      comments: numberValue(comments, "count"),
      posts: numberValue(posts, "count"),
      references: numberValue(references, "count"),
    };
  }

  deleteBranchWalkthrough(id: string): DeletedBranchWalkthrough {
    return this.immediateTransaction(() => {
      const walkthrough = this.getBranchWalkthrough(id);
      if (!walkthrough) {
        throw new RvwError("NOT_FOUND", "Walkthroughが見つかりません。", { status: 404 });
      }
      const counts = this.getBranchWalkthroughDeleteCounts(id);
      this.database
        .prepare(
          "DELETE FROM branch_comments WHERE id IN (SELECT comment_id FROM branch_comment_targets WHERE walkthrough_id = ?)",
        )
        .run(id);
      this.database.prepare("DELETE FROM branch_walkthroughs WHERE id = ?").run(id);
      this.incrementChangeSequence({ kind: "branch", reviewId: walkthrough.branchReviewId });
      return {
        id,
        ref: walkthrough.ref,
        branchReviewId: walkthrough.branchReviewId,
        counts,
      };
    });
  }

  private insertBranchCommentTarget(commentId: string, target: BranchCommentTarget): void {
    if (target.kind === "branch") {
      this.database
        .prepare("INSERT INTO branch_comment_targets(comment_id, target_kind) VALUES (?, 'branch')")
        .run(commentId);
      return;
    }
    if (target.kind === "walkthrough") {
      this.database
        .prepare(
          `INSERT INTO branch_comment_targets(
            comment_id, target_kind, walkthrough_id, source_document_hash, quoted_text,
            start_line, end_line
          ) VALUES (?, 'walkthrough', ?, ?, ?, ?, ?)`,
        )
        .run(
          commentId,
          target.walkthroughId,
          target.sourceDocumentHash,
          target.quotedText,
          target.startLine,
          target.endLine,
        );
      return;
    }
    if (target.kind === "issue") {
      this.database
        .prepare(
          `INSERT INTO branch_comment_targets(
            comment_id, target_kind, issue_id, source_document_hash, quoted_text,
            start_line, end_line
          ) VALUES (?, 'issue', ?, ?, ?, ?, ?)`,
        )
        .run(
          commentId,
          target.issueId,
          target.sourceDocumentHash,
          target.quotedText,
          target.startLine,
          target.endLine,
        );
      return;
    }
    this.database
      .prepare(
        `INSERT INTO branch_comment_targets(
          comment_id, target_kind, source_oid, file_path, start_line, end_line
        ) VALUES (?, 'repository_file', ?, ?, ?, ?)`,
      )
      .run(commentId, target.sourceOid, target.path, target.startLine, target.endLine);
  }

  private mapBranchCommentWithoutPosts(row: DbRow): Omit<BranchReviewComment, "posts"> {
    const targetKind = stringValue(row, "target_kind");
    let target: BranchCommentTarget;
    if (targetKind === "branch") {
      target = { kind: "branch" };
    } else if (targetKind === "walkthrough") {
      target = {
        kind: "walkthrough",
        walkthroughId: stringValue(row, "walkthrough_id"),
        walkthroughTitle: stringValue(row, "walkthrough_title"),
        sourceDocumentHash: nullableString(row, "source_document_hash"),
        quotedText: nullableString(row, "quoted_text"),
        startLine: nullableNumber(row, "start_line"),
        endLine: nullableNumber(row, "end_line"),
      };
    } else if (targetKind === "issue") {
      target = {
        kind: "issue",
        issueId: stringValue(row, "issue_id"),
        issueUrl: stringValue(row, "issue_url"),
        issueNumber: numberValue(row, "issue_number"),
        issueTitle: stringValue(row, "issue_title"),
        sourceDocumentHash: stringValue(row, "source_document_hash"),
        quotedText: nullableString(row, "quoted_text"),
        startLine: nullableNumber(row, "start_line"),
        endLine: nullableNumber(row, "end_line"),
      };
    } else {
      target = {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: stringValue(row, "source_oid"),
        path: stringValue(row, "file_path"),
        startLine: nullableNumber(row, "start_line"),
        endLine: nullableNumber(row, "end_line"),
      };
    }
    const id = stringValue(row, "id");
    return {
      id,
      ref: formatCommentUri(id),
      branchReviewId: stringValue(row, "branch_review_id"),
      createdSourceOid: stringValue(row, "created_source_oid"),
      resolvedAt: nullableString(row, "resolved_at"),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
      target,
    };
  }

  private branchCommentSelect(where: string): string {
    return `SELECT c.*, t.target_kind, t.source_oid, t.file_path, t.source_document_hash,
      t.quoted_text, t.walkthrough_id, t.issue_id, t.start_line, t.end_line,
      w.title AS walkthrough_title,
      i.github_url AS issue_url, i.number AS issue_number, i.title AS issue_title
      FROM branch_comments c
      JOIN branch_comment_targets t ON t.comment_id = c.id
      LEFT JOIN branch_walkthroughs w ON w.id = t.walkthrough_id
      LEFT JOIN github_issues i ON i.id = t.issue_id
      ${where}`;
  }

  getBranchComment(id: string): BranchReviewComment | null {
    const row = this.database.prepare(this.branchCommentSelect("WHERE c.id = ?")).get(id) as
      DbRow | undefined;
    if (!row) return null;
    const comment = this.mapBranchCommentWithoutPosts(row);
    return { ...comment, posts: this.listBranchCommentPosts(id) };
  }

  listBranchComments(branchReviewId: string, resolved?: boolean): BranchReviewComment[] {
    const state =
      resolved === undefined
        ? ""
        : resolved
          ? " AND c.resolved_at IS NOT NULL"
          : " AND c.resolved_at IS NULL";
    const rows = this.database
      .prepare(
        `${this.branchCommentSelect(`WHERE c.branch_review_id = ?${state}`)}
           ORDER BY c.updated_at DESC, c.id DESC`,
      )
      .all(branchReviewId) as DbRow[];
    const comments = rows.map((row) => this.mapBranchCommentWithoutPosts(row));
    const postsByComment = this.listPostsForComments(
      "branch-comment-post",
      comments.map((comment) => comment.id),
    );
    return comments.map((comment) => ({
      ...comment,
      posts: postsByComment.get(comment.id) ?? [],
    }));
  }

  listBranchCommentPosts(commentId: string): CommentPost[] {
    return this.listPostsForComments("branch-comment-post", [commentId]).get(commentId) ?? [];
  }

  createBranchComment(input: NewBranchCommentInput): BranchReviewComment {
    const branch = this.getBranchReview(input.branchReviewId);
    if (!branch) throw new RvwError("BRANCH_REVIEW_NOT_FOUND", "Branch Reviewが見つかりません。");
    const id = randomUUID();
    const postId = randomUUID();
    const now = new Date().toISOString();
    this.immediateTransaction(() => {
      this.database
        .prepare(
          `INSERT INTO branch_comments(
            id, branch_review_id, created_source_oid, resolved_at, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, input.branchReviewId, input.createdSourceOid, now, now);
      this.insertBranchCommentTarget(id, input.target);
      this.database
        .prepare(
          `INSERT INTO branch_comment_posts(
            id, comment_id, body, related_commit_oid, author_label, is_root, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          postId,
          id,
          input.body,
          input.relatedCommitOid ?? null,
          input.authorLabel ?? null,
          now,
          now,
        );
      this.insertCodeReferences("branch-comment-post", postId, input.references ?? []);
      this.insertReviewCommentEvent(
        postId,
        formatCommentUri(id),
        { kind: "branch", branchReviewId: branch.id, repository: branch.canonicalName },
        now,
      );
      this.incrementChangeSequence({ kind: "branch", reviewId: input.branchReviewId });
    });
    const comment = this.getBranchComment(id);
    if (!comment) throw new RvwError("DATABASE_ERROR", "保存したコメントを読み出せません。");
    return comment;
  }

  insertBranchReply(
    commentId: string,
    input: {
      body: string;
      relatedCommitOid?: string | null;
      authorLabel?: string | null;
      references?: CodeReference[];
      idempotencyKey?: string;
      idempotencyRequestHash?: string;
    },
  ): CommentPost {
    return this.immediateTransaction(() => {
      const comment = this.getBranchComment(commentId);
      if (!comment) throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
      const branch = this.getBranchReview(comment.branchReviewId);
      if (!branch) throw new RvwError("BRANCH_REVIEW_NOT_FOUND", "Branch Reviewが見つかりません。");
      const keyHash = input.idempotencyKey ? hashIdempotencyKey(input.idempotencyKey) : null;
      const requestHash = keyHash
        ? (input.idempotencyRequestHash ??
          hashIdempotencyKey(
            JSON.stringify({
              operation: "comment.reply",
              commentId,
              body: input.body,
              relatedCommitOid: input.relatedCommitOid ?? null,
              authorLabel: input.authorLabel ?? null,
              references: input.references ?? [],
            }),
          ))
        : null;
      if (keyHash) {
        const existing = this.database
          .prepare("SELECT * FROM branch_comment_reply_idempotency WHERE key_hash = ?")
          .get(keyHash) as DbRow | undefined;
        if (existing) {
          if (stringValue(existing, "request_hash") !== requestHash) {
            throw new RvwError(
              "IDEMPOTENCY_CONFLICT",
              "同じidempotencyKeyが別のcomment replyに使用されています。",
            );
          }
          const postId = stringValue(existing, "post_id");
          const post = this.listBranchCommentPosts(commentId).find(
            (candidate) => candidate.id === postId,
          );
          if (!post) {
            throw new RvwError(
              "IDEMPOTENCY_RESULT_DELETED",
              "このidempotencyKeyで作成したcomment replyは既に削除されています。",
              { details: { postId } },
            );
          }
          return post;
        }
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO branch_comment_posts(
            id, comment_id, body, related_commit_oid, author_label, is_root, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          commentId,
          input.body,
          input.relatedCommitOid ?? null,
          input.authorLabel ?? null,
          now,
          now,
        );
      this.insertCodeReferences("branch-comment-post", id, input.references ?? []);
      this.insertReviewCommentEvent(
        id,
        comment.ref,
        { kind: "branch", branchReviewId: branch.id, repository: branch.canonicalName },
        now,
      );
      if (keyHash && requestHash) {
        this.database
          .prepare(
            `INSERT INTO branch_comment_reply_idempotency(
              key_hash, request_hash, post_id, created_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(keyHash, requestHash, id, now);
      }
      this.database
        .prepare("UPDATE branch_comments SET updated_at = ? WHERE id = ?")
        .run(now, commentId);
      this.incrementChangeSequence({ kind: "branch", reviewId: comment.branchReviewId });
      const post = this.listBranchCommentPosts(commentId).find((candidate) => candidate.id === id);
      if (!post) throw new RvwError("DATABASE_ERROR", "返信を読み出せません。");
      return post;
    });
  }

  updateBranchCommentPost(
    commentId: string,
    postId: string,
    body: string,
    relatedCommitOid?: string | null,
    references?: CodeReference[],
  ): CommentPost {
    const now = new Date().toISOString();
    const comment = this.getBranchComment(commentId);
    if (!comment) throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
    this.immediateTransaction(() => {
      const result =
        relatedCommitOid === undefined
          ? this.database
              .prepare(
                "UPDATE branch_comment_posts SET body = ?, updated_at = ? WHERE id = ? AND comment_id = ?",
              )
              .run(body, now, postId, commentId)
          : this.database
              .prepare(
                `UPDATE branch_comment_posts SET body = ?, related_commit_oid = ?, updated_at = ?
                 WHERE id = ? AND comment_id = ?`,
              )
              .run(body, relatedCommitOid, now, postId, commentId);
      if (Number(result.changes) !== 1) {
        throw new RvwError("COMMENT_POST_NOT_FOUND", "コメント投稿が見つかりません。", {
          status: 404,
        });
      }
      if (references !== undefined) {
        this.database
          .prepare("DELETE FROM branch_comment_post_references WHERE post_id = ?")
          .run(postId);
        this.insertCodeReferences("branch-comment-post", postId, references);
      }
      this.database
        .prepare("UPDATE branch_comments SET updated_at = ? WHERE id = ?")
        .run(now, commentId);
      this.incrementChangeSequence({ kind: "branch", reviewId: comment.branchReviewId });
    });
    const post = this.listBranchCommentPosts(commentId).find(
      (candidate) => candidate.id === postId,
    );
    if (!post) throw new RvwError("COMMENT_POST_NOT_FOUND", "コメント投稿が見つかりません。");
    return post;
  }

  deleteBranchReply(commentId: string, postId: string): { commentId: string; postId: string } {
    const comment = this.getBranchComment(commentId);
    if (!comment) throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
    const post = this.listBranchCommentPosts(commentId).find(
      (candidate) => candidate.id === postId,
    );
    if (!post)
      throw new RvwError("COMMENT_POST_NOT_FOUND", "返信が見つかりません。", { status: 404 });
    if (post.isRoot)
      throw new RvwError("INVALID_INPUT", "root commentは返信として削除できません。");
    this.immediateTransaction(() => {
      this.database
        .prepare("DELETE FROM branch_comment_posts WHERE id = ? AND comment_id = ?")
        .run(postId, commentId);
      this.database
        .prepare("UPDATE branch_comments SET updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), commentId);
      this.incrementChangeSequence({ kind: "branch", reviewId: comment.branchReviewId });
    });
    return { commentId, postId };
  }

  setBranchCommentResolved(commentId: string, resolved: boolean): BranchReviewComment {
    const current = this.getBranchComment(commentId);
    if (!current) throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
    this.immediateTransaction(() => {
      const now = new Date().toISOString();
      const result = this.database
        .prepare("UPDATE branch_comments SET resolved_at = ?, updated_at = ? WHERE id = ?")
        .run(resolved ? now : null, now, commentId);
      if (Number(result.changes) !== 1) {
        throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
      }
      this.incrementChangeSequence({ kind: "branch", reviewId: current.branchReviewId });
    });
    const comment = this.getBranchComment(commentId);
    if (!comment) throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
    return comment;
  }

  deleteBranchComment(commentId: string): { id: string; ref: string } {
    const comment = this.getBranchComment(commentId);
    if (!comment) throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
    this.immediateTransaction(() => {
      this.database.prepare("DELETE FROM branch_comments WHERE id = ?").run(commentId);
      this.incrementChangeSequence({ kind: "branch", reviewId: comment.branchReviewId });
    });
    return { id: comment.id, ref: comment.ref };
  }
}
