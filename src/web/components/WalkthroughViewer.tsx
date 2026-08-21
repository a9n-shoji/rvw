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
  BranchReviewComment,
  BranchWalkthrough,
  CommentPlacement,
  CodeReference,
  ReviewComment,
  Walkthrough,
  WalkthroughReference,
} from "../../domain/models.js";
import { api, jsonRequest, type PlacementResponse } from "../api.js";
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
import {
  reviewCommentPayload,
  reviewIdForWalkthrough,
  reviewKindForWalkthrough,
  type AnyReviewComment,
  type AnyWalkthrough,
} from "../review-context.js";
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
import { MermaidSurface } from "./MermaidSurface.js";
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

function MermaidDiagram({
  source,
  sourceRange,
  commented,
  bindings,
  references,
  themePreference,
  onOpenReference,
  onCommentRange,
  diagramCommentEnabled,
  commentComposer,
}: {
  source: string;
  sourceRange: MarkdownSourceRange | null;
  commented: boolean;
  bindings: Record<string, string>;
  references: ReadonlyMap<string, WalkthroughReference>;
  themePreference: ThemePreference;
  onOpenReference: (reference: WalkthroughReference, openInOtherPane: boolean) => void;
  onCommentRange: (range: MarkdownSourceRange) => void;
  diagramCommentEnabled: boolean;
  commentComposer: ReactNode;
}) {
  const commentComposerRef = useRef<HTMLDivElement>(null);
  const composerOpen = Boolean(commentComposer);
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
      for (const node of container.querySelectorAll<SVGGElement>(
        "g.node, g.classGroup, g[data-id], g[id^='classId-']",
      )) {
        const nodeId =
          node.dataset.id ??
          Object.keys(bindings).find(
            (candidate) =>
              node.id === candidate ||
              node.id.includes(`-${candidate}`) ||
              node.id.includes(`-${candidate}-`) ||
              node.id.endsWith(`-${candidate}`),
          );
        if (!nodeId) continue;
        const referenceId = bindings[nodeId];
        const reference = referenceId ? references.get(referenceId) : undefined;
        if (!reference) continue;
        node.classList.add("walkthrough-diagram-node--linked");
        node.setAttribute("role", "button");
        node.setAttribute("tabindex", "0");
        node.setAttribute("aria-label", `${reference.label}をコードで開く`);
        node.dataset.walkthroughReferenceId = reference.id;
      }
    },
    [bindings, references],
  );

  return (
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
        <span>nodeを選択して開く · Cmd/Ctrlで反対のペイン</span>
        {sourceRange && diagramCommentEnabled && (
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
  );
}

interface MermaidMarkdownRenderContext {
  diagramBindings: Record<string, string>;
  references: ReadonlyMap<string, WalkthroughReference>;
  placedComments: Array<{
    comment: ReviewComment | BranchReviewComment;
    placement: CommentPlacement;
  }>;
  activeCommentId: string | null;
  diagramCommentRange: MarkdownSourceRange | null;
  themePreference: ThemePreference;
  onOpenReference: (reference: WalkthroughReference, openInOtherPane: boolean) => void;
  diagramCommentEnabled: boolean;
  onCommentRange: (range: MarkdownSourceRange) => void;
  diagramCommentPending: boolean;
  diagramCommentError: unknown;
  onCancelDiagramComment: () => void;
  onSubmitDiagramComment: (range: MarkdownSourceRange, body: string) => void;
}

const MermaidMarkdownRenderContext = createContext<MermaidMarkdownRenderContext | null>(null);

function WalkthroughDiagramCommentComposer({
  range,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  range: MarkdownSourceRange;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const label =
    range.startLine === range.endLine
      ? `L${range.startLine}へコメント`
      : `L${range.startLine}–${range.endLine}へコメント`;
  return (
    <InlineCommentComposer
      body={body}
      label={label}
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
  if (!context || !isValidElement(child) || child.props.className !== "language-mermaid") {
    return <pre {...props}>{children}</pre>;
  }
  const sourceRange = markdownNodeSourceRange(node);
  return (
    <MermaidDiagram
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
      diagramCommentEnabled={context.diagramCommentEnabled}
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
    />
  );
};

const WalkthroughMarkdown = memo(function WalkthroughMarkdown({
  body,
  diagramBindings,
  references,
  placedComments,
  activeCommentId,
  selectedRange,
  selectionComposerOpen,
  diagramCommentRange,
  markdownSourceOid,
  themePreference,
  onOpenReference,
  onOpenCommentCodeReference,
  onOpenRepositoryLink,
  onCommentActiveChange,
  onCommentRange,
  diagramCommentPending,
  diagramCommentError,
  onCancelDiagramComment,
  onSubmitDiagramComment,
  diagramCommentEnabled = true,
}: {
  body: string;
  diagramBindings: Record<string, string>;
  references: ReadonlyMap<string, WalkthroughReference>;
  placedComments: Array<{
    comment: ReviewComment | BranchReviewComment;
    placement: CommentPlacement;
  }>;
  activeCommentId: string | null;
  selectedRange: MarkdownSourceRange | null;
  selectionComposerOpen: boolean;
  diagramCommentRange: MarkdownSourceRange | null;
  markdownSourceOid: string;
  themePreference: ThemePreference;
  onOpenReference: (reference: WalkthroughReference, openInOtherPane: boolean) => void;
  onOpenCommentCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInOtherPane: boolean,
  ) => Promise<string | null>;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInOtherPane: boolean) => void;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onCommentRange: (range: MarkdownSourceRange) => void;
  diagramCommentPending: boolean;
  diagramCommentError: unknown;
  onCancelDiagramComment: () => void;
  onSubmitDiagramComment: (range: MarkdownSourceRange, body: string) => void;
  diagramCommentEnabled?: boolean;
}) {
  const annotations = useMemo<MarkdownCommentAnnotation[]>(
    () =>
      placedComments.map(({ comment, placement }) => ({
        id: comment.id,
        range: placement.range,
      })),
    [placedComments],
  );
  const commentsById = useMemo(
    () =>
      new Map(placedComments.map(({ comment, placement }) => [comment.id, { comment, placement }])),
    [placedComments],
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
        diagramBindings,
        references,
        placedComments,
        activeCommentId,
        diagramCommentRange,
        themePreference,
        onOpenReference,
        diagramCommentEnabled,
        onCommentRange,
        diagramCommentPending,
        diagramCommentError,
        onCancelDiagramComment,
        onSubmitDiagramComment,
      }}
    >
      <article className="walkthrough-markdown">
        <ReactMarkdown
          rehypePlugins={[
            rehypeRaw,
            [rehypeSanitize, codeReferenceMarkdownSanitizeSchema],
            [
              rehypeRvwSourceMap,
              { annotations, activeCommentId, selectedRange, composerOpen: selectionComposerOpen },
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

export function WalkthroughReadingSurface({
  walkthrough,
  placedComments,
  themePreference,
  onOpenReference,
  onOpenCommentCodeReference,
  onOpenRepositoryLink,
}: {
  walkthrough: Walkthrough | BranchWalkthrough;
  placedComments: Array<{
    comment: ReviewComment | BranchReviewComment;
    placement: CommentPlacement;
  }>;
  themePreference: ThemePreference;
  onOpenReference: (reference: WalkthroughReference, openInOtherPane: boolean) => void;
  onOpenCommentCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInOtherPane: boolean,
  ) => Promise<string | null>;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInOtherPane: boolean) => void;
}) {
  const references = useMemo(
    () => new Map(walkthrough.references.map((reference) => [reference.id, reference])),
    [walkthrough.references],
  );
  return (
    <WalkthroughMarkdown
      body={walkthrough.body}
      diagramBindings={walkthrough.diagramBindings}
      references={references}
      placedComments={placedComments}
      activeCommentId={null}
      selectedRange={null}
      selectionComposerOpen={false}
      diagramCommentRange={null}
      markdownSourceOid={walkthrough.sourceOid}
      themePreference={themePreference}
      onOpenReference={onOpenReference}
      onOpenCommentCodeReference={onOpenCommentCodeReference}
      onOpenRepositoryLink={onOpenRepositoryLink}
      onCommentActiveChange={() => undefined}
      onCommentRange={() => undefined}
      diagramCommentEnabled={false}
      diagramCommentPending={false}
      diagramCommentError={null}
      onCancelDiagramComment={() => undefined}
      onSubmitDiagramComment={() => undefined}
    />
  );
}

export function WalkthroughViewer({
  walkthrough,
  comments,
  commentPlacements,
  activeCommentId,
  navigationTarget,
  onNavigationApplied,
  themePreference,
  onCommentActiveChange,
  onOpenReference,
  onOpenCommentCodeReference,
  onOpenRepositoryLink,
  onDeleted,
}: {
  walkthrough: AnyWalkthrough;
  comments: AnyReviewComment[];
  commentPlacements?: ReadonlyMap<string, CommentPlacement>;
  activeCommentId: string | null;
  navigationTarget?: ViewerNavigationTarget | null;
  onNavigationApplied: (requestId: number) => void;
  themePreference: ThemePreference;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onOpenReference: (
    walkthrough: AnyWalkthrough,
    reference: WalkthroughReference,
    openInOtherPane: boolean,
  ) => Promise<string | null>;
  onOpenCommentCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInOtherPane: boolean,
  ) => Promise<string | null>;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInOtherPane: boolean) => void;
  onDeleted: (walkthrough: AnyWalkthrough) => void;
}) {
  const queryClient = useQueryClient();
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
        root.querySelector<HTMLElement>(`[data-rvw-source-start-line="${line}"]`);
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
    (reference: WalkthroughReference, openInOtherPane: boolean): void => {
      referenceRequestSequence.current += 1;
      const requestSequence = referenceRequestSequence.current;
      if (referenceNoticeTimeout.current !== null) {
        window.clearTimeout(referenceNoticeTimeout.current);
        referenceNoticeTimeout.current = null;
      }
      setReferenceNotice(null);
      void onOpenReference(walkthrough, reference, openInOtherPane).then((notice) => {
        if (requestSequence !== referenceRequestSequence.current || !notice) return;
        setReferenceNotice(notice);
        referenceNoticeTimeout.current = window.setTimeout(() => {
          setReferenceNotice(null);
          referenceNoticeTimeout.current = null;
        }, referenceNoticeDurationMs);
      });
    },
    [onOpenReference, walkthrough],
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
  const walkthroughComments = comments.filter(
    (comment) =>
      comment.target.kind === "walkthrough" && comment.target.walkthroughId === walkthrough.id,
  );
  const associatedPostCount = walkthroughComments.reduce(
    (count, comment) => count + comment.posts.length,
    0,
  );
  const reviewKind = reviewKindForWalkthrough(walkthrough);
  const reviewId = reviewIdForWalkthrough(walkthrough);
  const placementQuery = useQuery({
    queryKey: [
      "walkthrough-comment-placements",
      walkthrough.id,
      walkthrough.body,
      walkthroughComments.map((comment) => `${comment.id}:${comment.updatedAt}`),
      walkthroughComments.map((comment) => {
        const placement = commentPlacements?.get(comment.id);
        return placement
          ? `${comment.id}:${placement.outdated}:${placement.range?.startLine ?? ""}:${placement.range?.endLine ?? ""}`
          : `${comment.id}:uncached`;
      }),
    ],
    queryFn: async () => {
      const search = new URLSearchParams({
        kind: "walkthrough",
        [reviewKind === "pull-request" ? "pullRequestId" : "branchReviewId"]: reviewId,
        walkthroughId: walkthrough.id,
      });
      return await Promise.all(
        walkthroughComments.map(async (comment) => ({
          comment,
          placement:
            commentPlacements?.get(comment.id) ??
            (
              await api<PlacementResponse>(
                `/api/comments/${comment.id}/placement?${search.toString()}`,
              )
            ).placement,
        })),
      );
    },
    enabled: walkthroughComments.length > 0,
  });
  const placedComments = useMemo(() => placementQuery.data ?? [], [placementQuery.data]);
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
      await api(
        "/api/comments",
        jsonRequest({
          ...reviewCommentPayload({ kind: reviewKind, id: reviewId }),
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
    onSuccess: async () => {
      window.getSelection()?.removeAllRanges();
      setCommentBody("");
      setComposerOpen(false);
      setSelectedRange(null);
      setDiagramRange(null);
      setLineComposerPlacement(null);
      await queryClient.invalidateQueries({ queryKey: ["comments"] });
      await queryClient.invalidateQueries({ queryKey: ["change-sequence"] });
    },
  });
  const deleteWalkthrough = useMutation({
    mutationFn: async () =>
      await api(
        `/api/${reviewKind === "pull-request" ? "pull-requests" : "branch-reviews"}/${reviewId}/walkthroughs/${walkthrough.id}`,
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
  const closeLineComposer = (): void => {
    window.getSelection()?.removeAllRanges();
    createComment.reset();
    setCommentBody("");
    setSelectedRange(null);
    setDiagramRange(null);
    setLineComposerPlacement(null);
  };
  const openDiagramComposer = (range: MarkdownSourceRange): void => {
    createComment.reset();
    setCommentBody("");
    setComposerOpen(false);
    setSelectedRange(null);
    setDiagramRange(range);
    setLineComposerPlacement("diagram");
  };
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
      body={walkthrough.body}
      diagramBindings={walkthrough.diagramBindings}
      references={references}
      placedComments={markdownComments}
      activeCommentId={activeCommentId}
      selectedRange={lineComposerPlacement === "selection" ? selectedRange : null}
      selectionComposerOpen={lineComposerPlacement === "selection"}
      diagramCommentRange={diagramRange}
      markdownSourceOid={walkthrough.sourceOid}
      themePreference={themePreference}
      onOpenReference={openReference}
      onOpenCommentCodeReference={onOpenCommentCodeReference}
      onOpenRepositoryLink={onOpenRepositoryLink}
      onCommentActiveChange={onCommentActiveChange}
      onCommentRange={openDiagramComposer}
      diagramCommentPending={createComment.isPending}
      diagramCommentError={createComment.error}
      onCancelDiagramComment={closeLineComposer}
      onSubmitDiagramComment={(range, body) => createComment.mutate({ range, body })}
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
        {walkthroughMarkdown}
      </MarkdownSelectionSurface>
    </div>
  );
}
