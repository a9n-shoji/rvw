import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync("skills/rvw-watch-comments/SKILL.md", "utf8");

describe("rvw-watch-comments delegation contract", () => {
  it("requires immediate dispatch for every acknowledged lease", () => {
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

  it("treats each checkbox as permission and keeps PR workers separate from investigations", () => {
    expect(skill).toContain("permission, never an instruction");
    expect(skill).toContain("Infer the requested outcome only from the comment body");
    expect(skill).toContain("Never inherit a root post's permission");
    expect(skill).toContain("one change worker associated with each PR");
    expect(skill).toContain("Reuse that worker for later");
    expect(skill).toContain("dedicated clean worktree for each PR");
    expect(skill).toContain("one slot available for");
    expect(skill).toContain("never wait for a same-PR");
    expect(skill).toContain("immutable committed source");
    expect(skill).toContain("stop further changes at a safe boundary");
    expect(skill).toContain("same head branch");
    expect(skill).toMatch(/Activation does not discard[\s\S]*existing reservation/);
  });

  it("allows requested local Artifacts while retaining the code-write boundary", () => {
    expect(skill).toContain("--purpose artifact");
    expect(skill).toContain("defaults to `--purpose code`");
    expect(skill).toContain("It uses the same shared lock as code work");
    expect(skill).toContain("does not upgrade the lane or grant code/GitHub permission");
    expect(skill).toContain("Do not delete Artifacts without separate explicit authorization");
    expect(skill).not.toContain("PR metadata, Walkthrough, Structure, or other Artifact changes");
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
