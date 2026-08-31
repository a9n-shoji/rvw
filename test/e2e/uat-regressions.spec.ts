import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const unknownPullRequestId = "22222222-2222-4222-8222-222222222222";
const comparisonBase = "a".repeat(40);
const firstHead = "b".repeat(40);
const secondHead = "c".repeat(40);
const featureParentBeforeMergeBack = "d".repeat(40);

async function openWalkthroughFromSidebar(page: Page, title: string): Promise<void> {
  const walkthroughsFolder = page.getByRole("button", { name: /^ウォークスルー \d+$/ });
  if ((await walkthroughsFolder.getAttribute("aria-expanded")) !== "true") {
    await walkthroughsFolder.click();
  }
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await reviewTree.getByRole("button", { name: title, exact: true }).click();
}

async function openCommentsSidebar(page: Page): Promise<void> {
  const toggle = page.locator(".sidebar-stack--comments > .sidebar-stack-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function createFixtureFileComment(request: APIRequestContext): Promise<string> {
  const viewResponse = await request.get(`/api/pull-requests/${pullRequestId}`);
  expect(viewResponse.ok()).toBe(true);
  const { headOid } = (await viewResponse.json()) as { headOid: string };
  const createResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: headOid,
        path: "src/fixture.ts",
        startLine: 1,
        endLine: 1,
      },
      body: "ペイン移動中の返信draftを確認します。",
      authorLabel: "You",
    },
  });
  expect(createResponse.ok()).toBe(true);
  return ((await createResponse.json()) as { comment: { id: string } }).comment.id;
}

test("uses the comparison base for a PR range starting with a merge-back commit", async ({
  page,
}) => {
  const rewriteFirstCommitAsMergeBack = async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      comparisonBaseOid: string;
      commits: { parentOids: string[] }[];
    };
    body.comparisonBaseOid = comparisonBase;
    if (body.commits[0]) {
      body.commits[0].parentOids = [featureParentBeforeMergeBack, comparisonBase];
    }
    await route.fulfill({ response, json: body });
  };
  await page.route(`**/api/pull-requests/${pullRequestId}`, rewriteFirstCommitAsMergeBack);

  const requestedOldOids: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/changed-files")) {
      const oldOid = url.searchParams.get("oldOid");
      if (oldOid) requestedOldOids.push(oldOid);
    }
  });

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(page.getByRole("button", { name: /^対象commit:/ })).toBeVisible();
  await expect.poll(() => requestedOldOids.at(-1)).toBe(comparisonBase);
  expect(requestedOldOids).not.toContain(featureParentBeforeMergeBack);
});

test("uses path-specific fixture documents and a complete search index", async ({ request }) => {
  const readmeDiff = await request.get(
    `/api/pull-requests/${pullRequestId}/diff?oldOid=${firstHead}&newOid=${secondHead}&oldPath=README.md&newPath=README.md`,
  );
  expect(readmeDiff.ok()).toBe(true);
  const readmeBody = (await readmeDiff.json()) as {
    diff: { old: { text: string }; new: { text: string } };
  };
  expect(readmeBody.diff.old.text).toContain("# Orders service");
  expect(readmeBody.diff.old.text).toContain("Repository documentation.");
  expect(readmeBody.diff.new.text).toContain("Repository documentation updated.");
  expect(readmeBody.diff.new.text).not.toContain("export function fixture");

  const addedDiff = await request.get(
    `/api/pull-requests/${pullRequestId}/diff?oldOid=${firstHead}&newOid=${secondHead}&newPath=src%2Fnew.ts`,
  );
  expect(addedDiff.ok()).toBe(true);
  const addedBody = (await addedDiff.json()) as { diff: { old: null; new: { text: string } } };
  expect(addedBody.diff.old).toBeNull();
  expect(addedBody.diff.new.text).toBe("export const added = true;\n");

  const search = await request.get(
    `/api/pull-requests/${pullRequestId}/search?oid=${secondHead}&q=idempotency&matchCase=false&wholeWord=false`,
  );
  expect(search.ok()).toBe(true);
  const searchBody = (await search.json()) as {
    matchCount: number;
    results: { path: string }[];
  };
  expect(searchBody.matchCount).toBeGreaterThan(0);
  expect(searchBody.results.some((result) => result.path !== "Pull Request.md")).toBe(true);

  const historicalSearch = await request.get(
    `/api/pull-requests/${pullRequestId}/search?oid=${firstHead}&q=removed&matchCase=false&wholeWord=false`,
  );
  expect(historicalSearch.ok()).toBe(true);
  const historicalSearchBody = (await historicalSearch.json()) as {
    results: { path: string }[];
  };
  expect(historicalSearchBody.results.some((result) => result.path === "src/removed.ts")).toBe(
    true,
  );

  const notYetAdded = await request.get(
    `/api/pull-requests/${pullRequestId}/document?kind=repository-file&sourceOid=${firstHead}&path=src%2Fnew.ts`,
  );
  expect(notYetAdded.ok()).toBe(true);
  expect(
    ((await notYetAdded.json()) as { document: { availability: string } }).document.availability,
  ).toBe("missing");
});

test("rejects malformed and unknown pull request IDs", async ({ page, request }) => {
  await page.goto("/?pullRequestId=not-a-uuid");
  await expect(
    page.getByText("Pull Request IDの形式が正しくありません。", { exact: false }),
  ).toBeVisible();

  expect((await request.get("/api/pull-requests/not-a-uuid")).status()).toBe(400);
  expect((await request.get(`/api/pull-requests/${unknownPullRequestId}`)).status()).toBe(404);

  await page.goto(`/?pullRequestId=${unknownPullRequestId}`);
  await expect(
    page.getByText("Pull Requestが見つかりません。`rvw open`から起動し直してください。", {
      exact: true,
    }),
  ).toBeVisible();
});

test("restores focus to the actions button after Quick Open is closed from its menu", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const actionsButton = page.getByRole("button", { name: "その他の操作", exact: true });
  await actionsButton.click();
  await page.getByRole("menuitem", { name: /ファイルを開く/ }).click();
  const quickOpenInput = page.getByRole("combobox", { name: "ファイル名で検索" });
  await expect(quickOpenInput).toBeFocused();
  await quickOpenInput.press("Escape");
  await expect(actionsButton).toBeFocused();
});

test("supports standard keyboard navigation in the actions menu", async ({ page }) => {
  const initialRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
    );
  });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await initialRefresh;
  const actionsButton = page.getByRole("button", { name: "その他の操作", exact: true });
  await actionsButton.click();

  const menu = page.getByRole("menu");
  const quickOpen = menu.getByRole("menuitem", { name: /ファイルを開く/ });
  const sync = menu.getByRole("menuitem", { name: "GitHubと同期" });
  const rebuild = menu.getByRole("menuitem", { name: "ローカル状態を削除して再構築" });
  await expect(sync).toBeEnabled();
  await expect(quickOpen).toBeFocused();

  await quickOpen.press("ArrowDown");
  await expect(sync).toBeFocused();
  await sync.press("End");
  await expect(rebuild).toBeFocused();
  await rebuild.press("ArrowDown");
  await expect(quickOpen).toBeFocused();
  await quickOpen.press("ArrowUp");
  await expect(rebuild).toBeFocused();
  await rebuild.press("Home");
  await expect(quickOpen).toBeFocused();

  await quickOpen.press("Escape");
  await expect(menu).toBeHidden();
  await expect(actionsButton).toBeFocused();
});

