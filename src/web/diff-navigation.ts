export interface DiffLineNavigationTarget {
  line: number | null;
  endLine?: number;
}

export interface DiffNavigationWindow {
  startLine: number;
  endLine: number;
}

export const DIFF_NAVIGATION_CONTEXT_LINES = 5;

export function diffNavigationWindow(
  target: DiffLineNavigationTarget,
  contextLines = DIFF_NAVIGATION_CONTEXT_LINES,
): DiffNavigationWindow | null {
  if (target.line === null || target.endLine === undefined) return null;
  const firstLine = Math.min(target.line, target.endLine);
  const lastLine = Math.max(target.line, target.endLine);
  return {
    startLine: Math.max(1, firstLine - contextLines),
    endLine: lastLine + contextLines,
  };
}

export function firstCollapsedDiffNavigationLine(
  target: DiffLineNavigationTarget,
  isLineRenderable: (line: number) => boolean,
): number | null {
  const window = diffNavigationWindow(target);
  if (!window) return null;
  for (let line = window.startLine; line <= window.endLine; line += 1) {
    if (!isLineRenderable(line)) return line;
  }
  return null;
}
