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
  RepositoryReviewDocumentContent,
  RepositoryReviewDocumentRef,
  CodeReference,
  CommentPlacement,
  DocumentContent,
  DocumentRef,
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
import type { ActiveDocument, DocumentPaneId } from "../document-workspace.js";
import { fileContentsForRenderer } from "../file-rendering.js";
import {
  api,
  documentUrl,
  type DiffResponse,
  type DocumentResponse,
  jsonRequest,
  type PlacementResponse,
} from "../api.js";
import {
  repositoryGitHubAttachmentAssetUrl,
  repositoryMarkdownAssetUrl,
  githubAttachmentAssetUrl,
  isExternalMarkdownHref,
  markdownAssetUrl,
  markdownLinkWasDragged,
  resolveRepositoryMarkdownPath,
  type PointerPosition,
} from "../markdown-links.js";
import {
  reviewCommentPayload,
  type AnyReviewComment,
  type ReviewIdentity,
} from "../review-context.js";
import {
  MarkdownSelectionSurface,
  markdownCommentAnchorIds,
  markdownSourceDataAttributes,
  rehypeRvwSourceMap,
  type MarkdownCommentAnnotation,
  type MarkdownSourceRange,
} from "../markdown-source-map.js";
import type { ThemePreference } from "../theme.js";
import { reviewQueryKeys } from "../review-query-keys.js";
import { CommentIcon, InlineCommentComposer } from "./CommentComposer.js";
import { CommentThread } from "./CommentThread.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { FileEntryIcon } from "./FileIcon.js";
import { MarkdownImagePlaceholder } from "./MarkdownImagePlaceholder.js";
import { MarkdownImage } from "./MarkdownImage.js";
import { PreviewMarkdownTable } from "./MarkdownTable.js";
import { RepositoryImageViewer } from "./RepositoryImageViewer.js";

type ViewerAnnotation =
  | { kind: "comment"; comment: AnyReviewComment; placement: CommentPlacement }
  | { kind: "line-composer" };

type ReviewFileRef = DocumentRef | RepositoryReviewDocumentRef;
type ReviewDocumentContent = DocumentContent | RepositoryReviewDocumentContent;

