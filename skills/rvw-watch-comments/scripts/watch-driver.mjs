#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { spawnRvw } from "./rvw-command.mjs";

const EXIT_WATCH = 20;
const EXIT_SEQUENCE = 21;
const EXIT_INGEST = 22;
const EXIT_AUTO_ACK = 23;
const EXIT_ALREADY_RUNNING = 24;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const stateScript = path.join(scriptDirectory, "watch-state.mjs");
const autoAckScript = path.join(scriptDirectory, "auto-ack.mjs");
const DRIVER_LOCK_SUFFIX = ".watch-driver.lock";

class DriverError extends Error {
  constructor(message, exitCode, details = null) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}

function parseArguments(values) {
  let state = null;
  let autoAck = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--auto-ack") {
      autoAck = true;
      continue;
    }
    if (value === "--state") {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) {
        throw new DriverError("--state requires a path", EXIT_WATCH);
      }
      state = next;
      index += 1;
      continue;
    }
    if (!value.startsWith("--") && state === null) {
      state = value;
      continue;
    }
    throw new DriverError(`Unexpected argument: ${value}`, EXIT_WATCH);
  }
  if (!state) throw new DriverError("Pass the task state database path", EXIT_WATCH);
  return { state: path.resolve(state), autoAck };
}

async function runNodeScript(script, args, input) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  const stderrText = Buffer.concat(stderr).toString("utf8");
  let json = null;
  try {
    json = JSON.parse(stdoutText);
  } catch {
    // The caller selects the appropriate driver exit contract.
  }
  return { ...status, stdout: stdoutText, stderr: stderrText, json };
}