test("preserves a range ending at the old head when refresh publishes a new head", async ({
  page,
  request,
}) => {
  type TestPullRequestView = {
    pullRequest: { latestHeadOid: string } & Record<string, unknown>;
    comparisonBaseOid: string;
    headOid: string;
    commits: Array<{
      oid: string;
      parentOids: string[];
      subject: string;
      authorName: string;
      authoredAt: string;
    }>;
  };
  const initialRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === `/api/pull-requests/${pullRequestId}/refresh`
    );
  });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await initialRefresh;

  const currentResponse = await request.get(`/api/pull-requests/${pullRequestId}`);
  expect(currentResponse.ok()).toBe(true);
  const current = (await currentResponse.json()) as TestPullRequestView;
  expect(current.commits.length).toBeGreaterThanOrEqual(2);
  const oldHead = current.headOid;
  const newHead = "e".repeat(40);
  const withNewHead = <View extends TestPullRequestView>(view: View): View => ({
    ...view,
    pullRequest: { ...view.pullRequest, latestHeadOid: newHead },
    headOid: newHead,
    commits: [
      ...view.commits,
      {
        oid: newHead,
        parentOids: [oldHead],
        subject: "Post-review update",
        authorName: "Fixture Author",
        authoredAt: "2026-08-08T03:00:00.000Z",
      },
    ],
  });

  let exposeNewHead = false;
  await page.route(`**/api/pull-requests/${pullRequestId}`, async (route) => {
    const response = await route.fetch();
    const view = (await response.json()) as TestPullRequestView;
    await route.fulfill({ response, json: exposeNewHead ? withNewHead(view) : view });
  });
  let releaseRefresh!: () => void;
  const refreshHeld = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let markRefreshRequested!: () => void;
  const refreshRequested = new Promise<void>((resolve) => {
    markRefreshRequested = resolve;
  });
  await page.route(`**/api/pull-requests/${pullRequestId}/refresh`, async (route) => {
    markRefreshRequested();
    await refreshHeld;
    const response = await route.fetch();
    const view = (await response.json()) as TestPullRequestView & {
      commentUpdatesApplied: number;
    };
    exposeNewHead = true;
    await route.fulfill({ response, json: withNewHead(view) });
  });

  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "GitHubと同期" }).click();
  await refreshRequested;

  const commitPicker = page.getByRole("button", { name: /^対象commit:/ });
  await commitPicker.click();
  await page
    .getByRole("dialog", { name: "対象commitを選択" })
    .getByRole("button", { name: "最新だけ", exact: true })
    .click();
  await expect(commitPicker.locator(".commit-selection-badge")).toHaveText("最新");

  releaseRefresh();
  await expect(commitPicker).toHaveAccessibleName(/Trim fixture input/);
  await expect(commitPicker).not.toHaveAccessibleName(/Post-review update/);
  await expect(commitPicker.locator(".commit-selection-badge")).toHaveCount(0);
  await commitPicker.click();
  const commitDialog = page.getByRole("dialog", { name: "対象commitを選択" });
  await expect(commitDialog.getByRole("option", { name: /Trim fixture input/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(commitDialog.getByRole("option", { name: /Post-review update/ })).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

test("notifies only after an Agent acknowledgement becomes a final reply", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    type NotificationRecord = { title: string; options?: NotificationOptions };
    class MockNotification {
      static permission: NotificationPermission = "default";
      static requestPermission(): Promise<NotificationPermission> {
        MockNotification.permission = "granted";
        return Promise.resolve(MockNotification.permission);
      }

      onclick: (() => void) | null = null;

      constructor(title: string, options?: NotificationOptions) {
        const state = window as typeof window & { rvwNotifications?: NotificationRecord[] };
        state.rvwNotifications ??= [];
        state.rvwNotifications.push(options === undefined ? { title } : { title, options });
      }

      close(): void {}
    }

    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: MockNotification,
    });
  });

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const actionsButton = page.getByRole("button", { name: "その他の操作", exact: true });
  await actionsButton.click();
  const notificationToggle = page
    .getByRole("menu")
    .getByRole("menuitemcheckbox", { name: "Agentのコメントを通知" });
  await expect(notificationToggle).toHaveAttribute("aria-checked", "false");
  await notificationToggle.click();
  await expect
    .poll(async () => await page.evaluate(() => localStorage.getItem("rvw.agentNotifications")))
    .toBe("enabled");
  await expect(page.getByRole("status")).toHaveText("Agentのコメントをブラウザ通知します。");
  await openCommentsSidebar(page);

  let commentId: string | null = null;
  try {
    const humanResponse = await request.post("/api/comments", {
      data: {
        pullRequestId,
        target: { kind: "pull-request" },
        body: "Human follow-up must stay silent.",
        authorLabel: "You",
      },
    });
    expect(humanResponse.ok()).toBe(true);
    const human = (await humanResponse.json()) as { comment: { id: string } };
    commentId = human.comment.id;
    const thread = page.locator(".comment-list-item").filter({
      hasText: "Human follow-up must stay silent.",
    });
    await expect(thread).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { rvwNotifications?: unknown[] }).rvwNotifications?.length ??
          0,
      ),
    ).toBe(0);

    const acknowledgementResponse = await request.post(`/api/comments/${commentId}/posts`, {
      headers: { "x-rvw-fixture-modifier": "agent" },
      data: {
        body: "🔎 確認中です…",
        relatedCommitOid: null,
        authorLabel: "Codex",
      },
    });
    expect(acknowledgementResponse.ok()).toBe(true);
    const acknowledgement = (await acknowledgementResponse.json()) as { post: { id: string } };
    await expect(thread.getByText("🔎 確認中です…", { exact: true })).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { rvwNotifications?: unknown[] }).rvwNotifications?.length ??
          0,
      ),
    ).toBe(0);

    const finalResponse = await request.patch(
      `/api/comments/${commentId}/posts/${acknowledgement.post.id}`,
      {
        headers: { "x-rvw-fixture-modifier": "agent" },
        data: {
          body: "Agent investigation finished.",
        },
      },
    );
    expect(finalResponse.ok()).toBe(true);
    await expect(thread.getByText("Agent investigation finished.", { exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () =>
              (
                window as typeof window & {
                  rvwNotifications?: Array<{ title: string; options?: NotificationOptions }>;
                }
              ).rvwNotifications ?? [],
          ),
      )
      .toEqual([
        {
          title: "rvw · Codex",
          options: expect.objectContaining({
            body: "Agent investigation finished.",
            tag: expect.stringContaining(acknowledgement.post.id),
          }),
        },
      ]);

    const humanEditResponse = await request.patch(
      `/api/comments/${commentId}/posts/${acknowledgement.post.id}`,
      { data: { body: "Human correction must stay silent." } },
    );
    expect(humanEditResponse.ok()).toBe(true);
    await expect(
      thread.getByText("Human correction must stay silent.", { exact: true }),
    ).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { rvwNotifications?: unknown[] }).rvwNotifications?.length ??
          0,
      ),
    ).toBe(1);
  } finally {
    if (commentId) await request.delete(`/api/comments/${commentId}`, { data: {} });
  }
});

