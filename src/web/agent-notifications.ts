import type { CommentPost, ReviewComment } from "../domain/models.js";

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

export function notificationPermissionLabel(
  permission: NotificationPermission | "unsupported",
): string {
  switch (permission) {
    case "default":
      return "未確認";
    case "granted":
      return "許可";
    case "denied":
      return "拒否";
    case "unsupported":
      return "未対応";
  }
}

export function isNotifiableAgentPost(post: CommentPost): boolean {
  const authorLabel = post.authorLabel?.trim();
  return Boolean(
    post.lastModifiedBy === "agent" &&
    authorLabel &&
    authorLabel !== "You" &&
    authorLabel !== "Unknown" &&
    post.body.trim() !== agentAcknowledgementBody,
  );
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
  comments: ReviewComment[],
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
