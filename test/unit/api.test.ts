import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/web/api.js";

describe("web api errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns a browser fetch connection failure into actionable Japanese guidance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(api("/api/test")).rejects.toMatchObject({
      code: "LOCAL_SERVER_UNAVAILABLE",
      message:
        "rvwのローカルサーバーに接続できません。表示済みの内容はそのまま保持されています。`rvw open`から起動し直してください。",
    });
  });
});
