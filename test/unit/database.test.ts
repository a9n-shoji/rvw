import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";

function openDatabaseInChildProcess(
  filePath: string,
  migrationsDirectory: string,
  startAt: number,
): Promise<void> {
  const databaseModuleUrl = pathToFileURL(path.resolve("src/infrastructure/db/database.ts")).href;
  const script = `
    import { RvwDatabase } from ${JSON.stringify(databaseModuleUrl)};
    const [filePath, migrationsDirectory, rawStartAt] = process.argv.slice(1);
    const delay = Math.max(0, Number(rawStartAt) - Date.now());
    await new Promise((resolve) => setTimeout(resolve, delay));
    const database = new RvwDatabase({ filePath, migrationsDirectory });
    database.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
        filePath,
        migrationsDirectory,
        String(startAt),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child database open failed (${String(code)}): ${stderr}`));
    });
  });
}

const github = {
  host: "github.com" as const,
  owner: "acme",
  repository: "review-repo",
  number: 7,
  url: "https://github.com/acme/review-repo/pull/7",
  authorLogin: "review-author",
  headRepositoryOwner: "acme",
  headRepositoryName: "review-repo",
  title: "Review me",
  body: "Body",
  baseRefName: "main",
  baseOid: "a".repeat(40),
  headRefName: "feature",
  headOid: "b".repeat(40),
  updatedAt: "2026-08-08T00:00:00.000Z",
  state: "OPEN" as const,
  isDraft: false,
};

