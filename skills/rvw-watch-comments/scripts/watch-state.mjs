#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function fail(message) {
  throw new Error(message);
}

function parseOptions(values) {
  const result = {};
  const flags = new Set(["follow"]);
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) fail(`Unexpected argument: ${key ?? ""}`);
    const name = key.slice(2);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      if (!flags.has(name)) fail(`${key} requires a value`);
      result[name] = true;
    } else {
      result[name] = value;
      index += 1;
    }
  }
  return result;
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) fail(`--${key} is required`);
  return value;
}

function positiveIntegerOption(options, key, defaultValue) {
  const raw = options[key];
  if (raw === undefined) return defaultValue;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    fail(`--${key} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) fail(`--${key} must be a positive integer`);
  return value;
}

async function readInput() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  if (!value.trim()) fail("stdin JSON is required");
  return JSON.parse(value);
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function openState(statePath, create) {
  const absolute = path.resolve(statePath);
  if (create) {
    mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  } else if (!existsSync(absolute)) {
    fail(`State database does not exist: ${absolute}`);
  }
  const database = new DatabaseSync(absolute);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY,
      cursor TEXT NOT NULL,
      post_id TEXT NOT NULL,
      comment_ref TEXT NOT NULL,
      pull_request_url TEXT NOT NULL,
      deleted INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
      batch_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      pull_request_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'in_flight', 'completed', 'quarantined')),
      attempts INTEGER NOT NULL,
      next_attempt_at TEXT,
      lease_id TEXT,
      write_key TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      batch_id TEXT NOT NULL,
      comment_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      post_id TEXT,
      PRIMARY KEY(batch_id, comment_ref)
    );
    CREATE TABLE IF NOT EXISTS suppressed_posts (
      post_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS batches_active_write_key
      ON batches(write_key)
      WHERE status = 'in_flight' AND write_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS events_pending_pr
      ON events(status, pull_request_url, sequence);
    CREATE INDEX IF NOT EXISTS batches_pending_pr
      ON batches(status, pull_request_url, next_attempt_at, created_at);
  `);
  migrateStateSchema(database);
  if (create) chmodSync(absolute, 0o600);
  return { database, absolute };
}

function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the operation error.
    }
    throw error;
  }
}

function getMeta(database, key) {
  const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return typeof row?.value === "string" ? row.value : null;
}

