import type {
  CodeNavigationProvider,
  DefinitionResult,
  NavigationDocument,
  NavigationIssue,
  NavigationLanguage,
  NavigationTarget,
} from "../../domain/code-navigation.js";
import { navigationLanguage, navigationFamily } from "../../domain/code-navigation.js";
import type { TreeEntry } from "../../domain/models.js";
import { RvwError } from "../../shared/errors.js";
import type { BlobContent, GitClient } from "../git/git-client.js";
import { ParserWorkerClient } from "./parser-worker-client.js";
import type { BlobSymbols, SymbolTag } from "./tree-sitter-tags.js";

interface SymbolIndex {
  definitions: { path: string; tag: SymbolTag }[];
  skippedFiles: number;
  issues: NavigationIssue[];
}

/** Derived runtime cache: blob metadata has no paths or commits. */
export class GitSymbolIndex implements CodeNavigationProvider {
  private readonly blobs = new Map<string, { symbols: BlobSymbols; bytes: number }>();
  private blobBytes = 0;
  private readonly parsing = new Map<string, Promise<BlobSymbols>>();
  private readonly snapshots = new Map<string, SymbolIndex>();
  private readonly pending = new Map<string, Promise<SymbolIndex>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly parser = new ParserWorkerClient();
  private readonly shutdown = new AbortController();
  private activeQueries = 0;

  constructor(
    private readonly git: GitClient,
    private readonly extract: (
      text: string,
      language: NavigationLanguage,
    ) => Promise<BlobSymbols> = (text, language) => this.parser.extract(text, language),
  ) {}

  close(): void {
    this.shutdown.abort();
    this.parser.close();
    this.blobs.clear();
    this.snapshots.clear();
    this.blobBytes = 0;
  }

  private assertOpen(): void {
    if (this.shutdown.signal.aborted)
      throw new RvwError("NAVIGATION_UNAVAILABLE", "定義探索は終了しました。", { status: 503 });
  }

  private blobKey(entry: TreeEntry): string {
    return `${navigationLanguage(entry.path)}:${entry.oid}`;
  }

  private cachedSymbols(key: string): BlobSymbols | undefined {
    const cached = this.blobs.get(key);
    if (!cached) return undefined;
    this.blobs.delete(key);
    this.blobs.set(key, cached);
    return cached.symbols;
  }

  private async symbols(entry: TreeEntry, content: BlobContent): Promise<BlobSymbols> {
    this.assertOpen();
    const key = this.blobKey(entry);
    const cached = this.cachedSymbols(key);
    if (cached) return cached;
    const pending = this.parsing.get(key);
    if (pending) return pending;
    const job = (async () => {
      const symbols: BlobSymbols =
        content.availability === "available" &&
        content.entryKind === "file" &&
        content.text !== null
          ? await this.extract(content.text, navigationLanguage(entry.path)!)
          : { tags: [], partial: true, issues: ["unavailable-file"] };
      this.assertOpen();
      // A transient parser budget limit must not become a permanent negative cache.
      if (!symbols.issues.includes("parse-limit")) {
        const bytes = Buffer.byteLength(JSON.stringify(symbols));
        this.blobs.set(key, { symbols, bytes });
        this.blobBytes += bytes;
        while (this.blobBytes > 16 * 1024 * 1024 || this.blobs.size > 4000) {
          const oldest = this.blobs.keys().next().value!;
          this.blobBytes -= this.blobs.get(oldest)!.bytes;
          this.blobs.delete(oldest);
        }
      }
      return symbols;
    })().finally(() => this.parsing.delete(key));
    this.parsing.set(key, job);
    return job;
  }

