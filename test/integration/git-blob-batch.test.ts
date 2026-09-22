import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import { createGitRepository, git } from "../fixtures/git-repository.js";

const repositories: string[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0))
    rmSync(repository, { recursive: true, force: true });
});

describe("Git blob batches", () => {
  it("uses exact blob OIDs and preserves framing for binary, Unicode, CRLF and duplicate blobs", async () => {
    const repository = createGitRepository();
    repositories.push(repository);
    writeFileSync(path.join(repository, "unicode.rb"), "class 顧客\r\nend\r\n");
    writeFileSync(path.join(repository, "binary.rb"), Buffer.from([0, 10, 255, 10]));
    writeFileSync(path.join(repository, "not-utf8.rb"), Buffer.from([255]));
    writeFileSync(path.join(repository, "empty.rb"), "");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "batch");
    const client = new GitClient();
    const oid = git(repository, "rev-parse", "HEAD");
    const entries = await client.tree(repository, oid);
    const batch = await client.readBlobDocuments(repository, [...entries, entries[0]!]);
    for (const entry of entries)
      expect(batch.get(entry.oid)).toEqual(await client.readDocument(repository, oid, entry.path));
    writeFileSync(path.join(repository, "unicode.rb"), "dirty");
    expect(
      (await client.readBlobDocuments(repository, entries)).get(
        entries.find((entry) => entry.path === "unicode.rb")!.oid,
      )?.text,
    ).toBe("class 顧客\nend\n");
  });

  it("rejects object expressions, excessive sizes and metadata/object mismatches", async () => {
    const repository = createGitRepository();
    repositories.push(repository);
    const client = new GitClient();
    const entry = (await client.tree(repository, git(repository, "rev-parse", "HEAD")))[0]!;
    await expect(
      client.readBlobDocuments(repository, [{ ...entry, oid: "HEAD:README.md" }]),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      client.readBlobDocuments(repository, [{ ...entry, size: 1024 * 1024 + 1 }]),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      client.readBlobDocuments(repository, [{ ...entry, size: entry.size! + 1 }]),
    ).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    await expect(
      client.readBlobDocuments(repository, [{ ...entry, oid: "f".repeat(40) }]),
    ).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    await expect(client.readBlobDocuments(repository, [])).resolves.toEqual(new Map());
  });
});
