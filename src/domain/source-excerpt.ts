import { normalizeLf } from "./pr-markdown.js";

export const SOURCE_EXCERPT_CONTEXT_LINES = 20;
export const MAX_SOURCE_EXCERPT_LINES = 200;
export const MAX_SOURCE_EXCERPT_BYTES = 64 * 1024;

export interface SourceExcerpt {
  startLine: number;
  endLine: number;
  text: string;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  truncatedByBytes: boolean;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function createSourceExcerpt(
  value: string,
  focusStartLine: number | null,
  focusEndLine: number | null,
): SourceExcerpt {
  const lines = normalizeLf(value).split("\n");
  const lineCount = lines.length;
  const hasFocus = focusStartLine !== null && focusEndLine !== null;
  const focusStart = hasFocus ? focusStartLine : 1;
  const focusEnd = hasFocus ? focusEndLine : Math.min(lineCount, MAX_SOURCE_EXCERPT_LINES);

  let startLine = hasFocus ? Math.max(1, focusStart - SOURCE_EXCERPT_CONTEXT_LINES) : 1;
  let endLine = hasFocus ? Math.min(lineCount, focusEnd + SOURCE_EXCERPT_CONTEXT_LINES) : focusEnd;

  if (endLine - startLine + 1 > MAX_SOURCE_EXCERPT_LINES) {
    endLine = startLine + MAX_SOURCE_EXCERPT_LINES - 1;
    if (focusEnd - focusStart + 1 <= MAX_SOURCE_EXCERPT_LINES && endLine < focusEnd) {
      endLine = focusEnd;
      startLine = endLine - MAX_SOURCE_EXCERPT_LINES + 1;
    }
  }

  const selectedText = (): string => lines.slice(startLine - 1, endLine).join("\n");
  while (
    Buffer.byteLength(selectedText(), "utf8") > MAX_SOURCE_EXCERPT_BYTES &&
    startLine < focusStart
  ) {
    startLine += 1;
  }
  while (
    Buffer.byteLength(selectedText(), "utf8") > MAX_SOURCE_EXCERPT_BYTES &&
    endLine > focusEnd
  ) {
    endLine -= 1;
  }

  const unboundedText = selectedText();
  const truncatedByBytes = Buffer.byteLength(unboundedText, "utf8") > MAX_SOURCE_EXCERPT_BYTES;
  const text = truncatedByBytes
    ? truncateUtf8(unboundedText, MAX_SOURCE_EXCERPT_BYTES)
    : unboundedText;
  const includedLineCount = text.split("\n").length;
  const reportedEndLine = Math.min(endLine, startLine + includedLineCount - 1);

  return {
    startLine,
    endLine: reportedEndLine,
    text,
    truncatedBefore: startLine > 1,
    truncatedAfter: reportedEndLine < lineCount || truncatedByBytes,
    truncatedByBytes,
  };
}
