import type { GitHubPort } from "../../src/infrastructure/github/github-client.js";

function unsupported(operation: keyof GitHubPort): never {
  throw new Error(`Unexpected GitHubPort.${operation} call`);
}

export function createThrowingGitHubPort(overrides: Partial<GitHubPort> = {}): GitHubPort {
  return {
    doctor: () => unsupported("doctor"),
    getPullRequest: () => unsupported("getPullRequest"),
    getRepository: () => unsupported("getRepository"),
    getIssue: () => unsupported("getIssue"),
    getAttachment: () => unsupported("getAttachment"),
    ...overrides,
  };
}