describe("RvwDatabase", () => {
  it("serializes the same pending migration across concurrent processes", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-concurrent-migration-"));
    const migrationsDirectory = path.join(directory, "migrations");
    const filePath = path.join(directory, "rvw.db");
    mkdirSync(migrationsDirectory);
    writeFileSync(
      path.join(migrationsDirectory, "001_initial.sql"),
      `CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );`,
    );
    const initial = new RvwDatabase({ filePath, migrationsDirectory });
    initial.close();
    writeFileSync(
      path.join(migrationsDirectory, "002_concurrent.sql"),
      `CREATE TABLE migration_payload (value INTEGER PRIMARY KEY);
        WITH RECURSIVE sequence(value) AS (
          VALUES(1)
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 100000
        )
        INSERT INTO migration_payload(value) SELECT value FROM sequence;`,
    );

    const startAt = Date.now() + 500;
    await Promise.all([
      openDatabaseInChildProcess(filePath, migrationsDirectory, startAt),
      openDatabaseInChildProcess(filePath, migrationsDirectory, startAt),
    ]);

    const verified = new DatabaseSync(filePath);
    expect(
      verified.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 2").get(),
    ).toEqual({ count: 1 });
    expect(verified.prepare("SELECT count(*) AS count FROM migration_payload").get()).toEqual({
      count: 100000,
    });
    verified.close();
  }, 10_000);

  it("persists one theme preference across database instances", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-theme-db-"));
    const filePath = path.join(directory, "rvw.db");
    const first = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });

    expect(first.getThemePreference()).toBe("system");
    expect(first.setThemePreference("dark")).toBe("dark");
    first.close();

    const second = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    expect(second.getThemePreference()).toBe("dark");
    expect(second.getChangeSequence()).toBe(0);
    second.close();
  });

  it("migrates existing walkthrough ranges and persists file-level references", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-walkthrough-reference-db-"));
    const filePath = path.join(directory, "rvw.db");
    const legacyMigrationsDirectory = path.join(directory, "legacy-migrations");
    mkdirSync(legacyMigrationsDirectory);
    for (const migration of [
      "001_initial.sql",
      "002_commit_model.sql",
      "003_editable_comment_posts.sql",
      "004_walkthroughs.sql",
      "005_walkthrough_comments.sql",
      "006_theme_preference.sql",
      "007_file_level_walkthrough_references.sql",
      "008_walkthrough_line_comments.sql",
      "009_comment_watch.sql",
      "010_comment_post_references.sql",
    ]) {
      writeFileSync(
        path.join(legacyMigrationsDirectory, migration),
        readFileSync(path.join("migrations", migration)),
      );
    }

    const legacy = new RvwDatabase({
      filePath,
      migrationsDirectory: legacyMigrationsDirectory,
    });
    const pullRequest = legacy.upsertPullRequest(
      github,
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
    );
    const { walkthrough: ranged } = legacy.createWalkthrough({
      pullRequestId: pullRequest.id,
      sourceOid: github.headOid,
      title: "Ranged reference",
      body: "Open the range.",
      diagramBindings: {},
      references: [
        {
          id: "handler",
          label: "Request handler",
          path: "src/handler.ts",
          startLine: 10,
          endLine: 24,
          description: null,
        },
      ],
    });
    legacy.close();

    const legacySqlite = new DatabaseSync(filePath);
    const legacyCommentId = "legacy-walkthrough-comment";
    const legacyPostId = "legacy-walkthrough-post";
    const createdAt = new Date().toISOString();
    legacySqlite
      .prepare(
        `INSERT INTO comments(
          id, pull_request_id, created_head_oid, resolved_at, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(legacyCommentId, pullRequest.id, github.headOid, createdAt, createdAt);
    legacySqlite
      .prepare(
        `INSERT INTO comment_targets(
          comment_id, target_kind, walkthrough_id, source_document_hash,
          quoted_text, start_line, end_line
        ) VALUES (?, 'walkthrough', ?, NULL, NULL, NULL, NULL)`,
      )
      .run(legacyCommentId, ranged.id);
    legacySqlite
      .prepare(
        `INSERT INTO comment_posts(
          id, comment_id, body, related_commit_oid, author_label, is_root, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, 1, ?, ?)`,
      )
      .run(
        legacyPostId,
        legacyCommentId,
        "Keep this whole-Walkthrough comment.",
        createdAt,
        createdAt,
      );
    legacySqlite
      .prepare(
        `INSERT INTO comment_post_events(post_id, comment_ref, pull_request_url, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(legacyPostId, `rvw://comment/${legacyCommentId}`, pullRequest.url, createdAt);
    legacySqlite.close();

    const migrated = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    expect(migrated.getWalkthrough(ranged.id)?.references).toEqual([
      {
        id: "handler",
        label: "Request handler",
        path: "src/handler.ts",
        startLine: 10,
        endLine: 24,
        description: null,
      },
    ]);
    expect(migrated.getComment(legacyCommentId)).toMatchObject({
      target: {
        kind: "walkthrough",
        walkthroughId: ranged.id,
        sourceDocumentHash: null,
        quotedText: null,
        startLine: null,
        endLine: null,
      },
      posts: [{ body: "Keep this whole-Walkthrough comment." }],
    });
    expect(migrated.listCommentPostEvents(0, 10)).toMatchObject([
      {
        commentRef: `rvw://comment/${legacyCommentId}`,
        context: {
          kind: "pull-request",
          pullRequestId: pullRequest.id,
          pullRequestUrl: pullRequest.url,
        },
      },
    ]);
    const migratedSqlite = new DatabaseSync(filePath, { readOnly: true });
    expect(
      migratedSqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('comment_post_events', 'review_issues', 'pull_request_issue_comment_targets')",
        )
        .all(),
    ).toEqual([]);
    expect(migratedSqlite.prepare("PRAGMA foreign_key_list(pull_request_issues)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "pull_requests", from: "pull_request_id" }),
        expect.objectContaining({ table: "github_issues", from: "issue_id" }),
      ]),
    );
    expect(migratedSqlite.prepare("PRAGMA foreign_key_list(branch_review_issues)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "branch_reviews", from: "branch_review_id" }),
        expect.objectContaining({ table: "github_issues", from: "issue_id" }),
      ]),
    );
    migratedSqlite.close();
    const { walkthrough: fileLevel } = migrated.createWalkthrough({
      pullRequestId: pullRequest.id,
      sourceOid: github.headOid,
      title: "File reference",
      body: "Open the file.",
      diagramBindings: {},
      references: [
        {
          id: "composition",
          label: "Composition root",
          path: "src/application.ts",
          startLine: null,
          endLine: null,
          description: "File-wide wiring",
        },
      ],
    });
    expect(fileLevel.references).toMatchObject([
      { id: "composition", startLine: null, endLine: null },
    ]);
    migrated.close();
  });

  it("applies migrations and increments change sequence per write transaction", () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    expect(database.getChangeSequence()).toBe(0);
    expect(database.writeProbe()).toEqual({ ok: true, error: null });
    expect(database.getChangeSequence()).toBe(0);
    const pullRequest = database.upsertPullRequest(
      github,
      {
        localRepositoryPath: "/repo",
        gitCommonDir: "/repo/.git",
      },
      "c".repeat(40),
    );
    expect(database.getChangeSequence()).toBe(1);
    expect(database.getReviewChangeSequence("pull-request", pullRequest.id)).toBe(1);
    expect(database.getReviewChangeSequence("branch", pullRequest.id)).toBe(0);
    expect(database.getPullRequest(pullRequest.id)?.latestHeadOid).toBe(github.headOid);
    expect(database.getPullRequest(pullRequest.id)?.latestComparisonBaseOid).toBe("c".repeat(40));
    const otherPullRequest = database.upsertPullRequest(
      { ...github, number: github.number + 1, url: "https://github.com/acme/repo/pull/8" },
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
    );
    expect(database.getChangeSequence()).toBe(2);
    expect(database.getReviewChangeSequence("pull-request", pullRequest.id)).toBe(1);
    expect(database.getReviewChangeSequence("pull-request", otherPullRequest.id)).toBe(1);
    database.close();
  });

  it("never loads migrations from the directory being reviewed", () => {
    const untrustedDirectory = mkdtempSync(path.join(os.tmpdir(), "rvw-untrusted-cwd-"));
    const migrations = path.join(untrustedDirectory, "migrations");
    mkdirSync(migrations);
    writeFileSync(path.join(migrations, "999_untrusted.sql"), "THIS IS NOT VALID SQL;");
    const originalCwd = process.cwd();
    let database: RvwDatabase | null = null;
    try {
      process.chdir(untrustedDirectory);
      database = new RvwDatabase({ filePath: ":memory:" });
      expect(database.getChangeSequence()).toBe(0);
    } finally {
      database?.close();
      process.chdir(originalCwd);
    }
  });

  it("migrates existing review-version comments to commit-backed comments", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-legacy-db-"));
    const filePath = path.join(directory, "rvw.db");
    const legacy = new DatabaseSync(filePath);
    legacy.exec("PRAGMA foreign_keys = ON");
    legacy.exec(readFileSync("migrations/001_initial.sql", "utf8"));
    legacy
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)")
      .run("2026-08-08T00:00:00.000Z");
    const pullRequestId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";
    const commentId = "33333333-3333-4333-8333-333333333333";
    const postId = "44444444-4444-4444-8444-444444444444";
    const now = "2026-08-08T00:00:00.000Z";
    legacy
      .prepare(
        `INSERT INTO pull_requests(
          id, host, owner, repository, number, github_url, local_repository_path, git_common_dir,
          latest_title, latest_body, latest_base_ref_name, latest_head_ref_name, latest_base_oid,
          latest_head_oid, github_updated_at, fetched_at, created_at, updated_at
        ) VALUES (?, 'github.com', 'acme', 'review-repo', 7, ?, '/repo', '/repo/.git',
          'Review me', 'Body', 'main', 'feature', ?, ?, ?, ?, ?, ?)`,
      )
      .run(pullRequestId, github.url, github.baseOid, github.headOid, now, now, now, now);
    legacy
      .prepare(
        `INSERT INTO review_versions(
          id, pull_request_id, sequence, previous_review_version_id, base_tip_oid,
          comparison_base_oid, head_oid, comparison_base_git_ref, head_git_ref,
          pr_title, pr_body, pr_markdown, summary, captured_at
        ) VALUES (?, ?, 1, NULL, ?, ?, ?, 'refs/legacy/base', 'refs/legacy/head',
          'Review me', 'Body', '# Review me\n\nBody', NULL, ?)`,
      )
      .run(versionId, pullRequestId, github.baseOid, "c".repeat(40), github.headOid, now);
    legacy
      .prepare(
        `INSERT INTO comments(
          id, pull_request_id, created_review_version_id, resolved_at, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(commentId, pullRequestId, versionId, now, now);
    legacy
      .prepare(
        `INSERT INTO comment_targets(
          comment_id, target_kind, document_kind, document_review_version_id,
          source_oid, file_path, start_line, end_line
        ) VALUES (?, 'document', 'pull_request_markdown', ?, NULL, NULL, 1, 1)`,
      )
      .run(commentId, versionId);
    legacy
      .prepare(
        `INSERT INTO comment_posts(
          id, comment_id, body, related_review_version_id, author_label, created_at
        ) VALUES (?, ?, 'Legacy comment', ?, 'You', ?)`,
      )
      .run(postId, commentId, versionId, now);
    legacy.close();

    const database = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    expect(database.getPullRequest(pullRequestId)?.latestComparisonBaseOid).toBe("c".repeat(40));
    expect(database.getComment(commentId)).toMatchObject({
      createdHeadOid: github.headOid,
      target: {
        documentKind: "pull-request-markdown",
        sourceDocumentHash: `legacy:${versionId}`,
        quotedText: null,
      },
      posts: [{ relatedCommitOid: github.headOid, createdAt: now, updatedAt: now }],
    });
    database.close();
  });

  it("records only newly created posts and deduplicates replies by idempotency key", () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const pullRequest = database.upsertPullRequest(
      github,
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
    );
    expect(database.getLatestCommentPostEventSequence()).toBe(0);

    const comment = database.createComment({
      pullRequestId: pullRequest.id,
      createdHeadOid: github.headOid,
      target: { kind: "pull-request" },
      body: "Please investigate.",
    });
    const firstCursor = database.getLatestCommentPostEventSequence();
    expect(database.listCommentPostEvents(0, 100)).toMatchObject([
      {
        sequence: firstCursor,
        commentRef: comment.ref,
        context: {
          kind: "pull-request",
          pullRequestId: pullRequest.id,
          pullRequestUrl: pullRequest.url,
        },
        deleted: false,
      },
    ]);

    const firstReply = database.insertReply(comment.id, {
      body: "Investigation complete.",
      authorLabel: "Codex",
      idempotencyKey: "watch-task:batch-1:comment-1",
    });
    const repeatedReply = database.insertReply(comment.id, {
      body: "Investigation complete.",
      authorLabel: "Codex",
      idempotencyKey: "watch-task:batch-1:comment-1",
    });
    expect(repeatedReply.id).toBe(firstReply.id);
    expect(database.listCommentPostEvents(firstCursor, 100)).toHaveLength(1);
    expect(() =>
      database.insertReply(comment.id, {
        body: "Different payload.",
        authorLabel: "Codex",
        idempotencyKey: "watch-task:batch-1:comment-1",
      }),
    ).toThrow("同じidempotencyKey");
    database.close();
  });

  it("uses one database-wide idempotency keyspace for PR and Branch replies", () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const pullRequest = database.upsertPullRequest(
      github,
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
    );
    const branchInitialization = database.beginBranchReviewInitialization(
      {
        owner: github.owner,
        repository: github.repository,
        canonicalName: `${github.owner}/${github.repository}`,
        defaultBranchName: "main",
        defaultBranchOid: github.headOid,
      },
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
    ).branchReview;
    const branchReview = database.completeBranchReviewInitialization(
      branchInitialization.id,
      branchInitialization.sourceOid,
    );
    const pullRequestComment = database.createComment({
      pullRequestId: pullRequest.id,
      createdHeadOid: github.headOid,
      target: { kind: "pull-request" },
      body: "PR question",
    });
    const branchComment = database.createBranchComment({
      branchReviewId: branchReview.id,
      createdSourceOid: branchReview.sourceOid,
      target: { kind: "branch" },
      body: "Branch question",
    });
    database.insertReply(pullRequestComment.id, {
      body: "PR answer",
      idempotencyKey: "shared-public-key",
    });

    expect(() =>
      database.insertBranchReply(branchComment.id, {
        body: "Branch answer",
        idempotencyKey: "shared-public-key",
      }),
    ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(database.listBranchCommentPosts(branchComment.id)).toHaveLength(1);
    database.close();
  });

  it("keeps the shared Issue cache monotonic across review refreshes", () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const pullRequest = database.upsertPullRequest(
      github,
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
    );
    const branchInitialization = database.beginBranchReviewInitialization(
      {
        owner: github.owner,
        repository: github.repository,
        canonicalName: `${github.owner}/${github.repository}`,
        defaultBranchName: "main",
        defaultBranchOid: github.headOid,
      },
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
    ).branchReview;
    const branchReview = database.completeBranchReviewInitialization(
      branchInitialization.id,
      branchInitialization.sourceOid,
    );
    const initialIssue = {
      host: "github.com" as const,
      owner: github.owner,
      repository: github.repository,
      canonicalName: `${github.owner}/${github.repository}`,
      number: 142,
      url: `https://github.com/${github.owner}/${github.repository}/issues/142`,
      title: "Initial title",
      body: "Initial body",
      state: "OPEN" as const,
      updatedAt: "2026-08-08T01:00:00.000Z",
    };
    const cached = database.addReviewIssue("pull-request", pullRequest.id, initialIssue).issue;
    database.addReviewIssue("branch", branchReview.id, initialIssue);
    const initialCacheGeneration = database.getIssueCacheGeneration(cached.id);
    const newer = {
      ...initialIssue,
      title: "Newest title",
      body: "Newest body",
      updatedAt: "2026-08-08T03:00:00.000Z",
    };
    database.refreshReviewIssue("branch", branchReview.id, cached.id, newer);
    const newestSnapshot = database.getIssue(cached.id);
    const branchSequence = database.getReviewChangeSequence("branch", branchReview.id);
    const pullRequestSequence = database.getReviewChangeSequence("pull-request", pullRequest.id);

    expect(
      database.refreshReviewIssue("pull-request", pullRequest.id, cached.id, {
        ...initialIssue,
        title: "Older title",
        body: "Older body",
        updatedAt: "2026-08-08T02:00:00.000Z",
      }),
    ).toMatchObject({ refreshed: false, skipped: "older-response", issue: newestSnapshot });
    expect(
      database.setReviewIssueSyncError(
        "pull-request",
        pullRequest.id,
        cached.id,
        initialCacheGeneration,
        "late failure",
      ),
    ).toMatchObject({ updated: false, skipped: "newer-attempt", issue: newestSnapshot });
    expect(() =>
      database.refreshReviewIssue("branch", branchReview.id, cached.id, {
        ...newer,
        body: "Conflicting body at same timestamp",
      }),
    ).toThrowError(expect.objectContaining({ code: "GITHUB_ISSUE_ERROR" }));
    expect(database.getIssue(cached.id)).toEqual(newestSnapshot);
    expect(database.getReviewChangeSequence("branch", branchReview.id)).toBe(branchSequence);
    expect(database.getReviewChangeSequence("pull-request", pullRequest.id)).toBe(
      pullRequestSequence,
    );
    database.close();
  });

  it("uses Issue cache generation instead of millisecond timestamps as the failure CAS token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T04:00:00.000Z"));
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    try {
      const pullRequest = database.upsertPullRequest(
        github,
        { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
        "c".repeat(40),
      );
      const initial = {
        host: "github.com" as const,
        owner: github.owner,
        repository: github.repository,
        canonicalName: `${github.owner}/${github.repository}`,
        number: 143,
        url: `https://github.com/${github.owner}/${github.repository}/issues/143`,
        title: "Initial",
        body: "Initial body",
        state: "OPEN" as const,
        updatedAt: "2026-08-08T03:00:00.000Z",
      };
      const cached = database.addReviewIssue("pull-request", pullRequest.id, initial).issue;
      const oldGeneration = database.getIssueCacheGeneration(cached.id);
      const refreshed = database.refreshReviewIssue("pull-request", pullRequest.id, cached.id, {
        ...initial,
        title: "Newer",
        body: "Newer body",
        updatedAt: "2026-08-08T04:00:00.000Z",
      }).issue!;

      expect(refreshed.fetchedAt).toBe(cached.fetchedAt);
      expect(database.getIssueCacheGeneration(cached.id)).toBe(oldGeneration + 1);
      expect(
        database.setReviewIssueSyncError(
          "pull-request",
          pullRequest.id,
          cached.id,
          oldGeneration,
          "late failure in the same millisecond",
        ),
      ).toMatchObject({ updated: false, skipped: "newer-attempt" });
      expect(
        database.getReviewIssue("pull-request", pullRequest.id, cached.id)?.syncError,
      ).toBeNull();
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it("scopes Issue sync errors to memberships and garbage-collects the last shared cache owner", () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const pullRequest = database.upsertPullRequest(
      github,
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
    );
    const initialization = database.beginBranchReviewInitialization(
      {
        owner: github.owner,
        repository: github.repository,
        canonicalName: `${github.owner}/${github.repository}`,
        defaultBranchName: "main",
        defaultBranchOid: github.headOid,
      },
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
    ).branchReview;
    const branchReview = database.completeBranchReviewInitialization(
      initialization.id,
      initialization.sourceOid,
    );
    const issue = {
      host: "github.com" as const,
      owner: github.owner,
      repository: github.repository,
      canonicalName: `${github.owner}/${github.repository}`,
      number: 144,
      url: `https://github.com/${github.owner}/${github.repository}/issues/144`,
      title: "Shared",
      body: "Shared body",
      state: "OPEN" as const,
      updatedAt: "2026-08-08T05:00:00.000Z",
    };
    const cached = database.addReviewIssue("pull-request", pullRequest.id, issue).issue;
    database.addReviewIssue("branch", branchReview.id, issue);
    const branchSequence = database.getReviewChangeSequence("branch", branchReview.id);
    const generation = database.getIssueCacheGeneration(cached.id);

    expect(
      database.setReviewIssueSyncError(
        "pull-request",
        pullRequest.id,
        cached.id,
        generation,
        "PR-only failure",
      ),
    ).toMatchObject({ updated: true, issue: { syncError: "PR-only failure", stale: true } });
    expect(database.listReviewIssues("pull-request", pullRequest.id)[0]).toMatchObject({
      syncError: "PR-only failure",
      stale: true,
    });
    expect(database.listReviewIssues("branch", branchReview.id)[0]).toMatchObject({
      syncError: null,
      stale: false,
    });
    expect(database.getReviewChangeSequence("branch", branchReview.id)).toBe(branchSequence);

    database.removeReviewIssue(
      "pull-request",
      pullRequest.id,
      cached.id,
      database.getReviewChangeSequence("pull-request", pullRequest.id),
    );
    expect(database.getIssue(cached.id)).not.toBeNull();
    database.removeReviewIssue(
      "branch",
      branchReview.id,
      cached.id,
      database.getReviewChangeSequence("branch", branchReview.id),
    );
    expect(database.getIssue(cached.id)).toBeNull();

    const resetCached = database.addReviewIssue("pull-request", pullRequest.id, {
      ...issue,
      number: 145,
      url: `https://github.com/${github.owner}/${github.repository}/issues/145`,
    }).issue;
    database.addReviewIssue("branch", branchReview.id, {
      ...issue,
      number: 145,
      url: `https://github.com/${github.owner}/${github.repository}/issues/145`,
    });
    database.resetPullRequest(
      github,
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
      database.getReviewChangeSequence("pull-request", pullRequest.id),
    );
    expect(database.getIssue(resetCached.id)).not.toBeNull();
    database.resetBranchReview(
      branchReview.id,
      0,
      database.getReviewChangeSequence("branch", branchReview.id),
    );
    expect(database.getIssue(resetCached.id)).toBeNull();
    database.close();
  });

  it("persists post-level code references and removes them with their posts", () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const pullRequest = database.upsertPullRequest(
      github,
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
    );
    const rootReference = {
      id: "root",
      label: "Root source",
      path: "src/root.ts",
      startLine: 1,
      endLine: 3,
      description: null,
    };
    const comment = database.createComment({
      pullRequestId: pullRequest.id,
      createdHeadOid: github.headOid,
      target: { kind: "pull-request" },
      body: "Open [the root](rvw-ref:root).",
      relatedCommitOid: github.headOid,
      references: [rootReference],
    });
    const reply = database.insertReply(comment.id, {
      body: "Open [the reply source](rvw-ref:reply).",
      relatedCommitOid: github.headOid,
      references: [
        {
          id: "reply",
          label: "Reply source",
          path: "src/reply.ts",
          startLine: null,
          endLine: null,
          description: "File-level context",
        },
      ],
    });

    expect(database.getComment(comment.id)?.posts).toMatchObject([
      { references: [rootReference] },
      { references: [{ id: "reply", startLine: null, endLine: null }] },
    ]);
    expect(database.getResetCounts(pullRequest.id, 0).commentReferences).toBe(2);

    database.updateCommentPost(comment.id, reply.id, "Reference removed.", undefined, []);
    expect(database.getResetCounts(pullRequest.id, 0).commentReferences).toBe(1);
    database.deleteComment(comment.id);
    expect(database.getResetCounts(pullRequest.id, 0).commentReferences).toBe(0);
    database.close();
  });

  it("reuses a synchronized reply when the derived GitHub head advances", () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const pullRequest = database.upsertPullRequest(
      github,
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
    );
    const comment = database.createComment({
      pullRequestId: pullRequest.id,
      createdHeadOid: github.headOid,
      target: { kind: "pull-request" },
      body: "Please update this.",
    });
    const update = {
      commentId: comment.id,
      reply: "Updated.",
      resolve: false,
      authorLabel: "Agent",
      idempotencyKey: "sync-retry-key",
      idempotencyRequestHash: "d".repeat(64),
    };

    database.syncPullRequestAndComments(
      github,
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
      [update],
    );
    database.syncPullRequestAndComments(
      { ...github, headOid: "e".repeat(40), updatedAt: "2026-08-09T00:00:00.000Z" },
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "f".repeat(40),
      [update],
    );

    expect(database.listCommentPosts(comment.id)).toMatchObject([
      { isRoot: true },
      { body: "Updated.", relatedCommitOid: github.headOid },
    ]);
    expect(database.listCommentPostEvents(0, 100)).toHaveLength(2);
    database.close();
  });
});
