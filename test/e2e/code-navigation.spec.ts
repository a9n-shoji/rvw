import type { DefinitionResult } from "../../src/domain/code-navigation.js";
import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import { createGitRepository, commitFile, git } from "../fixtures/git-repository.js";

let process: ChildProcess;
let repository: string;
let url: string;
let base: string;
let head: string;
let pullRequestId: string;

test.beforeAll(async () => {
  repository = realpathSync(createGitRepository("rvw-navigation-e2e-"));
  commitFile(repository, "user.rb", "class User\n def save!; end\nend\n", "definition");
  commitFile(repository, "other.rb", "class Other\n def save!; end\nend\n", "ambiguous method");
  commitFile(
    repository,
    "Button.tsx",
    "export function Button() { return <button>Submit</button>; }\n",
    "TSX component",
  );
  commitFile(
    repository,
    "Secondary.jsx",
    "export const Button = () => <button>Other</button>;\n",
    "JSX component",
  );
  commitFile(
    repository,
    "App.tsx",
    "export function App() { return <Button/>; }\n",
    "old React usage",
  );
  commitFile(
    repository,
    `${"long_path_".repeat(20)}.rb`,
    "BulkDefinition.new\n" +
      `class BulkDefinition; end # ${"long_preview_".repeat(20)}\n`.repeat(110),
    "many candidates with long paths and previews",
  );
  base = commitFile(repository, "caller.rb", "User.new.save!\n", "old call");
  git(repository, "mv", "user.rb", "renamed.rb");
  git(repository, "commit", "-m", "rename definition");
  commitFile(
    repository,
    "App.tsx",
    'export function App() { return <Button title="Save"/>; }\n',
    "new React usage",
  );
  head = commitFile(repository, "caller.rb", "User.new.save! # changed\nMissing.new\n", "new call");
  const databasePath = path.join(repository, "review.db");
  const database = new RvwDatabase({
    filePath: databasePath,
    migrationsDirectory: path.resolve("migrations"),
  });
  pullRequestId = database.upsertPullRequest(
    {
      host: "github.com",
      owner: "acme",
      repository: "review-repo",
      number: 7,
      url: "https://github.com/acme/review-repo/pull/7",
      authorLogin: "reviewer",
      headRepositoryOwner: "acme",
      headRepositoryName: "review-repo",
      title: "Ruby navigation",
      body: "Review Ruby calls",
      baseRefName: "main",
      baseOid: base,
      headRefName: "feature",
      headOid: head,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      state: "OPEN",
      isDraft: false,
      approvalCount: 0,
    },
    { localRepositoryPath: repository, gitCommonDir: path.join(repository, ".git") },
    base,
  ).id;
  database.close();
  await new GitClient().ensureCommitRef(repository, 7, head);
  process = spawn(
    globalThis.process.execPath,
    [
      path.resolve("dist/cli.mjs"),
      "open",
      "https://github.com/acme/review-repo/pull/7",
      "--no-open",
      "--port",
      "0",
    ],
    {
      cwd: repository,
      env: { ...globalThis.process.env, RVW_DATABASE_PATH: databasePath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(output)), 10000);
    process.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    process.stderr!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    process.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited ${code}: ${output}`));
    });
  });
});

test.afterAll(async () => {
  if (process && process.exitCode === null) {
    const exited = once(process, "exit");
    process.kill("SIGTERM");
    await exited;
  }
  if (repository) rmSync(repository, { recursive: true, force: true });
});

async function openFile(page: Page, name: string) {
  await expect(page.getByRole("button", { name: "Pull Request.md", exact: true })).toBeVisible();
  await page.keyboard.press("Control+P");
  const palette = page.getByRole("dialog", { name: "ファイルを開く" });
  await palette.getByRole("combobox", { name: "ファイル名で検索" }).fill(name);
  await palette.getByRole("option", { name, exact: true }).click();
}

test("packaged CLI opens Ruby candidates from both diff sides, preserving exact source and history", async ({
  page,
}, testInfo) => {
  await page.goto(url);
  await expect(
    page.locator(".topbar").getByRole("heading", { name: "Ruby navigation", exact: true }),
  ).toBeVisible();
  await openFile(page, "caller.rb");
  const scope = page.getByRole("region", { name: "レビュー範囲", exact: true });
  await scope.getByRole("button", { name: "変更", exact: true }).click();
  await scope.getByRole("button", { name: "stacked", exact: true }).click();
  const left = page.locator('.document-pane[data-pane="left"]');
  const oldToken = left
    .locator('[data-line-type="change-deletion"] [data-char]')
    .filter({ hasText: /^User$/ })
    .first();
  await oldToken.click({ modifiers: ["ControlOrMeta"] });
  const candidates = page.getByRole("dialog", { name: "定義候補", exact: true });
  await expect(candidates.getByRole("button", { name: /user.rb:1/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("definition-candidates.png") });
  await candidates
    .getByRole("button", { name: /user.rb:1/ })
    .click({ modifiers: ["ControlOrMeta"] });
  const right = page.locator('.document-pane[data-pane="right"]');
  await expect(right.getByRole("tab", { name: "user.rb", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(right.locator('[data-line="1"]')).toContainText("class User");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/definitions?")) requests.push(request.url());
  });
  const newToken = left
    .locator('[data-line-type="change-addition"] [data-char]')
    .filter({ hasText: /^User$/ })
    .first();
  await newToken.click({ modifiers: ["ControlOrMeta"] });
  await expect(candidates.getByRole("button", { name: /renamed.rb:1/ })).toBeVisible();
  expect(requests.some((request) => new URL(request).searchParams.get("sourceOid") === head)).toBe(
    true,
  );
  await candidates.getByRole("button", { name: /renamed.rb:1/ }).click();
  await expect(left.getByRole("tab", { name: "renamed.rb", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(left.locator('[data-line="1"]')).toContainText("class User");
  await page.goBack();
  await expect(left.getByRole("tab", { name: "caller.rb", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(left.locator('[data-line][data-line-type="change-deletion"]')).toBeVisible();
  await scope.getByRole("button", { name: "split", exact: true }).click();
  await oldToken.click({ modifiers: ["ControlOrMeta"] });
  await expect(candidates.getByRole("button", { name: /user.rb:1/ })).toBeVisible();
  await page.keyboard.press("Escape");
  // The old-side endpoint agrees with the rendered candidates, without following a rename to HEAD.
  const response = await page.request.get(
    new URL(
      `/api/pull-requests/${pullRequestId}/definitions?sourceOid=${base}&path=caller.rb&line=1&column=1`,
      url,
    ).href,
  );
  expect(response.ok()).toBe(true);
  expect(((await response.json()) as DefinitionResult).targets[0]?.document).toMatchObject({
    path: "user.rb",
    sourceOid: base,
  });
});

test("full-file exploration handles no definition, API validation and unsupported files", async ({
  page,
}) => {
  await page.goto(url);
  await openFile(page, "caller.rb");
  await page
    .getByRole("region", { name: "レビュー範囲", exact: true })
    .getByRole("button", { name: "全文", exact: true })
    .click();
  await page
    .locator('[data-line="2"] [data-char]')
    .filter({ hasText: /^Missing$/ })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByText("定義候補が見つかりませんでした。", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "定義候補", exact: true })).toHaveCount(0);
  await page
    .locator('[data-line="1"] [data-char]')
    .filter({ hasText: /^save!?$/ })
    .click({ modifiers: ["ControlOrMeta"] });
  const candidates = page.getByRole("dialog", { name: "定義候補", exact: true });
  await expect(candidates.getByRole("button", { name: /renamed.rb:2/ })).toBeVisible();
  await expect(candidates.getByRole("button", { name: /other.rb:2/ })).toBeVisible();
  await candidates.getByRole("button", { name: /other.rb:2/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "other.rb", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await openFile(page, "README.md");
  await expect(page.getByText("⌘ / Ctrl + clickで定義候補を表示", { exact: true })).toHaveCount(0);
  const endpoint = new URL(`/api/pull-requests/${pullRequestId}/definitions`, url);
  for (const params of [
    { sourceOid: "main", path: "caller.rb", line: "1", column: "1" },
    { sourceOid: head, path: "caller.rb", line: "0", column: "1" },
    { sourceOid: head, path: "../caller.rb", line: "1", column: "1" },
  ]) {
    endpoint.search = new URLSearchParams(params).toString();
    expect((await page.request.get(endpoint.href)).status()).toBe(400);
  }
});

test("candidate popup preserves code layout, supports retry and arrow keys, and dismisses outside", async ({
  page,
}) => {
  await page.goto(url);
  await openFile(page, "caller.rb");
  await page
    .getByRole("region", { name: "レビュー範囲", exact: true })
    .getByRole("button", { name: "全文", exact: true })
    .click();
  const token = page.locator('[data-line="1"] [data-char]').filter({ hasText: /^save!?$/ });
  const before = await token.boundingBox();
  let first = true;
  await page.route("**/definitions?*", async (route) => {
    if (!first) return route.continue();
    first = false;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "NAVIGATION_UNAVAILABLE",
          message: "定義の解析を完了できませんでした。再試行してください。",
        },
      }),
    });
  });
  await token.click({ modifiers: ["ControlOrMeta"] });
  const candidates = page.getByRole("dialog", { name: "定義候補", exact: true });
  await expect(candidates.getByRole("button", { name: "再試行", exact: true })).toBeVisible();
  await candidates.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(candidates.getByRole("button", { name: /other.rb:2/ })).toBeVisible();
  expect(await token.boundingBox()).toEqual(before);
  await page.keyboard.press("Home");
  await expect(candidates.getByRole("button", { name: /other.rb:2/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(candidates.getByRole("button", { name: /renamed.rb:2/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(candidates).toHaveCount(0);
  await expect(page.locator('.document-pane[data-pane="left"]')).toBeFocused();
  await token.click({ modifiers: ["ControlOrMeta"] });
  await expect(candidates).toBeVisible();
  await page.getByRole("heading", { name: "Ruby navigation", exact: true }).click();
  await expect(candidates).toHaveCount(0);
});

test("modifier hover shows a pointer and a hundred candidates stay inside a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto(url);
  const file = `${"long_path_".repeat(20)}.rb`;
  await openFile(page, file);
  const token = page.locator('[data-line="1"] [data-char]').filter({ hasText: /^BulkDefinition$/ });
  await token.hover();
  const cursor = await token.evaluate((element) => getComputedStyle(element).cursor);
  const modifier = globalThis.process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await expect(token).toHaveCSS("cursor", "pointer");
  await page.keyboard.up(modifier);
  await expect(token).toHaveCSS("cursor", cursor);
  await page.mouse.move(0, 0);
  await page.keyboard.down(modifier);
  await token.hover();
  await expect(token).toHaveCSS("cursor", "pointer");
  await token.click();
  await page.keyboard.up(modifier);
  const candidates = page.getByRole("dialog", { name: "定義候補", exact: true });
  await expect(candidates.locator("[data-navigation-candidate]")).toHaveCount(100);
  await expect(
    candidates.getByText("候補の先頭100件を表示しています。", { exact: true }),
  ).toBeVisible();
  await expect(
    candidates.getByText("同名の定義です。呼び先は確定していません。", { exact: true }),
  ).toHaveCount(0);
  const box = await candidates.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(640);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);
  expect(await candidates.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  expect(await candidates.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await page.keyboard.press("End");
  await expect(candidates.locator("[data-navigation-candidate]").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(candidates).toHaveCount(0);
});

test("React JSX usage opens cross-language component candidates and excludes the clicked definition", async ({
  page,
}) => {
  await page.goto(url);
  await openFile(page, "App.tsx");
  await page
    .getByRole("region", { name: "レビュー範囲", exact: true })
    .getByRole("button", { name: "変更", exact: true })
    .click();
  const token = page
    .locator('[data-line-type="change-addition"] [data-char]')
    .filter({ hasText: /^Button$/ });
  await token.click({ modifiers: ["ControlOrMeta"] });
  const candidates = page.getByRole("dialog", { name: "定義候補", exact: true });
  await expect(candidates.getByRole("button", { name: /Button.tsx:1/ })).toBeVisible();
  await expect(candidates.getByRole("button", { name: /Secondary.jsx:1/ })).toBeVisible();
  await candidates
    .getByRole("button", { name: /Button.tsx:1/ })
    .click({ modifiers: ["ControlOrMeta"] });
  const right = page.locator('.document-pane[data-pane="right"]');
  await expect(right.getByRole("tab", { name: "Button.tsx", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await right
    .locator('[data-line="1"] [data-char]')
    .filter({ hasText: /^Button$/ })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(candidates.getByRole("button", { name: /Secondary.jsx:1/ })).toBeVisible();
  await expect(candidates.getByRole("button", { name: /Button.tsx:1/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goBack();
  await expect(
    page
      .locator('.document-pane[data-pane="left"]')
      .getByRole("tab", { name: "App.tsx", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});
