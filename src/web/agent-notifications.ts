import type { CommentPost } from "../domain/models.js";
import type { AnyReviewComment } from "./review-context.js";

export const agentNotificationStorageKey = "rvw.agentNotifications";
export const agentAcknowledgementBody = "🔎 確認中です…";

export interface AgentPostNotification {
  post: CommentPost;
}

export interface AgentPostNotificationScan {
  notifications: AgentPostNotification[];
  snapshot: Map<string, string>;
}

export function readAgentNotificationsEnabled(): boolean {
  try {
    return window.localStorage.getItem(agentNotificationStorageKey) === "enabled";
  } catch (error) {
    console.warn("Agent通知設定を読み込めませんでした。通知をオフにします。", error);
    return false;
  }
}

export function storeAgentNotificationsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(agentNotificationStorageKey, enabled ? "enabled" : "disabled");
  } catch (error) {
    console.warn("Agent通知設定を保存できませんでした。", error);
  }
}

export function browserNotificationPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export function isNotifiableAgentPost(post: CommentPost): boolean {
  return post.lastModifiedBy === "agent" && post.body.trim() !== agentAcknowledgementBody;
}

export function agentNotificationAuthor(post: CommentPost): string {
  const authorLabel = post.authorLabel?.trim();
  return authorLabel && authorLabel !== "You" && authorLabel !== "Unknown" ? authorLabel : "Agent";
}

function postFingerprint(post: CommentPost): string {
  return JSON.stringify([
    post.body,
    post.authorLabel,
    post.lastModifiedBy,
    post.relatedCommitOid,
    post.references,
  ]);
}

export function scanAgentPostNotifications(
  previousSnapshot: ReadonlyMap<string, string> | null,
  comments: AnyReviewComment[],
): AgentPostNotificationScan {
  const snapshot = new Map<string, string>();
  const notifications: AgentPostNotification[] = [];
  for (const comment of comments) {
    for (const post of comment.posts) {
      const fingerprint = postFingerprint(post);
      snapshot.set(post.id, fingerprint);
      if (
        previousSnapshot &&
        previousSnapshot.get(post.id) !== fingerprint &&
        isNotifiableAgentPost(post)
      ) {
        notifications.push({ post });
      }
    }
  }
  return { notifications, snapshot };
}

export function agentNotificationBody(body: string, maximumCharacters = 180): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  return normalized.length <= maximumCharacters
    ? normalized
    : `${normalized.slice(0, Math.max(0, maximumCharacters - 1))}…`;
}
