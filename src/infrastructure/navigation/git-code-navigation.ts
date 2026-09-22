import type {
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
import { visibleScopes } from "./symbol-context.js";
import { navigationPack } from "../../shared/navigation-packs.js";
import path from "node:path";
import {
  MAX_TEXT_DOCUMENT_BYTES,
  NAVIGATION_CACHE_BYTES,
  NAVIGATION_LOOKUP_BYTES,
  NAVIGATION_LOOKUP_MS,
  NAVIGATION_CONCURRENCY,
  NAVIGATION_CANDIDATES,
  NAVIGATION_BATCH_FILES,
  NAVIGATION_BATCH_BYTES,
} from "../../shared/constants.js";

interface Candidate {
  path: string;
  tag: SymbolTag;
}
interface SearchCandidates {
  definitions: Candidate[];
  skippedFiles: number;
  issues: NavigationIssue[];
}

/** Derived runtime cache: blob metadata has no paths or commits. */
export class GitCodeNavigation {
  private readonly blobs = new Map<string, { symbols: BlobSymbols; bytes: number }>();
  private blobBytes = 0;
  private readonly parsing = new Map<string, Promise<BlobSymbols>>();
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
        while (this.blobBytes > NAVIGATION_CACHE_BYTES) {
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

  private async search(
    repository: string,
    sourceOid: string,
    current: { entry: TreeEntry; symbols: BlobSymbols },
    names: string[],
    comparePaths: (a: string, b: string) => number,
    compare: (a: Candidate, b: Candidate) => number,
    accepts: (candidate: Candidate) => boolean,
  ): Promise<SearchCandidates> {
    const language = navigationLanguage(current.entry.path)!;
    const result: SearchCandidates = { definitions: [], skippedFiles: 0, issues: [] };
    const issues = new Set<NavigationIssue>();
    const collect = (entry: TreeEntry, symbols: BlobSymbols) => {
      for (const issue of symbols.issues) issues.add(issue);
      for (const tag of symbols.tags)
        if (tag.kind && accepts({ path: entry.path, tag }))
          result.definitions.push({ path: entry.path, tag });
      result.definitions.sort(compare);
      // One extra candidate is sufficient to report a truncated response.
      result.definitions.length = Math.min(result.definitions.length, NAVIGATION_CANDIDATES + 1);
    };
    // This document is already parsed. Even a truncated grep or exhausted search
    // must retain its candidates, using the same collector and ranking as other files.
    collect(current.entry, current.symbols);
    const found = await this.git.navigationPaths(
      repository,
      sourceOid,
      names,
      language,
      this.shutdown.signal,
    );
    if (found.truncated) issues.add("search-limit");
    const family = navigationFamily(language);
    const entries = (await this.git.tree(repository, sourceOid)).filter((entry) => {
      const id = navigationLanguage(entry.path);
      return (
        entry.path !== current.entry.path &&
        found.paths.has(entry.path) &&
        id !== null &&
        navigationFamily(id) === family
      );
    });
    entries.sort((a, b) => comparePaths(a.path, b.path));
    const deadline = performance.now() + NAVIGATION_LOOKUP_MS;
    // Include the query document read. Cached/in-flight candidate blobs cost no
    // new source work; metadata scanning is bounded by the deadline instead.
    let bytes = current.entry.size!;
    for (let offset = 0; offset < entries.length;) {
      this.assertOpen();
      if (performance.now() > deadline) {
        issues.add("search-limit");
        result.skippedFiles += entries.length - offset;
        break;
      }
      const batch: TreeEntry[] = [];
      const uncached: TreeEntry[] = [];
      // Pin reused values/promises through this bounded batch so an LRU eviction
      // cannot cause an unbudgeted read later. Also share work across copied paths.
      const work = new Map<string, BlobSymbols | Promise<BlobSymbols> | undefined>();
      let batchBytes = 0;
      while (
        offset < entries.length &&
        batch.length < NAVIGATION_BATCH_FILES &&
        performance.now() <= deadline
      ) {
        const entry = entries[offset]!;
        if (entry.kind !== "file" || entry.size === null || entry.size > MAX_TEXT_DOCUMENT_BYTES) {
          offset++;
          issues.add("unavailable-file");
          result.skippedFiles++;
          continue;
        }
        const key = this.blobKey(entry);
        if (!work.has(key)) {
          const reused =
            key === this.blobKey(current.entry)
              ? current.symbols
              : (this.cachedSymbols(key) ?? this.parsing.get(key));
          if (!reused) {
            if (bytes + entry.size > NAVIGATION_LOOKUP_BYTES) {
              offset++;
              issues.add("search-limit");
              result.skippedFiles++;
              // Later entries can still be cached or fit the remaining budget.
              continue;
            }
            if (batchBytes + entry.size > NAVIGATION_BATCH_BYTES) break;
            bytes += entry.size;
            batchBytes += entry.size;
            uncached.push(entry);
          }
          work.set(key, reused);
        }
        offset++;
        batch.push(entry);
      }
      const documents = await this.git.readBlobDocuments(
        repository,
        uncached,
        this.shutdown.signal,
      );
      for (let position = 0; position < batch.length; position++) {
        this.assertOpen();
        if (performance.now() > deadline) {
          issues.add("search-limit");
          result.skippedFiles += batch.length - position + entries.length - offset;
          offset = entries.length;
          break;
        }
        const entry = batch[position]!;
        const key = this.blobKey(entry);
        let symbols = work.get(key);
        if (!symbols) {
          symbols = this.symbols(entry, documents.get(entry.oid)!);
          work.set(key, symbols);
        }
        collect(entry, await symbols);
      }
    }
    result.issues = [...issues];
    return result;
  }

  async definitions(
    repository: string,
    document: NavigationDocument,
    line: number,
    column: number,
  ): Promise<DefinitionResult> {
    this.assertOpen();
    if (this.activeQueries >= NAVIGATION_CONCURRENCY)
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
    const atPosition = (tag: SymbolTag) =>
      tag.line === line && tag.column <= column && column < tag.endColumn;
    const reference = symbols.context?.references.find(atPosition);
    const symbol = symbols.tags.find(atPosition)?.name ?? reference?.name;
    if (!symbol) return { ...empty, partial: symbols.partial, issues: symbols.issues };
    const scopes =
      reference && symbols.context ? visibleScopes(symbols.context, reference.scope) : [];
    const localDefinitions = new Map<number, SymbolTag[]>();
    for (const tag of symbols.context?.definitions ?? []) {
      if (tag.name !== symbol) continue;
      const definitions = localDefinitions.get(tag.scope) ?? [];
      definitions.push(tag);
      localDefinitions.set(tag.scope, definitions);
    }
    // The nearest scope containing declarations wins. Multiple assignments remain
    // candidates: this is lexical context, not reaching-definition/data-flow analysis.
    for (const scope of scopes) {
      const locals = localDefinitions.get(scope) ?? [];
      if (!locals.length) continue;
      const matches = locals.filter((tag) => !atPosition(tag));
      return {
        ...empty,
        symbol,
        status: matches.length ? "possible" : "none",
        targets: matches.slice(0, NAVIGATION_CANDIDATES).map((tag) => ({
          document,
          name: tag.name,
          kind: "variable",
          preview: tag.preview,
          line: tag.line,
          column: tag.column,
          evidence: "local-scope",
        })),
        partial: symbols.partial,
        issues: symbols.issues,
        truncated: matches.length > NAVIGATION_CANDIDATES,
      };
    }
    const suffixes = navigationPack(language).relativeImportSuffixes ?? [];
    const visible = new Set(scopes);
    const imports = (symbols.context?.imports ?? []).filter(
      (binding) => binding.localName === symbol && visible.has(binding.scope),
    );
    const preferredPaths = new Set<string>();
    const searchNames = new Set([symbol]);
    const hints = new Set(
      imports.flatMap((binding) => {
        if (!binding.source.startsWith("./") && !binding.source.startsWith("../")) return [];
        const source = path.posix.normalize(
          path.posix.join(path.posix.dirname(document.path), binding.source),
        );
        if (source === ".." || source.startsWith("../")) return [];
        return suffixes.map((suffix) => {
          preferredPaths.add(source + suffix);
          searchNames.add(binding.importedName);
          return JSON.stringify([source + suffix, binding.importedName]);
        });
      }),
    );
    const imported = (candidate: Candidate) =>
      hints.has(JSON.stringify([candidate.path, candidate.tag.name]));
    const compareContext = (a: string, b: string) =>
      Number(b === document.path) - Number(a === document.path) ||
      Number(navigationLanguage(b) === language) - Number(navigationLanguage(a) === language);
    const comparePaths = (a: string, b: string) =>
      Number(preferredPaths.has(b)) - Number(preferredPaths.has(a)) || compareContext(a, b);
    const compare = (a: Candidate, b: Candidate) =>
      Number(imported(b)) - Number(imported(a)) || compareContext(a.path, b.path);
    const accepts = (candidate: Candidate) =>
      (candidate.tag.name === symbol || imported(candidate)) &&
      !(candidate.path === document.path && atPosition(candidate.tag));
    const result = await this.search(
      repository,
      document.sourceOid,
      { entry, symbols },
      [...searchNames],
      comparePaths,
      compare,
      accepts,
    );
    const matches = result.definitions;
    const targets: NavigationTarget[] = matches
      .slice(0, NAVIGATION_CANDIDATES)
      .map(({ path, tag }) => ({
        document: { ...document, path },
        name: tag.name,
        kind: tag.kind!,
        preview: tag.preview,
        line: tag.line,
        column: tag.column,
        ...(imported({ path, tag }) ? { evidence: "relative-import" as const } : {}),
      }));
    const issues = [...new Set([...symbols.issues, ...result.issues])];
    return {
      ...empty,
      status: targets.length ? "possible" : "none",
      symbol,
      targets,
      partial: issues.length > 0,
      issues,
      skippedFiles: result.skippedFiles,
      truncated: matches.length > targets.length,
    };
  }
}
