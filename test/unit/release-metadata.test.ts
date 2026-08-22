import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateReleaseMetadata } from "../../scripts/verify-release.js";
import { APP_VERSION } from "../../src/shared/constants.js";

const manifest = {
  name: "@a9n-shoji/rvw",
  version: "0.1.0",
  files: ["dist", "migrations", "skills", "CHANGELOG.md", "LICENSE", "README.md", "SECURITY.md"],
  publishConfig: {
    access: "public",
    registry: "https://registry.npmjs.org/",
  },
  repository: {
    type: "git",
    url: "git+https://github.com/a9n-shoji/rvw.git",
  },
  devDependencies: {
    npm: "11.19.0",
  },
};

describe("release metadata", () => {
  it("keeps the current package, app constant, and changelog aligned", () => {
    const currentManifest = JSON.parse(readFileSync("package.json", "utf8")) as typeof manifest;
    expect(() =>
      validateReleaseMetadata({
        appVersion: APP_VERSION,
        changelog: readFileSync("CHANGELOG.md", "utf8"),
        manifest: currentManifest,
        tag: `v${currentManifest.version}`,
      }),
    ).not.toThrow();
  });

  it("accepts an aligned stable release", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "0.1.0",
        changelog: "# Changelog\n\n## [0.1.0] - 2026-08-16\n",
        manifest,
        tag: "v0.1.0",
      }),
    ).not.toThrow();
  });

  it("rejects a different package scope", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "0.1.0",
        changelog: "## [0.1.0] - 2026-08-16\n",
        manifest: { ...manifest, name: "@someone-else/rvw" },
        tag: "v0.1.0",
      }),
    ).toThrow("package name");
  });

  it("rejects prereleases from the stable workflow", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "0.2.0-beta.1",
        changelog: "## [0.2.0-beta.1] - 2026-08-16\n",
        manifest: { ...manifest, version: "0.2.0-beta.1" },
        tag: "v0.2.0-beta.1",
      }),
    ).toThrow("stable semantic version");
  });

  it("rejects a release missing its changelog section", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "0.1.0",
        changelog: "# Changelog\n",
        manifest,
        tag: "v0.1.0",
      }),
    ).toThrow("CHANGELOG.md");
  });
});
