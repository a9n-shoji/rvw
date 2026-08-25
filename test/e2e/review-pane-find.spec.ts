import { expect, test } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";

test("finds within the focused document pane with VS Code-style controls", async ({ page }) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await expect(page.getByRole("heading", { name: "Fixture review" })).toBeVisible();

  await page.getByRole("button", { name: "src/fixture.ts", exact: true }).click();
  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  await expect(leftPane.getByRole("tab", { name: "src/fixture.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page
    .getByRole("region", { name: "レビュー範囲", exact: true })
    .getByRole("button", { name: "全文", exact: true })
    .click();

  const outsideShortcutPrevented = await page.evaluate(() => {
    const shortcut = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(shortcut);
    return shortcut.defaultPrevented;
  });
  expect(outsideShortcutPrevented).toBe(false);
  await expect(leftPane.getByRole("search", { name: "左ペイン内を検索" })).toHaveCount(0);

  await leftPane.locator('diffs-container [data-line="1"]').first().click();
  await expect(leftPane).toBeFocused();
  await page.keyboard.press("Control+F");
  const leftFind = leftPane.getByRole("search", { name: "左ペイン内を検索" });
  const leftInput = leftFind.getByRole("textbox", { name: "ペイン内を検索" });
  await expect(leftInput).toBeFocused();
  await leftInput.fill("fixture");
  await expect(leftFind.locator(".pane-find-status")).toHaveText("1/3");
  await expect(leftPane).toHaveAttribute("data-pane-find-match-count", "3");
  await expect
    .poll(
      async () =>
        await page.evaluate(() => ({
          matches: CSS.highlights.get("rvw-pane-find-left-match")?.size ?? 0,
          current: CSS.highlights.get("rvw-pane-find-left-current")?.size ?? 0,
        })),
    )
    .toEqual({ matches: 3, current: 1 });

  await leftInput.press("Enter");
  await expect(leftFind.locator(".pane-find-status")).toHaveText("2/3");
  await leftInput.press("Shift+Enter");
  await expect(leftFind.locator(".pane-find-status")).toHaveText("1/3");

  await leftFind.getByRole("button", { name: "単語単位で検索" }).click();
  await expect(leftFind.locator(".pane-find-status")).toHaveText("1/2");
  await leftInput.fill("FIXTURE");
  await expect(leftFind.locator(".pane-find-status")).toHaveText("1/2");
  await leftFind.getByRole("button", { name: "大文字と小文字を区別" }).click();
  await expect(leftFind.locator(".pane-find-status")).toHaveText("0/0");

  await leftFind.getByRole("button", { name: "正規表現を使用" }).click();
  await leftInput.fill("[");
  await expect(leftInput).toHaveAttribute("aria-invalid", "true");
  await expect(leftFind.locator(".pane-find-status")).toHaveText("正規表現が無効です");

  await leftInput.press("Escape");
  await expect(leftFind).toHaveCount(0);
  await expect(leftPane).toBeFocused();

  await page
    .getByRole("button", { name: "src/new.ts", exact: true })
    .click({ modifiers: ["Control"] });
  const rightPane = page.getByRole("region", { name: "右のコードペイン" });
  await expect(rightPane.getByRole("tab", { name: "src/new.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await rightPane.focus();
  await expect(rightPane).toBeFocused();
  await page.keyboard.press("Control+F");
  const rightFind = rightPane.getByRole("search", { name: "右ペイン内を検索" });
  const rightInput = rightFind.getByRole("textbox", { name: "ペイン内を検索" });
  await expect(rightInput).toBeFocused();
  await rightInput.fill("added");
  await expect(rightFind.locator(".pane-find-status")).toHaveText("1/1");
  await expect(rightPane).toHaveAttribute("data-pane-find-match-count", "1");
  await expect(leftPane).not.toHaveAttribute("data-pane-find-match-count", /.+/);

  await leftPane.getByRole("tab", { name: "src/fixture.ts" }).click();
  await page.keyboard.press("Control+F");
  await expect(leftInput).toBeFocused();
  await expect(rightFind).toBeVisible();
  await leftInput.fill("return");
  await expect(leftFind.locator(".pane-find-status")).toHaveText("1/2");
  await page.keyboard.press("F3");
  await expect(leftFind.locator(".pane-find-status")).toHaveText("2/2");
  await expect(rightFind.locator(".pane-find-status")).toHaveText("1/1");
});

test("finds rendered text in a walkthrough without searching its viewer controls", async ({
  page,
}) => {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  await page.getByRole("button", { name: "ウォークスルー 5", exact: true }).click();
  await page
    .getByRole("button", { name: "注文作成フロー：HTTPからtransactional outboxまで" })
    .click();

  const leftPane = page.getByRole("region", { name: "左のコードペイン" });
  await expect(leftPane.locator(".walkthrough-viewer")).toBeVisible();
  await leftPane.focus();
  await expect(leftPane).toBeFocused();
  await page.keyboard.press("Control+F");
  const find = leftPane.getByRole("search", { name: "左ペイン内を検索" });
  const input = find.getByRole("textbox", { name: "ペイン内を検索" });
  await input.fill("表示位置は変わりません");
  await expect(find.locator(".pane-find-status")).toHaveText("1/1");
  await expect
    .poll(
      async () =>
        await page.evaluate(() => CSS.highlights.get("rvw-pane-find-left-current")?.size ?? 0),
    )
    .toBe(1);
});