test("supports keyboard navigation and dismissal in a document pane menu", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  const pane = page.getByRole("region", { name: "左のコードペイン" });
  const toggle = pane.getByRole("button", { name: "左ペインの操作" });
  await toggle.click();
  const menu = pane.getByRole("menu");
  const move = menu.getByRole("menuitem", { name: "選択中のタブを右ペインへ移動" });
  const closeOthers = menu.getByRole("menuitem", { name: "他のタブをすべて閉じる" });
  await expect(move).toBeFocused();

  await move.press("ArrowDown");
  await expect(closeOthers).toBeFocused();
  await closeOthers.press("Home");
  await expect(move).toBeFocused();
  await move.press("Escape");
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();

  await toggle.click();
  await expect(menu).toBeVisible();
  await page.locator(".pr-heading").click();
  await expect(menu).toBeHidden();
});

test("offers a keyboard skip link and names the review sidebar landmark", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const skipLink = page.getByRole("link", { name: "レビュー本文へ移動" });
  await expect(
    page.locator('a[href], button:not([disabled]), input, textarea, [tabindex="0"]').first(),
  ).toHaveClass("skip-link");
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await skipLink.press("Enter");
  await expect(page.locator("#review-main-content")).toBeFocused();
  await expect(page.getByRole("complementary", { name: "レビューサイドバー" })).toBeVisible();
});

test("keeps overlays and primary controls reachable at high-zoom equivalent widths", async ({
  page,
}) => {
  const expectInsideViewport = async (locator: ReturnType<typeof page.locator>) => {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  };

  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const actionsButton = page.getByRole("button", { name: "その他の操作", exact: true });
  await expectInsideViewport(actionsButton);
  await actionsButton.click();
  await expectInsideViewport(page.getByRole("menu"));
  await page.keyboard.press("Escape");

  const commitButton = page.getByRole("button", { name: /^対象commit:/ });
  await commitButton.click();
  await expectInsideViewport(page.getByRole("dialog", { name: "対象commitを選択" }));
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 400, height: 720 });
  await expectInsideViewport(actionsButton);
  const workspace = page.locator(".workspace");
  const overflow = await workspace.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
  const scrolled = await workspace.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return element.scrollLeft;
  });
  expect(scrolled).toBeGreaterThan(0);
});

test("makes reset destructive intent explicit and honors confirmation cancellation", async ({
  page,
}) => {
  let previewRequests = 0;
  let confirmedRequests = 0;
  await page.route(`**/api/pull-requests/${pullRequestId}/reset`, async (route) => {
    const body = route.request().postDataJSON() as { yes: boolean };
    if (body.yes) {
      confirmedRequests += 1;
      await route.fulfill({ status: 500, json: { ok: false } });
      return;
    }
    previewRequests += 1;
    await route.fulfill({
      status: 409,
      json: {
        ok: false,
        error: {
          code: "RESET_CONFIRMATION_REQUIRED",
          message: "resetには明示的な確認が必要です。",
        },
        counts: {
          comments: 3,
          posts: 5,
          targets: 3,
          walkthroughs: 2,
          walkthroughReferences: 7,
          structures: 3,
          gitRefs: 4,
        },
      },
    });
  });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("ローカルレビュー状態を削除して再構築します。");
    expect(dialog.message()).toContain("コメント 3");
    expect(dialog.message()).toContain("返信 5");
    expect(dialog.message()).toContain("Structure 3");
    expect(dialog.message()).toContain("この操作は元に戻せません。");
    await dialog.dismiss();
  });

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "ローカル状態を削除して再構築", exact: true }).click();

  await expect.poll(() => previewRequests).toBe(1);
  expect(confirmedRequests).toBe(0);
  await expect(
    page.locator(".pr-heading").getByRole("heading", { name: /Fixture review/ }),
  ).toBeVisible();
});

test("discards in-memory comment drafts after a confirmed reset", async ({ page, request }) => {
  const viewResponse = await request.get(`/api/pull-requests/${pullRequestId}`);
  expect(viewResponse.ok()).toBe(true);
  const resetView = (await viewResponse.json()) as {
    pullRequest: { latestHeadOid: string };
    commits: Array<{
      oid: string;
      parentOids: string[];
      subject: string;
      authorName: string;
      authoredAt: string;
    }>;
  };
  let confirmedRequests = 0;
  await page.route(`**/api/pull-requests/${pullRequestId}/reset`, async (route) => {
    const body = route.request().postDataJSON() as { yes: boolean };
    if (!body.yes) {
      await route.fulfill({
        status: 409,
        json: {
          ok: false,
          error: {
            code: "RESET_CONFIRMATION_REQUIRED",
            message: "resetには明示的な確認が必要です。",
          },
          counts: {
            comments: 0,
            posts: 0,
            targets: 0,
            walkthroughs: 0,
            walkthroughReferences: 0,
            structures: 0,
            gitRefs: 1,
          },
        },
      });
      return;
    }
    confirmedRequests += 1;
    await route.fulfill({ json: { ok: true, ...resetView } });
  });
  page.once("dialog", (dialog) => dialog.accept());

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "ファイル全体へコメント" }).click();
  const draft = page.getByRole("textbox", { name: "ファイル全体へコメント" });
  await draft.fill("reset後に復元してはいけない未送信ドラフト");

  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "ローカル状態を削除して再構築", exact: true }).click();

  await expect.poll(() => confirmedRequests).toBe(1);
  await expect(draft).toBeHidden();
  await page.getByRole("button", { name: "ファイル全体へコメント" }).click();
  await expect(page.getByRole("textbox", { name: "ファイル全体へコメント" })).toHaveValue("");
});

test("preserves an unsent file comment draft while switching document tabs", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await page.getByRole("button", { name: "ファイル全体へコメント" }).click();
  const draft = page.getByRole("textbox", { name: "ファイル全体へコメント" });
  await draft.fill("中断される未送信ドラフト\n二行目");

  await page.getByRole("button", { name: "src/new.ts", exact: true }).click();
  await page.getByRole("tab", { name: "src/fixture.ts", exact: true }).click();

  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue("中断される未送信ドラフト\n二行目");
  await draft.press("Escape");
  await expect(draft).toBeHidden();

  await page.getByRole("tab", { name: "src/new.ts", exact: true }).click();
  await page.getByRole("tab", { name: "src/fixture.ts", exact: true }).click();
  await expect(draft).toBeHidden();
});

test("keeps unsent drafts independent for the same file in both panes", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const file = page.getByRole("button", { name: "src/fixture.ts", exact: true });
  await file.click();
  await file.click({ modifiers: ["Meta"] });

  const leftPane = page.locator('.document-pane[data-pane="left"]');
  const rightPane = page.locator('.document-pane[data-pane="right"]');
  await leftPane.getByRole("button", { name: "ファイル全体へコメント" }).click();
  await rightPane.getByRole("button", { name: "ファイル全体へコメント" }).click();
  const leftDraft = leftPane.getByRole("textbox", { name: "ファイル全体へコメント" });
  const rightDraft = rightPane.getByRole("textbox", { name: "ファイル全体へコメント" });
  await leftDraft.fill("左ペインの未送信ドラフト");
  await rightDraft.fill("右ペインの未送信ドラフト");

  await rightPane.getByRole("button", { name: "src/fixture.tsを閉じる" }).click();
  await file.click({ modifiers: ["Meta"] });
  await expect(rightPane.getByRole("textbox", { name: "ファイル全体へコメント" })).toHaveValue(
    "右ペインの未送信ドラフト",
  );

  await leftPane.getByRole("button", { name: "src/fixture.tsを閉じる" }).click();
  await file.click();
  await expect(leftPane.getByRole("textbox", { name: "ファイル全体へコメント" })).toHaveValue(
    "左ペインの未送信ドラフト",
  );
});

