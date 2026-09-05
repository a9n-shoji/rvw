#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
if (args[0] !== "comment" || args[1] !== "watch-task") {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: { code: "UNEXPECTED", message: args.join(" ") } })}\n`,
  );
  process.exitCode = 2;
} else {
  const database = new DatabaseSync(process.env.FAKE_WATCH_STATE);
  const value = (key) => database.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  const option = (name) => args[args.indexOf(name) + 1];
  const base = {
    ok: true,
    databaseId: value("database_id"),
    taskId: option("--task-id") ?? value("task_id"),
    generation: Number(option("--generation") ?? value("watch_generation")),
  };
  const result =
    args[2] === "verify"
      ? { ...base, status: "active" }
      : args[2] === "reserve-write"
        ? {
            ...base,
            leaseId: option("--lease-id"),
            writeKey: option("--write-key"),
            status: "reserved",
          }
        : args[2] === "release-write"
          ? { ...base, leaseId: option("--lease-id"), writeKey: null, status: "absent" }
          : { ok: false, error: { code: "UNEXPECTED", message: args.join(" ") } };
  database.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ok === false) process.exitCode = 2;
}
