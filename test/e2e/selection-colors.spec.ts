import { expect, test } from "@playwright/test";

const id = "82000000-0000-4000-8000-000000000005";
const pr = "11111111-1111-4111-8111-111111111111";
test.afterEach(async ({ request }) => {
  await request.delete(`/api/pull-requests/${pr}/walkthroughs/${id}`, { data: {} });
});

for (const standalone of [false, true]) {
  test(`selection fallback and authored overrides in ${standalone ? "standalone" : "fragment"} HTML`, async ({
    page,
    request,
  }) => {
    expect(
      (
        await request.post("/api/fixture/walkthroughs/70000000-0000-4000-8000-000000000005/clone", {
          data: { id },
        })
      ).ok(),
    ).toBe(true);
    const content = '<p id="sample">Readable <strong>selected text</strong></p>';
    const html = standalone
      ? `<!doctype html><html><head><style>body { background: #222; color: #eee; }</style></head><body>${content}</body></html>`
      : content;
    expect(
      (
        await request.post(`/api/fixture/walkthroughs/${id}/update`, {
          data: {
            title: "Selection colors",
            body: `~~~html-preview\n${html}\n~~~`,
            referenceLabel: "Implementation",
          },
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`/?pullRequestId=${pr}`);
    const folder = page.getByRole("button", { name: /^ウォークスルー \d+$/u });
    if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
    await page
      .getByRole("navigation", { name: "レビュー文書" })
      .getByRole("button", { name: "Selection colors", exact: true })
      .click();
    const sample = page
      .frameLocator(".walkthrough-html-preview-shell iframe")
      .locator("#sample strong");
    const colors = () =>
      sample.evaluate((element) => {
        const css = element.ownerDocument.defaultView!.getComputedStyle(element, "::selection");
        return [css.backgroundColor, css.color];
      });
    await expect.poll(colors).toEqual(["rgb(185, 218, 250)", "rgb(23, 43, 64)"]);
    // Author rules, even in a cascade layer or inherited from body, take precedence.
    for (const css of [
      "@layer artwork { :root::selection { background-color: #ffc; color: #321; } }",
      "body::selection { background-color: #ffc; color: #321; }",
      "::selection { background-color: #ffc; color: #321; }",
    ]) {
      await sample.evaluate((element, rules) => {
        const document = element.ownerDocument;
        document.getElementById("authored-selection")?.remove();
        const style = document.createElement("style");
        style.id = "authored-selection";
        style.textContent = rules;
        document.head.append(style);
      }, css);
      await expect.poll(colors).toEqual(["rgb(255, 255, 204)", "rgb(51, 34, 17)"]);
    }
  });
}
