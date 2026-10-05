import { expect, test, type APIRequestContext } from "@playwright/test";
import type { ReviewComment } from "../../src/domain/models.js";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const created: string[] = [];
async function create(
  request: APIRequestContext,
  body: string,
  code = false,
): Promise<ReviewComment> {
  const response = await request.post("/api/comments", {
    data: {
      pullRequestId,
      body,
      authorLabel: "Feed reviewer",
      target: code
        ? {
            kind: "document",
            documentKind: "repository-file",
            sourceOid: "b".repeat(40),
            path: "src/fixture.ts",
            startLine: 2,
            endLine: 3,
          }
        : { kind: "pull-request" },
    },
  });
  expect(response.ok()).toBeTruthy();
  const { comment } = (await response.json()) as { comment: ReviewComment };
  created.push(comment.id);
  return comment;
}
test.afterEach(async ({ request }) => {
  for (const id of created.splice(0)) await request.delete(`/api/comments/${id}`, { data: {} });
});

test("reads full conversations, collapses groups, searches replies, and replies without leaving the feed", async ({
  page,
  request,
}) => {
  const comment = await create(
    request,
    "Feed original full body\n\nSecond paragraph visible immediately.",
  );
  await request.post(`/api/comments/${comment.id}/posts`, {
    data: { body: "Unique needle in the reply", authorLabel: "Agent" },
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Comments", exact: true }).click();
  const feed = page.locator(".comment-feed-screen");
  const thread = feed.locator(`[data-feed-comment-id="${comment.id}"]`);
  await expect(thread.getByText("Second paragraph visible immediately.")).toBeVisible();
  await expect(thread.getByText("Unique needle in the reply")).toBeVisible();
  await thread.getByRole("textbox").fill("Draft survives folding");
  await feed.getByRole("button", { name: "すべて折りたたむ" }).click();
  await expect(thread).toBeHidden();
  await feed.getByRole("button", { name: "すべて展開" }).click();
  await expect(thread.getByRole("textbox")).toHaveValue("Draft survives folding");
  await expect(feed.locator(".comment-feed-group-header").getByText("下書き 1件")).toBeVisible();
  await thread.getByRole("button", { name: /のスレッドを折りたたむ/ }).click();
  await expect(thread.getByText("下書き", { exact: true })).toBeVisible();
  await expect(thread.locator(".comment-feed-collapsed")).toContainText("1返信");
  await thread.getByRole("button", { name: /のスレッドを展開/ }).click();
  const searched = page.waitForResponse(
    (response) =>
      response.url().includes("/api/comment-feed?") &&
      new URL(response.url()).searchParams.get("search") === "Unique needle",
  );
  await feed.getByRole("searchbox").fill("Unique needle");
  await searched;
  await expect(feed.locator(".comment-feed-thread")).toHaveCount(1);
  await expect(thread.getByRole("textbox")).toHaveValue("Draft survives folding");
  await thread.getByRole("button", { name: /から返信を送信/ }).click();
  await expect(thread.locator(".comment-post").getByText("Draft survives folding")).toBeVisible();
  await expect(thread.getByRole("textbox")).toHaveValue("");
  await expect(feed.locator(".comment-feed-draft")).toHaveCount(0);
  await expect(page).toHaveURL(/view=comments/);
  await thread.getByRole("button", { name: "解決", exact: true }).click();
  await expect(thread.getByText("解決済み", { exact: true })).toBeVisible();
  await expect(thread).toBeVisible();
  await feed.getByRole("button", { name: "新しい更新を反映" }).click();
  await expect(thread).toHaveCount(0);
  await feed.getByRole("combobox", { name: "コメント状態" }).selectOption("resolved");
  await expect(thread).toBeVisible();
  await thread.getByRole("button", { name: "再度開く", exact: true }).click();
  await expect(thread.getByText("未解決", { exact: true })).toBeVisible();
});

test("opens exact code and a resolved thread, restores feed drafts and scroll, and supports reload", async ({
  page,
  request,
}) => {
  const comment = await create(request, "Feed code context", true);
  await request.post(`/api/comments/${comment.id}/resolve`, { data: {} });
  await page.goto("/?view=comments");
  const feed = page.locator(".comment-feed-screen");
  await feed.getByRole("combobox", { name: "コメント状態" }).selectOption("resolved");
  const thread = feed.locator(`[data-feed-comment-id="${comment.id}"]`);
  await thread.getByRole("textbox").fill("Unsent context");
  const href = await thread.getByRole("link", { name: "PRで開く" }).getAttribute("href");
  await thread.getByRole("link", { name: "PRで開く" }).click();
  await expect(page.locator(".document-tab.active")).toContainText("fixture.ts");
  await expect(page.locator(`.comment-sidebar [data-comment-id="${comment.id}"]`)).toBeVisible();
  await page.goBack();
  await expect(feed).toBeVisible();
  await expect(thread.getByRole("textbox")).toHaveValue("Unsent context");
  const guarded = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    return !window.dispatchEvent(event);
  });
  expect(guarded).toBe(true);
  await thread.getByRole("textbox").fill("");
  await page.goto(href!);
  await expect(page.locator(".document-tab.active")).toContainText("fixture.ts");
  await expect(page.locator(`.comment-sidebar [data-comment-id="${comment.id}"]`)).toBeVisible();
  await page.reload();
  await expect(page.locator(".document-tab.active")).toContainText("fixture.ts");
});

