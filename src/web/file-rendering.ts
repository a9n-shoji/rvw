import { getFiletypeFromFileName, type FileContents } from "@pierre/diffs";

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
