import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  createRealisticFixture,
  validateRealisticFixture,
} from "../fixtures/realistic/realistic-fixture.mjs";

const require = createRequire(import.meta.url);
const tscEntry = require.resolve("typescript/bin/tsc");
const vitestEntry = path.join(path.dirname(require.resolve("vitest")), "vitest.mjs");
const fixtureTestTimeout = process.platform === "win32" ? 30_000 : 10_000;
vi.setConfig({ testTimeout: fixtureTestTimeout });

describe("realistic fixture", () => {
  it("builds identical Git history and manifests in separate temporary directories", () => {
    const first = createRealisticFixture();
    const second = createRealisticFixture();
    try {
      expect(first.repositoryRoot).not.toBe(second.repositoryRoot);
      expect(first.baseOid).toBe(second.baseOid);
      expect(first.headOid).toBe(second.headOid);
      expect(first.commits.map(({ oid }) => oid)).toEqual(second.commits.map(({ oid }) => oid));
      expect(first.repositoryEntriesAt(first.headOid)).toEqual(
        second.repositoryEntriesAt(second.headOid),
      );
      expect(first.changedFiles(first.baseOid, first.headOid)).toEqual(
        second.changedFiles(second.baseOid, second.headOid),
      );
      expect(first.manifest).toEqual(second.manifest);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  it("describes one coherent review workload with named invariants", () => {
    const fixture = createRealisticFixture();
    try {
      expect(() => validateRealisticFixture(fixture)).not.toThrow();
      expect(fixture.commits.map(({ subject }) => subject)).toEqual([
        "Define the authenticated order request boundary",
        "Model order placement and pricing invariants",
        "Reserve inventory and authorize payment",
        "Converge retried requests with an idempotency envelope",
        "Persist orders and events in one transaction",
        "Add outbox delivery, migration, and operational signals",
        "Recover orphan payments and close review feedback",
      ]);
      expect(fixture.manifest).toMatchObject({
        commitCount: 7,
        repositoryFileCount: 130,
        changedFileCount: 43,
        changeKinds: { added: 36, modified: 4, renamed: 1, deleted: 2 },
        commentCount: 13,
        unresolvedCommentCount: 7,
        resolvedCommentCount: 6,
        repliedThreadCount: 8,
        walkthroughCount: 3,
        structureCount: 4,
      });
      expect(fixture.manifest.layers).toEqual([
        "application",
        "domain",
        "http",
        "infrastructure",
        "workers",
        "test",
        "migration",
        "docs",
      ]);
      expect(fixture.pullRequest.latestBody).toContain("## Transaction boundary");
      expect(fixture.pullRequest.latestBody).toContain("## Payment failure recovery");
      expect(fixture.pullRequest.latestBody).toContain("## Suggested review route");
      expect(fixture.walkthroughs.map(({ title }) => title)).toEqual([
        "Review route: authenticated order placement",
        "Failure route: retries and payment recovery",
        "Delivery route: transactional outbox operations",
      ]);
      expect(fixture.structures.map(({ title }) => title)).toEqual([
        "Order placement behavior",
        "Idempotent retry convergence",
        "Payment reconciliation recovery",
        "Transactional outbox delivery",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("introduces retry and idempotency behavior in the commits that name them", () => {
    const fixture = createRealisticFixture();
    try {
      const reservationCommit = fixture.commits[2]?.oid;
      const idempotencyCommit = fixture.commits[3]?.oid;
      if (!reservationCommit || !idempotencyCommit) throw new Error("fixture commits are missing");
      const reservationHandler = fixture.repositoryDocumentAt(
        reservationCommit,
        "src/application/orders/create-order.ts",
      ).text;
      const reservationPorts = fixture.repositoryDocumentAt(
        reservationCommit,
        "src/application/ports.ts",
      ).text;
      const idempotencyHandler = fixture.repositoryDocumentAt(
        idempotencyCommit,
        "src/application/orders/create-order.ts",
      ).text;
      expect(reservationHandler).toContain('from "./retry-policy.js"');
      expect(reservationHandler).toContain("this.ports.retries.run(retry");
      expect(reservationHandler).not.toContain("idempotency-policy");
      expect(reservationPorts).toContain("RetryPolicy");
      expect(idempotencyHandler).toContain('from "./idempotency-policy.js"');
      expect(idempotencyHandler).toContain("this.ports.idempotency.run(envelope");
    } finally {
      fixture.cleanup();
    }
  });

  it("ignores hostile global Git configuration and hooks", () => {
    const baseline = createRealisticFixture();
    const hostileRoot = mkdtempSync(path.join(os.tmpdir(), "rvw-hostile-git-"));
    const hooksPath = path.join(hostileRoot, "hooks");
    const templatePath = path.join(hostileRoot, "template");
    const templateHooksPath = path.join(templatePath, "hooks");
    const templateInfoPath = path.join(templatePath, "info");
    const homePath = path.join(hostileRoot, "home");
    const xdgGitPath = path.join(hostileRoot, "xdg", "git");
    mkdirSync(hooksPath);
    mkdirSync(templateHooksPath, { recursive: true });
    mkdirSync(templateInfoPath, { recursive: true });
    mkdirSync(path.join(homePath, ".config", "git"), { recursive: true });
    mkdirSync(xdgGitPath, { recursive: true });
    writeFileSync(path.join(templateInfoPath, "attributes"), "*.ts -text\n", "utf8");
    writeFileSync(path.join(homePath, ".config", "git", "attributes"), "*.ts -text\n", "utf8");
    writeFileSync(path.join(xdgGitPath, "attributes"), "*.ts -text\n", "utf8");
    const hookPath = path.join(hooksPath, "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 73\n", "utf8");
    chmodSync(hookPath, 0o755);
    const hostileConfig = path.join(hostileRoot, "global.gitconfig");
    writeFileSync(
      hostileConfig,
      [
        "[user]",
        "  name = Hostile User",
        "  email = hostile@example.test",
        "[commit]",
        "  gpgSign = true",
        "[core]",
        `  hooksPath = ${hooksPath}`,
        "[init]",
        `  templateDir = ${path.join(hostileRoot, "template")}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const hostileEnvironment = {
      GIT_CONFIG_GLOBAL: hostileConfig,
      GIT_AUTHOR_NAME: "Hostile Author",
      GIT_AUTHOR_EMAIL: "hostile-author@example.test",
      GIT_COMMITTER_NAME: "Hostile Committer",
      GIT_COMMITTER_EMAIL: "hostile-committer@example.test",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Injected Config Identity",
      GIT_TEMPLATE_DIR: templatePath,
      HOME: homePath,
      XDG_CONFIG_HOME: path.join(hostileRoot, "xdg"),
    } as const;
    const previousEnvironment = Object.fromEntries(
      Object.keys(hostileEnvironment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, hostileEnvironment);
    let hostile: ReturnType<typeof createRealisticFixture> | undefined;
    try {
      hostile = createRealisticFixture();
      expect(hostile.baseOid).toBe(baseline.baseOid);
      expect(hostile.headOid).toBe(baseline.headOid);
      expect(hostile.manifest).toEqual(baseline.manifest);
      expect(existsSync(path.join(hostile.repositoryRoot, ".git", "info", "attributes"))).toBe(
        false,
      );
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      hostile?.cleanup();
      baseline.cleanup();
      rmSync(hostileRoot, { recursive: true, force: true });
    }
  });

  it("type-checks the self-contained synthetic repository", () => {
    const fixture = createRealisticFixture();
    try {
      execFileSync(process.execPath, [tscEntry, "--project", fixture.repositoryRoot], {
        stdio: "pipe",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("executes the synthetic core scenario tests without network access", () => {
    const fixture = createRealisticFixture();
    try {
      symlinkSync(
        path.resolve("node_modules"),
        path.join(fixture.repositoryRoot, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      execFileSync(
        process.execPath,
        [
          vitestEntry,
          "run",
          "--root",
          fixture.repositoryRoot,
          "test/unit/pricing.test.ts",
          "test/unit/order-telemetry.test.ts",
          "test/integration/create-order.test.ts",
          "test/integration/payment-reconciliation.test.ts",
          "test/contract/order-api.test.ts",
          "test/contract/outbox-event.test.ts",
        ],
        { stdio: "pipe" },
      );
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")(
    "removes the temporary repository when a child receives SIGTERM",
    async () => {
      const child = spawn(
        process.execPath,
        [path.resolve("test/fixtures/realistic/signal-cleanup-child.mjs")],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      const repositoryRoot = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("cleanup child did not become ready")),
          8_000,
        );
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          const newline = output.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timer);
          resolve(output.slice(0, newline));
        });
        child.once("error", reject);
      });
      expect(existsSync(repositoryRoot)).toBe(true);
      child.kill("SIGTERM");
      const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(exitResult).toEqual({ code: 0, signal: null });
      expect(existsSync(repositoryRoot)).toBe(false);
    },
    15_000,
  );

  it("tracks the renamed review target and marks the deleted target as outdated", () => {
    const fixture = createRealisticFixture();
    try {
      const renameComment = fixture.comments.find(
        ({ id }) => id === fixture.manifest.rename.commentId,
      );
      const deletedComment = fixture.comments.find(
        ({ id }) => id === fixture.manifest.deleted.commentId,
      );
      expect(renameComment?.target).toMatchObject({
        kind: "document",
        path: "src/application/orders/retry-policy.ts",
      });
      expect(
        fixture.resolvePathAt(
          renameComment!.createdHeadOid,
          fixture.manifest.rename.oldPath,
          fixture.headOid,
        ),
      ).toBe("src/application/orders/idempotency-policy.ts");
      expect(
        fixture.resolvePathAt(
          deletedComment!.createdHeadOid,
          fixture.manifest.deleted.path,
          fixture.headOid,
        ),
      ).toBeNull();
      expect(
        fixture.structures.filter(({ nodes }) =>
          nodes.some(({ anchor }) => anchor?.path === fixture.manifest.multiStructurePath),
        ),
      ).toHaveLength(2);
      expect(
        fixture.repositoryDocumentAt(fixture.headOid, "missing/not-present.ts").availability,
      ).toBe("missing");
    } finally {
      fixture.cleanup();
    }
  });
});
