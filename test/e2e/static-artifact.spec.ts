import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const id = "80000000-0000-4000-8000-000000000005";
const pr = "11111111-1111-4111-8111-111111111111";
test.afterEach(async ({ request }) => {
  await request.delete(`/api/pull-requests/${pr}/walkthroughs/${id}`, { data: {} });
});
for (const colorScheme of ["light", "dark"] as const) {
  test(`reproduces standalone editorial design and local assets in ${colorScheme}`, async ({
    page,
    request,
  }, testInfo) => {
    expect(
      (
        await request.post("/api/fixture/walkthroughs/70000000-0000-4000-8000-000000000005/clone", {
          data: { id },
        })
      ).ok(),
    ).toBe(true);
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.emulateMedia({ colorScheme });
    const externalRequests: string[] = [];
    page.on("request", (req) => {
      if (/^https?:/u.test(req.url()) && !req.url().startsWith("http://127.0.0.1:"))
        externalRequests.push(req.url());
    });
    const body = `~~~html-preview\n${readFileSync("test/fixtures/static-artifact/editorial.html", "utf8")}\n~~~`;
    const assets = [
      {
        path: "assets/editorial.woff2",
        mediaType: "font/woff2",
        base64: readFileSync("test/fixtures/static-artifact/assets/editorial.woff2").toString(
          "base64",
        ),
      },
      {
        path: "assets/pixel.png",
        mediaType: "image/png",
        base64: readFileSync("test/fixtures/static-artifact/assets/pixel.png").toString("base64"),
      },
    ];
    expect(
      (
        await request.post(`/api/fixture/walkthroughs/${id}/update`, {
          data: { title: "Independent editorial", body, assets, referenceLabel: "Implementation" },
        })
      ).ok(),
    ).toBe(true);
    const open = async () => {
      await page.goto(`/?pullRequestId=${pr}`);
      const folder = page.getByRole("button", { name: /^ウォークスルー \d+$/u });
      if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
      await page
        .getByRole("navigation", { name: "レビュー文書" })
        .getByRole("button", { name: "Independent editorial", exact: true })
        .click();
    };
    await open();
    const shell = page.locator(".walkthrough-html-preview-shell");
    const frame = shell.frameLocator("iframe");
    const assertDesign = async () => {
      await expect(frame.locator("body")).toHaveCSS("font-size", "19px");
      await expect(frame.locator("html")).toHaveCSS("font-size", "16px");
      await expect(frame.locator("body")).toHaveCSS("font-family", "Editorial, serif");
      await expect(frame.locator("html")).toHaveCSS("background-color", "rgb(245, 235, 213)");
      await expect(frame.locator("h1")).toHaveCSS("font-weight", "400");
      await expect(frame.locator(".metric").first()).toHaveCSS(
        "border-top-color",
        "rgb(173, 53, 78)",
      );
      await expect
        .poll(() =>
          frame.locator("body").evaluate(async (body) => {
            const fonts = body.ownerDocument.fonts;
            await fonts.ready;
            return (
              [...fonts].some((font) => font.family === "Editorial" && font.status === "loaded") &&
              fonts.check("19px Editorial", "boundary")
            );
          }),
        )
        .toBe(true);
      await expect
        .poll(() =>
          frame.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBe(1);
      expect(
        await frame
          .locator(".banner")
          .evaluate(
            (element) =>
              element.ownerDocument.defaultView!.getComputedStyle(element).backgroundImage,
          ),
      ).toContain("data:image/png");
      const sizes = await frame
        .locator("html")
        .evaluate((element) => ({ scroll: element.scrollWidth, width: element.clientWidth }));
      expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
    };
    await assertDesign();
    expect((await shell.boundingBox())!.width).toBeGreaterThan(1100);
    await page.screenshot({ path: testInfo.outputPath("editorial.png") });
    // Exact DOM selection survives font loading and reload without changing authored text nodes.
    await frame.locator("#claim").evaluate((element) => {
      const text = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)!;
      const range = element.ownerDocument.createRange();
      range.setStart(text, 4);
      range.setEnd(text, 11);
      const selection = element.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await shell.getByRole("button", { name: "選択したテキストへコメント" }).click();
    const composer = shell.locator(".walkthrough-html-comment-composer");
    await composer.getByRole("textbox").fill("Validate this boundary");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/comments") && response.request().method() === "POST",
    );
    await composer.getByRole("textbox").press("Control+Enter");
    const result = (await (await saved).json()) as { comment: { id: string } };
    await open();
    await assertDesign();
    await shell
      .getByRole("button", { name: `${result.comment.id}のコメントを開く`, exact: true })
      .click();
    await expect
      .poll(() =>
        frame
          .locator("body")
          .evaluate((body) =>
            [...(body.ownerDocument.defaultView!.CSS.highlights.get("rvw-comment") ?? [])]
              .map((range) => (range instanceof Range ? range.toString() : ""))
              .join(""),
          ),
      )
      .toBe("gateway");
    expect(
      (
        await request.post(`/api/fixture/walkthroughs/${id}/update`, {
          data: {
            title: "Independent editorial",
            body: body.replace("</main>", "<p>Updated document</p></main>"),
            referenceLabel: "Implementation",
          },
        })
      ).ok(),
    ).toBe(true);
    await expect(frame.getByText("Updated document", { exact: true })).toBeVisible();
    await assertDesign();
    await frame
      .getByRole("link", { name: /Inspect the implementation/u })
      .click({ modifiers: ["Control"] });
    await expect(page.locator(".document-pane")).toHaveCount(2);
    await assertDesign();
    await page.screenshot({ path: testInfo.outputPath("editorial-split.png") });
    expect(externalRequests).toEqual([]);
    expect((await request.delete(`/api/comments/${result.comment.id}`, { data: {} })).ok()).toBe(
      true,
    );
  });
}
