import { createHash, randomUUID } from "node:crypto";
import { STRUCTURE_NODE_NOTATIONS } from "../../domain/models.js";
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
  CodeReference,
  CommentPost,
  CommentPostModifier,
  CommentPostEvent,
  CommentTarget,
  DeletedStructure,
  DeletedWalkthrough,
  GitHubPullRequest,
  GitHubPullRequestState,
  PullRequest,
  PullRequestSummary,
  ResetCounts,
  ReviewComment,
  SourceAnchor,
  Structure,
  StructureDeleteCounts,
  StructureEdge,
  StructureNode,
  StructureSummary,
  Walkthrough,
  WalkthroughDeleteCounts,
  WalkthroughReference,
  WalkthroughSummary,
} from "../../domain/models.js";
import { formatCommentUri } from "../../domain/comment-uri.js";
import { formatStructureUri } from "../../domain/structure-uri.js";
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

export interface PullRequestSummaryPage {
  items: PullRequestSummary[];
  total: number;
}

export interface PullRequestGitHubStatusUpdate {
  pullRequestId: string;
  state: GitHubPullRequestState;
  isDraft: boolean;
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

function nullableBoolean(row: DbRow, key: string): boolean | null {
  const value = nullableNumber(row, key);
  if (value === null) return null;
  if (value === 0) return false;
  if (value === 1) return true;
  throw new RvwError("DATABASE_ERROR", `DB列 ${key} が不正です。`);
}

function nullableGitHubPullRequestState(row: DbRow, key: string): GitHubPullRequestState | null {
  const value = nullableString(row, key);
  if (value === null || value === "OPEN" || value === "CLOSED" || value === "MERGED") return value;
  throw new RvwError("DATABASE_ERROR", `DB列 ${key} が不正です。`);
}

function nullableCommentPostModifier(row: DbRow, key: string): CommentPostModifier | null {
  const value = nullableString(row, key);
  if (value === null || value === "human" || value === "agent") return value;
  throw new RvwError("DATABASE_ERROR", `DB列 ${key} が不正です。`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSourceAnchor(value: unknown): value is SourceAnchor {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.startLine === null || typeof value.startLine === "number") &&
    (value.endLine === null || typeof value.endLine === "number")
  );
}

function isStructureNode(value: unknown): value is StructureNode {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    isNullableString(value.description) &&
    isNullableString(value.kind) &&
    (value.notation === undefined ||
      STRUCTURE_NODE_NOTATIONS.some((notation) => notation === value.notation)) &&
    (value.anchor === null || isSourceAnchor(value.anchor))
  );
}

function isStructureEdge(value: unknown): value is StructureEdge {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.from === "string" &&
    typeof value.to === "string" &&
    typeof value.label === "string" &&
    typeof value.directed === "boolean" &&
    Array.isArray(value.anchors) &&
    value.anchors.every(isSourceAnchor)
  );
}

