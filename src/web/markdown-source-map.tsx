import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MarkdownSourceRange {
  startLine: number;
  endLine: number;
}

export interface MarkdownCommentAnnotation {
  id: string;
  range: MarkdownSourceRange | null;
}

interface SourcePoint {
  line: number;
  column?: number;
  offset?: number;
}

interface SourcePosition {
  start: SourcePoint;
  end: SourcePoint;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: SourcePosition;
}

interface SourceMapOptions {
  annotations?: MarkdownCommentAnnotation[];
  activeCommentId?: string | null;
  selectedRange?: MarkdownSourceRange | null;
  composerOpen?: boolean;
}

const blockTags = new Set([
  "blockquote",
  "details",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "ul",
]);

function addClass(node: HastNode, className: string): void {
  node.properties ??= {};
  const current = node.properties.className;
  const classes = Array.isArray(current)
    ? current.map(String)
    : typeof current === "string"
      ? current.split(/\s+/u).filter(Boolean)
      : [];
  if (!classes.includes(className)) classes.push(className);
  node.properties.className = classes;
}

function positionProperties(position: SourcePosition): Record<string, unknown> {
  return {
    dataRvwSourceStartLine: position.start.line,
    dataRvwSourceEndLine: position.end.line,
  };
}

function textLineSpans(node: HastNode, fallbackPosition?: SourcePosition): HastNode[] {
  const value = node.value ?? "";
  const position = node.position ?? fallbackPosition;
  if (!position) return [node];
  const parts = value.split("\n");
  if (parts.length === 1) {
    return [
      {
        type: "element",
        tagName: "span",
        properties: {
          ...positionProperties(position),
          dataRvwSourceLeaf: "true",
        },
        children: [{ type: "text", value }],
        position,
      },
    ];
  }
  const result: HastNode[] = [];
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1 && part === "" && value.endsWith("\n")) continue;
    const line = Math.min(position.start.line + index, position.end.line);
    if (part) {
      result.push({
        type: "element",
        tagName: "span",
        properties: {
          dataRvwSourceStartLine: line,
          dataRvwSourceEndLine: line,
          dataRvwSourceLeaf: "true",
        },
        children: [{ type: "text", value: part }],
        position: {
          start: { line },
          end: { line },
        },
      });
    }
    if (index < parts.length - 1) result.push({ type: "text", value: "\n" });
  }
  return result;
}

function inferredTextPosition(
  parentPosition: SourcePosition | undefined,
  startLine: number | undefined,
  value: string,
): SourcePosition | undefined {
  if (!parentPosition || startLine === undefined) return undefined;
  const lineCount = Math.max(1, value.split("\n").length);
  return {
    start: { line: startLine },
    end: { line: Math.min(startLine + lineCount - 1, parentPosition.end.line) },
  };
}

function codeTextPosition(node: HastNode, value: string): SourcePosition | undefined {
  const position = node.position;
  if (!position) return undefined;
  const parts = value.split("\n");
  const contentLineCount = Math.max(1, value.endsWith("\n") ? parts.length - 1 : parts.length);
  const sourceLineCount = position.end.line - position.start.line + 1;
  const startsAfterFence = sourceLineCount >= contentLineCount + 2;
  const startLine = position.start.line + (startsAfterFence ? 1 : 0);
  return {
    start: { line: startLine },
    end: { line: startLine + contentLineCount - 1 },
  };
}

