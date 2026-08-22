import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeReference, CommentPlacement } from "../../domain/models.js";
import { api, jsonRequest, type PlacementResponse } from "../api.js";
import {
  reviewCommentPayload,
  type AnyReviewComment,
  type AnyWalkthroughSummary,
  type ReviewIdentity,
} from "../review-context.js";
import type { ThemePreference } from "../theme.js";
import { reviewQueryKeys } from "../review-query-keys.js";
import { handleCommentSubmitShortcut } from "./CommentComposer.js";
import { CommentThread } from "./CommentThread.js";
import { ErrorNotice } from "./ErrorNotice.js";

function selectionLabel(comment: AnyReviewComment): string {
  if (comment.target.kind === "pull-request") return "Pull Request全体";
  if (comment.target.kind === "branch") return "Branch Review全体";
  if (comment.target.kind === "walkthrough") return comment.target.walkthroughTitle;
  if (comment.target.kind === "issue")
    return `#${comment.target.issueNumber} ${comment.target.issueTitle}`;
  return comment.target.documentKind === "pull-request-markdown"
    ? "Pull Request.md"
    : comment.target.path;
}

function CommentCard({
  comment,
  review,
  loadPlacement,
  selected,
  markdownSourceOid,
  themePreference,
  onSelect,
  onCommentActiveChange,
  onOpenCodeReference,
  onOpenTarget,
  onOpenRepositoryLink,
  onDeleted,
}: {
  comment: AnyReviewComment;
  review: ReviewIdentity;
  loadPlacement: (comment: AnyReviewComment) => Promise<CommentPlacement>;
  selected: boolean;
  markdownSourceOid?: string | undefined;
  themePreference: ThemePreference;
  onSelect: (selected: boolean) => void;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onOpenCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onOpenTarget: (placement: CommentPlacement | null, openInRightPane: boolean) => void;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
  onDeleted: () => void;
}) {
  const placement = useQuery({
    queryKey: reviewQueryKeys.commentPlacement(
      review.kind,
      review.id,
      comment.id,
      review.sourceOid,
    ),
    queryFn: async () => ({ placement: await loadPlacement(comment) }),
  });
  return (
    <div
      className={`comment-list-item${selected ? " is-selected" : ""}`}
      onClick={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("button, input, textarea, select, a, label, [role='menuitem']")) return;
        if (!target.closest(".comment-thread")) return;
        if (!window.getSelection()?.isCollapsed) return;
        onSelect(!selected);
      }}
    >
      <label className="comment-select-toggle">
        <input
          type="checkbox"
          checked={selected}
          aria-label={`${selectionLabel(comment)}のコメントを選択`}
          onChange={(event) => onSelect(event.target.checked)}
        />
      </label>
      <CommentThread
        comment={comment}
        variant="sidebar"
        placement={placement.data?.placement ?? null}
        markdownSourceOid={markdownSourceOid}
        themePreference={themePreference}
        onActiveChange={onCommentActiveChange}
        onOpenCodeReference={onOpenCodeReference}
        onOpenTarget={(openInRightPane) =>
          onOpenTarget(placement.data?.placement ?? null, openInRightPane)
        }
        onOpenRepositoryLink={onOpenRepositoryLink}
        onDeleted={onDeleted}
      />
      {placement.error && <ErrorNotice error={placement.error} />}
    </div>
  );
}

