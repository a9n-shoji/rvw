import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Children,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type {
  CommentPlacement,
  CodeReference,
  ReviewComment,
  Walkthrough,
  WalkthroughReference,
} from "../../domain/models.js";
import { walkthroughHtmlPreviewSourceRanges } from "../../shared/walkthrough-html.js";
import {
  api,
  type DeleteWalkthroughResponse,
  jsonRequest,
  resolveCommentPlacements,
} from "../api.js";
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
import type { DocumentPaneId } from "../document-workspace.js";
import { mermaidBindingTargets } from "../mermaid-binding-resolver.js";
import { commentReplyDraftScope } from "../comment-draft-store.js";
import { cancelCommentQuery, putCommentInCache } from "../comment-query-cache.js";
import type { ViewerNavigationTarget } from "./DocumentViewer.js";
import { CommentIcon, InlineCommentComposer } from "./CommentComposer.js";
import { CommentThread } from "./CommentThread.js";
import { ErrorNotice } from "./ErrorNotice.js";
import {
  CodeReferenceLink,
  codeReferenceIdFromHref,
  codeReferenceMarkdownSanitizeSchema,
} from "./CodeReferenceLink.js";
import { MarkdownImagePlaceholder } from "./MarkdownImagePlaceholder.js";
import { PreviewMarkdownTable } from "./MarkdownTable.js";
import { MermaidDiagram as ExpandableMermaidDiagram } from "./MermaidDiagram.js";
import type {
  MermaidCodeReferenceOpen,
  MermaidReferencePeekResolution,
} from "./MermaidExpandedView.js";
import { MermaidSurface } from "./MermaidSurface.js";
import { WalkthroughHtmlPreview } from "./WalkthroughHtmlPreview.js";
import { WalkthroughIcon } from "./WalkthroughPanel.js";

const referenceNoticeDurationMs = 2400;
function codeText(content: ReactNode): string {
  return Children.toArray(content)
    .map((part) => {
      if (typeof part === "string" || typeof part === "number") return String(part);
      return isValidElement<{ children?: ReactNode }>(part) ? codeText(part.props.children) : "";
    })
    .join("");
}

function sameRange(left: MarkdownSourceRange | null, right: MarkdownSourceRange | null): boolean {
  return Boolean(
    left && right && left.startLine === right.startLine && left.endLine === right.endLine,
  );
}

function DeleteIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
      <path
        fill="currentColor"
        d="M5.5 1.75A1.75 1.75 0 0 1 7.25 0h1.5a1.75 1.75 0 0 1 1.75 1.75V2h3a.75.75 0 0 1 0 1.5h-.64l-.68 10.03A2.5 2.5 0 0 1 9.69 16H6.31a2.5 2.5 0 0 1-2.49-2.47L3.14 3.5H2.5a.75.75 0 0 1 0-1.5h3v-.25Zm1.5 0V2h2v-.25a.25.25 0 0 0-.25-.25h-1.5a.25.25 0 0 0-.25.25ZM4.65 3.5l.67 9.96c.02.58.46 1.04.99 1.04h3.38c.53 0 .97-.46.99-1.04l.67-9.96h-6.7Z"
      />
    </svg>
  );
}