function decorateSourcePositions(node: HastNode): void {
  if (node.type === "element" && node.position) {
    node.properties = { ...node.properties, ...positionProperties(node.position) };
  }
  if (!node.children) return;
  const codeElement = node.type === "element" && node.tagName === "code";
  const nextChildren: HastNode[] = [];
  let inferredLine = node.position?.start.line;
  for (const child of node.children) {
    if (child.type === "text") {
      const fallbackPosition = codeElement
        ? codeTextPosition(node, child.value ?? "")
        : inferredTextPosition(node.position, inferredLine, child.value ?? "");
      if (child.position || fallbackPosition) {
        const position = child.position ?? fallbackPosition;
        nextChildren.push(...textLineSpans(child, position));
        inferredLine = position?.end.line ?? inferredLine;
        continue;
      }
    }
    decorateSourcePositions(child);
    inferredLine = child.position?.end.line ?? inferredLine;
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

function overlaps(position: SourcePosition | undefined, range: MarkdownSourceRange): boolean {
  return Boolean(
    position && position.start.line <= range.endLine && position.end.line >= range.startLine,
  );
}

function highlightRanges(
  node: HastNode,
  annotations: MarkdownCommentAnnotation[],
  activeCommentId: string | null,
  selectedRange: MarkdownSourceRange | null,
): void {
  if (node.type === "element" && node.properties?.dataRvwSourceLeaf === "true") {
    if (
      activeCommentId &&
      annotations.some(
        (annotation) =>
          annotation.id === activeCommentId &&
          annotation.range &&
          overlaps(node.position, annotation.range),
      )
    ) {
      addClass(node, "rvw-markdown-commented");
    }
    if (selectedRange && overlaps(node.position, selectedRange)) {
      addClass(node, "rvw-markdown-selected");
    }
  }
  node.children?.forEach((child) =>
    highlightRanges(child, annotations, activeCommentId, selectedRange),
  );
}

function findCommentAnchor(root: HastNode, line: number): HastNode | null {
  let best: { node: HastNode; depth: number; span: number } | null = null;
  let bestList: { node: HastNode; depth: number } | null = null;
  const pending: Array<{ node: HastNode; depth: number }> = [{ node: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const { node, depth } = current;
    if (
      node.type === "element" &&
      node.tagName &&
      blockTags.has(node.tagName) &&
      node.position &&
      node.position.start.line <= line &&
      node.position.end.line >= line
    ) {
      const span = node.position.end.line - node.position.start.line;
      if (!best || depth > best.depth || (depth === best.depth && span < best.span)) {
        best = { node, depth, span };
      }
      if (
        (node.tagName === "ul" || node.tagName === "ol") &&
        (!bestList || depth > bestList.depth)
      ) {
        bestList = { node, depth };
      }
    }
    node.children?.forEach((child) => pending.push({ node: child, depth: depth + 1 }));
  }
  return bestList?.node ?? best?.node ?? null;
}

function insertCommentAnchors(root: HastNode, annotations: MarkdownCommentAnnotation[]): void {
  const anchors = new Map<HastNode, string[]>();
  const rootComments: string[] = [];
  for (const annotation of annotations) {
    if (!annotation.range) {
      rootComments.push(annotation.id);
      continue;
    }
    const anchor = findCommentAnchor(root, annotation.range.endLine);
    if (!anchor) {
      rootComments.push(annotation.id);
      continue;
    }
    const ids = anchors.get(anchor) ?? [];
    ids.push(annotation.id);
    anchors.set(anchor, ids);
  }
  const insert = (node: HastNode): void => {
    if (!node.children) return;
    const children: HastNode[] = [];
    for (const child of node.children) {
      insert(child);
      children.push(child);
      const ids = anchors.get(child);
      if (ids) {
        children.push({
          type: "element",
          tagName: "div",
          properties: { dataRvwCommentAnchor: ids.join(",") },
          children: [],
        });
      }
    }
    node.children = children;
  };
  insert(root);
  if (rootComments.length > 0) {
    root.children ??= [];
    root.children.unshift({
      type: "element",
      tagName: "div",
      properties: { dataRvwCommentAnchor: rootComments.join(",") },
      children: [],
    });
  }
}

function insertComposerAnchor(root: HastNode, selectedRange: MarkdownSourceRange | null): void {
  if (!selectedRange) return;
  const line = selectedRange.endLine;
  const insertAfterSelectedBlock = (node: HastNode): boolean => {
    if (!node.children) return false;
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index]!;
      const containsLine = Boolean(
        child.position && child.position.start.line <= line && child.position.end.line >= line,
      );
      if (!containsLine) {
        if (insertAfterSelectedBlock(child)) return true;
        continue;
      }
      const isListOrTable =
        child.tagName === "ul" || child.tagName === "ol" || child.tagName === "table";
      if (!isListOrTable && insertAfterSelectedBlock(child)) return true;
      if (child.type === "element" && child.tagName && blockTags.has(child.tagName)) {
        node.children.splice(index + 1, 0, {
          type: "element",
          tagName: "div",
          properties: {
            className: ["markdown-selection-composer-slot"],
            dataRvwComposerAnchor: "true",
          },
          children: [],
        });
        return true;
      }
    }
    return false;
  };
  if (!insertAfterSelectedBlock(root)) {
    root.children ??= [];
    root.children.push({
      type: "element",
      tagName: "div",
      properties: {
        className: ["markdown-selection-composer-slot"],
        dataRvwComposerAnchor: "true",
      },
      children: [],
    });
  }
}

export function rehypeRvwSourceMap(options: SourceMapOptions = {}) {
  return (tree: HastNode): void => {
    const annotations = options.annotations ?? [];
    decorateSourcePositions(tree);
    highlightRanges(
      tree,
      annotations,
      options.activeCommentId ?? null,
      options.composerOpen ? (options.selectedRange ?? null) : null,
    );
    insertCommentAnchors(tree, annotations);
    insertComposerAnchor(tree, options.composerOpen ? (options.selectedRange ?? null) : null);
  };
}

function mappedElementAtBoundary(
  container: HTMLElement,
  node: Node,
  offset: number,
  edge: "start" | "end",
): HTMLElement | null {
  let candidate: Node | null = node;
  if (node instanceof Element && node.childNodes.length > 0) {
    const index =
      edge === "start" ? Math.min(offset, node.childNodes.length - 1) : Math.max(0, offset - 1);
    candidate = node.childNodes[index] ?? node;
  }
  const element = candidate instanceof Element ? candidate : candidate?.parentElement;
  if (!element) return null;
  const leaf = element.closest<HTMLElement>("[data-rvw-source-leaf='true']");
  if (leaf && container.contains(leaf)) return leaf;
  const leafDescendants = element.querySelectorAll<HTMLElement>("[data-rvw-source-leaf='true']");
  if (leafDescendants.length > 0) {
    return edge === "start"
      ? (leafDescendants[0] ?? null)
      : (leafDescendants[leafDescendants.length - 1] ?? null);
  }
  const direct = element.closest<HTMLElement>("[data-rvw-source-start-line]");
  if (direct && container.contains(direct)) return direct;
  const descendants = element.querySelectorAll<HTMLElement>("[data-rvw-source-start-line]");
  return edge === "start"
    ? (descendants[0] ?? null)
    : (descendants[descendants.length - 1] ?? null);
}

function isCommentUiBoundary(container: HTMLElement, node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  const commentUi = element?.closest(".comment-thread");
  return Boolean(commentUi && container.contains(commentUi));
}

export function markdownRangeFromSelection(
  container: HTMLElement,
  selection: Selection | null,
): MarkdownSourceRange | null {
  if (
    !selection ||
    selection.rangeCount === 0 ||
    selection.isCollapsed ||
    !selection.toString().trim()
  ) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer))
    return null;
  if (
    isCommentUiBoundary(container, range.startContainer) ||
    isCommentUiBoundary(container, range.endContainer)
  ) {
    return null;
  }
  const start = mappedElementAtBoundary(
    container,
    range.startContainer,
    range.startOffset,
    "start",
  );
  const end = mappedElementAtBoundary(container, range.endContainer, range.endOffset, "end");
  const startLine = Number(start?.dataset.rvwSourceStartLine);
  const endLine = Number(end?.dataset.rvwSourceEndLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < 1) {
    return null;
  }
  return {
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
  };
}

