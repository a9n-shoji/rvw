import { expect, test } from "@playwright/test";

const defaultPort = Number(process.env.RVW_E2E_PORT ?? 43117);
const demoPort = Number(process.env.RVW_DEMO_E2E_PORT ?? defaultPort + 1);
const demoBaseURL = `http://127.0.0.1:${demoPort}`;
const pullRequestId = "22222222-2222-4222-8222-222222222222";

test("opens a repository-scale demo backed by committed Git objects", async ({ page, request }) => {
  const viewResponse = await request.get(`${demoBaseURL}/api/pull-requests/${pullRequestId}`);
  expect(viewResponse.ok()).toBe(true);
  const view = (await viewResponse.json()) as {
    headOid: string;
    comparisonBaseOid: string;
    commits: Array<{ oid: string }>;
  };
  expect(view.commits).toHaveLength(6);

  const treeResponse = await request.get(
    `${demoBaseURL}/api/pull-requests/${pullRequestId}/tree?oid=${view.headOid}`,
  );
  expect(treeResponse.ok()).toBe(true);
  const tree = (await treeResponse.json()) as {
    entries: Array<{ path: string; size: number | null }>;
  };
  expect(tree.entries.length).toBeGreaterThanOrEqual(100);
  expect(
    tree.entries.reduce((total, entry) => total + (entry.size ?? 0), 0),
  ).toBeGreaterThanOrEqual(1024 * 1024);

  const changesResponse = await request.get(
    `${demoBaseURL}/api/pull-requests/${pullRequestId}/changed-files?oldOid=${view.comparisonBaseOid}&newOid=${view.headOid}`,
  );
  expect(changesResponse.ok()).toBe(true);
  const changes = (await changesResponse.json()) as { files: unknown[] };
  expect(changes.files.length).toBeGreaterThanOrEqual(1);

  await page.goto(`${demoBaseURL}/?pullRequestId=${pullRequestId}`);
  await expect(
    page.getByRole("heading", { name: "Demo: review rvw as a medium-sized repository" }),
  ).toBeVisible();
  const pullRequestAttachment = page.getByRole("img", {
    name: "Private attachment",
    exact: true,
  });
  await expect(pullRequestAttachment).toHaveAttribute(
    "src",
    new RegExp(`/api/pull-requests/${pullRequestId}/github-attachment\\?url=`),
  );
  await expect(page.locator("td").filter({ has: pullRequestAttachment })).toHaveCount(1);
  await expect(
    page.getByRole("img", { name: /External PR image.*自動読み込み停止/ }),
  ).toBeVisible();
  const reviewTree = page.getByRole("navigation", { name: "レビュー文書" });
  await expect(reviewTree.getByRole("button", { name: "Issues 3", exact: true })).toBeVisible();
  await expect(reviewTree.locator(".review-tree-issue").filter({ hasText: "#98" })).toContainText(
    "CLOSED",
  );
  await expect(page.getByRole("button", { name: "ウォークスルー 2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "コメント 4", exact: true })).toBeVisible();

  await reviewTree.getByRole("button", { name: /#156 Read the default branch/ }).click();
  await expect(
    page.getByRole("heading", {
      name: "Default-branch reading surface",
    }),
  ).toBeVisible();
  await expect(page.locator(".markdown-inline-comments")).toBeVisible();
  await page.getByRole("button", { name: "コメント 4", exact: true }).click();
  await page
    .locator('.comment-sidebar [data-comment-id="90000000-0000-4000-8000-000000000005"]')
    .getByRole("button", { name: "コメント対象を開く" })
    .click();
  await expect(page.locator(".rvw-markdown-commented").first()).toBeVisible();

  await reviewTree.getByRole("button", { name: /#142 Treat GitHub Issues/ }).click();
  const issueAttachment = page.getByRole("img", { name: "Issue attachment", exact: true });
  await expect(issueAttachment).toHaveAttribute(
    "src",
    new RegExp(`/api/pull-requests/${pullRequestId}/github-attachment\\?url=`),
  );
  await expect(page.locator("td").filter({ has: issueAttachment })).toHaveCount(1);
  await expect(
    page.getByRole("img", { name: /External planning diagram.*自動読み込み停止/ }),
  ).toBeVisible();

  const commitPicker = page
    .getByRole("region", { name: "レビュー範囲", exact: true })
    .getByRole("button", { name: /^対象commit:/ });
  await expect(commitPicker).toHaveAccessibleName(/6 commits.*PR全体/);
  await commitPicker.click();
  await expect(
    page.getByRole("dialog", { name: "対象commitを選択" }).getByRole("option"),
  ).toHaveCount(6);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Issue #98 Keep comment-watch writes context-safe");
    expect(dialog.message()).toContain("Issue全体コメント 0");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "#98を削除" }).click();
  await expect(reviewTree.getByRole("button", { name: "Issues 2", exact: true })).toBeVisible();
});
