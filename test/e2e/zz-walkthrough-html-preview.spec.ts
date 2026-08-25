import { expect, test, type Page } from "@playwright/test";

const pullRequestId = "11111111-1111-4111-8111-111111111111";
const walkthroughId = "70000000-0000-4000-8000-000000000005";

async function openWalkthrough(page: Page, title: string) {
  await page.goto(`/?pullRequestId=${pullRequestId}`);
  const folder = page.getByRole("button", { name: /^ウォークスルー \d+$/u });
  if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
  await page
    .getByRole("navigation", { name: "レビュー文書" })
    .getByRole("button", { name: title, exact: true })
    .click();
}

test("renders a sandboxed full-Walkthrough HTML preview with exact-source assets and comments", async ({
  page,
  request,
}) => {
  const currentResponse = await request.get(
    `/api/pull-requests/${pullRequestId}/walkthroughs/${walkthroughId}`,
  );
  expect(currentResponse.ok()).toBe(true);
  const current = (await currentResponse.json()) as {
    walkthrough: { title: string; references: Array<{ label: string }> };
  };
  const title = "HTML visual：認証境界のBefore / After";
  const body = [
    "```html-preview",
    "<style>",
    "  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }",
    "  .card { padding: 16px; border: 1px solid var(--rvw-border); border-radius: 8px; }",
    "  .card:hover { border-color: var(--rvw-accent); }",
    "</style>",
    '<main class="cards">',
    '  <section class="card" data-rvw-commentable>',
    "    <h2>Before</h2>",
    "    <p>各画面が認証を判断する</p>",
    "  </section>",
    '  <section class="card" data-rvw-commentable>',
    "    <h2>After</h2>",
    '    <p><a href="rvw-ref:handler">AuthGateway に集約する</a></p>',
    "  </section>",
    "</main>",
    '<figure><img src="docs/order-lifecycle.svg" alt="Order lifecycle"><figcaption>Exact source asset</figcaption></figure>',
    '<img src="docs/missing-preview.png" alt="Missing preview image">',
    '<svg aria-label="Inline flow" viewBox="0 0 160 40"><rect x="1" y="1" width="158" height="38" rx="6" fill="none" stroke="currentColor"></rect><text x="80" y="25" text-anchor="middle">Inline SVG</text></svg>',
    "```",
  ].join("\n");
  const updateResponse = await request.post(`/api/fixture/walkthroughs/${walkthroughId}/update`, {
    data: {
      title,
      body,
      referenceLabel: current.walkthrough.references[0]?.label ?? "Route",
    },
  });
  expect(updateResponse.ok()).toBe(true);

  await openWalkthrough(page, title);
  const shell = page.locator(".walkthrough-html-preview-shell");
  const iframe = shell.locator("iframe");
  await expect(shell).toBeVisible();
  await expect(page.locator("pre code.language-html-preview")).toHaveCount(0);
  await expect(iframe).toHaveAttribute("sandbox", "allow-same-origin");
  await expect(iframe).not.toHaveAttribute("sandbox", /allow-scripts/u);

  const frame = page.frameLocator(".walkthrough-html-preview-shell iframe");
  await expect(frame.getByRole("heading", { name: "Before" })).toBeVisible();
  await expect(frame.getByRole("heading", { name: "After" })).toBeVisible();
  await expect(frame.getByRole("img", { name: "Order lifecycle" })).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml;base64,/u,
  );
  await expect(frame.getByRole("img", { name: "Missing preview image" })).toContainText(
    "Missing preview image",
  );
  await expect(frame.getByLabel("Inline flow")).toBeVisible();
  await expect
    .poll(async () =>
      Number.parseFloat(
        (await iframe.getAttribute("style"))?.match(/height:\s*([\d.]+)/u)?.[1] ?? "0",
      ),
    )
    .toBeGreaterThanOrEqual(240);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(frame.getByRole("heading", { name: "After" })).toBeVisible();
  const contentSecurityPolicy = await frame
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  expect(contentSecurityPolicy).toContain("default-src 'none'");
  expect(contentSecurityPolicy).toContain("connect-src 'none'");
  expect(contentSecurityPolicy).toContain("form-action 'none'");

  await frame.getByRole("link", { name: "AuthGateway に集約する" }).click();
  await expect(
    page.getByRole("tab", { name: "src/application/orders/create-order.ts" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: title }).click();

  const afterText = frame.getByRole("link", { name: "AuthGateway に集約する" });
  await afterText.evaluate((element) => {
    const text = [...element.childNodes].find((node) => node instanceof Text);
    if (!(text instanceof Text)) throw new Error("Expected preview text node.");
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(text);
    const selection = element.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  const commentAction = page.locator(".walkthrough-html-comment-action");
  await expect(commentAction).toBeVisible();
  await commentAction.click();
  const composer = shell.locator(".walkthrough-html-comment-composer");
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox").fill("Gatewayへの集約境界を確認してください。");
  await composer.getByRole("textbox").press("Control+Enter");
  await expect(
    page.locator(".markdown-inline-comments .comment-thread").filter({
      hasText: "Gatewayへの集約境界を確認してください。",
    }),
  ).toBeVisible();

  await frame.getByRole("heading", { name: "Before" }).hover();
  await expect(commentAction).toBeVisible();
});

test("never creates a frame or network request for rejected authored HTML", async ({
  page,
  request,
}) => {
  const currentResponse = await request.get(
    `/api/pull-requests/${pullRequestId}/walkthroughs/${walkthroughId}`,
  );
  const current = (await currentResponse.json()) as {
    walkthrough: { references: Array<{ label: string }> };
  };
  const title = "HTML visual security boundary";
  const body = [
    "```html-preview",
    '<script src="http://test.invalid/x.js"></script>',
    '<img src="http://test.invalid/a.png">',
    '<style>@import "http://test.invalid/x.css";</style>',
    '<div style="background-image:url(http://test.invalid/x.png)" onclick="window.__rvwUnsafe = true">Unsafe</div>',
    "```",
  ].join("\n");
  const updateResponse = await request.post(`/api/fixture/walkthroughs/${walkthroughId}/update`, {
    data: {
      title,
      body,
      referenceLabel: current.walkthrough.references[0]?.label ?? "Route",
    },
  });
  expect(updateResponse.ok()).toBe(true);
  let authoredRequestCount = 0;
  await page.route("http://test.invalid/**", async (route) => {
    authoredRequestCount += 1;
    await route.abort();
  });

  await openWalkthrough(page, title);
  await expect(page.locator(".walkthrough-html-preview-error")).toContainText(
    "<script> は使用できません。",
  );
  await expect(page.locator(".walkthrough-html-preview-shell iframe")).toHaveCount(0);
  expect(authoredRequestCount).toBe(0);
  expect(await page.evaluate(() => "__rvwUnsafe" in window)).toBe(false);
});
