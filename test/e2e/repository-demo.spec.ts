import { expect, test } from "@playwright/test";

const defaultPort = Number(process.env.RVW_E2E_PORT ?? 43117);
const demoPort = Number(process.env.RVW_DEMO_E2E_PORT ?? defaultPort + 1);
const demoBaseURL = `http://127.0.0.1:${demoPort}`;
const pullRequestId = "22222222-2222-4222-8222-222222222222";

test("opens a repository-scale demo backed by committed Git objects", async ({ page, request }) => {
  await page.goto(demoBaseURL);
  const hideClosedOrMergedFilter = page.getByRole("checkbox", {
    name: "Closed / Merged を非表示",
  });
  const statusBadges = page.locator(".pull-request-status");
  const rows = page.locator(".pull-request-row");
  await expect(hideClosedOrMergedFilter).toBeChecked();
  await expect(rows).toHaveCount(3);
  await expect(statusBadges).toHaveText(["Open", "Draft"]);
  await expect(rows.nth(2)).toContainText("Legacy: status not synchronized yet");
  await expect(rows.nth(2).locator(".pull-request-status")).toHaveCount(0);

  await hideClosedOrMergedFilter.uncheck();
  await expect(rows).toHaveCount(5);
  await expect(statusBadges).toHaveText(["Open", "Draft", "Closed", "Merged"]);
  await rows.nth(3).click();
  await expect(
    page.getByRole("heading", { name: "Demo: review rvw as a medium-sized repository" }),
  ).toBeVisible();
  await page.goBack();
  await expect(hideClosedOrMergedFilter).not.toBeChecked();
  await expect(rows).toHaveCount(5);

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
  await expect(page.getByRole("button", { name: "ウォークスルー 2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "コメント 3", exact: true })).toBeVisible();

  const commitPicker = page
    .getByRole("region", { name: "レビュー範囲", exact: true })
    .getByRole("button", { name: /^対象commit:/ });
  await expect(commitPicker).toHaveAccessibleName(/6 commits.*PR全体/);
  await commitPicker.click();
  await expect(
    page.getByRole("dialog", { name: "対象commitを選択" }).getByRole("option"),
  ).toHaveCount(6);
});
