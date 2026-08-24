import { expect, test, type Locator } from "@playwright/test";

const repositoryReviewId = "33333333-3333-4333-8333-333333333333";
const modifier = process.platform === "darwin" ? "Meta" : "Control";

async function selectMappedText(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.evaluate((element) => {
    const text = element.firstChild;
    if (!(text instanceof Text) || text.data.length === 0) {
      throw new Error("Expected a non-empty mapped text node.");
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
}

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/test/reset-repository-review", { data: {} });
  expect(response.ok()).toBe(true);
});

test("rejects a malformed Repository Review ID before starting Review queries", async ({
  page,
  request,
}) => {
  const repositoryRequests: string[] = [];
  page.on("request", (browserRequest) => {
    if (new URL(browserRequest.url()).pathname.startsWith("/api/repository-reviews/")) {
      repositoryRequests.push(browserRequest.url());
    }
  });
  await page.goto("/?repositoryReviewId=not-a-uuid");
  await expect(page.getByText("Repository Review IDが不正です。", { exact: true })).toBeVisible();
  expect(repositoryRequests).toEqual([]);
  expect((await request.get("/api/repository-reviews/not-a-uuid")).status()).toBe(400);
});

test("shows Issue refresh failures without reporting the whole Repository Review sync as clean", async ({
  page,
}) => {
  await page.route(`**/api/repository-reviews/${repositoryReviewId}/sync`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...body,
        issueResults: [
          {
            issue: {
              id: "44444444-4444-4444-8444-444444444444",
              number: 142,
            },
            ok: false,
            error: {
              code: "GITHUB_ISSUE_ERROR",
              message: "GitHub Issue responseのrepository identityがrequestと一致しません。",
              details: { reason: "ISSUE_IDENTITY_MISMATCH" },
              suggestions: [],
            },
          },
        ],
      },
    });
  });

  await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);
  const feedback = page.getByRole("status");
  await expect(feedback).toContainText("trunk · cccccccc に同期しました。");
  await expect(feedback).toContainText("Issue 1件の更新に失敗しました");
  await expect(feedback).toContainText("#142");
  await expect(feedback).toHaveClass(/sync-feedback-warning/);
});

