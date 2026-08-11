import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
    path: "skills/rvw-walkthrough/SKILL.md",
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
});
