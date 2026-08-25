#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runRvw, successfulJson } from "./rvw-command.mjs";

const stateScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "watch-state.mjs");

function fail(message) {
  throw new Error(message);
}

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`Invalid argument: ${key ?? ""}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) fail(`--${key} is required`);
  return value;
}

async function readInput() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  if (!value.trim()) fail("stdin JSON is required");
  return JSON.parse(value);
}

async function runState(state, command, args = [], input) {
  const child = spawn(process.execPath, [stateScript, command, "--state", state, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  if (code !== 0) fail(Buffer.concat(stderr).toString("utf8").trim() || `${command} failed`);
  return JSON.parse(stdoutText);
}

function validatedOutcomes(input, operations) {
  if (!Array.isArray(input.outcomes)) fail("outcomes must be an array");
  const outcomes = new Map();
  for (const outcome of input.outcomes) {
    if (
      !outcome ||
      typeof outcome !== "object" ||
      typeof outcome.commentRef !== "string" ||
      outcome.commentRef.length === 0
    ) {
      fail("Each outcome requires commentRef");
    }
    if (outcomes.has(outcome.commentRef)) fail(`Duplicate outcome: ${outcome.commentRef}`);
    const status = outcome.status ?? "reply";
    if (status === "gone") {
      outcomes.set(outcome.commentRef, { commentRef: outcome.commentRef, status });
      continue;
    }
    if (status !== "reply") fail(`Invalid Repository Review outcome status: ${status}`);
    if (typeof outcome.body !== "string" || outcome.body.trim().length === 0) {
      fail("Each reply outcome requires a non-empty body");
    }
    if (
      outcome.relatedCommitOid !== null &&
      (typeof outcome.relatedCommitOid !== "string" ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(outcome.relatedCommitOid))
    ) {
      fail(
        "Repository Review relatedCommitOid must be null or a 40- or 64-character lowercase hex commit OID",
      );
    }
    if (!Array.isArray(outcome.references)) {
      fail("Repository Review outcomes must include the complete references array");
    }
    if (outcome.references.length > 0 && outcome.relatedCommitOid === null) {
      fail("Repository Review outcomes with references require relatedCommitOid");
    }
    const referenceIds = new Set();
    for (const reference of outcome.references) {
      if (
        !reference ||
        typeof reference !== "object" ||
        typeof reference.id !== "string" ||
        reference.id.length === 0 ||
        referenceIds.has(reference.id) ||
        typeof reference.label !== "string" ||
        reference.label.trim().length === 0 ||
        typeof reference.path !== "string" ||
        reference.path.length === 0
      ) {
        fail(`Invalid Repository Review reference: ${outcome.commentRef}`);
      }
      const startLine = reference.startLine ?? null;
      const endLine = reference.endLine ?? null;
      if (
        (startLine === null) !== (endLine === null) ||
        (startLine !== null &&
          (!Number.isInteger(startLine) ||
            !Number.isInteger(endLine) ||
            startLine < 1 ||
            endLine < startLine))
      ) {
        fail(`Invalid Repository Review reference line range: ${reference.id}`);
      }
      if (
        reference.description !== undefined &&
        reference.description !== null &&
        typeof reference.description !== "string"
      ) {
        fail(`Invalid Repository Review reference description: ${reference.id}`);
      }
      referenceIds.add(reference.id);
    }
    if (outcome.pushStatus !== "not-attempted")
      fail("Repository Review outcomes must use pushStatus: not-attempted");
    outcomes.set(outcome.commentRef, { ...outcome, status });
  }
  if (outcomes.size !== operations.length) fail("One final outcome is required per operation");
  return operations.map((operation) => {
    const outcome = outcomes.get(operation.commentRef);
    if (!outcome) fail(`Missing final outcome: ${operation.commentRef}`);
    return { operation, outcome };
  });
}

function isGone(result) {
  return (
    result.json?.ok === false &&
    ["COMMENT_NOT_FOUND", "NOT_FOUND"].includes(result.json?.error?.code)
  );
}

function commandFailure(command, commentRef, result) {
  return result.stderr.trim() || result.stdout.trim() || `${command} failed: ${commentRef}`;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const state = path.resolve(required(options, "state"));
  const leaseId = required(options, "lease");
  const input = await readInput();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("Worker result must be an object");
  }
  const status = await runState(state, "status");
  const batch = status.inFlightBatches?.find((candidate) => candidate.leaseId === leaseId);
  if (!batch) fail("Active lease was not found");
  if (batch.context?.kind !== "repository")
    fail("complete-repository only accepts a Repository Review lease");
  if (batch.writeKey !== null) fail("Repository Review lease must not own a write key");
  if (typeof input.leaseId !== "string" || input.leaseId.length === 0) {
    fail("Worker leaseId is required");
  }
  if (input.leaseId !== leaseId) fail("Worker leaseId does not match");
  if (
    !input.context ||
    typeof input.context !== "object" ||
    input.context.kind !== "repository" ||
    typeof input.context.repositoryReviewId !== "string" ||
    input.context.repositoryReviewId.length === 0 ||
    typeof input.context.repository !== "string" ||
    input.context.repository.length === 0
  ) {
    fail("Worker Repository Review context is required");
  }
  if (
    input.context.repositoryReviewId !== batch.context.repositoryReviewId ||
    input.context.repository !== batch.context.repository
  )
    fail("Worker context does not match the Repository Review lease");
  const pending = validatedOutcomes(input, batch.operations ?? []);
  for (const { operation } of pending) {
    if (typeof operation.idempotencyKey !== "string" || operation.idempotencyKey.length === 0) {
      fail(`Missing stable idempotency key: ${operation.commentRef}`);
    }
  }
  const replies = [];
  const gone = [];
  for (const { operation, outcome } of pending) {
    const current = await runRvw(["comment", "get", operation.commentRef, "--json"]);
    if (isGone(current)) {
      gone.push({
        commentRef: operation.commentRef,
        status: "gone",
        reason: outcome.status === "gone" ? "confirmed" : "deleted-before-reply",
      });
      continue;
    }
    if (!successfulJson(current)) {
      fail(commandFailure("comment get", operation.commentRef, current));
    }
    if (outcome.status === "gone") {
      fail(`Outcome reported gone but the Comment still exists: ${operation.commentRef}`);
    }
    const reply = {
      body: outcome.body,
      relatedCommitOid: outcome.relatedCommitOid,
      references: outcome.references,
      idempotencyKey: operation.idempotencyKey,
    };
    const result = await runRvw(["comment", "reply", operation.commentRef, "--stdin", "--json"], {
      input: reply,
    });
    if (isGone(result)) {
      gone.push({
        commentRef: operation.commentRef,
        status: "gone",
        reason: "deleted-during-reply",
      });
      continue;
    }
    if (!successfulJson(result) || typeof result.json?.post?.id !== "string") {
      fail(commandFailure("Final reply", operation.commentRef, result));
    }
    replies.push({
      commentRef: operation.commentRef,
      idempotencyKey: operation.idempotencyKey,
      postId: result.json.post.id,
    });
  }
  const completed = await runState(state, "complete", ["--lease", leaseId], {
    postIds: replies.map((reply) => reply.postId),
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      type: "repository-completed",
      context: batch.context,
      leaseId,
      replies,
      gone,
      completion: completed,
    })}\n`,
  );
}

await main();
