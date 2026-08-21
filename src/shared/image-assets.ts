export const SUPPORTED_IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
] as const;

export type ImageContentType =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "image/svg+xml";

const githubAttachmentPathPattern =
  /^\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const utf8Fatal = new TextDecoder("utf-8", { fatal: true });

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint16Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function uint32Be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function uint32Le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) +
      ((bytes[offset + 1] ?? 0) << 8) +
      ((bytes[offset + 2] ?? 0) << 16) +
      (bytes[offset + 3] ?? 0) * 0x1000000) >>>
    0
  );
}

function isSvg(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let text: string;
  try {
    text = utf8Fatal.decode(bytes);
  } catch {
    return false;
  }
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let candidate = withoutBom.trimStart();
  const declaration = /^<\?xml(?:\s[^?]*)?\?>/iu.exec(candidate);
  if (declaration) candidate = candidate.slice(declaration[0].length).trimStart();
  while (candidate.startsWith("<!--")) {
    const commentEnd = candidate.indexOf("-->");
    if (commentEnd < 0) return false;
    candidate = candidate.slice(commentEnd + 3).trimStart();
  }
  return /^<svg(?:\s|>)/iu.test(candidate);
}

export function isSupportedImagePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

export function canonicalGitHubAttachmentUrl(value: string | undefined): string | null {
  if (!value?.startsWith("https://github.com/")) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !githubAttachmentPathPattern.test(parsed.pathname)
  ) {
    return null;
  }
  return parsed.href;
}

export function detectImageContentType(bytes: Uint8Array): ImageContentType | null {
  if (
    bytes.length >= 33 &&
    hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
    ascii(bytes, 12, 4) === "IHDR" &&
    uint32Be(bytes, 16) > 0 &&
    uint32Be(bytes, 20) > 0
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 10 &&
    hasBytes(bytes, 0, [0xff, 0xd8, 0xff]) &&
    hasBytes(bytes, bytes.length - 2, [0xff, 0xd9])
  ) {
    return "image/jpeg";
  }

  const gifHeader = bytes.length >= 13 ? ascii(bytes, 0, 6) : "";
  if (
    (gifHeader === "GIF87a" || gifHeader === "GIF89a") &&
    uint16Le(bytes, 6) > 0 &&
    uint16Le(bytes, 8) > 0
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 20 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(ascii(bytes, 12, 4)) &&
    uint32Le(bytes, 4) >= 12 &&
    uint32Le(bytes, 4) + 8 <= bytes.length
  ) {
    return "image/webp";
  }

  if (bytes.length >= 16 && ascii(bytes, 4, 4) === "ftyp") {
    const boxSize = uint32Be(bytes, 0);
    if (boxSize >= 16 && boxSize <= bytes.length) {
      const brands = [ascii(bytes, 8, 4)];
      for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
        brands.push(ascii(bytes, offset, 4));
      }
      if (brands.some((brand) => brand === "avif" || brand === "avis")) {
        return "image/avif";
      }
    }
  }

  return isSvg(bytes) ? "image/svg+xml" : null;
}

export function imageContentTypeHeader(contentType: ImageContentType): string {
  return contentType === "image/svg+xml" ? `${contentType}; charset=utf-8` : contentType;
}
