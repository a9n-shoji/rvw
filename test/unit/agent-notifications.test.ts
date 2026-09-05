import { describe, expect, it } from "vitest";
import type { CommentPost, ReviewComment } from "../../src/domain/models.js";
import {
  agentAcknowledgementBody,
  agentNotificationBody,
  isNotifiableAgentPost,
  notificationPermissionLabel,
  scanAgentPostNotifications,
} from "../../src/web/agent-notifications.js";

function post(
  id: string,
  authorLabel: string | null,
  body: string,
  updatedAt = "2026-08-24T01:00:00.000Z",
  lastModifiedBy: CommentPost["lastModifiedBy"] = "agent",
): CommentPost {
  return {
    id,
    commentId: "comment-1",
    body,
    relatedCommitOid: null,
    references: [],
    authorLabel,
    lastModifiedBy,
    isRoot: id === "root",
    createdAt: "2026-08-24T01:00:00.000Z",
    updatedAt,
  };
}

function comment(posts: CommentPost[]): ReviewComment {
  return {
    id: "comment-1",
    ref: "rvw://comment/comment-1",
    pullRequestId: "11111111-1111-4111-8111-111111111111",
    createdHeadOid: "a".repeat(40),
    resolvedAt: null,
    createdAt: "2026-08-24T01:00:00.000Z",
    updatedAt: posts.at(-1)?.updatedAt ?? "2026-08-24T01:00:00.000Z",
    target: { kind: "pull-request" },
    posts,
  };
}

describe("Agent browser notifications", () => {
  it("uses the first comment load only as a notification baseline", () => {
    const initial = scanAgentPostNotifications(null, [comment([post("root", "Codex", "Done")])]);

    expect(initial.notifications).toEqual([]);
    expect(initial.snapshot.has("root")).toBe(true);
  });

  it("notifies only labeled Agent posts and ignores human, Unknown, and acknowledgement posts", () => {
    const initial = scanAgentPostNotifications(null, [comment([post("root", "You", "Question")])]);
    const agent = post("agent", "Codex", "Implemented the fix.");
    const human = post("human", "You", "Thanks");
    const unknown = post("unknown", null, "Unattributed post");
    const labeledUnknown = post("labeled-unknown", "Unknown", "Unattributed post");
    const humanEdit = post("human-edit", "Codex", "Edited in the browser", undefined, "human");
    const legacy = post("legacy", "Codex", "Legacy post", undefined, null);
    const acknowledgement = post("ack", "Codex", agentAcknowledgementBody);

    expect(isNotifiableAgentPost(agent)).toBe(true);
    expect(isNotifiableAgentPost(human)).toBe(false);
    expect(isNotifiableAgentPost(unknown)).toBe(false);
    expect(isNotifiableAgentPost(labeledUnknown)).toBe(false);
    expect(isNotifiableAgentPost(humanEdit)).toBe(false);
    expect(isNotifiableAgentPost(legacy)).toBe(false);
    expect(isNotifiableAgentPost(acknowledgement)).toBe(false);
    expect(
      scanAgentPostNotifications(initial.snapshot, [
        comment([
          post("root", "You", "Question"),
          agent,
          human,
          unknown,
          labeledUnknown,
          humanEdit,
          legacy,
          acknowledgement,
        ]),
      ]).notifications.map(({ post: candidate }) => candidate.id),
    ).toEqual(["agent"]);
  });

  it("notifies when an acknowledgement is edited into the Agent's final answer", () => {
    const acknowledgement = post("status", "Codex", agentAcknowledgementBody);
    const initial = scanAgentPostNotifications(null, [comment([acknowledgement])]);
    const acknowledged = scanAgentPostNotifications(initial.snapshot, [comment([acknowledgement])]);
    const completed = scanAgentPostNotifications(acknowledged.snapshot, [
      comment([
        post("status", "Codex", "The investigation is complete.", "2026-08-24T01:01:00.000Z"),
      ]),
    ]);

    expect(acknowledged.notifications).toEqual([]);
    expect(completed.notifications.map(({ post: candidate }) => candidate.body)).toEqual([
      "The investigation is complete.",
    ]);
  });

  it("does not repeat a notification for an idempotent Agent edit", () => {
    const completed = post("status", "Codex", "The investigation is complete.");
    const initial = scanAgentPostNotifications(null, [comment([completed])]);
    const retry = scanAgentPostNotifications(initial.snapshot, [
      comment([
        post("status", "Codex", "The investigation is complete.", "2026-08-24T01:01:00.000Z"),
      ]),
    ]);

    expect(retry.notifications).toEqual([]);
  });

  it("keeps notification previews compact", () => {
    expect(agentNotificationBody("first\n\nsecond", 20)).toBe("first second");
    expect(agentNotificationBody("1234567890", 6)).toBe("12345…");
  });

  it("labels every browser notification permission state", () => {
    expect(notificationPermissionLabel("default")).toBe("未確認");
    expect(notificationPermissionLabel("granted")).toBe("許可");
    expect(notificationPermissionLabel("denied")).toBe("拒否");
    expect(notificationPermissionLabel("unsupported")).toBe("未対応");
  });
});
