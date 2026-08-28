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

  await page.getByRole("button", { name: "Pull Request一覧へ" }).click();
  await expect(page.getByRole("heading", { name: "Pull Requests" })).toBeVisible();
  await page.goBack();
  await expect(page.locator(".pr-heading h1")).toContainText("Fixture review");
  await expect(page.locator(".document-tab.active")).toContainText("fixture.ts");
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
    const listButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Pull Request一覧へ"]',
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
