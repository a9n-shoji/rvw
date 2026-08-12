import { randomUUID } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import type {
  ChangedFile,
  CommitSummary,
  DocumentAvailability,
  SearchOptions,
  SearchResult,
  TreeEntry,
  TreeEntryKind,
} from "../../domain/models.js";
import {
  MAX_MARKDOWN_ASSET_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_STDOUT_BYTES,
  MAX_TEXT_DOCUMENT_BYTES,
} from "../../shared/constants.js";
import { findFixedStringMatches } from "../../domain/search.js";
import { RvwError } from "../../shared/errors.js";
import { runProcess, runText } from "../process/run-process.js";

const utf8Fatal = new TextDecoder("utf-8", { fatal: true });

export interface RepositoryContext {
  worktreePath: string;
  gitCommonDir: string;
}

export interface HeadState {
  oid: string;
  branch: string | null;
}

export interface WorktreeStatus {
  entries: string[];
  trackedEntries: string[];
  untrackedEntries: string[];
}

export interface EnsuredCommitRef {
  ref: string;
  created: boolean;
}

export interface BlobContent {
  availability: DocumentAvailability;
  text: string | null;
  byteLength: number | null;
  entryKind: TreeEntryKind;
  oid: string | null;
  normalizedLineEndings: boolean;
}

export interface RepositoryAsset {
  content: Buffer;
  oid: string;
  byteLength: number;
}

export interface SearchGitResult {
  results: Array<Omit<SearchResult, "document">>;
  truncated: boolean;
  stdoutBytes: number;
}

function assertGitPath(filePath: string): void {
  if (
    filePath.length === 0 ||
    filePath.includes("\0") ||
    path.posix.isAbsolute(filePath) ||
    filePath.split("/").includes("..")
  ) {
    throw new RvwError("INVALID_INPUT", `Git pathが不正です: ${filePath}`);
  }
}

function kindFor(mode: string, type: string): TreeEntryKind {
  if (mode === "120000") return "symlink";
  if (mode === "160000" || type === "commit") return "submodule";
  return "file";
}

export function parseLsTree(buffer: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const raw of buffer.toString("utf8").split("\0")) {
    if (raw.length === 0) continue;
    const tab = raw.indexOf("\t");
    if (tab < 0) throw new RvwError("INTERNAL_ERROR", "git ls-treeの出力を解析できません。");
    const metadata = raw.slice(0, tab).trim().split(/\s+/);
    const [mode, type, oid, sizeValue] = metadata;
    if (!mode || !type || !oid || sizeValue === undefined) {
      throw new RvwError("INTERNAL_ERROR", "git ls-treeのメタデータが不正です。");
    }
    entries.push({
      mode,
      type: type === "commit" ? "commit" : "blob",
      oid,
      size: sizeValue === "-" ? null : Number(sizeValue),
      path: raw.slice(tab + 1),
      kind: kindFor(mode, type),
    });
  }
  return entries;
}

export function parseNameStatus(buffer: Buffer): ChangedFile[] {
  const values = buffer.toString("utf8").split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index < values.length;) {
    const status = values[index++];
    if (!status) continue;
    const code = status[0];
    const similarityValue = status.slice(1);
    if (code === "R" || code === "C") {
      const oldPath = values[index++];
      const newPath = values[index++];
      if (oldPath === undefined || newPath === undefined) {
        throw new RvwError("INTERNAL_ERROR", "git diff --name-statusのrename出力が不正です。");
      }
      files.push({
        kind: "renamed",
        status,
        similarity: similarityValue ? Number(similarityValue) : null,
        oldPath,
        newPath,
      });
      continue;
    }
    const filePath = values[index++];
    if (filePath === undefined) {
      throw new RvwError("INTERNAL_ERROR", "git diff --name-statusの出力が不正です。");
    }
    const kind =
      code === "A"
        ? "added"
        : code === "D"
          ? "deleted"
          : code === "T"
            ? "type-changed"
            : "modified";
    files.push({
      kind,
      status,
      similarity: null,
      oldPath: code === "A" ? null : filePath,
      newPath: code === "D" ? null : filePath,
    });
  }
  return files;
}

