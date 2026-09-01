import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  CodeReference,
  CommentPlacement,
  CommentPost,
  ReviewComment,
} from "../../domain/models.js";
import { api, jsonRequest } from "../api.js";
import {
  cancelCommentQuery,
  putCommentInCache,
  removeCommentFromCache,
} from "../comment-query-cache.js";
import {
  deleteCommentReplyDraftsForComment,
  readCommentReplyDraft,
  subscribeCommentReplyDrafts,
  writeCommentReplyDraft,
} from "../comment-draft-store.js";
import type { ThemePreference } from "../theme.js";
import { handleCommentSubmitShortcut } from "./CommentComposer.js";
import { CommentMarkdown } from "./CommentMarkdown.js";
import { ErrorNotice } from "./ErrorNotice.js";
import type { MermaidReviewWorkspace } from "./MermaidExpandedView.js";

type CommentThreadVariant = "inline" | "sidebar";
type DiffSide = "additions" | "deletions" | null;

interface StoredInlineExpansion {
  expanded: boolean;
  commentUpdatedAt: string;
}

interface CommentMenuPosition {
  postId: string;
  top: number;
  left: number;
  opensUpward: boolean;
}

const inlineExpansionByComment = new Map<string, StoredInlineExpansion>();
const pendingInlineScrollByComment = new Set<string>();
const referenceNoticeDurationMs = 2400;

function rangeLabel(comment: ReviewComment, placement: CommentPlacement | null): string | null {
  if (comment.target.kind === "pull-request" || comment.target.startLine === null) return null;
  const range = placement && !placement.outdated ? placement.range : null;
  const start = range?.startLine ?? comment.target.startLine;
  const end = range?.endLine ?? comment.target.endLine ?? start;
  return start === end ? `L${start}` : `L${start}–${end}`;
}

function targetLabel(
  comment: ReviewComment,
  placement: CommentPlacement | null,
  side: DiffSide,
): string {
  if (comment.target.kind === "pull-request") return "Pull Request全体";
  if (comment.target.kind === "walkthrough") {
    return [
      comment.target.walkthroughTitle,
      rangeLabel(comment, placement) ?? "ウォークスルー全体",
    ].join(" · ");
  }
  const path =
    placement?.path ??
    (comment.target.documentKind === "pull-request-markdown"
      ? "Pull Request.md"
      : comment.target.path);
  const range = rangeLabel(comment, placement);
  const level = range ?? "文書全体";
  const sideLabel = side === "deletions" ? "変更前" : side === "additions" ? "変更後" : null;
  return [path, sideLabel, level].filter(Boolean).join(" · ");
}

function inlineTargetLabel(
  comment: ReviewComment,
  placement: CommentPlacement | null,
  side: DiffSide,
): string {
  if (comment.target.kind === "pull-request") return "Pull Request全体";
  if (comment.target.kind === "walkthrough") {
    return rangeLabel(comment, placement) ?? "ウォークスルー全体";
  }
  const range = rangeLabel(comment, placement);
  const level =
    range ??
    (comment.target.documentKind === "pull-request-markdown" ? "文書全体" : "ファイル全体");
  return side === "deletions" ? `変更前 · ${level}` : level;
}

function navigationLabel(comment: ReviewComment): string {
  return comment.target.kind === "pull-request" ? "Pull Request.mdを開く" : "コメント対象を開く";
}

function formattedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function CommentPostMarkdown({
  comment,
  post,
  markdownSourceOid,
  themePreference,
  mermaidReviewDisabled,
  onOpenCodeReference,
  onOpenRepositoryLink,
}: {
  comment: ReviewComment;
  post: CommentPost;
  markdownSourceOid?: string | undefined;
  themePreference: ThemePreference;
  mermaidReviewDisabled: boolean;
  onOpenCodeReference?:
    | ((
        sourceOid: string,
        reference: CodeReference,
        openInRightPane: boolean,
      ) => Promise<string | null>)
    | undefined;
  onOpenRepositoryLink?:
    ((path: string, sourceOid: string, openInRightPane: boolean) => void) | undefined;
}) {
  const [referenceNotice, setReferenceNotice] = useState<string | null>(null);
  const referenceNoticeTimeout = useRef<number | null>(null);
  const repositoryTarget =
    comment.target.kind === "document" && comment.target.documentKind === "repository-file"
      ? comment.target
      : null;
  const sourceOid =
    post.relatedCommitOid ??
    repositoryTarget?.sourceOid ??
    markdownSourceOid ??
    comment.createdHeadOid;
  useEffect(
    () => () => {
      if (referenceNoticeTimeout.current !== null) {
        window.clearTimeout(referenceNoticeTimeout.current);
      }
    },
    [],
  );
  const openCodeReference = useCallback(
    async (reference: CodeReference, openInRightPane: boolean): Promise<void> => {
      if (!onOpenCodeReference) return;
      const notice = await onOpenCodeReference(sourceOid, reference, openInRightPane);
      if (!notice) return;
      if (referenceNoticeTimeout.current !== null) {
        window.clearTimeout(referenceNoticeTimeout.current);
      }
      setReferenceNotice(notice);
      referenceNoticeTimeout.current = window.setTimeout(() => {
        setReferenceNotice(null);
        referenceNoticeTimeout.current = null;
      }, referenceNoticeDurationMs);
    },
    [onOpenCodeReference, sourceOid],
  );
  const handleOpenCodeReference = useCallback(
    (reference: CodeReference, openInRightPane: boolean): void => {
      void openCodeReference(reference, openInRightPane);
    },
    [openCodeReference],
  );
  const mermaidReview = useMemo<MermaidReviewWorkspace | undefined>(
    () =>
      mermaidReviewDisabled
        ? undefined
        : {
            pullRequestId: comment.pullRequestId,
            commentCount: 1,
            onOpenCodeReference:
              onOpenCodeReference ?? (() => Promise.resolve("参照先を開けません。")),
            renderComments: (openReference) => (
              <CommentThread
                comment={comment}
                variant="sidebar"
                draftScope={`mermaid-expanded:${comment.id}`}
                markdownSourceOid={markdownSourceOid}
                themePreference={themePreference}
                mermaidReviewDisabled
                cancelDraftOnEscape
                onOpenCodeReference={openReference}
                onOpenRepositoryLink={onOpenRepositoryLink}
              />
            ),
          },
    [
      comment,
      markdownSourceOid,
      mermaidReviewDisabled,
      onOpenCodeReference,
      onOpenRepositoryLink,
      themePreference,
    ],
  );
  return (
    <>
      <CommentMarkdown
        body={post.body}
        pullRequestId={comment.pullRequestId}
        sourceOid={sourceOid}
        sourcePath={repositoryTarget?.path ?? null}
        references={post.references}
        themePreference={themePreference}
        mermaidReview={mermaidReview}
        onOpenCodeReference={handleOpenCodeReference}
        onOpenRepositoryLink={onOpenRepositoryLink}
      />
      {referenceNotice && (
        <div className="code-reference-notice comment-reference-notice" role="status">
          {referenceNotice}
        </div>
      )}
    </>
  );
}

