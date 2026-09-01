import {
  File,
  FileDiff,
  type DiffFileInput,
  type DiffLineAnnotation,
  type LineAnnotation,
  type SelectedLineRange,
} from "@pierre/diffs/react";
import type {
  File as FileRendererInstance,
  FileDiff as DiffRendererInstance,
  PostRenderPhase,
} from "@pierre/diffs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type {
  CodeReference,
  CommentPlacement,
  DocumentContent,
  DocumentRef,
  FileStructureReference,
  ReviewComment,
  SourceReferenceFileTarget,
} from "../../domain/models.js";
import { isSupportedImagePath } from "../../shared/image-assets.js";
import {
  commentReplyDraftScope,
  commentDraftContextKey,
  currentCommentDraftRevision,
  deleteCommentDraft,
  readCommentDraft,
  writeCommentDraft,
} from "../comment-draft-store.js";
import {
  cancelCommentQuery,
  invalidateCommentQuery,
  putCommentInCache,
} from "../comment-query-cache.js";
import type {
  ActiveDocument,
  DocumentPaneId,
  ReferenceDocumentContext,
} from "../document-workspace.js";
import type { ReferenceStaleness } from "../document-viewer-state.js";
import { diffForRenderer, fileContentsForRenderer } from "../file-rendering.js";
import {
  api,
  documentUrl,
  type DiffResponse,
  type DocumentResponse,
  jsonRequest,
  resolveCommentPlacements,
} from "../api.js";
import { DIFF_NAVIGATION_CONTEXT_LINES } from "../diff-navigation.js";
import {
  githubAttachmentAssetUrl,
  isExternalMarkdownHref,
  markdownAssetUrl,
  markdownLinkWasDragged,
  resolveRepositoryMarkdownPath,
  type PointerPosition,
} from "../markdown-links.js";
import {
  MarkdownSelectionSurface,
  markdownCommentAnchorIds,
  markdownNodeSourceRange,
  markdownSourceDataAttributes,
  rehypeRvwSourceMap,
  type MarkdownCommentAnnotation,
  type MarkdownSourceRange,
} from "../markdown-source-map.js";
import type { ThemePreference } from "../theme.js";
import { CommentIcon, InlineCommentComposer } from "./CommentComposer.js";
import { CommentThread } from "./CommentThread.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { FileEntryIcon } from "./FileIcon.js";
import { FileStructureReferencesButton } from "./FileStructureReferencesButton.js";
import { MarkdownImagePlaceholder } from "./MarkdownImagePlaceholder.js";
import { MarkdownImage } from "./MarkdownImage.js";
import { PreviewMarkdownTable } from "./MarkdownTable.js";
import { MermaidDiagram } from "./MermaidDiagram.js";
import { MermaidSurface } from "./MermaidSurface.js";
import { RepositoryImageViewer } from "./RepositoryImageViewer.js";

type ViewerAnnotation =
  | { kind: "comment"; comment: ReviewComment; placement: CommentPlacement }
  | { kind: "line-composer" };

type CreateCommentTarget =
  | { kind: "pull-request" }
  | {
      kind: "document";
      documentKind: "pull-request-markdown";
      startLine: number | null;
      endLine: number | null;
    }
  | {
      kind: "document";
      documentKind: "repository-file";
      sourceOid: string;
      path: string;
      startLine: number | null;
      endLine: number | null;
    };

type OptimisticCommentLocation =
  | { mode: "full"; lineNumber: number }
  | { mode: "diff"; side: "additions" | "deletions"; lineNumber: number };

interface OptimisticCommentAnnotation {
  comment: ReviewComment;
  placement: CommentPlacement;
  location: OptimisticCommentLocation;
}

interface DiffViewportAnchor {
  line: string;
  occurrence: number;
  topOffset: number;
  fallbackScrollTop: number;
}

const markdownViewByDocument = new Map<string, "source" | "preview">();

function markdownViewKey(document: ActiveDocument): string {
  if (document.kind === "pull-request-markdown") return "pull-request-markdown";
  if (document.kind === "walkthrough") return `walkthrough:${document.id}`;
  if (document.kind === "structure") return `structure:${document.id}`;
  return `repository-file:${document.path}`;
}

const viewerStyle = {
  "--rvw-diff-addition-line-bg": "light-dark(#dafbe1, rgb(46 160 67 / 0.15))",
  "--rvw-diff-addition-number-bg": "light-dark(#aceebb, rgb(63 185 80 / 0.3))",
  "--rvw-diff-addition-word-bg": "light-dark(#aceebb, rgb(46 160 67 / 0.4))",
  "--rvw-diff-deletion-line-bg": "light-dark(#ffebe9, rgb(248 81 73 / 0.1))",
  "--rvw-diff-deletion-number-bg": "light-dark(#ffcecb, rgb(248 81 73 / 0.3))",
  "--rvw-diff-deletion-word-bg": "light-dark(#ffcecb, rgb(248 81 73 / 0.4))",
  "--rvw-diff-emphasis-fg": "light-dark(#1f2328, #f0f6fc)",
  "--diffs-bg": "light-dark(#fff, #0d1117)",
  "--diffs-fg": "light-dark(#1f2328, #f0f6fc)",
  "--diffs-light": "#1f2328",
  "--diffs-dark": "#f0f6fc",
  "--diffs-light-addition-color": "#1a7f37",
  "--diffs-dark-addition-color": "#3fb950",
  "--diffs-light-deletion-color": "#cf222e",
  "--diffs-dark-deletion-color": "#f85149",
  "--diffs-fg-number-override": "light-dark(#59636e, #9198a1)",
  "--diffs-fg-number-addition-override": "var(--diffs-fg)",
  "--diffs-fg-number-deletion-override": "var(--diffs-fg)",
  "--diffs-bg-addition-emphasis-override": "var(--rvw-diff-addition-word-bg)",
  "--diffs-bg-deletion-emphasis-override": "var(--rvw-diff-deletion-word-bg)",
  backgroundColor: "var(--diffs-bg)",
  color: "var(--diffs-fg)",
} as CSSProperties;

const viewerUnsafeCss = `
  [data-background]
    :is([data-line], [data-no-newline])[data-line-type="change-addition"] {
    --diffs-computed-diff-line-bg: var(--rvw-diff-addition-line-bg) !important;
  }
  [data-background]
    :is([data-line], [data-no-newline])[data-line-type="change-deletion"] {
    --diffs-computed-diff-line-bg: var(--rvw-diff-deletion-line-bg) !important;
  }
  [data-background]
    :is([data-gutter-buffer], [data-column-number])[data-line-type="change-addition"] {
    --diffs-computed-diff-line-bg: var(--rvw-diff-addition-number-bg) !important;
  }
  [data-background]
    :is([data-gutter-buffer], [data-column-number])[data-line-type="change-deletion"] {
    --diffs-computed-diff-line-bg: var(--rvw-diff-deletion-number-bg) !important;
  }
  :is([data-line-type="change-addition"], [data-line-type="change-deletion"])
    [data-diff-span],
  :is([data-line-type="change-addition"], [data-line-type="change-deletion"])
    [data-diff-span] span {
    color: var(--rvw-diff-emphasis-fg) !important;
  }
  [data-change-icon="file"] {
    display: none;
  }
  [data-diffs-header][data-sticky] {
    top: 40px;
  }
  [data-line] {
    padding-inline-start: calc(1ch + 8px);
  }
  [data-line][data-editor-active-line] {
    background: color-mix(in srgb, var(--diffs-modified-base) 28%, transparent) !important;
  }
  ::highlight(rvw-pane-find-left-match),
  ::highlight(rvw-pane-find-right-match) {
    background-color: light-dark(rgb(234 179 8 / 0.42), rgb(250 204 21 / 0.38));
  }
  ::highlight(rvw-pane-find-left-current),
  ::highlight(rvw-pane-find-right-current) {
    background-color: light-dark(rgb(245 139 10 / 0.82), rgb(249 115 22 / 0.78));
    color: light-dark(#17120a, #fff);
  }
`;

export type DisplayMode = "full" | "pull-request" | "range";
export interface ViewerNavigationTarget {
  documentKey: string;
  pane: DocumentPaneId;
  line: number | null;
  endLine?: number;
  requestId: number;
  resetHorizontal: boolean;
}

function scrollNavigationLine(
  container: HTMLElement,
  line: number,
  preferAdditions: boolean,
  resetHorizontal: boolean,
  onApplied: () => void,
): void {
  const maximumAttempts = 4;
  let attempts = 0;
  const scroll = (): void => {
    window.requestAnimationFrame(() => {
      attempts += 1;
      const root = container.shadowRoot;
      if (!root) {
        if (attempts < maximumAttempts) scroll();
        return;
      }
      const candidates = [...root.querySelectorAll<HTMLElement>(`[data-line="${line}"]`)];
      const activeCandidate = candidates.find((candidate) =>
        candidate.hasAttribute("data-editor-active-line"),
      );
      const additionCandidate = preferAdditions
        ? candidates.find(
            (candidate) =>
              candidate.closest("[data-additions]") !== null ||
              candidate.dataset.lineType !== "change-deletion",
          )
        : undefined;
      const target = activeCandidate ?? additionCandidate ?? candidates[0];
      const pane = container.closest<HTMLElement>(".document-pane");
      if (!target || !pane || !container.isConnected || pane.clientHeight === 0) {
        if (attempts < maximumAttempts) scroll();
        return;
      }
      const horizontalScroller = target.closest<HTMLElement>("code");
      const previousScrollLeft = horizontalScroller?.scrollLeft ?? 0;
      target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
      if (horizontalScroller) {
        const nextScrollLeft = resetHorizontal ? 0 : previousScrollLeft;
        horizontalScroller.scrollLeft = nextScrollLeft;
        window.requestAnimationFrame(() => {
          horizontalScroller.scrollLeft = nextScrollLeft;
        });
      }
      const paneRect = pane.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const viewportTop = diffViewportTop(pane);
      const viewportCenter = (viewportTop + paneRect.bottom) / 2;
      const targetCenter = (targetRect.top + targetRect.bottom) / 2;
      const centered =
        Math.abs(targetCenter - viewportCenter) <= Math.max(targetRect.height * 2, 24);
      if (!centered && attempts < maximumAttempts) {
        scroll();
        return;
      }
      onApplied();
    });
  };
  window.requestAnimationFrame(scroll);
}

