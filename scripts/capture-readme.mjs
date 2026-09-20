import { chromium, expect } from "@playwright/test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";

const commentsResponse = z.object({
  comments: z.array(
    z.object({
      id: z.string(),
      ref: z.string(),
      posts: z.array(z.object({ body: z.string() })),
      target: z.object({ path: z.string().nullish(), startLine: z.number().nullish() }),
    }),
  ),
});
const scene = process.env.RVW_CAPTURE_SCENE ?? "walkthrough";
if (!["walkthrough", "structure"].includes(scene))
  throw new Error(`Unknown capture scene: ${scene}`);
const framesDirectory = process.env.RVW_CAPTURE_FRAMES_DIR;
if (framesDirectory) await mkdir(framesDirectory, { recursive: true });

// Run against a fresh `pnpm demo -- --no-open`, never a personal rvw runtime.
const port = Number(process.env.RVW_DEMO_PORT ?? 43118);
const origin = `http://127.0.0.1:${port}`;
const pullRequestId = "22222222-2222-4222-8222-222222222222";
const output = path.resolve(import.meta.dirname, "../docs/images");
const viewport = { width: 1200, height: 800 };
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: "light",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  /** @type {{file: string, duration: number, scene: string}[]} */
  const frames = [];
  /** @param {number} duration @param {string} scene */
  const frame = async (duration, scene) => {
    if (!framesDirectory) return;
    const file = `${String(frames.length + 1).padStart(3, "0")}.png`;
    await page.screenshot({ path: path.join(framesDirectory, file) });
    frames.push({ file, duration, scene });
  };
  let mouse = { x: 420, y: 180 };
  /** @param {import('@playwright/test').Locator} target */
  const pointAt = async (target) => {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error("Capture target is not visible");
    const next = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const previous = mouse;
    for (let step = 1; step <= 8; step += 1) {
      mouse = {
        x: previous.x + ((next.x - previous.x) * step) / 8,
        y: previous.y + ((next.y - previous.y) * step) / 8,
      };
      await page.mouse.move(mouse.x, mouse.y);
      await frame(40, "cursor");
    }
  };
  const click = async () => {
    await page.mouse.down();
    await frame(80, "click");
    await page.mouse.up();
  };
  const showCursor = async () => {
    // Screenshots omit the OS cursor. This capture-only overlay follows actual mouse events.
    await page.evaluate(() => {
      const cursor = document.createElement("div");
      cursor.id = "readme-capture-cursor";
      cursor.setAttribute("aria-hidden", "true");
      cursor.style.cssText =
        "position:fixed;left:0;top:0;width:64px;height:68px;pointer-events:none;z-index:2147483647";
      cursor.innerHTML =
        '<svg width="64" height="68" viewBox="0 0 64 68"><circle cx="20" cy="20" r="17" fill="#f59e0b" fill-opacity=".25" stroke="#e38b00" stroke-width="3" opacity="0"/><path d="M20 20 L20 44 L26 38 L32 51 L37 48 L31 36 L41 36 Z" fill="#18202b" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>';
      const ring = cursor.querySelector("circle");
      if (!ring) throw new Error("Missing capture cursor ring");
      document.body.append(cursor);
      window.addEventListener("mousemove", (event) => {
        cursor.style.left = `${event.clientX - 20}px`;
        cursor.style.top = `${event.clientY - 20}px`;
      });
      window.addEventListener("mousedown", () => ring.setAttribute("opacity", "1"));
      window.addEventListener("mouseup", () => ring.setAttribute("opacity", "0"));
    });
    await page.mouse.move(mouse.x, mouse.y);
  };
  /** @param {string} lastScene */
  const finishFrames = async (lastScene) => {
    if (framesDirectory) {
      const remaining = 7500 - frames.reduce((total, item) => total + item.duration, 0);
      if (remaining < 300) throw new Error("GIF actions exceed the 7.5 second budget");
      await frame(remaining, lastScene);
      await writeFile(
        path.join(framesDirectory, "frames.json"),
        JSON.stringify(
          {
            width: viewport.width,
            height: viewport.height,
            scale: 2,
            duration: 7500,
            frames,
          },
          null,
          2,
        ),
      );
    }
  };
  const initial = await context.request.get(
    `${origin}/api/pull-requests/${pullRequestId}/comments?resolved=all`,
  );
  expect(commentsResponse.parse(await initial.json()).comments).toHaveLength(13);
  await page.goto(`${origin}/?pullRequestId=${pullRequestId}`);
  await expect(page.locator(".pr-heading")).toContainText("acme/commerce-service");
  const left = page.locator('.document-pane[data-pane="left"]');
  const right = page.locator('.document-pane[data-pane="right"]');
  const sidebarHandle = await page
    .getByRole("separator", { name: "サイドバーの幅を変更" })
    .boundingBox();
  if (!sidebarHandle) throw new Error("Missing sidebar resize handle");
  await page.mouse.move(sidebarHandle.x + 3, sidebarHandle.y + 120);
  await page.mouse.down();
  await page.mouse.move(240, sidebarHandle.y + 120, { steps: 5 });
  await page.mouse.up();

  if (scene === "structure") {
    await page.getByRole("button", { name: "Structure 4", exact: true }).click();
    await page
      .getByRole("navigation", { name: "レビュー文書" })
      .getByRole("button", { name: "決済を取り消してよいか", exact: true })
      .click();
    const viewer = left.locator('[data-structure-id="74000000-0000-4000-8000-000000000003"]');
    const provider = viewer.locator('.structure-node[data-node-id="provider-status"]');
    await expect(viewer.locator(".structure-node")).toHaveCount(6);
    await expect(viewer.locator(".structure-world")).not.toHaveClass(/camera-transition/u);
    await provider.click();
    await viewer.getByRole("button", { name: "1-hop", exact: true }).click();
    await expect(viewer.locator(".structure-node")).toHaveCount(2);
    await expect(viewer.locator(".structure-world")).not.toHaveClass(/camera-transition/u);
    await page.evaluate(() => document.fonts.ready);

    // Arrange the two visible cards using the normal drag gesture, then fit this neighborhood.
    const decision = viewer.locator('.structure-node[data-node-id="reconciliation-decision"]');
    const providerBox = await provider.boundingBox();
    const decisionBox = await decision.boundingBox();
    if (!providerBox || !decisionBox) throw new Error("Missing Structure nodes");
    await page.mouse.move(
      providerBox.x + providerBox.width / 2,
      providerBox.y + providerBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      decisionBox.x + decisionBox.width / 2,
      providerBox.y + providerBox.height / 2,
      { steps: 12 },
    );
    await page.mouse.up();
    await viewer.getByRole("button", { name: "表示中を収める", exact: true }).click();
    await expect(viewer.locator(".structure-world")).not.toHaveClass(/camera-transition/u);
    await showCursor();
    await frame(900, "structure-neighborhood");
    const relation = viewer.locator(
      '.structure-edge-label[data-edge-id="provider-status-feeds-decision"]',
    );
    await pointAt(relation.locator(".structure-edge-select"));
    await click();
    await expect(viewer).toHaveAttribute("data-selected-edge-id", "provider-status-feeds-decision");
    await frame(700, "structure-relation");
    await pointAt(relation.locator(".structure-source"));
    await page.keyboard.down("Meta");
    await click();
    await page.keyboard.up("Meta");
    await expect(right.locator("diffs-container")).toContainText("payments.getAuthorization");
    await expect(right.locator('[data-line="27"]')).toBeVisible();
    const oldComment = right
      .locator(".comment-thread")
      .filter({ hasText: "The remaining risk is provider ambiguity" });
    await expect(oldComment).toBeVisible();
    await oldComment.getByRole("button", { name: /のコメントを折りたたむ$/ }).click();
    const codeBox = await right.boundingBox();
    if (!codeBox) throw new Error("Missing Structure reference pane");
    mouse = { x: codeBox.x + codeBox.width - 20, y: codeBox.y + 180 };
    await page.mouse.move(mouse.x, mouse.y);
    for (let i = 0; i < 4; i += 1) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(40);
      await frame(60, "structure-scroll-relation");
    }
    await expect(viewer.locator(".structure-world")).not.toHaveClass(/camera-transition/u);
    await frame(1060, "structure-relation-source");
    // Follow the neighboring adapter's own code reference as context for the same decision.
    await pointAt(provider.locator(".structure-source"));
    await page.keyboard.down("Meta");
    await click();
    await page.keyboard.up("Meta");
    await expect(right.locator("diffs-container")).toContainText("class StripeGateway");
    const statusLine = right.locator("[data-line]").filter({ hasText: "async getAuthorization" });
    await expect(statusLine).toHaveCount(1);
    mouse = { x: codeBox.x + codeBox.width - 20, y: codeBox.y + 180 };
    await page.mouse.move(mouse.x, mouse.y);
    for (let i = 0; i < 4; i += 1) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(40);
      await frame(60, "structure-scroll-neighbor");
    }
    await expect(statusLine).toBeVisible();
    await frame(960, "structure-neighbor-source");
    await finishFrames("structure-neighbor-source");
    console.log(
      "Captured Structure relation and neighboring source references with both panes visible",
    );
  } else {
    await page.getByRole("button", { name: "ウォークスルー 3", exact: true }).click();
    await page
      .getByRole("navigation", { name: "レビュー文書" })
      .getByRole("button", {
        name: "決済承認後に注文を保存できなかったら",
        exact: true,
      })
      .click();
    await left.getByRole("button", { name: /のコメントを折りたたむ$/ }).click();

    // Start with the explanation and authorization code visible side by side.
    await left
      .locator(".walkthrough-inline-reference")
      .filter({ hasText: "決済の承認" })
      .click({ modifiers: ["Meta"] });
    await expect(right.locator("diffs-container")).toBeVisible();
    const recoveryLink = left
      .locator(".walkthrough-inline-reference")
      .filter({ hasText: "決済の復旧処理" });
    await left.locator(".walkthrough-diagram svg").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await recoveryLink.scrollIntoViewIfNeeded();

    await showCursor();
    await frame(700, "explanation");
    await pointAt(recoveryLink);
    await page.keyboard.down("Meta");
    await click();
    await page.keyboard.up("Meta");
    await expect(right.locator('diffs-container [data-line="24"]')).toBeVisible();
    const existingRecoveryComment = right.locator(".comment-thread").filter({
      hasText: "The remaining risk is provider ambiguity",
    });
    const collapseExistingComment = async () => {
      const toggle = existingRecoveryComment.getByRole("button", {
        name: /のコメントを折りたたむ$/,
      });
      if (await toggle.count()) await toggle.click();
    };
    await expect(existingRecoveryComment).toBeVisible();
    await collapseExistingComment();
    await recoveryLink.scrollIntoViewIfNeeded();
    await frame(400, "reference-opened");
    const code = right.locator("diffs-container");
    const retryLine = code.locator("[data-line]").filter({ hasText: 'return "retry-later"' });
    await expect(retryLine).toHaveCount(1);
    const lineNumber = await retryLine.getAttribute("data-line");
    const rightBox = await right.boundingBox();
    if (!rightBox) throw new Error("Missing right pane");
    await page.mouse.move(rightBox.x + rightBox.width - 25, rightBox.y + 230);
    mouse = { x: rightBox.x + rightBox.width - 25, y: rightBox.y + 230 };
    for (let i = 0; i < 5; i += 1) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(40);
      await frame(60, "scroll-code");
    }
    await expect(retryLine).toBeVisible();
    await frame(1000, "evidence");

    await pointAt(code.locator(`[data-column-number="${lineNumber}"]`).first());
    await click();
    const composer = right.locator(".inline-comment-composer--line");
    await expect(composer).toBeVisible();
    await expect(composer).toContainText(`L${lineNumber}へコメント`);
    await composer.scrollIntoViewIfNeeded();
    await frame(300, "comment-opened");
    await pointAt(composer.getByRole("textbox"));
    const pieces = [
      "pending / unknown の場合は再試行になると読みました。",
      "再試行の期限と、",
      "運用担当へ知らせる条件はどこで決まりますか？",
    ];
    const question = pieces.join("");
    let input = "";
    for (const piece of pieces) {
      input += piece;
      await composer.getByRole("textbox").fill(input);
      await frame(220, "typing-question");
    }
    await pointAt(composer.getByRole("button", { name: "コメント", exact: true }));
    await click();
    const thread = right.locator(".comment-thread").filter({ hasText: question }).last();
    await expect(thread).toBeVisible();
    await collapseExistingComment();
    await frame(400, "posted");
    const saved = await context.request.get(
      `${origin}/api/pull-requests/${pullRequestId}/comments?resolved=all`,
    );
    const posted = commentsResponse
      .parse(await saved.json())
      .comments.find((comment) => comment.posts[0].body === question);
    if (!posted) throw new Error("Missing the posted question");
    expect(posted.target.path).toBe("src/workers/payment-reconciliation.ts");
    expect(posted.target.startLine).toBe(Number(lineNumber));

    // Scripted demo responses through the fixture API, not a running Agent or altered UI.
    // A real watcher creates an acknowledgement and edits that same post into its answer.
    const acknowledgement = "🔎 確認中です…";
    const acknowledged = await context.request.post(`${origin}/api/comments/${posted.id}/posts`, {
      headers: { "x-rvw-fixture-modifier": "agent" },
      data: { body: acknowledgement, authorLabel: "Codex（デモ）", relatedCommitOid: null },
    });
    expect(acknowledged.ok()).toBe(true);
    const { post: statusPost } = z
      .object({ post: z.object({ id: z.string() }) })
      .parse(await acknowledged.json());
    await expect(thread.getByText(acknowledgement, { exact: true })).toBeVisible();
    await thread.scrollIntoViewIfNeeded();
    await collapseExistingComment();
    await frame(700, "agent-acknowledged");
    const reply =
      "再試行の期限は、このPRでは未実装です。[復旧処理](rvw-ref:retry)は再試行時に候補を残します。[運用手順](rvw-ref:runbook)は外部監視を求めていますが、通知の閾値は定めていません。";
    const answered = await context.request.patch(
      `${origin}/api/comments/${posted.id}/posts/${statusPost.id}`,
      {
        headers: { "x-rvw-fixture-modifier": "agent" },
        data: {
          body: reply,
          references: [
            {
              id: "retry",
              label: "復旧処理",
              path: "src/workers/payment-reconciliation.ts",
              startLine: 15,
              endLine: 21,
            },
            {
              id: "runbook",
              label: "運用手順",
              path: "docs/runbooks/payment-recovery.md",
              startLine: 7,
              endLine: 9,
            },
          ],
        },
      },
    );
    expect(answered.ok()).toBe(true);
    await expect(thread).toContainText("再試行の期限は、このPRでは未実装です。");
    await expect(thread.getByText(acknowledgement, { exact: true })).toHaveCount(0);
    await expect(thread.getByText("Codex（デモ）", { exact: true })).toBeVisible();
    await collapseExistingComment();
    await thread.scrollIntoViewIfNeeded();
    await finishFrames("agent-replied");

    await thread.getByRole("button", { name: "コメントのその他の操作" }).first().click();
    await page.getByRole("menuitem", { name: "参照をコピー", exact: true }).click();
    const reference = await page.evaluate(() => navigator.clipboard.readText());
    expect(reference).toMatch(/rvw:\/\/comment\/[0-9a-f-]{36}$/u);
    expect(reference).toContain(posted.ref);

    // Read the surrounding runbook, then take a larger detail image of the same question.
    await page.locator("#readme-capture-cursor").evaluate((element) => {
      element.hidden = true;
    });
    await left
      .locator(".walkthrough-inline-reference")
      .filter({ hasText: "復旧の運用手順" })
      .click();
    await expect(left).toContainText("Treat an already");
    await page.getByPlaceholder("ファイル名を検索").fill("payment-reconciliation.ts");
    await page
      .getByRole("button", { name: "src/workers/payment-reconciliation.ts", exact: true })
      .click();
    await right
      .getByRole("button", { name: "src/workers/payment-reconciliation.tsを閉じる", exact: true })
      .click();
    await right
      .getByRole("button", {
        name: "src/infrastructure/payments/stripe-gateway.tsを閉じる",
        exact: true,
      })
      .click();
    await expect(right).toHaveCount(0);
    const existing = left
      .locator(".comment-thread")
      .filter({ hasText: "The remaining risk is provider ambiguity" });
    const expanded = existing.getByRole("button", { name: /のコメントを折りたたむ$/ });
    if (await expanded.count()) await expanded.click();
    await expect(page.getByText("参照をコピーしました", { exact: true })).toHaveCount(0);
    const finalThread = left.locator(".comment-thread").filter({ hasText: question }).last();
    await expect(finalThread).toContainText("Codex（デモ）");
    await finalThread.scrollIntoViewIfNeeded();
    const detail = await page.locator(".main-view").boundingBox();
    if (!detail) throw new Error("Missing comment workspace");
    await page.screenshot({
      path: path.join(output, "review-comment.png"),
      clip: { ...detail, height: 650 },
    });
    // Exercise the reply's reference with the real UI after capturing the reply.
    await finalThread.getByRole("button").filter({ hasText: "運用手順" }).click();
    await expect(left).toContainText("monitor candidate age and lease churn externally");
    console.log(`Captured both panes, acknowledgement, and reply; copied ${reference}`);
  }
} finally {
  await browser.close();
}
