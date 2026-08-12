import {
  File,
  MultiFileDiff,
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
  isValidElement,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type {
  CommentPlacement,
  DocumentContent,
  DocumentRef,
  ReviewComment,
} from "../../domain/models.js";
import type { ActiveDocument } from "../document-workspace.js";
import {
  api,
  documentUrl,
  type DiffResponse,
  type DocumentResponse,
  jsonRequest,
  type PlacementResponse,
} from "../api.js";
import {
  isExternalMarkdownHref,
  markdownLinkWasDragged,
  resolveRepositoryMarkdownPath,
  type PointerPosition,
} from "../markdown-links.js";
import {
  MarkdownSelectionSurface,
  markdownCommentAnchorIds,
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
import { MarkdownImagePlaceholder } from "./MarkdownImagePlaceholder.js";

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
  return `repository-file:${document.path}`;
}

const viewerUnsafeCss = `
  :host {
    --diffs-bg: light-dark(var(--diffs-light-bg, #fff), #000);
    --diffs-bg-addition-override: light-dark(
      color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-addition-base)),
      color-mix(in lab, var(--diffs-bg) 86%, var(--diffs-addition-base))
    );
    --diffs-bg-deletion-override: light-dark(
      color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-deletion-base)),
      color-mix(in lab, var(--diffs-bg) 86%, var(--diffs-deletion-base))
    );
    --diffs-bg-addition-emphasis-override: light-dark(
      rgb(from var(--diffs-addition-base) r g b / 0.15),
      rgb(from var(--diffs-addition-base) r g b / 0.14)
    );
    --diffs-bg-deletion-emphasis-override: light-dark(
      rgb(from var(--diffs-deletion-base) r g b / 0.15),
      rgb(from var(--diffs-deletion-base) r g b / 0.14)
    );
  }
  [data-change-icon="file"] {
    display: none;
  }
  [data-line] {
    padding-inline-start: calc(1ch + 8px);
  }
  [data-line][data-editor-active-line] {
    background: color-mix(in srgb, var(--diffs-modified-base) 28%, transparent) !important;
  }
`;

export type DisplayMode = "full" | "pull-request" | "range";
export interface ViewerNavigationTarget {
  documentKey: string;
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
): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const root = container.shadowRoot;
      if (!root) return;
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
      if (!target) return;
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
    });
  });
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

function params(ref: DocumentRef): string {
  const search = new URLSearchParams({ kind: ref.kind, pullRequestId: ref.pullRequestId });
  if (ref.kind === "repository-file") {
    search.set("sourceOid", ref.sourceOid);
    search.set("path", ref.path);
  }
  return search.toString();
}

