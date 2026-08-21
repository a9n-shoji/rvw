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
  await expect(page.getByRole("heading", { name: /Issues\s+3/ })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Issues" }).getByRole("button", { name: /#98.*CLOSED/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "ウォークスルー 2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "コメント 4", exact: true })).toBeVisible();

  await page
    .getByRole("region", { name: "Issues" })
    .getByRole("button", { name: /#156 Read the default branch/ })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "#156 Read the default branch without changing the checkout",
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "RVW Comments" })).toBeVisible();
  await page.getByRole("button", { name: "コメント 4", exact: true }).click();
  await page
    .locator('.comment-sidebar [data-comment-id="90000000-0000-4000-8000-000000000005"]')
    .getByRole("button", { name: "コメント対象を開く" })
    .click();
  await expect(page.locator('[data-issue-line="5"].is-navigation-target')).toBeVisible();

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
  await expect(page.getByRole("heading", { name: /Issues\s+2/ })).toBeVisible();
});
