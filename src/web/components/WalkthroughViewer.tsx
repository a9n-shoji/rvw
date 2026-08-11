import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useId,
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
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type {
  CommentPlacement,
  ReviewComment,
  Walkthrough,
  WalkthroughReference,
} from "../../domain/models.js";
import {
  api,
  type DeleteWalkthroughResponse,
  jsonRequest,
  type PlacementResponse,
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
import type { ViewerNavigationTarget } from "./DocumentViewer.js";
import { CommentIcon, InlineCommentComposer } from "./CommentComposer.js";
import { CommentThread } from "./CommentThread.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { FileEntryIcon } from "./FileIcon.js";
import { MarkdownImagePlaceholder } from "./MarkdownImagePlaceholder.js";
import { WalkthroughIcon } from "./WalkthroughPanel.js";

let mermaidQueue = Promise.resolve();
const darkColorSchemeQuery = "(prefers-color-scheme: dark)";
const referenceNoticeDurationMs = 2400;
const walkthroughMarkdownSanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "rvw-ref"],
  },
};

function usePrefersDarkColorScheme(): boolean {
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia(darkColorSchemeQuery).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(darkColorSchemeQuery);
    const updatePreference = (): void => setPrefersDark(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return prefersDark;
}

function referenceHrefId(href: string | undefined): string | null {
  if (!href?.startsWith("rvw-ref:")) return null;
  return href.slice("rvw-ref:".length);
}

function codeText(content: ReactNode): string {
  return Children.toArray(content)
    .map((part) => {
      if (typeof part === "string" || typeof part === "number") return String(part);
      return isValidElement<{ children?: ReactNode }>(part) ? codeText(part.props.children) : "";
    })
    .join("");
}

function compactReferenceLocation(reference: WalkthroughReference): string {
  const fileName = reference.path.split("/").at(-1) ?? reference.path;
  const lineLabel = referenceLineLabel(reference);
  return lineLabel ? `${fileName}:${lineLabel}` : fileName;
}

function referenceLineLabel(reference: WalkthroughReference): string | null {
  if (reference.startLine === null || reference.endLine === null) return null;
  return reference.startLine === reference.endLine
    ? `L${reference.startLine}`
    : `L${reference.startLine}–${reference.endLine}`;
}

function fullReferenceLocation(reference: WalkthroughReference): string {
  const lineLabel = referenceLineLabel(reference);
  return lineLabel ? `${reference.path}:${lineLabel}` : reference.path;
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
  commentComposer: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const commentComposerRef = useRef<HTMLDivElement>(null);
  const generatedId = useId().replace(/[^A-Za-z0-9]/g, "");
  const [error, setError] = useState<string | null>(null);
  const prefersDarkColorScheme = usePrefersDarkColorScheme();
  const dark =
    themePreference === "dark" || (themePreference === "system" && prefersDarkColorScheme);
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

  useEffect(() => {
    let disposed = false;
    mermaidQueue = mermaidQueue
      .then(async () => {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "base",
          flowchart: { htmlLabels: false, curve: "basis" },
          themeVariables: dark
            ? { primaryColor: "#1f2937", primaryTextColor: "#f0f6fc", lineColor: "#8c959f" }
            : { primaryColor: "#eef5ff", primaryTextColor: "#24292f", lineColor: "#57606a" },
        });
        const rendered = await mermaid.render(`rvwWalkthrough${generatedId}`, source);
        if (disposed || !containerRef.current) return;
        containerRef.current.innerHTML = rendered.svg;
        for (const node of containerRef.current.querySelectorAll<SVGGElement>(
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
      })
      .catch((reason: unknown) => {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : "diagramを表示できません。");
      });
    return () => {
      disposed = true;
    };
  }, [bindings, dark, generatedId, references, source]);

  if (error) return <div className="walkthrough-diagram-error">{error}</div>;
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
      </div>
      <div
        className="walkthrough-diagram"
        ref={containerRef}
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

const WalkthroughMarkdown = memo(function WalkthroughMarkdown({
  walkthrough,
  references,
  placedComments,
  activeCommentId,
  selectedRange,
  diagramCommentRange,
  diagramCommentComposer,
  themePreference,
  onOpenReference,
  onCommentActiveChange,
  onCommentRange,
}: {
  walkthrough: Walkthrough;
  references: ReadonlyMap<string, WalkthroughReference>;
  placedComments: Array<{ comment: ReviewComment; placement: CommentPlacement }>;
  activeCommentId: string | null;
  selectedRange: MarkdownSourceRange | null;
  diagramCommentRange: MarkdownSourceRange | null;
  diagramCommentComposer: ReactNode;
  themePreference: ThemePreference;
  onOpenReference: (reference: WalkthroughReference, openInOtherPane: boolean) => void;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onCommentRange: (range: MarkdownSourceRange) => void;
}) {
  const inlineReferencePointerStart = useRef<{ x: number; y: number } | null>(null);
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
                onActiveChange={onCommentActiveChange}
              />
            ) : null;
          })}
        </div>
      );
    },
    [commentsById, onCommentActiveChange],
  );
  return (
    <article className="walkthrough-markdown">
      <ReactMarkdown
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, walkthroughMarkdownSanitizeSchema],
          [rehypeRvwSourceMap, { annotations, activeCommentId, selectedRange }],
        ]}
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith("rvw-ref:") ? url : defaultUrlTransform(url))}
        components={{
          div: markdownDiv,
          table: ({ children, node: _node, ...props }) => (
            <div className="markdown-table-scroll">
              <table {...markdownSourceDataAttributes(_node)} {...props}>
                {children}
              </table>
            </div>
          ),
          a: ({ href, children, node: _node, ...props }) => {
            const referenceId = referenceHrefId(href);
            const reference = referenceId ? references.get(referenceId) : undefined;
            return reference ? (
              <button
                className="walkthrough-inline-reference"
                title={fullReferenceLocation(reference)}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  inlineReferencePointerStart.current = {
                    x: event.clientX,
                    y: event.clientY,
                  };
                }}
                onPointerUp={(event) => {
                  const start = inlineReferencePointerStart.current;
                  inlineReferencePointerStart.current = null;
                  if (!start) return;
                  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenReference(reference, event.metaKey || event.ctrlKey);
                }}
                onPointerCancel={() => {
                  inlineReferencePointerStart.current = null;
                }}
                onClick={(event) => {
                  event.preventDefault();
                  if (event.detail === 0) onOpenReference(reference, false);
                }}
                onContextMenu={(event) => {
                  if (event.ctrlKey || event.metaKey) event.preventDefault();
                }}
              >
                <FileEntryIcon path={reference.path} kind="file" />
                <span>{children}</span>
                <small>{referenceLineLabel(reference) ?? "File"}</small>
              </button>
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
          pre: ({ children, node, ...props }) => {
            const child =
              Children.count(children) === 1
                ? (Children.only(children) as ReactElement<{
                    className?: string;
                    children?: ReactNode;
                  }>)
                : null;
            if (isValidElement(child) && child.props.className === "language-mermaid") {
              const sourceRange = markdownNodeSourceRange(node);
              return (
                <MermaidDiagram
                  source={codeText(child.props.children).trim()}
                  sourceRange={sourceRange}
                  commented={Boolean(
                    sourceRange &&
                    activeCommentId &&
                    placedComments.some(
                      ({ comment, placement }) =>
                        comment.id === activeCommentId &&
                        placement.range &&
                        placement.range.startLine <= sourceRange.endLine &&
                        placement.range.endLine >= sourceRange.startLine,
                    ),
                  )}
                  bindings={walkthrough.diagramBindings}
                  references={references}
                  themePreference={themePreference}
                  onOpenReference={onOpenReference}
                  onCommentRange={onCommentRange}
                  commentComposer={
                    sameRange(sourceRange, diagramCommentRange) ? diagramCommentComposer : null
                  }
                />
              );
            }
            return <pre {...props}>{children}</pre>;
          },
        }}
      >
        {walkthrough.body}
      </ReactMarkdown>
    </article>
  );
});

