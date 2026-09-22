import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import { GitCodeNavigation } from "../../src/infrastructure/navigation/git-code-navigation.js";
import { extractSymbols } from "../../src/infrastructure/navigation/tree-sitter-tags.js";
const extractRubySymbols = (text: string) => extractSymbols(text, "ruby");
import { createGitRepository, commitFile, git } from "../fixtures/git-repository.js";

const repositories: string[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0))
    rmSync(repository, { recursive: true, force: true });
});
function fixture() {
  const repository = createGitRepository();
  repositories.push(repository);
  const extract = vi.fn(extractRubySymbols);
  return { repository, extract, index: new GitCodeNavigation(new GitClient(), extract) };
}
const document = (sourceOid: string, path = "caller.rb") => ({
  kind: "repository-file" as const,
  pullRequestId: "fixture",
  sourceOid,
  path,
});

describe("Git-backed Ruby definition candidates", () => {
  it("omits only the clicked declaration while retaining other declarations and copied paths", async () => {
    const { repository, index } = fixture();
    commitFile(repository, "copy.rb", "class User; end\nclass User; end\n", "copy");
    const oid = commitFile(
      repository,
      "caller.rb",
      "class User; end\nclass User; end\n",
      "declarations",
    );
    const result = await index.definitions(repository, document(oid), 1, 8);
    expect(result.targets.map((target) => [target.document.path, target.line])).toEqual([
      ["caller.rb", 2],
      ["copy.rb", 1],
      ["copy.rb", 2],
    ]);
  });
  it("shares in-flight blob parses across simultaneous lookups", async () => {
    const { repository, index, extract } = fixture();
    const oid = commitFile(repository, "caller.rb", "class User; end\nUser.new\n", "concurrent");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => index.definitions(repository, document(oid), 2, 1)),
    );
    expect(results.every((result) => result.targets.length === 1)).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("parses only matching files and reuses their blobs across commits", async () => {
    const { repository, extract } = fixture();
    for (let index = 0; index < 40; index++)
      writeFileSync(path.join(repository, `model_${index}.rb`), `class Model${index}; end\n`);
    git(repository, "add", ".");
    git(repository, "commit", "-m", "models");
    const oid = commitFile(repository, "caller.rb", "Model0.new\n", "caller");
    const client = new GitClient();
    const readDocument = vi.spyOn(client, "readDocument");
    const batch = vi.spyOn(client, "readBlobDocuments");
    const index = new GitCodeNavigation(client, extract);
    await index.definitions(repository, document(oid), 1, 1);
    expect(readDocument).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls.filter((call) => call[1].length > 0)).toHaveLength(1);
    const count = extract.mock.calls.length;
    expect(count).toBe(2);
    const next = commitFile(repository, "unrelated.md", "Unchanged Ruby\n", "next");
    batch.mockClear();
    await index.definitions(repository, document(next), 1, 1);
    expect(batch.mock.calls.every((call) => call[1].length === 0)).toBe(true);
    expect(extract).toHaveBeenCalledTimes(count);
  });

  it("does not cache transient parse limits as permanent negative results", async () => {
    const { repository } = fixture();
    const oid = commitFile(repository, "caller.rb", "class User; end\nUser.new\n", "definition");
    const extract = vi
      .fn(extractRubySymbols)
      .mockResolvedValueOnce({ tags: [], partial: true, issues: ["parse-limit"] });
    const index = new GitCodeNavigation(new GitClient(), extract);
    expect((await index.definitions(repository, document(oid), 2, 1)).issues).toContain(
      "parse-limit",
    );
    expect((await index.definitions(repository, document(oid), 2, 1)).targets[0]?.preview).toBe(
      "class User; end",
    );
    expect(extract).toHaveBeenCalledTimes(2);
    index.close();
    await expect(index.definitions(repository, document(oid), 2, 1)).rejects.toMatchObject({
      code: "NAVIGATION_UNAVAILABLE",
    });
  });

  it("isolates commits and paths while reusing identical blobs across rename and copies", async () => {
    const { repository, index, extract } = fixture();
    commitFile(repository, "user.rb", "class User\nend\n", "definition");
    const first = commitFile(repository, "caller.rb", "User.new\n", "call");
    const result = await index.definitions(repository, document(first), 1, 2);
    expect(result.status).toBe("possible");
    expect(result.targets.map((target) => target.document)).toEqual([document(first, "user.rb")]);
    const parsed = extract.mock.calls.length;
    git(repository, "mv", "user.rb", "renamed.rb");
    git(repository, "commit", "-m", "rename");
    const renamed = git(repository, "rev-parse", "HEAD");
    expect(
      (await index.definitions(repository, document(renamed), 1, 2)).targets[0]?.document,
    ).toEqual(document(renamed, "renamed.rb"));
    expect(extract).toHaveBeenCalledTimes(parsed);
    const copied = commitFile(repository, "copy.rb", "class User\nend\n", "copy");
    expect(
      (await index.definitions(repository, document(copied), 1, 2)).targets.map(
        (target) => target.document.path,
      ),
    ).toEqual(["copy.rb", "renamed.rb"]);
    expect(extract).toHaveBeenCalledTimes(parsed);
    const changed = commitFile(
      repository,
      "renamed.rb",
      "class Account\nend\n",
      "change definition",
    );
    expect(
      (await index.definitions(repository, document(changed), 1, 2)).targets.map(
        (target) => target.document.path,
      ),
    ).toEqual(["copy.rb"]);
    // Dirty checkout must never be used, even when requesting a previous commit.
    writeFileSync(path.join(repository, "caller.rb"), "Account.new\n");
    expect((await index.definitions(repository, document(first), 1, 2)).targets).toEqual(
      result.targets,
    );
  });

  it("keeps ambiguous method candidates, and does not parse comments or strings as calls", async () => {
    const { repository, index } = fixture();
    commitFile(repository, "a.rb", "class A\n def save!\n end\nend\n", "a");
    commitFile(repository, "b.rb", "class B\n def save!\n end\nend\n", "b");
    const oid = commitFile(
      repository,
      "caller.rb",
      'item.save!\n# save!\n"save!"\nMissing.new\n',
      "calls",
    );
    const result = await index.definitions(repository, document(oid), 1, 7);
    expect(result.symbol).toBe("save!");
    expect(result.targets.map((target) => [target.document.path, target.line])).toEqual([
      ["a.rb", 2],
      ["b.rb", 2],
    ]);
    expect(result.partial).toBe(false);
    for (const [line, column] of [
      [2, 4],
      [3, 3],
      [4, 2],
    ]) {
      expect((await index.definitions(repository, document(oid), line!, column!)).status).toBe(
        "none",
      );
    }
    expect((await index.definitions(repository, document(oid, "README.md"), 1, 1)).status).toBe(
      "unsupported",
    );
    expect((await index.definitions(repository, document(oid, "missing.rb"), 1, 1)).status).toBe(
      "unavailable",
    );
  });

  it("extracts modules, qualified classes, constants, aliases and singleton methods with UTF-16 positions", async () => {
    const symbols = await extractRubySymbols(
      'module Admin\n class User\n  NAME = "こんにちは"\n  def self.find!; end\n  alias lookup find!\n end\nend\nAdmin::LIMIT = 5\n"😀"; Admin::User\n',
    );
    expect(symbols.partial).toBe(false);
    expect(
      symbols.tags.filter((tag) => tag.kind).map((tag) => [tag.name, tag.kind, tag.line]),
    ).toEqual([
      ["Admin", "module", 1],
      ["User", "class", 2],
      ["NAME", "constant", 3],
      ["find!", "method", 4],
      ["lookup", "method", 5],
      ["LIMIT", "constant", 8],
    ]);
    expect(symbols.tags.find((tag) => tag.name === "User" && tag.line === 9)?.column).toBe(14);
  });

  it("normalizes CRLF like the viewer and reports syntax errors and excluded large files", async () => {
    const { repository, index } = fixture();
    commitFile(repository, "broken.rb", "class Broken\n def bad(\n", "broken");
    commitFile(repository, "huge.rb", "User" + "#".repeat(1024 * 1024 + 1), "large");
    commitFile(repository, "user.rb", "class User\r\nend\r\n", "CRLF");
    const oid = commitFile(repository, "caller.rb", "# 日本語\r\nUser.new\r\n", "call");
    const result = await index.definitions(repository, document(oid), 2, 1);
    expect(result.targets.find((target) => target.name === "User")?.line).toBe(1);
    expect(result.partial).toBe(true);
    expect(result.skippedFiles).toBe(1);
  });

  it("finds definitions after many usage lines and ignores dirty attributes", async () => {
    const { repository, index } = fixture();
    commitFile(repository, "a.rb", "# User\n".repeat(1000), "many usages");
    commitFile(repository, "z:name\nwith-newline.rb", "class User; end\n", "definition");
    const oid = commitFile(repository, "caller.rb", "User.new\n", "usage");
    writeFileSync(path.join(repository, ".gitattributes"), "*.rb -diff\n");
    git(repository, "config", "color.grep", "always");
    const result = await index.definitions(repository, document(oid), 1, 1);
    expect(result.targets.map((t) => t.document.path)).toEqual(["z:name\nwith-newline.rb"]);
    expect(result.partial).toBe(false);
  });

  it("marks truncated file searches as partial instead of an exhaustive negative", async () => {
    const { repository, extract } = fixture();
    const oid = commitFile(repository, "caller.rb", "User.new\n", "usage");
    const client = new GitClient();
    vi.spyOn(client, "navigationPaths").mockResolvedValue({ paths: new Set(), truncated: true });
    const result = await new GitCodeNavigation(client, extract).definitions(
      repository,
      document(oid),
      1,
      1,
    );
    expect(result).toMatchObject({ status: "none", partial: true, issues: ["search-limit"] });
  });

  it("bounds candidates and allows retry after Git failure", async () => {
    const { repository, extract } = fixture();
    const oid = commitFile(
      repository,
      "caller.rb",
      "User.new\n" + "class User; end\n".repeat(101),
      "many",
    );
    const client = new GitClient();
    const tree = vi.spyOn(client, "tree").mockRejectedValueOnce(new Error("git unavailable"));
    const index = new GitCodeNavigation(client, extract);
    await expect(index.definitions(repository, document(oid), 1, 1)).rejects.toThrow(
      "git unavailable",
    );
    const result = await index.definitions(repository, document(oid), 1, 1);
    expect(tree).toHaveBeenCalledTimes(2);
    expect(result.targets).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });
});
