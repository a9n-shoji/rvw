import { useQueries } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { api, type CommentsResponse } from "../api.js";
import {
  commentReplyDraftEntriesSnapshot,
  readCommentReplyDraft,
  subscribeCommentReplyDrafts,
  writeCommentReplyDraft,
} from "../comment-draft-store.js";

// Kept outside filtered feed groups so recovery survives filtering and navigation.
export function DeletedCommentDrafts() {
  const snapshot = useSyncExternalStore(
    subscribeCommentReplyDrafts,
    commentReplyDraftEntriesSnapshot,
  );
  const drafts = JSON.parse(snapshot) as Array<{
    pullRequestId: string;
    contextKey: string;
    body: string;
  }>;
  const ids = [...new Set(drafts.map((draft) => draft.pullRequestId))];
  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["comments", id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<CommentsResponse>(`/api/pull-requests/${id}/comments?resolved=all`, { signal }),
      refetchInterval: 1000,
    })),
  });
  const [copyStatus, setCopyStatus] = useState("");
  const missing = drafts.filter((draft) => {
    const data = queries[ids.indexOf(draft.pullRequestId)]?.data;
    const commentId = draft.contextKey.slice(draft.contextKey.lastIndexOf(":") + 1);
    return data && !data.comments.some((comment) => comment.id === commentId);
  });
  if (!missing.length) return null;
  return (
    <aside className="deleted-comment-drafts" aria-label="削除されたスレッドの下書き">
      <h2>削除されたスレッドの下書き</h2>
      <p>返信先が削除されました。本文をコピーして保存するか、不要なら破棄してください。</p>
      {missing.map((draft) => (
        <div key={`${draft.pullRequestId}:${draft.contextKey}`}>
          <textarea aria-label="未送信の返信本文" value={draft.body} readOnly rows={3} />
          <button
            onClick={() => {
              void navigator.clipboard.writeText(draft.body).then(
                () => setCopyStatus("コピーしました"),
                () => setCopyStatus("コピーできませんでした。本文を選択してコピーしてください。"),
              );
            }}
          >
            本文をコピー
          </button>
          <button
            onClick={() => {
              writeCommentReplyDraft(draft.pullRequestId, draft.contextKey, {
                ...readCommentReplyDraft(draft.pullRequestId, draft.contextKey),
                body: "",
                focused: false,
              });
            }}
          >
            下書きを破棄
          </button>
        </div>
      ))}
      <p role="status">{copyStatus}</p>
    </aside>
  );
}
