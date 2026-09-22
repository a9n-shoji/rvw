import { navigationPacks } from "../src/shared/navigation-packs.ts";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { bundledPackageNotices, renderThirdPartyNotices } from "./third-party-notices.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(repositoryRoot, "dist");
rmSync(outputDirectory, { recursive: true, force: true });

const cliBuild = await esbuild({
  entryPoints: [path.join(repositoryRoot, "src/cli/main.ts")],
  outfile: path.join(outputDirectory, "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  metafile: true,
  sourcemap: true,
  define: { __RVW_CLI_BUNDLE__: "true" },
  banner: { js: "#!/usr/bin/env node" },
});
const parserBuild = await esbuild({
  entryPoints: [path.join(repositoryRoot, "src/infrastructure/navigation/parser-worker.ts")],
  outfile: path.join(outputDirectory, "parser-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  metafile: true,
  sourcemap: true,
  define: { __RVW_CLI_BUNDLE__: "true" },
});
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const unexpectedExternals = [
  ...Object.values(cliBuild.metafile.outputs),
  ...Object.values(parserBuild.metafile.outputs),
]
  .flatMap((output) => output.imports)
  .filter((item) => item.external && !nodeBuiltins.has(item.path));
if (unexpectedExternals.length > 0) {
  throw new Error(
    `CLI bundle contains non-Node external imports: ${unexpectedExternals
      .map((item) => item.path)
      .join(", ")}`,
  );
}
chmodSync(path.join(outputDirectory, "cli.mjs"), 0o755);
writeFileSync(
  path.join(outputDirectory, "cli-THIRD_PARTY_NOTICES.txt"),
  renderThirdPartyNotices(
    bundledPackageNotices([
      ...Object.keys(cliBuild.metafile.inputs),
      ...Object.keys(parserBuild.metafile.inputs),
      ...navigationPacks
        .flatMap((pack) => [pack.grammar, ...pack.queries])
        .filter((source) => !source.startsWith("./"))
        .map((source) => `node_modules/${source}`),
    ]),
    "CLI bundle",
  ),
);

const navigationAssets = path.join(outputDirectory, "navigation");
mkdirSync(navigationAssets, { recursive: true });
cpSync(
  path.join(repositoryRoot, "node_modules/web-tree-sitter/web-tree-sitter.wasm"),
  path.join(navigationAssets, "web-tree-sitter.wasm"),
);
for (const pack of navigationPacks) {
  mkdirSync(path.join(navigationAssets, pack.id), { recursive: true });
  for (const [source, output] of [
    [pack.grammar, "grammar.wasm"],
    ...pack.queries.map((source, index) => [source, `${index}.scm`]),
  ]) {
    cpSync(
      path.resolve(
        repositoryRoot,
        source.startsWith("./") ? "src/shared/navigation-packs" : "node_modules",
        source,
      ),
      path.join(navigationAssets, pack.id, output),
    );
  }
}

await viteBuild({
  configFile: path.join(repositoryRoot, "vite.config.ts"),
  root: repositoryRoot,
});
