import open from "open";

const host = "127.0.0.1";
const port = Number(process.env.RVW_DEMO_PORT ?? 43118);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("RVW_DEMO_PORT must be an integer from 1 to 65535");
}

process.env.RVW_E2E_PORT = String(port);
process.env.RVW_FIXTURE_SCENARIO = "dogfood";

await import("../test/e2e/fixture-server.mjs");

const url = `http://${host}:${port}/?pullRequestId=22222222-2222-4222-8222-222222222222`;
process.stderr.write(`rvw dogfood demo (current checkout history): ${url}\n`);
if (!process.argv.includes("--no-open")) await open(url);
