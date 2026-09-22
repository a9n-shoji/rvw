import ruby from "./navigation-packs/ruby.json" with { type: "json" };
import javascript from "./navigation-packs/javascript.json" with { type: "json" };
import typescript from "./navigation-packs/typescript.json" with { type: "json" };
import tsx from "./navigation-packs/tsx.json" with { type: "json" };

/** Data-only pack contract, shared by selection, indexing, parser and packaging.
 * Package specifiers and ./query paths describe build-time assets, not executable plugins.
 * User-installed pack discovery/update is deliberately separate from this contract.
 */
export interface NavigationLanguagePack {
  apiVersion: number;
  id: string;
  family: string;
  extensions: readonly string[];
  filenames: readonly string[];
  grammar: string;
  queries: readonly string[];
  /** Simple relative-file hints only; not module resolution or extension substitution. */
  relativeImportSuffixes?: readonly string[];
}

export const navigationPacks: readonly NavigationLanguagePack[] = [
  ruby,
  javascript,
  typescript,
  tsx,
];

export function navigationPack(id: string): NavigationLanguagePack {
  const pack = navigationPacks.find((pack) => pack.id === id);
  if (!pack || pack.apiVersion !== 1)
    throw new Error(`Unsupported navigation language pack: ${id}`);
  return pack;
}