function WalkthroughMermaidDiagram({
  source,
  sourceRange,
  commented,
  bindings,
  references,
  themePreference,
  onOpenReference,
  onCommentRange,
  commentComposer,
  reviewContext,
}: {
  source: string;
  sourceRange: MarkdownSourceRange | null;
  commented: boolean;
  bindings: Record<string, string>;
  references: ReadonlyMap<string, WalkthroughReference>;
  themePreference: ThemePreference;
  onOpenReference: (reference: WalkthroughReference, openInRightPane: boolean) => void;
  onCommentRange: (range: MarkdownSourceRange) => void;
  commentComposer: ReactNode;
  reviewContext: MermaidMarkdownRenderContext;
}) {
  const commentComposerRef = useRef<HTMLDivElement>(null);
  const composerOpen = Boolean(commentComposer);
  const [expandedComposerOpen, setExpandedComposerOpen] = useState(false);
  const [expandedCommentBody, setExpandedCommentBody] = useState("");
  useLayoutEffect(() => {
    if (!composerOpen) return;
    const frame = window.requestAnimationFrame(() => {
      commentComposerRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [composerOpen]);
  const referenceFromTarget = useCallback(
    (target: EventTarget | null): WalkthroughReference | undefined => {
      if (!(target instanceof Element)) return undefined;
      const node = target.closest<SVGGElement>("[data-walkthrough-reference-id]");
      const referenceId = node?.dataset.walkthroughReferenceId;
      return referenceId ? references.get(referenceId) : undefined;
    },
    [references],
  );

  const prepareSvg = useCallback(
    (container: HTMLDivElement): void => {
      for (const { bindingKey, element } of mermaidBindingTargets(
        source,
        container,
        Object.keys(bindings),
      )) {
        const referenceId = bindings[bindingKey];
        const reference = referenceId ? references.get(referenceId) : undefined;
        if (!reference) continue;
        element.classList.add("walkthrough-diagram-node--linked");
        element.setAttribute("role", "button");
        element.setAttribute("tabindex", "0");
        element.setAttribute("aria-label", `${reference.label}をコードで開く`);
        element.dataset.walkthroughReferenceId = reference.id;
      }
    },
    [bindings, references, source],
  );

  const diagramComments = sourceRange
    ? reviewContext.placedComments.filter(({ placement }) =>
        sameRange(placement.range, sourceRange),
      )
    : [];
  const review = sourceRange
    ? {
        pullRequestId: reviewContext.pullRequestId,
        commentCount: diagramComments.length,
        onOpenCodeReference: reviewContext.onOpenCommentCodeReference,
        diagramReferenceBindings: {
          sourceOid: reviewContext.sourceOid,
          onRendered: prepareSvg,
          referenceFromTarget,
          resolveForPeek: reviewContext.onResolveReferenceForPeek,
          onOpenInReview: onOpenReference,
        },
        renderComments: (openReference: MermaidCodeReferenceOpen) => (
          <div className="mermaid-diagram-comments">
            {diagramComments.length === 0 && !expandedComposerOpen && (
              <p className="mermaid-comments-empty">この diagram へのコメントはありません。</p>
            )}
            {diagramComments.map(({ comment, placement }) => (
              <CommentThread
                key={comment.id}
                comment={comment}
                variant="sidebar"
                draftScope={`${reviewContext.draftScope}:mermaid:${sourceRange.startLine}-${sourceRange.endLine}`}
                placement={placement}
                markdownSourceOid={reviewContext.sourceOid}
                themePreference={themePreference}
                cancelDraftOnEscape
                onActiveChange={reviewContext.onCommentActiveChange}
                onOpenCodeReference={openReference}
                onOpenRepositoryLink={reviewContext.onOpenRepositoryLink}
              />
            ))}
            {expandedComposerOpen ? (
              <InlineCommentComposer
                body={expandedCommentBody}
                label="Comment on diagram"
                pending={reviewContext.diagramCommentPending}
                error={reviewContext.diagramCommentError}
                validationError={undefined}
                placement="line"
                onBodyChange={setExpandedCommentBody}
                onCancel={() => {
                  setExpandedComposerOpen(false);
                  setExpandedCommentBody("");
                  reviewContext.onCancelDiagramComment();
                }}
                onSubmit={() => {
                  void reviewContext
                    .onCreateExpandedDiagramComment(sourceRange, expandedCommentBody)
                    .then(() => {
                      setExpandedComposerOpen(false);
                      setExpandedCommentBody("");
                    })
                    .catch(() => undefined);
                }}
              />
            ) : (
              <button
                className="mermaid-comment-action"
                onClick={() => {
                  reviewContext.onCancelDiagramComment();
                  setExpandedComposerOpen(true);
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
    <ExpandableMermaidDiagram
      source={source}
      themePreference={themePreference}
      renderIdPrefix="rvwWalkthrough"
      review={review}
      renderInline={(expandButton) => (
        <div
          className={`walkthrough-diagram-shell${commented ? " has-comment" : ""}`}
          {...(sourceRange
            ? {
                "data-rvw-navigation-start-line": sourceRange.startLine,
                "data-rvw-navigation-end-line": sourceRange.endLine,
              }
            : {})}
        >
          <div className="walkthrough-diagram-toolbar">
            <span>Mermaid diagram</span>
            <span>強調された要素を選択してコードを開く · Cmd/Ctrlで反対のペイン</span>
            {sourceRange && (
              <button
                className="button--quiet walkthrough-diagram-comment"
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  onCommentRange(sourceRange);
                }}
                onClick={(event) => {
                  if (event.detail === 0) onCommentRange(sourceRange);
                }}
              >
                <CommentIcon />
                図全体へコメント
              </button>
            )}
            {expandButton}
          </div>
          <MermaidSurface
            className="walkthrough-diagram"
            source={source}
            themePreference={themePreference}
            renderIdPrefix="rvwWalkthrough"
            errorClassName="walkthrough-diagram-error"
            onRendered={prepareSvg}
            onPointerDown={(event) => {
              const reference = referenceFromTarget(event.target);
              if (!reference) return;
              event.preventDefault();
              event.stopPropagation();
              onOpenReference(reference, event.metaKey || event.ctrlKey);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              const reference = referenceFromTarget(event.target);
              if (!reference) return;
              event.preventDefault();
              onOpenReference(reference, false);
            }}
          />
          {commentComposer && (
            <div className="walkthrough-diagram-comment-composer" ref={commentComposerRef}>
              {commentComposer}
            </div>
          )}
        </div>
      )}
    />
  );
}

interface MermaidMarkdownRenderContext {
  pullRequestId: string;
  sourceOid: string;
  diagramBindings: Record<string, string>;
  references: ReadonlyMap<string, WalkthroughReference>;
  placedComments: Array<{ comment: ReviewComment; placement: CommentPlacement }>;
  activeCommentId: string | null;
  navigationLine: number | null;
  diagramCommentRange: MarkdownSourceRange | null;
  themePreference: ThemePreference;
  onOpenReference: (reference: WalkthroughReference, openInRightPane: boolean) => void;
  onResolveReferenceForPeek: (
    reference: WalkthroughReference,
  ) => Promise<MermaidReferencePeekResolution>;
  onOpenCommentCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onActivateComment: (commentId: string) => void;
  onCommentRange: (range: MarkdownSourceRange) => void;
  diagramCommentPending: boolean;
  diagramCommentError: unknown;
  onCancelDiagramComment: () => void;
  onSubmitDiagramComment: (range: MarkdownSourceRange, body: string) => void;
  onCreateExpandedDiagramComment: (range: MarkdownSourceRange, body: string) => Promise<void>;
  draftScope: string;
}

const MermaidMarkdownRenderContext = createContext<MermaidMarkdownRenderContext | null>(null);

function WalkthroughDiagramCommentComposer({
  range,
  label,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  range: MarkdownSourceRange;
  label?: string;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const composerLabel =
    label ??
    (range.startLine === range.endLine
      ? `L${range.startLine}へコメント`
      : `L${range.startLine}–${range.endLine}へコメント`);
  return (
    <InlineCommentComposer
      body={body}
      label={composerLabel}
      pending={pending}
      error={error}
      validationError={undefined}
      placement="line"
      onBodyChange={setBody}
      onCancel={onCancel}
      onSubmit={() => onSubmit(body)}
    />
  );
}

const WalkthroughMarkdownPre: NonNullable<Components["pre"]> = ({ children, node, ...props }) => {
  const context = useContext(MermaidMarkdownRenderContext);
  const child =
    Children.count(children) === 1
      ? (Children.only(children) as ReactElement<{
          className?: string;
          children?: ReactNode;
        }>)
      : null;
  if (!context || !isValidElement(child)) {
    return <pre {...props}>{children}</pre>;
  }
  const sourceRange = markdownNodeSourceRange(node);
  if (child.props.className === "language-html-preview" && sourceRange) {
    const previewCommentRange =
      context.diagramCommentRange &&
      context.diagramCommentRange.startLine >= sourceRange.startLine &&
      context.diagramCommentRange.endLine <= sourceRange.endLine
        ? context.diagramCommentRange
        : null;
    return (
      <WalkthroughHtmlPreview
        source={codeText(child.props.children).replace(/\n$/u, "")}
        fenceRange={sourceRange}
        pullRequestId={context.pullRequestId}
        sourceOid={context.sourceOid}
        references={context.references}
        placedComments={context.placedComments}
        activeCommentId={context.activeCommentId}
        navigationLine={context.navigationLine}
        themePreference={context.themePreference}
        onOpenReference={context.onOpenReference}
        onOpenRepositoryLink={context.onOpenRepositoryLink}
        onCommentRange={context.onCommentRange}
        onActivateComment={context.onActivateComment}
        commentComposer={(label) =>
          previewCommentRange ? (
            <WalkthroughDiagramCommentComposer
              key={`${previewCommentRange.startLine}:${previewCommentRange.endLine}`}
              range={previewCommentRange}
              label={label}
              pending={context.diagramCommentPending}
              error={context.diagramCommentError}
              onCancel={context.onCancelDiagramComment}
              onSubmit={(body) => context.onSubmitDiagramComment(previewCommentRange, body)}
            />
          ) : null
        }
      />
    );
  }
  if (child.props.className !== "language-mermaid") {
    return <pre {...props}>{children}</pre>;
  }
  return (
    <WalkthroughMermaidDiagram
      source={codeText(child.props.children).trim()}
      sourceRange={sourceRange}
      commented={Boolean(
        sourceRange &&
        context.activeCommentId &&
        context.placedComments.some(
          ({ comment, placement }) =>
            comment.id === context.activeCommentId &&
            placement.range &&
            placement.range.startLine <= sourceRange.endLine &&
            placement.range.endLine >= sourceRange.startLine,
        ),
      )}
      bindings={context.diagramBindings}
      references={context.references}
      themePreference={context.themePreference}
      onOpenReference={context.onOpenReference}
      onCommentRange={context.onCommentRange}
      commentComposer={
        sourceRange && sameRange(sourceRange, context.diagramCommentRange) ? (
          <WalkthroughDiagramCommentComposer
            key={`${sourceRange.startLine}:${sourceRange.endLine}`}
            range={sourceRange}
            pending={context.diagramCommentPending}
            error={context.diagramCommentError}
            onCancel={context.onCancelDiagramComment}
            onSubmit={(body) => context.onSubmitDiagramComment(sourceRange, body)}
          />
        ) : null
      }
      reviewContext={context}
    />
  );
};

const WalkthroughMarkdown = memo(function WalkthroughMarkdown({
  pullRequestId,
  body,
  diagramBindings,
  references,
  placedComments,
  activeCommentId,
  navigationLine,
  selectedRange,
  selectionComposerOpen,
  diagramCommentRange,
  markdownSourceOid,
  draftScope,
  themePreference,
  onOpenReference,
  onResolveReferenceForPeek,
  onOpenCommentCodeReference,
  onOpenRepositoryLink,
  onCommentActiveChange,
  onActivateComment,
  onCommentRange,
  diagramCommentPending,
  diagramCommentError,
  onCancelDiagramComment,
  onSubmitDiagramComment,
  onCreateExpandedDiagramComment,
}: {
  pullRequestId: string;
  body: string;
  diagramBindings: Record<string, string>;
  references: ReadonlyMap<string, WalkthroughReference>;
  placedComments: Array<{ comment: ReviewComment; placement: CommentPlacement }>;
  activeCommentId: string | null;
  navigationLine: number | null;
  selectedRange: MarkdownSourceRange | null;
  selectionComposerOpen: boolean;
  diagramCommentRange: MarkdownSourceRange | null;
  markdownSourceOid: string;
  draftScope: string;
  themePreference: ThemePreference;
  onOpenReference: (reference: WalkthroughReference, openInRightPane: boolean) => void;
  onResolveReferenceForPeek: (
    reference: WalkthroughReference,
  ) => Promise<MermaidReferencePeekResolution>;
  onOpenCommentCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onActivateComment: (commentId: string) => void;
  onCommentRange: (range: MarkdownSourceRange) => void;
  diagramCommentPending: boolean;
  diagramCommentError: unknown;
  onCancelDiagramComment: () => void;
  onSubmitDiagramComment: (range: MarkdownSourceRange, body: string) => void;
  onCreateExpandedDiagramComment: (range: MarkdownSourceRange, body: string) => Promise<void>;
}) {
  const htmlPreviewRanges = useMemo(() => walkthroughHtmlPreviewSourceRanges(body), [body]);
  const markdownPlacedComments = useMemo(
    () =>
      placedComments.filter(({ placement }) => {
        const range = placement.range;
        return !(
          range &&
          htmlPreviewRanges.some(
            (previewRange) =>
              range.startLine >= previewRange.startLine && range.endLine <= previewRange.endLine,
          )
        );
      }),
    [htmlPreviewRanges, placedComments],
  );
  const annotations = useMemo<MarkdownCommentAnnotation[]>(
    () =>
      markdownPlacedComments.map(({ comment, placement }) => ({
        id: comment.id,
        range: placement.range,
      })),
    [markdownPlacedComments],
  );
  const commentsById = useMemo(
    () =>
      new Map(
        markdownPlacedComments.map(({ comment, placement }) => [
          comment.id,
          { comment, placement },
        ]),
      ),
    [markdownPlacedComments],
  );
  const markdownDiv: NonNullable<Components["div"]> = useCallback(
    ({ node, children, ...props }: ComponentPropsWithoutRef<"div"> & { node?: unknown }) => {
      const commentIds = markdownCommentAnchorIds(node);
      if (commentIds.length === 0) return <div {...props}>{children}</div>;
      return (
        <div className="markdown-inline-comments">
          {commentIds.map((commentId) => {
            const annotation = commentsById.get(commentId);
            return annotation ? (
              <CommentThread
                key={commentId}
                comment={annotation.comment}
                variant="inline"
                draftScope={draftScope}
                placement={annotation.placement}
                markdownSourceOid={markdownSourceOid}
                themePreference={themePreference}
                onActiveChange={onCommentActiveChange}
                onOpenCodeReference={onOpenCommentCodeReference}
                onOpenRepositoryLink={onOpenRepositoryLink}
              />
            ) : null;
          })}
        </div>
      );
    },
    [
      commentsById,
      draftScope,
      markdownSourceOid,
      onCommentActiveChange,
      onOpenCommentCodeReference,
      onOpenRepositoryLink,
      themePreference,
    ],
  );
  return (
    <MermaidMarkdownRenderContext.Provider
      value={{
        pullRequestId,
        sourceOid: markdownSourceOid,
        diagramBindings,
        references,
        placedComments,
        activeCommentId,
        navigationLine,
        diagramCommentRange,
        themePreference,
        onOpenReference,
        onResolveReferenceForPeek,
        onOpenCommentCodeReference,
        onOpenRepositoryLink,
        onCommentActiveChange,
        onActivateComment,
        onCommentRange,
        diagramCommentPending,
        diagramCommentError,
        onCancelDiagramComment,
        onSubmitDiagramComment,
        onCreateExpandedDiagramComment,
        draftScope,
      }}
    >
      <article className="walkthrough-markdown">
        <ReactMarkdown
          rehypePlugins={[
            rehypeRaw,
            [rehypeSanitize, codeReferenceMarkdownSanitizeSchema],
            [
              rehypeRvwSourceMap,
              {
                annotations,
                activeCommentId,
                selectedRange,
                composerOpen: selectionComposerOpen,
              },
            ],
          ]}
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) => (url.startsWith("rvw-ref:") ? url : defaultUrlTransform(url))}
          components={{
            div: markdownDiv,
            table: PreviewMarkdownTable,
            a: ({ href, children, node: _node, ...props }) => {
              const referenceId = codeReferenceIdFromHref(href);
              const reference = referenceId ? references.get(referenceId) : undefined;
              return reference ? (
                <CodeReferenceLink
                  reference={reference}
                  className="walkthrough-inline-reference"
                  onOpen={onOpenReference}
                >
                  {children}
                </CodeReferenceLink>
              ) : (
                <a {...markdownSourceDataAttributes(_node)} {...props} href={href}>
                  {children}
                </a>
              );
            },
            img: ({ alt, title, node }) => (
              <MarkdownImagePlaceholder
                alt={alt}
                title={title}
                sourceAttributes={markdownSourceDataAttributes(node)}
              />
            ),
            pre: WalkthroughMarkdownPre,
          }}
        >
          {body}
        </ReactMarkdown>
      </article>
    </MermaidMarkdownRenderContext.Provider>
  );
});

export function WalkthroughViewer({
  walkthrough,
  paneId,
  comments,
  activeCommentId,
  navigationTarget,
  onNavigationApplied,
  themePreference,
  onCommentActiveChange,
  onActivateComment,
  onOpenReference,
  onResolveReferenceForPeek,
  onOpenCommentCodeReference,
  onOpenRepositoryLink,
  onDeleted,
}: {
  walkthrough: Walkthrough;
  paneId: DocumentPaneId;
  comments: ReviewComment[];
  activeCommentId: string | null;
  navigationTarget?: ViewerNavigationTarget | null;
  onNavigationApplied: (requestId: number) => void;
  themePreference: ThemePreference;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onActivateComment: (commentId: string) => void;
  onOpenReference: (
    walkthrough: Walkthrough,
    reference: WalkthroughReference,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onResolveReferenceForPeek: (
    walkthrough: Walkthrough,
    reference: WalkthroughReference,
  ) => Promise<MermaidReferencePeekResolution>;
  onOpenCommentCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
  onDeleted: (walkthrough: Walkthrough) => void;
}) {
  const queryClient = useQueryClient();
  const replyDraftScope = commentReplyDraftScope(paneId, {
    kind: "walkthrough",
    id: walkthrough.id,
    title: walkthrough.title,
    sourceOid: walkthrough.sourceOid,
  });
  const viewerRef = useRef<HTMLDivElement>(null);
  const appliedNavigationRequest = useRef<number | null>(null);
  const navigationAppliedRef = useRef(onNavigationApplied);
  navigationAppliedRef.current = onNavigationApplied;
  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedRange, setSelectedRange] = useState<MarkdownSourceRange | null>(null);
  const [diagramRange, setDiagramRange] = useState<MarkdownSourceRange | null>(null);
  const [lineComposerPlacement, setLineComposerPlacement] = useState<
    "selection" | "diagram" | null
  >(null);
  const [commentBody, setCommentBody] = useState("");
  const [referenceNotice, setReferenceNotice] = useState<string | null>(null);
  const referenceRequestSequence = useRef(0);
  const referenceNoticeTimeout = useRef<number | null>(null);
  const walkthroughRef = useRef(walkthrough);
  walkthroughRef.current = walkthrough;
  const viewerCallbacksRef = useRef({
    onOpenReference,
    onResolveReferenceForPeek,
    onOpenCommentCodeReference,
    onOpenRepositoryLink,
    onCommentActiveChange,
    onActivateComment,
  });
  viewerCallbacksRef.current = {
    onOpenReference,
    onResolveReferenceForPeek,
    onOpenCommentCodeReference,
    onOpenRepositoryLink,
    onCommentActiveChange,
    onActivateComment,
  };
  const references = useMemo(
    () => new Map(walkthrough.references.map((reference) => [reference.id, reference])),
    [walkthrough.references],
  );
  useLayoutEffect(() => {
    if (!navigationTarget || appliedNavigationRequest.current === navigationTarget.requestId) {
      return;
    }
    const requestId = navigationTarget.requestId;
    const frame = window.requestAnimationFrame(() => {
      const root = viewerRef.current;
      if (!root) return;
      if (navigationTarget.line === null) {
        root.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
        appliedNavigationRequest.current = requestId;
        navigationAppliedRef.current(requestId);
        return;
      }
      const line = String(navigationTarget.line);
      const target =
        root.querySelector<HTMLElement>(`[data-rvw-navigation-start-line="${line}"]`) ??
        root.querySelector<HTMLElement>(`[data-rvw-source-start-line="${line}"]`) ??
        [...root.querySelectorAll<HTMLElement>("[data-rvw-navigation-start-line]")].find(
          (candidate) => {
            const startLine = Number(candidate.dataset.rvwNavigationStartLine);
            const endLine = Number(candidate.dataset.rvwNavigationEndLine);
            return startLine <= navigationTarget.line! && endLine >= navigationTarget.line!;
          },
        );
      const collapsedDetails = target?.closest<HTMLDetailsElement>("details:not([open])");
      if (collapsedDetails) collapsedDetails.open = true;
      if (!target) return;
      target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
      appliedNavigationRequest.current = requestId;
      navigationAppliedRef.current(requestId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationTarget]);
  const openReference = useCallback(
    (reference: WalkthroughReference, openInRightPane: boolean): void => {
      referenceRequestSequence.current += 1;
      const requestSequence = referenceRequestSequence.current;
      if (referenceNoticeTimeout.current !== null) {
        window.clearTimeout(referenceNoticeTimeout.current);
        referenceNoticeTimeout.current = null;
      }
      setReferenceNotice(null);
      void viewerCallbacksRef.current
        .onOpenReference(walkthroughRef.current, reference, openInRightPane)
        .then((notice) => {
          if (requestSequence !== referenceRequestSequence.current || !notice) return;
          setReferenceNotice(notice);
          referenceNoticeTimeout.current = window.setTimeout(() => {
            setReferenceNotice(null);
            referenceNoticeTimeout.current = null;
          }, referenceNoticeDurationMs);
        });
    },
    [],
  );
  const resolveReferenceForPeek = useCallback(
    (reference: WalkthroughReference) =>
      viewerCallbacksRef.current.onResolveReferenceForPeek(walkthroughRef.current, reference),
    [],
  );
  const openCommentCodeReference = useCallback(
    (sourceOid: string, reference: CodeReference, openInRightPane: boolean) =>
      viewerCallbacksRef.current.onOpenCommentCodeReference(sourceOid, reference, openInRightPane),
    [],
  );
  const openRepositoryLink = useCallback(
    (path: string, sourceOid: string, openInRightPane: boolean): void =>
      viewerCallbacksRef.current.onOpenRepositoryLink(path, sourceOid, openInRightPane),
    [],
  );
  const changeCommentActive = useCallback(
    (commentId: string, active: boolean): void =>
      viewerCallbacksRef.current.onCommentActiveChange(commentId, active),
    [],
  );
  const activateComment = useCallback(
    (commentId: string): void => viewerCallbacksRef.current.onActivateComment(commentId),
    [],
  );
  useEffect(
    () => () => {
      referenceRequestSequence.current += 1;
      if (referenceNoticeTimeout.current !== null) {
        window.clearTimeout(referenceNoticeTimeout.current);
      }
    },
    [],
  );
  const walkthroughComments = useMemo(
    () =>
      comments.filter(
        (comment) =>
          comment.target.kind === "walkthrough" && comment.target.walkthroughId === walkthrough.id,
      ),
    [comments, walkthrough.id],
  );
  const associatedPostCount = walkthroughComments.reduce(
    (count, comment) => count + comment.posts.length,
    0,
  );
  const placementQuery = useQuery({
    queryKey: [
      "walkthrough-comment-placements",
      walkthrough.id,
      walkthrough.body,
      walkthroughComments.map((comment) => [comment.id, comment.target]),
    ],
    queryFn: async () =>
      await resolveCommentPlacements(
        walkthrough.pullRequestId,
        walkthroughComments.map(({ id }) => id),
        [{ kind: "walkthrough", walkthroughId: walkthrough.id }],
      ),
    enabled: walkthroughComments.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const placedComments = useMemo(() => {
    const placements = new Map(
      placementQuery.data?.comments.map(({ commentId, placements: resolved }) => [
        commentId,
        resolved[0]?.placement,
      ]) ?? [],
    );
    return walkthroughComments.flatMap((comment) => {
      const placement = placements.get(comment.id);
      return placement ? [{ comment, placement }] : [];
    });
  }, [placementQuery.data, walkthroughComments]);
  const markdownComments = useMemo(
    () => placedComments.filter(({ placement }) => !placement.outdated && placement.range !== null),
    [placedComments],
  );
  const headerComments = useMemo(
    () =>
      placedComments.filter(
        ({ comment, placement }) =>
          (comment.target.kind === "walkthrough" && comment.target.startLine === null) ||
          placement.outdated,
      ),
    [placedComments],
  );
  const createComment = useMutation({
    mutationFn: async ({ range, body }: { range: MarkdownSourceRange | null; body: string }) =>
      await api<{ comment: ReviewComment }>(
        "/api/comments",
        jsonRequest({
          pullRequestId: walkthrough.pullRequestId,
          target: {
            kind: "walkthrough",
            walkthroughId: walkthrough.id,
            startLine: range?.startLine ?? null,
            endLine: range?.endLine ?? null,
          },
          body,
          authorLabel: "You",
        }),
      ),
    onMutate: async () => await cancelCommentQuery(queryClient, walkthrough.pullRequestId),
    onSuccess: async ({ comment }) => {
      window.getSelection()?.removeAllRanges();
      setCommentBody("");
      setComposerOpen(false);
      setSelectedRange(null);
      setDiagramRange(null);
      setLineComposerPlacement(null);
      await putCommentInCache(queryClient, walkthrough.pullRequestId, comment);
    },
  });
  const createCommentRef = useRef(createComment);
  createCommentRef.current = createComment;
  const deleteWalkthrough = useMutation({
    mutationFn: async () =>
      await api<DeleteWalkthroughResponse>(
        `/api/pull-requests/${walkthrough.pullRequestId}/walkthroughs/${walkthrough.id}`,
        {
          ...jsonRequest({}),
          method: "DELETE",
        },
      ),
    onSuccess: async () => {
      onDeleted(walkthrough);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["walkthroughs"] }),
        queryClient.invalidateQueries({ queryKey: ["walkthrough"] }),
        queryClient.invalidateQueries({ queryKey: ["comments"] }),
        queryClient.invalidateQueries({ queryKey: ["change-sequence"] }),
      ]);
    },
  });
  const unresolvedCommentCount = walkthroughComments.filter(
    (comment) => comment.resolvedAt === null,
  ).length;
  const confirmDelete = (): void => {
    const associatedState =
      walkthroughComments.length === 0
        ? "紐づくコメントはありません。"
        : `紐づくコメント ${walkthroughComments.length}件と投稿 ${associatedPostCount}件も削除されます。`;
    const confirmed = window.confirm(
      `このウォークスルーを削除します。\n${associatedState}\nコピー済みの参照は無効になります。\n\nこの操作は元に戻せません。`,
    );
    if (confirmed) deleteWalkthrough.mutate();
  };
  const selectedRangeLabel = selectedRange
    ? selectedRange.startLine === selectedRange.endLine
      ? `L${selectedRange.startLine}`
      : `L${selectedRange.startLine}–${selectedRange.endLine}`
    : null;
  const closeLineComposer = useCallback((): void => {
    window.getSelection()?.removeAllRanges();
    createCommentRef.current.reset();
    setCommentBody("");
    setSelectedRange(null);
    setDiagramRange(null);
    setLineComposerPlacement(null);
  }, []);
  const openDiagramComposer = useCallback((range: MarkdownSourceRange): void => {
    createCommentRef.current.reset();
    setCommentBody("");
    setComposerOpen(false);
    setSelectedRange(null);
    setDiagramRange(range);
    setLineComposerPlacement("diagram");
  }, []);
  const submitDiagramComment = useCallback((range: MarkdownSourceRange, body: string): void => {
    createCommentRef.current.mutate({ range, body });
  }, []);
  const createExpandedDiagramComment = useCallback(
    async (range: MarkdownSourceRange, body: string): Promise<void> => {
      await createCommentRef.current.mutateAsync({ range, body });
    },
    [],
  );
  const selectionComposer = selectedRange ? (
    <InlineCommentComposer
      body={commentBody}
      label={`${selectedRangeLabel ?? "選択範囲"}へコメント`}
      pending={createComment.isPending}
      error={createComment.error}
      validationError={undefined}
      placement="line"
      onBodyChange={setCommentBody}
      onCancel={closeLineComposer}
      onSubmit={() => createComment.mutate({ range: selectedRange, body: commentBody })}
    />
  ) : null;
  const walkthroughMarkdown = (
    <WalkthroughMarkdown
      pullRequestId={walkthrough.pullRequestId}
      body={walkthrough.body}
      diagramBindings={walkthrough.diagramBindings}
      references={references}
      placedComments={markdownComments}
      activeCommentId={activeCommentId}
      navigationLine={navigationTarget?.line ?? null}
      selectedRange={lineComposerPlacement === "selection" ? selectedRange : null}
      selectionComposerOpen={lineComposerPlacement === "selection"}
      diagramCommentRange={diagramRange}
      markdownSourceOid={walkthrough.sourceOid}
      draftScope={replyDraftScope}
      themePreference={themePreference}
      onOpenReference={openReference}
      onResolveReferenceForPeek={resolveReferenceForPeek}
      onOpenCommentCodeReference={openCommentCodeReference}
      onOpenRepositoryLink={openRepositoryLink}
      onCommentActiveChange={changeCommentActive}
      onActivateComment={activateComment}
      onCommentRange={openDiagramComposer}
      diagramCommentPending={createComment.isPending}
      diagramCommentError={createComment.error}
      onCancelDiagramComment={closeLineComposer}
      onSubmitDiagramComment={submitDiagramComment}
      onCreateExpandedDiagramComment={createExpandedDiagramComment}
    />
  );

  return (
    <div className="walkthrough-viewer" ref={viewerRef}>
      <header className="walkthrough-viewer-header">
        <div className="walkthrough-viewer-title">
          <span className="walkthrough-viewer-icon">
            <WalkthroughIcon />
          </span>
          <div className="walkthrough-viewer-heading-copy">
            <span className="walkthrough-kicker">Agent-provided walkthrough</span>
            <h2 title={walkthrough.title}>{walkthrough.title}</h2>
          </div>
        </div>
        <div className="walkthrough-viewer-actions">
          <button
            className="comment-icon-button walkthrough-comment-button"
            aria-label="ウォークスルー全体へコメント"
            title="ウォークスルー全体へコメント"
            aria-pressed={composerOpen}
            onClick={() => {
              createComment.reset();
              setCommentBody("");
              setSelectedRange(null);
              setDiagramRange(null);
              setLineComposerPlacement(null);
              setComposerOpen((open) => !open);
            }}
          >
            <CommentIcon />
            {unresolvedCommentCount > 0 && <span>{unresolvedCommentCount}</span>}
          </button>
          <button
            className="comment-icon-button walkthrough-delete-button"
            aria-label="ウォークスルーを削除"
            title="ウォークスルーを削除"
            disabled={deleteWalkthrough.isPending}
            onClick={confirmDelete}
          >
            <DeleteIcon />
          </button>
        </div>
        {referenceNotice && (
          <div
            className="code-reference-notice walkthrough-reference-notice"
            role="status"
            aria-live="polite"
          >
            {referenceNotice}
          </div>
        )}
      </header>
      <ErrorNotice error={deleteWalkthrough.error} />
      <ErrorNotice error={placementQuery.error} />
      {(composerOpen || headerComments.length > 0) && (
        <div className="walkthrough-comment-area">
          {composerOpen && (
            <InlineCommentComposer
              body={commentBody}
              label="ウォークスルー全体へコメント"
              pending={createComment.isPending}
              error={createComment.error}
              validationError={undefined}
              placement="file"
              onBodyChange={setCommentBody}
              onCancel={() => {
                createComment.reset();
                setCommentBody("");
                setComposerOpen(false);
              }}
              onSubmit={() => createComment.mutate({ range: null, body: commentBody })}
            />
          )}
          {headerComments.map(({ comment, placement }) => (
            <CommentThread
              key={comment.id}
              comment={comment}
              variant="inline"
              draftScope={replyDraftScope}
              placement={placement}
              markdownSourceOid={walkthrough.sourceOid}
              themePreference={themePreference}
              onActiveChange={onCommentActiveChange}
              onOpenCodeReference={onOpenCommentCodeReference}
              onOpenRepositoryLink={onOpenRepositoryLink}
            />
          ))}
        </div>
      )}
      <MarkdownSelectionSurface
        className="walkthrough-markdown-surface"
        selectedRange={selectedRange}
        composerOpen={lineComposerPlacement === "selection"}
        onSelection={(range) => {
          if (!range) {
            setSelectedRange(null);
            setLineComposerPlacement((placement) => (placement === "selection" ? null : placement));
            return;
          }
          createComment.reset();
          setCommentBody("");
          setComposerOpen(false);
          setSelectedRange(range);
          setDiagramRange(null);
          setLineComposerPlacement(null);
        }}
        onOpenComposer={() => setLineComposerPlacement("selection")}
        composer={selectionComposer}
      >
        <div data-pane-find-surface data-pane-find-text>
          {walkthroughMarkdown}
        </div>
      </MarkdownSelectionSurface>
    </div>
  );
}
