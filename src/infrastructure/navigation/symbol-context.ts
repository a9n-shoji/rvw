import { NAVIGATION_CAPTURES } from "../../shared/constants.js";
import type { Node, QueryMatch } from "web-tree-sitter";
import type { SymbolTag } from "./tree-sitter-tags.js";

export interface ScopedSymbol extends SymbolTag {
  scope: number;
}
export interface SymbolContext {
  scopes: {
    id: number;
    parent: number | null;
    inherits: boolean;
    range: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null;
  }[];
  definitions: ScopedSymbol[];
  references: ScopedSymbol[];
  imports: { localName: string; importedName: string; source: string; scope: number }[];
}

/** Interpret the standard locals captures plus the small, declarative import contract.
 * Language node names and syntax rules belong to the pack's queries, never here.
 */
export function extractContext(
  matches: QueryMatch[],
  lines: string[],
): { context: SymbolContext; limited: boolean } {
  const scopes = new Map<number, { node: Node; inherits: boolean }>();
  let count = 0;
  let limited = false;
  const bounded: QueryMatch[] = [];
  for (const match of matches) {
    if (!match.captures.some((capture) => /^(local\.|import\.|context\.)/.test(capture.name)))
      continue;
    count += match.captures.length;
    if (count > NAVIGATION_CAPTURES) {
      limited = true;
      break;
    }
    bounded.push(match);
    for (const capture of match.captures) {
      if (capture.name === "local.scope") {
        const previous = scopes.get(capture.node.id);
        scopes.set(capture.node.id, {
          node: capture.node,
          inherits:
            previous?.inherits !== false &&
            match.setProperties?.["local.scope-inherits"] !== "false",
        });
      }
    }
  }
  const scopeOf = (node: Node | null): number => {
    for (let current = node; current; current = current.parent)
      if (scopes.has(current.id)) return current.id;
    return 0;
  };
  const context: SymbolContext = {
    scopes: [
      { id: 0, parent: null, inherits: false, range: null },
      ...[...scopes.values()].map(({ node, inherits }) => ({
        id: node.id,
        parent: scopeOf(node.parent),
        inherits,
        range: {
          startLine: node.startPosition.row + 1,
          startColumn: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endColumn: node.endPosition.column + 1,
        },
      })),
    ],
    definitions: [],
    references: [],
    imports: [],
  };
  const excluded = new Set<number>();
  const definitions = new Map<number, ScopedSymbol>();
  const references = new Map<number, ScopedSymbol>();
  const symbol = (node: Node, definition: boolean): ScopedSymbol | null => {
    if (node.startPosition.row !== node.endPosition.row || node.text.length > 256) {
      limited = true;
      return null;
    }
    return {
      name: node.text,
      kind: definition ? "variable" : null,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      endColumn: node.endPosition.column + 1,
      scope: scopeOf(node),
      preview: definition ? (lines[node.startPosition.row] ?? "").trim().slice(0, 240) : "",
    };
  };
  for (const match of bounded) {
    for (const capture of match.captures) {
      if (capture.name === "context.nonlocal") excluded.add(capture.node.id);
      if (
        capture.name === "local.definition" ||
        capture.name === "local.definition.outer" ||
        capture.name === "local.reference"
      ) {
        const definition = capture.name !== "local.reference";
        const value = symbol(capture.node, definition);
        if (value) {
          // A declaration binds in its containing scope, not its own function scope.
          if (capture.name === "local.definition.outer")
            value.scope = scopeOf(capture.node.parent?.parent ?? null);
          (definition ? definitions : references).set(capture.node.id, value);
        }
      }
    }
    const imported = match.captures.find((capture) => capture.name === "import.name")?.node;
    const local =
      match.captures.find((capture) => capture.name === "import.local")?.node ?? imported;
    const source = match.captures.find((capture) => capture.name === "import.source")?.node.text;
    if (local && imported && source && source.length <= 4096 && !source.includes("\\")) {
      context.imports.push({
        localName: local.text,
        importedName: imported.text,
        source,
        scope: scopeOf(local),
      });
    }
  }
  context.definitions = [...definitions.values()];
  context.references = [...references]
    .filter(([id]) => !excluded.has(id))
    .map(([, value]) => value);
  return { context, limited };
}

export function visibleScopes(context: SymbolContext, scope: number): number[] {
  const byId = new Map(context.scopes.map((scope) => [scope.id, scope]));
  const result: number[] = [];
  const visited = new Set<number>();
  let current = byId.get(scope);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    result.push(current.id);
    if (!current.inherits || current.parent === null) break;
    current = byId.get(current.parent);
  }
  return result;
}

/** Scope for syntax tags (including type positions), independent of value references. */
export function scopeAtPosition(context: SymbolContext, line: number, column: number): number {
  let innermost = context.scopes[0]!;
  for (const scope of context.scopes) {
    const r = scope.range;
    if (
      !r ||
      line < r.startLine ||
      line > r.endLine ||
      (line === r.startLine && column < r.startColumn) ||
      (line === r.endLine && column >= r.endColumn)
    )
      continue;
    const previous = innermost.range;
    if (
      !previous ||
      r.startLine > previous.startLine ||
      (r.startLine === previous.startLine && r.startColumn >= previous.startColumn)
    )
      innermost = scope;
  }
  return innermost.id;
}