test("moves an unsent file comment draft with its tab", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  const leftPane = page.locator('.document-pane[data-pane="left"]');
  await leftPane.getByRole("button", { name: "ファイル全体へコメント" }).click();
  await leftPane
    .getByRole("textbox", { name: "ファイル全体へコメント" })
    .fill("タブと一緒に移動する新規コメントdraft");

  await leftPane.getByRole("button", { name: "左ペインの操作" }).click();
  await page.getByRole("menuitem", { name: "選択中のタブを右ペインへ移動" }).click();

  const rightPane = page.locator('.document-pane[data-pane="right"]');
  await expect(leftPane.getByRole("tab", { name: "src/fixture.ts", exact: true })).toHaveCount(0);
  await expect(rightPane.getByRole("textbox", { name: "ファイル全体へコメント" })).toHaveValue(
    "タブと一緒に移動する新規コメントdraft",
  );
});

test("moves a right-pane reply when closing the last left tab normalizes panes", async ({
  page,
  request,
}) => {
  const commentId = await createFixtureFileComment(request);
  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await page
      .getByRole("button", { name: "src/fixture.ts", exact: true })
      .click({ modifiers: ["Meta"] });
    const rightReply = page
      .locator(`.document-pane[data-pane="right"] [data-comment-id="${commentId}"]`)
      .getByPlaceholder("返信を入力");
    await rightReply.fill("最後の左タブを閉じても残る返信");

    await page
      .locator('.document-pane[data-pane="left"]')
      .getByRole("button", { name: /Pull Request\.md.*を閉じる/ })
      .click();

    await expect(page.locator('.document-pane[data-pane="right"]')).toHaveCount(0);
    await expect(
      page
        .locator(`.document-pane[data-pane="left"] [data-comment-id="${commentId}"]`)
        .getByPlaceholder("返信を入力"),
    ).toHaveValue("最後の左タブを閉じても残る返信");
  } finally {
    expect((await request.delete(`/api/comments/${commentId}`, { data: {} })).ok()).toBe(true);
  }
});

test("moves right-pane replies when moving the last left tab triggers normalization", async ({
  page,
  request,
}) => {
  const commentId = await createFixtureFileComment(request);
  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await page
      .getByRole("button", { name: "src/fixture.ts", exact: true })
      .click({ modifiers: ["Meta"] });
    await page
      .locator(`.document-pane[data-pane="right"] [data-comment-id="${commentId}"]`)
      .getByPlaceholder("返信を入力")
      .fill("最後の左タブを移動しても残る返信");

    const leftPane = page.locator('.document-pane[data-pane="left"]');
    await leftPane.getByRole("button", { name: "左ペインの操作" }).click();
    await page.getByRole("menuitem", { name: "選択中のタブを右ペインへ移動" }).click();

    await expect(page.locator('.document-pane[data-pane="right"]')).toHaveCount(0);
    await leftPane.getByRole("tab", { name: "src/fixture.ts", exact: true }).click();
    await expect(
      page
        .locator(`.document-pane[data-pane="left"] [data-comment-id="${commentId}"]`)
        .getByPlaceholder("返信を入力"),
    ).toHaveValue("最後の左タブを移動しても残る返信");
  } finally {
    expect((await request.delete(`/api/comments/${commentId}`, { data: {} })).ok()).toBe(true);
  }
});

test("rejects pane consolidation when both copies have a reply draft", async ({
  page,
  request,
}) => {
  const commentId = await createFixtureFileComment(request);
  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    const file = page.getByRole("button", { name: "src/fixture.ts", exact: true });
    await file.click();
    await file.click({ modifiers: ["Meta"] });
    const leftPane = page.locator('.document-pane[data-pane="left"]');
    const rightPane = page.locator('.document-pane[data-pane="right"]');
    const leftReply = leftPane
      .locator(`[data-comment-id="${commentId}"]`)
      .getByPlaceholder("返信を入力");
    const rightReply = rightPane
      .locator(`[data-comment-id="${commentId}"]`)
      .getByPlaceholder("返信を入力");
    await leftReply.fill("左の返信draft");
    await rightReply.fill("右の返信draft");
    await leftPane.getByRole("tab", { name: "src/fixture.ts", exact: true }).click();
    await leftPane.getByRole("button", { name: "左ペインの操作" }).click();
    await page.getByRole("menuitem", { name: "選択中のタブを右ペインへ移動" }).click();

    await expect(page.getByText(/移動先にも入力中のコメントまたは返信があります/)).toBeVisible();
    await expect(leftPane.getByRole("tab", { name: "src/fixture.ts", exact: true })).toBeVisible();
    await expect(rightPane.getByRole("tab", { name: "src/fixture.ts", exact: true })).toBeVisible();
    await expect(leftReply).toHaveValue("左の返信draft");
    await expect(rightReply).toHaveValue("右の返信draft");
  } finally {
    expect((await request.delete(`/api/comments/${commentId}`, { data: {} })).ok()).toBe(true);
  }
});

test("keeps same-file inline reply input and focus isolated by pane", async ({ page, request }) => {
  const viewResponse = await request.get(`/api/pull-requests/${pullRequestId}`);
  expect(viewResponse.ok()).toBe(true);
  const { headOid } = (await viewResponse.json()) as { headOid: string };
  const createResponse = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: headOid,
        path: "src/fixture.ts",
        startLine: 1,
        endLine: 1,
      },
      body: "左右ペインの返信入力を確認します。",
      authorLabel: "You",
    },
  });
  expect(createResponse.ok()).toBe(true);
  const { comment } = (await createResponse.json()) as { comment: { id: string } };

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    const file = page.getByRole("button", { name: "src/fixture.ts", exact: true });
    await file.click();
    await file.click({ modifiers: ["Meta"] });

    const leftReply = page
      .locator(`.document-pane[data-pane="left"] [data-comment-id="${comment.id}"]`)
      .getByPlaceholder("返信を入力");
    const rightReply = page
      .locator(`.document-pane[data-pane="right"] [data-comment-id="${comment.id}"]`)
      .getByPlaceholder("返信を入力");
    await leftReply.click();
    await leftReply.press("k");

    await expect(leftReply).toHaveValue("k");
    await expect(rightReply).toHaveValue("");
    await expect(leftReply).toBeFocused();
  } finally {
    const deleteResponse = await request.delete(`/api/comments/${comment.id}`, { data: {} });
    expect(deleteResponse.ok()).toBe(true);
  }
});

