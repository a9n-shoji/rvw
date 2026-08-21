import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync("skills/rvw-watch-comments/SKILL.md", "utf8");

describe("rvw-watch-comments delegation contract", () => {
  it("requires immediate fresh-subagent dispatch for every acknowledged lease", () => {
    expect(skill).toContain("Delegate every acknowledged batch immediately");
    expect(skill).toContain("same parent scheduling turn");
    expect(skill).toContain("No direct-processing exception exists");
    expect(skill).toMatch(/Never leave an\s+acknowledged lease parked without a live subagent/);
    expect(skill).not.toContain("the parent may investigate directly");
  });

  it("bounds auto-ack by reserved capacity and automatically drains eligible work", () => {
    expect(skill).toContain("--max-in-flight '<RESERVED_WORKER_SLOTS>'");
    expect(skill).toContain("long-lived streaming-process facility");
    expect(skill).toMatch(/never wait for the driver to exit or\s+buffer a group of lines/);
    expect(skill).toContain("task state about every 250 milliseconds");
    expect(skill).toContain("After retryable `fail`");
    expect(skill).toMatch(/do\s+not wait for another comment event or reconnect/);
  });
});
