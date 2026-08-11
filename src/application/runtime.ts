import { RvwDatabase, type DatabaseOptions } from "../infrastructure/db/database.js";
import { GitClient } from "../infrastructure/git/git-client.js";
import { GitHubClient, type GitHubPort } from "../infrastructure/github/github-client.js";
import { RvwService } from "./rvw-service.js";

export interface Runtime {
  database: RvwDatabase;
  git: GitClient;
  github: GitHubPort;
  service: RvwService;
  close(): void;
}

export function createRuntime(
  options: {
    database?: DatabaseOptions;
    github?: GitHubPort;
    git?: GitClient;
  } = {},
): Runtime {
  const database = new RvwDatabase(options.database);
  const git = options.git ?? new GitClient();
  const github = options.github ?? new GitHubClient();
  const service = new RvwService(database, git, github);
  return { database, git, github, service, close: () => database.close() };
}