function structureGraphValue(row: DbRow): Pick<Structure, "originNodeId" | "nodes" | "edges"> {
  try {
    const value: unknown = JSON.parse(stringValue(row, "graph_json"));
    const originNodeId =
      isRecord(value) && typeof value.originNodeId === "string" ? value.originNodeId : null;
    if (
      !isRecord(value) ||
      originNodeId === null ||
      !Array.isArray(value.nodes) ||
      !value.nodes.every(isStructureNode) ||
      !Array.isArray(value.edges) ||
      !value.edges.every(isStructureEdge)
    ) {
      throw new Error("invalid Structure graph");
    }
    return {
      originNodeId,
      nodes: value.nodes.map((node) => ({ ...node, notation: node.notation ?? "plain" })),
      edges: value.edges,
    };
  } catch (error) {
    throw new RvwError("DATABASE_ERROR", "Structure graph_jsonが不正です。", { cause: error });
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
    githubCreatedAt: nullableString(row, "github_created_at"),
    githubUpdatedAt: stringValue(row, "github_updated_at"),
    githubState: nullableGitHubPullRequestState(row, "github_state"),
    githubIsDraft: nullableBoolean(row, "github_is_draft"),
    fetchedAt: stringValue(row, "fetched_at"),
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
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
    lastModifiedBy: nullableCommentPostModifier(row, "last_modified_by"),
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
  lastModifiedBy?: CommentPostModifier;
}

export interface CommentUpdateInput {
  commentId: string;
  reply: string;
  resolve: boolean;
  authorLabel?: string | null;
  lastModifiedBy?: CommentPostModifier;
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

export interface NewStructureInput {
  pullRequestId: string;
  sourceOid: string;
  title: string;
  scope: string;
  originNodeId: string;
  nodes: StructureNode[];
  edges: StructureEdge[];
  idempotencyKey: string;
  idempotencyRequestHash: string;
}

export interface DomainRevisions {
  pullRequests: number;
  pullRequestContent: number;
  comments: number;
  walkthroughs: number;
  structures: number;
}

type DomainRevision = keyof DomainRevisions;

const domainRevisionMetaKeys: Record<DomainRevision, string> = {
  pullRequests: "revision_pull_requests",
  pullRequestContent: "revision_pull_request_content",
  comments: "revision_comments",
  walkthroughs: "revision_walkthroughs",
  structures: "revision_structures",
};

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

  incrementChangeSequence(): number {
    this.database
      .prepare(
        "UPDATE app_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'change_sequence'",
      )
      .run();
    return this.getChangeSequence();
  }

  incrementDomainRevisions(domains: readonly DomainRevision[]): number {
    const uniqueDomains = [...new Set(domains)];
    this.incrementChangeSequence();
    const increment = this.database.prepare(
      "UPDATE app_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ?",
    );
    for (const domain of uniqueDomains) increment.run(domainRevisionMetaKeys[domain]);
    return this.getChangeSequence();
  }

  getChangeSequence(): number {
    const row = this.database
      .prepare("SELECT value FROM app_meta WHERE key = 'change_sequence'")
      .get() as DbRow;
    return Number(stringValue(row, "value"));
  }

  getDomainRevisions(): DomainRevisions {
    const revisions = {} as DomainRevisions;
    for (const [domain, key] of Object.entries(domainRevisionMetaKeys) as [
      DomainRevision,
      string,
    ][]) {
      const row = this.database.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
        DbRow | undefined;
      if (!row) throw new RvwError("DATABASE_ERROR", `domain revisionがありません: ${domain}`);
      revisions[domain] = Number(stringValue(row, "value"));
    }
    return revisions;
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
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM comment_post_events")
      .get() as DbRow;
    return numberValue(row, "sequence");
  }

  listCommentPostEvents(afterSequence: number, limit: number): CommentPostEvent[] {
    const rows = this.database
      .prepare(
        `SELECT e.*, CASE WHEN p.id IS NULL THEN 1 ELSE 0 END AS deleted
        FROM comment_post_events e
        LEFT JOIN comment_posts p ON p.id = e.post_id
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
      pullRequestUrl: stringValue(row, "pull_request_url"),
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

  listPullRequestsNeedingStatusRefresh(): PullRequest[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM pull_requests WHERE github_state = 'OPEN' OR github_state IS NULL ORDER BY updated_at DESC",
        )
        .all() as DbRow[]
    ).map(mapPullRequest);
  }

  listPullRequestSummaries(
    offset: number,
    limit: number,
    hideClosedOrMerged = true,
  ): PullRequestSummaryPage {
    const hideClosedOrMergedValue = hideClosedOrMerged ? 1 : 0;
    const rows = this.database
      .prepare(
        `WITH page AS (
           SELECT
             id,
             owner,
             repository,
             number,
             latest_title,
             github_created_at,
             github_updated_at,
             github_state,
             github_is_draft
           FROM pull_requests
           WHERE ? = 0 OR github_state IS NULL OR github_state = 'OPEN'
           ORDER BY github_updated_at DESC, id DESC
           LIMIT ? OFFSET ?
         ), comment_counts AS (
           SELECT
             comments.pull_request_id,
             SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS unresolved_count,
             SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved_count
           FROM comments
           JOIN page ON page.id = comments.pull_request_id
           GROUP BY comments.pull_request_id
         ), walkthrough_counts AS (
           SELECT walkthroughs.pull_request_id, COUNT(*) AS walkthrough_count
           FROM walkthroughs
           JOIN page ON page.id = walkthroughs.pull_request_id
           GROUP BY walkthroughs.pull_request_id
         ), structure_counts AS (
           SELECT structures.pull_request_id, COUNT(*) AS structure_count
           FROM structures
           JOIN page ON page.id = structures.pull_request_id
           GROUP BY structures.pull_request_id
         )
         SELECT
           pr.id AS pull_request_id,
           pr.owner,
           pr.repository,
           pr.number,
           pr.latest_title,
           pr.github_created_at,
           pr.github_updated_at,
           pr.github_state,
           pr.github_is_draft,
           COALESCE(comment_counts.unresolved_count, 0) AS unresolved_comment_count,
           COALESCE(comment_counts.resolved_count, 0) AS resolved_comment_count,
           COALESCE(walkthrough_counts.walkthrough_count, 0) AS walkthrough_count,
           COALESCE(structure_counts.structure_count, 0) AS structure_count
         FROM page AS pr
         LEFT JOIN comment_counts ON comment_counts.pull_request_id = pr.id
         LEFT JOIN walkthrough_counts ON walkthrough_counts.pull_request_id = pr.id
         LEFT JOIN structure_counts ON structure_counts.pull_request_id = pr.id
         ORDER BY pr.github_updated_at DESC, pr.id DESC`,
      )
      .all(hideClosedOrMergedValue, limit, offset) as DbRow[];
    const totalRow = this.database
      .prepare(
        "SELECT COUNT(*) AS total FROM pull_requests WHERE ? = 0 OR github_state IS NULL OR github_state = 'OPEN'",
      )
      .get(hideClosedOrMergedValue) as DbRow | undefined;
    if (!totalRow) throw new RvwError("DATABASE_ERROR", "Pull Request件数を取得できません。");
    return {
      items: rows.map((row) => ({
        pullRequestId: stringValue(row, "pull_request_id"),
        owner: stringValue(row, "owner"),
        repository: stringValue(row, "repository"),
        number: numberValue(row, "number"),
        title: stringValue(row, "latest_title"),
        githubCreatedAt: nullableString(row, "github_created_at"),
        githubUpdatedAt: stringValue(row, "github_updated_at"),
        githubState: nullableGitHubPullRequestState(row, "github_state"),
        githubIsDraft: nullableBoolean(row, "github_is_draft"),
        unresolvedCommentCount: numberValue(row, "unresolved_comment_count"),
        resolvedCommentCount: numberValue(row, "resolved_comment_count"),
        walkthroughCount: numberValue(row, "walkthrough_count"),
        structureCount: numberValue(row, "structure_count"),
      })),
      total: numberValue(totalRow, "total"),
    };
  }

  updatePullRequestGitHubStatuses(updates: PullRequestGitHubStatusUpdate[]): void {
    if (updates.length === 0) return;
    this.immediateTransaction(() => {
      const statement = this.database.prepare(
        "UPDATE pull_requests SET github_state = ?, github_is_draft = ? WHERE id = ?",
      );
      let changed = false;
      for (const update of updates) {
        const current = this.getPullRequest(update.pullRequestId);
        if (!current) {
          throw new RvwError(
            "PR_NOT_FOUND",
            `Pull Requestが見つかりません: ${update.pullRequestId}`,
            { status: 404 },
          );
        }
        if (current.githubState === update.state && current.githubIsDraft === update.isDraft) {
          continue;
        }
        const result = statement.run(update.state, update.isDraft ? 1 : 0, update.pullRequestId);
        if (Number(result.changes) !== 1) {
          throw new RvwError(
            "PR_NOT_FOUND",
            `Pull Requestが見つかりません: ${update.pullRequestId}`,
            { status: 404 },
          );
        }
        changed = true;
      }
      if (changed) this.incrementDomainRevisions(["pullRequests"]);
    });
  }

  updateRepositoryLocation(
    id: string,
    repository: { localRepositoryPath: string; gitCommonDir: string },
  ): PullRequest {
    const existing = this.getPullRequest(id);
    if (!existing) throw new RvwError("PR_NOT_FOUND", "Pull Requestが見つかりません。");
    if (
      existing.localRepositoryPath === repository.localRepositoryPath &&
      existing.gitCommonDir === repository.gitCommonDir
    ) {
      return existing;
    }
    this.immediateTransaction(() => {
      const result = this.database
        .prepare(
          "UPDATE pull_requests SET local_repository_path = ?, git_common_dir = ?, updated_at = ? WHERE id = ?",
        )
        .run(repository.localRepositoryPath, repository.gitCommonDir, new Date().toISOString(), id);
      if (Number(result.changes) === 0)
        throw new RvwError("PR_NOT_FOUND", "Pull Requestが見つかりません。");
      this.incrementDomainRevisions(["pullRequests"]);
    });
    const pullRequest = this.getPullRequest(id);
    if (!pullRequest) throw new RvwError("PR_NOT_FOUND", "Pull Requestが見つかりません。");
    return pullRequest;
  }

  private writePullRequest(
    github: GitHubPullRequest,
    repository: { localRepositoryPath: string; gitCommonDir: string },
    comparisonBaseOid: string,
  ): { id: string; semanticChanged: boolean; contentChanged: boolean } {
    const now = new Date().toISOString();
    const existing = this.findPullRequestByIdentity(github.owner, github.repository, github.number);
    const id = existing?.id ?? randomUUID();
    const contentChanged =
      !existing || existing.latestTitle !== github.title || existing.latestBody !== github.body;
    const semanticChanged =
      !existing ||
      existing.url !== github.url ||
      existing.latestAuthorLogin !== github.authorLogin ||
      existing.latestHeadRepositoryOwner !== github.headRepositoryOwner ||
      existing.latestHeadRepositoryName !== github.headRepositoryName ||
      existing.localRepositoryPath !== repository.localRepositoryPath ||
      existing.gitCommonDir !== repository.gitCommonDir ||
      contentChanged ||
      existing.latestBaseRefName !== github.baseRefName ||
      existing.latestHeadRefName !== github.headRefName ||
      existing.latestBaseOid !== github.baseOid ||
      existing.latestComparisonBaseOid !== comparisonBaseOid ||
      existing.latestHeadOid !== github.headOid ||
      existing.githubCreatedAt !== github.createdAt ||
      existing.githubUpdatedAt !== github.updatedAt ||
      existing.githubState !== github.state ||
      existing.githubIsDraft !== github.isDraft;
    this.database
      .prepare(
        `INSERT INTO pull_requests(
          id, host, owner, repository, number, github_url,
          local_repository_path, git_common_dir,
          latest_author_login, latest_head_repository_owner, latest_head_repository_name,
          latest_title, latest_body, latest_base_ref_name, latest_head_ref_name,
          latest_base_oid, latest_head_oid, github_created_at, github_updated_at,
          github_state, github_is_draft, fetched_at,
          created_at, updated_at, latest_comparison_base_oid
        ) VALUES (?, 'github.com', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          github_created_at = excluded.github_created_at,
          github_updated_at = excluded.github_updated_at,
          github_state = excluded.github_state,
          github_is_draft = excluded.github_is_draft,
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
        github.createdAt,
        github.updatedAt,
        github.state,
        github.isDraft ? 1 : 0,
        now,
        existing?.createdAt ?? now,
        semanticChanged ? now : existing.updatedAt,
        comparisonBaseOid,
      );
    return { id, semanticChanged, contentChanged };
  }

  upsertPullRequest(
    github: GitHubPullRequest,
    repository: { localRepositoryPath: string; gitCommonDir: string },
    comparisonBaseOid: string,
  ): PullRequest {
    const id = this.immediateTransaction(() => {
      const write = this.writePullRequest(github, repository, comparisonBaseOid);
      const domains: DomainRevision[] = [];
      if (write.semanticChanged) domains.push("pullRequests");
      if (write.contentChanged) domains.push("pullRequestContent");
      if (domains.length > 0) this.incrementDomainRevisions(domains);
      return write.id;
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
      const write = this.writePullRequest(github, repository, comparisonBaseOid);
      this.applyCommentUpdates(updates, github.headOid);
      const domains: DomainRevision[] = [];
      if (write.semanticChanged) domains.push("pullRequests");
      if (write.contentChanged) domains.push("pullRequestContent");
      if (updates.some((update) => update.resolve || update.reply.trim().length > 0)) {
        domains.push("comments");
      }
      if (domains.length > 0) this.incrementDomainRevisions(domains);
      return write.id;
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
      const write = this.writePullRequest(github, repository, comparisonBaseOid);
      this.deletePullRequestHistory(write.id);
      this.incrementDomainRevisions([
        "pullRequests",
        "pullRequestContent",
        "comments",
        "walkthroughs",
        "structures",
      ]);
      return write.id;
    });
    const pullRequest = this.getPullRequest(id);
    if (!pullRequest)
      throw new RvwError("DATABASE_ERROR", "再構築したPull Requestを読み出せません。");
    return pullRequest;
  }

  getResetCounts(pullRequestId: string, gitRefs: number): ResetCounts {
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
    const structures = this.database
      .prepare("SELECT count(*) AS count FROM structures WHERE pull_request_id = ?")
      .get(pullRequestId) as DbRow;
    return {
      comments: numberValue(comments, "count"),
      posts: numberValue(posts, "count"),
      commentReferences: numberValue(commentReferences, "count"),
      targets: numberValue(targets, "count"),
      walkthroughs: numberValue(walkthroughs, "count"),
      walkthroughReferences: numberValue(walkthroughReferences, "count"),
      structures: numberValue(structures, "count"),
      gitRefs,
    };
  }

  deletePullRequestHistory(pullRequestId: string): void {
    this.database.prepare("DELETE FROM comments WHERE pull_request_id = ?").run(pullRequestId);
    this.database.prepare("DELETE FROM walkthroughs WHERE pull_request_id = ?").run(pullRequestId);
    this.database
      .prepare(
        `DELETE FROM structure_publish_idempotency
         WHERE structure_id IN (SELECT id FROM structures WHERE pull_request_id = ?)`,
      )
      .run(pullRequestId);
    this.database.prepare("DELETE FROM structures WHERE pull_request_id = ?").run(pullRequestId);
  }

  private mapStructure(row: DbRow): Structure {
    const id = stringValue(row, "id");
    return {
      id,
      ref: formatStructureUri(id),
      pullRequestId: stringValue(row, "pull_request_id"),
      sourceOid: stringValue(row, "source_oid"),
      title: stringValue(row, "title"),
      scope: stringValue(row, "scope"),
      ...structureGraphValue(row),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
    };
  }

  getStructure(id: string): Structure | null {
    const row = this.database.prepare("SELECT * FROM structures WHERE id = ?").get(id) as
      DbRow | undefined;
    return row ? this.mapStructure(row) : null;
  }

  listStructures(pullRequestId: string): StructureSummary[] {
    return (
      this.database
        .prepare(
          `SELECT id, pull_request_id, source_oid, title, scope, created_at, updated_at
           FROM structures
           WHERE pull_request_id = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(pullRequestId) as DbRow[]
    ).map((row) => ({
      id: stringValue(row, "id"),
      ref: formatStructureUri(stringValue(row, "id")),
      pullRequestId: stringValue(row, "pull_request_id"),
      sourceOid: stringValue(row, "source_oid"),
      title: stringValue(row, "title"),
      scope: stringValue(row, "scope"),
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
    }));
  }

  createStructure(input: NewStructureInput): Structure {
    let structureId: string | undefined;
    const graphJson = JSON.stringify({
      originNodeId: input.originNodeId,
      nodes: input.nodes,
      edges: input.edges,
    });
    this.immediateTransaction(() => {
      const keyHash = hashIdempotencyKey(input.idempotencyKey);
      const existingRow = this.database
        .prepare("SELECT * FROM structure_publish_idempotency WHERE key_hash = ?")
        .get(keyHash) as DbRow | undefined;
      if (existingRow) {
        if (stringValue(existingRow, "request_hash") !== input.idempotencyRequestHash) {
          throw new RvwError(
            "IDEMPOTENCY_CONFLICT",
            "同じidempotencyKeyが別のStructure publishに使用されています。",
          );
        }
        const existingId = stringValue(existingRow, "structure_id");
        if (!this.getStructure(existingId)) {
          throw new RvwError(
            "IDEMPOTENCY_RESULT_DELETED",
            "このidempotencyKeyで作成したStructureは既に削除されています。",
            { details: { structureId: existingId } },
          );
        }
        structureId = existingId;
        return;
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO structures(
             id, pull_request_id, source_oid, title, scope, graph_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.pullRequestId,
          input.sourceOid,
          input.title,
          input.scope,
          graphJson,
          now,
          now,
        );
      this.database
        .prepare(
          `INSERT INTO structure_publish_idempotency(
             key_hash, request_hash, structure_id, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(keyHash, input.idempotencyRequestHash, id, now);
      this.incrementDomainRevisions(["structures"]);
      structureId = id;
    });
    if (!structureId) {
      throw new RvwError("DATABASE_ERROR", "保存したStructure IDを確定できません。");
    }
    const structure = this.getStructure(structureId);
    if (!structure) throw new RvwError("DATABASE_ERROR", "保存したStructureを読み出せません。");
    return structure;
  }

  updateStructure(
    id: string,
    expectedUpdatedAt: string,
    input: Omit<NewStructureInput, "pullRequestId" | "idempotencyKey" | "idempotencyRequestHash">,
  ): Structure {
    const currentUpdatedAt = Date.parse(expectedUpdatedAt);
    const observedNow = Date.now();
    const now = new Date(
      Number.isNaN(currentUpdatedAt) ? observedNow : Math.max(observedNow, currentUpdatedAt + 1),
    ).toISOString();
    const graphJson = JSON.stringify({
      originNodeId: input.originNodeId,
      nodes: input.nodes,
      edges: input.edges,
    });
    this.immediateTransaction(() => {
      const current = this.getStructure(id);
      if (!current) {
        throw new RvwError("NOT_FOUND", "Structureが見つかりません。", { status: 404 });
      }
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new RvwError(
          "STRUCTURE_CONFLICT",
          "Structureが取得後に更新されています。現在値を読み直してください。",
          {
            status: 409,
            details: { expectedUpdatedAt, currentUpdatedAt: current.updatedAt },
          },
        );
      }
      const retiredNodeIds = new Set(
        (
          this.database
            .prepare("SELECT node_id FROM structure_retired_node_ids WHERE structure_id = ?")
            .all(id) as DbRow[]
        ).map((row) => stringValue(row, "node_id")),
      );
      const retiredEdgeIds = new Set(
        (
          this.database
            .prepare("SELECT edge_id FROM structure_retired_edge_ids WHERE structure_id = ?")
            .all(id) as DbRow[]
        ).map((row) => stringValue(row, "edge_id")),
      );
      const reusedNode = input.nodes.find((node) => retiredNodeIds.has(node.id));
      if (reusedNode) {
        throw new RvwError(
          "INVALID_INPUT",
          `削除済みのStructure Node IDは再利用できません: ${reusedNode.id}`,
        );
      }
      const reusedEdge = input.edges.find((edge) => retiredEdgeIds.has(edge.id));
      if (reusedEdge) {
        throw new RvwError(
          "INVALID_INPUT",
          `削除済みのStructure Edge IDは再利用できません: ${reusedEdge.id}`,
        );
      }
      const nextNodeIds = new Set(input.nodes.map((node) => node.id));
      const nextEdgeIds = new Set(input.edges.map((edge) => edge.id));
      const retiredAtThisUpdate = current.nodes
        .map((node) => node.id)
        .filter((nodeId) => !nextNodeIds.has(nodeId));
      const retiredEdgesAtThisUpdate = current.edges
        .map((edge) => edge.id)
        .filter((edgeId) => !nextEdgeIds.has(edgeId));
      const result = this.database
        .prepare(
          `UPDATE structures
           SET source_oid = ?, title = ?, scope = ?, graph_json = ?, updated_at = ?
           WHERE id = ? AND updated_at = ?`,
        )
        .run(input.sourceOid, input.title, input.scope, graphJson, now, id, expectedUpdatedAt);
      if (Number(result.changes) === 0) {
        throw new RvwError(
          "STRUCTURE_CONFLICT",
          "Structureが取得後に更新されています。現在値を読み直してください。",
          {
            status: 409,
            details: { expectedUpdatedAt, currentUpdatedAt: current.updatedAt },
          },
        );
      }
      const retireNode = this.database.prepare(
        "INSERT OR IGNORE INTO structure_retired_node_ids(structure_id, node_id, retired_at) VALUES (?, ?, ?)",
      );
      for (const nodeId of retiredAtThisUpdate) retireNode.run(id, nodeId, now);
      const retireEdge = this.database.prepare(
        "INSERT OR IGNORE INTO structure_retired_edge_ids(structure_id, edge_id, retired_at) VALUES (?, ?, ?)",
      );
      for (const edgeId of retiredEdgesAtThisUpdate) retireEdge.run(id, edgeId, now);
      this.incrementDomainRevisions(["structures"]);
    });
    const structure = this.getStructure(id);
    if (!structure) throw new RvwError("DATABASE_ERROR", "更新したStructureを読み出せません。");
    return structure;
  }

  getStructureDeleteCounts(id: string): StructureDeleteCounts {
    const structure = this.getStructure(id);
    if (!structure) throw new RvwError("NOT_FOUND", "Structureが見つかりません。", { status: 404 });
    return {
      nodes: structure.nodes.length,
      edges: structure.edges.length,
      anchors:
        structure.nodes.filter((node) => node.anchor !== null).length +
        structure.edges.reduce((count, edge) => count + edge.anchors.length, 0),
    };
  }

  deleteStructure(id: string, expectedUpdatedAt: string): DeletedStructure {
    return this.immediateTransaction(() => {
      const structure = this.getStructure(id);
      if (!structure) {
        throw new RvwError("NOT_FOUND", "Structureが見つかりません。", { status: 404 });
      }
      if (structure.updatedAt !== expectedUpdatedAt) {
        throw new RvwError(
          "STRUCTURE_CONFLICT",
          "Structureがpreview後に更新されています。現在値を読み直してください。",
          {
            status: 409,
            details: { expectedUpdatedAt, currentUpdatedAt: structure.updatedAt },
          },
        );
      }
      const counts = this.getStructureDeleteCounts(id);
      const result = this.database
        .prepare("DELETE FROM structures WHERE id = ? AND updated_at = ?")
        .run(id, expectedUpdatedAt);
      if (Number(result.changes) === 0) {
        throw new RvwError(
          "STRUCTURE_CONFLICT",
          "Structureがpreview後に更新されています。現在値を読み直してください。",
          { status: 409, details: { expectedUpdatedAt } },
        );
      }
      this.incrementDomainRevisions(["structures"]);
      return {
        id: structure.id,
        ref: structure.ref,
        pullRequestId: structure.pullRequestId,
        counts,
      };
    });
  }

  private codeReferenceStorage(kind: "comment-post" | "walkthrough"): {
    table: "comment_post_references" | "walkthrough_references";
    ownerColumn: "post_id" | "walkthrough_id";
  } {
    return kind === "comment-post"
      ? { table: "comment_post_references", ownerColumn: "post_id" }
      : { table: "walkthrough_references", ownerColumn: "walkthrough_id" };
  }

  private listCodeReferences(
    kind: "comment-post" | "walkthrough",
    ownerId: string,
  ): CodeReference[] {
    const { table, ownerColumn } = this.codeReferenceStorage(kind);
    return (
      this.database
        .prepare(`SELECT * FROM ${table} WHERE ${ownerColumn} = ? ORDER BY sort_order ASC`)
        .all(ownerId) as DbRow[]
    ).map(mapCodeReference);
  }

  private insertCodeReferences(
    kind: "comment-post" | "walkthrough",
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

  createWalkthrough(input: NewWalkthroughInput): Walkthrough {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.immediateTransaction(() => {
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
      this.incrementDomainRevisions(["walkthroughs"]);
    });
    const walkthrough = this.getWalkthrough(id);
    if (!walkthrough) {
      throw new RvwError("DATABASE_ERROR", "保存したwalkthroughを読み出せません。");
    }
    return walkthrough;
  }

  updateWalkthrough(id: string, input: Omit<NewWalkthroughInput, "pullRequestId">): Walkthrough {
    this.immediateTransaction(() => {
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
      this.incrementDomainRevisions(["walkthroughs"]);
    });
    const walkthrough = this.getWalkthrough(id);
    if (!walkthrough) {
      throw new RvwError("DATABASE_ERROR", "更新したwalkthroughを読み出せません。");
    }
    return walkthrough;
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
      this.incrementDomainRevisions(
        counts.comments === 0 ? ["walkthroughs"] : ["walkthroughs", "comments"],
      );
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
          "INSERT INTO comment_posts(id, comment_id, body, related_commit_oid, author_label, last_modified_by, is_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
        )
        .run(
          postId,
          id,
          input.body,
          input.relatedCommitOid ?? null,
          input.authorLabel ?? null,
          input.lastModifiedBy ?? null,
          now,
          now,
        );
      this.insertCodeReferences("comment-post", postId, input.references ?? []);
      this.database
        .prepare(
          `INSERT INTO comment_post_events(
            post_id, comment_ref, pull_request_url, created_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(postId, formatCommentUri(id), pullRequest.url, now);
      this.incrementDomainRevisions(["comments"]);
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
    if (targetKind === "pull_request") {
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
          t.source_document_hash, t.quoted_text, t.walkthrough_id, t.start_line, t.end_line,
          w.title AS walkthrough_title
        FROM comments c
        JOIN comment_targets t ON t.comment_id = c.id
        LEFT JOIN walkthroughs w ON w.id = t.walkthrough_id
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
    return (
      this.database
        .prepare(
          `SELECT c.*, t.target_kind, t.document_kind, t.source_oid, t.file_path,
            t.source_document_hash, t.quoted_text, t.walkthrough_id, t.start_line, t.end_line,
            w.title AS walkthrough_title
          FROM comments c
          JOIN comment_targets t ON t.comment_id = c.id
          LEFT JOIN walkthroughs w ON w.id = t.walkthrough_id
          WHERE c.pull_request_id = ?${where} ORDER BY c.updated_at DESC`,
        )
        .all(pullRequestId) as DbRow[]
    ).map((row) => this.mapComment(row));
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
            t.source_document_hash, t.quoted_text, t.walkthrough_id, t.start_line, t.end_line,
            w.title AS walkthrough_title,
            root.id AS root_id, root.body AS root_body,
            root.related_commit_oid AS root_related_commit_oid,
            root.author_label AS root_author_label,
            root.last_modified_by AS root_last_modified_by, root.created_at AS root_created_at,
            root.updated_at AS root_updated_at,
            (SELECT COUNT(*) FROM comment_posts p WHERE p.comment_id = c.id) AS post_count
          FROM comments c
          JOIN comment_targets t ON t.comment_id = c.id
          JOIN comment_posts root ON root.comment_id = c.id AND root.is_root = 1
          LEFT JOIN walkthroughs w ON w.id = t.walkthrough_id
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
          lastModifiedBy: nullableCommentPostModifier(row, "root_last_modified_by"),
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
    return (
      this.database
        .prepare(
          "SELECT * FROM comment_posts WHERE comment_id = ? ORDER BY is_root DESC, created_at ASC, id ASC",
        )
        .all(commentId) as DbRow[]
    ).map((row) => {
      const postId = stringValue(row, "id");
      return mapCommentPost(row, this.listCodeReferences("comment-post", postId));
    });
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
      lastModifiedBy?: CommentPostModifier;
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
          "INSERT INTO comment_posts(id, comment_id, body, related_commit_oid, author_label, last_modified_by, is_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
        )
        .run(
          id,
          commentId,
          input.body,
          relatedCommitOid,
          authorLabel,
          input.lastModifiedBy ?? null,
          now,
          now,
        );
      this.insertCodeReferences("comment-post", id, input.references ?? []);
      this.database
        .prepare(
          `INSERT INTO comment_post_events(
            post_id, comment_ref, pull_request_url, created_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(id, comment.ref, pullRequest.url, now);
      if (idempotencyKeyHash !== null && idempotencyRequestHash !== null) {
        this.database
          .prepare(
            "INSERT INTO comment_reply_idempotency(key_hash, request_hash, post_id, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(idempotencyKeyHash, idempotencyRequestHash, id, now);
      }
      this.database.prepare("UPDATE comments SET updated_at = ? WHERE id = ?").run(now, commentId);
      if (incrementSequence) this.incrementDomainRevisions(["comments"]);
      result = {
        id,
        commentId,
        body: input.body,
        relatedCommitOid,
        references: input.references ?? [],
        authorLabel,
        lastModifiedBy: input.lastModifiedBy ?? null,
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
    relatedCommitOid: string | null,
    references: CodeReference[],
    lastModifiedBy: CommentPostModifier | null,
  ): CommentPost {
    const now = new Date().toISOString();
    this.immediateTransaction(() => {
      const result = this.database
        .prepare(
          `UPDATE comment_posts
           SET body = ?, related_commit_oid = ?, last_modified_by = ?, updated_at = ?
           WHERE id = ? AND comment_id = ?`,
        )
        .run(body, relatedCommitOid, lastModifiedBy, now, postId, commentId);
      if (Number(result.changes) === 0) {
        throw new RvwError("COMMENT_POST_NOT_FOUND", "コメント投稿が見つかりません。", {
          status: 404,
        });
      }
      this.database.prepare("DELETE FROM comment_post_references WHERE post_id = ?").run(postId);
      this.insertCodeReferences("comment-post", postId, references);
      this.database.prepare("UPDATE comments SET updated_at = ? WHERE id = ?").run(now, commentId);
      this.incrementDomainRevisions(["comments"]);
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
      this.incrementDomainRevisions(["comments"]);
    });
    return { commentId, postId };
  }

  setCommentResolved(
    commentId: string,
    resolved: boolean,
    incrementSequence = true,
  ): ReviewComment {
    const now = new Date().toISOString();
    const write = (): void => {
      const result = this.database
        .prepare("UPDATE comments SET resolved_at = ?, updated_at = ? WHERE id = ?")
        .run(resolved ? now : null, now, commentId);
      if (Number(result.changes) === 0)
        throw new RvwError("COMMENT_NOT_FOUND", "コメントが見つかりません。");
      if (incrementSequence) this.incrementDomainRevisions(["comments"]);
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
      this.incrementDomainRevisions(["comments"]);
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
            lastModifiedBy: update.lastModifiedBy ?? "agent",
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
}
