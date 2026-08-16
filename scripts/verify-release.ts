import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_VERSION } from "../src/shared/constants.js";

const PACKAGE_NAME = "@a9n-shoji/rvw";
const RELEASE_NPM_VERSION = "11.19.0";
const repositoryRoot = path.resolve(import.meta.dirname, "..");

interface ReleaseManifest {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  files?: unknown;
  publishConfig?: unknown;
  repository?: unknown;
  devDependencies?: unknown;
}

interface ReleaseMetadata {
  appVersion: string;
  changelog: string;
  manifest: ReleaseManifest;
  tag: string;
}

function requireRelease(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function validateReleaseMetadata({
  appVersion,
  changelog,
  manifest,
  tag,
}: ReleaseMetadata): { name: string; version: string } {
  requireRelease(manifest.name === PACKAGE_NAME, `package name must be ${PACKAGE_NAME}`);
  requireRelease(
    typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/u.test(manifest.version),
    "package version must be a stable semantic version",
  );
  requireRelease(tag === `v${manifest.version}`, `release tag must be v${manifest.version}`);
  requireRelease(appVersion === manifest.version, "APP_VERSION must match package version");
  requireRelease(manifest.private !== true, "release package must not be private");

  const repository = manifest.repository as Record<string, unknown> | undefined;
  requireRelease(repository?.type === "git", "package repository type must be git");
  requireRelease(
    repository.url === "git+https://github.com/a9n-shoji/rvw.git",
    "package repository must match the Trusted Publisher repository",
  );

  const publishConfig = manifest.publishConfig as Record<string, unknown> | undefined;
  requireRelease(publishConfig?.access === "public", "publishConfig.access must be public");
  requireRelease(
    publishConfig.registry === "https://registry.npmjs.org/",
    "publishConfig.registry must be the public npm registry",
  );

  requireRelease(Array.isArray(manifest.files), "package files allowlist is required");
  for (const required of [
    "dist",
    "migrations",
    "skills",
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
  ]) {
    requireRelease(manifest.files.includes(required), `package files must include ${required}`);
  }

  const devDependencies = manifest.devDependencies as Record<string, unknown> | undefined;
  requireRelease(
    devDependencies?.npm === RELEASE_NPM_VERSION,
    `release npm CLI must be pinned to ${RELEASE_NPM_VERSION}`,
  );
  requireRelease(
    new RegExp(
      `^## \\[${manifest.version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`,
      "mu",
    ).test(changelog),
    `CHANGELOG.md must contain a dated ${manifest.version} section`,
  );
  return { name: manifest.name, version: manifest.version };
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function main(): void {
  const tag = process.env.RVW_RELEASE_TAG;
  requireRelease(tag, "RVW_RELEASE_TAG is required");
  const manifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as ReleaseManifest;
  const release = validateReleaseMetadata({
    appVersion: APP_VERSION,
    changelog: readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8"),
    manifest,
    tag,
  });

  const headOid = git("rev-parse", "HEAD");
  const tagOid = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
  requireRelease(headOid === tagOid, `${tag} must point to the checked-out commit`);
  git("merge-base", "--is-ancestor", headOid, "origin/main");
  requireRelease(git("status", "--short") === "", "release checkout must be clean");
  process.stdout.write(`Release metadata verified: ${release.name}@${release.version}\n`);
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (import.meta.url === entrypoint) main();
