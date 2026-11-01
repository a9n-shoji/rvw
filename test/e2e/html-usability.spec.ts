import { expect, test } from "@playwright/test";

for (const width of [1440, 900, 640]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`HTML reading and comments at ${width}px in ${colorScheme}`, async ({
      page,
      request,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme });
      const title = "注文確定：決済から通知まで";
      const body =
        '```html-preview\n<style>article {max-width: 880px; margin:auto; padding: 16px} h2 {font-size: 20px} table {width:100%;border-collapse:collapse} th,td {padding:14px;border:1px solid var(--rvw-border);text-align:left} .note {padding:16px;border:1px solid var(--rvw-border);border-radius:8px;margin:18px 0} </style>\n<article>\n<h2>注文はいつ確定する？</h2>\n<p>決済が成功した時点で注文を確定します。通知の失敗で決済を繰り返さないよう、処理の責務を分けています。</p>\n<section class="note"><strong>先に確認すること</strong><p>通知は注文確定後に実行されます。<a href="rvw-ref:handler">処理の入口をコードで確認する</a></p></section>\n<table><thead><tr><th>段階</th><th>成功時</th><th>失敗時</th></tr></thead><tbody><tr><td>決済</td><td>注文を確定</td><td>注文を未確定のまま残す</td></tr><tr><td>通知</td><td>送信済みに更新</td><td>通知だけを再試行</td></tr></tbody></table>\n<p>気になる条件を選択して、その場で質問できます。</p>\n</article>\n```';
      expect(
        (
          await request.post(
            "/api/fixture/walkthroughs/70000000-0000-4000-8000-000000000005/update",
            { data: { title, body, referenceLabel: "処理の入口" } },
          )
        ).ok(),
      ).toBe(true);
      await page.goto("/?pullRequestId=11111111-1111-4111-8111-111111111111");
      const folder = page.getByRole("button", { name: /^ウォークスルー \d+$/u });
      if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
      await page
        .getByRole("navigation", { name: "レビュー文書" })
        .getByRole("button", { name: title, exact: true })
        .click();
      const shell = page.locator(".walkthrough-html-preview-shell");
      const frame = shell.frameLocator("iframe");
      await expect(frame.getByRole("heading", { name: "注文はいつ確定する？" })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("reading.png") });
      await frame.getByRole("cell", { name: "通知だけを再試行", exact: true }).hover();
      const option = shell.getByRole("button", { name: "セル", exact: true });
      await option.hover();
      const targetBefore = await frame
        .getByRole("cell", { name: "通知だけを再試行", exact: true })
        .boundingBox();
      const actionBox = await shell.locator(".walkthrough-html-comment-action").boundingBox();
      expect(actionBox!.y).toBeGreaterThanOrEqual(targetBefore!.y + targetBefore!.height);
      expect(actionBox!.height).toBeLessThan(40);
      await expect(frame.getByRole("cell", { name: "通知だけを再試行", exact: true })).toHaveClass(
        /rvw-html-comment-target/,
      );
      await page.screenshot({ path: testInfo.outputPath("selection.png") });
      const box = await shell.locator(".walkthrough-html-target-options").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await option.click();
      const composer = shell.locator(".walkthrough-html-comment-composer");
      await composer.getByRole("textbox").fill("再試行の上限はどこで定義されていますか？");
      await page.screenshot({ path: testInfo.outputPath("composer.png") });
      const composerBox = await composer.boundingBox();
      const targetBox = await frame
        .getByRole("cell", { name: "通知だけを再試行", exact: true })
        .boundingBox();
      expect(composerBox!.y).toBeGreaterThanOrEqual(targetBox!.y + targetBox!.height);
      expect(composerBox!.x).toBeGreaterThanOrEqual(0);
      expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(width);
      await composer.getByRole("textbox").press("Escape");
      await expect(composer).toHaveCount(0);
      await frame.getByRole("link").click({ modifiers: ["Control"] });
      await expect(page.locator(".document-pane")).toHaveCount(2);
      await expect(page.locator('.document-pane[data-pane="right"] diffs-container')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("split.png") });
    });
  }
}
