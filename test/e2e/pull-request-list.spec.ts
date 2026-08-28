import { expect, test } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";

test.afterEach(async ({ request }) => {
  await request.post("/api/test/reset-sync-stage", { data: {} });
});

test("lists saved Pull Requests and navigates through browser history", async ({
  page,
  request,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Pull Requests" })).toBeVisible();
  await expect(page.getByText("GitHubでの更新が新しい順")).toBeVisible();
  const rows = page.locator(".pull-request-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("acme/review-repo");
  await expect(rows.first()).toContainText("#7");
  await expect(rows.first()).toContainText(/Fixture review/);
  await expect(rows.nth(1)).toContainText("3 open");
  await expect(rows.nth(1)).toContainText("5 resolved");
  await expect(rows.nth(1)).toContainText("2 walkthroughs");
  await expect(rows.nth(1).getByText("不明")).toBeVisible();
  await expect(page.getByText("1–2 / 2")).toBeVisible();

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
    await expect(
      page.getByRole("heading", { name: "まだレビュー対象が登録されていません" }),
    ).toBeVisible();
    await expect(page.getByText("rvw open <PR URL>", { exact: false })).toBeVisible();
    await expect(page.locator(".pull-request-row")).toHaveCount(0);
  } finally {
    await request.post("/api/test/pull-request-list-empty", { data: { enabled: false } });
  }
});