function setMeta(database, key, value) {
  database
    .prepare(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

function tableExists(database, tableName) {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function migrateStateSchema(database) {
  const ensureColumn = (table, name, definition) => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === name)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  ensureColumn("events", "review_kind", "TEXT");
  ensureColumn("events", "context_key", "TEXT");
  ensureColumn("batches", "review_kind", "TEXT");
  ensureColumn("batches", "context_key", "TEXT");
  database.exec(`
    UPDATE events
    SET review_kind = 'pull-request', context_key = pull_request_url
    WHERE review_kind IS NULL OR context_key IS NULL;
    UPDATE batches
    SET review_kind = 'pull-request', context_key = pull_request_url
    WHERE review_kind IS NULL OR context_key IS NULL;
    CREATE INDEX IF NOT EXISTS events_pending_context
      ON events(status, review_kind, context_key, sequence);
    CREATE INDEX IF NOT EXISTS batches_pending_context
      ON batches(status, review_kind, context_key, next_attempt_at, created_at);
  `);
  const operationColumns = database.prepare("PRAGMA table_info(operations)").all();
  if (
    operationColumns.some((column) => column.name === "post_id") &&
    getMeta(database, "batch_scoped_status_posts") === "1"
  ) {
    return;
  }
  transaction(database, () => {
    const currentOperationColumns = database.prepare("PRAGMA table_info(operations)").all();
    if (!currentOperationColumns.some((column) => column.name === "post_id")) {
      database.exec("ALTER TABLE operations ADD COLUMN post_id TEXT;");
    }
    if (getMeta(database, "batch_scoped_status_posts") === "1") return;
    if (tableExists(database, "comment_statuses")) {
      const rows = database
        .prepare(
          `SELECT b.id AS batch_id, e.comment_ref,
            b.created_at AS batch_created_at,
            o.idempotency_key AS operation_key, o.post_id AS operation_post_id,
            s.idempotency_key AS legacy_key, s.post_id AS legacy_post_id,
            s.updated_at AS legacy_updated_at
          FROM batches b
          JOIN (
            SELECT DISTINCT batch_id, comment_ref FROM events WHERE batch_id IS NOT NULL
          ) e ON e.batch_id = b.id
          LEFT JOIN operations o ON o.batch_id = b.id AND o.comment_ref = e.comment_ref
          LEFT JOIN comment_statuses s ON s.comment_ref = e.comment_ref
          WHERE b.status != 'completed' AND b.attempts > 0
          ORDER BY e.comment_ref,
            CASE b.status WHEN 'in_flight' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
            b.created_at DESC`,
        )
        .all();
      const migratedCommentRefs = new Set();
      for (const row of rows) {
        const useLegacyStatus =
          !migratedCommentRefs.has(row.comment_ref) &&
          row.legacy_key &&
          row.legacy_updated_at >= row.batch_created_at;
        if (useLegacyStatus) migratedCommentRefs.add(row.comment_ref);
        if (row.operation_key) {
          if (useLegacyStatus && row.operation_post_id === null && row.legacy_post_id !== null) {
            database
              .prepare("UPDATE operations SET post_id = ? WHERE batch_id = ? AND comment_ref = ?")
              .run(row.legacy_post_id, row.batch_id, row.comment_ref);
          }
          continue;
        }
        database
          .prepare(
            `INSERT INTO operations(batch_id, comment_ref, idempotency_key, post_id)
            VALUES (?, ?, ?, ?)`,
          )
          .run(
            row.batch_id,
            row.comment_ref,
            useLegacyStatus
              ? row.legacy_key
              : `${getMeta(database, "task_id") ?? "task"}:${row.batch_id}:${randomUUID()}`,
            useLegacyStatus ? row.legacy_post_id : null,
          );
      }
    }
    setMeta(database, "batch_scoped_status_posts", "1");
  });
}

function ensureBatchOperations(database, batchId) {
  const commentRefs = database
    .prepare("SELECT DISTINCT comment_ref FROM events WHERE batch_id = ? ORDER BY comment_ref")
    .all(batchId)
    .map((operation) => operation.comment_ref);
  for (let index = 0; index < commentRefs.length; index += 1) {
    database
      .prepare(
        `INSERT OR IGNORE INTO operations(batch_id, comment_ref, idempotency_key, post_id)
        VALUES (?, ?, ?, NULL)`,
      )
      .run(batchId, commentRefs[index], `${getMeta(database, "task_id")}:${batchId}:${index + 1}`);
  }
}

function batchStatusOperations(database, batchId) {
  return database
    .prepare(
      `SELECT comment_ref, idempotency_key, post_id FROM operations
      WHERE batch_id = ? ORDER BY comment_ref`,
    )
    .all(batchId)
    .map((operation) => ({
      commentRef: operation.comment_ref,
      idempotencyKey: operation.idempotency_key,
      statusPostId: operation.post_id ?? null,
    }));
}

function quarantinedBatches(database) {
  return database
    .prepare(
      `SELECT id, review_kind, context_key, attempts, last_error
      FROM batches WHERE status = 'quarantined' ORDER BY created_at`,
    )
    .all()
    .map((batch) => {
      const context =
        batch.review_kind === "branch"
          ? { kind: "branch", repository: batch.context_key }
          : { kind: "pull-request", pullRequestUrl: batch.context_key };
      return {
        batchId: batch.id,
        context,
        ...(context.kind === "pull-request" ? { pullRequest: context.pullRequestUrl } : {}),
        ...(context.kind === "branch" ? { repository: context.repository } : {}),
        attempts: Number(batch.attempts),
        error: batch.last_error,
        operations: batchStatusOperations(database, batch.id),
      };
    });
}

function initialize(database, options) {
  const ownMode = options["own-mode"] ?? "investigate-and-reply";
  if (ownMode !== "investigate-and-reply" && ownMode !== "fix-and-push") {
    fail("--own-mode must be investigate-and-reply or fix-and-push");
  }
  const expectedLogin = options["expected-login"] ?? "";
  return transaction(database, () => {
    const existingTaskId = getMeta(database, "task_id");
    if (existingTaskId) {
      if (
        getMeta(database, "own_mode") !== ownMode ||
        getMeta(database, "expected_login") !== expectedLogin
      ) {
        fail("Existing task policy does not match the requested immutable policy");
      }
      return existingTaskId;
    }
    const taskId = randomUUID();
    setMeta(database, "task_id", taskId);
    setMeta(database, "own_mode", ownMode);
    setMeta(database, "expected_login", expectedLogin);
    setMeta(database, "last_sequence", "0");
    return taskId;
  });
}

function ingestReady(database, frame) {
  if (
    typeof frame.databaseId !== "string" ||
    !/^[0-9a-f]{32}$/.test(frame.databaseId) ||
    typeof frame.cursor !== "string" ||
    frame.cursor.length === 0
  ) {
    fail("Invalid ready frame");
  }
  return transaction(database, () => {
    const databaseId = getMeta(database, "database_id");
    if (databaseId && databaseId !== frame.databaseId)
      fail("State belongs to another rvw database");
    const cursor = getMeta(database, "cursor");
    if (cursor && cursor !== frame.cursor) fail("Ready cursor does not match durable task cursor");
    setMeta(database, "database_id", frame.databaseId);
    if (!cursor) setMeta(database, "cursor", frame.cursor);
    return { status: "ready", cursor: frame.cursor };
  });
}

function ingestEvent(database, frame) {
  const event = frame.event;
  const context =
    event?.context?.kind === "pull-request" && typeof event.context.pullRequestUrl === "string"
      ? { kind: "pull-request", key: event.context.pullRequestUrl }
      : event?.context?.kind === "branch" && typeof event.context.repository === "string"
        ? { kind: "branch", key: event.context.repository.toLowerCase() }
        : typeof event?.pullRequestUrl === "string"
          ? { kind: "pull-request", key: event.pullRequestUrl }
          : null;
  if (
    typeof frame.cursor !== "string" ||
    !event ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    typeof event.postId !== "string" ||
    typeof event.commentRef !== "string" ||
    !context ||
    typeof event.deleted !== "boolean"
  ) {
    fail("Invalid comment-posted frame");
  }
  return transaction(database, () => {
    if (!getMeta(database, "database_id")) fail("Ingest a ready frame before events");
    const existing = database
      .prepare("SELECT * FROM events WHERE sequence = ?")
      .get(event.sequence);
    if (existing) {
      if (existing.cursor !== frame.cursor || existing.post_id !== event.postId) {
        fail("Event sequence was reused with different content");
      }
      return { status: "duplicate", sequence: event.sequence, cursor: getMeta(database, "cursor") };
    }
    const lastSequence = Number(getMeta(database, "last_sequence") ?? "0");
    if (event.sequence <= lastSequence) fail("Out-of-order event was not previously stored");
    const suppressed = database
      .prepare("SELECT 1 AS present FROM suppressed_posts WHERE post_id = ?")
      .get(event.postId);
    const status = event.deleted || suppressed ? "completed" : "pending";
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO events(
          sequence, cursor, post_id, comment_ref, pull_request_url, deleted,
          status, batch_id, created_at, updated_at, review_kind, context_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        event.sequence,
        frame.cursor,
        event.postId,
        event.commentRef,
        context.key,
        event.deleted ? 1 : 0,
        status,
        now,
        now,
        context.kind,
        context.key,
      );
    if (event.deleted) {
      const operations = database
        .prepare("SELECT batch_id, comment_ref FROM operations WHERE post_id = ?")
        .all(event.postId);
      for (const operation of operations) {
        database
          .prepare(
            `UPDATE operations SET post_id = NULL, idempotency_key = ?
            WHERE batch_id = ? AND comment_ref = ?`,
          )
          .run(
            `${getMeta(database, "task_id")}:${operation.batch_id}:${randomUUID()}`,
            operation.batch_id,
            operation.comment_ref,
          );
      }
    }
    setMeta(database, "last_sequence", String(event.sequence));
    setMeta(database, "cursor", frame.cursor);
    return {
      status: event.deleted ? "deleted" : suppressed ? "suppressed" : "queued",
      sequence: event.sequence,
      cursor: frame.cursor,
      context,
    };
  });
}

function listPending(database) {
  const now = new Date().toISOString();
  const batches = database
    .prepare(
      `SELECT b.review_kind, b.context_key, b.id AS batch_id, count(e.sequence) AS event_count,
        min(e.sequence) AS first_sequence
      FROM batches b
      JOIN events e ON e.batch_id = b.id AND e.status = 'pending'
      WHERE b.status = 'pending' AND (b.next_attempt_at IS NULL OR b.next_attempt_at <= ?)
      GROUP BY b.id
      ORDER BY first_sequence`,
    )
    .all(now);
  const blockedContexts = new Set(
    database
      .prepare(
        "SELECT DISTINCT review_kind, context_key FROM batches WHERE status IN ('pending', 'in_flight')",
      )
      .all()
      .map((row) => `${row.review_kind}:${row.context_key}`),
  );
  const unbatched = database
    .prepare(
      `SELECT review_kind, context_key, NULL AS batch_id, count(*) AS event_count,
        min(sequence) AS first_sequence
      FROM events
      WHERE status = 'pending' AND batch_id IS NULL
      GROUP BY review_kind, context_key
      ORDER BY first_sequence`,
    )
    .all()
    .filter((row) => !blockedContexts.has(`${row.review_kind}:${row.context_key}`));
  return [...batches, ...unbatched]
    .sort((left, right) => Number(left.first_sequence) - Number(right.first_sequence))
    .map((row) => {
      const commentRefs = row.batch_id
        ? database
            .prepare(
              "SELECT DISTINCT comment_ref FROM events WHERE batch_id = ? ORDER BY comment_ref",
            )
            .all(row.batch_id)
            .map((item) => item.comment_ref)
        : database
            .prepare(
              `SELECT DISTINCT comment_ref FROM events
              WHERE review_kind = ? AND context_key = ? AND status = 'pending' AND batch_id IS NULL
              ORDER BY comment_ref`,
            )
            .all(row.review_kind, row.context_key)
            .map((item) => item.comment_ref);
      const context =
        row.review_kind === "branch"
          ? { kind: "branch", repository: row.context_key }
          : { kind: "pull-request", pullRequestUrl: row.context_key };
      return {
        context,
        ...(context.kind === "pull-request" ? { pullRequest: context.pullRequestUrl } : {}),
        ...(context.kind === "branch" ? { repository: context.repository } : {}),
        batchId: row.batch_id ?? null,
        eventCount: Number(row.event_count),
        firstSequence: Number(row.first_sequence),
        commentRefs,
      };
    });
}

async function waitForPending(database, options) {
  const intervalMs = positiveIntegerOption(options, "interval-ms", 250);
  const follow = options.follow === true;
  let wasNonEmpty = false;
  do {
    const pending = listPending(database);
    const isNonEmpty = pending.length > 0;
    if (isNonEmpty && !wasNonEmpty) {
      write({
        ok: true,
        type: "pending",
        contexts: pending.map((batch) => batch.context),
        pullRequests: pending.flatMap((batch) =>
          batch.context.kind === "pull-request" ? [batch.context.pullRequestUrl] : [],
        ),
        pending,
      });
      if (!follow) return;
    }
    wasNonEmpty = isNonEmpty;
    await waitFor(intervalMs);
  } while (follow || !wasNonEmpty);
}

function normalizeWriteKey(writeKey) {
  if (typeof writeKey !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(writeKey)) {
    fail("--write-key must be owner/repository");
  }
  return writeKey.toLowerCase();
}

function reviewContextFromOptions(options) {
  if (typeof options["pull-request"] === "string") {
    return { kind: "pull-request", key: options["pull-request"] };
  }
  const kind = required(options, "context-kind");
  const key = required(options, "context-key");
  if (kind !== "pull-request" && kind !== "branch") {
    fail("--context-kind must be pull-request or branch");
  }
  if (kind === "branch" && !/^[^/\s]+\/[^/\s]+$/.test(key)) {
    fail("Branch --context-key must be owner/repository");
  }
  return { kind, key: kind === "branch" ? key.toLowerCase() : key };
}

function createBatch(database, context, now) {
  const batchId = randomUUID();
  const events = database
    .prepare(
      `SELECT sequence, comment_ref FROM events
      WHERE review_kind = ? AND context_key = ? AND status = 'pending' AND batch_id IS NULL
      ORDER BY sequence`,
    )
    .all(context.kind, context.key);
  if (events.length === 0) fail("No pending events for review context");
  database
    .prepare(
      `INSERT INTO batches(
        id, pull_request_url, status, attempts, next_attempt_at, lease_id,
        write_key, last_error, created_at, updated_at, review_kind, context_key
      ) VALUES (?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(batchId, context.key, now, now, context.kind, context.key);
  database
    .prepare(
      "UPDATE events SET batch_id = ?, updated_at = ? WHERE review_kind = ? AND context_key = ? AND status = 'pending' AND batch_id IS NULL",
    )
    .run(batchId, now, context.kind, context.key);
  ensureBatchOperations(database, batchId);
  return batchId;
}

function claim(database, context, writeKey) {
  if (context.kind === "branch" && writeKey !== undefined) {
    fail("Branch Review batches are read-only and cannot reserve a write key");
  }
  if (writeKey !== undefined && getMeta(database, "own_mode") !== "fix-and-push") {
    fail("Task policy is investigate-and-reply and cannot reserve a write key");
  }
  const canonicalWriteKey = writeKey === undefined ? undefined : normalizeWriteKey(writeKey);
  return transaction(database, () => {
    const now = new Date().toISOString();
    const active = database
      .prepare(
        "SELECT id FROM batches WHERE review_kind = ? AND context_key = ? AND status = 'in_flight'",
      )
      .get(context.kind, context.key);
    if (active) fail("Review context already has an in-flight batch");
    let batch = database
      .prepare(
        `SELECT * FROM batches
        WHERE review_kind = ? AND context_key = ? AND status = 'pending'
        ORDER BY created_at LIMIT 1`,
      )
      .get(context.kind, context.key);
    if (batch?.next_attempt_at && batch.next_attempt_at > now) fail("Batch retry is not due yet");
    const batchId = batch?.id ?? createBatch(database, context, now);
    batch = database.prepare("SELECT * FROM batches WHERE id = ?").get(batchId);
    const leaseId = randomUUID();
    try {
      database
        .prepare(
          `UPDATE batches SET status = 'in_flight', attempts = attempts + 1,
            lease_id = ?, write_key = ?, updated_at = ? WHERE id = ?`,
        )
        .run(leaseId, canonicalWriteKey ?? null, now, batchId);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        fail(`Another write-capable batch owns repository ${canonicalWriteKey}`);
      }
      throw error;
    }
    const events = database
      .prepare(
        `SELECT sequence, post_id, comment_ref, review_kind, context_key
        FROM events WHERE batch_id = ? AND status = 'pending' ORDER BY sequence`,
      )
      .all(batchId)
      .map((event) => ({
        sequence: Number(event.sequence),
        postId: event.post_id,
        commentRef: event.comment_ref,
        context:
          event.review_kind === "branch"
            ? { kind: "branch", repository: event.context_key }
            : { kind: "pull-request", pullRequestUrl: event.context_key },
      }));
    ensureBatchOperations(database, batchId);
    const operations = database
      .prepare(
        `SELECT comment_ref, idempotency_key, post_id FROM operations
        WHERE batch_id = ? ORDER BY comment_ref`,
      )
      .all(batchId)
      .map((operation) => ({
        commentRef: operation.comment_ref,
        idempotencyKey: operation.idempotency_key,
        statusPostId: operation.post_id,
      }));
    return {
      leaseId,
      batchId,
      context:
        context.kind === "branch"
          ? { kind: "branch", repository: context.key }
          : { kind: "pull-request", pullRequestUrl: context.key },
      ...(context.kind === "pull-request" ? { pullRequest: context.key } : {}),
      ...(context.kind === "branch" ? { repository: context.key } : {}),
      attempts: Number(batch.attempts) + 1,
      writeKey: canonicalWriteKey ?? null,
      events,
      operations,
    };
  });
}

function reserveWrite(database, leaseId, writeKey) {
  const canonicalWriteKey = normalizeWriteKey(writeKey);
  return transaction(database, () => {
    const batch = database
      .prepare("SELECT * FROM batches WHERE lease_id = ? AND status = 'in_flight'")
      .get(leaseId);
    if (!batch) fail("Active lease was not found");
    if (batch.review_kind === "branch") {
      fail("Branch Review batches are investigate-and-reply only");
    }
    if (getMeta(database, "own_mode") !== "fix-and-push") {
      fail("Task policy is investigate-and-reply and cannot reserve a write key");
    }
    if (batch.write_key !== null && batch.write_key !== canonicalWriteKey) {
      fail(`Active lease already owns repository ${batch.write_key}`);
    }
    try {
      database
        .prepare("UPDATE batches SET write_key = ?, updated_at = ? WHERE id = ?")
        .run(canonicalWriteKey, new Date().toISOString(), batch.id);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        fail(`Another write-capable batch owns repository ${canonicalWriteKey}`);
      }
      throw error;
    }
    return {
      leaseId,
      batchId: batch.id,
      context:
        batch.review_kind === "branch"
          ? { kind: "branch", repository: batch.context_key }
          : { kind: "pull-request", pullRequestUrl: batch.context_key },
      writeKey: canonicalWriteKey,
      status: batch.write_key === canonicalWriteKey ? "existing" : "reserved",
    };
  });
}

function acknowledge(database, leaseId, input) {
  if (typeof input.commentRef !== "string" || input.commentRef.length === 0) {
    fail("commentRef is required");
  }
  if (typeof input.postId !== "string" || input.postId.length === 0) fail("postId is required");
  return transaction(database, () => {
    const batch = database
      .prepare("SELECT * FROM batches WHERE lease_id = ? AND status = 'in_flight'")
      .get(leaseId);
    if (!batch) fail("Active lease was not found");
    const operation = database
      .prepare("SELECT post_id FROM operations WHERE batch_id = ? AND comment_ref = ?")
      .get(batch.id, input.commentRef);
    if (!operation) fail("Comment is not part of the active lease");
    const now = new Date().toISOString();
    if (operation.post_id !== null && operation.post_id !== input.postId) {
      fail("Batch operation already has another status post");
    }
    database
      .prepare("UPDATE operations SET post_id = ? WHERE batch_id = ? AND comment_ref = ?")
      .run(input.postId, batch.id, input.commentRef);
    database
      .prepare("INSERT OR IGNORE INTO suppressed_posts(post_id, created_at) VALUES (?, ?)")
      .run(input.postId, now);
    database
      .prepare(
        "UPDATE events SET status = 'completed', updated_at = ? WHERE post_id = ? AND status = 'pending'",
      )
      .run(now, input.postId);
    return {
      batchId: batch.id,
      commentRef: input.commentRef,
      statusPostId: input.postId,
      status: operation.post_id === null ? "recorded" : "existing",
    };
  });
}

function complete(database, leaseId, input) {
  const postIds = Array.isArray(input.postIds) ? [...new Set(input.postIds)] : [];
  if (postIds.some((postId) => typeof postId !== "string" || postId.length === 0)) {
    fail("postIds must contain strings");
  }
  return transaction(database, () => {
    const batch = database
      .prepare("SELECT * FROM batches WHERE lease_id = ? AND status = 'in_flight'")
      .get(leaseId);
    if (!batch) fail("Active lease was not found");
    const now = new Date().toISOString();
    for (const postId of postIds) {
      database
        .prepare("INSERT OR IGNORE INTO suppressed_posts(post_id, created_at) VALUES (?, ?)")
        .run(postId, now);
      database
        .prepare(
          "UPDATE events SET status = 'completed', updated_at = ? WHERE post_id = ? AND status = 'pending'",
        )
        .run(now, postId);
    }
    database
      .prepare(
        "UPDATE events SET status = 'completed', updated_at = ? WHERE batch_id = ? AND status = 'pending'",
      )
      .run(now, batch.id);
    database
      .prepare(
        `UPDATE batches SET status = 'completed', lease_id = NULL, write_key = NULL,
          next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, batch.id);
    return { batchId: batch.id, status: "completed", suppressedPostIds: postIds };
  });
}