type CreateCommentTarget =
  | { kind: "pull-request" }
  | {
      kind: "issue";
      issue: string;
      startLine: number | null;
      endLine: number | null;
    }
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
  comment: AnyReviewComment;
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
  if (document.kind === "issue") return `issue:${document.id}`;
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
  [data-diffs-header][data-sticky] {
    top: 40px;
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

function params(ref: ReviewFileRef): string {
  const search = new URLSearchParams({
    kind: ref.kind,
    ...("pullRequestId" in ref
      ? { pullRequestId: ref.pullRequestId }
      : { repositoryReviewId: ref.repositoryReviewId }),
  });
  if (ref.kind === "repository-file") {
    search.set("sourceOid", ref.sourceOid);
    search.set("path", ref.path);
  } else if (ref.kind === "issue-markdown") {
    search.set("issueId", ref.issueId);
  }
  return search.toString();
}

function reviewDocumentUrl(ref: ReviewFileRef): string {
  if ("pullRequestId" in ref) return documentUrl(ref);
  const search = new URLSearchParams({ kind: ref.kind });
  if (ref.kind === "repository-file") {
    search.set("sourceOid", ref.sourceOid);
    search.set("path", ref.path);
  } else {
    search.set("issueId", ref.issueId);
  }
  return `/api/repository-reviews/${ref.repositoryReviewId}/document?${search.toString()}`;
}

function reviewDocumentPath(ref: ReviewFileRef, activeDocument: ActiveDocument): string {
  if (ref.kind === "repository-file") return ref.path;
  if (ref.kind === "pull-request-markdown") return "Pull Request.md";
  return activeDocument.kind === "issue" ? `#${activeDocument.number}` : "Issue";
}

function reviewMarkdownAssetUrl(
  review: ReviewIdentity,
  sourceOid: string,
  filePath: string,
): string {
  return review.kind === "pull-request"
    ? markdownAssetUrl(review.id, sourceOid, filePath)
    : repositoryMarkdownAssetUrl(review.id, sourceOid, filePath);
}

function reviewGitHubAttachmentUrl(
  review: ReviewIdentity,
  absoluteUrl: string | undefined,
): string | null {
  return review.kind === "pull-request"
    ? githubAttachmentAssetUrl(review.id, absoluteUrl)
    : repositoryGitHubAttachmentAssetUrl(review.id, absoluteUrl);
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

function renderReviewMarkdown({
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
  review,
  linkPointerStart,
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
  sourceRef: ReviewFileRef;
  selectedOid: string;
  review: ReviewIdentity;
  linkPointerStart: { current: PointerPosition | null };
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
  onOpenMarkdownFragment: (line: number, hash: string) => void;
}): ReactNode {
  const headingCounts = new Map<string, number>();
  return (
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
          if (sourceRef.kind === "pull-request-markdown" || sourceRef.kind === "issue-markdown") {
            const attachmentUrl = reviewGitHubAttachmentUrl(review, src);
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
              src={reviewMarkdownAssetUrl(review, sourceRef.sourceOid, repositoryPath)}
              alt={alt}
              title={title}
              sourceAttributes={sourceAttributes}
            />
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function placementUrl(commentId: string, ref: ReviewFileRef): string {
  return `/api/comments/${commentId}/placement?${params(ref)}`;
}

function commentCanTargetDocument(comment: AnyReviewComment, ref: ReviewFileRef): boolean {
  if (ref.kind === "issue-markdown") {
    return comment.target.kind === "issue" && comment.target.issueId === ref.issueId;
  }
  if (ref.kind === "pull-request-markdown") {
    return (
      comment.target.kind === "document" && comment.target.documentKind === "pull-request-markdown"
    );
  }
  return comment.target.kind === "document" && comment.target.documentKind === "repository-file";
}

function fileValue(document: ReviewDocumentContent | null, fallbackName: string) {
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
  document: ReviewDocumentContent | null;
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
  review,
  paneId,
  selectedOid,
  oldOid,
  activeDocument,
  documentRevision = null,
  displayMode,
  diffStyle,
  comments,
  commentPlacements,
  activeCommentId,
  fullViewNotice = null,
  fullViewUnavailableMessage = null,
  themePreference,
  onCommentActiveChange,
  navigationTarget = null,
  onNavigationApplied,
  onOpenMarkdownFragment,
  onOpenCodeReference,
  onOpenRepositoryLink,
}: {
  review: ReviewIdentity;
  paneId: DocumentPaneId;
  selectedOid: string;
  oldOid: string | null;
  activeDocument: ActiveDocument;
  documentRevision?: string | null;
  displayMode: DisplayMode;
  diffStyle: "unified" | "split";
  comments: AnyReviewComment[];
  commentPlacements?: ReadonlyMap<string, CommentPlacement>;
  activeCommentId: string | null;
  fullViewNotice?: string | null;
  fullViewUnavailableMessage?: string | null;
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
}) {
  if (activeDocument.kind === "walkthrough") {
    throw new Error("この文書は専用viewerで表示してください。");
  }
  const queryClient = useQueryClient();
  const markdownCapable =
    activeDocument.kind === "pull-request-markdown" ||
    activeDocument.kind === "issue" ||
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
  const commentDraftKey = commentDraftContextKey({
    reviewKind: review.kind,
    activeDocument,
    pane: paneId,
    selectedOid,
    oldOid,
    displayMode,
  });
  const replyDraftScope = commentReplyDraftScope(paneId, activeDocument);
  const commentDraftRevision = useRef(
    currentCommentDraftRevision(review.id, commentDraftKey),
  ).current;
  const initialCommentDraft = readCommentDraft(review.id, commentDraftKey);
  const [selection, setSelection] = useState<SelectedLineRange | null>(
    initialCommentDraft?.selection ?? null,
  );
  const [selectionDocumentRevision, setSelectionDocumentRevision] = useState<string | null>(
    initialCommentDraft?.documentRevision ?? documentRevision,
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
    const persistDraft = (): void => {
      if (fileComposerOpen || markdownComposerOpen || selection) {
        writeCommentDraft(review.id, commentDraftKey, commentDraftRevision, {
          body,
          selection,
          documentRevision: selectionDocumentRevision,
          markdownComposerOpen,
          fileComposerOpen,
        });
        return;
      }
      deleteCommentDraft(review.id, commentDraftKey, commentDraftRevision);
    };
    persistDraft();
    return persistDraft;
  }, [
    body,
    commentDraftKey,
    commentDraftRevision,
    fileComposerOpen,
    markdownComposerOpen,
    review.id,
    selection,
    selectionDocumentRevision,
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
    activeDocument.kind === "pull-request-markdown" || activeDocument.kind === "issue"
      ? "full"
      : displayMode;
  const showingMarkdownPreview =
    markdownCapable && effectiveDisplayMode === "full" && markdownView === "preview";
  const fullRef = useMemo<ReviewFileRef>(
    () =>
      activeDocument.kind === "pull-request-markdown"
        ? {
            kind: "pull-request-markdown",
            pullRequestId: review.id,
          }
        : activeDocument.kind === "issue"
          ? review.kind === "pull-request"
            ? {
                kind: "issue-markdown",
                pullRequestId: review.id,
                issueId: activeDocument.id,
              }
            : {
                kind: "issue-markdown",
                repositoryReviewId: review.id,
                issueId: activeDocument.id,
              }
          : review.kind === "pull-request"
            ? {
                kind: "repository-file",
                pullRequestId: review.id,
                sourceOid: activeDocument.sourceOid ?? selectedOid,
                path: activeDocument.path,
              }
            : {
                kind: "repository-file",
                repositoryReviewId: review.id,
                sourceOid: activeDocument.sourceOid ?? selectedOid,
                path: activeDocument.path,
              },
    [
      activeDocument.kind,
      activeDocument.kind === "issue" ? activeDocument.id : null,
      activeDocument.kind === "repository-file" ? activeDocument.path : null,
      activeDocument.kind === "repository-file" ? activeDocument.sourceOid : null,
      review.id,
      review.kind,
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
    queryKey: reviewQueryKeys.document(fullRef),
    queryFn: async () =>
      (
        await api<DocumentResponse | { document: RepositoryReviewDocumentContent }>(
          reviewDocumentUrl(fullRef),
        )
      ).document,
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
    queryKey: ["diff", review.kind, review.id, oldOid, selectedOid, activeDocument],
    queryFn: async () =>
      (await api<DiffResponse>(`/api/pull-requests/${review.id}/diff?${diffSearch.toString()}`))
        .diff,
    enabled:
      review.kind === "pull-request" &&
      effectiveDisplayMode !== "full" &&
      !repositoryImageViewerActive &&
      activeDocument.kind === "repository-file" &&
      Boolean(oldOid) &&
      oldOid !== selectedOid,
  });
  const documentPath = reviewDocumentPath(fullRef, activeDocument);
  const fullFile = useMemo(
    () => fileValue(fullQuery.data ?? null, documentPath),
    [documentPath, fullQuery.data],
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
        review.kind === "pull-request" && oldOid && oldPath
          ? {
              kind: "repository-file" as const,
              pullRequestId: review.id,
              sourceOid: oldOid,
              path: oldPath,
            }
          : null,
      new:
        review.kind === "pull-request" && newPath
          ? {
              kind: "repository-file" as const,
              pullRequestId: review.id,
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
    review.id,
    review.kind,
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
  const placementCacheKey = comments.map((comment) => {
    const placement = commentPlacements?.get(comment.id);
    return placement
      ? `${comment.id}:${placement.outdated}:${placement.path ?? ""}:${placement.range?.startLine ?? ""}:${placement.range?.endLine ?? ""}`
      : `${comment.id}:uncached`;
  });
  const loadPlacement = async (
    comment: AnyReviewComment,
    ref: ReviewFileRef,
  ): Promise<CommentPlacement> => {
    const cachedPlacement =
      ref.kind === "issue-markdown" ||
      (ref.kind === "repository-file" && ref.sourceOid === review.sourceOid)
        ? commentPlacements?.get(comment.id)
        : undefined;
    if (cachedPlacement) return cachedPlacement;
    return (await api<PlacementResponse>(placementUrl(comment.id, ref))).placement;
  };
  const annotationQuery = useQuery({
    queryKey: [
      "annotations",
      comments.map((comment) => `${comment.id}:${comment.updatedAt}`),
      placementCacheKey,
      renderedRefs,
      renderedRefs.new?.kind !== "repository-file" ? fullQuery.data?.text : null,
    ],
    queryFn: async () => {
      const fileAnnotations: LineAnnotation<ViewerAnnotation>[] = [];
      const diffAnnotations: DiffLineAnnotation<ViewerAnnotation>[] = [];
      const markdownComments: Array<{
        comment: AnyReviewComment;
        placement: CommentPlacement;
      }> = [];
      const imageComments: {
        old: Array<{ comment: AnyReviewComment; placement: CommentPlacement }>;
        new: Array<{ comment: AnyReviewComment; placement: CommentPlacement }>;
      } = { old: [], new: [] };
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
            if (!candidate.ref || !commentCanTargetDocument(comment, candidate.ref)) continue;
            const placement = await loadPlacement(comment, candidate.ref);
            if (!placement.outdated && placement.path === candidate.ref.path) {
              imageComments[candidate.side].push({ comment, placement });
              break;
            }
          }
        }
        return { fileAnnotations, diffAnnotations, markdownComments, imageComments };
      }
      for (const comment of comments) {
        let added = false;
        if (renderedRefs.new && commentCanTargetDocument(comment, renderedRefs.new)) {
          const placement = await loadPlacement(comment, renderedRefs.new);
          if (
            !placement.outdated &&
            placement.path === reviewDocumentPath(renderedRefs.new, activeDocument)
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
        if (!added && renderedRefs.old && commentCanTargetDocument(comment, renderedRefs.old)) {
          const placement = await loadPlacement(comment, renderedRefs.old);
          if (
            !placement.outdated &&
            placement.path === reviewDocumentPath(renderedRefs.old, activeDocument)
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
      await api<{ comment: AnyReviewComment }>(
        "/api/comments",
        jsonRequest({
          ...reviewCommentPayload(review),
          target,
          body,
          authorLabel: "You",
        }),
      ),
    onSuccess: async ({ comment }, { target, location }) => {
      window.getSelection()?.removeAllRanges();
      const range =
        target.kind !== "pull-request" && target.startLine !== null && target.endLine !== null
          ? { startLine: target.startLine, endLine: target.endLine }
          : null;
      const path =
        target.kind === "pull-request"
          ? null
          : target.kind === "issue"
            ? documentPath
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
      setSelectionDocumentRevision(null);
      setSelectionPreview(null);
      setMarkdownComposerOpen(false);
      setFileComposerOpen(false);
      await queryClient.invalidateQueries({ queryKey: reviewQueryKeys.allComments() });
      await queryClient.invalidateQueries({ queryKey: reviewQueryKeys.changeSequence() });
    },
  });

  const navigationRequestId = navigationTarget?.requestId ?? null;
  useLayoutEffect(() => {
    if (navigationRequestId === null) return;
    setBody("");
    setSelection(null);
    setSelectionDocumentRevision(null);
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
  const revisionBoundSelection =
    activeDocument.kind === "issue" ||
    (review.kind === "repository" &&
      activeDocument.kind === "repository-file" &&
      activeDocument.sourceOid === undefined);
  const selectionIsStale =
    revisionBoundSelection && selection !== null && selectionDocumentRevision !== documentRevision;
  const canSubmitSelection =
    selection !== null &&
    !selectionIsStale &&
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
        : selectedRef.kind === "issue-markdown"
          ? {
              kind: "issue" as const,
              issue: activeDocument.kind === "issue" ? activeDocument.url : "",
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
    setSelectionDocumentRevision(null);
    setSelectionPreview(null);
    setMarkdownComposerOpen(false);
    setFileComposerOpen(false);
  };
  const resetCreateMutation = createMutation.reset;
  const handleLineSelectionStart = useCallback(
    (range: SelectedLineRange | null): void => {
      resetCreateMutation();
      if (!revisionBoundSelection || selectionDocumentRevision === documentRevision) {
        setBody("");
      }
      setSelection(null);
      setSelectionPreview(range);
      setMarkdownComposerOpen(false);
      if (range) {
        setFileComposerOpen(false);
      }
    },
    [documentRevision, resetCreateMutation, revisionBoundSelection, selectionDocumentRevision],
  );
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null): void => {
      resetCreateMutation();
      if (!revisionBoundSelection || selectionDocumentRevision === documentRevision) {
        setBody("");
      }
      setSelection(range);
      setSelectionDocumentRevision(range ? documentRevision : null);
      setSelectionPreview(null);
      setMarkdownComposerOpen(false);
      if (range) {
        setFileComposerOpen(false);
      }
    },
    [documentRevision, resetCreateMutation, revisionBoundSelection, selectionDocumentRevision],
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
      loadedOptimisticCommentId.current !== optimisticComment.comment.id &&
      !placed.some(({ comment }) => comment.id === optimisticComment.comment.id)
    ) {
      placed.push({
        comment: optimisticComment.comment,
        placement: optimisticComment.placement,
      });
    }
    return placed;
  }, [annotationQuery.data?.markdownComments, optimisticComment]);
  const repositoryImageComments = useMemo(() => {
    const placed = {
      old: [...(annotationQuery.data?.imageComments.old ?? [])],
      new: [...(annotationQuery.data?.imageComments.new ?? [])],
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
  }, [annotationQuery.data?.imageComments, optimisticComment]);
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
  const renderedReviewMarkdown = useMemo(
    () =>
      markdownText === null
        ? null
        : renderReviewMarkdown({
            text: markdownText,
            pullRequestMarkdown:
              activeDocument.kind === "pull-request-markdown" || activeDocument.kind === "issue",
            annotations: markdownCommentAnnotations,
            activeCommentId,
            selectedRange:
              composerStartLine === null || composerEndLine === null
                ? null
                : { startLine: composerStartLine, endLine: composerEndLine },
            navigationRange: navigationSelection
              ? { startLine: navigationSelection.start, endLine: navigationSelection.end }
              : null,
            composerOpen: markdownComposerOpen,
            markdownDiv,
            sourceRef: fullRef,
            selectedOid,
            review,
            linkPointerStart: markdownLinkPointerStart,
            onOpenRepositoryLink: openRepositoryLink,
            onOpenMarkdownFragment: openMarkdownFragment,
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
      navigationSelection,
      openMarkdownFragment,
      openRepositoryLink,
      review,
      selectedOid,
    ],
  );
  useLayoutEffect(() => {
    if (
      !showingMarkdownPreview ||
      !navigationTarget ||
      navigationTarget.line === null ||
      appliedNavigationRequest.current === navigationTarget.requestId ||
      renderedReviewMarkdown === null
    ) {
      return;
    }
    const requestId = navigationTarget.requestId;
    const frame = window.requestAnimationFrame(() => {
      const target = diffSurfaceRef.current?.querySelector<HTMLElement>(
        `[data-rvw-source-start-line="${navigationTarget.line}"]`,
      );
      if (!target) return;
      target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
      appliedNavigationRequest.current = requestId;
      navigationAppliedRef.current(requestId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationTarget, renderedReviewMarkdown, showingMarkdownPreview]);
  const wholeDocumentCommentLabel =
    activeDocument.kind === "issue" ? "Issue全体へコメント" : "ファイル全体へコメント";
  const activeSelection = fileComposerOpen
    ? null
    : (selectionPreview ?? selection ?? navigationSelection);
  const fileCommentButton = (
    <button
      className="comment-icon-button diff-header-comment-button"
      aria-label={wholeDocumentCommentLabel}
      title={wholeDocumentCommentLabel}
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
  const selectedPathLabel = selectedLineRef
    ? reviewDocumentPath(selectedLineRef, activeDocument)
    : documentPath;
  const selectedSideLabel =
    effectiveDisplayMode === "full"
      ? null
      : selection?.side === "deletions" || selection?.endSide === "deletions"
        ? "変更前"
        : "変更後";
  const selectionLabel = selection
    ? `${[selectedPathLabel, selectedSideLabel, selectedRangeLabel].filter(Boolean).join(" · ")}へコメント`
    : "選択範囲へコメント";
  const selectionValidationError = selectionIsStale
    ? activeDocument.kind === "issue"
      ? "Issue本文が更新されました。draftは保持されています。現在の本文で範囲を選び直してください。"
      : "Repository sourceが更新されました。draftは保持されています。現在のsourceで範囲を選び直してください。"
    : selection?.side && selection.endSide && selection.side !== selection.endSide
      ? "old/newをまたぐ選択にはコメントできません。"
      : undefined;
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
        validationError={selectionValidationError}
        placement="line"
        onBodyChange={setBody}
        onCancel={closeComposer}
        onSubmit={() => create("line")}
      />
    );
  };
  const markdownPath =
    activeDocument.kind === "repository-file"
      ? activeDocument.path
      : activeDocument.kind === "issue"
        ? `#${activeDocument.number} ${activeDocument.title}`
        : "Pull Request.md";
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
                    ? reviewMarkdownAssetUrl(
                        review,
                        repositoryImageRefs.old.sourceOid,
                        repositoryImageRefs.old.path,
                      )
                    : null,
                emptyMessage: oldPath
                  ? "変更前は対応画像ではありません。"
                  : "変更前の画像はありません。",
                action: repositoryImageRefs.new ? null : fileCommentButton,
                comments: repositoryImageCommentNodes("old", "deletions"),
              }
        }
        newSide={{
          label: effectiveDisplayMode === "full" ? "全文" : "変更後",
          path: effectiveDisplayMode === "full" ? activeDocument.path : newPath,
          sourceUrl:
            repositoryImageRefs.new?.kind === "repository-file" &&
            isSupportedImagePath(repositoryImageRefs.new.path)
              ? reviewMarkdownAssetUrl(
                  review,
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
          action: repositoryImageRefs.new ? fileCommentButton : null,
          comments: repositoryImageCommentNodes(
            "new",
            effectiveDisplayMode === "full" ? null : "additions",
          ),
        }}
      />
    ) : null;
  return (
    <div className="document-viewer">
      <ErrorNotice error={annotationQuery.error} />
      {markdownCapable && effectiveDisplayMode === "full" && (
        <div className="markdown-view-toolbar" aria-label="Markdown表示">
          <span>
            <FileEntryIcon path={markdownPath} kind="file" />
            {activeDocument.kind === "issue" ? (
              <a
                className="markdown-document-link"
                href={activeDocument.url}
                target="_blank"
                rel="noopener noreferrer"
                title="GitHub Issueを開く"
              >
                <code>{markdownPath}</code>
              </a>
            ) : (
              <code>{markdownPath}</code>
            )}
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
          label={wholeDocumentCommentLabel}
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
        {repositoryImageSurface ? (
          repositoryImageSurface
        ) : showingMarkdownPreview ? (
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
                  const nextSelection = range
                    ? { start: range.startLine, end: range.endLine }
                    : null;
                  const keepsReselectedDraft =
                    nextSelection !== null &&
                    selection !== null &&
                    nextSelection.start === selection.start &&
                    nextSelection.end === selection.end;
                  if (!selectionIsStale && !keepsReselectedDraft) setBody("");
                  setSelection(nextSelection);
                  setSelectionDocumentRevision(range ? documentRevision : null);
                  setSelectionPreview(null);
                  setMarkdownComposerOpen(false);
                  if (range) setFileComposerOpen(false);
                }}
                onOpenComposer={() => setMarkdownComposerOpen(true)}
                composer={
                  <InlineCommentComposer
                    body={body}
                    label={selectionLabel}
                    disabled={!canSubmitSelection}
                    pending={createMutation.isPending}
                    error={createMutation.error}
                    validationError={selectionValidationError}
                    placement="line"
                    onBodyChange={setBody}
                    onCancel={closeComposer}
                    onSubmit={() => create("line")}
                  />
                }
              >
                <article>{renderedReviewMarkdown}</article>
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