function markdownAssetUrl(pullRequestId: string, sourceOid: string, filePath: string): string {
  const search = new URLSearchParams({ sourceOid, path: filePath });
  return `/api/pull-requests/${pullRequestId}/markdown-asset?${search.toString()}`;
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

function openMarkdownFragment(anchor: HTMLAnchorElement, href: string): void {
  let id: string;
  try {
    id = decodeURIComponent(href.slice(1));
  } catch {
    return;
  }
  const pane = anchor.closest(".document-pane");
  const target = [...(pane?.querySelectorAll<HTMLElement>("[id]") ?? [])].find(
    (element) => element.id === id,
  );
  if (!target) return;
  target.scrollIntoView({ block: "start" });
  window.history.replaceState(null, "", href);
}

function renderRepositoryMarkdown({
  text,
  pullRequestMarkdown,
  annotations,
  activeCommentId,
  selectedRange,
  composerOpen,
  markdownDiv,
  sourceRef,
  selectedOid,
  pullRequestId,
  linkPointerStart,
  onOpenRepositoryLink,
}: {
  text: string;
  pullRequestMarkdown: boolean;
  annotations: MarkdownCommentAnnotation[];
  activeCommentId: string | null;
  selectedRange: MarkdownSourceRange | null;
  composerOpen: boolean;
  markdownDiv: NonNullable<Components["div"]>;
  sourceRef: DocumentRef;
  selectedOid: string;
  pullRequestId: string;
  linkPointerStart: { current: PointerPosition | null };
  onOpenRepositoryLink: (path: string, sourceOid: string, openInOtherPane: boolean) => void;
}): ReactNode {
  const headingCounts = new Map<string, number>();
  return (
    <ReactMarkdown
      rehypePlugins={[
        rehypeRaw,
        rehypeSanitize,
        [rehypeRvwSourceMap, { annotations, activeCommentId, selectedRange, composerOpen }],
      ]}
      remarkPlugins={pullRequestMarkdown ? [remarkGfm, remarkBreaks] : [remarkGfm]}
      components={{
        div: markdownDiv,
        table: ({ children, node: _node, ...props }) => (
          <div className="markdown-table-scroll">
            <table {...markdownSourceDataAttributes(_node)} {...props}>
              {children}
            </table>
          </div>
        ),
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
                    openMarkdownFragment(event.currentTarget, href);
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
                  if (event.detail === 0) openMarkdownFragment(event.currentTarget, href);
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
          if (sourceRef.kind !== "repository-file") {
            return (
              <MarkdownImagePlaceholder
                alt={alt}
                title={title}
                sourceAttributes={markdownSourceDataAttributes(_node)}
              />
            );
          }
          const repositoryPath = resolveRepositoryMarkdownPath(src, sourceRef.path);
          if (!repositoryPath) {
            return (
              <MarkdownImagePlaceholder
                alt={alt}
                title={title}
                sourceAttributes={markdownSourceDataAttributes(_node)}
              />
            );
          }
          return (
            <img
              {...markdownSourceDataAttributes(_node)}
              {...props}
              src={markdownAssetUrl(pullRequestId, sourceRef.sourceOid, repositoryPath)}
              alt={alt ?? ""}
              title={title}
            />
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function placementUrl(commentId: string, ref: DocumentRef): string {
  return `/api/comments/${commentId}/placement?${params(ref)}`;
}

function fileValue(document: DocumentContent | null, fallbackName: string) {
  if (!document || document.availability !== "available") return null;
  const file = {
    name: document.ref.kind === "repository-file" ? document.ref.path : fallbackName,
    contents: document.text ?? "",
  };
  return document.ref.kind === "repository-file"
    ? { ...file, cacheKey: `${document.ref.sourceOid}:${document.ref.path}` }
    : file;
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
  selectedOid,
  oldOid,
  activeDocument,
  displayMode,
  diffStyle,
  comments,
  activeCommentId,
  fullViewNotice = null,
  fullViewUnavailableMessage = null,
  themePreference,
  onCommentActiveChange,
  navigationTarget = null,
  onOpenRepositoryLink,
}: {
  pullRequestId: string;
  selectedOid: string;
  oldOid: string | null;
  activeDocument: ActiveDocument;
  displayMode: DisplayMode;
  diffStyle: "unified" | "split";
  comments: ReviewComment[];
  activeCommentId: string | null;
  fullViewNotice?: string | null;
  fullViewUnavailableMessage?: string | null;
  themePreference: ThemePreference;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  navigationTarget?: ViewerNavigationTarget | null;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInOtherPane: boolean) => void;
}) {
  if (activeDocument.kind === "walkthrough") {
    throw new Error("walkthroughはWalkthroughViewerで表示してください。");
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
  const setMarkdownView = (view: "source" | "preview"): void => {
    markdownViewByDocument.set(activeMarkdownViewKey, view);
    setMarkdownViewState(view);
  };
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<SelectedLineRange | null>(null);
  const [markdownComposerOpen, setMarkdownComposerOpen] = useState(false);
  const [fileComposerOpen, setFileComposerOpen] = useState(false);
  const [body, setBody] = useState("");
  const [optimisticComment, setOptimisticComment] = useState<OptimisticCommentAnnotation | null>(
    null,
  );
  const loadedOptimisticCommentId = useRef<string | null>(null);
  const markdownLinkPointerStart = useRef<PointerPosition | null>(null);
  const openRepositoryLinkRef = useRef(onOpenRepositoryLink);
  openRepositoryLinkRef.current = onOpenRepositoryLink;
  const openRepositoryLink = useCallback(
    (path: string, sourceOid: string, openInOtherPane: boolean) =>
      openRepositoryLinkRef.current(path, sourceOid, openInOtherPane),
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
  const fullQuery = useQuery({
    queryKey: ["document", fullRef],
    queryFn: async () => (await api<DocumentResponse>(documentUrl(fullRef))).document,
    enabled: effectiveDisplayMode === "full" && !fullViewUnavailableMessage,
    staleTime: fullRef.kind === "repository-file" ? Number.POSITIVE_INFINITY : 0,
  });
  const diffSearch = new URLSearchParams({ kind: activeDocument.kind });
  if (activeDocument.kind === "repository-file") {
    if (oldOid) diffSearch.set("oldOid", oldOid);
    diffSearch.set("newOid", selectedOid);
    const oldPath =
      activeDocument.oldPath === undefined ? activeDocument.path : activeDocument.oldPath;
    const newPath =
      activeDocument.newPath === undefined ? activeDocument.path : activeDocument.newPath;
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
      activeDocument.kind === "repository-file" &&
      Boolean(oldOid) &&
      oldOid !== selectedOid,
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
  const renderedRefs = useMemo(() => {
    if (effectiveDisplayMode === "full") return { old: null, new: fullRef };
    return {
      old: diffQuery.data?.old?.ref ?? null,
      new: diffQuery.data?.new?.ref ?? null,
    };
  }, [effectiveDisplayMode, fullRef, diffQuery.data]);
  const annotationQuery = useQuery({
    queryKey: [
      "annotations",
      comments.map((comment) => `${comment.id}:${comment.updatedAt}`),
      renderedRefs,
      renderedRefs.new?.kind === "pull-request-markdown" ? fullQuery.data?.text : null,
    ],
    queryFn: async () => {
      const fileAnnotations: LineAnnotation<ViewerAnnotation>[] = [];
      const diffAnnotations: DiffLineAnnotation<ViewerAnnotation>[] = [];
      const markdownComments: Array<{
        comment: ReviewComment;
        placement: CommentPlacement;
      }> = [];
      for (const comment of comments) {
        let added = false;
        if (renderedRefs.new) {
          const { placement } = await api<PlacementResponse>(
            placementUrl(comment.id, renderedRefs.new),
          );
          if (
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
          const { placement } = await api<PlacementResponse>(
            placementUrl(comment.id, renderedRefs.old),
          );
          if (
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
      return { fileAnnotations, diffAnnotations, markdownComments };
    },
    enabled: Boolean(renderedRefs.new || renderedRefs.old),
    placeholderData: (previousData) => previousData,
  });

  const createMutation = useMutation({
    mutationFn: async ({
      target,
    }: {
      target: CreateCommentTarget;
      location: OptimisticCommentLocation;
    }) =>
      await api<{ comment: ReviewComment }>(
        "/api/comments",
        jsonRequest({
          pullRequestId,
          target,
          body,
          authorLabel: "You",
        }),
      ),
    onSuccess: async ({ comment }, { target, location }) => {
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
      await queryClient.invalidateQueries({ queryKey: ["comments"] });
      await queryClient.invalidateQueries({ queryKey: ["change-sequence"] });
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
    const frame = window.requestAnimationFrame(() => {
      diffSurfaceRef.current?.scrollIntoView({
        behavior: "auto",
        block: "start",
        inline: "nearest",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationTarget]);

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
    createMutation.mutate({ target, location });
  };

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
    const fileAnnotations = [...(annotationQuery.data?.fileAnnotations ?? [])];
    const diffAnnotations = [...(annotationQuery.data?.diffAnnotations ?? [])];
    const optimisticAlreadyLoaded =
      [...fileAnnotations, ...diffAnnotations].some(
        (annotation) =>
          annotation.metadata?.kind === "comment" &&
          annotation.metadata.comment.id === optimisticComment?.comment.id,
      ) ||
      annotationQuery.data?.markdownComments.some(
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
  }, [annotationQuery.data, effectiveDisplayMode, optimisticComment, selection]);
  const markdownComments = useMemo(() => {
    const placed = [...(annotationQuery.data?.markdownComments ?? [])];
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
  }, [annotationQuery.data?.markdownComments, optimisticComment]);
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
                placement={annotation.placement}
                onActiveChange={onCommentActiveChange}
                {...(annotation.comment.id === optimisticCommentId
                  ? { onDeleted: () => setOptimisticComment(null) }
                  : {})}
              />
            ) : null;
          })}
        </div>
      );
    },
    [markdownCommentsById, onCommentActiveChange, optimisticCommentId],
  );
  useLayoutEffect(() => {
    if (!optimisticComment) return;
    const loaded =
      [
        ...(annotationQuery.data?.fileAnnotations ?? []),
        ...(annotationQuery.data?.diffAnnotations ?? []),
      ].some(
        (annotation) =>
          annotation.metadata?.kind === "comment" &&
          annotation.metadata.comment.id === optimisticComment.comment.id,
      ) ||
      annotationQuery.data?.markdownComments.some(
        ({ comment }) => comment.id === optimisticComment.comment.id,
      );
    if (loaded) loadedOptimisticCommentId.current = optimisticComment.comment.id;
  }, [annotationQuery.data, optimisticComment]);
  useLayoutEffect(() => {
    const anchor = pendingViewportAnchor.current;
    pendingViewportAnchor.current = null;
    if (anchor) restoreDiffViewportAnchor(diffSurfaceRef.current, anchor);
    return () => {
      pendingViewportAnchor.current = captureDiffViewportAnchor(diffSurfaceRef.current);
    };
  }, [diffAnnotations, fileAnnotations]);
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
  useLayoutEffect(() => {
    if (
      !showingMarkdownPreview ||
      !navigationTarget ||
      navigationTarget.line === null ||
      appliedNavigationRequest.current === navigationTarget.requestId
    ) {
      return;
    }
    appliedNavigationRequest.current = navigationTarget.requestId;
    const frame = window.requestAnimationFrame(() => {
      const target = diffSurfaceRef.current?.querySelector<HTMLElement>(
        `[data-rvw-source-start-line="${navigationTarget.line}"]`,
      );
      target?.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationTarget, showingMarkdownPreview]);
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
            composerOpen: markdownComposerOpen,
            markdownDiv,
            sourceRef: fullRef,
            selectedOid,
            pullRequestId,
            linkPointerStart: markdownLinkPointerStart,
            onOpenRepositoryLink: openRepositoryLink,
          }),
    [
      activeCommentId,
      activeDocument.kind,
      composerEndLine,
      composerStartLine,
      fullRef,
      markdownCommentAnnotations,
      markdownComposerOpen,
      markdownDiv,
      markdownText,
      openRepositoryLink,
      pullRequestId,
      selectedOid,
    ],
  );
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
  const headerMetadata = (
    <>
      {fullViewNotice && <span className="diff-fallback-badge">{fullViewNotice}</span>}
      {fileCommentButton}
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
  const loading = effectiveDisplayMode === "full" ? fullQuery.isLoading : diffQuery.isLoading;
  if (loading) {
    return (
      <div className="document-viewer">
        <div className="viewer-loading">文書を準備しています…</div>
      </div>
    );
  }
  const documentError = effectiveDisplayMode === "full" ? fullQuery.error : diffQuery.error;
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
          placement={annotation.metadata.placement}
          side={side ?? null}
          onActiveChange={onCommentActiveChange}
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
  return (
    <div className="document-viewer">
      <ErrorNotice error={annotationQuery.error} />
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
      <div className="diff-surface" ref={diffSurfaceRef}>
        {showingMarkdownPreview ? (
          markdownText !== null ? (
            <div className="markdown-preview">
              <header>
                <span>Rendered Markdown</span>
                <span>テキストを選択して行コメント</span>
                {fullViewNotice && <span className="diff-fallback-badge">{fullViewNotice}</span>}
                {fileCommentButton}
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
                <article>{renderedRepositoryMarkdown}</article>
              </MarkdownSelectionSurface>
            </div>
          ) : (
            <Unavailable document={fullQuery.data ?? null} fileCommentAction={fileCommentButton} />
          )
        ) : effectiveDisplayMode === "full" ? (
          fullFile ? (
            <File<ViewerAnnotation>
              file={fullFile}
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
            <Unavailable document={fullQuery.data ?? null} fileCommentAction={fileCommentButton} />
          )
        ) : diffFiles ? (
          <MultiFileDiff<ViewerAnnotation>
            {...diffFiles}
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
        ) : (
          <Unavailable
            document={diffQuery.data?.new ?? diffQuery.data?.old ?? null}
            fileCommentAction={fileCommentButton}
          />
        )}
      </div>
    </div>
  );
}
