import { spawn } from "node:child_process";
import {
  DEFAULT_PROCESS_STDERR_BYTES,
  DEFAULT_PROCESS_STDOUT_BYTES,
  DEFAULT_PROCESS_TIMEOUT_MS,
} from "../../shared/constants.js";
import { RvwError } from "../../shared/errors.js";

export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  stdoutTruncated: boolean;
}

export interface RunProcessOptions {
  cwd?: string;
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: NodeJS.ProcessEnv;
  allowExitCodes?: number[];
  truncateStdout?: boolean;
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_PROCESS_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_PROCESS_STDERR_BYTES;

  return await new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    });

    const finishWithError = (error: RvwError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };

    const timer = setTimeout(() => {
      finishWithError(
        new RvwError("PROCESS_TIMEOUT", `${executable} の実行がタイムアウトしました。`, {
          details: { executable, args, timeoutMs },
        }),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        if (options.truncateStdout) {
          const previousBytes = stdoutBytes - chunk.length;
          const remaining = Math.max(0, maxStdoutBytes - previousBytes);
          if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
          stdoutTruncated = true;
          child.kill("SIGTERM");
          return;
        }
        finishWithError(
          new RvwError("PROCESS_OUTPUT_LIMIT", `${executable} の出力が上限を超えました。`, {
            details: { stream: "stdout", maxBytes: maxStdoutBytes },
          }),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        finishWithError(
          new RvwError("PROCESS_OUTPUT_LIMIT", `${executable} のエラー出力が上限を超えました。`, {
            details: { stream: "stderr", maxBytes: maxStderrBytes },
          }),
        );
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const notFoundCode =
        executable === "git"
          ? "GIT_NOT_FOUND"
          : executable === "gh"
            ? "GH_NOT_FOUND"
            : "PROCESS_FAILED";
      finishWithError(
        new RvwError(notFoundCode, `${executable} を起動できませんでした。`, {
          cause: error,
          details: { executable, args, systemCode: error.code },
        }),
      );
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: exitCode ?? -1,
        stdoutTruncated,
      };
      if (
        !result.stdoutTruncated &&
        result.exitCode !== 0 &&
        !(options.allowExitCodes ?? []).includes(result.exitCode)
      ) {
        reject(
          new RvwError(
            "PROCESS_FAILED",
            `${executable} が終了コード ${result.exitCode} で失敗しました。`,
            {
              details: {
                executable,
                args,
                exitCode: result.exitCode,
                stderr: result.stderr.toString("utf8").trim(),
              },
            },
          ),
        );
        return;
      }
      resolve(result);
    });

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

export async function runText(
  executable: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<string> {
  const result = await runProcess(executable, args, options);
  return result.stdout.toString("utf8").trimEnd();
}