test("preserves failed replies and keeps existing thread order while external replies arrive", async ({
  page,
  request,
}) => {
  const older = await create(request, "Feed older thread");
  const newer = await create(request, "Feed newer thread");
  await page.goto("/?view=comments");
  const feed = page.locator(".comment-feed-screen");
  const thread = feed.locator(`[data-feed-comment-id="${older.id}"]`);
  await expect(thread).toBeVisible();
  const order = await feed
    .locator(".comment-feed-thread")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-feed-comment-id")));
  await request.post(`/api/comments/${older.id}/posts`, {
    data: { body: "External new reply", authorLabel: "Agent" },
  });
  await expect(thread.getByText("External new reply")).toBeVisible();
  expect(
    await feed
      .locator(".comment-feed-thread")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-feed-comment-id"))),
  ).toEqual(order);
  await page.route(`**/api/comments/${older.id}/posts`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { code: "TEST", message: "返信を保存できません" } }),
    }),
  );
  await thread.getByRole("textbox").fill("Retry this reply");
  await thread.getByRole("button", { name: /から返信を送信/ }).click();
  await expect(thread.getByText("返信を保存できません")).toBeVisible();
  await expect(thread.getByRole("textbox")).toHaveValue("Retry this reply");
  await page.unroute(`**/api/comments/${older.id}/posts`);
  await thread.getByRole("button", { name: /から返信を送信/ }).click();
  await expect(thread.locator(".comment-post").getByText("Retry this reply")).toBeVisible();
  await expect(feed.locator(`[data-feed-comment-id="${newer.id}"]`)).toBeVisible();
});

test("groups multiple PRs, appends complete groups, and retains the global collapsed setting", async ({
  page,
}) => {
  const groups = Array.from({ length: 21 }, (_, index) => {
    const id = `f0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    return {
      pullRequest: {
        id,
        owner: "feed",
        repository: "group-test",
        number: index + 1,
        title: `Group ${index + 1}`,
        githubState: "OPEN",
        githubIsDraft: false,
      },
      commentIds: [`thread-${index}`],
    };
  });
  await page.route("**/api/comment-feed?*", (route) => {
    const limit = Number(new URL(route.request().url()).searchParams.get("limit"));
    return route.fulfill({
      json: {
        ok: true,
        groups: groups.slice(0, limit),
        pullRequests: groups.map((group) => group.pullRequest),
        totalGroups: 21,
        totalComments: 21,
      },
    });
  });
  await page.route("**/api/pull-requests/f0000000-*/comments?*", (route) => {
    const pr = groups.find((group) => route.request().url().includes(group.pullRequest.id))!;
    const id = pr.commentIds[0]!;
    const now = "2026-10-05T00:00:00.000Z";
    return route.fulfill({
      json: {
        ok: true,
        comments: [
          {
            id,
            ref: `rvw://comment/${id}`,
            pullRequestId: pr.pullRequest.id,
            createdHeadOid: "b".repeat(40),
            resolvedAt: null,
            target: { kind: "pull-request" },
            createdAt: now,
            updatedAt: now,
            posts: [
              {
                id: `post-${id}`,
                commentId: id,
                body: `Conversation for ${pr.pullRequest.title}`,
                authorLabel: "Reviewer",
                isRoot: true,
                relatedCommitOid: null,
                references: [],
                lastModifiedBy: "human",
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        ],
      },
    });
  });
  await page.goto("/?view=comments");
  const feed = page.locator(".comment-feed-screen");
  await expect(feed.locator(".comment-feed-group")).toHaveCount(20);
  await expect(feed.getByText("Conversation for Group 1", { exact: true })).toBeVisible();
  await feed.getByRole("button", { name: "すべて折りたたむ" }).click();
  await feed.getByRole("button", { name: "さらに20 PRを表示" }).click();
  await expect(feed.locator(".comment-feed-group")).toHaveCount(21);
  await expect(feed.locator(".comment-feed-group-toggle[aria-expanded=false]")).toHaveCount(21);
  await feed.getByRole("button", { name: "すべて展開" }).click();
  await expect(feed.getByText("Conversation for Group 21", { exact: true })).toBeVisible();
  await expect(feed.locator(".comment-feed-group-toggle[aria-expanded=true]")).toHaveCount(21);
});

