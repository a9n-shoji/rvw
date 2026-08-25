import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function configureTestGitRepository(repository: string): void {
  git(repository, "config", "user.name", "rvw test");
  git(repository, "config", "user.email", "rvw@example.test");
  git(repository, "config", "core.autocrlf", "false");
}

export function createGitRepository(prefix = "rvw-test-"): string {
  const repository = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repository, "init", "-b", "main");
  configureTestGitRepository(repository);
  git(repository, "remote", "add", "origin", "https://github.com/acme/review-repo.git");
  writeFileSync(path.join(repository, "README.md"), "# Fixture\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "base");
  return repository;
}

export function commitFile(
  repository: string,
  file: string,
  contents: string,
  message: string,
): string {
  writeFileSync(path.join(repository, file), contents);
  git(repository, "add", "--", file);
  git(repository, "commit", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}
