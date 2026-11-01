import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { detectImageContentType } from "../shared/image-assets.js";
import { MAX_WALKTHROUGH_BODY_BYTES } from "../shared/constants.js";
import {
  MAX_WALKTHROUGH_ASSETS,
  MAX_WALKTHROUGH_ASSET_BYTES,
  MAX_WALKTHROUGH_ASSETS_BYTES,
  validateWalkthroughAssets,
  type WalkthroughAssetInput,
} from "../shared/walkthrough-assets.js";
import { RvwError } from "../shared/errors.js";

export async function importWalkthroughFiles(
  input: unknown,
  options: { html?: string; assetsDir?: string },
): Promise<unknown> {
  if (!options.html && !options.assetsDir) return input;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RvwError("INVALID_INPUT", "Metadata must be a JSON object.");
  const result = { ...input } as Record<string, unknown>;
  if (options.html) {
    if (Object.hasOwn(result, "body"))
      throw new RvwError("INVALID_INPUT", "Use either body or --html, not both.");
    const file = await lstat(options.html);
    if (!file.isFile() || file.size > MAX_WALKTHROUGH_BODY_BYTES - 64)
      throw new RvwError(
        "INVALID_INPUT",
        "HTML file must be a regular file within the body size limit.",
      );
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(options.html));
    } catch {
      throw new RvwError("INVALID_INPUT", "HTML import requires a readable UTF-8 file.");
    }
    const fence = "~".repeat(
      Math.max(3, ...[...source.matchAll(/~+/gu)].map((match) => match[0].length + 1)),
    );
    result.body = `${fence}html-preview\n${source}\n${fence}`;
  }
  if (options.assetsDir) {
    if (Object.hasOwn(result, "assets"))
      throw new RvwError("INVALID_INPUT", "Use either assets or --assets-dir, not both.");
    const root = path.resolve(options.assetsDir);
    const assetBase = options.html ? path.dirname(path.resolve(options.html)) : root;
    if (!(await lstat(root)).isDirectory())
      throw new RvwError("INVALID_INPUT", "Asset directory must not be a symlink.");
    const assets: WalkthroughAssetInput[] = [];
    let total = 0;
    let entries = 0;
    const visit = async (directory: string, depth = 0): Promise<void> => {
      if (depth > 16)
        throw new RvwError("INVALID_INPUT", "Asset directory nesting exceeds 16 levels.");
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 256)
          throw new RvwError("INVALID_INPUT", "Asset directory contains too many entries.");
        const fullPath = path.join(directory, entry.name);
        const stat = await lstat(fullPath);
        if (stat.isSymbolicLink())
          throw new RvwError("INVALID_INPUT", "Asset symlinks are not supported.");
        if (stat.isDirectory()) {
          await visit(fullPath, depth + 1);
          continue;
        }
        if (!stat.isFile())
          throw new RvwError("INVALID_INPUT", "Asset entries must be regular files.");
        // Metadata and source documents are not assets; referenced unsupported resources still fail validation.
        if (!/\.(?:png|jpe?g|gif|webp|avif|woff2)$/iu.test(entry.name)) continue;
        total += stat.size;
        if (
          !stat.isFile() ||
          stat.size > MAX_WALKTHROUGH_ASSET_BYTES ||
          total > MAX_WALKTHROUGH_ASSETS_BYTES ||
          assets.length >= MAX_WALKTHROUGH_ASSETS
        )
          throw new RvwError("INVALID_INPUT", "Asset count/type/size limit exceeded.");
        const bytes = await readFile(fullPath);
        const mediaType =
          bytes.subarray(0, 4).toString("ascii") === "wOF2"
            ? "font/woff2"
            : detectImageContentType(bytes);
        if (!mediaType || mediaType === "image/svg+xml")
          throw new RvwError(
            "INVALID_INPUT",
            `Unsupported asset: ${entry.name}. Use inline SVG for vector graphics.`,
          );
        assets.push({
          path: path.relative(assetBase, fullPath).split(path.sep).join("/"),
          mediaType,
          base64: bytes.toString("base64"),
        });
      }
    };
    await visit(root);
    validateWalkthroughAssets(assets);
    result.assets = assets;
  }
  return result;
}