export function CommentSidebar({
  comments,
  walkthroughs,
  review,
  loadPlacement,
  themePreference,
  onCommentActiveChange,
  onOpenCodeReference,
  onOpenTarget,
  onOpenRepositoryLink,
}: {
  comments: AnyReviewComment[];
  walkthroughs: AnyWalkthroughSummary[];
  review: ReviewIdentity;
  loadPlacement?: (comment: AnyReviewComment) => Promise<CommentPlacement>;
  themePreference: ThemePreference;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onOpenCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInRightPane: boolean,
  ) => Promise<string | null>;
  onOpenTarget: (
    comment: AnyReviewComment,
    placement: CommentPlacement | null,
    openInRightPane: boolean,
  ) => void;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInRightPane: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [selected, setSelected] = useState(() => new Set<string>());
  const [reviewComposerOpen, setReviewComposerOpen] = useState(false);
  const [reviewComment, setReviewComment] = useState("");
  const [copyFeedback, setCopyFeedback] = useState(false);
  const unresolvedCount = comments.filter((comment) => comment.resolvedAt === null).length;
  const resolvedCount = comments.length - unresolvedCount;
  const visible = useMemo(
    () =>
      comments.filter((comment) =>
        showResolved ? comment.resolvedAt !== null : comment.resolvedAt === null,
      ),
    [comments, showResolved],
  );
  const selectedComments = visible.filter((comment) => selected.has(comment.id));
  const walkthroughSourceOids = useMemo(
    () => new Map(walkthroughs.map((walkthrough) => [walkthrough.id, walkthrough.sourceOid])),
    [walkthroughs],
  );
  const allSelected = visible.length > 0 && selectedComments.length === visible.length;
  const someSelected = selectedComments.length > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const defaultLoadPlacement = async (comment: AnyReviewComment): Promise<CommentPlacement> =>
    (
      await api<PlacementResponse>(
        `/api/comments/${comment.id}/placement?kind=commit&${review.kind === "pull-request" ? "pullRequestId" : "branchReviewId"}=${review.id}&oid=${review.sourceOid}`,
      )
    ).placement;
  const createReviewComment = useMutation({
    mutationFn: async () =>
      await api(
        "/api/comments",
        jsonRequest({
          ...reviewCommentPayload(review),
          target: { kind: review.kind === "pull-request" ? "pull-request" : "branch" },
          body: reviewComment,
          authorLabel: "You",
        }),
      ),
    onSuccess: async () => {
      setReviewComment("");
      setReviewComposerOpen(false);
      await queryClient.invalidateQueries({ queryKey: reviewQueryKeys.allComments() });
      await queryClient.invalidateQueries({ queryKey: reviewQueryKeys.changeSequence() });
    },
  });

  const copySelectedReferences = async (): Promise<void> => {
    await navigator.clipboard.writeText(
      `rvw Skillを使って、次のコメントを確認してください。\n\n${selectedComments.map((comment) => comment.ref).join("\n")}`,
    );
    setCopyFeedback(true);
    window.setTimeout(() => setCopyFeedback(false), 1600);
  };
  const changeStateFilter = (resolved: boolean): void => {
    setShowResolved(resolved);
    setSelected(new Set());
  };
  const closeReviewComposer = (): void => {
    setReviewComment("");
    setReviewComposerOpen(false);
    createReviewComment.reset();
  };

  return (
    <section className="comment-sidebar">
      <div className="segmented comment-state-filter">
        <button className={!showResolved ? "active" : ""} onClick={() => changeStateFilter(false)}>
          未解決 <span>{unresolvedCount}</span>
        </button>
        <button className={showResolved ? "active" : ""} onClick={() => changeStateFilter(true)}>
          解決済み <span>{resolvedCount}</span>
        </button>
      </div>
      <div className="comment-list-toolbar">
        {visible.length > 0 && (
          <label className="comment-select-all">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              onChange={(event) =>
                setSelected(
                  event.target.checked ? new Set(visible.map((comment) => comment.id)) : new Set(),
                )
              }
            />
            すべて選択
          </label>
        )}
        <button
          className="button--quiet comment-review-create"
          aria-expanded={reviewComposerOpen}
          onClick={() => setReviewComposerOpen((open) => !open)}
        >
          ＋ {review.kind === "pull-request" ? "PR全体" : "Branch全体"}
        </button>
      </div>
      {reviewComposerOpen && (
        <div className="review-comment-composer">
          <label>
            {review.kind === "pull-request" ? "Pull Request" : "Branch Review"}全体へコメント
          </label>
          <textarea
            autoFocus
            rows={3}
            value={reviewComment}
            onChange={(event) => setReviewComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                closeReviewComposer();
                return;
              }
              handleCommentSubmitShortcut(
                event,
                Boolean(reviewComment.trim()) && !createReviewComment.isPending,
                () => createReviewComment.mutate(),
              );
            }}
            placeholder={`${review.kind === "pull-request" ? "Pull Request" : "Branch Review"}全体へのコメント`}
          />
          <div className="review-comment-actions">
            <button
              className="button--quiet"
              disabled={createReviewComment.isPending}
              onClick={closeReviewComposer}
            >
              キャンセル
            </button>
            <button
              disabled={!reviewComment.trim() || createReviewComment.isPending}
              onClick={() => createReviewComment.mutate()}
            >
              コメント
            </button>
          </div>
          <ErrorNotice error={createReviewComment.error} />
        </div>
      )}
      <div className="comment-list">
        {visible.length === 0 && <p className="empty-state">コメントはありません。</p>}
        {visible.map((comment) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            review={review}
            loadPlacement={loadPlacement ?? defaultLoadPlacement}
            selected={selected.has(comment.id)}
            markdownSourceOid={
              comment.target.kind === "walkthrough"
                ? walkthroughSourceOids.get(comment.target.walkthroughId)
                : undefined
            }
            themePreference={themePreference}
            onCommentActiveChange={onCommentActiveChange}
            onOpenCodeReference={onOpenCodeReference}
            onSelect={(checked) => {
              const next = new Set(selected);
              if (checked) next.add(comment.id);
              else next.delete(comment.id);
              setSelected(next);
            }}
            onOpenTarget={(placement, openInRightPane) =>
              onOpenTarget(comment, placement, openInRightPane)
            }
            onOpenRepositoryLink={onOpenRepositoryLink}
            onDeleted={() => {
              setSelected((current) => {
                const next = new Set(current);
                next.delete(comment.id);
                return next;
              });
            }}
          />
        ))}
      </div>
      {selectedComments.length > 0 && (
        <button
          className="button--wide comment-copy-selection"
          onClick={() => void copySelectedReferences()}
        >
          {copyFeedback ? "コピーしました" : `選択した${selectedComments.length}件の参照をコピー`}
        </button>
      )}
    </section>
  );
}
