import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const npmCli = path.join(path.dirname(require.resolve("npm/package.json")), "bin", "npm-cli.js");
const pnpmCli = process.env.npm_execpath;
assert.ok(pnpmCli, "package smoke must run through a pnpm lifecycle script");
const packageJsonSchema = z.object({
  name: z.string(),
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
});
const packOutputSchema = z.object({
  name: z.string(),
  version: z.string(),
  filename: z.string(),
  files: z.array(z.object({ path: z.string() })),
});
const protocolSchema = z.object({
  appVersion: z.string(),
  protocolVersion: z.number().int(),
});
const doctorSchema = z.object({
  ok: z.boolean(),
  databasePath: z.string(),
  git: z.object({ repository: z.unknown().nullable() }),
  github: z.object({ version: z.string(), authenticated: z.boolean() }),
});
const skillInstallSchema = z.object({
  skills: z.array(
    z.object({
      name: z.string(),
      matchesBundled: z.boolean(),
    }),
  ),
});
const watchStateInitSchema = z.object({
  ok: z.literal(true),
  ownPullRequests: z.literal("investigate-and-reply"),
});
const packageJson = packageJsonSchema.parse(
  JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")),
);
const maxTarballBytes = 6 * 1024 * 1024;
const maxUnpackedBytes = 25 * 1024 * 1024;

function requestedPackDirectory() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--pack-destination") {
    throw new Error("Usage: pnpm test:package -- --pack-destination <empty-directory>");
  }
  const value = args[1];
  if (!value) throw new Error("--pack-destination requires a directory");
  const directory = path.resolve(value);
  mkdirSync(directory, { recursive: true });
  assert.deepEqual(readdirSync(directory), [], `pack destination must be empty: ${directory}`);
  return directory;
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} [options]
 * @param {number[]} [allowedExitCodes]
 */
