import type { Structure } from "../../../src/domain/models.js";

export const fullStackRepositoryPaths: string[];
export const contractSemanticAnchors: Array<{
  path: string;
  startLine: number;
  endLine: number;
  needle: string;
}>;
export function validateContractStructureFixture(): void;
export function createContractStructures(input: {
  pullRequestId: string;
  baseOid: string;
  firstHead: string;
}): Structure[];