  private index(
    repository: string,
    sourceOid: string,
    language: NavigationLanguage,
  ): Promise<SymbolIndex> {
    const family = navigationFamily(language);
    const key = JSON.stringify([repository, sourceOid, family]);
    const cached = this.snapshots.get(key);
    if (cached) {
      this.snapshots.delete(key);
      this.snapshots.set(key, cached);
      return Promise.resolve(cached);
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 4)
      throw new RvwError(
        "NAVIGATION_BUSY",
        "定義候補の索引を作成中です。少し待って再試行してください。",
        { status: 429 },
      );
    const job = this.queue.then(async () => {
      this.assertOpen();
      const entries = (await this.git.tree(repository, sourceOid)).filter((entry) => {
        const entryLanguage = navigationLanguage(entry.path);
        return entryLanguage !== null && navigationFamily(entryLanguage) === family;
      });
      const index: SymbolIndex = { definitions: [], skippedFiles: 0, issues: [] };
      const issues = new Set<NavigationIssue>();
      const selected: TreeEntry[] = [];
      let bytes = 0;
      for (const entry of entries) {
        let issue: NavigationIssue | undefined;
        if (entry.kind !== "file" || entry.size === null || entry.size > 1024 * 1024)
          issue = "unavailable-file";
        else if (selected.length >= 2000) issue = "file-limit";
        else if (bytes + entry.size > 16 * 1024 * 1024) issue = "byte-limit";
        if (issue) {
          issues.add(issue);
          index.skippedFiles++;
          continue;
        }
        bytes += entry.size!;
        selected.push(entry);
      }
      const deadline = performance.now() + 10_000;
      let offset = 0;
      while (offset < selected.length) {
        this.assertOpen();
        if (performance.now() > deadline || index.definitions.length >= 50_000) {
          issues.add(index.definitions.length >= 50_000 ? "definition-limit" : "index-timeout");
          index.skippedFiles += selected.length - offset;
          break;
        }
        const batch: TreeEntry[] = [];
        let batchBytes = 0;
        while (offset < selected.length && batch.length < 32) {
          const entry = selected[offset]!;
          if (batchBytes + entry.size! > 4 * 1024 * 1024) break;
          batch.push(entry);
          batchBytes += entry.size!;
          offset++;
        }
        const uncached = batch.filter(
          (entry) => !this.blobs.has(this.blobKey(entry)) && !this.parsing.has(this.blobKey(entry)),
        );
        const documents = await this.git.readBlobDocuments(
          repository,
          uncached,
          this.shutdown.signal,
        );
        for (let position = 0; position < batch.length; position++) {
          this.assertOpen();
          if (performance.now() > deadline) {
            issues.add("index-timeout");
            index.skippedFiles += batch.length - position + selected.length - offset;
            offset = selected.length;
            break;
          }
          const entry = batch[position]!;
          const key = this.blobKey(entry);
          const cached = this.cachedSymbols(key) ?? (await this.parsing.get(key));
          // An LRU eviction by another request can remove a previously cached batch member.
          const content = cached
            ? null
            : (documents.get(entry.oid) ??
              (await this.git.readBlobDocuments(repository, [entry], this.shutdown.signal)).get(
                entry.oid,
              )!);
          const symbols = cached ?? (await this.symbols(entry, content!));
          for (const issue of symbols.issues) issues.add(issue);
          for (const tag of symbols.tags) {
            if (tag.kind && index.definitions.length < 50_000)
              index.definitions.push({ path: entry.path, tag });
            else if (tag.kind) issues.add("definition-limit");
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      index.issues = [...issues];
      if (!issues.has("index-timeout") && !issues.has("parse-limit")) {
        this.snapshots.set(key, index);
        if (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!);
      }
      return index;
    });
    this.queue = job.catch(() => {});
    const tracked = job.finally(() => this.pending.delete(key));
    this.pending.set(key, tracked);
    return tracked;
  }

  async definitions(
    repository: string,
    document: NavigationDocument,
    line: number,
    column: number,
  ): Promise<DefinitionResult> {
    this.assertOpen();
    if (this.activeQueries >= 8)
      throw new RvwError("NAVIGATION_BUSY", "定義を検索中です。少し待って再試行してください。", {
        status: 429,
      });
    this.activeQueries++;
    try {
      return await this.query(repository, document, line, column);
    } finally {
      this.activeQueries--;
    }
  }

  private async query(
    repository: string,
    document: NavigationDocument,
    line: number,
    column: number,
  ): Promise<DefinitionResult> {
    const empty: DefinitionResult = {
      provider: "tree-sitter-tags",
      status: "none",
      symbol: null,
      targets: [],
      partial: false,
      issues: [],
      skippedFiles: 0,
      truncated: false,
    };
    const language = navigationLanguage(document.path);
    if (!language) return { ...empty, status: "unsupported" };
    const content = await this.git.readDocument(repository, document.sourceOid, document.path);
    if (
      content.availability !== "available" ||
      content.entryKind !== "file" ||
      content.text === null ||
      !content.oid
    )
      return { ...empty, status: "unavailable" };
    const entry: TreeEntry = {
      path: document.path,
      oid: content.oid,
      size: content.byteLength,
      type: "blob",
      kind: "file",
      mode: "100644",
    };
    const symbols = await this.symbols(entry, content);
    const symbol = symbols.tags.find(
      (tag) => tag.line === line && tag.column <= column && column < tag.endColumn,
    )?.name;
    if (!symbol) return { ...empty, partial: symbols.partial, issues: symbols.issues };
    const index = await this.index(repository, document.sourceOid, language);
    const matches = index.definitions
      .filter(
        ({ path, tag }) =>
          tag.name === symbol &&
          !(
            path === document.path &&
            tag.line === line &&
            tag.column <= column &&
            column < tag.endColumn
          ),
      )
      .sort((a, b) => Number(b.path === document.path) - Number(a.path === document.path));
    const targets: NavigationTarget[] = matches.slice(0, 100).map(({ path, tag }) => ({
      document: { ...document, path },
      name: tag.name,
      kind: tag.kind!,
      preview: tag.preview,
      line: tag.line,
      column: tag.column,
    }));
    const issues = [...new Set([...symbols.issues, ...index.issues])];
    return {
      ...empty,
      status: targets.length ? "possible" : "none",
      symbol,
      targets,
      partial: issues.length > 0,
      issues,
      skippedFiles: index.skippedFiles,
      truncated: matches.length > targets.length,
    };
  }
}
