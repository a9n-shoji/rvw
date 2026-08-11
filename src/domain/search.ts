import type { SearchMatch, SearchOptions } from "./models.js";

const wordCharacter = /[\p{L}\p{N}_]/u;

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && wordCharacter.test(value);
}

function isWholeWord(text: string, start: number, end: number): boolean {
  const startsInsideWord = isWordCharacter(text[start - 1]) && isWordCharacter(text[start]);
  const endsInsideWord = isWordCharacter(text[end - 1]) && isWordCharacter(text[end]);
  return !startsInsideWord && !endsInsideWord;
}

export function findFixedStringMatches(
  text: string,
  query: string,
  options: SearchOptions,
): SearchMatch[] {
  if (query.length === 0) return [];
  const expression = new RegExp(escapeRegularExpression(query), options.matchCase ? "gu" : "giu");
  const matches: SearchMatch[] = [];
  for (const match of text.matchAll(expression)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!options.wholeWord || isWholeWord(text, start, end)) {
      matches.push({ start, end });
    }
  }
  return matches;
}