test("visually disambiguates open tabs that share the same basename", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const paths = [
    "src/application/orders/create-order.ts",
    "src/http/controllers/create-order.ts",
    "src/http/schemas/create-order.ts",
  ];
  await expect(page.getByRole("button", { name: "その他の操作", exact: true })).toBeVisible();
  for (const path of paths) {
    await page.keyboard.press("Control+P");
    const palette = page.getByRole("dialog", { name: "ファイルを開く" });
    const input = palette.getByRole("combobox", { name: "ファイル名で検索" });
    await expect(input).toBeFocused();
    await input.fill(path);
    await palette.getByRole("option", { name: path }).click();
    await expect(page.getByRole("tab", { name: path })).toHaveAttribute("aria-selected", "true");
  }

  const tablist = page.getByRole("tablist", { name: "開いている文書" });
  const uniqueDirectoryByPath = new Map([
    [paths[0], "orders"],
    [paths[1], "controllers"],
    [paths[2], "schemas"],
  ]);
  for (const path of paths) {
    const tab = tablist.getByRole("tab", { name: path });
    await expect(tab).toContainText(`create-order.ts · ${uniqueDirectoryByPath.get(path)}`);
    await expect(tab.locator(".document-tab-label")).toHaveAttribute("title", path);
  }
});

test("distinguishes virtual and repository documents with the same path", async ({ page }) => {
  const duplicatePath = "Pull Request.md";
  await page.route(`**/api/pull-requests/${pullRequestId}/tree?*`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { entries: Record<string, unknown>[] };
    body.entries.push({
      mode: "100644",
      type: "blob",
      oid: "f".repeat(40),
      size: 31,
      path: duplicatePath,
      kind: "file",
    });
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/pull-requests/${pullRequestId}/document?*`, async (route) => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("kind") !== "repository-file" ||
      url.searchParams.get("path") !== duplicatePath
    ) {
      await route.continue();
      return;
    }
    const sourceOid = url.searchParams.get("sourceOid") ?? secondHead;
    await route.fulfill({
      json: {
        ok: true,
        document: {
          ref: { kind: "repository-file", pullRequestId, sourceOid, path: duplicatePath },
          availability: "available",
          text: "# Repository Pull Request file\n",
          byteLength: 31,
          entryKind: "file",
          normalizedLineEndings: false,
          oid: "f".repeat(40),
        },
      },
    });
  });

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: /ファイルを開く/ }).click();
  const palette = page.getByRole("dialog", { name: "ファイルを開く" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "ファイル名で検索" }).fill(duplicatePath);
  await expect(palette.getByRole("option", { name: /Pull Request\.md（PR本文）/ })).toBeVisible();
  await palette.getByRole("option", { name: "Pull Request.md（repository）", exact: true }).click();

  const pane = page.getByRole("region", { name: "左のコードペイン" });
  const tablist = pane.getByRole("tablist", { name: "開いている文書" });
  await expect(
    tablist.getByRole("tab", { name: "Pull Request.md（PR本文）", exact: true }),
  ).toContainText("Pull Request.md · PR本文");
  await expect(
    tablist.getByRole("tab", { name: "Pull Request.md（repository）", exact: true }),
  ).toContainText("Pull Request.md · repository");
  await expect(
    pane.getByRole("button", { name: "Pull Request.md（PR本文）を閉じる", exact: true }),
  ).toBeVisible();
  await expect(
    pane.getByRole("button", { name: "Pull Request.md（repository）を閉じる", exact: true }),
  ).toBeVisible();

  await pane.getByRole("button", { name: "左ペインの操作" }).click();
  const menu = pane.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "Pull Request.md（PR本文）", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Pull Request.md（repository）", exact: true }),
  ).toBeVisible();
});

test("handles Unicode empty symlink submodule and very long repository paths", async ({ page }) => {
  const emptyPath = "docs/空 ファイル.txt";
  const emojiPath = "docs/emoji 🚀/レビュー.md";
  const decomposedPath = "docs/Cafe\u0301.md";
  const composedPath = "docs/Café.md";
  const symlinkPath = "links/current";
  const submodulePath = "vendor/example-module";
  const longPath = `packages/${"deep-segment/".repeat(12)}feature/review-target.ts`;
  const submoduleOid = "e".repeat(40);
  const documents = new Map([
    [emptyPath, { text: "", entryKind: "file" }],
    [emojiPath, { text: "# 注文レビュー 🚀\n\n多言語の本文です。\n", entryKind: "file" }],
    [decomposedPath, { text: "decomposed accent\n", entryKind: "file" }],
    [composedPath, { text: "composed accent\n", entryKind: "file" }],
    [symlinkPath, { text: "../releases/current", entryKind: "symlink" }],
    [submodulePath, { text: submoduleOid, entryKind: "submodule" }],
    [longPath, { text: "export const deeplyNested = true;\n", entryKind: "file" }],
  ]);

  await page.route(`**/api/pull-requests/${pullRequestId}/tree?*`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { entries: Record<string, unknown>[] };
    body.entries.push(
      ...[...documents].map(([path, value], index) => ({
        mode:
          value.entryKind === "symlink"
            ? "120000"
            : value.entryKind === "submodule"
              ? "160000"
              : "100644",
        type: value.entryKind === "submodule" ? "commit" : "blob",
        oid: (index + 10).toString(16).padStart(40, "0"),
        size: Buffer.byteLength(value.text),
        path,
        kind: value.entryKind,
      })),
    );
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/pull-requests/${pullRequestId}/document?*`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    const value = documents.get(path);
    if (!value) {
      await route.continue();
      return;
    }
    const sourceOid = url.searchParams.get("sourceOid") ?? secondHead;
    await route.fulfill({
      json: {
        ok: true,
        document: {
          ref: { kind: "repository-file", pullRequestId, sourceOid, path },
          availability: "available",
          text: value.text,
          byteLength: Buffer.byteLength(value.text),
          entryKind: value.entryKind,
          normalizedLineEndings: false,
          oid: value.entryKind === "submodule" ? submoduleOid : "f".repeat(40),
        },
      },
    });
  });
  await page.route(`**/api/pull-requests/${pullRequestId}/search?*`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") !== "注文") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        query: "注文",
        matchCount: 1,
        truncated: false,
        results: [
          {
            document: {
              kind: "repository-file",
              pullRequestId,
              sourceOid: secondHead,
              path: emojiPath,
            },
            path: emojiPath,
            line: 1,
            text: "# 注文レビュー 🚀",
            matches: [{ start: 2, end: 4 }],
          },
        ],
      },
    });
  });

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const showQuickOpen = async () => {
    await page.getByRole("button", { name: "その他の操作", exact: true }).click();
    await page.getByRole("menuitem", { name: /ファイルを開く/ }).click();
    const palette = page.getByRole("dialog", { name: "ファイルを開く" });
    await expect(palette).toBeVisible();
    return palette;
  };
  const openFromQuickOpen = async (path: string, query = path) => {
    const palette = await showQuickOpen();
    const input = palette.getByRole("combobox", { name: "ファイル名で検索" });
    await input.fill(query);
    await palette.getByRole("option", { name: path }).click();
    await expect(page.getByRole("tab", { name: path })).toHaveAttribute("aria-selected", "true");
  };

  await openFromQuickOpen(emptyPath);
  await expect(page.locator("diffs-container")).toBeVisible();
  await expect(page.getByText(/本文を表示できません/)).toHaveCount(0);

  let palette = await showQuickOpen();
  let input = palette.getByRole("combobox", { name: "ファイル名で検索" });
  await input.fill("Caf");
  await expect(palette.getByRole("option", { name: decomposedPath })).toBeVisible();
  await expect(palette.getByRole("option", { name: composedPath })).toBeVisible();
  await input.press("Escape");

  palette = await showQuickOpen();
  input = palette.getByRole("combobox", { name: "ファイル名で検索" });
  await input.fill("current");
  const symlinkOption = palette.getByRole("option", { name: symlinkPath });
  await expect(symlinkOption.locator('[data-file-icon="file-symlink-duo"]')).toBeVisible();
  await symlinkOption.click();
  await expect(page.getByText("../releases/current", { exact: true })).toBeVisible();

  palette = await showQuickOpen();
  input = palette.getByRole("combobox", { name: "ファイル名で検索" });
  await input.fill("example-module");
  const submoduleOption = palette.getByRole("option", { name: submodulePath });
  await expect(submoduleOption.locator('[data-file-icon="submodule"]')).toBeVisible();
  await submoduleOption.click();
  await expect(page.getByText(submoduleOid, { exact: true })).toBeVisible();

  await openFromQuickOpen(longPath, "review-target");
  await openFromQuickOpen(emojiPath, "🚀");
  await page.keyboard.press("Control+Shift+F");
  const searchInput = page.getByRole("textbox", { name: "全文検索" });
  await searchInput.fill("注文");
  await expect(page.getByRole("button", { name: `${emojiPath}、1件` })).toBeVisible();
  await expect(page.getByRole("button", { name: `${emojiPath} 1行` })).toBeVisible();
});