function failLease(database, leaseId, input) {
  if (typeof input.error !== "string" || input.error.length === 0) fail("error is required");
  return transaction(database, () => {
    const batch = database
      .prepare("SELECT * FROM batches WHERE lease_id = ? AND status = 'in_flight'")
      .get(leaseId);
    if (!batch) fail("Active lease was not found");
    const attempts = Number(batch.attempts);
    const retryable = input.retryable !== false;
    const quarantine = !retryable || attempts >= 3;
    const delaySeconds = attempts === 1 ? 10 : 60;
    const now = new Date();
    const nextAttemptAt = quarantine
      ? null
      : new Date(now.getTime() + delaySeconds * 1_000).toISOString();
    database
      .prepare(
        `UPDATE batches SET status = ?, next_attempt_at = ?, lease_id = NULL,
          write_key = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        quarantine ? "quarantined" : "pending",
        nextAttemptAt,
        input.error,
        now.toISOString(),
        batch.id,
      );
    return {
      batchId: batch.id,
      status: quarantine ? "quarantined" : "pending",
      attempts,
      nextAttemptAt,
      ...(quarantine ? { operations: batchStatusOperations(database, batch.id) } : {}),
    };
  });
}

function recover(database) {
  return transaction(database, () => {
    const batches = database.prepare("SELECT * FROM batches WHERE status = 'in_flight'").all();
    const now = new Date().toISOString();
    let pending = 0;
    let quarantined = 0;
    for (const batch of batches) {
      const quarantine = Number(batch.attempts) >= 3;
      database
        .prepare(
          `UPDATE batches SET status = ?, next_attempt_at = ?, lease_id = NULL,
            write_key = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          quarantine ? "quarantined" : "pending",
          quarantine ? null : now,
          "Worker was interrupted before reporting a final result",
          now,
          batch.id,
        );
      if (quarantine) quarantined += 1;
      else pending += 1;
    }
    return {
      recovered: batches.length,
      pending,
      quarantined,
      quarantinedBatches: quarantinedBatches(database),
    };
  });
}

