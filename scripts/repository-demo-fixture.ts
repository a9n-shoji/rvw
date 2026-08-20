import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ChangedFile,
  CodeReference,
  CommitSummary,
  DocumentAvailability,
  ReviewComment,
  TreeEntry,
  TreeEntryKind,
  Walkthrough,
} from "../src/domain/models.js";

const pullRequestId = "22222222-2222-4222-8222-222222222222";
const maximumDocumentBytes = 1024 * 1024;

interface RepositoryDocumentSnapshot {
  availability: DocumentAvailability;
  text: string | null;
  byteLength: number | null;
  entryKind: TreeEntryKind;
  normalizedLineEndings: boolean;
  oid: string | null;
}

export interface RepositoryDemoFixture {
  pullRequestId: string;
  baseOid: string;
  headOid: string;
  commits: CommitSummary[];
  pullRequest: {
    id: string;
    host: "github.com";
    owner: string;
    repository: string;
    number: number;
    url: string;
    latestAuthorLogin: string;
    latestHeadRepositoryOwner: string;
    latestHeadRepositoryName: string;
    localRepositoryPath: string;
    gitCommonDir: string;
    latestTitle: string;
    latestBody: string;
    latestBaseRefName: string;
    latestHeadRefName: string;
    latestBaseOid: string;
    latestComparisonBaseOid: string;
    latestHeadOid: string;
    githubUpdatedAt: string;
    fetchedAt: string;
    createdAt: string;
    updatedAt: string;
  };
  comments: ReviewComment[];
  walkthroughs: Walkthrough[];
  repositoryEntriesAt(oid: string): TreeEntry[];
  repositoryDocumentAt(oid: string, filePath: string): RepositoryDocumentSnapshot;
  changedFiles(oldOid: string, newOid: string): ChangedFile[];
}

function gitText(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function gitBuffer(repositoryRoot: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function parseCommit(repositoryRoot: string, oid: string): CommitSummary {
  const [commitOid, parents, subject, authorName, authoredAt] = gitText(repositoryRoot, [
    "show",
    "-s",
    "--format=%H%x00%P%x00%s%x00%an%x00%aI",
    oid,
  ])
    .trimEnd()
    .split("\0");
  if (!commitOid || parents === undefined || !subject || !authorName || !authoredAt) {
    throw new Error(`demo fixture could not parse commit ${oid}`);
  }
  return {
    oid: commitOid,
    parentOids: parents ? parents.split(" ") : [],
    subject,
    authorName,
    authoredAt,
  };
}

function parseTree(repositoryRoot: string, oid: string): TreeEntry[] {
  return gitText(repositoryRoot, ["ls-tree", "-r", "-l", "-z", oid])
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) (blob|commit) ([0-9a-f]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error(`demo fixture could not parse tree entry at ${oid}`);
      const [, mode, type, objectOid, sizeText, filePath] = match;
      if (!mode || !type || !objectOid || !sizeText || !filePath) {
        throw new Error(`demo fixture tree entry is incomplete at ${oid}`);
      }
      const kind: TreeEntryKind =
        type === "commit" ? "submodule" : mode === "120000" ? "symlink" : "file";
      return {
        mode,
        type: type as "blob" | "commit",
        oid: objectOid,
        size: sizeText === "-" ? null : Number(sizeText),
        path: filePath,
        kind,
      };
    });
}

function parseChangedFiles(repositoryRoot: string, oldOid: string, newOid: string): ChangedFile[] {
  const fields = gitText(repositoryRoot, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    oldOid,
    newOid,
  ]).split("\0");
  const files: ChangedFile[] = [];
  let index = 0;
  while (index < fields.length && fields[index]) {
    const status = fields[index++];
    if (!status) break;
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (!oldPath || !newPath) throw new Error(`demo fixture rename is incomplete: ${status}`);
      files.push({
        kind: code === "R" ? "renamed" : "added",
        status,
        similarity: Number(status.slice(1)),
        oldPath: code === "R" ? oldPath : null,
        newPath,
      });
      continue;
    }
    const filePath = fields[index++];
    if (!filePath) throw new Error(`demo fixture change is incomplete: ${status}`);
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

