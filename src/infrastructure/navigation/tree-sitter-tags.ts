import { navigationPack } from "../../shared/navigation-packs.js";
import type { NavigationIssue, NavigationLanguage } from "../../domain/code-navigation.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, Query, type Tree } from "web-tree-sitter";

declare const __RVW_CLI_BUNDLE__: boolean | undefined;

export interface SymbolTag {
  name: string;
  kind: string | null;
  preview: string;
  line: number;
  column: number;
  endColumn: number;
}

export interface BlobSymbols {
  tags: SymbolTag[];
  partial: boolean;
  issues: NavigationIssue[];
}

function asset(source: string, bundledName: string): string {
  if (typeof __RVW_CLI_BUNDLE__ !== "undefined" && __RVW_CLI_BUNDLE__) {
    return path.join(import.meta.dirname, "navigation", bundledName);
  }
  if (source.startsWith("./"))
    return path.resolve(import.meta.dirname, "../../shared/navigation-packs", source);
  return createRequire(import.meta.url).resolve(source);
}

const runtimes = new Map<NavigationLanguage, Promise<{ language: Language; query: Query }>>();
let initialized: Promise<void> | undefined;
function loadRuntime(id: NavigationLanguage): Promise<{ language: Language; query: Query }> {
  const cached = runtimes.get(id);
  if (cached) return cached;
  const runtime = (async () => {
    await (initialized ??= Parser.init({
      locateFile: () => asset("web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"),
    }).catch((error: unknown) => {
      initialized = undefined;
      throw error;
    }));
    const pack = navigationPack(id);
    const language = await Language.load(asset(pack.grammar, `${pack.id}/grammar.wasm`));
    const source = pack.queries
      .map((source, index) => readFileSync(asset(source, `${pack.id}/${index}.scm`), "utf8"))
      .join("\n");
    const query = new Query(language, source);
    return { language, query };
  })().catch((error: unknown) => {
    runtimes.delete(id);
    throw error;
  });
  runtimes.set(id, runtime);
  return runtime;
}

export async function extractSymbols(text: string, id: NavigationLanguage): Promise<BlobSymbols> {
  const { language, query } = await loadRuntime(id);
  const parser = new Parser();
  const deadline = performance.now() + 100;
  let cancelled = false;
  const progressCallback = (): boolean => (cancelled ||= performance.now() > deadline);
  let tree: Tree | null = null;
  try {
    parser.setLanguage(language);
    tree = parser.parse(text, null, { progressCallback });
    if (!tree) return { tags: [], partial: true, issues: ["parse-limit"] };
    const matches = query.matches(tree.rootNode, { matchLimit: 4096, progressCallback });
    const tags = new Map<string, SymbolTag>();
    const lines = text.split("\n");
    let omitted = false;
    for (const match of matches) {
      const name = match.captures.find((capture) => capture.name === "name")?.node;
      if (!name || name.startPosition.row !== name.endPosition.row || name.text.length > 256) {
        omitted ||= Boolean(name);
        continue;
      }
      const definition = match.captures.find((capture) => capture.name.startsWith("definition."));
      const kind =
        match.captures
          .find((capture) => capture.name.startsWith("definition."))
          ?.name.slice("definition.".length) ?? null;
      const tag: SymbolTag = {
        name: name.text,
        kind,
        preview: kind ? (lines[definition!.node.startPosition.row] ?? "").trim().slice(0, 240) : "",
        line: name.startPosition.row + 1,
        column: name.startPosition.column + 1,
        endColumn: name.endPosition.column + 1,
      };
      const key = `${tag.line}:${tag.column}`;
      const existing = tags.get(key);
      if (!existing || (kind && (!existing.kind || existing.kind === "variable")))
        tags.set(key, tag);
      if (tags.size >= 10_000) break;
    }
    const issues: NavigationIssue[] = [];
    if (tree.rootNode.hasError) issues.push("syntax-error");
    if (cancelled || query.didExceedMatchLimit() || tags.size >= 10_000 || omitted)
      issues.push("parse-limit");
    return { tags: [...tags.values()], partial: issues.length > 0, issues };
  } finally {
    tree?.delete();
    parser.delete();
  }
}
