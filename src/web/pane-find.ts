export interface PaneFindOptions {
  matchCase: boolean;
  wholeWord: boolean;
  useRegularExpression: boolean;
}

export interface PaneFindMatch {
  start: number;
  end: number;
}

export interface PaneFindTextResult {
  matches: PaneFindMatch[];
  invalidRegularExpression: boolean;
}

export interface PaneFindRangeResult {
  ranges: Range[];
  invalidRegularExpression: boolean;
}

const paneFindBlockSelector = "h1,h2,h3,h4,h5,h6,p,li,td,th,pre,summary,figcaption";
const paneFindIgnoredSelector = [
  "[data-pane-find-ignore]",
  "[hidden]",
  "[aria-hidden='true']",
  ".comment-thread",
  ".inline-comment-composer",
  ".markdown-selection-popover",
  "script",
  "style",
  "textarea",
  "input",
  "select",
  "option",
].join(",");

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function advancesByCodePoint(value: string, index: number): number {
  const codePoint = value.codePointAt(index);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

export function findPaneTextMatches(
  text: string,
  query: string,
  options: PaneFindOptions,
): PaneFindTextResult {
  if (!query) return { matches: [], invalidRegularExpression: false };
  let expression: RegExp;
  try {
    expression = new RegExp(
      options.useRegularExpression ? query : escapeRegularExpression(query),
      `gu${options.matchCase ? "" : "i"}`,
    );
  } catch {
    return { matches: [], invalidRegularExpression: true };
  }

  const matches: PaneFindMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const hasWholeWordBoundary =
      !options.wholeWord || (!isWordCharacter(text[start - 1]) && !isWordCharacter(text[end]));
    if (hasWholeWordBoundary) matches.push({ start, end });
    if (match[0].length === 0) {
      expression.lastIndex = Math.min(
        text.length,
        expression.lastIndex + advancesByCodePoint(text, start),
      );
      if (start === text.length) break;
    }
  }
  return { matches, invalidRegularExpression: false };
}

function searchableNodesWithin(
  container: Element,
  includeLineBreaks: boolean,
): Array<Text | Element> {
  const nodes: Array<Text | Element> = [];
  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT | (includeLineBreaks ? NodeFilter.SHOW_ELEMENT : 0),
  );
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current instanceof Text) {
      if (!current.data) continue;
      const parent = current.parentElement;
      if (!parent || parent.closest(paneFindIgnoredSelector)) continue;
      nodes.push(current);
      continue;
    }
    if (includeLineBreaks && current instanceof Element && current.tagName === "BR") {
      if (!current.closest(paneFindIgnoredSelector)) nodes.push(current);
    }
  }
  return nodes;
}

function textNodesWithin(container: Element): Text[] {
  return searchableNodesWithin(container, false).filter(
    (node): node is Text => node instanceof Text,
  );
}

function lightDomTextGroups(surface: HTMLElement): Text[][] {
  const groups: Text[][] = [];
  const roots = [
    ...(surface.matches("[data-pane-find-text]") ? [surface] : []),
    ...surface.querySelectorAll<HTMLElement>("[data-pane-find-text]"),
  ];
  for (const root of roots) {
    const currentGroups = new Map<Element, Text[]>();
    for (const node of searchableNodesWithin(root, true)) {
      const parent = node.parentElement;
      if (!parent) continue;
      const block = parent.closest(paneFindBlockSelector);
      const key = block && root.contains(block) ? block : parent;
      if (node instanceof Element) {
        currentGroups.delete(key);
        continue;
      }
      const existing = currentGroups.get(key);
      if (existing) {
        existing.push(node);
      } else {
        const group = [node];
        currentGroups.set(key, group);
        groups.push(group);
      }
    }
  }
  return groups;
}

function shadowRootsWithin(root: ParentNode): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) continue;
    roots.push(element.shadowRoot, ...shadowRootsWithin(element.shadowRoot));
  }
  return roots;
}

function shadowDomTextGroups(surface: HTMLElement): Text[][] {
  const groups: Text[][] = [];
  for (const root of shadowRootsWithin(surface)) {
    for (const line of root.querySelectorAll<HTMLElement>("[data-line]")) {
      if (line.parentElement?.closest("[data-line]")) continue;
      const nodes = textNodesWithin(line);
      if (nodes.length > 0) groups.push(nodes);
    }
  }
  return groups;
}

function rangeAtOffsets(nodes: readonly Text[], start: number, end: number): Range | null {
  let offset = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;
  for (const node of nodes) {
    const nextOffset = offset + node.data.length;
    if (!startNode && start <= nextOffset) {
      startNode = node;
      startOffset = Math.max(0, start - offset);
    }
    if (!endNode && end <= nextOffset) {
      endNode = node;
      endOffset = Math.max(0, end - offset);
      break;
    }
    offset = nextOffset;
  }
  if (!startNode || !endNode) return null;
  const range = nodes[0]?.ownerDocument.createRange();
  if (!range) return null;
  range.setStart(startNode, Math.min(startOffset, startNode.data.length));
  range.setEnd(endNode, Math.min(endOffset, endNode.data.length));
  return range;
}

export function findPaneRanges(
  surface: HTMLElement,
  query: string,
  options: PaneFindOptions,
): PaneFindRangeResult {
  const ranges: Range[] = [];
  const validation = findPaneTextMatches("", query, options);
  if (validation.invalidRegularExpression) {
    return { ranges, invalidRegularExpression: true };
  }
  let invalidRegularExpression = false;
  const groups = [...lightDomTextGroups(surface), ...shadowDomTextGroups(surface)];
  for (const nodes of groups) {
    const text = nodes.map((node) => node.data).join("");
    const result = findPaneTextMatches(text, query, options);
    invalidRegularExpression ||= result.invalidRegularExpression;
    if (invalidRegularExpression) return { ranges: [], invalidRegularExpression: true };
    for (const match of result.matches) {
      const range = rangeAtOffsets(nodes, match.start, match.end);
      if (range) ranges.push(range);
    }
  }
  return { ranges, invalidRegularExpression: false };
}

export function paneFindShadowRoots(surface: HTMLElement): ShadowRoot[] {
  return shadowRootsWithin(surface);
}
