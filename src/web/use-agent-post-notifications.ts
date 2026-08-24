import { useCallback, useEffect, useRef, useState } from "react";
import type { AnyReviewComment, ReviewKind } from "./review-context.js";
import {
  agentNotificationAuthor,
  agentNotificationBody,
  browserNotificationPermission,
  readAgentNotificationsEnabled,
  scanAgentPostNotifications,
  storeAgentNotificationsEnabled,
} from "./agent-notifications.js";

export type AgentNotificationStatus = "active" | "inactive" | "denied" | "unsupported";

export function useAgentPostNotifications({
  reviewKind,
  reviewId,
  comments,
  commentsReady,
  showFeedback,
}: {
  reviewKind: ReviewKind;
  reviewId: string | null;
  comments: AnyReviewComment[];
  commentsReady: boolean;
  showFeedback: (message: string) => void;
}): {
  status: AgentNotificationStatus;
  toggle: () => Promise<void>;
} {
  const [enabled, setEnabled] = useState(readAgentNotificationsEnabled);
  const observedReviewKey = useRef<string | null>(null);
  const observedSnapshot = useRef<Map<string, string> | null>(null);
  const permission = browserNotificationPermission();
  const active = enabled && permission === "granted";

  const toggle = useCallback(async (): Promise<void> => {
    const currentPermission = browserNotificationPermission();
    if (enabled && currentPermission === "granted") {
      storeAgentNotificationsEnabled(false);
      setEnabled(false);
      showFeedback("Agentのコメント通知をオフにしました。");
      return;
    }
    if (currentPermission === "unsupported") {
      storeAgentNotificationsEnabled(false);
      setEnabled(false);
      showFeedback("このブラウザはBrowser Notificationに対応していません。");
      return;
    }
    if (currentPermission === "denied") {
      storeAgentNotificationsEnabled(false);
      setEnabled(false);
      showFeedback("ブラウザのサイト設定で通知を許可してください。");
      return;
    }
    let requestedPermission: NotificationPermission;
    try {
      requestedPermission =
        currentPermission === "granted" ? "granted" : await Notification.requestPermission();
    } catch (error) {
      console.warn("ブラウザへ通知permissionを要求できませんでした。", error);
      storeAgentNotificationsEnabled(false);
      setEnabled(false);
      showFeedback("通知permissionを要求できませんでした。ブラウザの設定を確認してください。");
      return;
    }
    const nextEnabled = requestedPermission === "granted";
    storeAgentNotificationsEnabled(nextEnabled);
    setEnabled(nextEnabled);
    showFeedback(
      nextEnabled
        ? "Agentのコメントをブラウザ通知します。"
        : "通知は許可されませんでした。ブラウザのサイト設定から変更できます。",
    );
  }, [enabled, showFeedback]);

  useEffect(() => {
    if (!commentsReady || !reviewId) return;
    const reviewKey = `${reviewKind}:${reviewId}`;
    if (observedReviewKey.current !== reviewKey) {
      observedReviewKey.current = reviewKey;
      observedSnapshot.current = null;
    }
    const scan = scanAgentPostNotifications(observedSnapshot.current, comments);
    observedSnapshot.current = scan.snapshot;
    if (!enabled || browserNotificationPermission() !== "granted") return;
    for (const { post } of scan.notifications) {
      try {
        const notification = new Notification(`rvw · ${agentNotificationAuthor(post)}`, {
          body: agentNotificationBody(post.body),
          tag: `rvw-agent-post:${reviewKind}:${reviewId}:${post.id}`,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch (error) {
        console.warn("Agentのコメントをブラウザ通知できませんでした。", error);
      }
    }
  }, [comments, commentsReady, enabled, reviewId, reviewKind]);

  return {
    status: active
      ? "active"
      : permission === "denied"
        ? "denied"
        : permission === "unsupported"
          ? "unsupported"
          : "inactive",
    toggle,
  };
}