test("keeps cached review content and explains how to recover from server loss", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const pullRequestTitle = page.locator(".pr-heading h1");
  await expect(pullRequestTitle).toBeVisible();
  const title = await pullRequestTitle.textContent();
  await page.route("**/api/pull-requests/*/refresh", (route) => route.abort("connectionrefused"));
  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "GitHubと同期" }).click();

  await expect(
    page.getByText(
      "rvwのローカルサーバーに接続できません。表示済みの内容はそのまま保持されています。`rvw open`から起動し直してください。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(pullRequestTitle).toHaveText(title ?? "");
});

test("enriches PR Markdown comment targets like the production service", async ({ request }) => {
  const viewResponse = await request.get(`/api/pull-requests/${pullRequestId}`);
  const view = (await viewResponse.json()) as {
    pullRequest: { latestTitle: string; latestBody: string };
  };
  const markdown = `# ${view.pullRequest.latestTitle}\n\n${view.pullRequest.latestBody}`;
  const response = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "pull-request-markdown",
        startLine: 1,
        endLine: 1,
      },
      body: "Fixture target enrichment check.",
      authorLabel: "You",
    },
  });
  expect(response.ok()).toBe(true);
  const result = (await response.json()) as {
    comment: {
      target: { sourceDocumentHash: string; quotedText: string };
    };
  };
  expect(result.comment.target).toMatchObject({
    sourceDocumentHash: createHash("sha256").update(markdown).digest("hex"),
    quotedText: `# ${view.pullRequest.latestTitle}`,
  });
});

test("allows file-level comments while line comments stay unavailable for binary files", async ({
  page,
}, testInfo) => {
  const body = `Binary artifact needs a file-level note (${testInfo.repeatEachIndex}-${testInfo.retry}).`;
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.getByRole("button", { name: "binary.bin", exact: true }).click();
  await expect(page.getByText("非UTF-8またはbinaryのため本文を表示できません。")).toBeVisible();
  await expect(page.locator("diffs-container")).toHaveCount(0);

  await page.getByRole("button", { name: "ファイル全体へコメント" }).click();
  const composer = page.locator(".inline-comment-composer--file");
  await composer.getByRole("textbox", { name: "ファイル全体へコメント" }).fill(body);
  await composer.getByRole("button", { name: "コメント", exact: true }).click();
  const commentsToggle = page.getByRole("button", { name: /^コメント \d+$/ });
  await expect(commentsToggle).toHaveAttribute("aria-expanded", "false");
  await commentsToggle.click();
  await expect(page.locator(".comment-sidebar").getByText(body, { exact: true })).toBeVisible();
});

