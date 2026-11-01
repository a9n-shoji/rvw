import { createHash } from "node:crypto";
import { z } from "zod";
import { detectImageContentType } from "./image-assets.js";
import { RvwError } from "./errors.js";

export const MAX_WALKTHROUGH_ASSETS = 32;
export const MAX_WALKTHROUGH_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_WALKTHROUGH_ASSETS_BYTES = 20 * 1024 * 1024;
export const walkthroughAssetInputSchema = z
  .object({
    path: z.string().min(1).max(240),
    mediaType: z.enum([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
      "font/woff2",
    ]),
    base64: z.string().max(Math.ceil(MAX_WALKTHROUGH_ASSET_BYTES / 3) * 4),
  })
  .strict();
export type WalkthroughAssetInput = z.infer<typeof walkthroughAssetInputSchema>;
export interface WalkthroughAssetMetadata {
  path: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}
export interface ValidatedWalkthroughAsset extends WalkthroughAssetMetadata {
  bytes: Uint8Array;
}

export function validateWalkthroughAssets(
  inputs: WalkthroughAssetInput[],
): ValidatedWalkthroughAsset[] {
  if (inputs.length > MAX_WALKTHROUGH_ASSETS)
    throw new RvwError("INVALID_INPUT", "Too many bundled assets (maximum 32).");
  const paths = new Set<string>();
  let total = 0;
  return inputs.map((raw) => {
    const input = walkthroughAssetInputSchema.parse(raw);
    if (
      !/^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/u.test(input.path) ||
      input.path.split("/").some((part) => part === "." || part === "..") ||
      paths.has(input.path)
    )
      throw new RvwError("INVALID_INPUT", `Invalid or duplicate asset path: ${input.path}`);
    paths.add(input.path);
    const bytes = Buffer.from(input.base64, "base64");
    if (
      !bytes.length ||
      bytes.toString("base64") !== input.base64 ||
      bytes.length > MAX_WALKTHROUGH_ASSET_BYTES
    )
      throw new RvwError("INVALID_INPUT", `Invalid asset bytes: ${input.path}`);
    total += bytes.length;
    if (total > MAX_WALKTHROUGH_ASSETS_BYTES)
      throw new RvwError("INVALID_INPUT", "Bundled assets exceed 20 MiB.");
    let detected: string | null = detectImageContentType(bytes);
    if (
      bytes.length >= 48 &&
      bytes.toString("ascii", 0, 4) === "wOF2" &&
      bytes.readUInt32BE(8) === bytes.length &&
      bytes.readUInt16BE(12) > 0 &&
      bytes.readUInt16BE(14) === 0 &&
      bytes.readUInt32BE(16) > 0 &&
      bytes.readUInt32BE(16) <= 32 * 1024 * 1024 &&
      bytes.readUInt32BE(20) > 0 &&
      bytes.readUInt32BE(20) <= bytes.length - 48
    )
      detected = "font/woff2";
    if (detected !== input.mediaType)
      throw new RvwError("INVALID_INPUT", `Asset MIME/signature mismatch: ${input.path}`);
    return {
      path: input.path,
      mediaType: input.mediaType,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  });
}