export function parseCommitLog(value: string): CommitSummary[] {
  const commits: CommitSummary[] = [];
  for (const rawRecord of value.split("\x1e")) {
    const record = rawRecord.replace(/^\n+|\n+$/g, "");
    if (!record) continue;
    const [oid, parents, authorName, authoredAt, subject, ...extra] = record.split("\0");
    if (
      !oid ||
      parents === undefined ||
      !authorName ||
      !authoredAt ||
      subject === undefined ||
      extra.length > 0
    ) {
      throw new RvwError("INTERNAL_ERROR", "git logの出力を解析できません。");
    }
    commits.push({
      oid,
      parentOids: parents ? parents.split(" ") : [],
      subject,
      authorName,
      authoredAt,
    });
  }
  return commits;
}

function parseGithubRemote(remote: string): { owner: string; repository: string } | null {
  const normalized = remote.trim().replace(/\.git$/, "");
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+)$/.exec(
      normalized,
    );
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repository: match[2] };
}

export class GitClient {
  async doctor(cwd: string): Promise<{ version: string; repository: RepositoryContext | null }> {
    const version = await runText("git", ["--version"]);
    let repository: RepositoryContext | null = null;
    try {
      repository = await this.repositoryContext(cwd);
    } catch (error) {
      if (!(error instanceof RvwError) || error.code !== "NOT_IN_GIT_REPOSITORY") throw error;
    }
    return { version, repository };
  }

