import { describe, expect, it } from "vitest";
import {
  canonicalGitHubAttachmentUrl,
  detectImageContentType,
  isSupportedImagePath,
} from "../../src/shared/image-assets.js";

const validAttachmentId = "37948111-1227-4cdb-a76d-dc8eb469ae5c";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("GitHub user attachment URL validation", () => {
  it("canonicalizes the modern GitHub attachment URL", () => {
    expect(
      canonicalGitHubAttachmentUrl(
        `https://github.com/user-attachments/assets/${validAttachmentId}`,
      ),
    ).toBe(`https://github.com/user-attachments/assets/${validAttachmentId}`);
  });

  it.each([
    `http://github.com/user-attachments/assets/${validAttachmentId}`,
    `https://github.com.evil.example/user-attachments/assets/${validAttachmentId}`,
    `https://evil.example/github.com/user-attachments/assets/${validAttachmentId}`,
    `https://user@github.com/user-attachments/assets/${validAttachmentId}`,
    `https://github.com:8443/user-attachments/assets/${validAttachmentId}`,
    `https://github.com:443/user-attachments/assets/${validAttachmentId}`,
    `https://github.com/user-attachments/assets/${validAttachmentId}?x=1`,
    `https://github.com/user-attachments/assets/${validAttachmentId}#fragment`,
    "https://github.com/user-attachments/assets/../secret",
    "https://github.com/issues/1",
    `//github.com/user-attachments/assets/${validAttachmentId}`,
    "data:image/png;base64,AAAA",
    "blob:https://github.com/00000000-0000-4000-8000-000000000000",
    "https://user-images.githubusercontent.com/1/example.png",
    "https://private-user-images.githubusercontent.com/1/example.png",
  ])("rejects %s", (value) => {
    expect(canonicalGitHubAttachmentUrl(value)).toBeNull();
  });
});

describe("image content detection", () => {
  it.each([
    [
      "PNG",
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0,
        0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0,
      ]),
      "image/png",
    ],
    ["JPEG", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, 0xff, 0xd9]), "image/jpeg"],
    ["GIF87a", Uint8Array.from([...bytes("GIF87a"), 1, 0, 1, 0, 0, 0, 0]), "image/gif"],
    ["GIF89a", Uint8Array.from([...bytes("GIF89a"), 1, 0, 1, 0, 0, 0, 0]), "image/gif"],
    [
      "WebP",
      Uint8Array.from([...bytes("RIFF"), 12, 0, 0, 0, ...bytes("WEBPVP8 "), 0, 0, 0, 0]),
      "image/webp",
    ],
    [
      "AVIF",
      Uint8Array.from([0, 0, 0, 24, ...bytes("ftypavif"), 0, 0, 0, 0, ...bytes("avifmif1")]),
      "image/avif",
    ],
    [
      "SVG with declaration",
      bytes('\ufeff  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      "image/svg+xml",
    ],
    [
      "SVG with generator comments",
      bytes(
        '<?xml version="1.0"?>\n<!-- Generator: Example 1.0 -->\n<!-- safe header -->\n<svg viewBox="0 0 1 1"></svg>',
      ),
      "image/svg+xml",
    ],
  ])("detects %s", (_label, fixture, contentType) => {
    expect(detectImageContentType(fixture)).toBe(contentType);
  });

  it.each([
    ["HTML", bytes("<!doctype html><html></html>")],
    ["arbitrary XML", bytes('<?xml version="1.0"?><html></html>')],
    ["SVG with doctype", bytes('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["unterminated XML comment", bytes("<!-- generated\n<svg></svg>")],
    ["JSON", bytes('{"message":"Not Found"}')],
    ["empty", new Uint8Array()],
    ["truncated PNG", Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
    ["truncated JPEG", Uint8Array.from([0xff, 0xd8, 0xff])],
    ["invalid GIF dimensions", Uint8Array.from([...bytes("GIF89a"), 0, 0, 0, 0, 0, 0, 0])],
    ["truncated WebP", bytes("RIFF")],
    ["truncated AVIF", Uint8Array.from([0, 0, 0, 24, ...bytes("ftypavif")])],
  ])("rejects %s", (_label, fixture) => {
    expect(detectImageContentType(fixture)).toBeNull();
  });
});

describe("image path detection", () => {
  it.each(["asset.PNG", "photo.JpEg", "animation.GIF", "new-name.WebP", "diagram.SVG"])(
    "accepts %s case-insensitively",
    (filePath) => expect(isSupportedImagePath(filePath)).toBe(true),
  );

  it.each(["asset.txt", "asset.png.txt", "png", "diagram.svg.backup", "folder/imagepng"])(
    "rejects misleading or non-image path %s",
    (filePath) => expect(isSupportedImagePath(filePath)).toBe(false),
  );
});
