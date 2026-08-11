import { diffArrays } from "diff";
import type { MappedRange } from "./models.js";
import { hashDocument, normalizeLf } from "./pr-markdown.js";

export interface MutableDocumentCommentAnchor {
  sourceDocumentHash: string | null;
  quotedText: string | null;
  startLine: number | null;
  endLine: number | null;
}

export type MutableDocumentCommentPlacement =
  { outdated: false; range: MappedRange | null } | { outdated: true; range: null };

function lines(text: string): string[] {
  return normalizeLf(text).split("\n");
}

/**
 * Conservatively maps an inclusive 1-based line range. A source line must
 * survive unchanged and contiguously; replacements and ambiguous matches are
 * deliberately treated as outdated.
 */
export function mapUnchangedLineRange(
  sourceText: string,
  destinationText: string,
  startLine: number,
  endLine: number,
): MappedRange | null {
  if (startLine < 1 || endLine < startLine) return null;
  const sourceLines = lines(sourceText);
  if (endLine > sourceLines.length) return null;
  if (sourceText === destinationText) return { startLine, endLine };

  const mapping = new Map<number, number>();
  let sourceIndex = 1;
  let destinationIndex = 1;
  for (const part of diffArrays(sourceLines, lines(destinationText))) {
    const count = part.value.length;
    if (part.removed) {
      sourceIndex += count;
      continue;
    }
    if (part.added) {
      destinationIndex += count;
      continue;
    }
    for (let offset = 0; offset < count; offset += 1) {
      mapping.set(sourceIndex + offset, destinationIndex + offset);
    }
    sourceIndex += count;
    destinationIndex += count;
  }

  const mappedStart = mapping.get(startLine);
  const mappedEnd = mapping.get(endLine);
  if (mappedStart === undefined || mappedEnd === undefined) return null;
  for (let line = startLine; line <= endLine; line += 1) {
    if (mapping.get(line) !== mappedStart + line - startLine) return null;
  }
  const selected = sourceLines.slice(startLine - 1, endLine);
  let occurrences = 0;
  const destinationLines = lines(destinationText);
  for (let index = 0; index <= destinationLines.length - selected.length; index += 1) {
    if (selected.every((line, offset) => destinationLines[index + offset] === line))
      occurrences += 1;
    if (occurrences > 1) return null;
  }
  return { startLine: mappedStart, endLine: mappedEnd };
}

export function findUniqueQuotedLineRange(
  quotedText: string,
  destinationText: string,
): MappedRange | null {
  const selected = lines(quotedText);
  const destination = lines(destinationText);
  let match: MappedRange | null = null;
  for (let index = 0; index <= destination.length - selected.length; index += 1) {
    if (!selected.every((line, offset) => destination[index + offset] === line)) continue;
    if (match) return null;
    match = { startLine: index + 1, endLine: index + selected.length };
  }
  return match;
}

/**
 * Places a comment in a mutable document that intentionally has no retained revisions.
 * Exact hashes keep the original range; otherwise only one exact quoted-line match can re-anchor it.
 */
export function placeMutableDocumentComment(
  anchor: MutableDocumentCommentAnchor,
  currentText: string,
): MutableDocumentCommentPlacement {
  if (anchor.startLine === null || anchor.endLine === null) {
    return { outdated: false, range: null };
  }
  if (
    anchor.sourceDocumentHash !== null &&
    anchor.sourceDocumentHash === hashDocument(currentText)
  ) {
    return {
      outdated: false,
      range: { startLine: anchor.startLine, endLine: anchor.endLine },
    };
  }
  const range = anchor.quotedText
    ? findUniqueQuotedLineRange(anchor.quotedText, currentText)
    : null;
  return range ? { outdated: false, range } : { outdated: true, range: null };
}
