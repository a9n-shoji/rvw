import { expect, test } from "@playwright/test";

const branchReviewId = "33333333-3333-4333-8333-333333333333";
const modifier = process.platform === "darwin" ? "Meta" : "Control";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/test/reset-branch-review", { data: {} });
  expect(response.ok()).toBe(true);
});

test("uses the shared review workspace for the default branch, Issues, code, and Walkthroughs", async ({
  page,
}) => {
  await page.goto(`/?branchReviewId=${branchReviewId}`);

  await expect(
    page.getByRole("heading", { name: /^Branch Review · trunk · [0-9a-f]{8}$/ }),
  ).toBeVisible();
  await expect(page.getByText("acme/review-repo", { exact: true })).toBeVisible();
  await expect(page.locator(".sidebar-stack-toggle")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "エクスプローラー", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByRole("button", { name: "コメント 2", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  const issues = page.getByRole("region", { name: "Issues" });
  const issueButtons = issues.locator(".issue-list-open");
  await expect(issueButtons).toHaveCount(2);
  await expect(issueButtons.nth(0)).toContainText("#142");
  await expect(issueButtons.nth(0)).toContainText("OPEN");
  await expect(issueButtons.nth(1)).toContainText("#19");
  await expect(issueButtons.nth(1)).toContainText("CLOSED");
  await expect(issueButtons.nth(1)).toContainText("stale");

  const commentsToggle = page.getByRole("button", { name: "コメント 2", exact: true });
  await commentsToggle.click();
  await expect(page.getByRole("button", { name: "未解決 2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "解決済み 1", exact: true })).toBeVisible();
  await expect(
    page.getByText("Verify the default-branch trimming behavior at its exact source.", {
      exact: true,
    }),
  ).toBeVisible();
  const codeComment = page.locator(".comment-list-item").filter({
    hasText: "Verify the default-branch trimming behavior at its exact source.",
  });
  await codeComment.getByRole("button", { name: "コメント対象を開く" }).click();
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  const source = leftPane.locator("diffs-container");
  await expect(page.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(source).toHaveAttribute("data-search-target-line", "2");
  await expect(source.locator('[data-line="2"][data-editor-active-line]')).toBeVisible();
  await page.getByRole("button", { name: "解決済み 1", exact: true }).click();
  await expect(
    page.getByText("The default-branch scope is confirmed.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "未解決 2", exact: true }).click();
  await commentsToggle.click();

  await issueButtons.nth(0).click();
  await expect(
    page.getByRole("heading", { name: "Stabilize the request path", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: /Remote diagram.*自動読み込み停止/ })).toBeVisible();

  const walkthroughFolder = page.getByRole("button", { name: "ウォークスルー 1" });
  await walkthroughFolder.click();
  const walkthroughButton = page.getByRole("button", {
    name: "Current request flow",
    exact: true,
  });
  await walkthroughButton.click({ modifiers: [modifier] });
  await expect(page.getByRole("region", { name: "右のコードペイン" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "右のコードペイン" }).getByRole("heading", {
      level: 1,
      name: "Current request flow",
      exact: true,
    }),
  ).toBeVisible();
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
    .click({ modifiers: [modifier] });
  await expect(page.getByRole("button", { name: "fixture.tsを閉じる" })).toBeVisible();

  await page.keyboard.press(`${modifier}+p`);
  const quickOpen = page.getByRole("dialog", { name: "ファイルを開く" });
  await expect(quickOpen).toBeVisible();
  await quickOpen.getByRole("combobox", { name: "ファイル名で検索" }).fill("README.md");
  await expect(quickOpen.getByRole("option", { name: "README.md" })).toBeVisible();
  await expect(quickOpen.getByRole("option", { name: "Pull Request.md" })).toHaveCount(0);
  await quickOpen.getByRole("option", { name: "README.md" }).click();
  await leftPane.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("img", { name: "Order lifecycle" })).toBeVisible();

  await page.getByRole("button", { name: "コード検索を開く" }).click();
  const searchInput = page.getByRole("textbox", { name: "全文検索" });
  await expect(searchInput).toBeFocused();
  await searchInput.fill("fixtureSearchTarget");
  await expect(page.getByText("1件・1ファイル", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "大文字小文字を区別" })).toBeVisible();
  await expect(page.getByRole("button", { name: "単語単位で検索" })).toBeVisible();
  await page.getByRole("button", { name: "src/fixture.ts 13行" }).click();
  await expect(source).toHaveAttribute("data-search-target-line", "13");
  await expect(source.locator('[data-line="13"][data-editor-active-line]')).toBeVisible();
  await page.goBack();
  await expect(leftPane.locator(".document-tab.active").getByText("README.md")).toBeVisible();
  await page.goForward();
  await expect(source.locator('[data-line="13"][data-editor-active-line]')).toBeVisible();
  await page.getByRole("button", { name: "ファイルツリーに戻る" }).click();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("紐づくコメント 1件と投稿 1件");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "ウォークスルーを削除" }).click();
  await expect(page.getByRole("button", { name: "ウォークスルー 0" })).toBeVisible();
  await expect(page.getByRole("button", { name: "コメント 1", exact: true })).toBeVisible();

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

  const issues = page.getByRole("region", { name: "Issues" });
  const issueButtons = issues.locator(".issue-list-open");
  const issueInput = issues.getByPlaceholder("#142 または Issue URL");
  await expect(issueButtons).toHaveCount(2);

  await issueInput.fill("#142");
  await issues.getByRole("button", { name: "追加", exact: true }).click();
  await expect(issueInput).toHaveValue("");
  await expect(issueButtons).toHaveCount(2);

  await issueInput.fill("#77");
  await issues.getByRole("button", { name: "追加", exact: true }).click();
  await expect(issueButtons).toHaveCount(3);
  await expect(issueButtons.first()).toContainText("#77");

  await issueButtons.filter({ hasText: "#142" }).click();
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  await leftPane.getByRole("button", { name: "Source", exact: true }).click();
  await leftPane.locator('[data-issue-line="1"]').click();
  await leftPane.locator(".document-comment-composer textarea").fill("Issue range fixture comment");
  await leftPane
    .locator(".document-comment-composer")
    .getByRole("button", { name: "コメント", exact: true })
    .click();
  await expect(leftPane.getByText("Issue range fixture comment", { exact: true })).toBeVisible();

  const commentsToggle = page.getByRole("button", { name: "コメント 3", exact: true });
  await commentsToggle.click();
  await page.getByRole("button", { name: "＋ Branch全体", exact: true }).click();
  await page.getByPlaceholder("Branch Review全体へのコメント").fill("Branch whole fixture comment");
  await page
    .locator(".review-comment-composer")
    .getByRole("button", { name: "コメント", exact: true })
    .click();
  await expect(page.getByText("Branch whole fixture comment", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "コメント 4", exact: true })).toBeVisible();

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
          resolvedAt: null,
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
    expect(dialog.message()).toContain("コードコメント 1");
    expect(dialog.message()).toContain("Branch全体コメント 2");
    expect(dialog.message()).toContain("Walkthroughコメント 1");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "Branch Reviewを削除して再構築" }).click();
  await expect(page).not.toHaveURL(`/?branchReviewId=${branchReviewId}`);
  await expect(page.getByRole("region", { name: "Issues" }).getByRole("heading")).toHaveText(
    "Issues 0",
  );
  await expect(page.getByRole("button", { name: "ウォークスルー 0" })).toBeVisible();
  await expect(page.getByRole("button", { name: "コメント 0", exact: true })).toBeVisible();
});
