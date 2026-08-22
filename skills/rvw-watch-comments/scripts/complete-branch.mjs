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
      outcome.commentRef.length === 0 ||
      typeof outcome.body !== "string" ||
      outcome.body.trim().length === 0
    ) {
      fail("Each outcome requires commentRef and a non-empty body");
    }
    if (outcomes.has(outcome.commentRef)) fail(`Duplicate outcome: ${outcome.commentRef}`);
    if (
      outcome.relatedCommitOid !== null &&
      (typeof outcome.relatedCommitOid !== "string" ||
        !/^[0-9a-f]{40}$/.test(outcome.relatedCommitOid))
    ) {
      fail("Branch Review relatedCommitOid must be null or a lowercase 40-hex commit OID");
    }
    if (!Array.isArray(outcome.references)) {
      fail("Branch Review outcomes must include the complete references array");
    }
    if (outcome.references.length > 0 && outcome.relatedCommitOid === null) {
      fail("Branch Review outcomes with references require relatedCommitOid");
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
        fail(`Invalid Branch Review reference: ${outcome.commentRef}`);
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
        fail(`Invalid Branch Review reference line range: ${reference.id}`);
      }
      if (
        reference.description !== undefined &&
        reference.description !== null &&
        typeof reference.description !== "string"
      ) {
        fail(`Invalid Branch Review reference description: ${reference.id}`);
      }
      referenceIds.add(reference.id);
    }
    if (outcome.pushStatus !== "not-attempted")
      fail("Branch Review outcomes must use pushStatus: not-attempted");
    outcomes.set(outcome.commentRef, outcome);
  }
  if (outcomes.size !== operations.length) fail("One final outcome is required per operation");
  return operations.map((operation) => {
    const outcome = outcomes.get(operation.commentRef);
    if (!outcome) fail(`Missing final outcome: ${operation.commentRef}`);
    return { operation, outcome };
  });
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
  if (batch.context?.kind !== "branch") fail("complete-branch only accepts a Branch Review lease");
  if (batch.writeKey !== null) fail("Branch Review lease must not own a write key");
  if (typeof input.leaseId !== "string" || input.leaseId.length === 0) {
    fail("Worker leaseId is required");
  }
  if (input.leaseId !== leaseId) fail("Worker leaseId does not match");
  if (
    !input.context ||
    typeof input.context !== "object" ||
    input.context.kind !== "branch" ||
    typeof input.context.repository !== "string" ||
    input.context.repository.length === 0
  ) {
    fail("Worker Branch context is required");
  }
  if (input.context.repository !== batch.context.repository)
    fail("Worker context does not match the Branch Review lease");
  const pending = validatedOutcomes(input, batch.operations ?? []);
  for (const { operation } of pending) {
    if (typeof operation.idempotencyKey !== "string" || operation.idempotencyKey.length === 0) {
      fail(`Missing stable idempotency key: ${operation.commentRef}`);
    }
  }
  const replies = [];
  for (const { operation, outcome } of pending) {
    const reply = {
      body: outcome.body,
      relatedCommitOid: outcome.relatedCommitOid,
      references: outcome.references,
      idempotencyKey: operation.idempotencyKey,
    };
    const result = await runRvw(["comment", "reply", operation.commentRef, "--stdin", "--json"], {
      input: reply,
    });
    if (!successfulJson(result) || typeof result.json?.post?.id !== "string") {
      fail(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `Final reply failed: ${operation.commentRef}`,
      );
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
      type: "branch-completed",
      context: batch.context,
      leaseId,
      replies,
      completion: completed,
    })}\n`,
  );
}

await main();
