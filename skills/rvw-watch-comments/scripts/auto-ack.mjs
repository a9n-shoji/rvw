#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRvw, successfulJson } from "./rvw-command.mjs";

const ACKNOWLEDGEMENT_BODY = "🔎 確認中です…";
const MAX_AUTHOR_LABEL_CHARACTERS = 100;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const stateScript = path.join(scriptDirectory, "watch-state.mjs");

function fail(message, details) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`Expected --name value, received ${key ?? ""}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) fail(`--${key} is required`);
  return value;
}

async function runState(state, command, args = [], input) {
  const { spawn } = await import("node:child_process");
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
  const stderrText = Buffer.concat(stderr).toString("utf8");
  let json = null;
  try {
    json = JSON.parse(stdoutText);
  } catch {
    // Report the original output below.
  }
  if (code !== 0 || !json?.ok) {
    fail(`watch-state ${command} failed`, { code, stdout: stdoutText, stderr: stderrText });
  }
  return json;
}

function rvwFailure(command, result) {
  return {
    command,
    exitCode: result.code,
    signal: result.signal,
    output: result.json,
    stderr: result.stderr.trim() || null,
    stdout: result.json ? null : result.stdout.trim() || null,
  };
}

function isGone(result) {
  return (
    result.json?.ok === false &&
    ["COMMENT_NOT_FOUND", "NOT_FOUND"].includes(result.json?.error?.code)
  );
}

async function acknowledgeOperation(state, leaseId, operation, threadResult) {
  if (isGone(threadResult)) {
    return {
      ...operation,
      status: "gone",
      acknowledgement: "skipped",
      thread: null,
    };
  }
  if (!successfulJson(threadResult)) {
    fail(`rvw comment get failed for ${operation.commentRef}`, {
      failure: rvwFailure("comment get", threadResult),
    });
  }
  if (operation.statusPostId === null) {
    const reply = await runRvw(["comment", "reply", operation.commentRef, "--stdin", "--json"], {
      input: {
        body: ACKNOWLEDGEMENT_BODY,
        idempotencyKey: operation.idempotencyKey,
        ...(operation.authorLabel === null ? {} : { authorLabel: operation.authorLabel }),
      },
    });
    if (!successfulJson(reply) || typeof reply.json?.post?.id !== "string") {
      fail(`rvw comment reply failed for ${operation.commentRef}`, {
        failure: rvwFailure("comment reply", reply),
      });
    }
    await runState(state, "ack", ["--lease", leaseId], {
      commentRef: operation.commentRef,
      postId: reply.json.post.id,
    });
    return {
      ...operation,
      statusPostId: reply.json.post.id,
      status: "acknowledged",
      acknowledgement: "created",
      thread: threadResult.json,
    };
  }
  const edit = await runRvw(
    [
      "comment",
      "edit",
      operation.commentRef,
      "--post",
      operation.statusPostId,
      "--stdin",
      "--json",
    ],
    {
      input: {
        body: ACKNOWLEDGEMENT_BODY,
        relatedCommitOid: null,
      },
    },
  );
  if (!successfulJson(edit)) {
    fail(`rvw comment edit failed for ${operation.commentRef}`, {
      failure: rvwFailure("comment edit", edit),
    });
  }
  await runState(state, "ack", ["--lease", leaseId], {
    commentRef: operation.commentRef,
    postId: operation.statusPostId,
  });
  return {
    ...operation,
    status: "acknowledged",
    acknowledgement: "restored",
    thread: threadResult.json,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const state = path.resolve(required(options, "state"));
  const pullRequest = required(options, "pull-request");
  const authorLabel = options["author-label"] ?? null;
  if (
    authorLabel !== null &&
    (authorLabel.length === 0 || authorLabel.length > MAX_AUTHOR_LABEL_CHARACTERS)
  ) {
    fail(`--author-label must contain 1 through ${MAX_AUTHOR_LABEL_CHARACTERS} characters`);
  }
  let claimed = null;
  try {
    const claimArgs = ["--pull-request", pullRequest];
    if (options["write-key"]) claimArgs.push("--write-key", options["write-key"]);
    claimed = await runState(state, "claim", claimArgs);
    const threadResults = await Promise.all(
      claimed.operations.map((operation) =>
        runRvw(["comment", "get", operation.commentRef, "--json"]),
      ),
    );
    const operations = [];
    for (let index = 0; index < claimed.operations.length; index += 1) {
      operations.push(
        await acknowledgeOperation(
          state,
          claimed.leaseId,
          { ...claimed.operations[index], authorLabel },
          threadResults[index],
        ),
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        type: "acknowledged",
        leaseId: claimed.leaseId,
        batchId: claimed.batchId,
        pullRequest: claimed.pullRequest,
        attempts: claimed.attempts,
        writeKey: claimed.writeKey,
        events: claimed.events,
        operations,
      })}\n`,
    );
  } catch (error) {
    let leaseFailure = null;
    if (claimed?.leaseId) {
      try {
        leaseFailure = await runState(state, "fail", ["--lease", claimed.leaseId], {
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      } catch (failError) {
        leaseFailure = { ok: false, error: String(failError) };
      }
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        details: error?.details ?? null,
        leaseFailure,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
