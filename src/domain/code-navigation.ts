import type { DocumentRef } from "./models.js";
import { navigationPack, navigationPacks } from "../shared/navigation-packs.js";

export type NavigationDocument = Extract<DocumentRef, { kind: "repository-file" }>;
export type NavigationLanguage = string;

export function navigationLanguage(path: string): NavigationLanguage | null {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  return (
    navigationPacks.find(
      (pack) =>
        pack.filenames.includes(filename) ||
        pack.extensions.some((extension) => filename.endsWith(extension)),
    )?.id ?? null
  );
}

export function navigationFamily(language: NavigationLanguage): string {
  return navigationPack(language).family;
}

export type NavigationIssue =
  | "syntax-error"
  | "parse-limit"
  | "file-limit"
  | "byte-limit"
  | "definition-limit"
  | "unavailable-file"
  | "index-timeout";

export interface NavigationTarget {
  document: NavigationDocument;
  name: string;
  kind: string;
  preview: string;
  line: number;
  column: number;
  evidence?: "local-scope" | "relative-import";
}

export interface DefinitionResult {
  provider: "tree-sitter-tags";
  status: "possible" | "none" | "unsupported" | "unavailable";
  symbol: string | null;
  targets: NavigationTarget[];
  /** Incomplete indexing is never presented as an exhaustive negative result. */
  partial: boolean;
  issues: NavigationIssue[];
  skippedFiles: number;
  truncated: boolean;
}

export interface CodeNavigationProvider {
  definitions(
    repository: string,
    document: NavigationDocument,
    line: number,
    column: number,
  ): Promise<DefinitionResult>;
}

export function supportsCodeNavigation(path: string): boolean {
  return navigationLanguage(path) !== null;
}
