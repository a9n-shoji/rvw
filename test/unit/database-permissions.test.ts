import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSecureExistingPath,
  RvwDatabase,
  secureNewPath,
} from "../../src/infrastructure/db/database.js";
import { RvwError } from "../../src/shared/errors.js";

describe("database permissions", () => {
  const originalDatabasePath = process.env.RVW_DATABASE_PATH;

  afterEach(() => {
    if (originalDatabasePath === undefined) delete process.env.RVW_DATABASE_PATH;
    else process.env.RVW_DATABASE_PATH = originalDatabasePath;
  });

  it("continues after chmod EPERM only when the resulting mode and owner are already safe", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-db-permissions-"));
    const filePath = path.join(directory, "rvw.db");
    writeFileSync(filePath, "");
    chmodSync(filePath, 0o600);
    const rejectChmod = (): never => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    };

    expect(() => secureNewPath(filePath, 0o600, "DB file", rejectChmod)).not.toThrow();
    expect(() => assertSecureExistingPath(filePath, 0o600, "DB file")).not.toThrow();

    chmodSync(filePath, 0o644);
    let rejected: RvwError | null = null;
    try {
      secureNewPath(filePath, 0o600, "DB file", rejectChmod);
    } catch (error) {
      if (!(error instanceof RvwError)) throw error;
      rejected = error;
    }
    expect(rejected?.code).toBe("DATABASE_ERROR");
    expect(rejected?.details).toMatchObject({ mode: "0644", expectedMode: "0600" });
  });

  it("leaves an explicitly managed RVW_DATABASE_PATH unchanged", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "rvw-explicit-db-"));
    chmodSync(directory, 0o755);
    const filePath = path.join(directory, "explicit.db");
    writeFileSync(filePath, "");
    chmodSync(filePath, 0o644);
    process.env.RVW_DATABASE_PATH = filePath;

    const database = new RvwDatabase({ migrationsDirectory: "./migrations" });
    expect(database.permissionStatus()).toMatchObject({
      managedByRvw: false,
      directory: { mode: "0755", expectedMode: "0700", safe: false },
      file: { mode: "0644", expectedMode: "0600", safe: false },
    });
    expect(database.permissionStatus().warning).toContain("chmodしません");
    database.close();

    expect(statSync(directory).mode & 0o777).toBe(0o755);
    expect(statSync(filePath).mode & 0o777).toBe(0o644);
  });

  it("creates a missing configured directory and file securely without a repair chmod", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "rvw-explicit-new-db-"));
    const directory = path.join(parent, "private");
    const filePath = path.join(directory, "explicit.db");
    process.env.RVW_DATABASE_PATH = filePath;

    const database = new RvwDatabase({ migrationsDirectory: "./migrations" });
    expect(database.permissionStatus()).toMatchObject({
      managedByRvw: false,
      directory: { mode: "0700", safe: true },
      file: { mode: "0600", safe: true },
      warning: null,
    });
    database.close();
  });
});
