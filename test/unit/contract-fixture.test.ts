import { describe, expect, it } from "vitest";
import {
  contractRepositoryPaths,
  contractRepositoryText,
} from "../fixtures/contract/contract-repository.mjs";
import { validateContractStructureFixture } from "../fixtures/contract/contract-structures.mjs";

describe("contract fixture integrity", () => {
  it("keeps semantic structure anchors and relative imports valid", () => {
    expect(() => validateContractStructureFixture()).not.toThrow();
    expect(contractRepositoryPaths).toContain("src/edge-only-evidence.ts");
    expect(contractRepositoryText("src/edge-only-evidence.ts")).toContain(
      "export const edgeOnlyEvidence",
    );
    expect(() => contractRepositoryText("src/not-declared.ts")).toThrow(
      "unknown contract repository path",
    );
  });
});
