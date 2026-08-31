import {
  getFiletypeFromFileName,
  parseDiffFromFile,
  SPLIT_WITH_NEWLINES,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";

const whitespaceExceptLineEndings = /[^\S\r\n]+/gu;

function withoutWhitespace(contents: string): string {
  return contents.replace(whitespaceExceptLineEndings, "");
}

function originalLines(contents: string): string[] {
  return contents === "" ? [] : contents.split(SPLIT_WITH_NEWLINES);
}

function whitespaceComparisonFile(file: FileContents): FileContents {
  return {
    ...file,
    contents: withoutWhitespace(file.contents),
    cacheKey: `${file.cacheKey ?? file.name}:hide-whitespace`,
  };
}

export function fileContentsForRenderer(
  name: string,
  contents: string,
  cacheKey?: string,
): FileContents {
  return {
    name,
    contents,
    lang: getFiletypeFromFileName(name),
    ...(cacheKey === undefined ? {} : { cacheKey }),
  };
}

export function diffForRenderer(
  oldFile: FileContents | null,
  newFile: FileContents | null,
  hideWhitespace: boolean,
): FileDiffMetadata {
  if (!hideWhitespace || oldFile === null || newFile === null) {
    return parseDiffFromFile(oldFile, newFile);
  }

  const diff = parseDiffFromFile(
    whitespaceComparisonFile(oldFile),
    whitespaceComparisonFile(newFile),
  );
  return {
    ...diff,
    deletionLines: originalLines(oldFile.contents),
    additionLines: originalLines(newFile.contents),
  };
}
