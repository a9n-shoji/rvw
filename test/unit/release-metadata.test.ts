import { describe, expect, it } from "vitest";
import { validateReleaseMetadata } from "../../scripts/verify-release.js";

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
  it("accepts an aligned stable release", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "0.1.0",
        changelog: "# Changelog\n\n## [0.1.0] - 2026-08-16\n",
        manifest,
        npmTag: "latest",
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
        npmTag: "latest",
        tag: "v0.1.0",
      }),
    ).toThrow("package name");
  });

  it("accepts a beta release with the beta dist-tag", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "0.2.0-beta.1",
        changelog: "## [0.2.0-beta.1] - 2026-08-16\n",
        manifest: { ...manifest, version: "0.2.0-beta.1" },
        npmTag: "beta",
        tag: "v0.2.0-beta.1",
      }),
    ).not.toThrow();
  });

  it("rejects publishing a beta release with the latest dist-tag", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "0.2.0-beta.1",
        changelog: "## [0.2.0-beta.1] - 2026-08-16\n",
        manifest: { ...manifest, version: "0.2.0-beta.1" },
        npmTag: "latest",
        tag: "v0.2.0-beta.1",
      }),
    ).toThrow("beta npm dist-tag");
  });

  it("rejects publishing a stable release with the beta dist-tag", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "0.1.0",
        changelog: "## [0.1.0] - 2026-08-16\n",
        manifest,
        npmTag: "beta",
        tag: "v0.1.0",
      }),
    ).toThrow("latest npm dist-tag");
  });

  it("rejects an unsupported prerelease channel", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "0.2.0-rc.0",
        changelog: "## [0.2.0-rc.0] - 2026-08-16\n",
        manifest: { ...manifest, version: "0.2.0-rc.0" },
        npmTag: "beta",
        tag: "v0.2.0-rc.0",
      }),
    ).toThrow("stable or beta semantic version");
  });

  it("rejects a release missing its changelog section", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "0.1.0",
        changelog: "# Changelog\n",
        manifest,
        npmTag: "latest",
        tag: "v0.1.0",
      }),
    ).toThrow("CHANGELOG.md");
  });
});
