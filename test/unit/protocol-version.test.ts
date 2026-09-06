import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StructureAuthoringWarning } from "../../src/domain/structure-projection.js";
import { PROTOCOL_VERSION } from "../../src/shared/constants.js";

const contractFiles = [
  {
    path: "docs/implementation-spec.md",
    pattern: (version: number) => `protocol versionは${version}とし`,
  },
  {
    path: "docs/cli-protocol.md",
    pattern: (version: number) => `# CLI protocol v${version}`,
  },
  {
    path: "skills/rvw/SKILL.md",
    pattern: (version: number) => `Require \`protocolVersion\` ${version}`,
  },
  {
    path: "skills/rvw-review-compose/SKILL.md",
    pattern: (version: number) => `Require \`protocolVersion\` ${version}`,
  },
  {
    path: "skills/rvw-walkthrough/SKILL.md",
    pattern: (version: number) => `Require \`protocolVersion\` ${version}`,
  },
  {
    path: "skills/rvw-structure/SKILL.md",
    pattern: (version: number) => `Require \`protocolVersion\` ${version}`,
  },
  {
    path: "skills/rvw-watch-comments/SKILL.md",
    pattern: (version: number) => `Require \`protocolVersion\` ${version}`,
  },
];

describe("protocol version contract", () => {
  it.each(contractFiles)(
    "keeps $path aligned with the executable protocol",
    ({ path, pattern }) => {
      expect(readFileSync(path, "utf8")).toContain(pattern(PROTOCOL_VERSION));
    },
  );

  it("documents every current Structure warning code and additive unknown-code handling", () => {
    const protocol = readFileSync("docs/cli-protocol.md", "utf8");
    const warningCodes: StructureAuthoringWarning["code"][] = [
      "STRUCTURE_ORIGIN_NO_OUTGOING_DIRECTIONAL_RELATION",
      "STRUCTURE_LAYOUT_MAX_ROWS_HIGH",
      "STRUCTURE_LAYOUT_NON_FORWARD_DIRECTIONAL_LINK_RATIO_HIGH",
    ];
    for (const code of warningCodes) expect(protocol).toContain(code);
    expect(protocol).toContain(
      "Consumers branch on `code`, never on the display-oriented `message`",
    );
    expect(protocol).toContain("ignore unknown warning");
  });

  it("documents the complete additive watch-ownership capability", () => {
    const protocol = readFileSync("docs/cli-protocol.md", "utf8");
    expect(protocol).toContain("comment.watchOwnership");
  });

  it("keeps Structure protocol terminology on origin rather than removed focus input", () => {
    const specification = readFileSync("docs/implementation-spec.md", "utf8");
    const lifecycle = specification.slice(
      specification.indexOf("### 7.5 Structure lifecycle"),
      specification.indexOf("### 7.6 JSON transport contract"),
    );
    const errorPolicy = specification.slice(
      specification.indexOf("## 13. Error方針"),
      specification.indexOf("## 14. テスト"),
    );

    expect(lifecycle).toContain("`originNodeId`、anchor総数");
    expect(lifecycle).not.toContain("focus、anchor総数");
    expect(errorPolicy).toContain("endpoint / origin / presentation");
    expect(errorPolicy).not.toContain("presentation / focus / source anchor");
  });

  it("documents primaryBackbone as required nullable version-5 content", () => {
    const protocol = readFileSync("docs/cli-protocol.md", "utf8");
    expect(protocol).toMatch(/required nullable\s+`primaryBackbone`/);
    expect(protocol).not.toMatch(/an optional\s+`primaryBackbone`/);
  });
});