function run(executable, args, options = {}, allowedExitCodes = []) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error || (result.status !== 0 && !allowedExitCodes.includes(result.status ?? -1))) {
    throw new Error(
      [
        `Command failed: ${executable} ${args.join(" ")}`,
        result.error?.message,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

/**
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} [options]
 */
function runNpm(args, options = {}) {
  // Exercise npm's consumer-facing global install behavior.
  return run(process.execPath, [npmCli, ...args], options);
}

/**
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} [options]
 */
function runPnpm(args, options = {}) {
  return run(process.execPath, [pnpmCli, ...args], options);
}

/**
 * @template T
 * @param {string} output
 * @param {import("zod").ZodType<T>} schema
 * @param {string} label
 * @returns {T}
 */
function parseJson(output, schema, label) {
  const starts = [0];
  for (let index = 0; index < output.length; index += 1) {
    if ((output[index] === "{" || output[index] === "[") && output[index - 1] === "\n") {
      starts.push(index);
    }
  }
  for (const start of starts.reverse()) {
    try {
      return schema.parse(JSON.parse(output.slice(start)));
    } catch {
      // npm lifecycle output can precede the final --json payload.
    }
  }
  throw new Error(`${label} did not return valid JSON`);
}

/** @param {string} directory */
function createFakeGitHubCli(directory) {
  mkdirSync(directory, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(
      path.join(directory, "gh.cmd"),
      [
        "@echo off",
        'if "%1"=="--version" echo gh version 0.0.0-package-smoke& exit /b 0',
        'if "%1"=="auth" exit /b 0',
        "exit /b 2",
        "",
      ].join("\r\n"),
    );
    return;
  }
  const executable = path.join(directory, "gh");
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "gh version 0.0.0-package-smoke"',
      "  exit 0",
      "fi",
      'if [ "$1" = "auth" ]; then exit 0; fi',
      "exit 2",
      "",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
}

/** @param {string} prefix */
function executablePath(prefix) {
  const name = process.platform === "win32" ? "rvw.cmd" : "rvw";
  return path.join(prefix, process.platform === "win32" ? "" : "bin", name);
}

/** @param {string} tarball */
function unpackedTarBytes(tarball) {
  const archive = gunzipSync(readFileSync(tarball));
  let offset = 0;
  let total = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeField = header.subarray(124, 136);
    assert.equal(sizeField[0] & 0x80, 0, "tar entry uses unsupported base-256 size");
    const octalSize = sizeField.toString("ascii").replace(/\0.*$/u, "").trim();
    const size = octalSize === "" ? 0 : Number.parseInt(octalSize, 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0, "tar entry has invalid size");
    const type = String.fromCharCode(header[156]);
    if (type === "\0" || type === "0" || type === "7") total += size;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return total;
}

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "rvw-package-smoke-"));
try {
  const retainedPackDirectory = requestedPackDirectory();
  const packDirectory = retainedPackDirectory ?? path.join(temporaryRoot, "pack");
  const installPrefix = path.join(temporaryRoot, "global");
  const workingDirectory = path.join(temporaryRoot, "working");
  const npmCache = path.join(temporaryRoot, "npm-cache");
  if (!retainedPackDirectory) mkdirSync(packDirectory);
  mkdirSync(installPrefix);
  mkdirSync(workingDirectory);

  const pack = parseJson(
    runPnpm(["pack", "--json", "--pack-destination", packDirectory], { cwd: repositoryRoot }),
    packOutputSchema,
    "pnpm pack",
  );
  assert.equal(pack.name, packageJson.name);
  assert.equal(pack.version, packageJson.version);
  const tarball = path.isAbsolute(pack.filename)
    ? pack.filename
    : path.join(packDirectory, pack.filename);
  assert.equal(path.dirname(tarball), packDirectory);
  const packedBytes = statSync(tarball).size;
  const unpackedBytes = unpackedTarBytes(tarball);
  assert.ok(packedBytes <= maxTarballBytes, `tarball is too large: ${packedBytes} bytes`);
  assert.ok(
    unpackedBytes <= maxUnpackedBytes,
    `unpacked package is too large: ${unpackedBytes} bytes`,
  );

  const packedFiles = new Set(pack.files.map((file) => file.path));
  const requiredFiles = [
    "LICENSE",
    "CHANGELOG.md",
    "README.md",
    "SECURITY.md",
    "package.json",
    "dist/cli.mjs",
    "dist/cli.mjs.map",
    "dist/cli-THIRD_PARTY_NOTICES.txt",
    "dist/web/index.html",
    "dist/web/THIRD_PARTY_NOTICES.txt",
    "skills/rvw/SKILL.md",
    "skills/rvw/agents/openai.yaml",
    "skills/rvw-walkthrough/SKILL.md",
    "skills/rvw-walkthrough/agents/openai.yaml",
    "skills/rvw-walkthrough/references/walkthrough-authoring.md",
    "skills/rvw-watch-comments/SKILL.md",
    "skills/rvw-watch-comments/agents/openai.yaml",
    "skills/rvw-watch-comments/scripts/auto-ack.mjs",
    "skills/rvw-watch-comments/scripts/complete-repository.mjs",
    "skills/rvw-watch-comments/scripts/preflight.mjs",
    "skills/rvw-watch-comments/scripts/rvw-command.mjs",
    "skills/rvw-watch-comments/scripts/watch-driver.mjs",
    "skills/rvw-watch-comments/scripts/watch-state.mjs",
    ...readdirSync(path.join(repositoryRoot, "migrations"))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .map((name) => `migrations/${name}`),
  ];
  for (const required of requiredFiles) {
    assert.ok(packedFiles.has(required), `package is missing ${required}`);
  }
  assert.ok(
    [...packedFiles].some((name) => name.startsWith("dist/web/assets/")),
    "package is missing bundled web assets",
  );
  const allowed = ["CHANGELOG.md", "LICENSE", "README.md", "SECURITY.md", "package.json"];
  for (const file of packedFiles) {
    assert.ok(
      allowed.includes(file) ||
        file.startsWith("dist/") ||
        file.startsWith("migrations/") ||
        file.startsWith("skills/"),
      `unexpected package file: ${file}`,
    );
  }

  runNpm(
    [
      "install",
      "--global",
      "--prefix",
      installPrefix,
      "--offline",
      "--no-audit",
      "--no-fund",
      "--cache",
      npmCache,
      tarball,
    ],
    { cwd: workingDirectory },
  );
  const installedPackageRoot = path.join(
    runNpm(["root", "--global", "--prefix", installPrefix]),
    packageJson.name,
  );
  const installedPackageJson = packageJsonSchema.parse(
    JSON.parse(readFileSync(path.join(installedPackageRoot, "package.json"), "utf8")),
  );
  assert.deepEqual(installedPackageJson.dependencies ?? {}, {});
  assert.equal(
    existsSync(path.join(installedPackageRoot, "node_modules")),
    false,
    "installed package unexpectedly contains a runtime dependency tree",
  );
  const installedCli = path.join(installedPackageRoot, "dist", "cli.mjs");
  assert.ok(existsSync(installedCli));
  if (process.platform !== "win32") {
    assert.notEqual(statSync(installedCli).mode & 0o111, 0, "installed CLI is not executable");
  }

  const bin = executablePath(installPrefix);
  const help = run(bin, ["--help"], {
    cwd: workingDirectory,
    ...(process.platform === "win32" ? { shell: true } : {}),
  });
  assert.match(help, /Usage: rvw/);
  assert.equal(
    run(bin, ["--version"], {
      cwd: workingDirectory,
      ...(process.platform === "win32" ? { shell: true } : {}),
    }),
    packageJson.version,
  );
  const protocol = parseJson(
    run(bin, ["protocol", "--json"], {
      cwd: workingDirectory,
      ...(process.platform === "win32" ? { shell: true } : {}),
    }),
    protocolSchema,
    "rvw protocol",
  );
  assert.equal(protocol.appVersion, packageJson.version);
  assert.ok(Number.isInteger(protocol.protocolVersion));

  const fakeBin = path.join(temporaryRoot, "fake-bin");
  if (process.platform !== "win32") createFakeGitHubCli(fakeBin);
  const repository = path.join(temporaryRoot, "review-repository");
  mkdirSync(repository);
  run("git", ["init", "--quiet"], { cwd: repository });
  const databasePath = path.join(temporaryRoot, "data", "rvw.db");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const doctorEnvironment = {
    ...process.env,
    RVW_DATABASE_PATH: databasePath,
  };
  if (process.platform !== "win32") {
    doctorEnvironment[pathKey] = `${fakeBin}${path.delimiter}${process.env[pathKey] ?? ""}`;
  }
  const doctor = parseJson(
    run(
      bin,
      ["doctor", "--json"],
      {
        cwd: repository,
        env: doctorEnvironment,
        ...(process.platform === "win32" ? { shell: true } : {}),
      },
      process.platform === "win32" ? [2] : [],
    ),
    doctorSchema,
    "rvw doctor",
  );
  assert.equal(doctor.ok, doctor.github.authenticated);
  assert.match(doctor.github.version, /^gh version /);
  assert.equal(doctor.databasePath, databasePath);
  assert.ok(doctor.git.repository);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const migrationState = database
    .prepare("SELECT count(*) AS count, max(version) AS latest FROM schema_migrations")
    .get();
  database.close();
  const expectedMigrationCount = requiredFiles.filter((name) =>
    name.startsWith("migrations/"),
  ).length;
  assert.equal(Number(migrationState.count), expectedMigrationCount);
  assert.equal(Number(migrationState.latest), expectedMigrationCount);

  const skillRoot = path.join(temporaryRoot, "skills");
  const installedSkills = parseJson(
    run(bin, ["skill", "install", "codex", "--target", skillRoot, "--json"], {
      cwd: workingDirectory,
      ...(process.platform === "win32" ? { shell: true } : {}),
    }),
    skillInstallSchema,
    "rvw skill install",
  );
  assert.deepEqual(
    installedSkills.skills.map((skill) => skill.name),
    ["rvw", "rvw-walkthrough", "rvw-watch-comments"],
  );
  assert.ok(installedSkills.skills.every((skill) => skill.matchesBundled));
  const installedWatchState = path.join(
    skillRoot,
    "rvw-watch-comments",
    "scripts",
    "watch-state.mjs",
  );
  const watchTaskState = path.join(temporaryRoot, "watch-task", "state.db");
  const initializedWatchState = parseJson(
    run(process.execPath, [installedWatchState, "init", "--state", watchTaskState]),
    watchStateInitSchema,
    "rvw-watch-comments state init",
  );
  assert.equal(initializedWatchState.ok, true);
  assert.equal(initializedWatchState.ownPullRequests, "investigate-and-reply");

  process.stdout.write(
    `Package smoke passed: ${pack.files.length} files, ${packedBytes} bytes packed, ${unpackedBytes} bytes unpacked.\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
