import { describe, expect, it, vi } from "vitest";
import { RvwService } from "../../src/application/rvw-service.js";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import type { GitHubPort } from "../../src/infrastructure/github/github-client.js";
import { createApp } from "../../src/server/app.js";
import { ViewerLifecycle } from "../../src/server/viewer-lifecycle.js";
import { VIEWER_ID_HEADER } from "../../src/shared/constants.js";
import { RvwError } from "../../src/shared/errors.js";

const github: GitHubPort = {
  doctor() {
    return Promise.resolve({ version: "fake", authenticated: true });
  },
  getPullRequest() {
    return Promise.reject(new Error("not used"));
  },
  getAttachment() {
    return Promise.reject(new Error("not used"));
  },
};

const attachmentUrl =
  "https://github.com/user-attachments/assets/37948111-1227-4cdb-a76d-dc8eb469ae5c";
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);

function registerPullRequest(database: RvwDatabase): string {
  return database.upsertPullRequest(
    {
      host: "github.com",
      owner: "acme",
      repository: "review-repo",
      number: 7,
      url: "https://github.com/acme/review-repo/pull/7",
      authorLogin: "reviewer",
      headRepositoryOwner: "acme",
      headRepositoryName: "review-repo",
      title: "Review",
      body: "Body",
      baseRefName: "main",
      baseOid: "a".repeat(40),
      headRefName: "feature",
      headOid: "b".repeat(40),
      updatedAt: "2026-08-21T00:00:00.000Z",
      state: "OPEN",
      isDraft: false,
    },
    { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
    "a".repeat(40),
  ).id;
}

function registerBranchReview(database: RvwDatabase): string {
  const initialized = database.beginBranchReviewInitialization(
    {
      owner: "acme",
      repository: "review-repo",
      canonicalName: "acme/review-repo",
      defaultBranchName: "main",
      defaultBranchOid: "b".repeat(40),
    },
    { localRepositoryPath: "/repo", gitCommonDir: "/repo/.git" },
  ).branchReview;
  return database.completeBranchReviewInitialization(initialized.id, initialized.sourceOid).id;
}

describe("local HTTP security", () => {
  it("reads and writes a validated user-wide theme preference", async () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const app = createApp(new RvwService(database, new GitClient(), github), {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });
    const requestHeaders = {
      host: "127.0.0.1:4321",
      origin: "http://127.0.0.1:4321",
      "content-type": "application/json",
    };

    const initial = await app.request("http://127.0.0.1:4321/api/preferences/theme", {
      headers: { host: "127.0.0.1:4321" },
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ ok: true, themePreference: "system" });

    const updated = await app.request("http://127.0.0.1:4321/api/preferences/theme", {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ themePreference: "dark" }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ ok: true, themePreference: "dark" });
    expect(database.getThemePreference()).toBe("dark");
    expect(database.getChangeSequence()).toBe(0);

    const invalid = await app.request("http://127.0.0.1:4321/api/preferences/theme", {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ themePreference: "sepia" }),
    });
    expect(invalid.status).toBe(400);
    expect(database.getThemePreference()).toBe("dark");
    database.close();
  });

  it("rejects unexpected Host, cross-origin writes, and non-JSON writes without CORS", async () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const app = createApp(new RvwService(database, new GitClient(), github), {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });

    const badHost = await app.request("http://127.0.0.1:4321/api/meta/change-sequence", {
      headers: { host: "evil.example" },
    });
    expect(badHost.status).toBe(403);

    const wrongType = await app.request("http://127.0.0.1:4321/api/pull-requests/id/refresh", {
      method: "POST",
      headers: { host: "127.0.0.1:4321", "content-type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const wrongOrigin = await app.request("http://127.0.0.1:4321/api/pull-requests/id/refresh", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4321",
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(wrongOrigin.status).toBe(403);

    const allowed = await app.request("http://127.0.0.1:4321/api/meta/change-sequence", {
      headers: { host: "127.0.0.1:4321" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBeNull();

    const invalidSearchOption = await app.request(
      `http://127.0.0.1:4321/api/pull-requests/id/search?oid=${"a".repeat(40)}&q=test&matchCase=maybe`,
      { headers: { host: "127.0.0.1:4321" } },
    );
    expect(invalidSearchOption.status).toBe(400);

    const initializing = createApp(new RvwService(database, new GitClient(), github), {
      security: { expectedHost: null, expectedOrigin: null },
    });
    const beforeBinding = await initializing.request("http://127.0.0.1/api/meta/change-sequence", {
      headers: { host: "127.0.0.1" },
    });
    expect(beforeBinding.status).toBe(403);
    database.close();
  });

  it("sandboxes same-origin SVG Markdown assets", async () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const service = new RvwService(database, new GitClient(), github);
    const content = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>window.parent.pwned = true</script></svg>',
    );
    vi.spyOn(service, "getRepositoryAsset").mockResolvedValue({
      content,
      oid: "b".repeat(40),
      byteLength: content.byteLength,
    });
    const app = createApp(service, {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });

    const response = await app.request(
      `http://127.0.0.1:4321/api/pull-requests/id/markdown-asset?sourceOid=${"a".repeat(40)}&path=diagram.svg`,
      { headers: { host: "127.0.0.1:4321" } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox",
    );
    database.close();
  });

  it("proxies only validated same-origin GitHub attachment requests", async () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const pullRequestId = registerPullRequest(database);
    const branchReviewId = registerBranchReview(database);
    const requestedUrls: string[] = [];
    let attachmentContent = png;
    let attachmentError: RvwError | null = null;
    const attachmentGithub: GitHubPort = {
      ...github,
      getAttachment(url) {
        requestedUrls.push(url);
        if (attachmentError) return Promise.reject(attachmentError);
        return Promise.resolve({
          content: attachmentContent,
          byteLength: attachmentContent.byteLength,
        });
      },
    };
    const app = createApp(new RvwService(database, new GitClient(), attachmentGithub), {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });
    const headers = { host: "127.0.0.1:4321", "sec-fetch-site": "same-origin" };
    const endpoint = `http://127.0.0.1:4321/api/pull-requests/${pullRequestId}/github-attachment?url=${encodeURIComponent(attachmentUrl)}`;

    const response = await app.request(endpoint, { headers });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(requestedUrls).toEqual([attachmentUrl]);

    const branchEndpoint = `http://127.0.0.1:4321/api/branch-reviews/${branchReviewId}/github-attachment?url=${encodeURIComponent(attachmentUrl)}`;
    const branchResponse = await app.request(branchEndpoint, { headers });
    expect(branchResponse.status).toBe(200);
    expect(Buffer.from(await branchResponse.arrayBuffer())).toEqual(png);
    expect(branchResponse.headers.get("content-type")).toBe("image/png");
    expect(requestedUrls).toEqual([attachmentUrl, attachmentUrl]);

    for (const fetchSite of ["same-site", "cross-site"]) {
      const blocked = await app.request(endpoint, {
        headers: { host: "127.0.0.1:4321", "sec-fetch-site": fetchSite },
      });
      expect(blocked.status).toBe(403);
    }
    const badOrigin = await app.request(endpoint, {
      headers: { host: "127.0.0.1:4321", origin: "https://evil.example" },
    });
    expect(badOrigin.status).toBe(403);
    expect(requestedUrls).toHaveLength(2);

    const invalid = await app.request(
      `http://127.0.0.1:4321/api/pull-requests/${pullRequestId}/github-attachment?url=${encodeURIComponent("https://github.com.evil.example/user-attachments/assets/37948111-1227-4cdb-a76d-dc8eb469ae5c")}`,
      { headers },
    );
    expect(invalid.status).toBe(400);
    expect(requestedUrls).toHaveLength(2);

    attachmentContent = Buffer.from(
      '<?xml version="1.0"?><!-- generated --><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    const svg = await app.request(endpoint, { headers });
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(svg.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");

    attachmentContent = Buffer.from('{"message":"Not Found"}');
    const unknown = await app.request(endpoint, { headers });
    expect(unknown.status).toBe(415);
    expect((await unknown.json()) as object).toMatchObject({
      error: { code: "UNSUPPORTED_IMAGE" },
    });

    attachmentError = new RvwError(
      "FILE_TOO_LARGE",
      "GitHub attachmentは10 MiB以下にしてください。",
      { status: 413 },
    );
    const tooLarge = await app.request(endpoint, { headers });
    expect(tooLarge.status).toBe(413);

    const missing = await app.request(
      `http://127.0.0.1:4321/api/pull-requests/missing/github-attachment?url=${encodeURIComponent(attachmentUrl)}`,
      { headers },
    );
    expect(missing.status).toBe(404);
    const missingBranch = await app.request(
      `http://127.0.0.1:4321/api/branch-reviews/missing/github-attachment?url=${encodeURIComponent(attachmentUrl)}`,
      { headers },
    );
    expect(missingBranch.status).toBe(404);
    expect(requestedUrls).toHaveLength(5);
    database.close();
  });

  it("rejects non-image repository assets and supports metadata HEAD checks", async () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const service = new RvwService(database, new GitClient(), github);
    const asset = { content: png, oid: "b".repeat(40), byteLength: png.byteLength };
    const repositoryAssetMock = vi.spyOn(service, "getRepositoryAsset").mockResolvedValue(asset);
    const app = createApp(service, {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
    });
    const url = `http://127.0.0.1:4321/api/pull-requests/id/markdown-asset?sourceOid=${"a".repeat(40)}&path=asset.png`;

    const head = await app.request(url, { method: "HEAD", headers: { host: "127.0.0.1:4321" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(head.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await head.text()).toBe("");

    repositoryAssetMock.mockResolvedValue({
      content: Buffer.from("<html>not an image</html>"),
      oid: "b".repeat(40),
      byteLength: 25,
    });
    const invalid = await app.request(url, { headers: { host: "127.0.0.1:4321" } });
    expect(invalid.status).toBe(415);
    database.close();
  });

  it("registers and releases validated viewer leases through the local API", async () => {
    const database = new RvwDatabase({ filePath: ":memory:", migrationsDirectory: "./migrations" });
    const lifecycle = new ViewerLifecycle({ onAllViewersClosed() {} });
    const app = createApp(new RvwService(database, new GitClient(), github), {
      security: { expectedHost: "127.0.0.1:4321", expectedOrigin: "http://127.0.0.1:4321" },
      viewerLifecycle: lifecycle,
    });
    const viewerId = "44444444-4444-4444-8444-444444444444";

    const heartbeat = await app.request("http://127.0.0.1:4321/api/meta/change-sequence", {
      headers: { host: "127.0.0.1:4321", [VIEWER_ID_HEADER]: viewerId },
    });
    expect(heartbeat.status).toBe(200);
    expect(lifecycle.activeViewerCount).toBe(1);

    const invalidHeartbeat = await app.request("http://127.0.0.1:4321/api/meta/change-sequence", {
      headers: { host: "127.0.0.1:4321", [VIEWER_ID_HEADER]: "invalid" },
    });
    expect(invalidHeartbeat.status).toBe(400);

    const release = await app.request("http://127.0.0.1:4321/api/meta/viewers/release", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4321",
        origin: "http://127.0.0.1:4321",
        "content-type": "application/json",
      },
      body: JSON.stringify({ viewerId }),
    });
    expect(release.status).toBe(200);
    expect(lifecycle.activeViewerCount).toBe(0);

    lifecycle.close();
    database.close();
  });
});