export function CommentThread({
  comment,
  variant = "sidebar",
  draftScope,
  placement = null,
  side = null,
  markdownSourceOid,
  themePreference,
  onOpenCodeReference,
  onOpenTarget,
  onOpenRepositoryLink,
  onDeleted,
  onActiveChange,
  mermaidReviewDisabled = false,
  cancelDraftOnEscape = false,
}: {
  comment: ReviewComment;
  variant?: CommentThreadVariant;
  draftScope?: string;
  placement?: CommentPlacement | null;
  side?: DiffSide;
  markdownSourceOid?: string | undefined;
  themePreference: ThemePreference;
  onOpenCodeReference?:
    | ((
        sourceOid: string,
        reference: CodeReference,
        openInRightPane: boolean,
      ) => Promise<string | null>)
    | undefined;
  onOpenTarget?: (openInRightPane: boolean) => void;
  onOpenRepositoryLink?:
    ((path: string, sourceOid: string, openInRightPane: boolean) => void) | undefined;
  onDeleted?: () => void;
  onActiveChange?: (commentId: string, active: boolean) => void;
  mermaidReviewDisabled?: boolean;
  cancelDraftOnEscape?: boolean;
}) {
  const queryClient = useQueryClient();
  const replyDraftKey = [variant, draftScope, comment.id].filter(Boolean).join(":");
  const replyDraft = useSyncExternalStore(
    subscribeCommentReplyDrafts,
    () => readCommentReplyDraft(comment.pullRequestId, replyDraftKey),
    () => readCommentReplyDraft(comment.pullRequestId, replyDraftKey),
  );
  const reply = replyDraft.body;
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const [inlineExpanded, setInlineExpanded] = useState(() => {
    if (variant === "sidebar") return true;
    const stored = inlineExpansionByComment.get(comment.id);
    return stored?.commentUpdatedAt === comment.updatedAt
      ? stored.expanded
      : comment.resolvedAt === null;
  });
  const previousCommentUpdatedAt = useRef(comment.updatedAt);
  const threadRef = useRef<HTMLElement>(null);
  const [openMenuPostId, setOpenMenuPostId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<CommentMenuPosition | null>(null);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const showThread = variant === "sidebar" || inlineExpanded;
  const previousShowThread = useRef(showThread);
  const rootPost = comment.posts.find((post) => post.isRoot) ?? comment.posts[0];
  const replyCount = comment.posts.filter((post) => !post.isRoot).length;
  const placementOutdated = placement?.outdated ?? false;

  useLayoutEffect(() => {
    if (!replyDraft.focused || document.activeElement === replyInputRef.current) return;
    replyInputRef.current?.focus();
    replyInputRef.current?.setSelectionRange(reply.length, reply.length);
  }, [reply.length, replyDraft.focused]);

  useEffect(() => {
    if (variant !== "inline") return;
    if (previousCommentUpdatedAt.current === comment.updatedAt) return;
    const expanded = comment.resolvedAt === null;
    inlineExpansionByComment.set(comment.id, {
      expanded,
      commentUpdatedAt: comment.updatedAt,
    });
    setInlineExpanded(expanded);
    previousCommentUpdatedAt.current = comment.updatedAt;
  }, [comment.id, comment.resolvedAt, comment.updatedAt, variant]);

  useLayoutEffect(() => {
    if (variant !== "inline" || !pendingInlineScrollByComment.has(comment.id)) return;
    pendingInlineScrollByComment.delete(comment.id);
    const frame = window.requestAnimationFrame(() => {
      threadRef.current?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [comment.id, comment.resolvedAt, comment.updatedAt, variant]);

  useLayoutEffect(() => {
    const expandedNow = showThread && !previousShowThread.current;
    previousShowThread.current = showThread;
    if (!expandedNow || variant !== "inline") return;
    const frame = window.requestAnimationFrame(() => {
      threadRef.current?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showThread, variant]);

  useEffect(() => {
    if (!openMenuPostId) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(`[data-comment-menu="${openMenuPostId}"]`)) return;
      setOpenMenuPostId(null);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const menuHost = Array.from(
        threadRef.current?.querySelectorAll<HTMLElement>("[data-comment-menu]") ?? [],
      ).find((element) => element.dataset.commentMenu === openMenuPostId);
      menuHost?.querySelector<HTMLElement>(".comment-more-trigger")?.focus();
      setOpenMenuPostId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuPostId]);

  useLayoutEffect(() => {
    if (!openMenuPostId) {
      setMenuPosition(null);
      return;
    }
    const menuHost = Array.from(
      threadRef.current?.querySelectorAll<HTMLElement>("[data-comment-menu]") ?? [],
    ).find((element) => element.dataset.commentMenu === openMenuPostId);
    const menu = menuHost?.querySelector<HTMLElement>(".comment-more-menu");
    if (!menuHost || !menu) return;

    // Diff annotations have their own paint order, so the browser top layer keeps the
    // menu above later annotations without changing document flow.
    if (!menu.matches(":popover-open")) {
      menu.showPopover();
    }

    const positionMenu = (): void => {
      let visibleTop = 8;
      let visibleRight = window.innerWidth - 8;
      let visibleBottom = window.innerHeight - 8;
      let visibleLeft = 8;
      for (let ancestor = menuHost.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = window.getComputedStyle(ancestor);
        if (
          ![style.overflow, style.overflowX, style.overflowY].some((value) =>
            /^(auto|clip|hidden|scroll)$/u.test(value),
          )
        ) {
          continue;
        }
        const rect = ancestor.getBoundingClientRect();
        visibleTop = Math.max(visibleTop, rect.top + 8);
        visibleRight = Math.min(visibleRight, rect.right - 8);
        visibleBottom = Math.min(visibleBottom, rect.bottom - 8);
        visibleLeft = Math.max(visibleLeft, rect.left + 8);
      }

      const triggerRect = menuHost.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const gap = 3;
      const spaceAbove = triggerRect.top - visibleTop;
      const spaceBelow = visibleBottom - triggerRect.bottom;
      const opensUpward = menuRect.height + gap > spaceBelow && spaceAbove > spaceBelow;
      const desiredTop = opensUpward
        ? triggerRect.top - menuRect.height - gap
        : triggerRect.bottom + gap;
      const maxTop = Math.max(visibleTop, visibleBottom - menuRect.height);
      const maxLeft = Math.max(visibleLeft, visibleRight - menuRect.width);
      const nextPosition: CommentMenuPosition = {
        postId: openMenuPostId,
        top: Math.min(Math.max(desiredTop, visibleTop), maxTop),
        left: Math.min(Math.max(triggerRect.right - menuRect.width, visibleLeft), maxLeft),
        opensUpward,
      };
      setMenuPosition((current) =>
        current?.postId === nextPosition.postId &&
        current.top === nextPosition.top &&
        current.left === nextPosition.left &&
        current.opensUpward === nextPosition.opensUpward
          ? current
          : nextPosition,
      );
    };

    positionMenu();
    if (
      menuPosition?.postId === openMenuPostId &&
      document.activeElement === menuHost.querySelector(".comment-more-trigger")
    ) {
      menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    }
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [menuPosition, openMenuPostId, showThread]);

  const cancelCommentRefetch = async (): Promise<void> =>
    await cancelCommentQuery(queryClient, comment.pullRequestId);
  const cacheComment = async (next: ReviewComment): Promise<void> =>
    await putCommentInCache(queryClient, comment.pullRequestId, next);
  const replyMutation = useMutation({
    mutationFn: async () =>
      await api<{ post: CommentPost; comment: ReviewComment }>(
        `/api/comments/${comment.id}/posts`,
        jsonRequest({ body: reply, authorLabel: "You", relatedCommitOid: null }),
      ),
    onMutate: cancelCommentRefetch,
    onSuccess: async ({ comment: next }) => {
      const currentReplyDraft = readCommentReplyDraft(comment.pullRequestId, replyDraftKey);
      writeCommentReplyDraft(comment.pullRequestId, replyDraftKey, {
        revision: currentReplyDraft.revision,
        body: "",
        focused: currentReplyDraft.focused,
      });
      if (variant === "inline") pendingInlineScrollByComment.add(comment.id);
      await cacheComment(next);
    },
  });
  const stateMutation = useMutation({
    mutationFn: async () =>
      await api<{ comment: ReviewComment }>(
        `/api/comments/${comment.id}/${comment.resolvedAt ? "reopen" : "resolve"}`,
        jsonRequest({}),
      ),
    onMutate: cancelCommentRefetch,
    onSuccess: async ({ comment: next }) => await cacheComment(next),
  });
  const editMutation = useMutation({
    mutationFn: async ({ postId, body }: { postId: string; body: string }) =>
      await api<{ post: CommentPost; comment: ReviewComment }>(
        `/api/comments/${comment.id}/posts/${postId}`,
        {
          ...jsonRequest({ body }),
          method: "PATCH",
        },
      ),
    onMutate: cancelCommentRefetch,
    onSuccess: async ({ comment: next }) => {
      setEditingPostId(null);
      setEditBody("");
      await cacheComment(next);
    },
  });
  const deleteReplyMutation = useMutation({
    mutationFn: async (postId: string) =>
      await api<{ deleted: { commentId: string; postId: string }; comment: ReviewComment }>(
        `/api/comments/${comment.id}/posts/${postId}`,
        {
          ...jsonRequest({}),
          method: "DELETE",
        },
      ),
    onMutate: cancelCommentRefetch,
    onSuccess: async ({ comment: next }) => {
      setOpenMenuPostId(null);
      await cacheComment(next);
    },
  });
  const deleteThreadMutation = useMutation({
    mutationFn: async () =>
      await api(`/api/comments/${comment.id}`, {
        ...jsonRequest({}),
        method: "DELETE",
      }),
    onMutate: cancelCommentRefetch,
    onSuccess: async () => {
      deleteCommentReplyDraftsForComment(comment.pullRequestId, comment.id);
      await removeCommentFromCache(queryClient, comment.pullRequestId, comment.id);
      onDeleted?.();
    },
  });

  const copyReference = async (): Promise<void> => {
    await navigator.clipboard.writeText(
      `rvw Skillを使って、次のコメントを確認してください。\n\n${comment.ref}`,
    );
    setOpenMenuPostId(null);
    setFeedback("参照をコピーしました");
    window.setTimeout(() => setFeedback(null), 1600);
  };
  const startEditing = (post: CommentPost): void => {
    setInlineExpanded(true);
    setEditingPostId(post.id);
    setEditBody(post.body);
    setOpenMenuPostId(null);
    editMutation.reset();
  };
  const confirmDeleteThread = (): void => {
    const replyNotice = replyCount > 0 ? `\n返信${replyCount}件もすべて削除されます。` : "";
    const confirmed = window.confirm(
      `このコメントスレッドを削除します。${replyNotice}\nコピー済みの参照は無効になります。\n\nこの操作は元に戻せません。`,
    );
    if (confirmed) deleteThreadMutation.mutate();
  };
  const confirmDeleteReply = (postId: string): void => {
    const confirmed = window.confirm("この返信を削除します。\n\nこの操作は元に戻せません。");
    if (confirmed) deleteReplyMutation.mutate(postId);
  };
  const label = targetLabel(comment, placement, side);
  const visibleLabel = variant === "inline" ? inlineTargetLabel(comment, placement, side) : label;
  const summary = (
    <>
      {variant === "inline" && (
        <span className="comment-thread-chevron" aria-hidden="true">
          {showThread ? "⌄" : "›"}
        </span>
      )}
      <span className="comment-thread-summary-copy">
        <span className="comment-thread-target">{visibleLabel}</span>
        {variant === "sidebar" && (
          <>
            {!showThread && (
              <span className="comment-thread-excerpt">{rootPost?.body ?? "コメント"}</span>
            )}
            <span className="comment-thread-meta">
              {rootPost?.authorLabel ?? "Unknown"} · {replyCount}返信 · 最終更新{" "}
              {formattedTime(comment.updatedAt)}
            </span>
          </>
        )}
      </span>
    </>
  );

  const moreMenu = (post: CommentPost, replyIndex: number) => {
    const menuLabel = post.isRoot
      ? "コメントのその他の操作"
      : `${replyIndex}件目の返信のその他の操作`;
    const menuOpen = openMenuPostId === post.id;
    const positionedMenu = menuPosition?.postId === post.id ? menuPosition : null;
    return (
      <div className="comment-more" data-comment-menu={post.id}>
        <button
          className="comment-more-trigger"
          aria-label={menuLabel}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuPosition(null);
            setOpenMenuPostId((current) => (current === post.id ? null : post.id));
          }}
        >
          …
        </button>
        {menuOpen && (
          <div
            className={`comment-more-menu${positionedMenu?.opensUpward ? " opens-upward" : ""}`}
            role="menu"
            aria-label={menuLabel}
            popover="manual"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget
                  .closest<HTMLElement>("[data-comment-menu]")
                  ?.querySelector<HTMLElement>(".comment-more-trigger")
                  ?.focus();
                setOpenMenuPostId(null);
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"),
              );
              if (items.length === 0) return;
              event.preventDefault();
              const currentIndex = items.indexOf(document.activeElement as HTMLElement);
              const nextIndex =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : event.key === "ArrowUp"
                      ? (currentIndex - 1 + items.length) % items.length
                      : (currentIndex + 1) % items.length;
              items[nextIndex]?.focus();
            }}
            style={{
              top: positionedMenu?.top ?? 0,
              left: positionedMenu?.left ?? 0,
              visibility: positionedMenu ? "visible" : "hidden",
            }}
          >
            {post.isRoot && (
              <button role="menuitem" onClick={() => void copyReference()}>
                参照をコピー
              </button>
            )}
            <button role="menuitem" onClick={() => startEditing(post)}>
              編集
            </button>
            {post.isRoot ? (
              <button className="is-danger" role="menuitem" onClick={confirmDeleteThread}>
                削除
              </button>
            ) : (
              <button
                className="is-danger"
                role="menuitem"
                onClick={() => confirmDeleteReply(post.id)}
              >
                削除
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <article
      ref={threadRef}
      className={`comment-thread comment-thread--${variant}${showThread ? " is-expanded" : " is-collapsed"}`}
      data-comment-id={comment.id}
      onPointerEnter={() => onActiveChange?.(comment.id, true)}
      onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) {
          onActiveChange?.(comment.id, false);
        }
      }}
      onFocusCapture={() => onActiveChange?.(comment.id, true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (
          (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) &&
          !event.currentTarget.matches(":hover")
        ) {
          onActiveChange?.(comment.id, false);
        }
      }}
    >
      <header className="comment-thread-header">
        {variant === "inline" ? (
          <button
            className="comment-thread-toggle"
            aria-expanded={showThread}
            aria-label={`${label}のコメントを${showThread ? "折りたたむ" : "展開"}`}
            onClick={() =>
              setInlineExpanded((expanded) => {
                const next = !expanded;
                inlineExpansionByComment.set(comment.id, {
                  expanded: next,
                  commentUpdatedAt: comment.updatedAt,
                });
                return next;
              })
            }
          >
            {summary}
          </button>
        ) : (
          <div className="comment-thread-summary">{summary}</div>
        )}
        <div className="comment-thread-header-actions">
          {!showThread && feedback && (
            <span className="comment-action-feedback comment-action-feedback--header" role="status">
              {feedback}
            </span>
          )}
          <div className="comment-thread-badges">
            {placementOutdated && <span className="badge badge--outdated">Outdated</span>}
            {(variant === "sidebar" || comment.resolvedAt) && (
              <span className={comment.resolvedAt ? "badge badge--resolved" : "badge"}>
                {comment.resolvedAt ? "解決済み" : "未解決"}
              </span>
            )}
          </div>
          {rootPost && moreMenu(rootPost, 0)}
        </div>
      </header>

      {showThread && (
        <div className="comment-thread-content">
          {placementOutdated && (
            <p className="comment-outdated-note">
              {comment.target.kind === "walkthrough"
                ? "現在のウォークスルーでは位置を特定できません。作成時の選択範囲を確認してください。"
                : "現在の文書では位置を特定できません。コメント対象を開くと、コメント時点の文書を確認できます。"}
            </p>
          )}
          {((comment.target.kind === "document" &&
            comment.target.documentKind === "pull-request-markdown") ||
            comment.target.kind === "walkthrough") &&
            comment.target.quotedText &&
            placementOutdated && (
              <div className="comment-source-quote">
                <small>コメント作成時の選択範囲</small>
                <pre>{comment.target.quotedText}</pre>
              </div>
            )}
          <div className="comment-posts">
            {comment.posts.map((post, index) => (
              <div className="comment-post" key={post.id}>
                <div className="comment-post-meta">
                  <span>
                    <strong>{post.authorLabel ?? "Unknown"}</strong>
                    {post.updatedAt !== post.createdAt && <small>編集済み</small>}
                  </span>
                  <span className="comment-post-meta-end">
                    <time dateTime={post.createdAt}>{formattedTime(post.createdAt)}</time>
                    {!post.isRoot && moreMenu(post, index)}
                  </span>
                </div>
                {editingPostId === post.id ? (
                  <div className="comment-edit-composer">
                    <textarea
                      autoFocus
                      rows={3}
                      value={editBody}
                      aria-label={post.isRoot ? "コメントを編集" : "返信を編集"}
                      onChange={(event) => setEditBody(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          cancelDraftOnEscape &&
                          event.key === "Escape" &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                          setEditingPostId(null);
                          setEditBody("");
                          editMutation.reset();
                          return;
                        }
                        handleCommentSubmitShortcut(
                          event,
                          Boolean(editBody.trim()) && !editMutation.isPending,
                          () => editMutation.mutate({ postId: post.id, body: editBody }),
                        );
                      }}
                    />
                    <div className="comment-edit-actions">
                      <button
                        className="button--quiet"
                        disabled={editMutation.isPending}
                        onClick={() => {
                          setEditingPostId(null);
                          setEditBody("");
                          editMutation.reset();
                        }}
                      >
                        キャンセル
                      </button>
                      <button
                        disabled={!editBody.trim() || editMutation.isPending}
                        onClick={() => editMutation.mutate({ postId: post.id, body: editBody })}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <CommentPostMarkdown
                    comment={comment}
                    post={post}
                    markdownSourceOid={markdownSourceOid}
                    themePreference={themePreference}
                    mermaidReviewDisabled={mermaidReviewDisabled}
                    onOpenCodeReference={onOpenCodeReference}
                    onOpenRepositoryLink={onOpenRepositoryLink}
                  />
                )}
                {post.relatedCommitOid && <small>commit {post.relatedCommitOid.slice(0, 8)}</small>}
              </div>
            ))}
          </div>

          <div className="comment-reply-composer">
            <textarea
              ref={replyInputRef}
              value={reply}
              onChange={(event) => {
                const current = readCommentReplyDraft(comment.pullRequestId, replyDraftKey);
                writeCommentReplyDraft(comment.pullRequestId, replyDraftKey, {
                  ...current,
                  body: event.target.value,
                });
              }}
              onFocus={() => {
                const current = readCommentReplyDraft(comment.pullRequestId, replyDraftKey);
                writeCommentReplyDraft(comment.pullRequestId, replyDraftKey, {
                  ...current,
                  focused: true,
                });
              }}
              onBlur={() => {
                const current = readCommentReplyDraft(comment.pullRequestId, replyDraftKey);
                writeCommentReplyDraft(comment.pullRequestId, replyDraftKey, {
                  ...current,
                  focused: false,
                });
              }}
              onKeyDown={(event) => {
                if (
                  cancelDraftOnEscape &&
                  event.key === "Escape" &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  const current = readCommentReplyDraft(comment.pullRequestId, replyDraftKey);
                  writeCommentReplyDraft(comment.pullRequestId, replyDraftKey, {
                    ...current,
                    body: "",
                    focused: false,
                  });
                  event.currentTarget.blur();
                  return;
                }
                handleCommentSubmitShortcut(
                  event,
                  Boolean(reply.trim()) && !replyMutation.isPending,
                  () => replyMutation.mutate(),
                );
              }}
              placeholder="返信を入力"
              aria-label={`${label}へ返信`}
              rows={1}
            />
            <button
              aria-label={`${label}の${variant === "sidebar" ? "サイドバー" : "コード内"}から返信を送信`}
              disabled={!reply.trim() || replyMutation.isPending}
              onClick={() => replyMutation.mutate()}
            >
              返信
            </button>
          </div>

          <div className="comment-actions">
            <button
              className="button--quiet"
              disabled={stateMutation.isPending}
              onClick={() => stateMutation.mutate()}
            >
              {comment.resolvedAt ? "再度開く" : "解決"}
            </button>
            {onOpenTarget && (
              <button
                className="button--quiet"
                onMouseDown={(event) => {
                  if (!event.metaKey && !event.ctrlKey) return;
                  event.preventDefault();
                  onOpenTarget(true);
                }}
                onClick={(event) => {
                  if (!event.metaKey && !event.ctrlKey) onOpenTarget(false);
                }}
                onContextMenu={(event) => {
                  if (event.ctrlKey || event.metaKey) event.preventDefault();
                }}
              >
                {navigationLabel(comment)}
              </button>
            )}
            {feedback && (
              <span className="comment-action-feedback" role="status">
                {feedback}
              </span>
            )}
          </div>
          <ErrorNotice
            error={
              replyMutation.error ??
              stateMutation.error ??
              editMutation.error ??
              deleteReplyMutation.error ??
              deleteThreadMutation.error
            }
          />
        </div>
      )}
    </article>
  );
}
