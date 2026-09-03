import { expect, test } from "@playwright/test";

const defaultPort = Number(process.env.RVW_E2E_PORT ?? 43117);
const fixtureBaseURL = `http://127.0.0.1:${defaultPort}`;
const pullRequestId = "11111111-1111-4111-8111-111111111111";

test.afterEach(async ({ request }) => {
  const response = await request.post(`${fixtureBaseURL}/api/test/reset-sync-stage`, { data: {} });
  expect(response.ok()).toBe(true);
});

test("keeps the current source line anchored when whitespace changes are hidden", async ({
  page,
  request,
}) => {
  const refreshResponse = await request.post(
    `${fixtureBaseURL}/api/pull-requests/${pullRequestId}/refresh`,
    { data: {} },
  );
  expect(refreshResponse.ok()).toBe(true);
  await page.goto(`${fixtureBaseURL}/?pullRequestId=${pullRequestId}`);

  await page.getByRole("textbox", { name: "ファイル名を検索" }).fill("viewport-anchor.ts");
  await page.getByRole("button", { name: "src/viewport-anchor.ts", exact: true }).click();
  await page
    .getByRole("region", { name: "レビュー範囲", exact: true })
    .getByRole("button", { name: "変更", exact: true })
    .click();

  const leftPane = page.getByRole("region", { name: "左のコードペイン", exact: true });
  const diff = leftPane.locator("diffs-container");
  await expect(diff.locator("[data-diffs-header]")).toBeVisible();
  const deepSourceLine = diff.locator('[data-line="760"]').last();
  await expect(deepSourceLine).toHaveCount(1);
  await deepSourceLine.evaluate((line) => line.scrollIntoView({ block: "center" }));

  const viewportAnchor = async () =>
    await leftPane.evaluate((pane) => {
      const container = pane.querySelector<HTMLElement>("diffs-container");
      const root = container?.shadowRoot;
      if (!container || !root) return null;
      const paneRect = pane.getBoundingClientRect();
      const paneTop = paneRect.top;
      const viewportTop = [...pane.querySelectorAll<HTMLElement>(".document-tabs-shell")]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.bottom > paneTop && rect.top <= paneTop + 1)
        .reduce((top, rect) => Math.max(top, rect.bottom), paneTop);
      const hostRect = container.getBoundingClientRect();
      const left = Math.max(hostRect.left, paneRect.left);
      const right = Math.min(hostRect.right, paneRect.right);
      const top = Math.max(hostRect.top, viewportTop);
      const bottom = Math.min(hostRect.bottom, paneRect.bottom);
      const sampleXs = [left + (right - left) * 0.25, left + (right - left) * 0.75];
      for (let y = top + 1; y < bottom; y += 6) {
        for (const x of sampleXs) {
          const line = root.elementFromPoint(x, y)?.closest<HTMLElement>("[data-line]");
          if (line?.dataset.line) {
            return { line: line.dataset.line, topOffset: line.getBoundingClientRect().top - top };
          }
        }
      }
      return null;
    });

  const before = await viewportAnchor();
  expect(before).not.toBeNull();
  const changedLines = diff.locator('[data-line-type^="change-"]');
  const changedLineCountBefore = await changedLines.count();

  const actionsMenuButton = page.getByRole("button", { name: "その他の操作", exact: true });
  await actionsMenuButton.click();
  const hideWhitespaceMenuItem = page
    .getByRole("menu")
    .getByRole("menuitemcheckbox", { name: "Hide Whitespace", exact: true });
  await hideWhitespaceMenuItem.click();
  await expect(hideWhitespaceMenuItem).toHaveAttribute("aria-checked", "true");
  await actionsMenuButton.click();
  await expect.poll(async () => await changedLines.count()).toBeLessThan(changedLineCountBefore);
  await expect.poll(async () => (await viewportAnchor())?.line ?? null).toBe(before!.line);
  const after = await viewportAnchor();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.topOffset - before!.topOffset)).toBeLessThanOrEqual(3);
});
