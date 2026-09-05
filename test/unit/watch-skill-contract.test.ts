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
    expect(skill).toContain("target eight concurrent subagent slots");
    expect(skill).toContain("set `<RESERVED_WORKER_SLOTS>` to `8`");
    expect(skill).toMatch(/use `1` only when it\s+cannot guarantee more than one/);
    expect(skill).toContain("Never set the value above reserved capacity");
    expect(skill).toContain("long-lived streaming-process facility");
    expect(skill).toMatch(/never wait for the driver to exit or\s+buffer a group of lines/);
    expect(skill).toContain("task state about every 250 milliseconds");
    expect(skill).toContain("After retryable `fail`");
    expect(skill).toMatch(/do\s+not wait for another comment event or reconnect/);
    expect(skill).toContain("--author-label '<CURRENT_AGENT_NAME>'");
    expect(skill).toMatch(
      /label is stored on the acknowledgement post and remains when\s+that post is replaced/,
    );
  });

  it("parallelizes investigate-only follow-ups without weakening writer serialization", () => {
    expect(skill).toMatch(
      /Do not reduce capacity merely because multiple leases may inspect the same Pull\s+Request or repository/,
    );
    expect(skill).toMatch(
      /an event for a PR with an active lease becomes a separate\s+eligible batch/,
    );
    expect(skill).toMatch(
      /immutable task policy allows `fix-and-push`[\s\S]*same-PR\s+follow-ups remain durable but ineligible/,
    );
    expect(skill).toMatch(/repository write\s+reservations serialize writers across different PRs/);
  });

  it("separates historical actionability from shared watcher authority", () => {
    expect(skill).toContain("watch-state.mjs' activate");
    expect(skill).toMatch(/Never run `activate` when resuming an existing task/);
    expect(skill).toMatch(/older Skill[\s\S]*fails\s+closed/i);
    expect(skill).toContain("`batch-skipped` is diagnostic completion");
    expect(skill).toMatch(/resolved and disappeared operations[\s\S]*durably marked skipped/);
    expect(skill).toMatch(/mixed batch[\s\S]*unresolved operations/);
    expect(skill).toMatch(/superseded driver terminates/);
  });
});