test("shows a recoverable error when the lazy document viewer cannot load", async ({ page }) => {
  await page.route("**/assets/DocumentViewer-*.js", (route) => route.abort());
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(
    page.getByText("文書ビューアーを読み込めませんでした。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "ページを再読み込み" })).toBeVisible();
});

test("defaults Markdown to preview and preserves an explicit mode per document tab", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const reviewScope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  await reviewScope.getByRole("button", { name: /^対象commit:/ }).click();
  await page
    .getByRole("dialog", { name: "対象commitを選択" })
    .getByRole("button", { name: "最新だけ", exact: true })
    .click();
  await expect(reviewScope.getByRole("button", { name: /^対象commit:/ })).toHaveAccessibleName(
    /最新/,
  );
  await reviewScope.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await expect(page.locator("diffs-container")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);

  await reviewScope.getByRole("button", { name: "全文", exact: true }).click();
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("heading", { name: "Orders service", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.getByRole("tab", { name: "Pull Request.md" }).click();
  await page.getByRole("tab", { name: "README.md" }).click();
  await expect(page.getByRole("button", { name: "Source", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("preserves a Markdown table's horizontal scroll when the preview rerenders", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "全文", exact: true }).click();
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.getByRole("button", { name: "README.md", exact: true }).click();

  const sourceLine = page
    .locator('.markdown-preview [data-rvw-source-start-line="6"][data-rvw-source-leaf="true"]')
    .first();
  await expect(sourceLine).toBeVisible();
  await sourceLine.evaluate((element) => {
    const text = element.firstChild;
    if (!(text instanceof Text) || text.data.length === 0) {
      throw new Error("Expected a non-empty mapped Markdown text node.");
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });

  const tableScroller = page.locator(".markdown-preview .markdown-table-scroll");
  const expectedScrollLeft = await tableScroller.evaluate((element) => {
    const maximum = element.scrollWidth - element.clientWidth;
    if (maximum <= 0) throw new Error("Expected the Markdown table to overflow horizontally.");
    element.scrollLeft = Math.min(80, maximum);
    return element.scrollLeft;
  });
  expect(expectedScrollLeft).toBeGreaterThan(0);

  await page.getByRole("button", { name: "L6へコメント", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "README.md · L6へコメント" })).toBeVisible();
  await expect
    .poll(() => tableScroller.evaluate((element) => element.scrollLeft))
    .toBe(expectedScrollLeft);
});

test("keeps full and diff file headers directly below the sticky document tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 240 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();

  const reviewScope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  const documentPane = page.locator('.document-pane[data-pane="left"]');
  const diff = documentPane.locator("diffs-container");

  const assertStickyHeader = async (): Promise<void> => {
    await expect(diff.locator("[data-diffs-header][data-sticky]")).toBeVisible();
    const scrollTop = await documentPane.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(scrollTop).toBeGreaterThan(0);
    await expect
      .poll(async () => {
        return await diff.locator("[data-diffs-header]").evaluate((header) => {
          const root = header.getRootNode();
          if (!(root instanceof ShadowRoot)) return null;
          const tabs = root.host.closest(".document-pane")?.querySelector(".document-tabs-shell");
          if (!(tabs instanceof HTMLElement)) return null;
          return Math.round(
            header.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom,
          );
        });
      })
      .toBe(0);
  };

  await reviewScope.getByRole("button", { name: "全文", exact: true }).click();
  await assertStickyHeader();

  await documentPane.evaluate((element) => {
    element.scrollTop = 0;
  });
  await reviewScope.getByRole("button", { name: "変更", exact: true }).click();
  await assertStickyHeader();
});

test("starts a newly activated document at the top of its pane", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.getByRole("button", { name: "ファイルツリーをすべて展開" }).click();
  await page
    .getByRole("button", { name: "src/application/orders/create-order.ts", exact: true })
    .click();

  const documentPane = page.locator('.document-pane[data-pane="left"]');
  const longDocument = documentPane.locator("diffs-container");
  await expect(longDocument.locator('[data-line="42"]')).toBeVisible();
  const inheritedScrollTop = await documentPane.evaluate((element) => {
    element.scrollTop = 160;
    return element.scrollTop;
  });
  expect(inheritedScrollTop).toBeGreaterThan(0);

  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  const shortDocument = documentPane.locator("diffs-container");
  await expect(shortDocument.locator('[data-line="1"]')).toBeVisible();
  await expect.poll(() => documentPane.evaluate((element) => element.scrollTop)).toBe(0);
  const positions = await shortDocument.evaluate((element) => {
    const header = element.shadowRoot!.querySelector<HTMLElement>("[data-diffs-header]")!;
    const firstLine = element.shadowRoot!.querySelector<HTMLElement>('[data-line="1"]')!;
    return {
      headerBottom: header.getBoundingClientRect().bottom,
      firstLineTop: firstLine.getBoundingClientRect().top,
    };
  });
  expect(positions.firstLineTop).toBeGreaterThanOrEqual(positions.headerBottom - 1);

  await page
    .getByRole("tab", { name: "src/application/orders/create-order.ts", exact: true })
    .click();
  await expect.poll(() => documentPane.evaluate((element) => element.scrollTop)).toBe(160);
});

test("browser back and forward restore the focused reading pane without rolling back review scope", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(page.getByRole("button", { name: "src/fixture.ts", exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.history.state as {
          rvwReading?: { version?: unknown };
        } | null;
        return state?.rvwReading?.version ?? null;
      }),
    )
    .toBe(1);

  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await expect(
    page
      .locator('.document-pane[data-pane="left"]')
      .getByRole("tab", { name: "src/fixture.ts", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.getByRole("button", { name: "全文", exact: true }).click();
  await page
    .getByRole("button", { name: "Pull Request.md", exact: true })
    .click({ modifiers: ["Meta"] });

  const leftPane = page.locator('.document-pane[data-pane="left"]');
  const rightPane = page.locator('.document-pane[data-pane="right"]');
  const pullRequestTab = rightPane.getByRole("tab", { name: "Pull Request.md", exact: true });
  await expect(pullRequestTab).toHaveAttribute("aria-selected", "true");
  await expect(rightPane).toHaveClass(/active/);

  await page.goBack();
  await expect(leftPane.getByRole("tab", { name: "src/fixture.ts", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(leftPane).toHaveClass(/active/);
  await expect(pullRequestTab).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "変更のないファイルも表示" })).toBeChecked();
  await expect(page.getByRole("button", { name: "全文", exact: true })).toHaveClass(/active/);

  await page.goForward();
  await expect(pullRequestTab).toHaveAttribute("aria-selected", "true");
  await expect(rightPane).toHaveClass(/active/);
});

test("browser back restores the reading position after scrolling away from a line jump", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "コード検索を開く", exact: true }).click();
  await page.getByRole("textbox", { name: "全文検索", exact: true }).fill("dispatcher");
  await page.getByRole("button", { name: "README.md 50行", exact: true }).click();

  const pane = page.locator('.document-pane[data-pane="left"]');
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(800);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.history.state as {
              rvwReading?: { locator?: { kind?: unknown } };
            } | null
          )?.rvwReading?.locator?.kind ?? null,
      ),
    )
    .toBe("line");

  await pane.evaluate((element) => {
    element.scrollTop = 200;
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const locator = (
          window.history.state as {
            rvwReading?: { locator?: { kind?: unknown; top?: unknown } };
          } | null
        )?.rvwReading?.locator;
        return locator?.kind === "scroll" ? locator.top : null;
      }),
    )
    .toBe(200);

  await page.getByRole("button", { name: "ファイルツリーに戻る", exact: true }).click();
  await page.getByRole("button", { name: "src/new.ts", exact: true }).click();
  await page.goBack();
  await expect(pane.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(200);

  await page.goForward();
  await expect(pane.getByRole("tab", { name: "src/new.ts", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.goBack();
  await expect(pane.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(200);
});

test("browser back returns from a Markdown heading to the prior position in the same document", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.getByRole("button", { name: "README.md", exact: true }).click();

  const pane = page.locator('.document-pane[data-pane="left"]');
  const readmeTab = pane.getByRole("tab", { name: "README.md", exact: true });
  await pane.getByRole("link", { name: "the request lifecycle", exact: true }).click();
  await expect(page).toHaveURL(/#request-lifecycle$/);

  await page.goBack();
  await expect(readmeTab).toHaveAttribute("aria-selected", "true");
  await expect(page).not.toHaveURL(/#request-lifecycle$/);
});

test("reload starts a fresh ephemeral document workspace", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await page
    .getByRole("button", { name: "Pull Request.md", exact: true })
    .click({ modifiers: ["Meta"] });
  await expect(page.locator('.document-pane[data-pane="right"]')).toBeVisible();

  await page.reload();

  const leftPane = page.locator('.document-pane[data-pane="left"]');
  await expect(leftPane.getByRole("tab", { name: "Pull Request.md", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(leftPane.getByRole("tab")).toHaveCount(1);
  await expect(page.locator('.document-pane[data-pane="right"]')).toHaveCount(0);
});

test("focuses a deep Walkthrough range when command-click creates the right pane", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await openWalkthroughFromSidebar(page, "注文作成フロー：HTTPからtransactional outboxまで");
  await page
    .getByRole("button", { name: "recordPaymentAuthorization L26–34", exact: true })
    .click({ modifiers: ["Meta"] });

  const rightPane = page.locator('.document-pane[data-pane="right"]');
  const diff = rightPane.locator("diffs-container");
  await expect(diff).toHaveAttribute("data-search-target-line", "26");
  await expect(diff.locator('[data-line="26"][data-editor-active-line]')).toBeVisible();
  await expect
    .poll(async () => {
      const paneBox = await rightPane.boundingBox();
      const lineBox = await diff.locator('[data-line="26"][data-editor-active-line]').boundingBox();
      if (!paneBox || !lineBox) return Number.POSITIVE_INFINITY;
      const paneCenter = paneBox.y + paneBox.height / 2;
      const lineCenter = lineBox.y + lineBox.height / 2;
      return Math.abs(paneCenter - lineCenter);
    })
    .toBeLessThan(80);

  await page.goBack();
  await expect(
    page
      .locator('.document-pane[data-pane="left"]')
      .getByRole("tab", { name: "注文作成フロー：HTTPからtransactional outboxまで" }),
  ).toHaveAttribute("aria-selected", "true");
});

test("comment targets participate in reading history without persisting transient comment focus", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: secondHead,
        path: "src/fixture.ts",
        sourceDocumentHash: "reading-history-comment",
        quotedText: 'export const fixtureSearchTarget = "fixture";',
        startLine: 13,
        endLine: 13,
      },
      body: "Reading history comment target.",
      authorLabel: "You",
    },
  });
  expect(created.ok()).toBe(true);
  const commentId = ((await created.json()) as { comment: { id: string } }).comment.id;

  try {
    await page.goto(`/?pullRequestId=${pullRequestId}`);
    await page.getByRole("button", { name: "src/new.ts", exact: true }).click();
    await openCommentsSidebar(page);
    const comment = page.locator(`.comment-thread--sidebar[data-comment-id="${commentId}"]`);
    await comment.getByRole("button", { name: "コメント対象を開く", exact: true }).click();

    const leftPane = page.locator('.document-pane[data-pane="left"]');
    const fixtureTab = leftPane.getByRole("tab", { name: "src/fixture.ts", exact: true });
    await expect(fixtureTab).toHaveAttribute("aria-selected", "true");
    await expect(leftPane.locator("diffs-container")).toHaveAttribute(
      "data-search-target-line",
      "13",
    );
    expect(
      await page.evaluate(
        () =>
          (
            window.history.state as {
              rvwReading?: { commentId?: unknown };
            } | null
          )?.rvwReading?.commentId,
      ),
    ).toBeUndefined();

    await page.goBack();
    await expect(leftPane.getByRole("tab", { name: "src/new.ts", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.goForward();
    await expect(fixtureTab).toHaveAttribute("aria-selected", "true");
  } finally {
    await request.delete(`/api/comments/${commentId}`, { data: {} });
  }
});

test("reopens an inline thread consistently after it changes while unmounted", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/comments", {
    data: {
      pullRequestId,
      target: {
        kind: "document",
        documentKind: "repository-file",
        sourceOid: secondHead,
        path: "src/fixture.ts",
        sourceDocumentHash: "uat-remount-comment",
        quotedText: "export function fixture(value: string) {",
        startLine: 1,
        endLine: 1,
      },
      body: "非表示中の状態変更を確認します。",
      authorLabel: "You",
    },
  });
  expect(created.ok()).toBe(true);
  const commentId = ((await created.json()) as { comment: { id: string } }).comment.id;

  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  const inline = page.locator(`.comment-thread--inline[data-comment-id="${commentId}"]`);
  await expect(inline).toHaveClass(/is-expanded/);
  await inline.locator(".comment-thread-toggle").click();
  await expect(inline).toHaveClass(/is-collapsed/);
  await page.getByRole("tab", { name: "Pull Request.md" }).click();

  await openCommentsSidebar(page);
  const sidebar = page.locator(`.comment-thread--sidebar[data-comment-id="${commentId}"]`);
  await sidebar.getByRole("button", { name: "解決", exact: true }).click();
  await expect(sidebar).toHaveCount(0);
  await page.getByRole("button", { name: /^解決済み/ }).click();
  const resolvedSidebar = page.locator(`.comment-thread--sidebar[data-comment-id="${commentId}"]`);
  await resolvedSidebar.getByRole("button", { name: "再度開く", exact: true }).click();
  await expect(resolvedSidebar).toHaveCount(0);
  await page.getByRole("button", { name: /^未解決/ }).click();
  await page.getByRole("tab", { name: "src/fixture.ts" }).click();
  await expect(inline).toHaveClass(/is-expanded/);
});

