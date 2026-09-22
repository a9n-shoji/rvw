import ruby from "./navigation-packs/ruby.json" with { type: "json" };
import javascript from "./navigation-packs/javascript.json" with { type: "json" };
import typescript from "./navigation-packs/typescript.json" with { type: "json" };
import tsx from "./navigation-packs/tsx.json" with { type: "json" };

/** Internal data shared by our bundled languages, parser and build.
 * This is not a public extension API; changes ship with the corresponding queries.
 */
export interface NavigationLanguagePack {
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
  if (!pack) throw new Error(`Unsupported navigation language pack: ${id}`);
  return pack;
}

/** Git wildmatch pathspecs derived only from our bundled source-file settings. */
export function navigationPathspecs(language: string): string[] {
  const family = navigationPack(language).family;
  const escape = (value: string) => value.replace(/[?*[\]\\]/g, "\\$&");
  return [
    ...new Set(
      navigationPacks
        .filter((pack) => pack.family === family)
        .flatMap((pack) => [
          ...pack.extensions.map((extension) => `:(top,glob)**/*${escape(extension)}`),
          ...pack.filenames.map((filename) => `:(top,glob)**/${escape(filename)}`),
        ]),
    ),
  ];
}
