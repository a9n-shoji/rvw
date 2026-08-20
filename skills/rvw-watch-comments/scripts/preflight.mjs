#!/usr/bin/env node

import { runRvw } from "./rvw-command.mjs";

const REQUIRED_NODE = [24, 15, 0];
const REQUIRED_PROTOCOL = 3;
const REQUIRED_CAPABILITIES = [
  "agent.transport",
  "comment.watch",
  "comment.read",
  "comment.reply",
  "comment.edit",
  "comment.codeReferences",
  "pullRequest.sync",
];

function nodeIsSupported(version) {
  const actual = version.split(".").map(Number);
  for (let index = 0; index < REQUIRED_NODE.length; index += 1) {
    if ((actual[index] ?? 0) > REQUIRED_NODE[index]) return true;
    if ((actual[index] ?? 0) < REQUIRED_NODE[index]) return false;
  }
  return true;
}

function commandSummary(result) {
  return {
    exitCode: result.code,
    signal: result.signal,
    output: result.json,
    ...(result.stderr.trim() ? { stderr: result.stderr.trim() } : {}),
    ...(!result.json && result.stdout.trim() ? { stdout: result.stdout.trim() } : {}),
  };
}

async function main() {
  const settled = await Promise.allSettled([
    runRvw(["protocol", "--json"]),
    runRvw(["agent", "status", "--json"]),
    runRvw(["agent", "ping", "--json"]),
  ]);
  const [protocolResult, statusResult, pingResult] = settled.map((result) =>
    result.status === "fulfilled" ? result.value : null,
  );
  const protocol = protocolResult?.json;
  const agentStatus = statusResult?.json;
  const agentPing = pingResult?.json;
  const capabilities = Array.isArray(protocol?.capabilities) ? protocol.capabilities : [];
  const missingCapabilities = REQUIRED_CAPABILITIES.filter(
    (capability) => !capabilities.includes(capability),
  );
  const checks = {
    nodeVersion: nodeIsSupported(process.versions.node),
    rvwBinary: protocolResult !== null,
    appVersion: typeof protocol?.appVersion === "string" && protocol.appVersion.length > 0,
    protocol: protocol?.protocolVersion === REQUIRED_PROTOCOL,
    capabilities: missingCapabilities.length === 0,
    agentStatus: agentStatus?.ok === true && agentStatus.selectedTransport !== "unavailable",
    agentPingInspected: agentPing !== null && typeof agentPing === "object",
    agentPingConnected: agentPing?.ok === true && agentPing.connected === true,
  };
  const ok =
    checks.nodeVersion &&
    checks.rvwBinary &&
    checks.appVersion &&
    checks.protocol &&
    checks.capabilities &&
    checks.agentStatus &&
    checks.agentPingInspected;
  const output = {
    ok,
    node: {
      version: process.versions.node,
      required: ">=24.15.0",
      ok: checks.nodeVersion,
    },
    rvw: {
      binary: protocolResult?.binary ?? process.env.RVW_BIN ?? "rvw",
      appVersion: typeof protocol?.appVersion === "string" ? protocol.appVersion : null,
      protocolVersion:
        typeof protocol?.protocolVersion === "number" ? protocol.protocolVersion : null,
      requiredProtocolVersion: REQUIRED_PROTOCOL,
      capabilities,
      requiredCapabilities: REQUIRED_CAPABILITIES,
      missingCapabilities,
    },
    agent: {
      status: statusResult ? commandSummary(statusResult) : null,
      ping: pingResult ? commandSummary(pingResult) : null,
      pingRequired: false,
    },
    checks,
    errors: settled.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            {
              command: ["protocol", "agent status", "agent ping"][index],
              error: String(result.reason),
            },
          ]
        : [],
    ),
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!ok) process.exitCode = 1;
}

await main();
