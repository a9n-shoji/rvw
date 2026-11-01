import type { HtmlCommentAnchor } from "../domain/models.js";

export function htmlNodePath(root: Node, node: Node): number[] | null {
  const path: number[] = [];
  let current = node;
  while (current !== root) {
    const parent = current.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return path;
}

export function resolveHtmlAnchor(
  document: Document,
  anchor: HtmlCommentAnchor,
): Element | Range | null {
  const root = document.querySelector(".rvw-preview-root");
  if (!root) return null;
  const resolve = (path: number[]): Node | null => {
    let node: Node = root;
    for (const index of path) {
      const child = node.childNodes.item(index);
      if (!child) return null;
      node = child;
    }
    return node;
  };
  const start = resolve(anchor.path);
  if (!start) return null;
  if (anchor.startOffset === undefined) return start.nodeType === 1 ? (start as Element) : null;
  const end = anchor.endPath ? resolve(anchor.endPath) : null;
  if (!end || anchor.endOffset === undefined) return null;
  try {
    const range = document.createRange();
    range.setStart(start, anchor.startOffset);
    range.setEnd(end, anchor.endOffset);
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}
