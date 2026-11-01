import { expect, test } from "@playwright/test";

test("viewer CSP blocks injected scripts and framing while loading the app", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await expect(page.getByRole("heading", { name: "Pull Requests" })).toBeVisible();
  const injected = await page.evaluate(async () => {
    const script = document.createElement("script");
    script.textContent = 'document.documentElement.dataset.injected = "yes"';
    document.body.append(script);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return document.documentElement.dataset.injected;
  });
  expect(injected).toBeUndefined();
  const blockedDirective = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener("securitypolicyviolation", (event) => {
        if (event.blockedURI === "https://rvw-security-test.invalid/") {
          resolve(event.effectiveDirective);
        }
      });
    });
    await fetch("https://rvw-security-test.invalid/").catch(() => undefined);
    return violation;
  });
  expect(blockedDirective).toBe("connect-src");
  const framed = await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    frame.src = "/";
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener("load", () => resolve(), { once: true }),
    );
    document.body.append(frame);
    await loaded;
    try {
      return Boolean(frame.contentDocument?.querySelector("#root"));
    } catch {
      return false;
    }
  });
  expect(framed).toBe(false);
});