function hashDocument(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function lineReference(
  readText: (filePath: string) => string,
  id: string,
  label: string,
  filePath: string,
  needle: string,
  span: number,
  description: string,
): CodeReference {
  const text = readText(filePath);
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`demo reference ${id} could not find ${needle} in ${filePath}`);
  const startLine = text.slice(0, offset).split("\n").length;
  return {
    id,
    label,
    path: filePath,
    startLine,
    endLine: Math.min(startLine + span, text.split("\n").length),
    description,
  };
}

function createWalkthroughs(
  headOid: string,
  readText: (filePath: string) => string,
): Walkthrough[] {
  const viewerReferences = [
    lineReference(
      readText,
      "app",
      "App shell",
      "src/web/app/App.tsx",
      "export function App",
      24,
      "Repository-wide review state and navigation orchestration",
    ),
    lineReference(
      readText,
      "workspace",
      "document workspace hook",
      "src/web/use-document-workspace.ts",
      "export function useDocumentWorkspace",
      28,
      "The two-pane document ownership model",
    ),
    lineReference(
      readText,
      "service",
      "RvwService",
      "src/application/rvw-service.ts",
      "export class RvwService",
      24,
      "Application boundary shared by HTTP and CLI transports",
    ),
    lineReference(
      readText,
      "git",
      "GitClient",
      "src/infrastructure/git/git-client.ts",
      "export class GitClient",
      22,
      "Exact commit tree, document, diff, and search access",
    ),
  ];
  const viewerBody = [
    "# Repository reading flow",
    "",
    "The [App shell](rvw-ref:app) keeps one global review scope while the [document workspace](rvw-ref:workspace) owns the files that are open in one or two panes.",
    "",
    "Requests cross the [application service](rvw-ref:service), which delegates commit-fixed reads to the [Git client](rvw-ref:git). The changed-files tree is only the entry point; the destination commit's complete tree remains available.",
    "",
    "```mermaid",
    "flowchart LR",
    "  AppShell[App shell] --> Workspace[Document workspace]",
    "  AppShell --> Service[RvwService]",
    "  Service --> Git[GitClient]",
    "  Git --> Repository[(Commit snapshot)]",
    "```",
    "",
    "A useful review starts with the PR description, samples the changed files, and then follows callers, tests, configuration, and documentation without losing the selected commit range.",
  ].join("\n");

  const feedbackReferences = [
    lineReference(
      readText,
      "comments",
      "CommentSidebar",
      "src/web/components/CommentSidebar.tsx",
      "export function CommentSidebar",
      24,
      "Unresolved and resolved review threads",
    ),
    lineReference(
      readText,
      "server",
      "HTTP application",
      "src/server/app.ts",
      "export function createApp",
      28,
      "Local viewer API and write validation",
    ),
    lineReference(
      readText,
      "service",
      "comment application service",
      "src/application/rvw-service.ts",
      "export class RvwService",
      18,
      "Shared comment validation and persistence boundary",
    ),
    {
      id: "watch",
      label: "comment-watch Skill",
      path: "skills/rvw-watch-comments/SKILL.md",
      startLine: null,
      endLine: null,
      description: "Agent-side durable comment intake workflow",
    },
  ];
  const feedbackBody = [
    "# Feedback handoff",
    "",
    "Review threads begin in the [Comments sidebar](rvw-ref:comments). Viewer writes enter through the [local HTTP API](rvw-ref:server), while CLI operations reuse the same [application service](rvw-ref:service).",
    "",
    "The external Agent can then follow the [comment-watch Skill](rvw-ref:watch) without rvw launching an Agent or embedding an AI chat.",
    "",
    "```mermaid",
    "flowchart LR",
    "  Comments[Comments sidebar] --> Server[HTTP API]",
    "  Server --> Service[Application service]",
    "  Service --> Watch[Comment watch protocol]",
    "```",
    "",
    "The durable unit is the unresolved or resolved thread anchored to an exact document, not a transient browser or Agent session.",
  ].join("\n");

  return [
    {
      id: "80000000-0000-4000-8000-000000000001",
      ref: "rvw://walkthrough/80000000-0000-4000-8000-000000000001",
      pullRequestId,
      sourceOid: headOid,
      title: "Repository reading flow",
      body: viewerBody,
      authorLabel: "Demo Agent",
      diagramBindings: { AppShell: "app", Workspace: "workspace", Service: "service", Git: "git" },
      references: viewerReferences,
      createdAt: "2026-08-20T01:10:00.000Z",
    },
    {
      id: "80000000-0000-4000-8000-000000000002",
      ref: "rvw://walkthrough/80000000-0000-4000-8000-000000000002",
      pullRequestId,
      sourceOid: headOid,
      title: "Feedback handoff",
      body: feedbackBody,
      authorLabel: "Demo Agent",
      diagramBindings: {
        Comments: "comments",
        Server: "server",
        Service: "service",
        Watch: "watch",
      },
      references: feedbackReferences,
      createdAt: "2026-08-20T01:20:00.000Z",
    },
  ];
}

