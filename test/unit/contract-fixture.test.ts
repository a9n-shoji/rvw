import { describe, expect, it } from "vitest";
import { validateContractStructureFixture } from "../fixtures/contract/contract-structures.mjs";

describe("contract fixture integrity", () => {
  it("keeps semantic structure anchors and relative imports valid", () => {
    expect(() => validateContractStructureFixture()).not.toThrow();
  });
});
