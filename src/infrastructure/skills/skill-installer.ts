import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RvwError } from "../../shared/errors.js";

export type SkillPlatform = "codex" | "claude";
export type SkillName = "rvw" | "rvw-walkthrough";

const skillNames = ["rvw", "rvw-walkthrough"] as const satisfies readonly SkillName[];

export interface SkillStatus {
  platform: SkillPlatform;
  name: SkillName;
  path: string;
  installed: boolean;
  matchesBundled: boolean;
}

interface SkillAdapter {
  defaultRoot(): string;
}

const adapters: Record<SkillPlatform, SkillAdapter> = {
  codex: {
    defaultRoot: () => path.join(os.homedir(), ".agents", "skills"),
  },
  claude: {
    defaultRoot: () => path.join(os.homedir(), ".claude", "skills"),
  },
};

function directoryDigest(directory: string): string {
  const hash = createHash("sha256");
  const walk = (current: string, relative: string): void => {
    const entries = readdirSync(current).sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      const absolute = path.join(current, entry);
      const childRelative = path.posix.join(relative, entry);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new RvwError(
          "SKILL_CONFLICT",
          `Skill assetのsymlinkはサポートしません: ${childRelative}`,
        );
      }
      if (stat.isDirectory()) {
        hash.update(`d\0${childRelative}\0`);
        walk(absolute, childRelative);
      } else if (stat.isFile()) {
        hash.update(`f\0${childRelative}\0${stat.mode & 0o777}\0`);
        hash.update(readFileSync(absolute));
        hash.update("\0");
      }
    }
  };
  walk(directory, "");
  return hash.digest("hex");
}

function findPackageRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, ".."),
    path.resolve(moduleDirectory, "../../../"),
  ];
  const root = candidates.find((candidate) =>
    skillNames.every((name) => existsSync(path.join(candidate, "skills", name, "SKILL.md"))),
  );
  if (!root) throw new RvwError("SKILL_NOT_FOUND", "同梱Skill assetが見つかりません。");
  return root;
}

export class SkillInstaller {
  private readonly packageRoot: string;

  constructor(packageRoot?: string) {
    this.packageRoot = findPackageRoot(packageRoot);
  }

  private paths(
    platform: SkillPlatform,
    name: SkillName,
    targetRoot?: string,
  ): {
    source: string;
    root: string;
    destination: string;
  } {
    const adapter = adapters[platform];
    const root = path.resolve(targetRoot ?? adapter.defaultRoot());
    const source = path.join(this.packageRoot, "skills", name);
    if (!existsSync(path.join(source, "SKILL.md"))) {
      throw new RvwError("SKILL_NOT_FOUND", `同梱${name}が見つかりません。`);
    }
    return { source, root, destination: path.join(root, name) };
  }

  status(platform: SkillPlatform, name: SkillName, targetRoot?: string): SkillStatus {
    const { source, destination } = this.paths(platform, name, targetRoot);
    const installed = existsSync(destination);
    const installedDirectory = installed && lstatSync(destination).isDirectory();
    return {
      platform,
      name,
      path: destination,
      installed,
      matchesBundled:
        installedDirectory && directoryDigest(source) === directoryDigest(destination),
    };
  }

  statuses(platform?: SkillPlatform, targetRoot?: string): SkillStatus[] {
    if (targetRoot && !platform) {
      throw new RvwError(
        "INVALID_INPUT",
        "--targetを使う場合はcodexまたはclaudeを指定してください。",
      );
    }
    const platforms: SkillPlatform[] = platform ? [platform] : ["codex", "claude"];
    return platforms.flatMap((targetPlatform) =>
      skillNames.map((name) => this.status(targetPlatform, name, targetRoot)),
    );
  }

  install(
    platform: SkillPlatform,
    options: { force?: boolean; targetRoot?: string } = {},
  ): SkillStatus[] {
    const currentStatuses = skillNames.map((name) =>
      this.status(platform, name, options.targetRoot),
    );
    const conflicts = currentStatuses.filter(
      (status) => status.installed && !status.matchesBundled,
    );
    if (conflicts.length > 0 && !options.force) {
      throw new RvwError(
        "SKILL_CONFLICT",
        `${conflicts.map((status) => status.path).join(", ")} は同梱版と内容が異なるため--forceが必要です。`,
        {
          suggestions: [`確認後、rvw skill install ${platform} --force を実行してください。`],
        },
      );
    }

    for (const name of skillNames) this.installOne(platform, name, options);
    return skillNames.map((name) => this.status(platform, name, options.targetRoot));
  }

  private installOne(
    platform: SkillPlatform,
    name: SkillName,
    options: { force?: boolean; targetRoot?: string },
  ): void {
    const { source, root, destination } = this.paths(platform, name, options.targetRoot);
    const current = this.status(platform, name, options.targetRoot);
    if (current.matchesBundled) return;
    mkdirSync(root, { recursive: true });
    const staging = path.join(root, `.${name}.staging-${randomUUID()}`);
    const backup = path.join(root, `.${name}.backup-${randomUUID()}`);
    let hasBackup = false;
    try {
      cpSync(source, staging, { recursive: true, errorOnExist: true });
      if (existsSync(destination)) {
        renameSync(destination, backup);
        hasBackup = true;
      }
      try {
        renameSync(staging, destination);
      } catch (error) {
        if (hasBackup && !existsSync(destination)) {
          renameSync(backup, destination);
          hasBackup = false;
        }
        throw error;
      }
      if (hasBackup) {
        rmSync(backup, { recursive: true });
        hasBackup = false;
      }
    } finally {
      if (existsSync(staging)) rmSync(staging, { recursive: true });
    }
  }
}
