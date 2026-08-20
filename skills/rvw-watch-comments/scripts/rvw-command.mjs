import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 40 * 1024 * 1024;

function commandPrefix() {
  const binary = process.env.RVW_BIN?.trim() || "rvw";
  const rawPrefix = process.env.RVW_BIN_ARGS_JSON;
  if (!rawPrefix) return { binary, prefix: [] };
  let parsed;
  try {
    parsed = JSON.parse(rawPrefix);
  } catch (error) {
    throw new Error(`RVW_BIN_ARGS_JSON must be a JSON string array: ${String(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("RVW_BIN_ARGS_JSON must be a JSON string array");
  }
  return { binary, prefix: parsed };
}

export function spawnRvw(args, options = {}) {
  const { binary, prefix } = commandPrefix();
  return spawn(binary, [...prefix, ...args], {
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
    env: process.env,
  });
}

export async function runRvw(args, options = {}) {
  const child = spawnRvw(args);
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= MAX_CAPTURE_BYTES) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_CAPTURE_BYTES) stderr.push(chunk);
  });
  if (options.input === undefined) child.stdin.end();
  else
    child.stdin.end(
      typeof options.input === "string" ? options.input : JSON.stringify(options.input),
    );
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES) {
    throw new Error("rvw command output exceeded 40 MiB");
  }
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  const stderrText = Buffer.concat(stderr).toString("utf8");
  let json = null;
  if (stdoutText.trim()) {
    try {
      json = JSON.parse(stdoutText);
    } catch {
      // The caller reports malformed output with the original stdout attached.
    }
  }
  return {
    args,
    binary: commandPrefix().binary,
    code: status.code,
    signal: status.signal,
    stdout: stdoutText,
    stderr: stderrText,
    json,
  };
}

export function successfulJson(result) {
  return result.code === 0 && result.json && result.json.ok !== false;
}
