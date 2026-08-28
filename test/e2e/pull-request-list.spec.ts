import { expect, test } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";

test.afterEach(async ({ request }) => {
  await Promise.all([
    request.post("/api/test/reset-sync-stage", { data: {} }),
    request.post("/api/test/reset-pull-request-list", { data: {} }),
  ]);
});

test("lists saved Pull Requests and navigates through browser history", async ({
  page,
  request,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Pull Requests" })).toBeVisible();
  await expect(page.getByText("GitHubでの更新が新しい順")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Closed / Merged を非表示" })).toBeChecked();
  const rows = page.locator(".pull-request-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("acme/review-repo");
  await expect(rows.first()).toContainText("#7");
  await expect(rows.first()).toContainText(/Fixture review/);
  await expect(rows.first().getByLabel("Pull Request status: Open")).toBeVisible();
  await expect(rows.nth(1).getByLabel("Pull Request status: Draft")).toBeVisible();
  const longTitle = rows.nth(1).locator(".pull-request-row__title");
  await expect(longTitle).toHaveText(
    "Older fixture review with a deliberately long Pull Request title that must wrap onto multiple lines without being truncated",
  );
  await expect(longTitle).toHaveCSS("white-space", "normal");
  const titleLayout = await longTitle.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(window.getComputedStyle(element).lineHeight),
  }));
  expect(titleLayout.height).toBeGreaterThan(titleLayout.lineHeight * 1.5);
  await expect(rows.nth(1)).toContainText("3 unresolved");
  await expect(rows.nth(1)).toContainText("5 resolved");
  await expect(rows.nth(1)).toContainText("2 walkthroughs");
  await expect(rows.nth(1).getByText("不明")).toBeVisible();
  await expect(page.getByText("1–2 / 2")).toBeVisible();
  const browserCloseGuard = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    const dispatchAllowed = window.dispatchEvent(event);
    return { dispatchAllowed, defaultPrevented: event.defaultPrevented };
  });
  expect(browserCloseGuard).toEqual({ dispatchAllowed: true, defaultPrevented: false });

  await expect
    .poll(async () => {
      const response = await request.get("/api/test/viewers");
      const body = (await response.json()) as { activeViewers: string[] };
      return body.activeViewers.length;
    })
    .toBeGreaterThan(0);

  await rows.first().click();
  await expect(page).toHaveURL(new RegExp(`pullRequestId=${pullRequestId}`));
  await expect(page.locator(".pr-heading h1")).toContainText("Fixture review");

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Pull Requests" })).toBeVisible();
  await page.goForward();
  await expect(page.locator(".pr-heading h1")).toContainText("Fixture review");

  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await expect(page.locator(".document-tab.active")).toContainText("fixture.ts");

  await page.getByRole("link", { name: "Pull Request一覧へ" }).click();
  await expect(page.getByRole("heading", { name: "Pull Requests" })).toBeVisible();
  await page.goBack();
  await expect(page.locator(".pr-heading h1")).toContainText("Fixture review");
  await expect(page.locator(".document-tab.active")).toContainText("fixture.ts");
});

test("opens the Pull Request list in a new tab from a modified logo click", async ({
  page,
  context,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const logo = page.getByRole("link", { name: "Pull Request一覧へ" });
  await expect(logo).toHaveAttribute("href", "/");

  const newPagePromise = context.waitForEvent("page");
  await logo.click({ modifiers: ["ControlOrMeta"] });
  const listPage = await newPagePromise;

  await expect(listPage.getByRole("heading", { name: "Pull Requests" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`pullRequestId=${pullRequestId}`));
  await listPage.close();
});

test("refreshes eligible saved Pull Request statuses only after an explicit click", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator(".pull-request-row")).toHaveCount(2);
  await expect
    .poll(async () => {
      const response = await request.get("/api/test/pull-request-status-refresh-count");
      return ((await response.json()) as { count: number }).count;
    })
    .toBe(0);

  await page.getByRole("button", { name: "PRステータスを一括更新" }).click();

  await expect(page.getByRole("status")).toHaveText("2件のPRステータスを更新しました。");
  await expect(
    page.getByRole("heading", { name: "Closed / Merged以外のPull Requestはありません" }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const response = await request.get("/api/test/pull-request-status-refresh-count");
      return ((await response.json()) as { count: number }).count;
    })
    .toBe(1);
});