async function stateCommand(state, command, args = [], input) {
  const result = await runNodeScript(stateScript, [command, "--state", state, ...args], input);
  if (result.code !== 0 || !result.json?.ok) {
    throw new DriverError(`watch-state ${command} failed`, EXIT_INGEST, result);
  }
  return result.json;
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fileIdentity(filePath) {
  try {
    const stat = lstatSync(filePath);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function unlinkIfOwned(filePath, identity) {
  const current = fileIdentity(filePath);
  if (!identity || !current || current.dev !== identity.dev || current.ino !== identity.ino) return;
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function lockOwner(lockPath) {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8"));
    return Number.isInteger(value?.pid) && value.pid > 0 ? value : null;
  } catch {
    return null;
  }
}

function acquireDriverLock(state) {
  const canonicalState = realpathSync(state);
  const lockPath = `${canonicalState}${DRIVER_LOCK_SUFFIX}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stagingPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        stagingPath,
        `${JSON.stringify({ pid: process.pid, state: canonicalState, startedAt: new Date().toISOString() })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      chmodSync(stagingPath, 0o600);
      linkSync(stagingPath, lockPath);
    } catch (error) {
      try {
        unlinkSync(stagingPath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
      if (error.code !== "EEXIST") throw error;
      const observedIdentity = fileIdentity(lockPath);
      const owner = lockOwner(lockPath);
      // Preserve unreadable locks rather than risking two live drivers.
      if (!owner || processIsAlive(owner.pid)) {
        throw new DriverError(
          "Another watch-driver process already owns this task state",
          EXIT_ALREADY_RUNNING,
          {
            state: canonicalState,
            lockPath,
            ownerPid: owner?.pid ?? null,
          },
        );
      }
      unlinkIfOwned(lockPath, observedIdentity);
      continue;
    }
    try {
      const identity = fileIdentity(lockPath);
      if (!identity) throw new Error("Could not verify the watch-driver owner lock");
      unlinkSync(stagingPath);
      return { identity, path: lockPath };
    } catch (error) {
      const stagingIdentity = fileIdentity(stagingPath);
      unlinkIfOwned(lockPath, stagingIdentity);
      try {
        unlinkSync(stagingPath);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
      throw error;
    }
  }
  throw new DriverError("Could not acquire the watch-driver owner lock", EXIT_ALREADY_RUNNING, {
    state: canonicalState,
    lockPath,
  });
}

function releaseDriverLock(lock) {
  unlinkIfOwned(lock.path, lock.identity);
}

async function dispatchAutoAck(state, pullRequest) {
  const pending = await stateCommand(state, "list");
  if (!pending.pending.some((batch) => batch.pullRequest === pullRequest)) {
    write({ ok: true, type: "queued", pullRequest, reason: "batch-not-yet-eligible" });
    return;
  }
  const result = await runNodeScript(autoAckScript, [
    "--state",
    state,
    "--pull-request",
    pullRequest,
  ]);
  if (result.code !== 0 || !result.json?.ok) {
    throw new DriverError(`auto-ack failed for ${pullRequest}`, EXIT_AUTO_ACK, result);
  }
  write({ ...result.json, type: "batch-acknowledged" });
}

async function dispatchPendingAutoAcks(state) {
  const pending = await stateCommand(state, "list");
  for (const batch of pending.pending) {
    await dispatchAutoAck(state, batch.pullRequest);
  }
}

async function processFrame(state, frame, autoAck, pullRequests) {
  if (!frame || typeof frame !== "object" || typeof frame.type !== "string") {
    throw new DriverError("Invalid RFC 7464 frame", EXIT_SEQUENCE, frame);
  }
  if (frame.type === "error") {
    throw new DriverError("rvw comment watch returned an error frame", EXIT_WATCH, frame);
  }
  const ingested = await stateCommand(state, "ingest", [], frame);
  if (frame.type === "ready") {
    write({
      ok: true,
      type: "watch-ready",
      cursor: ingested.cursor,
      databaseId: frame.databaseId,
      anchoredAtCurrent: frame.anchoredAtCurrent,
      autoAck,
    });
  } else if (frame.type === "comment-posted" && ingested.status === "queued") {
    if (autoAck) pullRequests.add(frame.event.pullRequestUrl);
    else {
      write({
        ok: true,
        type: "pending",
        pullRequest: frame.event.pullRequestUrl,
        commentRef: frame.event.commentRef,
        cursor: ingested.cursor,
      });
    }
  }
}

async function runWatchOnce(state, autoAck, stopping) {
  const current = await stateCommand(state, "status");
  const args = ["comment", "watch"];
  if (current.cursor) args.push("--after", current.cursor);
  args.push("--interval", "1", "--json-seq");
  const child = spawnRvw(args);
  stopping.child = child;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const statusPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end();
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let readySeen = false;
  let stoppedSeen = false;
  try {
    for await (const chunk of child.stdout) {
      buffered += decoder.write(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      const pullRequests = new Set();
      for (const rawLine of lines) {
        if (!rawLine) continue;
        if (!rawLine.startsWith("\u001e")) {
          throw new DriverError("RFC 7464 frame does not start with RS", EXIT_SEQUENCE, rawLine);
        }
        let frame;
        try {
          frame = JSON.parse(rawLine.slice(1));
        } catch (error) {
          throw new DriverError("RFC 7464 frame is not valid JSON", EXIT_SEQUENCE, String(error));
        }
        readySeen ||= frame.type === "ready";
        stoppedSeen ||= frame.type === "stopped";
        await processFrame(state, frame, autoAck, pullRequests);
      }
      for (const pullRequest of pullRequests) await dispatchAutoAck(state, pullRequest);
    }
    buffered += decoder.end();
    if (buffered.trim()) {
      throw new DriverError(
        "rvw comment watch ended with a truncated frame",
        EXIT_SEQUENCE,
        buffered,
      );
    }
    const status = await statusPromise;
    stopping.child = null;
    return { ...status, stderr, readySeen, stoppedSeen };
  } catch (error) {
    child.kill("SIGTERM");
    await statusPromise.catch(() => undefined);
    stopping.child = null;
    throw error;
  }
}

function retryDelay(attempt) {
  const base = Number(process.env.RVW_WATCH_DRIVER_RETRY_MS ?? "1000");
  const safeBase = Number.isFinite(base) && base >= 0 ? base : 1000;
  return Math.min(safeBase * 2 ** Math.max(0, attempt - 1), 30_000);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const { state, autoAck } = parseArguments(process.argv.slice(2));
  const driverLock = acquireDriverLock(state);
  try {
    const stopping = { requested: false, child: null };
    const stop = () => {
      stopping.requested = true;
      stopping.child?.kill("SIGTERM");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const maxRestarts = Number(process.env.RVW_WATCH_DRIVER_MAX_RESTARTS ?? "5");
    let restarts = 0;
    try {
      while (!stopping.requested) {
        const startedAt = Date.now();
        if (autoAck) await dispatchPendingAutoAcks(state);
        const result = await runWatchOnce(state, autoAck, stopping);
        if (stopping.requested) return;
        if (Date.now() - startedAt >= 30_000) restarts = 0;
        restarts += 1;
        if (restarts > maxRestarts) {
          throw new DriverError(
            "rvw comment watch exceeded its reconnect limit",
            EXIT_WATCH,
            result,
          );
        }
        const delayMs = retryDelay(restarts);
        write({
          ok: true,
          type: "reconnecting",
          attempt: restarts,
          delayMs,
          lastExitCode: result.code,
          lastSignal: result.signal,
          readySeen: result.readySeen,
        });
        await delay(delayMs);
      }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    releaseDriverLock(driverLock);
  }
}

try {
  await main();
} catch (error) {
  const exitCode = error instanceof DriverError ? error.exitCode : EXIT_WATCH;
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      details: error?.details ?? null,
      exitCode,
    })}\n`,
  );
  process.exitCode = exitCode;
}
