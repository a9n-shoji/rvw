import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CodeReference,
  CommentPlacement,
  ReviewComment,
  WalkthroughSummary,
} from "../../domain/models.js";
import { api, jsonRequest, type PlacementResponse } from "../api.js";
import type { ThemePreference } from "../theme.js";
import { handleCommentSubmitShortcut } from "./CommentComposer.js";
import { CommentThread } from "./CommentThread.js";
import { ErrorNotice } from "./ErrorNotice.js";

function selectionLabel(comment: ReviewComment): string {
  if (comment.target.kind === "pull-request") return "Pull Request全体";
  if (comment.target.kind === "walkthrough") return comment.target.walkthroughTitle;
  if (comment.target.kind === "issue")
    return `#${comment.target.issueNumber} ${comment.target.issueTitle}`;
  return comment.target.documentKind === "pull-request-markdown"
    ? "Pull Request.md"
    : comment.target.path;
}

function CommentCard({
  comment,
  pullRequestId,
  selectedOid,
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
  comment: ReviewComment;
  pullRequestId: string;
  selectedOid: string;
  selected: boolean;
  markdownSourceOid?: string | undefined;
  themePreference: ThemePreference;
  onSelect: (selected: boolean) => void;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onOpenCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInOtherPane: boolean,
  ) => Promise<string | null>;
  onOpenTarget: (placement: CommentPlacement | null) => void;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInOtherPane: boolean) => void;
  onDeleted: () => void;
}) {
  const placement = useQuery({
    queryKey: ["comment-placement", comment.id, selectedOid],
    queryFn: async () =>
      await api<PlacementResponse>(
        `/api/comments/${comment.id}/placement?kind=commit&pullRequestId=${pullRequestId}&oid=${selectedOid}`,
      ),
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
        onOpenTarget={() => onOpenTarget(placement.data?.placement ?? null)}
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
  pullRequestId,
  selectedOid,
  themePreference,
  onCommentActiveChange,
  onOpenCodeReference,
  onOpenTarget,
  onOpenRepositoryLink,
}: {
  comments: ReviewComment[];
  walkthroughs: WalkthroughSummary[];
  pullRequestId: string;
  selectedOid: string;
  themePreference: ThemePreference;
  onCommentActiveChange: (commentId: string, active: boolean) => void;
  onOpenCodeReference: (
    sourceOid: string,
    reference: CodeReference,
    openInOtherPane: boolean,
  ) => Promise<string | null>;
  onOpenTarget: (comment: ReviewComment, placement: CommentPlacement | null) => void;
  onOpenRepositoryLink: (path: string, sourceOid: string, openInOtherPane: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [selected, setSelected] = useState(() => new Set<string>());
  const [prComposerOpen, setPrComposerOpen] = useState(false);
  const [prComment, setPrComment] = useState("");
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

  const createPrComment = useMutation({
    mutationFn: async () =>
      await api(
        "/api/comments",
        jsonRequest({
          pullRequestId,
          target: { kind: "pull-request" },
          body: prComment,
          authorLabel: "You",
        }),
      ),
    onSuccess: async () => {
      setPrComment("");
      setPrComposerOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["comments"] });
      await queryClient.invalidateQueries({ queryKey: ["change-sequence"] });
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
  const closePrComposer = (): void => {
    setPrComment("");
    setPrComposerOpen(false);
    createPrComment.reset();
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
          className="button--quiet comment-pr-create"
          aria-expanded={prComposerOpen}
          onClick={() => setPrComposerOpen((open) => !open)}
        >
          ＋ PR全体
        </button>
      </div>
      {prComposerOpen && (
        <div className="pr-comment-composer">
          <label>Pull Request全体へコメント</label>
          <textarea
            autoFocus
            rows={3}
            value={prComment}
            onChange={(event) => setPrComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                closePrComposer();
                return;
              }
              handleCommentSubmitShortcut(
                event,
                Boolean(prComment.trim()) && !createPrComment.isPending,
                () => createPrComment.mutate(),
              );
            }}
            placeholder="Pull Request全体へのコメント"
          />
          <div className="pr-comment-actions">
            <button
              className="button--quiet"
              disabled={createPrComment.isPending}
              onClick={closePrComposer}
            >
              キャンセル
            </button>
            <button
              disabled={!prComment.trim() || createPrComment.isPending}
              onClick={() => createPrComment.mutate()}
            >
              コメント
            </button>
          </div>
          <ErrorNotice error={createPrComment.error} />
        </div>
      )}
      <div className="comment-list">
        {visible.length === 0 && <p className="empty-state">コメントはありません。</p>}
        {visible.map((comment) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            pullRequestId={pullRequestId}
            selectedOid={selectedOid}
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
            onOpenTarget={(placement) => onOpenTarget(comment, placement)}
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
