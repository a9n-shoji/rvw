import { expect, test } from "@playwright/test";

const port = Number(process.env.RVW_E2E_PORT ?? 43117);
const baseURL = `http://127.0.0.1:${port}`;
const pullRequestId = "11111111-1111-4111-8111-111111111111";

test.afterEach(async ({ request }) => {
  const response = await request.post(`${baseURL}/api/fixture/stress/structure`, {
    data: { reset: true },
  });
  expect(response.ok()).toBe(true);
});

test("renders and interacts with a 100-node Structure in the real Viewer", async ({
  page,
  request,
}) => {
  const setup = await request.post(`${baseURL}/api/fixture/stress/structure`, {
    data: { nodeCount: 100, shape: "fan-out", longLabels: true },
  });
  expect(setup.ok()).toBe(true);
  const startedAt = Date.now();
  await page.goto(`${baseURL}/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "Structure 1", exact: true }).click();
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: "fan-out 100-node stress graph", exact: true })
    .click();
  const viewer = page.locator('[data-structure-id="76000000-0000-4000-8000-200000000100"]');
  await expect(viewer.locator(".structure-node")).toHaveCount(100);
  await viewer.getByRole("button", { name: "表示中を収める" }).click();
  await viewer.locator('.structure-node[data-node-id="node-42"]').click();
  await expect(viewer.locator('.structure-node[data-node-id="node-42"]')).toHaveClass(/focused/u);
  expect(Date.now() - startedAt).toBeLessThan(10_000);
});

test("opens, searches, and scrolls to a deep line in a 10,000-line document", async ({ page }) => {
  await page.goto(`${baseURL}/?pullRequestId=${pullRequestId}`);
  await page.getByRole("checkbox", { name: "変更のないファイルも表示" }).check();
  const fileSearch = page.getByPlaceholder("ファイル名を検索");
  await fileSearch.fill("stress/long-document.txt");
  await page.getByRole("button", { name: "stress/long-document.txt", exact: true }).click();

  const leftPane = page.getByRole("region", { name: "左のコードペイン", exact: true });
  const deepLine = leftPane.locator('diffs-container [data-line="7500"]').first();
  await expect(deepLine).toHaveCount(1);
  await deepLine.evaluate((line) => line.scrollIntoView({ block: "center" }));
  await deepLine.click();
  await page.keyboard.press("Control+F");
  const find = leftPane.getByRole("search", { name: "左ペイン内を検索" });
  await find.getByRole("textbox", { name: "ペイン内を検索" }).fill("stress line 7500:");
  await expect(find.locator(".pane-find-status")).toHaveText("1/1");
  await expect(deepLine).toBeInViewport();
});