function markdownRangeFromPointerTarget(
  container: HTMLElement,
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): MarkdownSourceRange | null {
  const caretPosition = document.caretPositionFromPoint?.(clientX, clientY);
  const caretRange = (
    document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  ).caretRangeFromPoint?.(clientX, clientY);
  const caretNode = caretPosition?.offsetNode ?? caretRange?.startContainer ?? null;
  const candidates = [caretNode, target];
  let mapped: HTMLElement | null = null;
  for (const candidate of candidates) {
    const element =
      candidate instanceof Element
        ? candidate
        : candidate instanceof Node
          ? candidate.parentElement
          : null;
    if (!element || !container.contains(element)) continue;
    mapped =
      element.closest<HTMLElement>("[data-rvw-source-leaf='true']") ??
      element.closest<HTMLElement>("[data-rvw-source-start-line]");
    if (mapped && container.contains(mapped)) break;
  }
  if (!mapped) return null;
  const startLine = Number(mapped.dataset.rvwSourceStartLine);
  const endLine = Number(mapped.dataset.rvwSourceEndLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < 1) {
    return null;
  }
  return { startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) };
}

export function markdownRangeFromPointerIntent(
  selectionRange: MarkdownSourceRange,
  pointerStartRange: MarkdownSourceRange | null,
  pointerEndRange: MarkdownSourceRange | null,
): MarkdownSourceRange {
  return pointerStartRange && pointerEndRange
    ? {
        startLine: Math.min(pointerStartRange.startLine, pointerEndRange.startLine),
        endLine: Math.max(pointerStartRange.endLine, pointerEndRange.endLine),
      }
    : selectionRange;
}

