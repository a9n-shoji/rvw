import { expect, test } from "@playwright/test";

const branchReviewId = "33333333-3333-4333-8333-333333333333";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/test/reset-branch-review", { data: {} });
  expect(response.ok()).toBe(true);
});

test("reads the default branch, Issues, code, and Walkthrough in one Branch Review", async ({
  page,
}) => {
  await page.goto(`/?branchReviewId=${branchReviewId}`);

  await expect(
    page.getByRole("heading", { name: /^Branch Review · trunk · [0-9a-f]{8}$/ }),
  ).toBeVisible();
  await expect(page.getByText("acme/review-repo", { exact: true })).toBeVisible();

  const issueButtons = page
    .locator(".branch-sidebar-section")
    .first()
    .locator(".branch-list .issue-list-open");
  await expect(issueButtons).toHaveCount(2);
  await expect(issueButtons.nth(0)).toContainText("#142");
  await expect(issueButtons.nth(0)).toContainText("OPEN");
  await expect(issueButtons.nth(1)).toContainText("#19");
  await expect(issueButtons.nth(1)).toContainText("CLOSED");
  await expect(issueButtons.nth(1)).toContainText("stale");
  expect(
    await page.evaluate(() => {
      const code = document.querySelector(".branch-code-section")?.getBoundingClientRect();
      const comments = document.querySelector(".branch-comments-section")?.getBoundingClientRect();
      return Boolean(code && comments && comments.top >= code.bottom);
    }),
  ).toBe(true);

  await issueButtons.nth(0).click();
  await expect(page.getByRole("heading", { name: "Stabilize the request path" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Remote diagram.*自動読み込み停止/ })).toBeVisible();

  const walkthroughButton = page.getByRole("button", {
    name: "Current request flow",
    exact: true,
  });
  await walkthroughButton.click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  await expect(page.getByRole("region", { name: "right document pane" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current request flow" })).toBeVisible();
  await expect(
    page
      .locator(".walkthrough-markdown")
      .getByText("Confirm this entry point against the exact default-branch source."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Request implementationをコードで開く" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /the implementation.*L1–3/ })
    .click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await expect(page.getByRole("button", { name: "fixture.tsを閉じる" })).toBeVisible();

  await page.keyboard.press(process.platform === "darwin" ? "Meta+p" : "Control+p");
  const quickOpen = page.getByRole("dialog", { name: "ファイルを開く" });
  await expect(quickOpen).toBeVisible();
  await quickOpen.getByRole("combobox", { name: "ファイル名で検索" }).fill("README.md");
  await expect(quickOpen.getByRole("option", { name: "README.md" })).toBeVisible();
  await expect(quickOpen.getByRole("option", { name: "Pull Request.md" })).toHaveCount(0);
  await quickOpen.getByRole("option", { name: "README.md" }).click();
  await page
    .getByRole("region", { name: "left document pane" })
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await expect(page.getByRole("img", { name: "Order lifecycle" })).toBeVisible();

  await page.getByPlaceholder("コード全文検索").fill("fixtureSearchTarget");
  const searchResult = page.getByRole("button", { name: /src\/fixture\.ts:13/ });
  await expect(searchResult).toBeVisible();
  await searchResult.click();
  await expect(
    page.locator('[data-branch-pane="left"][data-branch-line="13"].is-navigation-target'),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page
      .getByRole("region", { name: "left document pane" })
      .locator(".document-tab.active")
      .getByText("README.md"),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.locator('[data-branch-pane="left"][data-branch-line="13"].is-navigation-target'),
  ).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Issue #19 Document recovery");
    expect(dialog.message()).toContain("Issue本文rangeコメント 0");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "#19を削除" }).click();
  await expect(issueButtons).toHaveCount(1);
  await expect(page.getByRole("button", { name: "#19を削除" })).toHaveCount(0);
});

test("keeps Branch mutations isolated and recreates an empty review after reset", async ({
  page,
  request,
}) => {
  const pullRequestCommentsBefore = (await (
    await request.get("/api/pull-requests/11111111-1111-4111-8111-111111111111/comments")
  ).json()) as Record<string, unknown>;
  await page.goto(`/?branchReviewId=${branchReviewId}`);

  const issueSection = page.locator(".branch-sidebar-section").first();
  const issueButtons = issueSection.locator(".branch-list .issue-list-open");
  const issueInput = issueSection.getByPlaceholder("#142 または Issue URL");
  await expect(issueButtons).toHaveCount(2);

  await issueInput.fill("#142");
  await issueSection.getByRole("button", { name: "追加", exact: true }).click();
  await expect(issueInput).toHaveValue("");
  await expect(issueButtons).toHaveCount(2);

  await issueInput.fill("#77");
  await issueSection.getByRole("button", { name: "追加", exact: true }).click();
  await expect(issueButtons).toHaveCount(3);
  await expect(issueButtons.first()).toContainText("#77");

  await issueButtons.filter({ hasText: "#142" }).click();
  const leftPane = page.getByRole("region", { name: "left document pane" });
  await leftPane.getByRole("button", { name: "Source", exact: true }).click();
  await leftPane.locator('[data-branch-line="1"]').click();
  await leftPane.getByPlaceholder("RVW Comment").fill("Issue range fixture comment");
  await leftPane.getByRole("button", { name: "コメント", exact: true }).click();
  await expect(leftPane.getByText("Issue range fixture comment", { exact: true })).toBeVisible();

  await page.getByPlaceholder("Branch Review全体へコメント").fill("Branch whole fixture comment");
  await page.getByRole("button", { name: "全体コメントを追加", exact: true }).click();
  await expect(page.getByText("Branch whole fixture comment", { exact: true })).toBeVisible();
  await expect(page.locator(".branch-comments-section h2")).toContainText("3");

  const branchComments = (await (
    await request.get(`/api/branch-reviews/${branchReviewId}/comments`)
  ).json()) as { comments: unknown[] };
  expect(branchComments.comments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        comment: expect.objectContaining({
          branchReviewId,
          target: expect.objectContaining({
            kind: "issue",
            issueNumber: 142,
            issueTitle: "Stabilize the request path",
            startLine: 1,
            endLine: 1,
          }),
        }),
      }),
      expect.objectContaining({
        comment: expect.objectContaining({
          branchReviewId,
          target: { kind: "branch" },
        }),
      }),
    ]),
  );
  const pullRequestCommentsAfter = (await (
    await request.get("/api/pull-requests/11111111-1111-4111-8111-111111111111/comments")
  ).json()) as Record<string, unknown>;
  expect(pullRequestCommentsAfter).toEqual(pullRequestCommentsBefore);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Issue membership 3");
    expect(dialog.message()).toContain("Issueコメント 1");
    expect(dialog.message()).toContain("Branch全体コメント 1");
    expect(dialog.message()).toContain("Walkthroughコメント 1");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "リセット", exact: true }).click();
  await expect(page).not.toHaveURL(`/?branchReviewId=${branchReviewId}`);
  await expect(page.locator(".branch-sidebar-section").first().locator("h2")).toContainText(
    "Issues 0",
  );
  await expect(page.getByRole("heading", { name: /^Walkthroughs 0$/ })).toBeVisible();
  await expect(page.locator(".branch-comments-section h2")).toContainText("0");
});
