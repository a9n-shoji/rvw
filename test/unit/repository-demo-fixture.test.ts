import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepositoryDemoFixture } from "../../scripts/repository-demo-fixture.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("repository demo fixture", () => {
  it("exposes committed medium-sized repository data with review context", () => {
    const fixture = createRepositoryDemoFixture(repositoryRoot);
    const entries = fixture.repositoryEntriesAt(fixture.headOid);
    const changedFiles = fixture.changedFiles(fixture.baseOid, fixture.headOid);
    const totalBytes = entries.reduce((total, entry) => total + (entry.size ?? 0), 0);
    const substantiveFiles = entries.filter((entry) => (entry.size ?? 0) >= 1000);

    expect(fixture.commits).toHaveLength(6);
    expect(entries.length).toBeGreaterThanOrEqual(100);
    expect(totalBytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(substantiveFiles.length).toBeGreaterThanOrEqual(75);
    expect(changedFiles.length).toBeGreaterThanOrEqual(10);
    expect(fixture.issues.map((issue) => issue.number)).toEqual([156, 142, 98]);
    expect(fixture.issues.some((issue) => issue.state === "CLOSED")).toBe(true);
    expect(fixture.walkthroughs).toHaveLength(2);
    expect(fixture.comments).toHaveLength(5);
    expect(fixture.comments.some((comment) => comment.resolvedAt !== null)).toBe(true);
    expect(fixture.comments.some((comment) => comment.posts.length > 1)).toBe(true);
    expect(fixture.comments.some((comment) => comment.target.kind === "issue")).toBe(true);

    const app = fixture.repositoryDocumentAt(fixture.headOid, "src/web/app/App.tsx");
    expect(app.availability).toBe("available");
    expect(app.text?.split("\n").length).toBeGreaterThan(500);
    expect(fixture.repositoryDocumentAt(fixture.headOid, "missing.ts").availability).toBe(
      "missing",
    );

    for (const walkthrough of fixture.walkthroughs) {
      expect(walkthrough.sourceOid).toBe(fixture.headOid);
      for (const reference of walkthrough.references) {
        const document = fixture.repositoryDocumentAt(fixture.headOid, reference.path);
        expect(document.availability, reference.path).toBe("available");
        if (reference.endLine !== null) {
          expect(reference.endLine).toBeLessThanOrEqual(document.text?.split("\n").length ?? 0);
        }
      }
    }
  });
});