export function markdownCommentAnchorIds(node: unknown): string[] {
  const properties = (node as { properties?: Record<string, unknown> } | null)?.properties;
  const value = properties?.dataRvwCommentAnchor;
  return typeof value === "string" ? value.split(",").filter(Boolean) : [];
}

export function markdownNodeSourceRange(node: unknown): MarkdownSourceRange | null {
  const position = (node as { position?: SourcePosition } | null)?.position;
  if (!position || position.start.line < 1 || position.end.line < position.start.line) return null;
  return { startLine: position.start.line, endLine: position.end.line };
}

export function markdownSourceDataAttributes(node: unknown): Record<string, number> {
  const range = markdownNodeSourceRange(node);
  return range
    ? {
        "data-rvw-source-start-line": range.startLine,
        "data-rvw-source-end-line": range.endLine,
      }
    : {};
}

function rangeLabel(range: MarkdownSourceRange): string {
  return range.startLine === range.endLine
    ? `L${range.startLine}`
    : `L${range.startLine}–${range.endLine}`;
}

export function MarkdownSelectionSurface({
  children,
  className,
  selectedRange,
  composerOpen,
  onSelection,
  onOpenComposer,
  composer,
}: {
  children: ReactNode;
  className?: string;
  selectedRange: MarkdownSourceRange | null;
  composerOpen: boolean;
  onSelection: (range: MarkdownSourceRange | null) => void;
  onOpenComposer: () => void;
  composer: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pointerStartRangeRef = useRef<MarkdownSourceRange | null>(null);
  const pointerSelectingRef = useRef(false);
  const pendingSelectionClearRef = useRef<number | null>(null);
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const [transientRange, setTransientRange] = useState<MarkdownSourceRange | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [popoverLeft, setPopoverLeft] = useState<number | null>(null);
  const [composerHost, setComposerHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (composerOpen) return;
    const clearInvalidSelection = (): void => {
      if (pointerSelectingRef.current) return;
      const container = containerRef.current;
      if (container && markdownRangeFromSelection(container, window.getSelection())) return;
      setTransientRange(null);
      setAnchor(null);
      setPopoverLeft(null);
    };
    document.addEventListener("selectionchange", clearInvalidSelection);
    return () => document.removeEventListener("selectionchange", clearInvalidSelection);
  }, [composerOpen]);
  useEffect(() => {
    if (composerOpen || selectedRange) return;
    const container = containerRef.current;
    if (container && markdownRangeFromSelection(container, window.getSelection())) return;
    setTransientRange(null);
    setAnchor(null);
    setPopoverLeft(null);
  }, [composerOpen, selectedRange]);
  useEffect(
    () => () => {
      if (pendingSelectionClearRef.current !== null) {
        window.clearTimeout(pendingSelectionClearRef.current);
      }
    },
    [],
  );
  useLayoutEffect(() => {
    const container = containerRef.current;
    const popover = popoverRef.current;
    if (!anchor || !container || !popover) return;
    const edgePadding = 12;
    const updatePosition = (): void => {
      const availableWidth = Math.max(0, container.clientWidth - edgePadding * 2);
      const popoverWidth = Math.min(popover.offsetWidth, availableWidth);
      const minimumLeft = edgePadding + popoverWidth / 2;
      const maximumLeft = container.clientWidth - edgePadding - popoverWidth / 2;
      const nextLeft = Math.max(minimumLeft, Math.min(anchor.left, maximumLeft));
      setPopoverLeft((current) =>
        current !== null && Math.abs(current - nextLeft) < 0.5 ? current : nextLeft,
      );
    };
    updatePosition();
    let scrollFrame: number | null = null;
    if (composerOpen) {
      scrollFrame = window.requestAnimationFrame(() => {
        popover.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    }
    const observer = new ResizeObserver(updatePosition);
    observer.observe(container);
    observer.observe(popover);
    return () => {
      observer.disconnect();
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
    };
  }, [anchor, composerOpen]);
  useLayoutEffect(() => {
    if (!composerOpen) {
      setComposerHost(null);
      return;
    }
    const container = containerRef.current;
    const host = container?.querySelector<HTMLDivElement>("[data-rvw-composer-anchor='true']");
    if (!host) return;
    setComposerHost(host);
    const frame = window.requestAnimationFrame(() => {
      host.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [composerOpen, selectedRange?.endLine, selectedRange?.startLine]);
  const updateSelection = (
    pointerStartRange: MarkdownSourceRange | null = null,
    pointerEndRange: MarkdownSourceRange | null = null,
  ): void => {
    const container = containerRef.current;
    if (!container) return;
    const selection = window.getSelection();
    const selectionRange = markdownRangeFromSelection(container, selection);
    if (!selectionRange || !selection) {
      setTransientRange(null);
      setAnchor(null);
      setPopoverLeft(null);
      return;
    }
    const sourceRange = markdownRangeFromPointerIntent(
      selectionRange,
      pointerStartRange,
      pointerEndRange,
    );
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setPopoverLeft(null);
    setAnchor({
      left: rect.left + rect.width / 2 - containerRect.left,
      top: Math.max(8, rect.bottom - containerRect.top + 8),
    });
    setTransientRange(sourceRange);
  };
  const displayedRange = composerOpen ? selectedRange : transientRange;
  return (
    <div
      className={["markdown-comment-surface", className].filter(Boolean).join(" ")}
      ref={containerRef}
      onPointerDown={(event) => {
        if (pendingSelectionClearRef.current !== null) {
          window.clearTimeout(pendingSelectionClearRef.current);
          pendingSelectionClearRef.current = null;
        }
        if (event.button !== 0) {
          pointerSelectingRef.current = false;
          pointerStartRangeRef.current = null;
          return;
        }
        pointerSelectingRef.current = true;
        pointerStartRangeRef.current = markdownRangeFromPointerTarget(
          event.currentTarget,
          event.target,
          event.clientX,
          event.clientY,
        );
      }}
      onPointerUp={(event) => {
        if (
          (event.target as Element).closest(
            ".markdown-selection-popover, button, input, textarea, select",
          )
        ) {
          pointerSelectingRef.current = false;
          pointerStartRangeRef.current = null;
          return;
        }
        const pointerStartRange = pointerStartRangeRef.current;
        const pointerEndRange = markdownRangeFromPointerTarget(
          event.currentTarget,
          event.target,
          event.clientX,
          event.clientY,
        );
        pointerStartRangeRef.current = null;
        pointerSelectingRef.current = false;
        const container = containerRef.current;
        const selectionRange = container
          ? markdownRangeFromSelection(container, window.getSelection())
          : null;
        if (selectionRange) {
          updateSelection(pointerStartRange, pointerEndRange);
          return;
        }
        // Preserve the browser's two-click sequence before treating a click as a clear.
        pendingSelectionClearRef.current = window.setTimeout(() => {
          pendingSelectionClearRef.current = null;
          updateSelection();
        }, 250);
      }}
      onPointerCancel={() => {
        pointerSelectingRef.current = false;
        pointerStartRangeRef.current = null;
      }}
      onKeyUp={(event) => {
        if (
          (event.target as Element).closest(
            ".markdown-selection-popover, button, input, textarea, select",
          )
        )
          return;
        window.requestAnimationFrame(() => updateSelection());
      }}
    >
      {children}
      {displayedRange && anchor && !composerHost && (
        <div
          ref={popoverRef}
          className={`markdown-selection-popover${composerOpen ? " is-composing" : ""}`}
          style={{ left: popoverLeft ?? anchor.left, top: anchor.top }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {composerOpen ? (
            composer
          ) : (
            <button
              className="markdown-selection-comment-action"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                onSelectionRef.current(displayedRange);
                onOpenComposer();
              }}
            >
              {rangeLabel(displayedRange)}へコメント
            </button>
          )}
        </div>
      )}
      {composerHost && createPortal(composer, composerHost)}
    </div>
  );
}
