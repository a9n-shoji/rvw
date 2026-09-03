import { describe, expect, it } from "vitest";
import {
  createRealisticFixture,
  validateRealisticFixture,
} from "../fixtures/realistic/realistic-fixture.mjs";

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
        repositoryFileCount: 147,
        changedFileCount: 39,
        changeKinds: { added: 35, modified: 1, renamed: 1, deleted: 2 },
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
