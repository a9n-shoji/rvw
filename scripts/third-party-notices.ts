import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const legalDocumentPattern = /^(?:licen[cs]e|copying|notice)(?:\..*)?$/i;

export interface BundledPackageNotice {
  name: string;
  version: string;
  license: string;
  repository: string | null;
  documents: { name: string; body: string }[];
}

function packageRootForModule(moduleId: string): string | null {
  const cleanId = moduleId.replace(/^\0+/, "").split("?", 1)[0];
  if (!cleanId) return null;
  const absoluteId = path.isAbsolute(cleanId) ? cleanId : path.resolve(repositoryRoot, cleanId);
  if (!absoluteId.includes(`${path.sep}node_modules${path.sep}`)) return null;
  let current = path.dirname(absoluteId);
  while (current !== path.dirname(current)) {
    const manifest = path.join(current, "package.json");
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (metadata.name && metadata.version) return current;
    }
    current = path.dirname(current);
  }
  return null;
}

function repositoryUrl(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "url" in value && typeof value.url === "string") {
    return value.url;
  }
  return null;
}

function noticeForPackage(packageRoot: string): BundledPackageNotice {
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    license?: string;
    repository?: unknown;
  };
  if (!packageJson.name || !packageJson.version) {
    throw new Error(`Bundled dependency metadata is incomplete: ${packageRoot}`);
  }
  const documents = readdirSync(packageRoot)
    .filter((name) => legalDocumentPattern.test(name))
    .filter((name) => statSync(path.join(packageRoot, name)).isFile())
    .sort()
    .map((name) => ({ name, body: readFileSync(path.join(packageRoot, name), "utf8").trim() }));
  if (documents.length === 0) {
    const override = path.join(
      repositoryRoot,
      "third-party-licenses",
      `${packageJson.name.replaceAll("/", "__")}-LICENSE.txt`,
    );
    if (!existsSync(override)) {
      throw new Error(
        `Bundled dependency ${packageJson.name}@${packageJson.version} has no license document`,
      );
    }
    documents.push({ name: path.basename(override), body: readFileSync(override, "utf8").trim() });
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license ?? "See included license document",
    repository: repositoryUrl(packageJson.repository),
    documents,
  };
}

export function bundledPackageNotices(moduleIds: Iterable<string>): BundledPackageNotice[] {
  const roots = new Set<string>();
  for (const moduleId of moduleIds) {
    const packageRoot = packageRootForModule(moduleId);
    if (packageRoot) roots.add(packageRoot);
  }
  return [...roots]
    .map(noticeForPackage)
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    );
}

export function renderThirdPartyNotices(
  notices: BundledPackageNotice[],
  bundleName: string,
): string {
  const sections = notices.map((notice) => {
    const metadata = [
      `${notice.name}@${notice.version}`,
      `Declared license: ${notice.license}`,
      ...(notice.repository ? [`Source: ${notice.repository}`] : []),
    ].join("\n");
    const documents = notice.documents
      .map((document) => `--- ${document.name} ---\n${document.body}`)
      .join("\n\n");
    return `${metadata}\n\n${documents}`;
  });
  return [
    "THIRD-PARTY SOFTWARE NOTICES",
    "",
    `The rvw ${bundleName} contains code from the packages listed below. These notices are`,
    "provided for attribution and license compliance; they do not change rvw's MIT license.",
    "",
    ...sections.flatMap((section) => ["=".repeat(80), section, ""]),
  ].join("\n");
}