function diffViewportTop(pane: HTMLElement): number {
  const paneTop = pane.getBoundingClientRect().top;
  return [...pane.querySelectorAll<HTMLElement>(".document-tabs-shell, .markdown-view-toolbar")]
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.bottom > paneTop && rect.top <= paneTop + 1)
    .reduce((top, rect) => Math.max(top, rect.bottom), paneTop);
}

function firstVisibleDiffLine(
  root: ShadowRoot,
  pane: HTMLElement,
  viewportTop: number,
): HTMLElement | null {
  const hostRect = (root.host as HTMLElement).getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  const left = Math.max(hostRect.left, paneRect.left);
  const right = Math.min(hostRect.right, paneRect.right);
  const top = Math.max(hostRect.top, viewportTop);
  const bottom = Math.min(hostRect.bottom, paneRect.bottom);
  const sampleXs = [left + (right - left) * 0.25, left + (right - left) * 0.75, (left + right) / 2];
  for (let y = top + 1; y < bottom; y += 6) {
    for (const x of sampleXs) {
      const line = root.elementFromPoint(x, y)?.closest<HTMLElement>("[data-line]");
      if (line) return line;
    }
  }
  return null;
}

function renderedLines(root: ShadowRoot, line: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-line="${CSS.escape(line)}"]`)];
}

function captureDiffViewportAnchor(surface: HTMLElement | null): DiffViewportAnchor | null {
  const pane = surface?.closest<HTMLElement>(".document-pane");
  const root = surface?.querySelector<HTMLElement>("diffs-container")?.shadowRoot;
  if (!pane || !root) return null;
  const viewportTop = diffViewportTop(pane);
  const anchor = firstVisibleDiffLine(root, pane, viewportTop);
  const line = anchor?.dataset.line;
  if (!anchor || line === undefined) return null;
  const matchingLines = renderedLines(root, line);
  return {
    line,
    occurrence: Math.max(0, matchingLines.indexOf(anchor)),
    topOffset: anchor.getBoundingClientRect().top - viewportTop,
    fallbackScrollTop: pane.scrollTop,
  };
}

function restoreDiffViewportAnchor(surface: HTMLElement | null, anchor: DiffViewportAnchor): void {
  const pane = surface?.closest<HTMLElement>(".document-pane");
  const root = surface?.querySelector<HTMLElement>("diffs-container")?.shadowRoot;
  if (!pane || !root) return;
  const matchingLines = renderedLines(root, anchor.line);
  const target = matchingLines[anchor.occurrence] ?? matchingLines[0];
  if (!target) {
    pane.scrollTop = anchor.fallbackScrollTop;
    return;
  }
  const currentOffset = target.getBoundingClientRect().top - diffViewportTop(pane);
  pane.scrollTop += currentOffset - anchor.topOffset;
}

function markdownNodeText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return markdownNodeText(child.props.children);
      }
      return "";
    })
    .join("");
}

function markdownHeadingId(children: ReactNode, counts: Map<string, number>): string {
  const base =
    markdownNodeText(children)
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .replace(/\s+/g, "-") || "section";
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function markdownFragmentLine(anchor: HTMLAnchorElement, href: string): number | null {
  let id: string;
  try {
    id = decodeURIComponent(href.slice(1));
  } catch {
    return null;
  }
  const pane = anchor.closest(".document-pane");
  const target = [...(pane?.querySelectorAll<HTMLElement>("[id]") ?? [])].find(
    (element) => element.id === id,
  );
  if (!target) return null;
  const line = Number(target.dataset.rvwSourceStartLine);
  return Number.isInteger(line) && line > 0 ? line : null;
}

function markdownRangesOverlap(
  sourceRange: MarkdownSourceRange | null,
  targetRange: MarkdownSourceRange | null,
): boolean {
  return Boolean(
    sourceRange &&
    targetRange &&
    sourceRange.startLine <= targetRange.endLine &&
    sourceRange.endLine >= targetRange.startLine,
  );
}

function markdownNavigationElement(root: HTMLElement | null, line: number): HTMLElement | null {
  if (!root) return null;
  const exact = root.querySelector<HTMLElement>(`[data-rvw-source-start-line="${line}"]`);
  if (exact) return exact;

  let best: { element: HTMLElement; span: number; leaf: boolean } | null = null;
  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-rvw-source-start-line][data-rvw-source-end-line]",
  )) {
    const startLine = Number(element.dataset.rvwSourceStartLine);
    const endLine = Number(element.dataset.rvwSourceEndLine);
    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      startLine > line ||
      endLine < line
    ) {
      continue;
    }
    const span = endLine - startLine;
    const leaf = element.dataset.rvwSourceLeaf === "true";
    if (!best || span < best.span || (span === best.span && leaf && !best.leaf)) {
      best = { element, span, leaf };
    }
  }
  return best?.element ?? null;
}

function sameMarkdownRange(
  left: MarkdownSourceRange | null,
  right: MarkdownSourceRange | null,
): boolean {
  return Boolean(
    left && right && left.startLine === right.startLine && left.endLine === right.endLine,
  );
}

function MarkdownMermaidDiagram({
  source,
  sourceRange,
  sourceAttributes,
  sourceHighlighted,
  sourceSelected,
  sourceOid,
  pullRequestId,
  placedComments,
  replyDraftScope,
  themePreference,
  onCommentActiveChange,
  onOpenCodeReference,
  onOpenRepositoryLink,
  onCreateComment,
  createPending,
  createError,
  onResetCreate,
}: {
  source: string;
  sourceRange: MarkdownSourceRange | null;
  sourceAttributes: Record<string, number>;
  sourceHighlighted: boolean;
  sourceSelected: boolean;
  sourceOid: string;
  pullRequestId: string;
  placedComments: Array<{ comment: ReviewComment; placement: CommentPlacement }>;
  replyDraftScope: string;
  themePreference: ThemePreference;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onOpenCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
  onCreateComment: (range: MarkdownSourceRange, body: string) => Promise<void>;
  createPending: boolean;
  createError: unknown;
  onResetCreate: () => void;
}) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [body, setBody] = useState("");
  const diagramComments = sourceRange
    ? placedComments.filter(({ placement }) => sameMarkdownRange(placement.range, sourceRange))
    : [];
  const review = sourceRange
    ? {
        pullRequestId,
        commentCount: diagramComments.length,
        onOpenCodeReference,
        renderComments: (
          openReference: (
            sourceOid: string,
            reference: CodeReference,
            openInRightPane: boolean,
          ) => Promise<string | null>,
        ) => (
          <div className="mermaid-diagram-comments">
            {diagramComments.length === 0 && !composerOpen && (
              <p className="mermaid-comments-empty">この diagram へのコメントはありません。</p>
            )}
            {diagramComments.map(({ comment, placement }) => (
              <CommentThread
                key={comment.id}
                comment={comment}
                variant="sidebar"
                draftScope={`${replyDraftScope}:mermaid:${sourceRange.startLine}-${sourceRange.endLine}`}
                placement={placement}
                markdownSourceOid={sourceOid}
                themePreference={themePreference}
                cancelDraftOnEscape
                onActiveChange={onCommentActiveChange}
                onOpenCodeReference={openReference}
                onOpenRepositoryLink={onOpenRepositoryLink}
              />
            ))}
            {composerOpen ? (
              <InlineCommentComposer
                body={body}
                label="Comment on diagram"
                pending={createPending}
                error={createError}
                validationError={undefined}
                placement="line"
                onBodyChange={setBody}
                onCancel={() => {
                  setBody("");
                  setComposerOpen(false);
                  onResetCreate();
                }}
                onSubmit={() => {
                  void onCreateComment(sourceRange, body)
                    .then(() => {
                      setBody("");
                      setComposerOpen(false);
                    })
                    .catch(() => undefined);
                }}
              />
            ) : (
              <button
                className="mermaid-comment-action"
                onClick={() => {
                  onResetCreate();
                  setComposerOpen(true);
                }}
              >
                <CommentIcon />
                Comment on diagram
              </button>
            )}
          </div>
        ),
      }
    : undefined;
  return (
    <MermaidDiagram
      source={source}
      themePreference={themePreference}
      renderIdPrefix="rvwMarkdown"
      review={review}
      renderInline={(expandButton) => (
        <div
          className={`markdown-mermaid-shell${sourceHighlighted ? " is-source-highlighted" : ""}${sourceSelected ? " is-source-selected" : ""}`}
          data-rvw-source-leaf="true"
          {...sourceAttributes}
        >
          <div className="markdown-mermaid-toolbar">
            <span>Mermaid diagram</span>
            {expandButton}
          </div>
          <MermaidSurface
            className="markdown-mermaid"
            role="img"
            aria-label="Mermaid diagram"
            source={source}
            themePreference={themePreference}
            renderIdPrefix="rvwMarkdown"
            errorClassName="markdown-mermaid-error"
          />
        </div>
      )}
    />
  );
}

interface RepositoryMermaidRenderContext {
  annotations: MarkdownCommentAnnotation[];
  activeCommentId: string | null;
  selectedRange: MarkdownSourceRange | null;
  navigationRange: MarkdownSourceRange | null;
  sourceRef: DocumentRef;
  selectedOid: string;
  pullRequestId: string;
  themePreference: ThemePreference;
  placedComments: Array<{ comment: ReviewComment; placement: CommentPlacement }>;
  replyDraftScope: string;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onOpenCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onCreateDiagramComment: (range: MarkdownSourceRange, body: string) => Promise<void>;
  diagramCommentPending: boolean;
  diagramCommentError: unknown;
  onResetDiagramComment: () => void;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
}

const RepositoryMermaidRenderContext = createContext<RepositoryMermaidRenderContext | null>(null);

const RepositoryMarkdownPre: NonNullable<Components["pre"]> = ({ children, node, ...props }) => {
  const context = useContext(RepositoryMermaidRenderContext);
  const childParts = Children.toArray(children);
  const child = childParts.length === 1 ? childParts[0] : null;
  if (
    !context ||
    !isValidElement<{ className?: string; children?: ReactNode }>(child) ||
    !child.props.className?.split(/\s+/u).includes("language-mermaid")
  ) {
    return <pre {...props}>{children}</pre>;
  }
  const sourceRange = markdownNodeSourceRange(node);
  const sourceHighlighted =
    markdownRangesOverlap(sourceRange, context.navigationRange) ||
    Boolean(
      context.activeCommentId &&
      context.annotations.some(
        (annotation) =>
          annotation.id === context.activeCommentId &&
          markdownRangesOverlap(sourceRange, annotation.range),
      ),
    );
  return (
    <MarkdownMermaidDiagram
      source={markdownNodeText(child.props.children).trim()}
      sourceRange={sourceRange}
      sourceAttributes={markdownSourceDataAttributes(node)}
      sourceHighlighted={sourceHighlighted}
      sourceSelected={markdownRangesOverlap(sourceRange, context.selectedRange)}
      sourceOid={
        context.sourceRef.kind === "repository-file"
          ? context.sourceRef.sourceOid
          : context.selectedOid
      }
      pullRequestId={context.pullRequestId}
      placedComments={context.placedComments}
      replyDraftScope={context.replyDraftScope}
      themePreference={context.themePreference}
      onCommentActiveChange={context.onCommentActiveChange}
      onOpenCodeReference={context.onOpenCodeReference}
      onOpenRepositoryLink={context.onOpenRepositoryLink}
      onCreateComment={context.onCreateDiagramComment}
      createPending={context.diagramCommentPending}
      createError={context.diagramCommentError}
      onResetCreate={context.onResetDiagramComment}
    />
  );
};

function renderRepositoryMarkdown({
  text,
  pullRequestMarkdown,
  annotations,
  activeCommentId,
  selectedRange,
  navigationRange,
  composerOpen,
  markdownDiv,
  sourceRef,
  selectedOid,
  pullRequestId,
  themePreference,
  placedComments,
  replyDraftScope,
  linkPointerStart,
  onCommentActiveChange,
  onOpenCodeReference,
  onCreateDiagramComment,
  diagramCommentPending,
  diagramCommentError,
  onResetDiagramComment,
  onOpenRepositoryLink,
  onOpenMarkdownFragment,
}: {
  text: string;
  pullRequestMarkdown: boolean;
  annotations: MarkdownCommentAnnotation[];
  activeCommentId: string | null;
  selectedRange: MarkdownSourceRange | null;
  navigationRange: MarkdownSourceRange | null;
  composerOpen: boolean;
  markdownDiv: NonNullable<Components["div"]>;
  sourceRef: DocumentRef;
  selectedOid: string;
  pullRequestId: string;
  themePreference: ThemePreference;
  placedComments: Array<{ comment: ReviewComment; placement: CommentPlacement }>;
  replyDraftScope: string;
  linkPointerStart: { current: PointerPosition | null };
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onOpenCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onCreateDiagramComment: (range: MarkdownSourceRange, body: string) => Promise<void>;
  diagramCommentPending: boolean;
  diagramCommentError: unknown;
  onResetDiagramComment: () => void;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
  onOpenMarkdownFragment: (line: number, hash: string) => void;
}): ReactNode {
  const headingCounts = new Map<string, number>();
  const mermaidContext: RepositoryMermaidRenderContext = {
    annotations,
    activeCommentId,
    selectedRange,
    navigationRange,
    sourceRef,
    selectedOid,
    pullRequestId,
    themePreference,
    placedComments,
    replyDraftScope,
    onCommentActiveChange,
    onOpenCodeReference,
    onCreateDiagramComment,
    diagramCommentPending,
    diagramCommentError,
    onResetDiagramComment,
    onOpenRepositoryLink,
  };
  const markdown = (
    <ReactMarkdown
      rehypePlugins={[
        rehypeRaw,
        rehypeSanitize,
        [
          rehypeRvwSourceMap,
          { annotations, activeCommentId, selectedRange, navigationRange, composerOpen },
        ],
      ]}
      remarkPlugins={pullRequestMarkdown ? [remarkGfm, remarkBreaks] : [remarkGfm]}
      components={{
        div: markdownDiv,
        table: PreviewMarkdownTable,
        h1: ({ children, node: _node, ...props }) => (
          <h1
            {...markdownSourceDataAttributes(_node)}
            {...props}
            id={markdownHeadingId(children, headingCounts)}
          >
            {children}
          </h1>
        ),
        h2: ({ children, node: _node, ...props }) => (
          <h2
            {...markdownSourceDataAttributes(_node)}
            {...props}
            id={markdownHeadingId(children, headingCounts)}
          >
            {children}
          </h2>
        ),
        h3: ({ children, node: _node, ...props }) => (
          <h3
            {...markdownSourceDataAttributes(_node)}
            {...props}
            id={markdownHeadingId(children, headingCounts)}
          >
            {children}
          </h3>
        ),
        h4: ({ children, node: _node, ...props }) => (
          <h4
            {...markdownSourceDataAttributes(_node)}
            {...props}
            id={markdownHeadingId(children, headingCounts)}
          >
            {children}
          </h4>
        ),
        h5: ({ children, node: _node, ...props }) => (
          <h5
            {...markdownSourceDataAttributes(_node)}
            {...props}
            id={markdownHeadingId(children, headingCounts)}
          >
            {children}
          </h5>
        ),
        h6: ({ children, node: _node, ...props }) => (
          <h6
            {...markdownSourceDataAttributes(_node)}
            {...props}
            id={markdownHeadingId(children, headingCounts)}
          >
            {children}
          </h6>
        ),
        a: ({ href, children, node: _node, ...props }) => {
          const sourcePath = sourceRef.kind === "repository-file" ? sourceRef.path : null;
          const repositoryPath = resolveRepositoryMarkdownPath(href, sourcePath);
          if (!repositoryPath) {
            const external = isExternalMarkdownHref(href);
            return (
              <a
                {...markdownSourceDataAttributes(_node)}
                {...props}
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
                onPointerDown={(event) => {
                  linkPointerStart.current = { x: event.clientX, y: event.clientY };
                }}
                onPointerUp={(event) => {
                  const dragged = markdownLinkWasDragged(linkPointerStart.current, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                  linkPointerStart.current = null;
                  if (dragged) event.currentTarget.dataset.rvwLinkDragged = "true";
                  if (!dragged && href?.startsWith("#")) {
                    const line = markdownFragmentLine(event.currentTarget, href);
                    if (line !== null) onOpenMarkdownFragment(line, href);
                  }
                }}
                onClick={(event) => {
                  if (event.currentTarget.dataset.rvwLinkDragged === "true") {
                    delete event.currentTarget.dataset.rvwLinkDragged;
                    event.preventDefault();
                    return;
                  }
                  if (!href?.startsWith("#")) return;
                  event.preventDefault();
                  if (event.detail === 0) {
                    const line = markdownFragmentLine(event.currentTarget, href);
                    if (line !== null) onOpenMarkdownFragment(line, href);
                  }
                }}
              >
                {children}
              </a>
            );
          }
          const sourceOid =
            sourceRef.kind === "repository-file" ? sourceRef.sourceOid : selectedOid;
          return (
            <a
              {...markdownSourceDataAttributes(_node)}
              {...props}
              href={href}
              onPointerDown={(event) => {
                linkPointerStart.current = { x: event.clientX, y: event.clientY };
              }}
              onPointerUp={(event) => {
                const dragged = markdownLinkWasDragged(linkPointerStart.current, {
                  x: event.clientX,
                  y: event.clientY,
                });
                linkPointerStart.current = null;
                if (dragged) return;
                onOpenRepositoryLink(repositoryPath, sourceOid, event.metaKey || event.ctrlKey);
              }}
              onClick={(event) => {
                event.preventDefault();
                if (event.detail === 0) onOpenRepositoryLink(repositoryPath, sourceOid, false);
              }}
              onContextMenu={(event) => {
                if (event.ctrlKey || event.metaKey) event.preventDefault();
              }}
            >
              {children}
            </a>
          );
        },
        img: ({ src, alt, title, node: _node, ...props }) => {
          const sourceAttributes = markdownSourceDataAttributes(_node);
          if (sourceRef.kind === "pull-request-markdown") {
            const attachmentUrl = githubAttachmentAssetUrl(pullRequestId, src);
            return attachmentUrl ? (
              <MarkdownImage
                {...props}
                src={attachmentUrl}
                alt={alt}
                title={title}
                sourceAttributes={sourceAttributes}
              />
            ) : (
              <MarkdownImagePlaceholder
                alt={alt}
                title={title}
                sourceAttributes={sourceAttributes}
              />
            );
          }
          if (sourceRef.kind !== "repository-file") {
            return (
              <MarkdownImagePlaceholder
                alt={alt}
                title={title}
                sourceAttributes={sourceAttributes}
              />
            );
          }
          const repositoryPath = resolveRepositoryMarkdownPath(src, sourceRef.path);
          if (!repositoryPath) {
            return (
              <MarkdownImagePlaceholder
                alt={alt}
                title={title}
                sourceAttributes={sourceAttributes}
              />
            );
          }
          return (
            <MarkdownImage
              {...props}
              src={markdownAssetUrl(pullRequestId, sourceRef.sourceOid, repositoryPath)}
              alt={alt}
              title={title}
              sourceAttributes={sourceAttributes}
            />
          );
        },
        pre: RepositoryMarkdownPre,
      }}
    >
      {text}
    </ReactMarkdown>
  );
  return (
    <RepositoryMermaidRenderContext.Provider value={mermaidContext}>
      {markdown}
    </RepositoryMermaidRenderContext.Provider>
  );
}

function fileValue(document: DocumentContent | null, fallbackName: string) {
  if (!document || document.availability !== "available") return null;
  const name = document.ref.kind === "repository-file" ? document.ref.path : fallbackName;
  return fileContentsForRenderer(
    name,
    document.text ?? "",
    document.ref.kind === "repository-file"
      ? `${document.ref.sourceOid}:${document.ref.path}`
      : undefined,
  );
}

function Unavailable({
  document,
  fileCommentAction = null,
}: {
  document: DocumentContent | null;
  fileCommentAction?: ReactNode;
}) {
  const message = !document
    ? "この比較側には文書がありません。"
    : document.availability === "binary"
      ? "非UTF-8またはbinaryのため本文を表示できません。"
      : document.availability === "too-large"
        ? "1 MiBを超えるため本文を表示できません。"
        : "文書が見つかりません。";
  return (
    <div className="viewer-unavailable">
      <span>FILE</span>
      <p>{message}</p>
      {document && document.availability !== "missing" ? fileCommentAction : null}
    </div>
  );
}

export function DocumentViewer({
  pullRequestId,
  paneId,
  latestHeadOid,
  selectedOid,
  oldOid,
  pullRequestContentRevision,
  structureFingerprint,
  structuresLoaded,
  activeDocument,
  displayMode,
  diffStyle,
  hideWhitespace,
  comments,
  activeCommentId,
  fullViewNotice = null,
  fullViewUnavailableMessage = null,
  referenceStaleness,
  themePreference,
  onCommentActiveChange,
  navigationTarget = null,
  onNavigationApplied,
  onOpenMarkdownFragment,
  onOpenCodeReference,
  onOpenRepositoryLink,
  onOpenLatestReferenceFile,
  onReresolveSourceReference,
  onOpenStructureReference,
}: {
  pullRequestId: string;
  paneId: DocumentPaneId;
  latestHeadOid: string;
  selectedOid: string;
  oldOid: string | null;
  pullRequestContentRevision: number | undefined;
  structureFingerprint: string;
  structuresLoaded: boolean;
  activeDocument: ActiveDocument;
  displayMode: DisplayMode;
  diffStyle: "unified" | "split";
  hideWhitespace: boolean;
  comments: ReviewComment[];
  activeCommentId: string | null;
  fullViewNotice?: string | null;
  fullViewUnavailableMessage?: string | null;
  referenceStaleness: ReferenceStaleness | null;
  themePreference: ThemePreference;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  navigationTarget?: ViewerNavigationTarget | null;
  onNavigationApplied: (requestId: number) => void;
  onOpenMarkdownFragment: (line: number, hash: string) => void;
  onOpenCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
  onOpenLatestReferenceFile: (target: SourceReferenceFileTarget) => void;
  onReresolveSourceReference: (context: ReferenceDocumentContext) => Promise<string | null>;
  onOpenStructureReference: (reference: FileStructureReference) => void;
}) {
  if (activeDocument.kind === "walkthrough" || activeDocument.kind === "structure") {
    throw new Error("この文書は専用Viewerで表示してください。");
  }
  const queryClient = useQueryClient();
  const markdownCapable =
    activeDocument.kind === "pull-request-markdown" ||
    activeDocument.path.toLowerCase().endsWith(".md") ||
    activeDocument.path.toLowerCase().endsWith(".markdown");
  const activeMarkdownViewKey = markdownViewKey(activeDocument);
  const [markdownView, setMarkdownViewState] = useState<"source" | "preview">(
    () => markdownViewByDocument.get(activeMarkdownViewKey) ?? "preview",
  );
  const [referenceResolutionPending, setReferenceResolutionPending] = useState(false);
  const [referenceResolutionError, setReferenceResolutionError] = useState<string | null>(null);
  const setMarkdownView = (view: "source" | "preview"): void => {
    markdownViewByDocument.set(activeMarkdownViewKey, view);
    setMarkdownViewState(view);
  };
  const commentDraftKey = commentDraftContextKey({
    activeDocument,
    pane: paneId,
    selectedOid,
    oldOid,
    displayMode,
  });
  const replyDraftScope = commentReplyDraftScope(paneId, activeDocument);
  const commentDraftRevision = useRef(currentCommentDraftRevision(pullRequestId)).current;
  const initialCommentDraft = readCommentDraft(pullRequestId, commentDraftKey);
  const [selection, setSelection] = useState<SelectedLineRange | null>(
    initialCommentDraft?.selection ?? null,
  );
  const [selectionPreview, setSelectionPreview] = useState<SelectedLineRange | null>(null);
  const [markdownComposerOpen, setMarkdownComposerOpen] = useState(
    initialCommentDraft?.markdownComposerOpen ?? false,
  );
  const [fileComposerOpen, setFileComposerOpen] = useState(
    initialCommentDraft?.fileComposerOpen ?? false,
  );
  const [body, setBody] = useState(initialCommentDraft?.body ?? "");
  const [optimisticComment, setOptimisticComment] = useState<OptimisticCommentAnnotation | null>(
    null,
  );
  useLayoutEffect(() => {
    if (fileComposerOpen || markdownComposerOpen || selection) {
      writeCommentDraft(pullRequestId, commentDraftKey, commentDraftRevision, {
        body,
        selection,
        markdownComposerOpen,
        fileComposerOpen,
      });
      return;
    }
    deleteCommentDraft(pullRequestId, commentDraftKey, commentDraftRevision);
  }, [
    body,
    commentDraftKey,
    commentDraftRevision,
    fileComposerOpen,
    markdownComposerOpen,
    pullRequestId,
    selection,
  ]);
  const loadedOptimisticCommentId = useRef<string | null>(null);
  const markdownLinkPointerStart = useRef<PointerPosition | null>(null);
  const navigationAppliedRef = useRef(onNavigationApplied);
  const openMarkdownFragmentRef = useRef(onOpenMarkdownFragment);
  const openRepositoryLinkRef = useRef(onOpenRepositoryLink);
  navigationAppliedRef.current = onNavigationApplied;
  openMarkdownFragmentRef.current = onOpenMarkdownFragment;
  openRepositoryLinkRef.current = onOpenRepositoryLink;
  const openMarkdownFragment = useCallback(
    (line: number, hash: string) => openMarkdownFragmentRef.current(line, hash),
    [],
  );
  const openRepositoryLink = useCallback(
    (path: string, sourceOid: string, openInRightPane: boolean) =>
      openRepositoryLinkRef.current(path, sourceOid, openInRightPane),
    [],
  );
  const diffSurfaceRef = useRef<HTMLDivElement>(null);
  const pendingViewportAnchor = useRef<DiffViewportAnchor | null>(null);
  const appliedNavigationRequest = useRef<number | null>(null);
  const handleFullPostRender = useCallback(
    (
      container: HTMLElement,
      instance: FileRendererInstance<ViewerAnnotation>,
      phase: PostRenderPhase,
    ): void => {
      if (phase === "unmount") return;
      if (!navigationTarget || navigationTarget.line === null) {
        const requestId = navigationTarget?.requestId ?? null;
        if (appliedNavigationRequest.current === requestId) return;
        instance.setEditorActiveLine(null);
        delete container.dataset.searchTargetLine;
        appliedNavigationRequest.current = requestId;
        return;
      }
      if (appliedNavigationRequest.current === navigationTarget.requestId) return;
      appliedNavigationRequest.current = navigationTarget.requestId;
      container.dataset.searchTargetLine = String(navigationTarget.line);
      instance.setEditorActiveLine(navigationTarget.line);
      scrollNavigationLine(
        container,
        navigationTarget.line,
        false,
        navigationTarget.resetHorizontal,
        () => navigationAppliedRef.current(navigationTarget.requestId),
      );
    },
    [navigationTarget],
  );
  const handleDiffPostRender = useCallback(
    (
      container: HTMLElement,
      instance: DiffRendererInstance<ViewerAnnotation>,
      phase: PostRenderPhase,
    ): void => {
      if (phase === "unmount") return;
      if (!navigationTarget || navigationTarget.line === null) {
        const requestId = navigationTarget?.requestId ?? null;
        if (appliedNavigationRequest.current === requestId) return;
        instance.setEditorActiveLine(null);
        delete container.dataset.searchTargetLine;
        appliedNavigationRequest.current = requestId;
        return;
      }
      if (appliedNavigationRequest.current === navigationTarget.requestId) return;
      if (
        navigationTarget.endLine !== undefined &&
        instance.revealRange(
          navigationTarget.line,
          navigationTarget.endLine,
          DIFF_NAVIGATION_CONTEXT_LINES,
        )
      ) {
        return;
      }
      if (
        !instance.isLineRenderable(navigationTarget.line) &&
        instance.revealLine(navigationTarget.line)
      ) {
        return;
      }
      appliedNavigationRequest.current = navigationTarget.requestId;
      container.dataset.searchTargetLine = String(navigationTarget.line);
      instance.setEditorActiveLine(navigationTarget.line, { side: "additions" });
      scrollNavigationLine(
        container,
        navigationTarget.line,
        true,
        navigationTarget.resetHorizontal,
        () => navigationAppliedRef.current(navigationTarget.requestId),
      );
    },
    [navigationTarget],
  );
  const effectiveDisplayMode =
    activeDocument.kind === "pull-request-markdown" ? "full" : displayMode;
  const showingMarkdownPreview =
    markdownCapable && effectiveDisplayMode === "full" && markdownView === "preview";
  const fullRef = useMemo<DocumentRef>(
    () =>
      activeDocument.kind === "pull-request-markdown"
        ? { kind: "pull-request-markdown", pullRequestId }
        : {
            kind: "repository-file",
            pullRequestId,
            sourceOid: activeDocument.sourceOid ?? selectedOid,
            path: activeDocument.path,
          },
    [
      activeDocument.kind,
      activeDocument.kind === "repository-file" ? activeDocument.path : null,
      activeDocument.kind === "repository-file" ? activeDocument.sourceOid : null,
      pullRequestId,
      selectedOid,
    ],
  );
  const oldPath =
    activeDocument.kind === "repository-file"
      ? activeDocument.oldPath === undefined
        ? activeDocument.path
        : activeDocument.oldPath
      : null;
  const newPath =
    activeDocument.kind === "repository-file"
      ? activeDocument.newPath === undefined
        ? activeDocument.path
        : activeDocument.newPath
      : null;
  const repositoryImageViewerActive =
    activeDocument.kind === "repository-file" &&
    (effectiveDisplayMode === "full"
      ? isSupportedImagePath(activeDocument.path)
      : Boolean(
          (oldPath && isSupportedImagePath(oldPath)) || (newPath && isSupportedImagePath(newPath)),
        ));
  const fullQuery = useQuery({
    queryKey: ["document", fullRef],
    queryFn: async () => (await api<DocumentResponse>(documentUrl(fullRef))).document,
    enabled:
      effectiveDisplayMode === "full" &&
      !repositoryImageViewerActive &&
      !fullViewUnavailableMessage,
    staleTime: fullRef.kind === "repository-file" ? Number.POSITIVE_INFINITY : 0,
  });
  const diffSearch = new URLSearchParams({ kind: activeDocument.kind });
  if (activeDocument.kind === "repository-file") {
    if (oldOid) diffSearch.set("oldOid", oldOid);
    diffSearch.set("newOid", selectedOid);
    if (oldPath) diffSearch.set("oldPath", oldPath);
    if (newPath) diffSearch.set("newPath", newPath);
  }
  const diffQuery = useQuery({
    queryKey: ["diff", pullRequestId, oldOid, selectedOid, activeDocument],
    queryFn: async () =>
      (await api<DiffResponse>(`/api/pull-requests/${pullRequestId}/diff?${diffSearch.toString()}`))
        .diff,
    enabled:
      effectiveDisplayMode !== "full" &&
      !repositoryImageViewerActive &&
      activeDocument.kind === "repository-file" &&
      Boolean(oldOid) &&
      oldOid !== selectedOid,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const fullFile = useMemo(
    () => fileValue(fullQuery.data ?? null, "Pull Request.md"),
    [fullQuery.data],
  );
  const oldFile = useMemo(
    () => fileValue(diffQuery.data?.old ?? null, "Pull Request.md"),
    [diffQuery.data?.old],
  );
  const newFile = useMemo(
    () => fileValue(diffQuery.data?.new ?? null, "Pull Request.md"),
    [diffQuery.data?.new],
  );
  const diffFiles = useMemo<DiffFileInput | null>(
    () =>
      oldFile
        ? newFile
          ? { oldFile, newFile }
          : { oldFile, newFile: null }
        : newFile
          ? { oldFile: null, newFile }
          : null,
    [newFile, oldFile],
  );
  const renderedDiff = useMemo(
    () =>
      diffFiles ? diffForRenderer(diffFiles.oldFile, diffFiles.newFile, hideWhitespace) : null,
    [diffFiles, hideWhitespace],
  );
  const renderedDiffCacheKey = renderedDiff?.cacheKey ?? null;
  const repositoryImageRefs = useMemo(() => {
    if (!repositoryImageViewerActive || activeDocument.kind !== "repository-file") return null;
    if (effectiveDisplayMode === "full") {
      return {
        old: null,
        new: fullRef.kind === "repository-file" ? fullRef : null,
      };
    }
    return {
      old:
        oldOid && oldPath
          ? {
              kind: "repository-file" as const,
              pullRequestId,
              sourceOid: oldOid,
              path: oldPath,
            }
          : null,
      new: newPath
        ? {
            kind: "repository-file" as const,
            pullRequestId,
            sourceOid: selectedOid,
            path: newPath,
          }
        : null,
    };
  }, [
    activeDocument.kind,
    effectiveDisplayMode,
    fullRef,
    newPath,
    oldOid,
    oldPath,
    pullRequestId,
    repositoryImageViewerActive,
    selectedOid,
  ]);
  const renderedRefs = useMemo(() => {
    if (repositoryImageRefs) return repositoryImageRefs;
    if (effectiveDisplayMode === "full") return { old: null, new: fullRef };
    return {
      old: diffQuery.data?.old?.ref ?? null,
      new: diffQuery.data?.new?.ref ?? null,
    };
  }, [effectiveDisplayMode, fullRef, diffQuery.data, repositoryImageRefs]);
  const placementDestinations = useMemo(
    () =>
      [renderedRefs.new, renderedRefs.old].flatMap((ref) =>
        ref ? [{ kind: "document" as const, ref }] : [],
      ),
    [renderedRefs],
  );
  const placementComments = useMemo(() => {
    const documentKinds = new Set(
      [renderedRefs.new, renderedRefs.old].flatMap((ref) => (ref ? [ref.kind] : [])),
    );
    return comments
      .filter(
        (comment) =>
          comment.target.kind === "document" && documentKinds.has(comment.target.documentKind),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }, [comments, renderedRefs]);
  const commentTargetFingerprint = useMemo(
    () => placementComments.map((comment) => [comment.id, comment.target]),
    [placementComments],
  );
  const annotationQuery = useQuery({
    queryKey: [
      "comment-placements",
      "document",
      pullRequestId,
      commentTargetFingerprint,
      renderedRefs,
      renderedRefs.new?.kind === "pull-request-markdown" ||
      renderedRefs.old?.kind === "pull-request-markdown"
        ? pullRequestContentRevision
        : null,
    ],
    queryFn: async ({ signal }) =>
      await resolveCommentPlacements(
        pullRequestId,
        placementComments.map(({ id }) => id),
        placementDestinations,
        signal,
      ),
    enabled: placementComments.length > 0 && placementDestinations.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const annotationData = useMemo(() => {
    const fileAnnotations: LineAnnotation<ViewerAnnotation>[] = [];
    const diffAnnotations: DiffLineAnnotation<ViewerAnnotation>[] = [];
    const markdownComments: Array<{
      comment: ReviewComment;
      placement: CommentPlacement;
    }> = [];
    const imageComments: {
      old: Array<{ comment: ReviewComment; placement: CommentPlacement }>;
      new: Array<{ comment: ReviewComment; placement: CommentPlacement }>;
    } = { old: [], new: [] };
    const placementsByComment = new Map(
      annotationQuery.data?.comments.map(({ commentId, placements }) => [commentId, placements]) ??
        [],
    );
    const placementFor = (commentId: string, ref: DocumentRef): CommentPlacement | null =>
      placementsByComment
        .get(commentId)
        ?.find(
          ({ destination }) =>
            destination.kind === "document" &&
            JSON.stringify(destination.ref) === JSON.stringify(ref),
        )?.placement ?? null;
    if (repositoryImageRefs) {
      for (const comment of comments) {
        const exactOldTarget =
          comment.target.kind === "document" &&
          comment.target.documentKind === "repository-file" &&
          repositoryImageRefs.old?.kind === "repository-file" &&
          comment.target.sourceOid === repositoryImageRefs.old.sourceOid &&
          comment.target.path === repositoryImageRefs.old.path;
        const candidates = exactOldTarget
          ? ([
              { side: "old" as const, ref: repositoryImageRefs.old },
              { side: "new" as const, ref: repositoryImageRefs.new },
            ] as const)
          : ([
              { side: "new" as const, ref: repositoryImageRefs.new },
              { side: "old" as const, ref: repositoryImageRefs.old },
            ] as const);
        for (const candidate of candidates) {
          if (!candidate.ref) continue;
          const placement = placementFor(comment.id, candidate.ref);
          if (placement && !placement.outdated && placement.path === candidate.ref.path) {
            imageComments[candidate.side].push({ comment, placement });
            break;
          }
        }
      }
      return { fileAnnotations, diffAnnotations, markdownComments, imageComments };
    }
    for (const comment of comments) {
      let added = false;
      if (renderedRefs.new) {
        const placement = placementFor(comment.id, renderedRefs.new);
        if (
          placement &&
          !placement.outdated &&
          placement.path ===
            (renderedRefs.new.kind === "repository-file"
              ? renderedRefs.new.path
              : "Pull Request.md")
        ) {
          const lineNumber = placement.range?.endLine ?? 0;
          const metadata = { kind: "comment", comment, placement } as const;
          if (effectiveDisplayMode === "full") {
            fileAnnotations.push({ lineNumber, metadata });
            markdownComments.push({ comment, placement });
          } else diffAnnotations.push({ side: "additions", lineNumber, metadata });
          added = true;
        }
      }
      if (!added && renderedRefs.old) {
        const placement = placementFor(comment.id, renderedRefs.old);
        if (
          placement &&
          !placement.outdated &&
          placement.path ===
            (renderedRefs.old.kind === "repository-file"
              ? renderedRefs.old.path
              : "Pull Request.md")
        ) {
          diffAnnotations.push({
            side: "deletions",
            lineNumber: placement.range?.endLine ?? 0,
            metadata: { kind: "comment", comment, placement },
          });
        }
      }
    }
    return { fileAnnotations, diffAnnotations, markdownComments, imageComments };
  }, [annotationQuery.data, comments, effectiveDisplayMode, renderedRefs, repositoryImageRefs]);

  const createMutation = useMutation({
    mutationFn: async ({
      target,
      body: commentBody,
    }: {
      target: CreateCommentTarget;
      location: OptimisticCommentLocation;
      body: string;
    }) =>
      await api<{ comment: ReviewComment }>(
        "/api/comments",
        jsonRequest({
          pullRequestId,
          target,
          body: commentBody,
          authorLabel: "You",
        }),
      ),
    onMutate: async () => await cancelCommentQuery(queryClient, pullRequestId),
    onError: () => invalidateCommentQuery(queryClient, pullRequestId),
    onSuccess: ({ comment }, { target, location }) => {
      window.getSelection()?.removeAllRanges();
      const range =
        target.kind === "document" && target.startLine !== null && target.endLine !== null
          ? { startLine: target.startLine, endLine: target.endLine }
          : null;
      const path =
        target.kind !== "document"
          ? null
          : target.documentKind === "pull-request-markdown"
            ? "Pull Request.md"
            : target.path;
      loadedOptimisticCommentId.current = null;
      setOptimisticComment({
        comment,
        placement: { outdated: false, range, path },
        location,
      });
      setBody("");
      setSelection(null);
      setSelectionPreview(null);
      setMarkdownComposerOpen(false);
      setFileComposerOpen(false);
      putCommentInCache(queryClient, pullRequestId, comment);
    },
  });

  const navigationRequestId = navigationTarget?.requestId ?? null;
  useLayoutEffect(() => {
    if (navigationRequestId === null) return;
    setBody("");
    setSelection(null);
    setSelectionPreview(null);
    setMarkdownComposerOpen(false);
    setFileComposerOpen(false);
    setOptimisticComment(null);
  }, [navigationRequestId]);
  useLayoutEffect(() => {
    if (!navigationTarget || navigationTarget.line !== null) return;
    const requestId = navigationTarget.requestId;
    const frame = window.requestAnimationFrame(() => {
      diffSurfaceRef.current?.scrollIntoView({
        behavior: "auto",
        block: "start",
        inline: "nearest",
      });
      navigationAppliedRef.current(requestId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationTarget]);
  useLayoutEffect(() => {
    if (
      !repositoryImageRefs ||
      !navigationTarget ||
      navigationTarget.line === null ||
      appliedNavigationRequest.current === navigationTarget.requestId
    ) {
      return;
    }
    const requestId = navigationTarget.requestId;
    const frame = window.requestAnimationFrame(() => {
      diffSurfaceRef.current?.scrollIntoView({
        behavior: "auto",
        block: "start",
        inline: "nearest",
      });
      appliedNavigationRequest.current = requestId;
      navigationAppliedRef.current(requestId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationTarget, repositoryImageRefs]);

  const selectedLineRef =
    effectiveDisplayMode === "full"
      ? fullRef
      : selection?.side === "deletions" || selection?.endSide === "deletions"
        ? renderedRefs.old
        : renderedRefs.new;
  const fileLevelRef =
    effectiveDisplayMode === "full" ? fullRef : (renderedRefs.new ?? renderedRefs.old ?? null);
  const canSubmitSelection =
    selection !== null &&
    selectedLineRef !== null &&
    selectedLineRef !== undefined &&
    (!selection.side || !selection.endSide || selection.side === selection.endSide);
  const create = (level: "file" | "line"): void => {
    const selectedRef = level === "file" ? fileLevelRef : selectedLineRef;
    if (!selectedRef || (level === "line" && !selection)) return;
    const startLine = level === "file" ? null : Math.min(selection!.start, selection!.end);
    const endLine = level === "file" ? null : Math.max(selection!.start, selection!.end);
    const target =
      selectedRef.kind === "pull-request-markdown"
        ? {
            kind: "document" as const,
            documentKind: "pull-request-markdown" as const,
            startLine,
            endLine,
          }
        : {
            kind: "document" as const,
            documentKind: "repository-file" as const,
            sourceOid: selectedRef.sourceOid,
            path: selectedRef.path,
            startLine,
            endLine,
          };
    const lineNumber = endLine ?? 0;
    const location: OptimisticCommentLocation =
      effectiveDisplayMode === "full"
        ? { mode: "full", lineNumber }
        : {
            mode: "diff",
            side:
              selectedRef.kind === "repository-file" &&
              renderedRefs.old?.kind === "repository-file" &&
              selectedRef.sourceOid === renderedRefs.old.sourceOid &&
              selectedRef.path === renderedRefs.old.path
                ? "deletions"
                : "additions",
            lineNumber,
          };
    createMutation.mutate({ target, location, body });
  };

  const createDiagramComment = useCallback(
    async (range: MarkdownSourceRange, commentBody: string): Promise<void> => {
      const target =
        fullRef.kind === "pull-request-markdown"
          ? {
              kind: "document" as const,
              documentKind: "pull-request-markdown" as const,
              startLine: range.startLine,
              endLine: range.endLine,
            }
          : {
              kind: "document" as const,
              documentKind: "repository-file" as const,
              sourceOid: fullRef.sourceOid,
              path: fullRef.path,
              startLine: range.startLine,
              endLine: range.endLine,
            };
      await createMutation.mutateAsync({
        target,
        body: commentBody,
        location: { mode: "full", lineNumber: range.endLine },
      });
    },
    [createMutation.mutateAsync, fullRef],
  );

  const closeComposer = (): void => {
    createMutation.reset();
    setBody("");
    setSelection(null);
    setSelectionPreview(null);
    setMarkdownComposerOpen(false);
    setFileComposerOpen(false);
  };
  const resetCreateMutation = createMutation.reset;
  const handleLineSelectionStart = useCallback(
    (range: SelectedLineRange | null): void => {
      resetCreateMutation();
      setBody("");
      setSelection(null);
      setSelectionPreview(range);
      setMarkdownComposerOpen(false);
      if (range) {
        setFileComposerOpen(false);
      }
    },
    [resetCreateMutation],
  );
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null): void => {
      resetCreateMutation();
      setBody("");
      setSelection(range);
      setSelectionPreview(null);
      setMarkdownComposerOpen(false);
      if (range) {
        setFileComposerOpen(false);
      }
    },
    [resetCreateMutation],
  );
  const { fileAnnotations, diffAnnotations } = useMemo(() => {
    const fileAnnotations = [...annotationData.fileAnnotations];
    const diffAnnotations = [...annotationData.diffAnnotations];
    const optimisticAlreadyLoaded =
      [...fileAnnotations, ...diffAnnotations].some(
        (annotation) =>
          annotation.metadata?.kind === "comment" &&
          annotation.metadata.comment.id === optimisticComment?.comment.id,
      ) ||
      annotationData.markdownComments.some(
        ({ comment }) => comment.id === optimisticComment?.comment.id,
      );
    if (
      optimisticComment &&
      !optimisticAlreadyLoaded &&
      loadedOptimisticCommentId.current !== optimisticComment.comment.id
    ) {
      const metadata = {
        kind: "comment" as const,
        comment: optimisticComment.comment,
        placement: optimisticComment.placement,
      };
      if (optimisticComment.location.mode === "full") {
        fileAnnotations.push({
          lineNumber: optimisticComment.location.lineNumber,
          metadata,
        });
      } else {
        diffAnnotations.push({
          side: optimisticComment.location.side,
          lineNumber: optimisticComment.location.lineNumber,
          metadata,
        });
      }
    }
    if (selection) {
      if (effectiveDisplayMode === "full") {
        fileAnnotations.push({
          lineNumber: Math.max(selection.start, selection.end),
          metadata: { kind: "line-composer" },
        });
      } else {
        const crossesSides =
          selection.side && selection.endSide && selection.side !== selection.endSide;
        diffAnnotations.push({
          side: selection.endSide ?? selection.side ?? "additions",
          lineNumber: crossesSides ? selection.end : Math.max(selection.start, selection.end),
          metadata: { kind: "line-composer" },
        });
      }
    }
    return { fileAnnotations, diffAnnotations };
  }, [annotationData, effectiveDisplayMode, optimisticComment, selection]);
  const markdownComments = useMemo(() => {
    const placed = [...annotationData.markdownComments];
    if (
      optimisticComment &&
      !placed.some(({ comment }) => comment.id === optimisticComment.comment.id)
    ) {
      placed.push({
        comment: optimisticComment.comment,
        placement: optimisticComment.placement,
      });
    }
    return placed;
  }, [annotationData.markdownComments, optimisticComment]);
  const repositoryImageComments = useMemo(() => {
    const placed = {
      old: [...annotationData.imageComments.old],
      new: [...annotationData.imageComments.new],
    };
    if (
      optimisticComment &&
      ![...placed.old, ...placed.new].some(
        ({ comment }) => comment.id === optimisticComment.comment.id,
      )
    ) {
      const side =
        optimisticComment.location.mode === "diff" &&
        optimisticComment.location.side === "deletions"
          ? "old"
          : "new";
      placed[side].push({
        comment: optimisticComment.comment,
        placement: optimisticComment.placement,
      });
    }
    return placed;
  }, [annotationData.imageComments, optimisticComment]);
  const markdownCommentAnnotations = useMemo<MarkdownCommentAnnotation[]>(
    () =>
      markdownComments.map(({ comment, placement }) => ({
        id: comment.id,
        range: placement.range,
      })),
    [markdownComments],
  );
  const markdownCommentsById = useMemo(
    () =>
      new Map(
        markdownComments.map(({ comment, placement }) => [comment.id, { comment, placement }]),
      ),
    [markdownComments],
  );
  const optimisticCommentId = optimisticComment?.comment.id;
  const markdownDiv: NonNullable<Components["div"]> = useCallback(
    ({ node, children, ...props }: ComponentPropsWithoutRef<"div"> & { node?: unknown }) => {
      const commentIds = markdownCommentAnchorIds(node);
      if (commentIds.length === 0) return <div {...props}>{children}</div>;
      return (
        <div className="markdown-inline-comments">
          {commentIds.map((commentId) => {
            const annotation = markdownCommentsById.get(commentId);
            return annotation ? (
              <CommentThread
                key={commentId}
                comment={annotation.comment}
                variant="inline"
                draftScope={replyDraftScope}
                placement={annotation.placement}
                themePreference={themePreference}
                onActiveChange={onCommentActiveChange}
                onOpenCodeReference={onOpenCodeReference}
                onOpenRepositoryLink={openRepositoryLink}
                {...(annotation.comment.id === optimisticCommentId
                  ? { onDeleted: () => setOptimisticComment(null) }
                  : {})}
              />
            ) : null;
          })}
        </div>
      );
    },
    [
      markdownCommentsById,
      onCommentActiveChange,
      onOpenCodeReference,
      openRepositoryLink,
      optimisticCommentId,
      replyDraftScope,
      themePreference,
    ],
  );
  useLayoutEffect(() => {
    if (!optimisticComment) return;
    const loaded =
      [...annotationData.fileAnnotations, ...annotationData.diffAnnotations].some(
        (annotation) =>
          annotation.metadata?.kind === "comment" &&
          annotation.metadata.comment.id === optimisticComment.comment.id,
      ) ||
      annotationData.markdownComments.some(
        ({ comment }) => comment.id === optimisticComment.comment.id,
      );
    if (loaded) loadedOptimisticCommentId.current = optimisticComment.comment.id;
  }, [annotationData, optimisticComment]);
  useLayoutEffect(() => {
    const anchor = pendingViewportAnchor.current;
    pendingViewportAnchor.current = null;
    if (anchor) restoreDiffViewportAnchor(diffSurfaceRef.current, anchor);
    return () => {
      pendingViewportAnchor.current = captureDiffViewportAnchor(diffSurfaceRef.current);
    };
  }, [diffAnnotations, fileAnnotations, renderedDiffCacheKey]);
  const navigationSelection: SelectedLineRange | null =
    navigationTarget && navigationTarget.line !== null && navigationTarget.endLine !== undefined
      ? {
          start: navigationTarget.line,
          end: navigationTarget.endLine,
          ...(effectiveDisplayMode === "full"
            ? {}
            : { side: "additions" as const, endSide: "additions" as const }),
        }
      : null;
  const navigationStartLine = navigationTarget?.line ?? null;
  const navigationEndLine = navigationTarget?.endLine;
  const markdownNavigationRange = useMemo<MarkdownSourceRange | null>(
    () =>
      navigationStartLine === null
        ? null
        : {
            startLine: navigationStartLine,
            endLine: navigationEndLine ?? navigationStartLine,
          },
    [navigationEndLine, navigationStartLine],
  );
  const markdownText =
    fullQuery.data?.availability === "available" ? (fullQuery.data.text ?? "") : null;
  const markdownSelectedRange: MarkdownSourceRange | null = selection
    ? {
        startLine: Math.min(selection.start, selection.end),
        endLine: Math.max(selection.start, selection.end),
      }
    : null;
  const composerStartLine = markdownComposerOpen
    ? (markdownSelectedRange?.startLine ?? null)
    : null;
  const composerEndLine = markdownComposerOpen ? (markdownSelectedRange?.endLine ?? null) : null;
  const renderedRepositoryMarkdown = useMemo(
    () =>
      markdownText === null
        ? null
        : renderRepositoryMarkdown({
            text: markdownText,
            pullRequestMarkdown: activeDocument.kind === "pull-request-markdown",
            annotations: markdownCommentAnnotations,
            activeCommentId,
            selectedRange:
              composerStartLine === null || composerEndLine === null
                ? null
                : { startLine: composerStartLine, endLine: composerEndLine },
            navigationRange: markdownNavigationRange,
            composerOpen: markdownComposerOpen,
            markdownDiv,
            sourceRef: fullRef,
            selectedOid,
            pullRequestId,
            themePreference,
            placedComments: markdownComments,
            replyDraftScope,
            linkPointerStart: markdownLinkPointerStart,
            onCommentActiveChange,
            onOpenCodeReference,
            onCreateDiagramComment: createDiagramComment,
            diagramCommentPending: createMutation.isPending,
            diagramCommentError: createMutation.error,
            onResetDiagramComment: createMutation.reset,
            onOpenRepositoryLink: openRepositoryLink,
            onOpenMarkdownFragment: openMarkdownFragment,
          }),
    [
      activeCommentId,
      activeDocument.kind,
      composerEndLine,
      composerStartLine,
      createDiagramComment,
      createMutation.error,
      createMutation.isPending,
      createMutation.reset,
      fullRef,
      markdownCommentAnnotations,
      markdownComposerOpen,
      markdownNavigationRange,
      markdownDiv,
      markdownComments,
      markdownText,
      onCommentActiveChange,
      onOpenCodeReference,
      openMarkdownFragment,
      openRepositoryLink,
      pullRequestId,
      replyDraftScope,
      selectedOid,
      themePreference,
    ],
  );
  useLayoutEffect(() => {
    if (
      !showingMarkdownPreview ||
      !navigationTarget ||
      navigationTarget.line === null ||
      appliedNavigationRequest.current === navigationTarget.requestId ||
      renderedRepositoryMarkdown === null
    ) {
      return;
    }
    const requestId = navigationTarget.requestId;
    const navigationLine = navigationTarget.line;
    const frame = window.requestAnimationFrame(() => {
      const target = markdownNavigationElement(diffSurfaceRef.current, navigationLine);
      if (!target) return;
      target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
      appliedNavigationRequest.current = requestId;
      navigationAppliedRef.current(requestId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationTarget, renderedRepositoryMarkdown, showingMarkdownPreview]);
  const activeSelection = fileComposerOpen
    ? null
    : (selectionPreview ?? selection ?? navigationSelection);
  const fileCommentButton = (
    <button
      className="comment-icon-button diff-header-comment-button"
      aria-label="ファイル全体へコメント"
      title="ファイル全体へコメント"
      aria-pressed={fileComposerOpen}
      disabled={!fileLevelRef}
      onClick={() => {
        createMutation.reset();
        setSelection(null);
        setSelectionPreview(null);
        setMarkdownComposerOpen(false);
        setBody("");
        setFileComposerOpen((open) => !open);
      }}
    >
      <CommentIcon />
    </button>
  );
  const fileStructureReferencesButton =
    fileLevelRef?.kind === "repository-file" ? (
      <FileStructureReferencesButton
        pullRequestId={pullRequestId}
        fileRef={fileLevelRef}
        structureFingerprint={structureFingerprint}
        structuresLoaded={structuresLoaded}
        onSelect={onOpenStructureReference}
      />
    ) : null;
  const fileHeaderActions = (
    <span className="diff-header-file-actions">
      {fileStructureReferencesButton}
      {fileCommentButton}
    </span>
  );
  const headerMetadata = (
    <>
      {fullViewNotice && <span className="diff-fallback-badge">{fullViewNotice}</span>}
      {fileHeaderActions}
    </>
  );
  if (effectiveDisplayMode === "full" && fullViewUnavailableMessage) {
    return (
      <div className="document-viewer">
        <div className="viewer-unavailable">
          <span>FILE</span>
          <p>{fullViewUnavailableMessage}</p>
        </div>
      </div>
    );
  }
  if (effectiveDisplayMode !== "full" && (!oldOid || oldOid === selectedOid)) {
    return (
      <div className="document-viewer">
        <div className="viewer-unavailable">
          <span>DIFF</span>
          <p>比較可能なcommit範囲がありません。</p>
        </div>
      </div>
    );
  }
  const loading = repositoryImageRefs
    ? false
    : effectiveDisplayMode === "full"
      ? fullQuery.isLoading
      : diffQuery.isLoading;
  if (loading) {
    return (
      <div className="document-viewer">
        <div className="viewer-loading">文書を準備しています…</div>
      </div>
    );
  }
  const documentError = repositoryImageRefs
    ? null
    : effectiveDisplayMode === "full"
      ? fullQuery.error
      : diffQuery.error;
  if (documentError) {
    return (
      <div className="document-viewer">
        <div className="viewer-error">
          <ErrorNotice error={documentError} />
        </div>
      </div>
    );
  }
  const selectedRangeLabel = selection
    ? `L${Math.min(selection.start, selection.end)}${selection.start === selection.end ? "" : `–${Math.max(selection.start, selection.end)}`}`
    : null;
  const selectedPathLabel =
    selectedLineRef?.kind === "repository-file" ? selectedLineRef.path : "Pull Request.md";
  const selectedSideLabel =
    effectiveDisplayMode === "full"
      ? null
      : selection?.side === "deletions" || selection?.endSide === "deletions"
        ? "変更前"
        : "変更後";
  const selectionLabel = selection
    ? `${[selectedPathLabel, selectedSideLabel, selectedRangeLabel].filter(Boolean).join(" · ")}へコメント`
    : "選択範囲へコメント";
  const annotationRenderer = (
    annotation: LineAnnotation<ViewerAnnotation> | DiffLineAnnotation<ViewerAnnotation>,
  ) => {
    if (!annotation.metadata) return null;
    if (annotation.metadata.kind === "comment") {
      const side = "side" in annotation ? annotation.side : null;
      return (
        <CommentThread
          comment={annotation.metadata.comment}
          variant="inline"
          draftScope={replyDraftScope}
          placement={annotation.metadata.placement}
          side={side ?? null}
          themePreference={themePreference}
          onActiveChange={onCommentActiveChange}
          onOpenCodeReference={onOpenCodeReference}
          onOpenRepositoryLink={openRepositoryLink}
          {...(annotation.metadata.comment.id === optimisticComment?.comment.id
            ? { onDeleted: () => setOptimisticComment(null) }
            : {})}
        />
      );
    }
    return (
      <InlineCommentComposer
        body={body}
        label={selectionLabel}
        disabled={!canSubmitSelection}
        pending={createMutation.isPending}
        error={createMutation.error}
        validationError={
          selection?.side && selection.endSide && selection.side !== selection.endSide
            ? "old/newをまたぐ選択にはコメントできません。"
            : undefined
        }
        placement="line"
        onBodyChange={setBody}
        onCancel={closeComposer}
        onSubmit={() => create("line")}
      />
    );
  };
  const markdownPath =
    activeDocument.kind === "repository-file" ? activeDocument.path : "Pull Request.md";
  const repositoryImageCommentNodes = (
    side: "old" | "new",
    diffSide: "deletions" | "additions" | null,
  ): ReactNode => {
    const placed = repositoryImageComments[side];
    return placed.length > 0 ? (
      <div className="repository-image-comments">
        {placed.map(({ comment, placement }) => (
          <CommentThread
            key={comment.id}
            comment={comment}
            variant="inline"
            draftScope={replyDraftScope}
            placement={placement}
            side={diffSide}
            themePreference={themePreference}
            onActiveChange={onCommentActiveChange}
            onOpenCodeReference={onOpenCodeReference}
            onOpenRepositoryLink={openRepositoryLink}
            {...(comment.id === optimisticComment?.comment.id
              ? { onDeleted: () => setOptimisticComment(null) }
              : {})}
          />
        ))}
      </div>
    ) : null;
  };
  const repositoryImageSurface =
    repositoryImageRefs && activeDocument.kind === "repository-file" ? (
      <RepositoryImageViewer
        mode={effectiveDisplayMode === "full" ? "full" : "split"}
        oldSide={
          effectiveDisplayMode === "full"
            ? null
            : {
                label: "変更前",
                path: oldPath,
                sourceUrl:
                  repositoryImageRefs.old?.kind === "repository-file" &&
                  isSupportedImagePath(repositoryImageRefs.old.path)
                    ? markdownAssetUrl(
                        pullRequestId,
                        repositoryImageRefs.old.sourceOid,
                        repositoryImageRefs.old.path,
                      )
                    : null,
                emptyMessage: oldPath
                  ? "変更前は対応画像ではありません。"
                  : "変更前の画像はありません。",
                action: repositoryImageRefs.new ? null : fileHeaderActions,
                comments: repositoryImageCommentNodes("old", "deletions"),
              }
        }
        newSide={{
          label: effectiveDisplayMode === "full" ? "全文" : "変更後",
          path: effectiveDisplayMode === "full" ? activeDocument.path : newPath,
          sourceUrl:
            repositoryImageRefs.new?.kind === "repository-file" &&
            isSupportedImagePath(repositoryImageRefs.new.path)
              ? markdownAssetUrl(
                  pullRequestId,
                  repositoryImageRefs.new.sourceOid,
                  repositoryImageRefs.new.path,
                )
              : null,
          emptyMessage:
            effectiveDisplayMode === "full"
              ? "画像を表示できません。"
              : newPath
                ? "変更後は対応画像ではありません。"
                : "変更後の画像はありません。",
          action: repositoryImageRefs.new ? fileHeaderActions : null,
          comments: repositoryImageCommentNodes(
            "new",
            effectiveDisplayMode === "full" ? null : "additions",
          ),
        }}
      />
    ) : null;
  const referenceFallback =
    activeDocument.kind === "repository-file" &&
    activeDocument.referenceContext?.outcome === "source-fallback"
      ? activeDocument.referenceContext
      : null;
  const staleReference =
    activeDocument.kind === "repository-file" &&
    activeDocument.referenceContext &&
    referenceStaleness
      ? activeDocument.referenceContext
      : null;
  const referenceOriginLabel =
    staleReference?.origin.kind === "structure" ? "Structure" : "Walkthrough";
  const reresolveReference = async (context: ReferenceDocumentContext): Promise<void> => {
    setReferenceResolutionPending(true);
    setReferenceResolutionError(null);
    const error = await onReresolveSourceReference(context);
    setReferenceResolutionPending(false);
    setReferenceResolutionError(error);
  };
  return (
    <div className="document-viewer">
      <ErrorNotice error={annotationQuery.error} />
      {staleReference && referenceStaleness && (
        <div className="reference-fallback-banner reference-stale-banner" role="status">
          <div>
            <strong>
              {referenceStaleness.originMissing
                ? referenceStaleness.originKind === "structure"
                  ? "Structureの参照元claimが削除されています"
                  : "Walkthroughの参照元が削除されています"
                : referenceStaleness.originChanged
                  ? `${referenceOriginLabel}が更新されています${
                      referenceStaleness.headChanged
                        ? ` · 解決時 ${staleReference.latestHeadOid.slice(0, 8)} → 現在 ${latestHeadOid.slice(0, 8)}`
                        : ""
                    }`
                  : `解決時 ${staleReference.latestHeadOid.slice(0, 8)} → 現在 ${latestHeadOid.slice(0, 8)}`}
            </strong>
            <span>
              {referenceFallback
                ? `参照時点のコード · ${referenceFallback.anchorSourceOid.slice(0, 8)} を表示中。`
                : ""}
              {referenceStaleness.originMissing
                ? "このコードは削除された参照元から最後に解決された状態です。"
                : referenceStaleness.originChanged
                  ? referenceStaleness.headChanged
                    ? `このコード参照は${referenceOriginLabel}とPRの更新前に解決されています。`
                    : `このコード参照は${referenceOriginLabel}の更新前に解決されています。`
                  : "このコード参照はPR更新前に解決されています。"}
              {referenceResolutionError ? ` ${referenceResolutionError}` : ""}
            </span>
          </div>
          {!referenceStaleness.originMissing && (
            <button
              type="button"
              disabled={referenceResolutionPending}
              onClick={() => void reresolveReference(staleReference)}
            >
              {referenceResolutionPending ? "再解決中…" : "最新へ再解決"}
            </button>
          )}
        </div>
      )}
      {referenceFallback && !staleReference && (
        <div className="reference-fallback-banner reference-anchor-fallback-banner" role="status">
          <div>
            <strong>参照時点のコード · {referenceFallback.anchorSourceOid.slice(0, 8)}</strong>
            <span>最新コード上の対応位置を確実に特定できませんでした。</span>
          </div>
          {referenceFallback.latestFile && (
            <button
              type="button"
              onClick={() => onOpenLatestReferenceFile(referenceFallback.latestFile!)}
            >
              最新のファイルを見る
            </button>
          )}
        </div>
      )}
      {markdownCapable && effectiveDisplayMode === "full" && (
        <div className="markdown-view-toolbar" aria-label="Markdown表示">
          <span>
            <FileEntryIcon path={markdownPath} kind="file" />
            <code>{markdownPath}</code>
          </span>
          <div className="segmented markdown-view-modes">
            <button
              className={markdownView === "source" ? "active" : ""}
              aria-pressed={markdownView === "source"}
              onClick={() => setMarkdownView("source")}
            >
              Source
            </button>
            <button
              className={markdownView === "preview" ? "active" : ""}
              aria-pressed={markdownView === "preview"}
              onClick={() => setMarkdownView("preview")}
            >
              Preview
            </button>
          </div>
        </div>
      )}
      {fileComposerOpen && (
        <InlineCommentComposer
          body={body}
          label="ファイル全体へコメント"
          pending={createMutation.isPending}
          error={createMutation.error}
          validationError={undefined}
          placement="file"
          onBodyChange={setBody}
          onCancel={closeComposer}
          onSubmit={() => create("file")}
        />
      )}
      <div className="diff-surface" ref={diffSurfaceRef} data-pane-find-surface>
        {repositoryImageSurface ? (
          repositoryImageSurface
        ) : showingMarkdownPreview ? (
          markdownText !== null ? (
            <div className="markdown-preview">
              <header>
                <span>Rendered Markdown</span>
                <span>テキストを選択して行コメント</span>
                {fullViewNotice && <span className="diff-fallback-badge">{fullViewNotice}</span>}
                {fileHeaderActions}
              </header>
              <MarkdownSelectionSurface
                selectedRange={markdownSelectedRange}
                composerOpen={markdownComposerOpen}
                onSelection={(range) => {
                  createMutation.reset();
                  setBody("");
                  setSelection(range ? { start: range.startLine, end: range.endLine } : null);
                  setSelectionPreview(null);
                  setMarkdownComposerOpen(false);
                  if (range) setFileComposerOpen(false);
                }}
                onOpenComposer={() => setMarkdownComposerOpen(true)}
                composer={
                  <InlineCommentComposer
                    body={body}
                    label={selectionLabel}
                    pending={createMutation.isPending}
                    error={createMutation.error}
                    validationError={undefined}
                    placement="line"
                    onBodyChange={setBody}
                    onCancel={closeComposer}
                    onSubmit={() => create("line")}
                  />
                }
              >
                <article data-pane-find-text>{renderedRepositoryMarkdown}</article>
              </MarkdownSelectionSurface>
            </div>
          ) : (
            <Unavailable document={fullQuery.data ?? null} fileCommentAction={fileHeaderActions} />
          )
        ) : effectiveDisplayMode === "full" ? (
          fullFile ? (
            <File<ViewerAnnotation>
              file={fullFile}
              style={viewerStyle}
              disableWorkerPool
              lineAnnotations={fileAnnotations}
              selectedLines={activeSelection}
              renderAnnotation={annotationRenderer}
              renderHeaderPrefix={(file) => <FileEntryIcon path={file.name} kind="file" />}
              renderHeaderMetadata={() => headerMetadata}
              options={{
                stickyHeader: true,
                enableGutterUtility: true,
                enableLineSelection: true,
                lineHoverHighlight: "both",
                onGutterUtilityClick: setSelectionPreview,
                onLineSelectionChange: setSelectionPreview,
                onLineSelectionEnd: handleLineSelectionEnd,
                onLineSelectionStart: handleLineSelectionStart,
                overflow: "scroll",
                theme: { light: "github-light", dark: "github-dark" },
                themeType: themePreference,
                unsafeCSS: viewerUnsafeCss,
                onPostRender: handleFullPostRender,
              }}
            />
          ) : (
            <Unavailable document={fullQuery.data ?? null} fileCommentAction={fileHeaderActions} />
          )
        ) : renderedDiff ? (
          <>
            <FileDiff<ViewerAnnotation>
              fileDiff={renderedDiff}
              style={viewerStyle}
              disableWorkerPool
              lineAnnotations={diffAnnotations}
              selectedLines={activeSelection}
              renderAnnotation={annotationRenderer}
              renderHeaderPrefix={(file) => <FileEntryIcon path={file.name} kind="file" />}
              renderHeaderMetadata={() => headerMetadata}
              options={{
                stickyHeader: true,
                diffStyle,
                enableGutterUtility: true,
                enableLineSelection: true,
                lineHoverHighlight: "both",
                onGutterUtilityClick: setSelectionPreview,
                onLineSelectionChange: setSelectionPreview,
                onLineSelectionEnd: handleLineSelectionEnd,
                onLineSelectionStart: handleLineSelectionStart,
                overflow: "scroll",
                theme: { light: "github-light", dark: "github-dark" },
                themeType: themePreference,
                unsafeCSS: viewerUnsafeCss,
                onPostRender: handleDiffPostRender,
              }}
            />
            {hideWhitespace && renderedDiff.hunks.length === 0 && (
              <div className="diff-whitespace-empty" role="status">
                <strong>空白差分をすべて非表示にしています。</strong>
                <span>右上の「…」メニューで Hide Whitespace を解除できます。</span>
              </div>
            )}
          </>
        ) : (
          <Unavailable
            document={diffQuery.data?.new ?? diffQuery.data?.old ?? null}
            fileCommentAction={fileHeaderActions}
          />
        )}
      </div>
    </div>
  );
}