test("keeps successful status updates and shows partial failures immediately", async ({
  page,
  request,
}) => {
  await request.post("/api/test/pull-request-status-refresh-failure", {
    data: { enabled: true },
  });
  await page.goto("/");

  await page.getByRole("button", { name: "PRステータスを一括更新" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("1件のPRステータスを更新しました。");
  await expect(alert).toContainText("1件を更新できませんでした");
  await expect(alert).toContainText(
    "octo-org/review-repo#3: Pull Request状態をGitHubから取得できませんでした。",
  );
  await expect(page.locator(".pull-request-row")).toHaveCount(1);
  await expect(page.locator(".pull-request-row")).toContainText("#3");
});

test("shows an actionable empty state when no Pull Requests are saved", async ({
  page,
  request,
}) => {
  await request.post("/api/test/pull-request-list-empty", { data: { enabled: true } });
  try {
    await page.goto("/");
    const hideClosedOrMergedFilter = page.getByRole("checkbox", {
      name: "Closed / Merged を非表示",
    });
    await expect(
      page.getByRole("heading", { name: "Closed / Merged以外のPull Requestはありません" }),
    ).toBeVisible();
    await hideClosedOrMergedFilter.uncheck();
    await expect(
      page.getByRole("heading", { name: "まだレビュー対象が登録されていません" }),
    ).toBeVisible();
    await expect(page.getByText("rvw open <PR URL>", { exact: false })).toBeVisible();
    await expect(page.locator(".pull-request-row")).toHaveCount(0);
  } finally {
    await request.post("/api/test/pull-request-list-empty", { data: { enabled: false } });
  }
});

test("keeps the current list page in URL and browser history", async ({ page, request }) => {
  await request.post("/api/test/pull-request-list-paginated", { data: { enabled: true } });
  await page.goto("/");

  await expect(page.locator(".pull-request-row")).toHaveCount(50);
  await expect(page.getByText("1–50 / 51")).toBeVisible();
  await page.getByRole("button", { name: "次へ", exact: true }).click();

  await expect(page).toHaveURL(/\?offset=50$/);
  await expect(page.getByText("51–51 / 51")).toBeVisible();
  const row = page.locator(".pull-request-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Fixture review");
  await expect(row).toHaveAttribute("href", `/?offset=50&pullRequestId=${pullRequestId}`);

  await row.click();
  await expect(page).toHaveURL(new RegExp(`offset=50&pullRequestId=${pullRequestId}`));
  await expect(page.locator(".pr-heading h1")).toContainText("Fixture review");

  await page.goBack();
  await expect(page).toHaveURL(/\?offset=50$/);
  await expect(page.getByText("51–51 / 51")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("1–50 / 51")).toBeVisible();
});

test("moves to the last valid page when a status refresh invalidates the current page", async ({
  page,
  request,
}) => {
  await request.post("/api/test/pull-request-list-paginated", { data: { enabled: true } });
  await page.goto("/?offset=50");
  await expect(page.getByText("51–51 / 51")).toBeVisible();

  await page.getByRole("button", { name: "PRステータスを一括更新" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("1–50 / 50")).toBeVisible();
  await expect(page.locator(".pull-request-row")).toHaveCount(50);
  await expect(
    page.getByRole("heading", { name: "Closed / Merged以外のPull Requestはありません" }),
  ).toHaveCount(0);
});

test("preserves drafts and the latest reading position when returning to the list", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.keyboard.press("Control+Shift+F");
  await page.getByRole("textbox", { name: "全文検索", exact: true }).fill("dispatcher");
  await page.getByRole("button", { name: "README.md 50行", exact: true }).click();

  const pane = page.locator('.document-pane[data-pane="left"]');
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(800);
  await page.getByRole("button", { name: "ファイル全体へコメント" }).click();
  await page
    .getByRole("textbox", { name: "ファイル全体へコメント" })
    .fill("一覧から戻っても保持する未送信ドラフト");

  await page.evaluate(() => {
    const paneElement = document.querySelector<HTMLElement>('.document-pane[data-pane="left"]');
    const listButton = document.querySelector<HTMLAnchorElement>(
      'a[aria-label="Pull Request一覧へ"]',
    );
    if (!paneElement || !listButton) throw new Error("review navigation controls are unavailable");
    paneElement.scrollTop = 200;
    paneElement.dispatchEvent(new Event("scroll", { bubbles: true }));
    listButton.click();
  });

  await expect(page.getByRole("heading", { name: "Pull Requests" })).toBeVisible();
  const browserCloseGuard = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    const dispatchAllowed = window.dispatchEvent(event);
    return { dispatchAllowed, defaultPrevented: event.defaultPrevented };
  });
  expect(browserCloseGuard).toEqual({ dispatchAllowed: false, defaultPrevented: true });

  await page.goBack();
  await expect(page.locator(".pr-heading h1")).toContainText("Fixture review");
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(200);
  await expect(page.getByRole("textbox", { name: "ファイル全体へコメント" })).toHaveValue(
    "一覧から戻っても保持する未送信ドラフト",
  );
});

test("refreshes relative timestamps while the list remains open", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-08T01:02:00.000Z") });
  await page.goto("/");
  const updatedAt = page
    .locator(".pull-request-row")
    .first()
    .locator(".pull-request-row__date--updated time");
  const initialLabel = await updatedAt.innerText();

  await page.clock.fastForward(60_000);

  await expect(updatedAt).not.toHaveText(initialLabel);
});