function status(database) {
  const batchCounts = Object.fromEntries(
    database
      .prepare("SELECT status, count(*) AS count FROM batches GROUP BY status")
      .all()
      .map((row) => [row.status, Number(row.count)]),
  );
  const unbatched = database
    .prepare("SELECT count(*) AS count FROM events WHERE status = 'pending' AND batch_id IS NULL")
    .get();
  const inFlightBatches = database
    .prepare(
      `SELECT id, review_kind, context_key, attempts, lease_id, write_key, updated_at
      FROM batches WHERE status = 'in_flight' ORDER BY created_at`,
    )
    .all()
    .map((batch) => ({
      batchId: batch.id,
      leaseId: batch.lease_id,
      context:
        batch.review_kind === "branch"
          ? { kind: "branch", repository: batch.context_key }
          : { kind: "pull-request", pullRequestUrl: batch.context_key },
      ...(batch.review_kind === "pull-request" ? { pullRequest: batch.context_key } : {}),
      ...(batch.review_kind === "branch" ? { repository: batch.context_key } : {}),
      attempts: Number(batch.attempts),
      writeKey: batch.write_key,
      updatedAt: batch.updated_at,
      operations: batchStatusOperations(database, batch.id),
    }));
  return {
    taskId: getMeta(database, "task_id"),
    databaseId: getMeta(database, "database_id"),
    cursor: getMeta(database, "cursor"),
    expectedGitHubLogin: getMeta(database, "expected_login") || null,
    ownPullRequests: getMeta(database, "own_mode"),
    otherPullRequests: "investigate-and-reply",
    batches: {
      pending: batchCounts.pending ?? 0,
      inFlight: batchCounts.in_flight ?? 0,
      completed: batchCounts.completed ?? 0,
      quarantined: batchCounts.quarantined ?? 0,
      unbatchedEvents: Number(unbatched.count),
    },
    inFlightBatches,
    quarantinedBatches: quarantinedBatches(database),
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) fail("A command is required");
  const options = parseOptions(rest);
  const statePath = required(options, "state");
  const { database, absolute } = openState(statePath, command === "init");
  try {
    if (command === "init") {
      const taskId = initialize(database, options);
      write({ ok: true, state: absolute, taskId, ...status(database) });
      return;
    }
    if (!getMeta(database, "task_id")) fail("State database is not initialized");
    if (command === "ingest") {
      const frame = await readInput();
      const result =
        frame.type === "ready"
          ? ingestReady(database, frame)
          : frame.type === "comment-posted"
            ? ingestEvent(database, frame)
            : frame.type === "stopped"
              ? { status: "stopped", cursor: getMeta(database, "cursor") }
              : fail("Unsupported watch frame");
      write({ ok: true, ...result });
      return;
    }
    if (command === "list") {
      write({ ok: true, pending: listPending(database) });
      return;
    }
    if (command === "wait") {
      await waitForPending(database, options);
      return;
    }
    if (command === "claim") {
      const context = reviewContextFromOptions(options);
      write({
        ok: true,
        ...claim(database, context, options["write-key"]),
      });
      return;
    }
    if (command === "reserve-write") {
      write({
        ok: true,
        ...reserveWrite(database, required(options, "lease"), required(options, "write-key")),
      });
      return;
    }
    if (command === "complete") {
      write({ ok: true, ...complete(database, required(options, "lease"), await readInput()) });
      return;
    }
    if (command === "ack") {
      write({ ok: true, ...acknowledge(database, required(options, "lease"), await readInput()) });
      return;
    }
    if (command === "fail") {
      write({ ok: true, ...failLease(database, required(options, "lease"), await readInput()) });
      return;
    }
    if (command === "recover") {
      write({ ok: true, ...recover(database) });
      return;
    }
    if (command === "status") {
      write({ ok: true, state: absolute, ...status(database) });
      return;
    }
    fail(`Unknown command: ${command}`);
  } finally {
    database.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
  process.exitCode = 1;
}
