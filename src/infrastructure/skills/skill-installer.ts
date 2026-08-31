import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "../../shared/constants.js";
import { RvwError } from "../../shared/errors.js";

export type SkillPlatform = "codex" | "claude";
export type SkillName = "rvw" | "rvw-walkthrough" | "rvw-structure" | "rvw-watch-comments";

const skillNames = [
  "rvw",
  "rvw-walkthrough",
  "rvw-structure",
  "rvw-watch-comments",
] as const satisfies readonly SkillName[];
const INSTALL_METADATA_FILE = ".rvw-install.json";
const INSTALL_METADATA_SCHEMA_VERSION = 1;
const MAX_DIGEST_ENTRIES = 10_000;
const MAX_DIGEST_BYTES = 32 * 1024 * 1024;

type SkillState =
  | "not-installed"
  | "current"
  | "update-available"
  | "locally-modified"
  | "unmanaged-difference"
  | "inspection-error";

export interface SkillStatus {
  platform: SkillPlatform;
  name: SkillName;
  path: string;
  installed: boolean;
  matchesBundled: boolean;
  managed: boolean;
  locallyModified: boolean;
  updateAvailable: boolean | null;
  updateRequired: boolean;
  state: SkillState;
  inspectionError: string | null;
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
  let entriesSeen = 0;
  let bytesSeen = 0;
  const walk = (current: string, relative: string): void => {
    const entries = readdirSync(current).sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      const absolute = path.join(current, entry);
      const childRelative = path.posix.join(relative, entry);
      if (childRelative === INSTALL_METADATA_FILE) continue;
      entriesSeen += 1;
      if (entriesSeen > MAX_DIGEST_ENTRIES) {
        throw new RvwError("SKILL_CONFLICT", "Skillのentry数がinspection上限を超えています。");
      }
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        hash.update(`l\0${childRelative}\0${readlinkSync(absolute)}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`d\0${childRelative}\0`);
        walk(absolute, childRelative);
      } else if (stat.isFile()) {
        bytesSeen += stat.size;
        if (bytesSeen > MAX_DIGEST_BYTES) {
          throw new RvwError("SKILL_CONFLICT", "Skillのasset容量がinspection上限を超えています。");
        }
        hash.update(`f\0${childRelative}\0${stat.mode & 0o777}\0`);
        hash.update(readFileSync(absolute));
        hash.update("\0");
      } else {
        hash.update(`s\0${childRelative}\0${stat.mode}\0`);
      }
    }
  };
  walk(directory, "");
  return hash.digest("hex");
}

interface InstallMetadata {
  schemaVersion: 1;
  appVersion: string;
  bundledDigest: string;
}

function readInstallMetadata(destination: string): InstallMetadata | null {
  const metadataPath = path.join(destination, INSTALL_METADATA_FILE);
  try {
    if (!existsSync(metadataPath) || !lstatSync(metadataPath).isFile()) return null;
    const value = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<InstallMetadata>;
    if (
      value.schemaVersion !== INSTALL_METADATA_SCHEMA_VERSION ||
      typeof value.appVersion !== "string" ||
      typeof value.bundledDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.bundledDigest)
    ) {
      return null;
    }
    return value as InstallMetadata;
  } catch {
    return null;
  }
}

function writeInstallMetadata(destination: string, bundledDigest: string): void {
  const metadata: InstallMetadata = {
    schemaVersion: INSTALL_METADATA_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    bundledDigest,
  };
  writeFileSync(
    path.join(destination, INSTALL_METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { mode: 0o644 },
  );
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
    const bundledDigest = directoryDigest(source);
    let installedDirectory: boolean;
    try {
      installedDirectory = installed && lstatSync(destination).isDirectory();
    } catch (error) {
      return {
        platform,
        name,
        path: destination,
        installed,
        matchesBundled: false,
        managed: false,
        locallyModified: false,
        updateAvailable: null,
        updateRequired: false,
        state: "inspection-error",
        inspectionError: error instanceof Error ? error.message : String(error),
      };
    }
    if (!installedDirectory) {
      return {
        platform,
        name,
        path: destination,
        installed,
        matchesBundled: false,
        managed: false,
        locallyModified: installed,
        updateAvailable: null,
        updateRequired: false,
        state: installed ? "unmanaged-difference" : "not-installed",
        inspectionError: null,
      };
    }
    const metadata = readInstallMetadata(destination);
    let installedDigest: string;
    try {
      installedDigest = directoryDigest(destination);
    } catch (error) {
      return {
        platform,
        name,
        path: destination,
        installed: true,
        matchesBundled: false,
        managed: metadata !== null,
        locallyModified: false,
        updateAvailable: metadata === null ? null : metadata.bundledDigest !== bundledDigest,
        updateRequired: false,
        state: "inspection-error",
        inspectionError: error instanceof Error ? error.message : String(error),
      };
    }
    const matchesBundled = bundledDigest === installedDigest;
    const locallyModified =
      !matchesBundled && (metadata === null || metadata.bundledDigest !== installedDigest);
    const updateAvailable = matchesBundled
      ? false
      : metadata === null
        ? null
        : metadata.bundledDigest !== bundledDigest;
    const updateRequired =
      metadata !== null &&
      installedDigest === metadata.bundledDigest &&
      bundledDigest !== metadata.bundledDigest;
    const state: SkillState = matchesBundled
      ? "current"
      : metadata === null
        ? "unmanaged-difference"
        : locallyModified
          ? "locally-modified"
          : updateRequired
            ? "update-available"
            : "unmanaged-difference";
    return {
      platform,
      name,
      path: destination,
      installed: true,
      matchesBundled,
      managed: metadata !== null,
      locallyModified,
      updateAvailable,
      updateRequired,
      state,
      inspectionError: null,
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
    const bundledDigest = directoryDigest(source);
    if (current.matchesBundled) {
      writeInstallMetadata(destination, bundledDigest);
      return;
    }
    mkdirSync(root, { recursive: true });
    const staging = path.join(root, `.${name}.staging-${randomUUID()}`);
    const backup = path.join(root, `.${name}.backup-${randomUUID()}`);
    let hasBackup = false;
    try {
      cpSync(source, staging, { recursive: true, errorOnExist: true });
      writeInstallMetadata(staging, bundledDigest);
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