  async repositoryContext(cwd: string): Promise<RepositoryContext> {
    try {
      const [rootValue, commonValue] = await Promise.all([
        runText("git", ["rev-parse", "--show-toplevel"], { cwd }),
        runText("git", ["rev-parse", "--git-common-dir"], { cwd }),
      ]);
      const worktreePath = path.resolve(cwd, rootValue);
      return {
        worktreePath,
        gitCommonDir: path.isAbsolute(commonValue)
          ? path.resolve(commonValue)
          : path.resolve(worktreePath, commonValue),
      };
    } catch (error) {
      if (error instanceof RvwError && error.code === "PROCESS_FAILED") {
        throw new RvwError("NOT_IN_GIT_REPOSITORY", `${cwd} はGit repositoryではありません。`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async assertBaseRepository(cwd: string, owner: string, repository: string): Promise<string> {
    const remoteNames = (await runText("git", ["remote"], { cwd }))
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const remoteName of remoteNames) {
      const urls = (await runText("git", ["remote", "get-url", "--all", remoteName], { cwd }))
        .split("\n")
        .filter(Boolean);
      for (const url of urls) {
        const parsed = parseGithubRemote(url);
        if (
          parsed &&
          parsed.owner.toLowerCase() === owner.toLowerCase() &&
          parsed.repository.toLowerCase() === repository.toLowerCase()
        ) {
          return url;
        }
      }
    }
    throw new RvwError(
      "REPOSITORY_MISMATCH",
      `現在のrepositoryは ${owner}/${repository} のbase repository cloneではありません。`,
      {
        suggestions: [
          `${owner}/${repository} をcloneしたrepositoryまたはそのworktreeから実行してください。`,
        ],
      },
    );
  }

  async hasObject(cwd: string, oid: string): Promise<boolean> {
    const result = await runProcess("git", ["cat-file", "-e", `${oid}^{commit}`], {
      cwd,
      allowExitCodes: [1, 128],
    });
    return result.exitCode === 0;
  }

  async ensurePullRequestObjects(input: {
    cwd: string;
    remoteUrl: string;
    number: number;
    baseRefName: string;
    baseOid: string;
    headOid: string;
  }): Promise<void> {
    const operationId = randomUUID();
    const prefix = `refs/rvw/tmp/${operationId}`;
    try {
      if (!(await this.hasObject(input.cwd, input.headOid))) {
        const temporaryRef = `${prefix}/head`;
        await runProcess(
          "git",
          [
            "fetch",
            "--no-write-fetch-head",
            "--no-tags",
            input.remoteUrl,
            `+refs/pull/${input.number}/head:${temporaryRef}`,
          ],
          { cwd: input.cwd, timeoutMs: 120_000 },
        );
        const fetched = await runText("git", ["rev-parse", temporaryRef], { cwd: input.cwd });
        if (fetched !== input.headOid) {
          throw new RvwError(
            "LOCAL_STATE_INCONSISTENT",
            "取得したPR headがGitHubのOIDと一致しません。",
            {
              details: { expected: input.headOid, actual: fetched },
              suggestions: [`rvw pr reset https://github.com/.../pull/${input.number} --yes`],
            },
          );
        }
      }
      if (!(await this.hasObject(input.cwd, input.baseOid))) {
        const temporaryRef = `${prefix}/base-tip`;
        await runProcess(
          "git",
          [
            "fetch",
            "--no-write-fetch-head",
            "--no-tags",
            input.remoteUrl,
            `+refs/heads/${input.baseRefName}:${temporaryRef}`,
          ],
          { cwd: input.cwd, timeoutMs: 120_000 },
        );
        const fetched = await runText("git", ["rev-parse", temporaryRef], { cwd: input.cwd });
        if (fetched !== input.baseOid) {
          throw new RvwError(
            "LOCAL_STATE_INCONSISTENT",
            "取得したbase tipがGitHubのOIDと一致しません。",
            {
              details: { expected: input.baseOid, actual: fetched },
              suggestions: [`rvw pr reset https://github.com/.../pull/${input.number} --yes`],
            },
          );
        }
      }
    } finally {
      await this.deleteRefsByPrefix(input.cwd, `${prefix}/`).catch(() => undefined);
    }
  }

  async mergeBase(cwd: string, baseOid: string, headOid: string): Promise<string> {
    return await runText("git", ["merge-base", baseOid, headOid], { cwd });
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await runProcess("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      allowExitCodes: [1],
    });
    return result.exitCode === 0;
  }

  async worktreeStatus(cwd: string): Promise<WorktreeStatus> {
    const output = await runText("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd,
    });
    const entries = output.split("\n").filter(Boolean);
    return {
      entries,
      trackedEntries: entries.filter((entry) => !entry.startsWith("?? ")),
      untrackedEntries: entries.filter((entry) => entry.startsWith("?? ")),
    };
  }

  async headState(cwd: string): Promise<HeadState> {
    const oid = await runText("git", ["rev-parse", "HEAD"], { cwd });
    const branchResult = await runProcess("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      allowExitCodes: [1],
    });
    return {
      oid,
      branch:
        branchResult.exitCode === 0 ? branchResult.stdout.toString("utf8").trim() || null : null,
    };
  }

  commitRef(number: number, oid: string): string {
    // Git rejects a ref path component that is exactly a 40-hex object ID.
    return `refs/rvw/pr/${number}/commits/oid-${oid.toLowerCase()}`;
  }

  async ensureCommitRef(cwd: string, number: number, oid: string): Promise<EnsuredCommitRef> {
    const ref = this.commitRef(number, oid);
    const existing = await runProcess("git", ["show-ref", "--verify", "--hash", ref], {
      cwd,
      allowExitCodes: [1, 128],
    });
    if (existing.exitCode === 0) {
      const value = existing.stdout.toString("utf8").trim();
      if (value !== oid) {
        throw new RvwError("LOCAL_STATE_INCONSISTENT", `Git ref ${ref} のOIDが不正です。`);
      }
      return { ref, created: false };
    }
    await runProcess("git", ["update-ref", ref, oid], { cwd });
    return { ref, created: true };
  }

  async deleteRef(cwd: string, ref: string, expectedOid: string): Promise<void> {
    await runProcess("git", ["update-ref", "-d", ref, expectedOid], { cwd });
  }

  async verifyCommitRef(cwd: string, number: number, oid: string): Promise<boolean> {
    const ref = this.commitRef(number, oid);
    try {
      return (await runText("git", ["rev-parse", "--verify", ref], { cwd })) === oid;
    } catch {
      return false;
    }
  }

