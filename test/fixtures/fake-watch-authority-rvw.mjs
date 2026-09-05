#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
if (args[0] !== "comment" || args[1] !== "watch-task" || args[2] !== "verify") {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: { code: "UNEXPECTED", message: args.join(" ") } })}\n`,
  );
  process.exitCode = 2;
} else {
  const database = new DatabaseSync(process.env.FAKE_WATCH_STATE);
  const value = (key) => database.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  const result = {
    ok: true,
    databaseId: value("database_id"),
    taskId: value("task_id"),
    generation: Number(value("watch_generation")),
    status: "active",
  };
  database.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