test("does not let a delayed Repository Review reference replace newer navigation", async ({
  page,
}) => {
  let releaseRequest = (): void => undefined;
  const requestMayContinue = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let markRequestStarted = (): void => undefined;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  await page.route("**/api/repository-reviews/*/document?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "src/fixture.ts") {
      await route.continue();
      return;
    }
    markRequestStarted();
    await requestMayContinue;
    await route.continue();
  });

  try {
    await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);
    await page.getByRole("button", { name: "ウォークスルー 1" }).click();
    await page.getByRole("button", { name: "Current request flow", exact: true }).click();
    await page.getByRole("button", { name: /the implementation.*L1–3/ }).click();
    await requestStarted;

    await page.getByRole("button", { name: "README.md", exact: true }).click();
    const leftPane = page.getByRole("region", { name: "左のコードペイン" });
    await expect(leftPane.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const delayedResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/api/repository-reviews/${repositoryReviewId}/document` &&
        url.searchParams.get("path") === "src/fixture.ts"
      );
    });
    releaseRequest();
    await delayedResponse;
    await page.waitForTimeout(100);
    await expect(leftPane.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    releaseRequest();
  }
});

test("refreshes both pane details without losing unrelated UI state after an external Repository Walkthrough update", async ({
  page,
  request,
}) => {
  await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);
  await page.getByRole("button", { name: "ウォークスルー 1" }).click();
  const walkthroughButton = page.getByRole("button", {
    name: "Current request flow",
    exact: true,
  });
  await walkthroughButton.click();
  await walkthroughButton.click({ modifiers: [modifier] });
  await expect(page.getByRole("tab", { name: "Current request flow", exact: true })).toHaveCount(2);
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  const rightPane = page.getByRole("region", { name: "右のコードペイン" });
  for (const pane of [leftPane, rightPane]) {
    await expect(
      pane.getByRole("heading", { level: 1, name: "Current request flow", exact: true }),
    ).toBeVisible();
    await expect(
      pane.locator(".walkthrough-inline-reference").filter({ hasText: "the implementation" }),
    ).toHaveAttribute("title", "src/fixture.ts:L1–3");
    await expect(
      pane.getByRole("button", { name: "Request implementationをコードで開く" }),
    ).toBeVisible();
  }

  const commentsToggle = page.getByRole("button", { name: "コメント 2", exact: true });
  await commentsToggle.click();
  await page.getByRole("button", { name: "＋ Repository Review全体", exact: true }).click();
  const unrelatedDraft = page.getByPlaceholder("Repository Review全体へのコメント");
  await unrelatedDraft.fill("External Walkthrough refresh must preserve this draft");
  await unrelatedDraft.evaluate((element) => {
    element.dataset.rvwE2eIdentity = "unrelated-branch-draft";
  });
  await expect(unrelatedDraft).toBeFocused();

  const paneScroll = await Promise.all(
    [leftPane, rightPane].map(
      async (pane) =>
        await pane.evaluate((element) => {
          element.style.height = "120px";
          element.style.overflow = "auto";
          element.scrollTop = 40;
          return element.scrollTop;
        }),
    ),
  );
  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/meta/change-sequence" && response.ok(),
  );

  const updatedTitle = "Updated request flow";
  const updatedBody = [
    "# Updated request flow",
    "",
    "The external agent replaced the Markdown body.",
    "",
    "Open [the replacement](rvw-ref:replacement).",
    "",
    "```mermaid",
    "flowchart LR",
    "  replacement[Replacement] --> complete[Complete]",
    "```",
  ].join("\n");
  const update = await request.post("/api/test/update-repository-walkthrough", {
    data: {
      title: updatedTitle,
      body: updatedBody,
      references: [
        {
          id: "replacement",
          label: "Replacement handler",
          path: "README.md",
          startLine: 2,
          endLine: 4,
          description: "Updated external binding",
        },
      ],
      diagramBindings: { replacement: "replacement" },
    },
  });
  expect(update.ok()).toBe(true);
  await expect(page.getByRole("tab", { name: updatedTitle, exact: true })).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "Current request flow", exact: true })).toHaveCount(0);
  for (const [index, pane] of [leftPane, rightPane].entries()) {
    await expect(
      pane.getByRole("heading", { level: 1, name: updatedTitle, exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByText("The external agent replaced the Markdown body.", { exact: true }),
    ).toBeVisible();
    const replacementReference = pane
      .locator(".walkthrough-inline-reference")
      .filter({ hasText: "the replacement" });
    await expect(replacementReference).toHaveAttribute("title", "README.md:L2–4");
    await expect(replacementReference).toContainText("L2–4");
    await expect(
      pane.getByRole("button", { name: "Replacement handlerをコードで開く" }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "Request implementationをコードで開く" }),
    ).toHaveCount(0);
    await expect(
      pane.locator(".walkthrough-inline-reference").filter({ hasText: "the implementation" }),
    ).toHaveCount(0);
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(paneScroll[index]);
  }
  await expect(unrelatedDraft).toHaveValue("External Walkthrough refresh must preserve this draft");
  await expect(unrelatedDraft).toHaveAttribute("data-rvw-e2e-identity", "unrelated-branch-draft");
  await expect(unrelatedDraft).toBeFocused();
  await expect(rightPane).toBeVisible();

  const deletionEndpoint = `/api/repository-reviews/${repositoryReviewId}/walkthroughs/66666666-6666-4666-8666-666666666666`;
  const deletionPreview = await request.delete(deletionEndpoint, { data: { yes: false } });
  expect(deletionPreview.status()).toBe(409);
  const { confirmationToken } = (await deletionPreview.json()) as {
    confirmationToken: string;
  };
  const deletion = await request.delete(deletionEndpoint, {
    data: { yes: true, confirmationToken },
  });
  expect(deletion.ok()).toBe(true);
  await expect(page.getByRole("tab", { name: updatedTitle, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ウォークスルー 0" })).toBeVisible();
});

test("keeps a moved Repository Review document in its current pane during reading-history restore", async ({
  page,
}) => {
  await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);
  await page.getByRole("button", { name: "src フォルダ", exact: true }).click();
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await page.getByRole("button", { name: "README.md", exact: true }).click();

  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  const rightPane = page.getByRole("region", { name: "右のコードペイン" });
  await leftPane.getByRole("button", { name: "左ペインの操作" }).click();
  await leftPane.getByRole("menuitem", { name: "選択中のタブを右ペインへ移動" }).click();
  await expect(rightPane.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.goBack();
  await expect(leftPane.getByRole("tab", { name: "src/fixture.ts", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rightPane.getByRole("tab", { name: "README.md", exact: true })).toHaveCount(1);
  await page.goForward();
  await expect(rightPane.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(leftPane.getByRole("tab", { name: "README.md", exact: true })).toHaveCount(0);
});

test("restores the actual Repository Review pane scroll position after leaving a line jump", async ({
  page,
}) => {
  await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);
  await page.getByRole("button", { name: "コード検索を開く" }).click();
  await page.getByRole("textbox", { name: "全文検索", exact: true }).fill("dispatcher");
  await page.getByRole("button", { name: /README\.md \d+行/ }).click();

  const pane = page.getByRole("region", { name: "左のコードペイン" });
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  const lineJumpTop = await pane.evaluate((element) => element.scrollTop);
  await pane.hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeLessThan(lineJumpTop);
  const scrolledTop = await pane.evaluate((element) => element.scrollTop);
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
    .toBe(scrolledTop);

  await page.getByRole("button", { name: "ファイルツリーに戻る" }).click();
  await page.getByRole("button", { name: "src フォルダ", exact: true }).click();
  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  await page.goBack();
  await expect(pane.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(scrolledTop);
});

test("uses the shared review workspace for the default branch, Issues, code, and Walkthroughs", async ({
  page,
}) => {
  await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);

  await expect(
    page.getByRole("heading", { name: /^Repository Review · trunk · [0-9a-f]{8}$/ }),
  ).toBeVisible();
  await expect(page.getByText("acme/review-repo · remote origin", { exact: true })).toHaveAttribute(
    "title",
    "https://github.com/acme/review-repo.git",
  );
  await expect(page.locator(".sidebar-stack-toggle")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "エクスプローラー", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByRole("button", { name: "コメント 2", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await expect(reviewTree.getByRole("button", { name: "Issues 2", exact: true })).toBeVisible();
  const issueButtons = reviewTree.locator(".review-tree-issue");
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
  await expect(
    leftPane.locator(".comment-thread--inline").filter({
      hasText: "Verify the default-branch trimming behavior at its exact source.",
    }),
  ).toBeVisible();
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
  const issueAttachment = page.getByRole("img", { name: "Issue attachment", exact: true });
  await expect(issueAttachment).toHaveAttribute(
    "src",
    new RegExp(`/api/repository-reviews/${repositoryReviewId}/github-attachment\\?url=`),
  );
  await expect
    .poll(() => issueAttachment.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(320);
  await expect(page.locator("td").filter({ has: issueAttachment })).toHaveCount(1);
  await expect(
    page.getByRole("img", { name: /External planning diagram.*自動読み込み停止/ }),
  ).toBeVisible();

  const walkthroughFolder = page.getByRole("button", { name: "ウォークスルー 1" });
  await walkthroughFolder.click();
  const walkthroughButton = page.getByRole("button", {
    name: "Current request flow",
    exact: true,
  });
  await walkthroughButton.click({ modifiers: [modifier] });
  const rightPane = page.getByRole("region", { name: "右のコードペイン" });
  await expect(rightPane).toBeVisible();
  await expect(
    rightPane.getByRole("heading", {
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
  await expect(
    rightPane.getByRole("button", { name: "src/fixture.tsを閉じる", exact: true }),
  ).toBeVisible();

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
    expect(dialog.message()).toContain("紐づくコメント 1件、投稿 1件、コード参照 1件");
    await dialog.accept();
  });
  await page
    .getByRole("region", { name: "右のコードペイン" })
    .getByRole("tab", { name: "Current request flow", exact: true })
    .click();
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

test("keeps Repository Review mutations isolated and recreates an empty review after reset", async ({
  page,
  request,
}) => {
  const pullRequestCommentsBefore = (await (
    await request.get("/api/pull-requests/11111111-1111-4111-8111-111111111111/comments")
  ).json()) as Record<string, unknown>;
  await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);

  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  const issueButtons = reviewTree.locator(".review-tree-issue");
  const addIssueButton = reviewTree.getByRole("button", { name: "Issueを追加", exact: true });
  const issueInput = reviewTree.getByRole("textbox", { name: "Issue番号またはURL" });
  await expect(issueButtons).toHaveCount(2);
  await expect(issueInput).toHaveCount(0);

  await addIssueButton.click();
  await issueInput.fill("#142");
  await reviewTree.getByRole("button", { name: "追加", exact: true }).click();
  await expect(issueInput).toHaveCount(0);
  await expect(issueButtons).toHaveCount(2);

  await addIssueButton.click();
  await issueInput.fill("#77");
  await reviewTree.getByRole("button", { name: "追加", exact: true }).click();
  await expect(issueButtons).toHaveCount(3);
  await expect(issueButtons.first()).toContainText("#77");

  await issueButtons.filter({ hasText: "#142" }).click();
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  await expect(leftPane.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
  await expect(leftPane.getByRole("textbox", { name: "Issue全体へコメント" })).toHaveCount(0);
  await leftPane.getByRole("button", { name: "Issue全体へコメント" }).click();
  await expect(leftPane.getByRole("textbox", { name: "Issue全体へコメント" })).toBeVisible();
  await leftPane.getByRole("textbox", { name: "Issue全体へコメント" }).press("Escape");
  const issueBodyLine = leftPane
    .locator('[data-rvw-source-start-line="3"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "Inspect the default-branch implementation." });
  await selectMappedText(issueBodyLine);
  await leftPane.getByRole("button", { name: "L3へコメント", exact: true }).click();
  await leftPane
    .getByRole("textbox", { name: "#142 · L3へコメント" })
    .fill("Issue range fixture comment");
  await leftPane
    .locator(".markdown-selection-composer-slot")
    .getByRole("button", { name: "コメント", exact: true })
    .click();
  await expect(leftPane.getByText("Issue range fixture comment", { exact: true })).toBeVisible();

  const commentsToggle = page.getByRole("button", { name: "コメント 3", exact: true });
  await commentsToggle.click();
  await page.getByRole("button", { name: "＋ Repository Review全体", exact: true }).click();
  await page
    .getByPlaceholder("Repository Review全体へのコメント")
    .fill("Repository Review whole fixture comment");
  await page
    .locator(".review-comment-composer")
    .getByRole("button", { name: "コメント", exact: true })
    .click();
  await expect(
    page.getByText("Repository Review whole fixture comment", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "コメント 4", exact: true })).toBeVisible();

  const repositoryComments = (await (
    await request.get(`/api/repository-reviews/${repositoryReviewId}/comments`)
  ).json()) as { comments: unknown[] };
  expect(repositoryComments.comments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        comment: expect.objectContaining({
          repositoryReviewId,
          target: expect.objectContaining({
            kind: "issue",
            issueNumber: 142,
            issueTitle: "Stabilize the request path",
            startLine: 3,
            endLine: 3,
          }),
        }),
      }),
      expect.objectContaining({
        comment: expect.objectContaining({
          repositoryReviewId,
          target: { kind: "repository" },
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
    expect(dialog.message()).toContain("Repository Review全体コメント 2");
    expect(dialog.message()).toContain("Walkthroughコメント 1");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "Repository Reviewを削除して再構築" }).click();
  await expect(page).not.toHaveURL(`/?repositoryReviewId=${repositoryReviewId}`);
  await expect(page.getByRole("button", { name: "Issues 0", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "ウォークスルー 0" })).toBeVisible();
  await expect(page.getByRole("button", { name: "コメント 0", exact: true })).toBeVisible();
});

test("distinguishes a completed Repository Review reset from a failed reopen", async ({ page }) => {
  await page.route(`**/api/repository-reviews/${repositoryReviewId}/reset`, async (route) => {
    const input = route.request().postDataJSON() as { yes: boolean };
    if (!input.yes) {
      await route.fulfill({
        status: 409,
        json: {
          ok: false,
          error: { code: "RESET_CONFIRMATION_REQUIRED", message: "reset confirmation required" },
          counts: {
            issueMemberships: 0,
            issueComments: 0,
            codeComments: 0,
            reviewComments: 0,
            walkthroughComments: 0,
            posts: 0,
            walkthroughs: 0,
            gitRefs: 0,
          },
          retainedRefs: [],
          confirmationToken: "e".repeat(64),
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        repositoryReview: { id: repositoryReviewId },
        deleted: { repositoryReview: 1 },
        removedRefs: [],
        outcome: { kind: "completed" },
      },
    });
  });
  await page.route("**/api/repository-reviews/open", async (route) => {
    await route.fulfill({
      status: 502,
      json: {
        ok: false,
        error: {
          code: "GITHUB_REPOSITORY_ERROR",
          message: "default branchを取得できませんでした。",
        },
      },
    });
  });
  await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);

  page.once("dialog", async (dialog) => await dialog.accept());
  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "Repository Reviewを削除して再構築" }).click();

  await expect(
    page.getByRole("heading", { name: "Repository Reviewのresetは完了しました" }),
  ).toBeVisible();
  await expect(page.getByText(/rvw repository open/)).toBeVisible();
  await expect(
    page.getByText("default branchを取得できませんでした。", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/?repositoryReviewId=${repositoryReviewId}`);
});

test("clears deleted Repository Review state after reset leaves isolated orphan refs", async ({
  page,
}) => {
  let reopenRequests = 0;
  await page.route(`**/api/repository-reviews/${repositoryReviewId}/reset`, async (route) => {
    const input = route.request().postDataJSON() as { yes: boolean };
    if (!input.yes) {
      await route.fulfill({
        status: 409,
        json: {
          ok: false,
          error: { code: "RESET_CONFIRMATION_REQUIRED", message: "reset confirmation required" },
          counts: {
            issueMemberships: 0,
            issueComments: 0,
            codeComments: 0,
            reviewComments: 0,
            walkthroughComments: 0,
            posts: 0,
            walkthroughs: 0,
            gitRefs: 1,
          },
          retainedRefs: [`refs/rvw/repository/${repositoryReviewId}/commits/oid-${"c".repeat(40)}`],
          confirmationToken: "d".repeat(64),
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        repositoryReview: { id: repositoryReviewId },
        deleted: { repositoryReview: 1, gitRefs: 0 },
        removedRefs: [],
        outcome: {
          kind: "completed-with-orphan-refs",
          repositoryReviewDeleted: true,
          remainingRefs: [
            `refs/rvw/repository/${repositoryReviewId}/commits/oid-${"c".repeat(40)}`,
          ],
          refPrefix: `refs/rvw/repository/${repositoryReviewId}/commits/`,
          repositoryPath: "/fixture/review-repo",
          manualCleanupPossible: true,
        },
      },
    });
  });
  await page.route("**/api/repository-reviews/open", async (route) => {
    reopenRequests += 1;
    await route.abort();
  });
  await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);

  page.once("dialog", async (dialog) => await dialog.accept());
  await page.getByRole("button", { name: "その他の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "Repository Reviewを削除して再構築" }).click();

  await expect(
    page.getByRole("heading", { name: "Repository Reviewのresetは完了しました" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("新しいReviewから隔離されています");
  await expect(page.getByRole("alert")).toContainText(
    `refs/rvw/repository/${repositoryReviewId}/commits/`,
  );
  await expect(page.getByText(/rvw repository open/)).toBeVisible();
  expect(reopenRequests).toBe(0);
});

test("keeps an Issue range composer focused across a same-body Repository Review refresh", async ({
  page,
  request,
}) => {
  await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await reviewTree.locator(".review-tree-issue").filter({ hasText: "#142" }).click();
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  const issueBodyLine = leftPane
    .locator('[data-rvw-source-start-line="3"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "Inspect the default-branch implementation." });
  await selectMappedText(issueBodyLine);
  await leftPane.getByRole("button", { name: "L3へコメント", exact: true }).click();
  const textarea = leftPane.getByRole("textbox", { name: "#142 · L3へコメント" });
  await textarea.fill("Background sync must preserve this draft");
  await textarea.evaluate((element) => {
    element.dataset.rvwE2eIdentity = "original-textarea";
  });
  await expect(textarea).toBeFocused();

  const refresh = await request.post("/api/test/refresh-repository-review", {
    data: { sourceOid: "b".repeat(40) },
  });
  expect(refresh.ok()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Repository Review · trunk · bbbbbbbb" }),
  ).toBeVisible();
  await expect(textarea).toHaveValue("Background sync must preserve this draft");
  await expect(textarea).toHaveAttribute("data-rvw-e2e-identity", "original-textarea");
  await expect(textarea).toBeFocused();

  await leftPane
    .locator(".markdown-selection-composer-slot")
    .getByRole("button", { name: "コメント", exact: true })
    .click();
  await expect(
    leftPane.getByText("Background sync must preserve this draft", { exact: true }),
  ).toBeVisible();
});

test("refreshes an open Issue body without silently applying a stale range draft", async ({
  page,
  request,
}) => {
  await page.goto(`/?repositoryReviewId=${repositoryReviewId}`);
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await reviewTree.locator(".review-tree-issue").filter({ hasText: "#142" }).click();
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  const originalLine = leftPane
    .locator('[data-rvw-source-start-line="3"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "Inspect the default-branch implementation." });

  await selectMappedText(originalLine);
  await leftPane.getByRole("button", { name: "L3へコメント", exact: true }).click();
  await leftPane
    .getByRole("textbox", { name: "#142 · L3へコメント" })
    .fill("Comment that should become outdated");
  await leftPane
    .locator(".markdown-selection-composer-slot")
    .getByRole("button", { name: "コメント", exact: true })
    .click();
  await expect(
    leftPane.getByText("Comment that should become outdated", { exact: true }),
  ).toBeVisible();
  // Let the sequence-driven comment/document refresh settle before creating the next range.
  // Otherwise the just-opened selection menu can correctly disappear with the replaced DOM.
  await expect(page.getByRole("button", { name: "コメント 3", exact: true })).toBeVisible();

  await selectMappedText(originalLine);
  await leftPane.getByRole("button", { name: "L3へコメント", exact: true }).click();
  const textarea = leftPane.getByRole("textbox", { name: "#142 · L3へコメント" });
  await textarea.fill("Preserve this unsent draft");
  await expect(textarea).toBeFocused();

  const updatedBody = [
    "# Stabilize the request path",
    "",
    "Inspect the refreshed default-branch implementation.",
    "",
    "The Issue body changed while a reviewer was writing.",
  ].join("\n");
  const refresh = await request.post("/api/test/refresh-repository-review", {
    data: { issueNumber: 142, issueBody: updatedBody },
  });
  expect(refresh.ok()).toBe(true);
  const refreshedLine = leftPane
    .locator('[data-rvw-source-start-line="3"][data-rvw-source-leaf="true"]')
    .filter({ hasText: "Inspect the refreshed default-branch implementation." });
  await expect(refreshedLine).toBeVisible();
  await expect(textarea).toHaveValue("Preserve this unsent draft");
  await expect(textarea).toBeFocused();
  await expect(
    leftPane.getByText(
      "Issue本文が更新されました。draftは保持されています。現在の本文で範囲を選び直してください。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    leftPane
      .locator(".markdown-selection-composer-slot")
      .getByRole("button", { name: "コメント", exact: true }),
  ).toBeDisabled();

  const commentsToggle = page.getByRole("button", { name: "コメント 3", exact: true });
  await commentsToggle.click();
  const outdatedComment = page.locator(".comment-list-item").filter({
    hasText: "Comment that should become outdated",
  });
  await expect(outdatedComment.locator(".badge--outdated")).toBeVisible();
  await expect(
    leftPane.locator(".markdown-inline-comments").getByText("Comment that should become outdated"),
  ).toHaveCount(0);
  await commentsToggle.click();

  await selectMappedText(refreshedLine);
  await leftPane.getByRole("button", { name: "L3へコメント", exact: true }).click();
  const refreshedTextarea = leftPane.getByRole("textbox", { name: "#142 · L3へコメント" });
  await expect(refreshedTextarea).toHaveValue("Preserve this unsent draft");
  await leftPane
    .locator(".markdown-selection-composer-slot")
    .getByRole("button", { name: "コメント", exact: true })
    .click();
  await expect(leftPane.getByText("Preserve this unsent draft", { exact: true })).toBeVisible();
});