test("reports missing deep-linked comments without navigating to a guessed target", async ({
  page,
}) => {
  await page.goto(
    `/?view=comments&pullRequestId=${pullRequestId}&commentId=ffffffff-ffff-4fff-8fff-ffffffffffff`,
  );
  await expect(
    page.getByText("コメントが見つかりません。削除されたか、このPRに属していません。"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "コメントへの移動を再試行" })).toBeVisible();
});

test("keeps PR identity visible while reading and preserves the scrolled position across PR navigation", async ({
  page,
  request,
}) => {
  const comment = await create(
    request,
    "UI layout thread\n\n" +
      Array.from(
        { length: 24 },
        (_, index) => `Paragraph ${index + 1}: enough context to read a long discussion.`,
      ).join("\n\n"),
    true,
  );
  await page.setViewportSize({ width: 605, height: 853 });
  await page.goto("/?view=comments");
  const feed = page.locator(".comment-feed-screen");
  const thread = feed.locator(`[data-feed-comment-id="${comment.id}"]`);
  const scroller = feed.locator(".comment-feed-content");
  await expect(thread).toBeVisible();
  const searchBox = await feed.getByRole("searchbox").boundingBox();
  expect(searchBox?.width).toBeGreaterThan(500);
  await thread.getByRole("textbox").fill("A draft before checking code\nSecond line");
  const header = feed.locator(".comment-feed-group-header");
  await expect(header).toBeInViewport();
  const scrollerBounds = await scroller.boundingBox();
  const headerBounds = await header.boundingBox();
  expect(Math.abs(headerBounds!.y - scrollerBounds!.y)).toBeLessThan(2);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await thread.getByRole("link", { name: "PRで開く" }).scrollIntoViewIfNeeded();
  const position = await scroller.evaluate((element) => element.scrollTop);
  await thread.getByRole("link", { name: "PRで開く" }).click();
  await expect(page.locator(".document-tab.active")).toContainText("fixture.ts");
  await page.getByRole("link", { name: "コメント一覧へ", exact: true }).click();
  await expect(feed).toBeVisible();
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeCloseTo(position, 0);
  await expect(thread.getByRole("textbox")).toHaveValue(
    "A draft before checking code\nSecond line",
  );
  await thread.getByRole("textbox").fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  await feed.getByRole("searchbox").fill("no-matching-thread-here");
  await expect(
    feed.getByRole("heading", { name: "条件に一致するコメントはありません" }),
  ).toBeVisible();
  expect(await feed.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const narrowSearch = await feed.getByRole("searchbox").boundingBox();
  expect(narrowSearch?.width).toBeGreaterThan(300);
  await feed.getByRole("button", { name: "すべてのコメントを表示" }).click();
  await expect(thread).toBeVisible();
  await expect(feed.getByRole("searchbox")).toHaveValue("");
});

test("shows one connection error and retries all displayed conversations together", async ({
  page,
  request,
}) => {
  const comment = await create(request, "Keep cached conversation during disconnect");
  await page.goto("/?view=comments");
  const feed = page.locator(".comment-feed-screen");
  await expect(feed.getByText("Keep cached conversation during disconnect")).toBeVisible();
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await feed.getByRole("button", { name: "一覧を更新", exact: true }).click();
  await expect(feed.getByRole("button", { name: "接続を再試行", exact: true })).toBeVisible();
  await expect(feed.getByRole("alert")).toHaveCount(1);
  await expect(feed.getByText("Keep cached conversation during disconnect")).toBeVisible();
  await page.unroute("**/api/**");
  await request.post(`/api/comments/${comment.id}/posts`, {
    data: { body: "Reply received while disconnected", authorLabel: "Agent" },
  });
  await feed.getByRole("button", { name: "接続を再試行", exact: true }).click();
  await expect(feed.getByRole("alert")).toHaveCount(0);
  await expect(feed.getByText("Reply received while disconnected")).toBeVisible();
});
