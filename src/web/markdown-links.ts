const urlScheme = /^[A-Za-z][A-Za-z\d+.-]*:/;

export interface PointerPosition {
  x: number;
  y: number;
}

export function markdownAssetUrl(
  pullRequestId: string,
  sourceOid: string,
  filePath: string,
): string {
  const search = new URLSearchParams({ sourceOid, path: filePath });
  return `/api/pull-requests/${pullRequestId}/markdown-asset?${search.toString()}`;
}

export function markdownLinkWasDragged(
  start: PointerPosition | null,
  end: PointerPosition,
): boolean {
  return Boolean(start && Math.hypot(end.x - start.x, end.y - start.y) > 4);
}

export function isExternalMarkdownHref(href: string | undefined): boolean {
  if (!href) return false;
  const value = href.trim();
  return urlScheme.test(value) || value.startsWith("//");
}

export function resolveRepositoryMarkdownPath(
  href: string | undefined,
  sourcePath: string | null,
): string | null {
  if (!href) return null;
  const value = href.trim();
  if (
    value.length === 0 ||
    value.startsWith("#") ||
    value.startsWith("?") ||
    isExternalMarkdownHref(value)
  ) {
    return null;
  }

  const encodedPath = value.split(/[?#]/, 1)[0];
  if (!encodedPath) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath).replaceAll("\\", "/");
  } catch {
    return null;
  }

  const segments = decodedPath.startsWith("/")
    ? []
    : (sourcePath?.split("/").slice(0, -1).filter(Boolean) ?? []);
  for (const segment of decodedPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    if (segment.includes("\0")) return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}