test("explains that full view is unavailable for a deleted file", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "src/removed.ts", exact: true }).click();
  await page.getByRole("button", { name: "全文", exact: true }).click();
  await expect(page.getByText("全文は利用できません", { exact: false })).toBeVisible();
  await expect(page.locator("diffs-container")).toHaveCount(0);
});

test("keeps activated overflow tabs visible and supports tablist arrow keys", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.getByRole("button", { name: "ファイルツリーをすべて展開" }).click();
  const paths = [
    "README.md",
    "src/fixture.ts",
    "src/new.ts",
    "docs/order-workflow.md",
    "src/http/routes/orders.ts",
    "src/application/orders/create-order.ts",
  ];
  for (const path of paths) {
    await page.getByRole("button", { name: path, exact: true }).click({ modifiers: ["Meta"] });
  }

  const rightPane = page.locator('.document-pane[data-pane="right"]');
  const tabList = rightPane.getByRole("tablist", { name: "開いている文書" });
  const activeLastTab = rightPane.getByRole("tab", {
    name: "src/application/orders/create-order.ts",
  });
  await expect(activeLastTab).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => {
      const list = await tabList.boundingBox();
      const tab = await activeLastTab.boundingBox();
      return Boolean(
        list && tab && tab.x >= list.x && tab.x + tab.width <= list.x + list.width + 1,
      );
    })
    .toBe(true);

  await tabList.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await rightPane.getByRole("button", { name: "右ペインの操作" }).click();
  await rightPane.getByRole("menuitem", { name: "README.md", exact: true }).click();
  const firstTab = rightPane.getByRole("tab", { name: "README.md", exact: true });
  await expect
    .poll(async () => {
      const list = await tabList.boundingBox();
      const tab = await firstTab.boundingBox();
      return Boolean(
        list && tab && tab.x >= list.x && tab.x + tab.width <= list.x + list.width + 1,
      );
    })
    .toBe(true);

  await firstTab.press("ArrowRight");
  await expect(rightPane.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await rightPane.getByRole("tab", { name: "src/fixture.ts" }).press("End");
  await expect(activeLastTab).toHaveAttribute("aria-selected", "true");
});

test("keeps both panes reachable inside a 640px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 600 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.getByRole("button", { name: "README.md", exact: true }).click({ modifiers: ["Meta"] });

  const mainView = page.locator(".main-view.two-pane");
  const dimensions = await mainView.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  const maximumScroll = await mainView.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return element.scrollLeft;
  });
  expect(maximumScroll).toBeGreaterThan(0);

  const mainBox = await mainView.boundingBox();
  const rightBox = await page.locator('.document-pane[data-pane="right"]').boundingBox();
  expect(mainBox).not.toBeNull();
  expect(rightBox).not.toBeNull();
  expect(rightBox!.x).toBeGreaterThanOrEqual(mainBox!.x - 1);
  expect(rightBox!.x + rightBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 1);
});

test("keeps every top bar control inside a 640px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 600 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);

  const topbar = page.locator(".topbar");
  const dimensions = await topbar.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);

  const topbarBox = await topbar.boundingBox();
  const actionsBox = await page
    .getByRole("button", { name: "その他の操作", exact: true })
    .boundingBox();
  expect(topbarBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(
    topbarBox!.x + topbarBox!.width + 1,
  );
});

test("keeps the beginning of code visible after narrow reference navigation", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 760 });
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  await page.getByRole("button", { name: "README.md", exact: true }).click({ modifiers: ["Meta"] });
  await openWalkthroughFromSidebar(page, "注文作成フロー：HTTPからtransactional outboxまで");
  await page.getByRole("button", { name: "POST /orders L10–12", exact: true }).click();

  const diff = page.locator('.document-pane[data-pane="left"] diffs-container');
  await expect(diff.locator('[data-line="10"][data-editor-active-line]')).toBeVisible();
  await expect.poll(() => diff.locator("code").evaluate((code) => code.scrollLeft)).toBe(0);
  await expect(diff.locator('[data-line="1"] span').first()).toHaveText("import");

  await diff.locator("code").evaluate((code) => {
    code.scrollLeft = 80;
  });
  await page.keyboard.press("Control+Shift+F");
  await page.getByRole("textbox", { name: "全文検索" }).fill("routes.post");
  await page.getByRole("button", { name: "src/http/routes/orders.ts 10行" }).click();
  await expect.poll(() => diff.locator("code").evaluate((code) => code.scrollLeft)).toBe(80);
});