  async listRefsByPrefix(cwd: string, prefix: string): Promise<string[]> {
    const output = await runProcess("git", ["for-each-ref", "--format=%(refname)%00", prefix], {
      cwd,
    });
    return output.stdout
      .toString("utf8")
      .split("\0")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async deleteRefsByPrefix(cwd: string, prefix: string): Promise<number> {
    const refs = await this.listRefsByPrefix(cwd, prefix);
    if (refs.length === 0) return 0;
    const input = ["start", ...refs.map((ref) => `delete ${ref}`), "prepare", "commit", ""].join(
      "\n",
    );
    await runProcess("git", ["update-ref", "--stdin"], { cwd, input });
    return refs.length;
  }

  async replacePullRequestRefsForReset(
    cwd: string,
    number: number,
    headOid: string,
  ): Promise<{ ref: string; removedCount: number }> {
    const prefix = `refs/rvw/pr/${number}/`;
    const existing = await this.listRefsByPrefix(cwd, prefix);
    const ref = this.commitRef(number, headOid);
    const commands: string[] = ["start"];
    for (const ref of existing) {
      if (ref !== this.commitRef(number, headOid)) commands.push(`delete ${ref}`);
    }
    commands.push(
      existing.includes(ref) ? `update ${ref} ${headOid}` : `create ${ref} ${headOid}`,
      "prepare",
      "commit",
      "",
    );
    await runProcess("git", ["update-ref", "--stdin"], { cwd, input: commands.join("\n") });
    return { ref, removedCount: existing.length };
  }

  async commits(cwd: string, oldOid: string, newOid: string): Promise<CommitSummary[]> {
    const output = await runText(
      "git",
      [
        "log",
        "--reverse",
        "--ancestry-path",
        "--format=%H%x00%P%x00%an%x00%aI%x00%s%x1e",
        `${oldOid}..${newOid}`,
      ],
      { cwd },
    );
    return parseCommitLog(output);
  }

  async tree(cwd: string, oid: string): Promise<TreeEntry[]> {
    const result = await runProcess("git", ["ls-tree", "-r", "-z", "--long", oid], { cwd });
    return parseLsTree(result.stdout);
  }

  async changedFiles(cwd: string, oldOid: string, newOid: string): Promise<ChangedFile[]> {
    const result = await runProcess(
      "git",
      ["diff", "--name-status", "-z", "--find-renames", oldOid, newOid],
      { cwd },
    );
    return parseNameStatus(result.stdout);
  }

  async readDocument(cwd: string, sourceOid: string, filePath: string): Promise<BlobContent> {
    assertGitPath(filePath);
    const result = await runProcess("git", ["ls-tree", "-z", "--long", sourceOid, "--", filePath], {
      cwd,
      allowExitCodes: [128],
    });
    const entry = parseLsTree(result.stdout).find((candidate) => candidate.path === filePath);
    if (!entry) {
      return {
        availability: "missing",
        text: null,
        byteLength: null,
        entryKind: "file",
        oid: null,
        normalizedLineEndings: false,
      };
    }
    if (entry.kind === "submodule") {
      return {
        availability: "available",
        text: entry.oid,
        byteLength: Buffer.byteLength(entry.oid),
        entryKind: "submodule",
        oid: entry.oid,
        normalizedLineEndings: false,
      };
    }
    if ((entry.size ?? 0) > MAX_TEXT_DOCUMENT_BYTES) {
      return {
        availability: "too-large",
        text: null,
        byteLength: entry.size,
        entryKind: entry.kind,
        oid: entry.oid,
        normalizedLineEndings: false,
      };
    }
    const content = await runProcess("git", ["cat-file", "blob", entry.oid], {
      cwd,
      maxStdoutBytes: MAX_TEXT_DOCUMENT_BYTES + 1,
    });
    if (content.stdout.includes(0)) {
      return {
        availability: "binary",
        text: null,
        byteLength: content.stdout.length,
        entryKind: entry.kind,
        oid: entry.oid,
        normalizedLineEndings: false,
      };
    }
    let decoded: string;
    try {
      decoded = utf8Fatal.decode(content.stdout);
    } catch {
      return {
        availability: "binary",
        text: null,
        byteLength: content.stdout.length,
        entryKind: entry.kind,
        oid: entry.oid,
        normalizedLineEndings: false,
      };
    }
    const normalized = decoded.replace(/\r\n?/g, "\n");
    return {
      availability: "available",
      text: normalized,
      byteLength: content.stdout.length,
      entryKind: entry.kind,
      oid: entry.oid,
      normalizedLineEndings: normalized !== decoded,
    };
  }

  async readRepositoryAsset(
    cwd: string,
    sourceOid: string,
    filePath: string,
  ): Promise<RepositoryAsset> {
    assertGitPath(filePath);
    const result = await runProcess("git", ["ls-tree", "-z", "--long", sourceOid, "--", filePath], {
      cwd,
      allowExitCodes: [128],
    });
    const entry = parseLsTree(result.stdout).find((candidate) => candidate.path === filePath);
    if (!entry || entry.kind === "submodule") {
      throw new RvwError("DOCUMENT_NOT_FOUND", "Markdown assetが見つかりません。", {
        status: 404,
      });
    }
    if ((entry.size ?? 0) > MAX_MARKDOWN_ASSET_BYTES) {
      throw new RvwError("FILE_TOO_LARGE", "Markdown assetは5 MiB以下にしてください。", {
        status: 413,
      });
    }
    const content = await runProcess("git", ["cat-file", "blob", entry.oid], {
      cwd,
      maxStdoutBytes: MAX_MARKDOWN_ASSET_BYTES + 1,
    });
    return { content: content.stdout, oid: entry.oid, byteLength: content.stdout.length };
  }

  async search(
    cwd: string,
    oid: string,
    query: string,
    options: SearchOptions,
  ): Promise<SearchGitResult> {
    const searchFlags = [
      ...(options.matchCase ? [] : ["-i"]),
      ...(options.wholeWord ? ["-w"] : []),
    ];
    const processResult = await runProcess(
      "git",
      ["grep", "-z", "-n", "-I", "-F", ...searchFlags, "-e", query, oid],
      {
        cwd,
        allowExitCodes: [1],
        maxStdoutBytes: MAX_SEARCH_STDOUT_BYTES,
        truncateStdout: true,
      },
    );
    if (processResult.exitCode === 1) {
      return { results: [], truncated: false, stdoutBytes: 0 };
    }
    const results: Array<Omit<SearchResult, "document">> = [];
    let offset = 0;
    while (offset < processResult.stdout.length && results.length < MAX_SEARCH_RESULTS) {
      const nul = processResult.stdout.indexOf(0, offset);
      if (nul < 0) break;
      const filename = processResult.stdout.subarray(offset, nul).toString("utf8");
      const lineSeparator = processResult.stdout.indexOf(0, nul + 1);
      if (lineSeparator < 0) break;
      const newline = processResult.stdout.indexOf(10, lineSeparator + 1);
      const end = newline < 0 ? processResult.stdout.length : newline;
      const line = Number(processResult.stdout.subarray(nul + 1, lineSeparator).toString("utf8"));
      const text = processResult.stdout.subarray(lineSeparator + 1, end).toString("utf8");
      const pathSeparator = filename.indexOf(":");
      const matches = findFixedStringMatches(text, query, options);
      if (matches.length === 0) {
        offset = end + (newline < 0 ? 0 : 1);
        continue;
      }
      results.push({
        path: pathSeparator < 0 ? filename : filename.slice(pathSeparator + 1),
        line,
        text,
        matches,
      });
      offset = end + (newline < 0 ? 0 : 1);
    }
    return {
      results,
      truncated:
        processResult.stdoutTruncated ||
        results.length >= MAX_SEARCH_RESULTS ||
        offset < processResult.stdout.length,
      stdoutBytes: processResult.stdout.length,
    };
  }
}
