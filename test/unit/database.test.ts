import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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
  createdAt: "2026-08-07T00:00:00.000Z",
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

  it("lists Pull Request summaries by GitHub update time with aggregate counts and pagination", () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const older = database.upsertPullRequest(
      github,
      { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
      "c".repeat(40),
    );
    const newerGithub = {
      ...github,
      owner: "other",
      number: 8,
      url: "https://github.com/other/review-repo/pull/8",
      title: "Newest review",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      isDraft: true,
    };
    const newer = database.upsertPullRequest(
      newerGithub,
      { localRepositoryPath: "/other", gitCommonDir: "/other/.git" },
      "d".repeat(40),
    );
    const closedGithub = {
      ...github,
      owner: "closed",
      number: 9,
      url: "https://github.com/closed/review-repo/pull/9",
      title: "Closed review",
      updatedAt: "2026-08-11T00:00:00.000Z",
      state: "CLOSED" as const,
    };
    const closed = database.upsertPullRequest(
      closedGithub,
      { localRepositoryPath: "/closed", gitCommonDir: "/closed/.git" },
      "e".repeat(40),
    );
    const unresolved = database.createComment({
      pullRequestId: newer.id,
      createdHeadOid: newerGithub.headOid,
      target: { kind: "pull-request" },
      body: "Open feedback",
    });
    const resolved = database.createComment({
      pullRequestId: newer.id,
      createdHeadOid: newerGithub.headOid,
      target: { kind: "pull-request" },
      body: "Resolved feedback",
    });
    database.setCommentResolved(resolved.id, true);
    database.createWalkthrough({
      pullRequestId: newer.id,
      sourceOid: newerGithub.headOid,
      title: "Architecture tour",
      body: "Read the implementation.",
      diagramBindings: {},
      references: [],
    });
    const structure = database.createStructure({
      pullRequestId: newer.id,
      sourceOid: newerGithub.headOid,
      title: "Architecture space",
      scope: "The bounded relationship under review.",
      originNodeId: "entry",
      nodes: [
        {
          id: "entry",
          label: "Entry",
          description: null,
          kind: null,
          notation: "plain",
          anchor: { path: "src/entry.ts", startLine: 1, endLine: 1 },
        },
      ],
      edges: [],
      idempotencyKey: "summary-structure",
      idempotencyRequestHash: "summary-structure-request",
    });
    expect(structure.nodes[0]?.notation).toBe("plain");

    expect(unresolved.resolvedAt).toBeNull();
    expect(database.listPullRequestSummaries(0, 1)).toEqual({
      items: [
        {
          pullRequestId: newer.id,
          owner: "other",
          repository: "review-repo",
          number: 8,
          title: "Newest review",
          githubCreatedAt: "2026-08-08T12:00:00.000Z",
          githubUpdatedAt: "2026-08-10T00:00:00.000Z",
          githubState: "OPEN",
          githubIsDraft: true,
          unresolvedCommentCount: 1,
          resolvedCommentCount: 1,
          walkthroughCount: 1,
          structureCount: 1,
        },
      ],
      total: 2,
    });
    expect(database.listPullRequestSummaries(1, 1)).toMatchObject({
      items: [
        {
          pullRequestId: older.id,
          unresolvedCommentCount: 0,
          resolvedCommentCount: 0,
          walkthroughCount: 0,
          structureCount: 0,
        },
      ],
      total: 2,
    });
    expect(database.listPullRequestSummaries(0, 1, false)).toMatchObject({
      items: [{ pullRequestId: closed.id, githubState: "CLOSED" }],
      total: 3,
    });
    database.close();
  });

  it("lists only Open, Draft, and unknown Pull Requests needing a status refresh", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-status-refresh-db-"));
    const filePath = path.join(directory, "rvw.db");
    const database = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    const savePullRequest = (
      owner: string,
      number: number,
      state: "OPEN" | "CLOSED" | "MERGED",
      isDraft = false,
    ) =>
      database.upsertPullRequest(
        {
          ...github,
          owner,
          number,
          url: `https://github.com/${owner}/review-repo/pull/${number}`,
          state,
          isDraft,
        },
        { localRepositoryPath: `/${owner}`, gitCommonDir: `/${owner}/.git` },
        "c".repeat(40),
      );
    const open = savePullRequest("open", 1, "OPEN");
    const draft = savePullRequest("draft", 2, "OPEN", true);
    const unknown = savePullRequest("unknown", 3, "OPEN");
    const closed = savePullRequest("closed", 4, "CLOSED");
    const merged = savePullRequest("merged", 5, "MERGED");
    database.close();

    const raw = new DatabaseSync(filePath);
    raw
      .prepare("UPDATE pull_requests SET github_state = NULL, github_is_draft = NULL WHERE id = ?")
      .run(unknown.id);
    raw.close();

    const reopened = new RvwDatabase({ filePath, migrationsDirectory: "./migrations" });
    const candidates = reopened.listPullRequestsNeedingStatusRefresh();

    expect(candidates.map(({ id }) => id).sort()).toEqual([open.id, draft.id, unknown.id].sort());
    expect(candidates.find(({ id }) => id === open.id)).toMatchObject({
      githubState: "OPEN",
      githubIsDraft: false,
    });
    expect(candidates.find(({ id }) => id === draft.id)).toMatchObject({
      githubState: "OPEN",
      githubIsDraft: true,
    });
    expect(candidates.find(({ id }) => id === unknown.id)).toMatchObject({
      githubState: null,
      githubIsDraft: null,
    });
    expect(candidates.map(({ id }) => id)).not.toContain(closed.id);
    expect(candidates.map(({ id }) => id)).not.toContain(merged.id);
    reopened.close();
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
      "009_comment_watch.sql",
      "010_comment_post_references.sql",
      "011_comment_post_modifier.sql",
      "012_pull_request_list.sql",
      "013_pull_request_github_status.sql",
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
    const ranged = legacy.createWalkthrough({
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
    const wholeComment = legacy.createComment({
      pullRequestId: pullRequest.id,
      createdHeadOid: github.headOid,
      target: {
        kind: "walkthrough",
        walkthroughId: ranged.id,
        walkthroughTitle: ranged.title,
        sourceDocumentHash: null,
        quotedText: null,
        startLine: null,
        endLine: null,
      },
      body: "Keep this whole-Walkthrough comment.",
    });
    legacy.close();

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
    expect(migrated.getComment(wholeComment.id)).toMatchObject({
      target: {
        kind: "walkthrough",
        walkthroughId: ranged.id,
        sourceDocumentHash: null,
        quotedText: null,
        startLine: null,
        endLine: null,
      },
      posts: [{ body: "Keep this whole-Walkthrough comment.", lastModifiedBy: null }],
    });
    const fileLevel = migrated.createWalkthrough({
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
    expect(database.getDomainRevisions()).toEqual({
      pullRequests: 0,
      pullRequestContent: 0,
      comments: 0,
      walkthroughs: 0,
      structures: 0,
    });
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
    expect(database.getDomainRevisions()).toEqual({
      pullRequests: 1,
      pullRequestContent: 1,
      comments: 0,
      walkthroughs: 0,
      structures: 0,
    });
    expect(database.getPullRequest(pullRequest.id)?.latestHeadOid).toBe(github.headOid);
    expect(database.getPullRequest(pullRequest.id)?.latestComparisonBaseOid).toBe("c".repeat(40));
    expect(database.getPullRequest(pullRequest.id)).toMatchObject({
      githubState: "OPEN",
      githubIsDraft: false,
    });
    database.close();
  });

  it("advances Pull Request revisions only for semantic metadata and content changes", () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const repository = { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" };
    const comparisonBaseOid = "c".repeat(40);
    const pullRequest = database.upsertPullRequest(github, repository, comparisonBaseOid);

    database.upsertPullRequest(github, repository, comparisonBaseOid);
    database.updatePullRequestGitHubStatuses([
      { pullRequestId: pullRequest.id, state: "OPEN", isDraft: false },
    ]);
    expect(database.getChangeSequence()).toBe(1);
    expect(database.getDomainRevisions()).toEqual({
      pullRequests: 1,
      pullRequestContent: 1,
      comments: 0,
      walkthroughs: 0,
      structures: 0,
    });

    const changedGithub = {
      ...github,
      body: "Updated Pull Request body.",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    database.upsertPullRequest(changedGithub, repository, comparisonBaseOid);
    expect(database.getDomainRevisions()).toMatchObject({
      pullRequests: 2,
      pullRequestContent: 2,
    });

    database.updatePullRequestGitHubStatuses([
      { pullRequestId: pullRequest.id, state: "CLOSED", isDraft: false },
    ]);
    expect(database.getDomainRevisions()).toMatchObject({
      pullRequests: 3,
      pullRequestContent: 2,
    });

    const comment = database.createComment({
      pullRequestId: pullRequest.id,
      createdHeadOid: github.headOid,
      target: { kind: "pull-request" },
      body: "Please update this.",
    });
    const beforeSync = database.getDomainRevisions();
    database.syncPullRequestAndComments(
      { ...changedGithub, state: "CLOSED" },
      repository,
      comparisonBaseOid,
      [
        {
          commentId: comment.id,
          reply: "Updated.",
          resolve: false,
          authorLabel: "Agent",
        },
      ],
    );
    expect(database.getDomainRevisions()).toEqual({
      ...beforeSync,
      comments: beforeSync.comments + 1,
    });
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
    expect(database.getPullRequest(pullRequestId)).toMatchObject({
      latestComparisonBaseOid: "c".repeat(40),
      githubCreatedAt: null,
      githubState: null,
      githubIsDraft: null,
    });
    expect(database.listPullRequestSummaries(0, 50, true)).toMatchObject({
      items: [
        {
          pullRequestId,
          githubState: null,
          githubIsDraft: null,
        },
      ],
      total: 1,
    });
    expect(database.getComment(commentId)).toMatchObject({
      createdHeadOid: github.headOid,
      target: {
        documentKind: "pull-request-markdown",
        sourceDocumentHash: `legacy:${versionId}`,
        quotedText: null,
      },
      posts: [
        {
          relatedCommitOid: github.headOid,
          lastModifiedBy: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
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
        pullRequestUrl: pullRequest.url,
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

    database.updateCommentPost(
      comment.id,
      reply.id,
      "Reference removed.",
      reply.relatedCommitOid,
      [],
      reply.lastModifiedBy,
    );
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
