import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const unknownPullRequestId = "22222222-2222-4222-8222-222222222222";
const firstHead = "b".repeat(40);
const secondHead = "c".repeat(40);

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
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "全ファイル", exact: true }).click();
  await page.getByRole("button", { name: "binary.bin", exact: true }).click();
  await expect(page.getByText("非UTF-8またはbinaryのため本文を表示できません。")).toBeVisible();
  await expect(page.locator("diffs-container")).toHaveCount(0);

  await page.getByRole("button", { name: "ファイル全体へコメント" }).click();
  const composer = page.locator(".inline-comment-composer--file");
  await composer
    .getByRole("textbox", { name: "ファイル全体へコメント" })
    .fill("Binary artifact needs a file-level note.");
  await composer.getByRole("button", { name: "コメント", exact: true }).click();
  await expect(
    page.getByText("Binary artifact needs a file-level note.", { exact: true }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "全ファイル", exact: true }).click();
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
  await page.getByRole("button", { name: "全ファイル", exact: true }).click();
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
  await page.getByRole("button", { name: "全ファイル", exact: true }).click();
  await page.getByRole("button", { name: "README.md", exact: true }).click({ modifiers: ["Meta"] });
  await page
    .getByRole("button", { name: "注文作成フロー：HTTPからtransactional outboxまで", exact: true })
    .click();
  await page.getByRole("button", { name: "POST /orders L10–12", exact: true }).click();

  const diff = page.locator('.document-pane[data-pane="right"] diffs-container');
  await expect(diff.locator('[data-line="10"][data-editor-active-line]')).toBeVisible();
  await expect.poll(() => diff.locator("code").evaluate((code) => code.scrollLeft)).toBe(0);
  await expect(diff.locator('[data-line="1"] span').first()).toHaveText("import");

  await diff.locator("code").evaluate((code) => {
    code.scrollLeft = 80;
  });
  await page.getByRole("textbox", { name: "全文検索" }).fill("routes.post");
  await page.getByRole("button", { name: "src/http/routes/orders.ts 10行" }).click();
  await expect.poll(() => diff.locator("code").evaluate((code) => code.scrollLeft)).toBe(80);
});
