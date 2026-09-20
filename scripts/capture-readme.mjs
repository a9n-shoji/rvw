import { chromium, expect } from "@playwright/test";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";

const commentsResponse = z.object({
  comments: z.array(
    z.object({
      ref: z.string(),
      posts: z.array(z.object({ body: z.string() })),
      target: z.object({ path: z.string().nullish(), startLine: z.number().nullish() }),
    }),
  ),
});
const framesDirectory = process.env.RVW_CAPTURE_FRAMES_DIR;
if (framesDirectory) await mkdir(framesDirectory, { recursive: true });

// Run against a fresh `pnpm demo -- --no-open`, never a personal rvw runtime.
const port = Number(process.env.RVW_DEMO_PORT ?? 43118);
const origin = `http://127.0.0.1:${port}`;
const pullRequestId = "22222222-2222-4222-8222-222222222222";
const output = path.resolve(import.meta.dirname, "../docs/images");
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 780 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  /** @param {string} name */
  const frame = async (name) => {
    if (!framesDirectory) return;
    await page.mouse.move(0, 0);
    const clip = await page.locator(".main-view").boundingBox();
    await page.screenshot({ path: path.join(framesDirectory, `${name}.png`), clip });
  };
  const initial = await context.request.get(
    `${origin}/api/pull-requests/${pullRequestId}/comments?resolved=all`,
  );
  expect(commentsResponse.parse(await initial.json()).comments).toHaveLength(13); // Require a fresh synthetic demo.
  await page.goto(`${origin}/?pullRequestId=${pullRequestId}`);
  await expect(page.locator(".pr-heading")).toContainText("acme/commerce-service");
  await page.getByRole("button", { name: "ウォークスルー 3", exact: true }).click();
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", {
      name: "決済承認後に注文を保存できなかったら",
      exact: true,
    })
    .click();
  const left = page.locator('.document-pane[data-pane="left"]');
  const right = page.locator('.document-pane[data-pane="right"]');
  await left.getByRole("button", { name: /のコメントを折りたたむ$/ }).click();
  await left.locator(".walkthrough-diagram svg").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  const workspace = await page.locator(".main-view").boundingBox();
  await page.screenshot({ path: path.join(output, "review-evidence.png"), clip: workspace });
  await frame("01-explanation");

  await page
    .locator(".walkthrough-inline-reference")
    .filter({ hasText: "決済の復旧処理" })
    .click({ modifiers: ["Meta"] });
  await expect(right.locator('diffs-container [data-line="24"]')).toBeVisible();
  while (await right.getByRole("button", { name: /のコメントを折りたたむ$/ }).count())
    await right
      .getByRole("button", { name: /のコメントを折りたたむ$/ })
      .first()
      .click();
  // Follow the surrounding operational context, then return to the code.
  await left.locator(".walkthrough-inline-reference").filter({ hasText: "復旧の運用手順" }).click();
  await expect(left).toContainText("Treat an already");
  await page.getByPlaceholder("ファイル名を検索").fill("payment-reconciliation.ts");
  await page
    .getByRole("button", { name: "src/workers/payment-reconciliation.ts", exact: true })
    .click();
  await right
    .getByRole("button", { name: "src/workers/payment-reconciliation.tsを閉じる", exact: true })
    .click();
  while (await left.getByRole("button", { name: /のコメントを折りたたむ$/ }).count())
    await left
      .getByRole("button", { name: /のコメントを折りたたむ$/ })
      .first()
      .click();
  const code = left.locator("diffs-container");
  const retryLine = code.locator("[data-line]").filter({ hasText: 'return "retry-later"' });
  await expect(retryLine).toHaveCount(1);
  const lineNumber = await retryLine.getAttribute("data-line");
  await left.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await frame("02-code");
  await code.locator(`[data-column-number="${lineNumber}"]`).first().hover();
  await code.locator("[data-utility-button]").first().click();
  const question =
    "pending / unknown の場合は再試行になると読みました。再試行の期限と、運用担当へ知らせる条件はどこで決まりますか？";
  const composer = left.locator(".inline-comment-composer--line");
  await composer.getByRole("textbox").fill(question);
  await composer.scrollIntoViewIfNeeded();
  await frame("03-question");
  await composer.getByRole("button", { name: "コメント", exact: true }).click();
  const thread = left.locator(".comment-thread").filter({ hasText: question }).last();
  await expect(thread).toBeVisible();
  await thread.getByRole("button", { name: "コメントのその他の操作" }).click();
  await page.getByRole("menuitem", { name: "参照をコピー", exact: true }).click();
  const reference = await page.evaluate(() => navigator.clipboard.readText());
  expect(reference).toMatch(/rvw:\/\/comment\/[0-9a-f-]{36}$/u);
  const saved = await context.request.get(
    `${origin}/api/pull-requests/${pullRequestId}/comments?resolved=all`,
  );
  const posted = commentsResponse
    .parse(await saved.json())
    .comments.find((comment) => reference.endsWith(comment.ref));
  if (!posted) throw new Error("Copied reference did not identify the posted question");
  expect(posted.posts[0].body).toBe(question);
  expect(posted.target.path).toBe("src/workers/payment-reconciliation.ts");
  expect(posted.target.startLine).toBe(Number(lineNumber));
  const existing = left
    .locator(".comment-thread")
    .filter({ hasText: "The remaining risk is provider ambiguity" });
  const expanded = existing.getByRole("button", { name: /のコメントを折りたたむ$/ });
  if (await expanded.count()) await expanded.click();
  await expect(page.getByText("参照をコピーしました", { exact: true })).toHaveCount(0);
  await left.evaluate((el) => {
    el.scrollTop = 380;
  });
  await page.mouse.move(0, 0);
  const commentWorkspace = await page.locator(".main-view").boundingBox();
  await page.screenshot({
    path: path.join(output, "review-comment.png"),
    clip: { ...commentWorkspace, height: 610 },
  });
  await frame("04-posted");
  console.log(`Captured evidence and comment; copied ${reference}`);
} finally {
  await browser.close();
}