function createComments(
  headOid: string,
  readText: (filePath: string) => string,
  walkthroughs: Walkthrough[],
): ReviewComment[] {
  const appReference = lineReference(
    readText,
    "file-tree",
    "FileTree implementation",
    "src/web/components/FileTree.tsx",
    "function FileTreeComponent",
    20,
    "Tree expansion and file navigation behavior",
  );
  const appTarget = lineReference(
    readText,
    "app-target",
    "App shell",
    "src/web/app/App.tsx",
    "export function App",
    8,
    "",
  );
  const serviceTarget = lineReference(
    readText,
    "service-target",
    "RvwService",
    "src/application/rvw-service.ts",
    "export class RvwService",
    8,
    "",
  );
  const gitTarget = lineReference(
    readText,
    "git-target",
    "GitClient",
    "src/infrastructure/git/git-client.ts",
    "export class GitClient",
    8,
    "",
  );
  const thread = (
    index: number,
    target: ReviewComment["target"],
    body: string,
    options: {
      resolved?: boolean;
      reply?: string;
      references?: CodeReference[];
      relatedCommitOid?: string | null;
    } = {},
  ): ReviewComment => {
    const id = `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const createdAt = `2026-08-20T02:${String(index).padStart(2, "0")}:00.000Z`;
    const posts = [
      {
        id: `91000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        commentId: id,
        body,
        relatedCommitOid: options.relatedCommitOid ?? null,
        references: options.references ?? [],
        authorLabel: "Reviewer",
        isRoot: true,
        createdAt,
        updatedAt: createdAt,
      },
    ];
    if (options.reply) {
      posts.push({
        id: `92000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        commentId: id,
        body: options.reply,
        relatedCommitOid: headOid,
        references: [],
        authorLabel: "Demo Agent",
        isRoot: false,
        createdAt: `2026-08-20T03:${String(index).padStart(2, "0")}:00.000Z`,
        updatedAt: `2026-08-20T03:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    return {
      id,
      ref: `rvw://comment/${id}`,
      pullRequestId,
      createdHeadOid: headOid,
      resolvedAt: options.resolved
        ? `2026-08-20T04:${String(index).padStart(2, "0")}:00.000Z`
        : null,
      createdAt,
      updatedAt: posts.at(-1)?.updatedAt ?? createdAt,
      target,
      posts,
    };
  };

  const walkthrough = walkthroughs[0];
  if (!walkthrough) throw new Error("demo walkthrough is missing");
  const walkthroughLines = walkthrough.body.split("\n");
  const quotedLine = walkthroughLines[2];
  if (!quotedLine) throw new Error("demo walkthrough comment target is missing");

  return [
    thread(
      1,
      {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: headOid,
        path: appTarget.path,
        startLine: appTarget.startLine,
        endLine: appTarget.endLine,
      },
      "ファイル数が増えた状態でも、選択中の文書とtreeの展開状態を見失わないか確認したいです。[tree側の実装](rvw-ref:file-tree)も並べて読めると判断しやすそうです。",
      { relatedCommitOid: headOid, references: [appReference] },
    ),
    thread(
      2,
      {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: headOid,
        path: serviceTarget.path,
        startLine: serviceTarget.startLine,
        endLine: serviceTarget.endLine,
      },
      "HTTPとCLIがこのapplication boundaryを共有していることを、失敗時の明示エラーまで含めて確認してください。",
      {
        reply: "主要なwrite経路が同じservice validationへ到達することを確認中です。",
      },
    ),
    thread(
      3,
      {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: headOid,
        path: gitTarget.path,
        startLine: gitTarget.startLine,
        endLine: gitTarget.endLine,
      },
      "worktreeではなく選択commitのGit objectを読む境界が保たれていることを確認しました。",
      {
        resolved: true,
        reply: "確認ありがとうございます。commit固定のread pathを維持しています。",
      },
    ),
    thread(
      4,
      {
        kind: "walkthrough",
        walkthroughId: walkthrough.id,
        walkthroughTitle: walkthrough.title,
        sourceDocumentHash: hashDocument(walkthrough.body),
        quotedText: quotedLine,
        startLine: 3,
        endLine: 3,
      },
      "最初にどの変更ファイルから読むと、この説明の流れへ入りやすいかも一文あると助かります。",
    ),
  ];
}

export function createRepositoryDemoFixture(
  repositoryRoot: string,
  options: { commitCount?: number } = {},
): RepositoryDemoFixture {
  const resolvedRoot = path.resolve(repositoryRoot);
  const commitCount = options.commitCount ?? 6;
  if (!Number.isInteger(commitCount) || commitCount < 2 || commitCount > 12) {
    throw new Error("demo fixture commit count must be an integer from 2 to 12");
  }
  const commitOids = gitText(resolvedRoot, [
    "rev-list",
    "--first-parent",
    `--max-count=${commitCount}`,
    "HEAD",
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
    .reverse();
  if (commitOids.length < commitCount) {
    throw new Error(
      `demo fixture requires ${commitCount} first-parent commits; fetch more Git history and retry`,
    );
  }
  const commits = commitOids.map((oid) => parseCommit(resolvedRoot, oid));
  const firstCommit = commits[0];
  const latestCommit = commits.at(-1);
  const baseOid = firstCommit?.parentOids[0];
  if (!firstCommit || !latestCommit || !baseOid) {
    throw new Error("demo fixture requires a first-parent comparison base");
  }
  const treeCache = new Map<string, TreeEntry[]>();
  const documentCache = new Map<string, RepositoryDocumentSnapshot>();
  const repositoryEntriesAt = (oid: string): TreeEntry[] => {
    const cached = treeCache.get(oid);
    if (cached) return cached;
    const entries = parseTree(resolvedRoot, oid);
    treeCache.set(oid, entries);
    return entries;
  };
  const repositoryDocumentAt = (oid: string, filePath: string): RepositoryDocumentSnapshot => {
    const key = `${oid}\0${filePath}`;
    const cached = documentCache.get(key);
    if (cached) return cached;
    const entry = repositoryEntriesAt(oid).find((candidate) => candidate.path === filePath);
    if (!entry) {
      const missing: RepositoryDocumentSnapshot = {
        availability: "missing",
        text: null,
        byteLength: 0,
        entryKind: "file",
        normalizedLineEndings: false,
        oid: null,
      };
      documentCache.set(key, missing);
      return missing;
    }
    if (entry.size !== null && entry.size > maximumDocumentBytes) {
      const tooLarge: RepositoryDocumentSnapshot = {
        availability: "too-large",
        text: null,
        byteLength: entry.size,
        entryKind: entry.kind,
        normalizedLineEndings: false,
        oid: entry.oid,
      };
      documentCache.set(key, tooLarge);
      return tooLarge;
    }
    const contents =
      entry.kind === "submodule"
        ? Buffer.from(`${entry.oid}\n`)
        : gitBuffer(resolvedRoot, ["show", `${oid}:${filePath}`]);
    if (contents.includes(0) || !isUtf8(contents)) {
      const binary: RepositoryDocumentSnapshot = {
        availability: "binary",
        text: null,
        byteLength: contents.byteLength,
        entryKind: entry.kind,
        normalizedLineEndings: false,
        oid: entry.oid,
      };
      documentCache.set(key, binary);
      return binary;
    }
    const originalText = contents.toString("utf8");
    const text = originalText.replace(/\r\n?/g, "\n");
    const available: RepositoryDocumentSnapshot = {
      availability: "available",
      text,
      byteLength: contents.byteLength,
      entryKind: entry.kind,
      normalizedLineEndings: text !== originalText,
      oid: entry.oid,
    };
    documentCache.set(key, available);
    return available;
  };
  const readHeadText = (filePath: string): string => {
    const document = repositoryDocumentAt(latestCommit.oid, filePath);
    if (document.availability !== "available" || document.text === null) {
      throw new Error(`demo fixture requires a readable ${filePath}`);
    }
    return document.text;
  };
  const changedFiles = (oldOid: string, newOid: string): ChangedFile[] =>
    parseChangedFiles(resolvedRoot, oldOid, newOid);
  const headEntries = repositoryEntriesAt(latestCommit.oid);
  const pullRequestChanges = changedFiles(baseOid, latestCommit.oid);
  const walkthroughs = createWalkthroughs(latestCommit.oid, readHeadText);
  const comments = createComments(latestCommit.oid, readHeadText, walkthroughs);
  const gitCommonDirValue = gitText(resolvedRoot, ["rev-parse", "--git-common-dir"]).trim();
  const gitCommonDir = path.resolve(resolvedRoot, gitCommonDirValue);
  const latestBody = [
    "## Summary",
    "",
    `This deterministic local demo presents ${commits.length} recent commits from rvw as one reviewable change set.`,
    "",
    `- Browse ${headEntries.length} committed repository files instead of a shallow placeholder tree.`,
    `- Start from ${pullRequestChanges.length} changed files, then follow unchanged implementation, tests, Skills, migrations, and documentation.`,
    "- Exercise commit ranges, full-file reading, search, two panes, seeded review comments, and code-linked Walkthroughs.",
    "",
    "## Suggested review route",
    "",
    "1. Read this description and inspect the commit sequence.",
    "2. Open a changed web or application file in changes mode.",
    "3. Switch to all files and follow its tests or infrastructure dependencies.",
    "4. Open a Walkthrough beside the referenced source.",
    "5. Inspect the seeded unresolved and resolved comment threads.",
    "",
    "> Demo metadata is synthetic; every repository document and commit shown comes from committed Git objects in this checkout.",
  ].join("\n");
  return {
    pullRequestId,
    baseOid,
    headOid: latestCommit.oid,
    commits,
    pullRequest: {
      id: pullRequestId,
      host: "github.com",
      owner: "a9n-shoji",
      repository: "rvw",
      number: 999,
      url: "https://github.com/a9n-shoji/rvw/pulls",
      latestAuthorLogin: "a9n-shoji",
      latestHeadRepositoryOwner: "a9n-shoji",
      latestHeadRepositoryName: "rvw",
      localRepositoryPath: resolvedRoot,
      gitCommonDir,
      latestTitle: "Demo: review rvw as a medium-sized repository",
      latestBody,
      latestBaseRefName: "main",
      latestHeadRefName: "demo/recent-rvw-work",
      latestBaseOid: baseOid,
      latestComparisonBaseOid: baseOid,
      latestHeadOid: latestCommit.oid,
      githubUpdatedAt: latestCommit.authoredAt,
      fetchedAt: latestCommit.authoredAt,
      createdAt: firstCommit.authoredAt,
      updatedAt: latestCommit.authoredAt,
    },
    comments,
    walkthroughs,
    repositoryEntriesAt,
    repositoryDocumentAt,
    changedFiles,
  };
}
