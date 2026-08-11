import { describe, expect, it, vi } from "vitest";
import { RvwService } from "../../src/application/rvw-service.js";
import { RvwDatabase } from "../../src/infrastructure/db/database.js";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import type { GitHubPort } from "../../src/infrastructure/github/github-client.js";
import { createApp } from "../../src/server/app.js";
import { ViewerLifecycle } from "../../src/server/viewer-lifecycle.js";
import { VIEWER_ID_HEADER } from "../../src/shared/constants.js";

const github: GitHubPort = {
  doctor() {
    return Promise.resolve({ version: "fake", authenticated: true });
  },
  getPullRequest() {
    return Promise.reject(new Error("not used"));
  },
};

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
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox",
    );
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