export function WalkthroughViewer({
  walkthrough,
  comments,
  activeCommentId,
  navigationTarget,
  themePreference,
  onCommentActiveChange,
  onOpenReference,
  onDeleted,
}: {
  walkthrough: Walkthrough;
  comments: ReviewComment[];
  activeCommentId: string | null;
  navigationTarget?: ViewerNavigationTarget | null;
  themePreference: ThemePreference;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onOpenReference: (
    walkthrough: Walkthrough,
    reference: WalkthroughReference,
    openInOtherPane: boolean,
  ) => Promise<string | null>;
  onDeleted: (walkthrough: Walkthrough) => void;
}) {
  const queryClient = useQueryClient();
  const viewerRef = useRef<HTMLDivElement>(null);
  const appliedNavigationRequest = useRef<number | null>(null);
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
    appliedNavigationRequest.current = navigationTarget.requestId;
    const frame = window.requestAnimationFrame(() => {
      const root = viewerRef.current;
      if (!root) return;
      if (navigationTarget.line === null) {
        root.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
        return;
      }
      const line = String(navigationTarget.line);
      const target =
        root.querySelector<HTMLElement>(`[data-rvw-navigation-start-line="${line}"]`) ??
        root.querySelector<HTMLElement>(`[data-rvw-source-start-line="${line}"]`);
      const collapsedDetails = target?.closest<HTMLDetailsElement>("details:not([open])");
      if (collapsedDetails) collapsedDetails.open = true;
      target?.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
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
  const placementQuery = useQuery({
    queryKey: [
      "walkthrough-comment-placements",
      walkthrough.id,
      walkthrough.body,
      walkthroughComments.map((comment) => `${comment.id}:${comment.updatedAt}`),
    ],
    queryFn: async () => {
      const search = new URLSearchParams({
        kind: "walkthrough",
        pullRequestId: walkthrough.pullRequestId,
        walkthroughId: walkthrough.id,
      });
      return await Promise.all(
        walkthroughComments.map(async (comment) => ({
          comment,
          placement: (
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
    mutationFn: async (range: MarkdownSourceRange | null) =>
      await api(
        "/api/comments",
        jsonRequest({
          pullRequestId: walkthrough.pullRequestId,
          target: {
            kind: "walkthrough",
            walkthroughId: walkthrough.id,
            startLine: range?.startLine ?? null,
            endLine: range?.endLine ?? null,
          },
          body: commentBody,
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
  const activeLineRange = lineComposerPlacement === "diagram" ? diagramRange : selectedRange;
  const selectedRangeLabel = activeLineRange
    ? activeLineRange.startLine === activeLineRange.endLine
      ? `L${activeLineRange.startLine}`
      : `L${activeLineRange.startLine}–${activeLineRange.endLine}`
    : null;
  const closeLineComposer = (): void => {
    window.getSelection()?.removeAllRanges();
    createComment.reset();
    setCommentBody("");
    setSelectedRange(null);
    setDiagramRange(null);
    setLineComposerPlacement(null);
  };
  const resetCreateComment = createComment.reset;
  const openDiagramComposer = useCallback(
    (range: MarkdownSourceRange): void => {
      resetCreateComment();
      setCommentBody("");
      setComposerOpen(false);
      setSelectedRange(null);
      setDiagramRange(range);
      setLineComposerPlacement("diagram");
    },
    [resetCreateComment],
  );
  const lineComposer = activeLineRange ? (
    <InlineCommentComposer
      body={commentBody}
      label={`${selectedRangeLabel ?? "選択範囲"}へコメント`}
      pending={createComment.isPending}
      error={createComment.error}
      validationError={undefined}
      placement="line"
      onBodyChange={setCommentBody}
      onCancel={closeLineComposer}
      onSubmit={() => createComment.mutate(activeLineRange)}
    />
  ) : null;

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
          <div className="walkthrough-reference-notice" role="status" aria-live="polite">
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
              onSubmit={() => createComment.mutate(null)}
            />
          )}
          {headerComments.map(({ comment, placement }) => (
            <CommentThread
              key={comment.id}
              comment={comment}
              variant="inline"
              placement={placement}
              onActiveChange={onCommentActiveChange}
            />
          ))}
        </div>
      )}
      <div className="walkthrough-viewer-layout">
        <MarkdownSelectionSurface
          className="walkthrough-markdown-surface"
          selectedRange={selectedRange}
          composerOpen={lineComposerPlacement === "selection"}
          onSelection={(range) => {
            if (!range) {
              setSelectedRange(null);
              setLineComposerPlacement((placement) =>
                placement === "selection" ? null : placement,
              );
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
          composer={lineComposer}
        >
          <WalkthroughMarkdown
            walkthrough={walkthrough}
            references={references}
            placedComments={markdownComments}
            activeCommentId={activeCommentId}
            selectedRange={activeLineRange}
            diagramCommentRange={diagramRange}
            diagramCommentComposer={lineComposerPlacement === "diagram" ? lineComposer : null}
            themePreference={themePreference}
            onOpenReference={openReference}
            onCommentActiveChange={onCommentActiveChange}
            onCommentRange={openDiagramComposer}
          />
        </MarkdownSelectionSurface>
        <aside className="walkthrough-reference-index" aria-label="コード参照">
          <div className="walkthrough-reference-index-heading">
            <strong>Code references</strong>
            <span>開くまでnavigationは変わりません</span>
          </div>
          <div className="walkthrough-reference-index-list">
            {walkthrough.references.map((reference, index) => (
              <button
                key={reference.id}
                title={fullReferenceLocation(reference)}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  openReference(reference, event.metaKey || event.ctrlKey);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  if (event.detail === 0) openReference(reference, false);
                }}
                onContextMenu={(event) => {
                  if (event.ctrlKey || event.metaKey) event.preventDefault();
                }}
              >
                <span className="walkthrough-reference-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="walkthrough-reference-copy">
                  <strong>{reference.label}</strong>
                  <code>{compactReferenceLocation(reference)}</code>
                  {reference.description && <small>{reference.description}</small>}
                </span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
