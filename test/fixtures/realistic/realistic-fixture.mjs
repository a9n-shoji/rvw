import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkthroughRepositorySources } from "../../e2e/walkthrough-fixture.mjs";

export const realisticPullRequestId = "22222222-2222-4222-8222-222222222222";
const maximumDocumentBytes = 1024 * 1024;
const fixtureEpoch = Date.parse("2026-07-14T09:00:00.000Z");

const backgroundContexts = [
  "catalog",
  "customers",
  "fulfillment",
  "inventory",
  "notifications",
  "returns",
  "shipping",
];
const backgroundCapabilities = [
  "commands",
  "events",
  "model",
  "policy",
  "ports",
  "queries",
  "repository",
  "service",
  "telemetry",
  "types",
  "validation",
  "worker",
];

const baseFiles = () => {
  const files = {
    "README.md": [
      "# Acme commerce service",
      "",
      "The service owns catalog, customer, inventory, order, payment, and fulfillment workflows.",
      "",
      "Order submission currently retries at the HTTP client without a durable idempotency record.",
      "Payment cleanup is performed by a legacy best-effort worker.",
      "",
    ].join("\n"),
    "package.json": `${JSON.stringify(
      {
        name: "@acme/commerce-service",
        private: true,
        type: "module",
        scripts: { test: "vitest run", start: "node dist/server.js" },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": `${JSON.stringify(
      { compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" } },
      null,
      2,
    )}\n`,
    "src/application/orders/retry-policy.ts": [
      "/** Identifies one durable create-order operation across repeated HTTP delivery. */",
      "export interface RetryPolicy {",
      "  key: string;",
      '  operation: "create-order";',
      "  actorSubject: string;",
      "}",
      "",
      "export function retryPolicy(key: string, actorSubject: string): RetryPolicy {",
      '  if (!key) throw new Error("operation key is required");',
      '  return { key, operation: "create-order", actorSubject };',
      "}",
      "",
    ].join("\n"),
    "src/workers/legacy-payment-cleaner.ts": [
      "export async function cleanPendingPayments(paymentIds: string[]) {",
      "  for (const paymentId of paymentIds) {",
      '    await fetch(`/payments/${paymentId}/void`, { method: "POST" });',
      "  }",
      "}",
      "",
    ].join("\n"),
    "docs/operations/order-failures.md": [
      "# Order failure operations",
      "",
      "Inspect the payment provider before retrying a failed order request.",
      "Record the authorization identifier and customer ID in the incident timeline.",
      "Do not capture an authorization when no order record exists.",
      "",
    ].join("\n"),
  };

  for (const context of backgroundContexts) {
    for (const capability of backgroundCapabilities) {
      const exportName = `${context}${capability[0].toUpperCase()}${capability.slice(1)}`;
      files[`src/modules/${context}/${capability}.ts`] = [
        `/** ${context} ${capability} boundary used by the commerce service. */`,
        `export const ${exportName} = {`,
        `  context: "${context}",`,
        `  capability: "${capability}",`,
        `  ownership: "commerce-platform",`,
        "} as const;",
        "",
      ].join("\n");
    }
  }

  const decisions = [
    ["001-service-boundaries", "Keep bounded contexts independently deployable"],
    ["002-money-values", "Represent money as integer minor units"],
    ["003-event-contracts", "Version externally consumed events"],
    ["004-authentication", "Verify access tokens at the HTTP boundary"],
    ["005-database-access", "Pass transaction clients explicitly"],
    ["006-observability", "Correlate logs with request and order identifiers"],
    ["007-retries", "Retry only classified transient failures"],
    ["008-migrations", "Deploy additive migrations before application code"],
    ["009-ownership", "Assign every queue and table to one team"],
    ["010-webhooks", "Authenticate webhooks before decoding payloads"],
    ["011-timeouts", "Bound every remote request"],
    ["012-feature-flags", "Remove rollout flags after stabilization"],
  ];
  for (const [name, decision] of decisions) {
    files[`docs/decisions/${name}.md`] = `# ${decision}\n\nStatus: Accepted\n\n${decision}.\n`;
  }
  for (const environment of ["development", "test", "staging", "production"]) {
    files[`config/${environment}.json`] = `${JSON.stringify(
      {
        environment,
        logLevel: environment === "production" ? "info" : "debug",
        httpTimeoutMs: environment === "production" ? 2500 : 5000,
      },
      null,
      2,
    )}\n`;
  }
  for (const name of [
    "actor",
    "catalog-item",
    "customer",
    "inventory-item",
    "money",
    "payment",
    "shipment",
    "test-clock",
  ]) {
    const exportName = name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    files[`test/support/${name}.ts`] = [
      `export function ${exportName}Fixture(overrides = {}) {`,
      `  return { fixture: "${name}", ...overrides };`,
      "}",
      "",
    ].join("\n");
  }
  return files;
};

const source = (value) => `${value.trim()}\n`;

const finalSources = {
  ...walkthroughRepositorySources,
  "src/infrastructure/db/idempotency-store.ts": source(`
import type { Pool, PoolClient } from "pg";

export class PostgresIdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async run<T>(key: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (!key) return await operation();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const cached = await client.query("SELECT response FROM idempotency_keys WHERE key = $1", [key]);
      if (cached.rowCount) return JSON.parse(cached.rows[0].response) as T;
      const result = await operation();
      await this.record(client, key, result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async record(client: PoolClient, key: string, result: unknown): Promise<void> {
    await client.query("INSERT INTO idempotency_keys (key, response) VALUES ($1, $2)", [
      key,
      JSON.stringify(result),
    ]);
  }
}
  `),
  "src/application/orders/idempotency-policy.ts": source(`
/** Identifies one durable create-order operation across repeated HTTP delivery. */
export interface IdempotencyEnvelope {
  key: string;
  operation: "create-order";
  actorSubject: string;
}

export function idempotencyEnvelope(key: string, actorSubject: string): IdempotencyEnvelope {
  if (!key) throw new Error("operation key is required");
  return { key, operation: "create-order", actorSubject };
}
  `),
  "src/domain/events.ts": source(`
export interface DomainEvent {
  type: "order.placed" | "payment.authorized";
  aggregateId: string;
  payload: Record<string, unknown>;
}
  `),
  "src/application/ports.ts": source(`
export interface ApplicationPorts {
  idempotency: { run<T>(key: string | undefined, work: () => Promise<T>): Promise<T> };
  catalog: { getBySkus(skus: string[]): Promise<Array<{ sku: string; unitPrice: number; currency: string }>> };
  inventory: { reserve(lines: Array<{ sku: string; quantity: number }>): Promise<{ id: string }> };
  payments: { authorize(input: unknown): Promise<{ id: string }> };
  transaction: { run<T>(work: (transaction: unknown) => Promise<T>): Promise<T> };
  orders: { insert(order: unknown, transaction: unknown): Promise<void> };
  outbox: { append(events: unknown[], transaction: unknown): Promise<void> };
}
  `),
  "src/infrastructure/events/outbox-event.ts": source(`
export interface OutboxEventRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  publishedAt: Date | null;
}
  `),
  "src/telemetry/order-metrics.ts": source(`
export const orderMetrics = {
  placementLatency: "orders.placement.duration_ms",
  idempotencyReplay: "orders.idempotency.replay_total",
  orphanAuthorization: "payments.orphan_authorization_total",
  outboxLag: "outbox.oldest_unpublished_age_seconds",
} as const;
  `),
  "src/telemetry/order-logger.ts": source(`
export function orderLogContext(input: { requestId: string; orderId?: string; idempotencyKey?: string }) {
  return { ...input, component: "order-placement" };
}
  `),
  "config/order-placement.json": `${JSON.stringify(
    {
      inventoryTimeoutMs: 2500,
      paymentTimeoutMs: 3000,
      outboxBatchSize: 100,
      reconciliationLeaseSeconds: 60,
    },
    null,
    2,
  )}\n`,
  "config/order-alerts.json": `${JSON.stringify(
    {
      outboxLagSeconds: 120,
      orphanAuthorizationRate: 5,
      paymentProviderErrorRate: 0.02,
    },
    null,
    2,
  )}\n`,
  "docs/architecture/resilient-order-placement.md": source(`
# Resilient order placement

The request boundary authenticates an actor before the application service authorizes customer scope.
Inventory reservation and payment authorization are remote side effects, while the order and outbox
event share one database transaction. Idempotency converges repeated client requests on the original
result. A separate reconciliation worker recovers authorizations left without a persisted order.
  `),
  "docs/runbooks/payment-recovery.md": source(`
# Payment recovery runbook

Inspect the payment provider before retrying a failed order request.
Record the authorization identifier and customer ID in the incident timeline.
Do not capture an authorization when no order record exists.

The reconciliation worker leases candidates before checking the order repository. Treat an already
voided authorization as success, retry provider timeouts, and page the payments owner when the same
authorization remains eligible for more than three runs.
  `),
  "docs/runbooks/outbox-lag.md": source(`
# Outbox lag runbook

Alert on the age of the oldest unpublished event. Confirm dispatcher leases are progressing before
increasing concurrency. Duplicate publication is expected after a crash between publish and marking
the row complete, so consumers must deduplicate by event ID.
  `),
  "test/unit/pricing.test.ts": source(`
import { describe, expect, it } from "vitest";
import { calculateOrderTotal } from "../../src/domain/orders/pricing.js";

describe("calculateOrderTotal", () => {
  it("rejects mixed currencies", () => {
    expect(() => calculateOrderTotal(
      [{ sku: "sku-1", quantity: 1 }, { sku: "sku-2", quantity: 1 }],
      [{ sku: "sku-1", unitPrice: 100, currency: "USD" }, { sku: "sku-2", unitPrice: 100, currency: "EUR" }],
    )).toThrow("same currency");
  });
});
  `),
  "test/integration/payment-reconciliation.test.ts": source(`
import { describe, expect, it } from "vitest";

describe("payment reconciliation", () => {
  it("voids an authorization only when no persisted order exists", async () => {
    const result = await Promise.resolve({ voided: true, reason: "order-missing" });
    expect(result).toEqual({ voided: true, reason: "order-missing" });
  });
});
  `),
  "test/contract/outbox-event.test.ts": source(`
import { describe, expect, it } from "vitest";

describe("order.placed event", () => {
  it("keeps the event ID and aggregate ID stable across redelivery", () => {
    expect({ eventId: "evt-1", aggregateId: "order-1" }).toMatchObject({ aggregateId: "order-1" });
  });
});
  `),
};

function git(repositoryRoot, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function writeFiles(repositoryRoot, files) {
  for (const [filePath, contents] of Object.entries(files)) {
    const destination = path.join(repositoryRoot, filePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents, "utf8");
  }
}

function removeFile(repositoryRoot, filePath) {
  rmSync(path.join(repositoryRoot, filePath));
}

function commitAll(repositoryRoot, subject, index) {
  git(repositoryRoot, ["add", "-A"]);
  const date = new Date(fixtureEpoch + index * 60 * 60 * 1000).toISOString();
  git(repositoryRoot, ["commit", "--no-gpg-sign", "-m", subject], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      TZ: "UTC",
      LC_ALL: "C",
    },
  });
  return git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
}

function parseCommit(repositoryRoot, oid) {
  const [commitOid, parents, subject, authorName, authoredAt] = git(repositoryRoot, [
    "show",
    "-s",
    "--format=%H%x00%P%x00%s%x00%an%x00%aI",
    oid,
  ])
    .trimEnd()
    .split("\0");
  if (!commitOid || parents === undefined || !subject || !authorName || !authoredAt) {
    throw new Error(`realistic fixture could not parse commit ${oid}`);
  }
  return {
    oid: commitOid,
    parentOids: parents ? parents.split(" ") : [],
    subject,
    authorName,
    authoredAt,
  };
}

function parseTree(repositoryRoot, oid) {
  return git(repositoryRoot, ["ls-tree", "-r", "-l", "-z", oid])
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) (blob|commit) ([0-9a-f]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error(`realistic fixture could not parse tree entry at ${oid}`);
      const [, mode, type, objectOid, sizeText, filePath] = match;
      if (!mode || !type || !objectOid || !sizeText || !filePath) {
        throw new Error(`realistic fixture tree entry is incomplete at ${oid}`);
      }
      return {
        mode,
        type,
        oid: objectOid,
        size: sizeText === "-" ? null : Number(sizeText),
        path: filePath,
        kind: type === "commit" ? "submodule" : mode === "120000" ? "symlink" : "file",
      };
    });
}

function parseChangedFiles(repositoryRoot, oldOid, newOid) {
  const fields = git(repositoryRoot, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=50%",
    oldOid,
    newOid,
  ]).split("\0");
  const files = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (!oldPath || !newPath)
        throw new Error(`realistic fixture rename is incomplete: ${status}`);
      files.push({
        kind: code === "R" ? "renamed" : "added",
        status,
        similarity: Number(status.slice(1)),
        oldPath: code === "R" ? oldPath : null,
        newPath,
      });
      continue;
    }
    const filePath = fields[index++];
    if (!filePath) throw new Error(`realistic fixture change is incomplete: ${status}`);
    files.push({
      kind:
        code === "A"
          ? "added"
          : code === "D"
            ? "deleted"
            : code === "T"
              ? "type-changed"
              : "modified",
      status,
      similarity: null,
      oldPath: code === "A" ? null : filePath,
      newPath: code === "D" ? null : filePath,
    });
  }
  return files;
}

function createRepository() {
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "rvw-realistic-"));
  git(repositoryRoot, ["init", "--object-format=sha1", "--initial-branch=main"]);
  const config = [
    ["user.name", "Acme Orders Team"],
    ["user.email", "orders@example.test"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.autocrlf", "false"],
    ["core.eol", "lf"],
    ["core.filemode", "false"],
  ];
  for (const [key, value] of config) git(repositoryRoot, ["config", key, value]);

  writeFiles(repositoryRoot, baseFiles());
  const baseOid = commitAll(repositoryRoot, "Establish commerce service boundaries", 0);

  const progressions = [
    {
      subject: "Define the authenticated order request boundary",
      files: [
        "src/http/routes/orders.ts",
        "src/http/controllers/create-order.ts",
        "src/http/middleware/require-actor.ts",
        "src/http/schemas/create-order.ts",
        "src/application/orders/types.ts",
      ],
      extra: {
        "README.md": `${baseFiles()["README.md"]}\n## Order API\n\nPOST /orders requires an actor and an idempotency key.\n`,
      },
    },
    {
      subject: "Model order placement and pricing invariants",
      files: [
        "src/domain/orders/order.ts",
        "src/domain/orders/pricing.ts",
        "src/domain/events.ts",
        "src/application/authorization/order-policy.ts",
      ],
    },
    {
      subject: "Reserve inventory and authorize payment",
      files: [
        "src/infrastructure/inventory/http-inventory-client.ts",
        "src/infrastructure/payments/stripe-gateway.ts",
        "src/application/orders/create-order.ts",
        "src/application/ports.ts",
      ],
    },
    {
      subject: "Converge retried requests with an idempotency envelope",
      files: [
        "src/infrastructure/db/idempotency-store.ts",
        "src/application/orders/idempotency-policy.ts",
      ],
      remove: ["src/application/orders/retry-policy.ts"],
    },
    {
      subject: "Persist orders and events in one transaction",
      files: [
        "src/infrastructure/db/transaction.ts",
        "src/infrastructure/db/order-repository.ts",
        "src/infrastructure/events/postgres-outbox.ts",
        "src/infrastructure/events/outbox-event.ts",
      ],
    },
    {
      subject: "Add outbox delivery, migration, and operational signals",
      files: [
        "src/workers/outbox-dispatcher.ts",
        "migrations/018_orders_and_outbox.sql",
        "src/telemetry/order-metrics.ts",
        "src/telemetry/order-logger.ts",
        "config/order-placement.json",
        "config/order-alerts.json",
        "docs/architecture/resilient-order-placement.md",
        "docs/runbooks/outbox-lag.md",
      ],
    },
    {
      subject: "Recover orphan payments and close review feedback",
      files: [
        "src/workers/payment-reconciliation.ts",
        "src/bootstrap/application.ts",
        "test/integration/create-order.test.ts",
        "test/integration/payment-reconciliation.test.ts",
        "test/contract/order-api.test.ts",
        "test/contract/outbox-event.test.ts",
        "test/unit/pricing.test.ts",
        "docs/runbooks/payment-recovery.md",
        "docs/order-workflow.md",
      ],
      remove: ["src/workers/legacy-payment-cleaner.ts", "docs/operations/order-failures.md"],
    },
  ];

  const commitOids = [];
  progressions.forEach((progression, progressionIndex) => {
    const files = Object.fromEntries(
      progression.files.map((filePath) => {
        const contents = finalSources[filePath];
        if (contents === undefined) throw new Error(`missing realistic source: ${filePath}`);
        return [filePath, contents];
      }),
    );
    writeFiles(repositoryRoot, { ...files, ...(progression.extra ?? {}) });
    for (const filePath of progression.remove ?? []) removeFile(repositoryRoot, filePath);
    commitOids.push(commitAll(repositoryRoot, progression.subject, progressionIndex + 1));
  });
  return { repositoryRoot, baseOid, commitOids };
}

function hashDocument(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function createRealisticFixture() {
  const { repositoryRoot, baseOid, commitOids } = createRepository();
  const commits = commitOids.map((oid) => parseCommit(repositoryRoot, oid));
  const headOid = commitOids.at(-1);
  if (!headOid) throw new Error("realistic fixture did not create a head commit");
  const treeCache = new Map();
  const documentCache = new Map();
  const repositoryEntriesAt = (oid) => {
    if (!commitOids.includes(oid) && oid !== baseOid) {
      throw new Error(`realistic fixture does not contain commit ${oid}`);
    }
    const cached = treeCache.get(oid);
    if (cached) return cached;
    const entries = parseTree(repositoryRoot, oid);
    treeCache.set(oid, entries);
    return entries;
  };
  const repositoryDocumentAt = (oid, filePath) => {
    const key = `${oid}\0${filePath}`;
    const cached = documentCache.get(key);
    if (cached) return cached;
    const entry = repositoryEntriesAt(oid).find((candidate) => candidate.path === filePath);
    if (!entry) {
      const missing = {
        availability: "missing",
        text: null,
        byteLength: 0,
        entryKind: "file",
        normalizedLineEndings: false,
        oid: null,
      };
      documentCache.set(key, missing);
      return missing;
    }
    if (entry.size !== null && entry.size > maximumDocumentBytes) {
      const tooLarge = {
        availability: "too-large",
        text: null,
        byteLength: entry.size,
        entryKind: entry.kind,
        normalizedLineEndings: false,
        oid: entry.oid,
      };
      documentCache.set(key, tooLarge);
      return tooLarge;
    }
    const contents = execFileSync("git", ["show", `${oid}:${filePath}`], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (contents.includes(0) || !isUtf8(contents)) {
      const binary = {
        availability: "binary",
        text: null,
        byteLength: contents.length,
        entryKind: entry.kind,
        normalizedLineEndings: false,
        oid: entry.oid,
      };
      documentCache.set(key, binary);
      return binary;
    }
    const rawText = contents.toString("utf8");
    const text = rawText.replace(/\r\n?/gu, "\n");
    const available = {
      availability: "available",
      text,
      byteLength: contents.length,
      entryKind: entry.kind,
      normalizedLineEndings: text !== rawText,
      oid: entry.oid,
    };
    documentCache.set(key, available);
    return available;
  };
  const changedFiles = (oldOid, newOid) => parseChangedFiles(repositoryRoot, oldOid, newOid);
  const lineReferenceAt = (oid, id, label, filePath, needle, span, description) => {
    const document = repositoryDocumentAt(oid, filePath);
    if (document.availability !== "available" || document.text === null) {
      throw new Error(`realistic reference ${id} requires readable ${filePath} at ${oid}`);
    }
    const firstOffset = document.text.indexOf(needle);
    const secondOffset = firstOffset < 0 ? -1 : document.text.indexOf(needle, firstOffset + 1);
    if (firstOffset < 0) throw new Error(`realistic reference ${id} could not find ${needle}`);
    if (secondOffset >= 0)
      throw new Error(`realistic reference ${id} needle is not unique: ${needle}`);
    const startLine = document.text.slice(0, firstOffset).split("\n").length;
    return {
      id,
      label,
      path: filePath,
      startLine,
      endLine: Math.min(startLine + span, document.text.split("\n").length),
      description,
    };
  };
  const headReference = (...args) => lineReferenceAt(headOid, ...args);
  const anchor = (filePath, needle, span = 3) => {
    const reference = headReference(
      `anchor:${filePath}:${needle}`,
      needle,
      filePath,
      needle,
      span,
      "",
    );
    return { path: filePath, startLine: reference.startLine, endLine: reference.endLine };
  };

  const placementReferences = [
    headReference(
      "placement-route",
      "POST /orders",
      "src/http/routes/orders.ts",
      "routes.post",
      2,
      "Authenticated HTTP entrypoint",
    ),
    headReference(
      "placement-controller",
      "Request controller",
      "src/http/controllers/create-order.ts",
      "export async function createOrderController",
      14,
      "Transport-to-application mapping",
    ),
    headReference(
      "placement-handler",
      "CreateOrderHandler",
      "src/application/orders/create-order.ts",
      "async execute",
      31,
      "Order placement orchestration",
    ),
    headReference(
      "placement-order",
      "Order aggregate",
      "src/domain/orders/order.ts",
      "static place",
      8,
      "Order invariant and event creation",
    ),
    headReference(
      "placement-catalog",
      "Catalog query dependency",
      "src/modules/catalog/queries.ts",
      "export const catalogQueries",
      4,
      "Unchanged catalog boundary used by pricing",
    ),
  ];
  const recoveryReferences = [
    headReference(
      "recovery-idempotency",
      "Idempotency transaction",
      "src/infrastructure/db/idempotency-store.ts",
      "async run",
      12,
      "Concurrent retries converge on one result",
    ),
    headReference(
      "recovery-payment",
      "Payment authorization",
      "src/infrastructure/payments/stripe-gateway.ts",
      "async authorize",
      16,
      "Provider idempotency and manual capture",
    ),
    headReference(
      "recovery-worker",
      "Payment reconciliation",
      "src/workers/payment-reconciliation.ts",
      "async reconcile",
      8,
      "Orphan authorization recovery",
    ),
    headReference(
      "recovery-runbook",
      "Payment recovery runbook",
      "docs/runbooks/payment-recovery.md",
      "The reconciliation worker leases candidates",
      3,
      "Operator response for persistent recovery failures",
    ),
  ];
  const deliveryReferences = [
    headReference(
      "delivery-transaction",
      "Database transaction",
      "src/infrastructure/db/transaction.ts",
      "async run",
      12,
      "Atomic order and event write",
    ),
    headReference(
      "delivery-outbox",
      "Outbox append",
      "src/infrastructure/events/postgres-outbox.ts",
      "async append",
      8,
      "Durable event handoff",
    ),
    headReference(
      "delivery-dispatcher",
      "Outbox dispatcher",
      "src/workers/outbox-dispatcher.ts",
      "async tick",
      9,
      "Lease and publish loop",
    ),
    headReference(
      "delivery-migration",
      "Orders and outbox migration",
      "migrations/018_orders_and_outbox.sql",
      "CREATE TABLE outbox_events",
      10,
      "Durable schema",
    ),
    headReference(
      "delivery-metrics",
      "Order operational metrics",
      "src/telemetry/order-metrics.ts",
      "export const orderMetrics",
      5,
      "Lag and recovery signals",
    ),
  ];
  const walkthroughs = [
    {
      id: "73000000-0000-4000-8000-000000000001",
      ref: "rvw://walkthrough/73000000-0000-4000-8000-000000000001",
      pullRequestId: realisticPullRequestId,
      sourceOid: headOid,
      title: "Review route: authenticated order placement",
      authorLabel: "Acme Orders Team",
      createdAt: "2026-07-14T17:10:00.000Z",
      references: placementReferences,
      diagramBindings: {
        Route: "placement-route",
        Handler: "placement-handler",
        Order: "placement-order",
      },
      body: [
        "# Authenticated order placement",
        "",
        "Start at [POST /orders](rvw-ref:placement-route), confirm the [request controller](rvw-ref:placement-controller), then inspect [CreateOrderHandler](rvw-ref:placement-handler).",
        "",
        "```mermaid",
        "flowchart LR",
        "  Route[POST /orders] --> Handler[CreateOrderHandler]",
        "  Handler --> Order[Order aggregate]",
        "```",
        "",
        "The handler keeps HTTP types outside the application layer and delegates pricing invariants to the [Order aggregate](rvw-ref:placement-order). The unchanged [catalog query dependency](rvw-ref:placement-catalog) is useful context when reviewing SKU lookups.",
      ].join("\n"),
    },
    {
      id: "73000000-0000-4000-8000-000000000002",
      ref: "rvw://walkthrough/73000000-0000-4000-8000-000000000002",
      pullRequestId: realisticPullRequestId,
      sourceOid: headOid,
      title: "Failure route: retries and payment recovery",
      authorLabel: "Acme Orders Team",
      createdAt: "2026-07-14T17:20:00.000Z",
      references: recoveryReferences,
      diagramBindings: {
        Retry: "recovery-idempotency",
        Payment: "recovery-payment",
        Recovery: "recovery-worker",
      },
      body: [
        "# Retry and payment recovery",
        "",
        "Repeated requests enter the [idempotency transaction](rvw-ref:recovery-idempotency) before [payment authorization](rvw-ref:recovery-payment).",
        "",
        "```mermaid",
        "flowchart LR",
        "  Retry[Idempotent retry] --> Payment[Authorize payment]",
        "  Payment -. orphaned authorization .-> Recovery[Reconciliation]",
        "```",
        "",
        "When authorization succeeds but persistence does not, [payment reconciliation](rvw-ref:recovery-worker) checks for a missing order before voiding. The [operator runbook](rvw-ref:recovery-runbook) defines escalation for repeated provider failures.",
      ].join("\n"),
    },
    {
      id: "73000000-0000-4000-8000-000000000003",
      ref: "rvw://walkthrough/73000000-0000-4000-8000-000000000003",
      pullRequestId: realisticPullRequestId,
      sourceOid: headOid,
      title: "Delivery route: transactional outbox operations",
      authorLabel: "Acme Orders Team",
      createdAt: "2026-07-14T17:30:00.000Z",
      references: deliveryReferences,
      diagramBindings: {
        Transaction: "delivery-transaction",
        Outbox: "delivery-outbox",
        Dispatcher: "delivery-dispatcher",
      },
      body: [
        "# Transactional outbox delivery",
        "",
        "The [database transaction](rvw-ref:delivery-transaction) writes the order and [outbox rows](rvw-ref:delivery-outbox) together.",
        "",
        "```mermaid",
        "flowchart LR",
        "  Transaction[Order transaction] --> Outbox[Outbox rows]",
        "  Outbox --> Dispatcher[Dispatcher]",
        "```",
        "",
        "Review the [dispatcher lease](rvw-ref:delivery-dispatcher), the [migration](rvw-ref:delivery-migration), and the [operational metrics](rvw-ref:delivery-metrics) as one delivery contract. Publication remains at-least-once.",
      ].join("\n"),
    },
  ];

  const structure = (index, title, scope, originNodeId, nodes, edges, createdAt) => ({
    id: `74000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ref: `rvw://structure/74000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    pullRequestId: realisticPullRequestId,
    sourceOid: headOid,
    title,
    scope,
    originNodeId,
    nodes,
    edges,
    createdAt,
    updatedAt: createdAt,
  });
  const node = (id, label, kind, notation, sourceAnchor = null, description = null) => ({
    id,
    label,
    description,
    kind,
    notation,
    anchor: sourceAnchor,
  });
  const edge = (id, from, to, label, ...anchors) => ({
    id,
    from,
    to,
    label,
    directed: true,
    anchors,
  });
  const structures = [
    structure(
      1,
      "Order placement behavior",
      "A request from the authenticated POST /orders entrypoint through authorization, remote reservations, aggregate decisions, and transactional persistence.",
      "orders-route",
      [
        node(
          "orders-route",
          "POST /orders",
          "route",
          "external",
          anchor("src/http/routes/orders.ts", "routes.post", 1),
        ),
        node(
          "actor",
          "Authenticated actor",
          "middleware",
          "component",
          anchor("src/http/middleware/require-actor.ts", "export function requireActor", 10),
        ),
        node(
          "controller",
          "Create order controller",
          "controller",
          "class",
          anchor(
            "src/http/controllers/create-order.ts",
            "export async function createOrderController",
            12,
          ),
        ),
        node(
          "handler",
          "CreateOrderHandler",
          "use-case",
          "class",
          anchor("src/application/orders/create-order.ts", "export class CreateOrderHandler", 31),
        ),
        node(
          "order",
          "Order aggregate",
          "aggregate",
          "class",
          anchor("src/domain/orders/order.ts", "export class Order", 20),
        ),
        node(
          "inventory",
          "Inventory reservation",
          "gateway",
          "external",
          anchor("src/infrastructure/inventory/http-inventory-client.ts", "async reserve", 8),
        ),
        node(
          "payment",
          "Payment authorization",
          "gateway",
          "external",
          anchor("src/infrastructure/payments/stripe-gateway.ts", "async authorize", 12),
        ),
        node(
          "transaction",
          "Order transaction",
          "transaction",
          "database",
          anchor("src/infrastructure/db/transaction.ts", "async run", 10),
        ),
      ],
      [
        edge(
          "route-authenticates",
          "orders-route",
          "actor",
          "authenticates every order request",
          anchor("src/http/routes/orders.ts", "routes.use", 1),
        ),
        edge(
          "route-dispatches",
          "orders-route",
          "controller",
          "dispatches POST requests",
          anchor("src/http/routes/orders.ts", "routes.post", 1),
        ),
        edge(
          "controller-calls-handler",
          "controller",
          "handler",
          "executes a validated command",
          anchor("src/http/controllers/create-order.ts", "application.createOrder.execute", 7),
        ),
        edge(
          "handler-reserves",
          "handler",
          "inventory",
          "reserves requested stock",
          anchor("src/application/orders/create-order.ts", "ports.inventory.reserve", 2),
        ),
        edge(
          "handler-places",
          "handler",
          "order",
          "constructs the priced aggregate",
          anchor("src/application/orders/create-order.ts", "const order = Order.place", 6),
        ),
        edge(
          "handler-authorizes",
          "handler",
          "payment",
          "authorizes the aggregate total",
          anchor("src/application/orders/create-order.ts", "ports.payments.authorize", 5),
        ),
        edge(
          "handler-persists",
          "handler",
          "transaction",
          "commits order and events atomically",
          anchor("src/application/orders/create-order.ts", "ports.transaction.run", 4),
        ),
      ],
      "2026-07-14T17:40:00.000Z",
    ),
    structure(
      2,
      "Idempotent retry convergence",
      "Concurrent create-order requests sharing an idempotency key converge on the first completed result before remote side effects repeat.",
      "idempotency-store",
      [
        node(
          "request-key",
          "Idempotency-Key header",
          "input",
          "external",
          anchor("src/http/controllers/create-order.ts", "const idempotencyKey", 2),
        ),
        node(
          "envelope",
          "Idempotency envelope",
          "policy",
          "interface",
          anchor(
            "src/application/orders/idempotency-policy.ts",
            "export function idempotencyEnvelope",
            4,
          ),
        ),
        node(
          "idempotency-store",
          "Idempotency transaction coordinator with replayable result",
          "adapter",
          "database",
          anchor(
            "src/infrastructure/db/idempotency-store.ts",
            "export class PostgresIdempotencyStore",
            14,
          ),
        ),
        node(
          "handler",
          "CreateOrderHandler operation",
          "use-case",
          "class",
          anchor("src/application/orders/create-order.ts", "export class CreateOrderHandler", 20),
        ),
        node("handler-result", "Original order result", "result", "concept"),
        node(
          "payment",
          "Payment authorization",
          "gateway",
          "external",
          anchor("src/infrastructure/payments/stripe-gateway.ts", "async authorize", 10),
        ),
      ],
      [
        edge(
          "key-builds-envelope",
          "request-key",
          "envelope",
          "identifies actor-scoped operation",
          anchor("src/application/orders/idempotency-policy.ts", "return { key", 1),
        ),
        edge(
          "envelope-coordinates",
          "envelope",
          "idempotency-store",
          "locks the operation key",
          anchor("src/infrastructure/db/idempotency-store.ts", "pg_advisory_xact_lock", 3),
        ),
        edge(
          "store-runs-handler",
          "idempotency-store",
          "handler",
          "permits one application operation",
          anchor("src/application/orders/create-order.ts", "ports.idempotency.run", 3),
        ),
        edge(
          "handler-runs-payment",
          "handler",
          "payment",
          "performs one authorization path",
          anchor("src/application/orders/create-order.ts", "ports.payments.authorize", 4),
        ),
        edge(
          "store-replays-result",
          "idempotency-store",
          "handler-result",
          "returns the recorded response",
          anchor("src/infrastructure/db/idempotency-store.ts", "return JSON.parse", 2),
        ),
        edge(
          "payment-completes-result",
          "payment",
          "handler-result",
          "contributes authorization ID",
          anchor("src/application/orders/create-order.ts", "order.recordPaymentAuthorization", 2),
        ),
      ],
      "2026-07-14T17:41:00.000Z",
    ),
    structure(
      3,
      "Payment reconciliation recovery",
      "A scheduled recovery decision for an authorized payment that may not have a corresponding persisted order.",
      "reconciliation-decision",
      [
        node(
          "scheduler",
          "Reconciliation scheduler",
          "trigger",
          "component",
          anchor(
            "src/workers/payment-reconciliation.ts",
            "export class PaymentReconciliationWorker",
            10,
          ),
        ),
        node("authorization-candidate", "Orphan authorization candidate", "record", "concept"),
        node(
          "order-repository",
          "Order existence evidence",
          "repository",
          "database",
          anchor(
            "src/infrastructure/db/order-repository.ts",
            "export class PostgresOrderRepository",
            10,
          ),
        ),
        node(
          "provider-status",
          "Provider authorization status",
          "gateway",
          "external",
          anchor("src/infrastructure/payments/stripe-gateway.ts", "export class StripeGateway", 15),
        ),
        node(
          "reconciliation-decision",
          "Safe-to-void reconciliation decision",
          "decision",
          "concept",
        ),
        node(
          "void-command",
          "Void authorization",
          "command",
          "external",
          anchor("src/workers/payment-reconciliation.ts", "payments.void", 2),
        ),
      ],
      [
        edge(
          "scheduler-supplies-candidate",
          "scheduler",
          "authorization-candidate",
          "leases a recovery candidate",
          anchor("src/workers/payment-reconciliation.ts", "async reconcile", 2),
        ),
        edge(
          "candidate-feeds-decision",
          "authorization-candidate",
          "reconciliation-decision",
          "identifies the authorization under review",
          anchor("src/workers/payment-reconciliation.ts", "async reconcile(authorizationId", 2),
        ),
        edge(
          "order-evidence-feeds-decision",
          "order-repository",
          "reconciliation-decision",
          "proves whether an order exists",
          anchor("src/workers/payment-reconciliation.ts", "orders.findByPaymentAuthorization", 2),
        ),
        edge(
          "provider-status-feeds-decision",
          "provider-status",
          "reconciliation-decision",
          "confirms the authorization remains voidable",
          anchor("src/workers/payment-reconciliation.ts", "payments.getAuthorization", 2),
        ),
        edge(
          "decision-issues-void",
          "reconciliation-decision",
          "void-command",
          "voids only an orphan authorization",
          anchor("src/workers/payment-reconciliation.ts", "if (!order", 3),
        ),
      ],
      "2026-07-14T17:42:00.000Z",
    ),
    structure(
      4,
      "Transactional outbox delivery",
      "Committed order events move from the shared transaction to leased outbox rows and at-least-once publication.",
      "dispatcher",
      [
        node(
          "order-repository",
          "Persisted order",
          "repository",
          "database",
          anchor("src/infrastructure/db/order-repository.ts", "async insert", 7),
        ),
        node(
          "outbox-writer",
          "Transactional outbox writer",
          "repository",
          "database",
          anchor("src/infrastructure/events/postgres-outbox.ts", "async append", 8),
        ),
        node(
          "outbox-table",
          "outbox_events table",
          "storage",
          "database",
          anchor("migrations/018_orders_and_outbox.sql", "CREATE TABLE outbox_events", 10),
        ),
        node(
          "dispatcher",
          "Outbox dispatcher",
          "worker",
          "component",
          anchor("src/workers/outbox-dispatcher.ts", "export class OutboxDispatcher", 11),
        ),
        node("event-bus", "Commerce event bus", "transport", "external"),
        node(
          "metrics",
          "Delivery lag metrics",
          "telemetry",
          "component",
          anchor("src/telemetry/order-metrics.ts", "outboxLag", 1),
        ),
      ],
      [
        edge(
          "order-shares-transaction",
          "order-repository",
          "outbox-writer",
          "uses the same transaction client",
          anchor("src/application/orders/create-order.ts", "ports.orders.insert", 3),
        ),
        edge(
          "writer-inserts-rows",
          "outbox-writer",
          "outbox-table",
          "inserts released domain events",
          anchor("src/infrastructure/events/postgres-outbox.ts", "INSERT INTO outbox_events", 4),
        ),
        edge(
          "dispatcher-claims-rows",
          "dispatcher",
          "outbox-table",
          "claims rows with SKIP LOCKED",
          anchor("src/workers/outbox-dispatcher.ts", "FOR UPDATE SKIP LOCKED", 3),
        ),
        edge(
          "dispatcher-publishes",
          "dispatcher",
          "event-bus",
          "publishes each leased event",
          anchor("src/workers/outbox-dispatcher.ts", "this.bus.publish", 2),
        ),
        edge(
          "dispatcher-records-lag",
          "dispatcher",
          "metrics",
          "reports oldest unpublished age",
          anchor("src/telemetry/order-metrics.ts", "outboxLag", 1),
        ),
      ],
      "2026-07-14T17:43:00.000Z",
    ),
  ];

  const latestTitle =
    "Implement resilient order placement with idempotent retries, transactional outbox, and payment recovery";
  const latestBody = [
    "## Summary",
    "",
    "Adds a production-ready order placement flow spanning the authenticated HTTP boundary, domain pricing, inventory and payment integrations, atomic persistence, asynchronous event delivery, and payment recovery.",
    "",
    "## Motivation / failure mode",
    "",
    "Client retries could previously duplicate payment authorization, and a process crash between saving an order and publishing its event could lose downstream fulfillment work. An authorization created immediately before a failed database commit also had no safe recovery path.",
    "",
    "## Design",
    "",
    "The controller translates validated input into a CreateOrder command. The application handler owns orchestration while the Order aggregate owns pricing and state invariants. Remote adapters remain behind application ports.",
    "",
    "## Transaction boundary",
    "",
    "The order snapshot and released domain events are written with the same Postgres transaction client. External inventory and payment calls intentionally happen before this boundary and are covered by explicit recovery.",
    "",
    "## Retry / idempotency semantics",
    "",
    "The Idempotency-Key and actor identify one create-order operation. Concurrent attempts serialize on that operation and completed retries return the original response without repeating payment authorization.",
    "",
    "## Payment failure recovery",
    "",
    "Authorizations use the order ID as the provider idempotency key and remain uncaptured. The reconciliation worker leases candidates, checks for a persisted order, and voids only confirmed orphans. Provider timeouts remain retryable.",
    "",
    "## Outbox delivery semantics",
    "",
    "Dispatchers claim rows with FOR UPDATE SKIP LOCKED. Delivery is at-least-once because a crash can occur after publication and before published_at is recorded; consumers deduplicate by event ID.",
    "",
    "## Migration / rollout",
    "",
    "Deploy migration 018 first, then application writers, then dispatcher and reconciliation workers. Alerting ships disabled until one hour of baseline metrics is available.",
    "",
    "## Observability",
    "",
    "Structured logs include request, order, authorization, and idempotency identifiers. Metrics cover placement latency, replay rate, orphan authorization count, and oldest unpublished event age.",
    "",
    "## Tests",
    "",
    "Contract tests cover authentication and response stability. Integration tests cover atomic persistence, idempotent replay, and reconciliation. Unit tests cover aggregate and pricing invariants.",
    "",
    "## Known trade-offs",
    "",
    "Inventory reservations are not transactionally coupled to Postgres and expire independently. Outbox consumers must tolerate duplicates. Reconciliation intentionally prefers a delayed retry over voiding on ambiguous provider state.",
    "",
    "## Suggested review route",
    "",
    "1. Review the request boundary and authorization policy.",
    "2. Follow CreateOrderHandler through pricing and remote side effects.",
    "3. Verify the transaction and outbox schema together.",
    "4. Finish with recovery, telemetry, tests, and both runbooks.",
  ].join("\n");
  const pullRequestMarkdown = `# ${latestTitle}\n\n${latestBody}`;

  const targetAt = (oid, filePath, needle, span = 1) => {
    const reference = lineReferenceAt(
      oid,
      `comment:${filePath}:${needle}`,
      needle,
      filePath,
      needle,
      span,
      "",
    );
    return {
      kind: "document",
      documentKind: "repository-file",
      sourceOid: oid,
      path: filePath,
      startLine: reference.startLine,
      endLine: reference.endLine,
    };
  };
  const thread = (index, target, body, options = {}) => {
    const id = `75000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const createdAt = `2026-07-14T18:${String(index).padStart(2, "0")}:00.000Z`;
    const posts = [
      {
        id: `75100000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        commentId: id,
        body,
        relatedCommitOid: options.relatedCommitOid ?? null,
        references: options.references ?? [],
        authorLabel: "Reviewer",
        lastModifiedBy: "human",
        isRoot: true,
        createdAt,
        updatedAt: createdAt,
      },
    ];
    if (options.reply) {
      posts.push({
        id: `75200000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        commentId: id,
        body: options.reply,
        relatedCommitOid: options.replyCommitOid ?? headOid,
        references: [],
        authorLabel: "Acme Orders Team",
        lastModifiedBy: "agent",
        isRoot: false,
        createdAt: `2026-07-14T19:${String(index).padStart(2, "0")}:00.000Z`,
        updatedAt: `2026-07-14T19:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    return {
      id,
      ref: `rvw://comment/${id}`,
      pullRequestId: realisticPullRequestId,
      createdHeadOid: options.createdHeadOid ?? headOid,
      resolvedAt: options.resolved
        ? `2026-07-14T20:${String(index).padStart(2, "0")}:00.000Z`
        : null,
      createdAt,
      updatedAt: posts.at(-1).updatedAt,
      target,
      posts,
    };
  };
  const prTransactionLine =
    pullRequestMarkdown.split("\n").findIndex((line) => line === "## Transaction boundary") + 1;
  const walkthroughTarget = walkthroughs[1];
  const comments = [
    thread(
      1,
      { kind: "pull-request" },
      "Please confirm inventory reservations expire if authorization never completes; this is the remaining rollout decision.",
    ),
    thread(
      2,
      {
        kind: "document",
        documentKind: "pull-request-markdown",
        sourceDocumentHash: hashDocument(pullRequestMarkdown),
        quotedText: "## Transaction boundary",
        startLine: prTransactionLine,
        endLine: prTransactionLine,
      },
      "The boundary is clear. Please keep the external calls outside the database transaction to avoid holding locks during provider latency.",
      {
        resolved: true,
        reply: "Confirmed in the final handler and called out explicitly in this section.",
        relatedCommitOid: commitOids[4],
      },
    ),
    thread(
      3,
      targetAt(commitOids[0], "src/http/routes/orders.ts", "routes.use", 1),
      "Should authorization be enforced after authentication so service credentials cannot cross customer scope?",
      {
        resolved: true,
        reply:
          "Yes. The route authenticates; assertCanCreateOrder enforces permission and customer scope in the application boundary.",
        createdHeadOid: commitOids[0],
        relatedCommitOid: commitOids[0],
        replyCommitOid: commitOids[1],
      },
    ),
    thread(
      4,
      targetAt(commitOids[1], "src/domain/orders/pricing.ts", "const currency", 3),
      "Mixed currencies should fail before inventory reservation. Is that ordering guaranteed by the handler?",
      { createdHeadOid: commitOids[1], relatedCommitOid: commitOids[1] },
    ),
    thread(
      5,
      targetAt(commitOids[2], "src/infrastructure/payments/stripe-gateway.ts", "capture_method", 2),
      "Manual capture is the right failure boundary. Please add recovery ownership before resolving this.",
      {
        resolved: true,
        reply:
          "Added the reconciliation worker, alert thresholds, and payment recovery runbook in the final commit.",
        createdHeadOid: commitOids[2],
        relatedCommitOid: commitOids[2],
        replyCommitOid: commitOids[6],
      },
    ),
    thread(
      6,
      targetAt(
        commitOids[2],
        "src/application/orders/retry-policy.ts",
        "export function retryPolicy",
        2,
      ),
      "This policy name hides that the durable key converges concurrent work. Please rename it around idempotency semantics.",
      {
        resolved: true,
        reply: "Renamed to idempotency-policy.ts and made the actor-scoped envelope explicit.",
        createdHeadOid: commitOids[2],
        relatedCommitOid: commitOids[2],
        replyCommitOid: commitOids[3],
      },
    ),
    thread(
      7,
      targetAt(commitOids[5], "src/workers/legacy-payment-cleaner.ts", "cleanPendingPayments", 3),
      "This best-effort loop can void a payment after a delayed order commit. It should be removed once reconciliation lands.",
      { createdHeadOid: commitOids[5], relatedCommitOid: commitOids[5] },
    ),
    thread(
      8,
      targetAt(
        commitOids[2],
        "src/application/orders/create-order.ts",
        "ports.payments.authorize",
        5,
      ),
      "If payment succeeds and the transaction fails, retries must not create a second authorization. Please link the recovery path here.",
      {
        reply:
          "The provider uses order ID idempotency, and the final commit adds orphan reconciliation.",
        createdHeadOid: commitOids[2],
        relatedCommitOid: commitOids[2],
        replyCommitOid: commitOids[6],
      },
    ),
    thread(
      9,
      targetAt(
        commitOids[4],
        "src/infrastructure/events/postgres-outbox.ts",
        "INSERT INTO outbox_events",
        4,
      ),
      "Please verify this receives the exact transaction client used by the order insert.",
      {
        resolved: true,
        reply: "The integration test now asserts rollback removes both records.",
        createdHeadOid: commitOids[4],
        relatedCommitOid: commitOids[4],
        replyCommitOid: commitOids[6],
      },
    ),
    thread(
      10,
      {
        kind: "walkthrough",
        walkthroughId: walkthroughTarget.id,
        walkthroughTitle: walkthroughTarget.title,
        sourceDocumentHash: hashDocument(walkthroughTarget.body),
        quotedText: walkthroughTarget.body.split("\n")[2],
        startLine: 3,
        endLine: 3,
      },
      "This is a useful failure-first route. Please keep the operator runbook as the final hop rather than duplicating it in the Structure.",
    ),
    thread(
      11,
      targetAt(
        commitOids[5],
        "migrations/018_orders_and_outbox.sql",
        "CREATE TABLE outbox_events",
        8,
      ),
      "What protects the initial deployment from workers reading before this migration is complete?",
      {
        reply:
          "The rollout section requires migration 018 before enabling either worker; the flag stays off during the baseline window.",
        createdHeadOid: commitOids[5],
        relatedCommitOid: commitOids[5],
      },
    ),
    thread(
      12,
      targetAt(commitOids[6], "src/workers/payment-reconciliation.ts", "if (!order", 3),
      "The remaining risk is provider ambiguity: should a timeout increment the investigation counter or remain retryable indefinitely?",
      { createdHeadOid: commitOids[6], relatedCommitOid: commitOids[6] },
    ),
    thread(
      13,
      targetAt(commitOids[5], "src/telemetry/order-metrics.ts", "orphanAuthorization", 2),
      "These metric names give the runbook enough evidence to separate outbox lag from payment recovery failures.",
      {
        resolved: true,
        reply: "Confirmed; alert configuration now uses the same two signals.",
        createdHeadOid: commitOids[5],
        relatedCommitOid: commitOids[5],
        replyCommitOid: commitOids[6],
      },
    ),
  ];

  const gitCommonDir = path.resolve(
    repositoryRoot,
    git(repositoryRoot, ["rev-parse", "--git-common-dir"]).trim(),
  );
  const pullRequest = {
    id: realisticPullRequestId,
    host: "github.com",
    owner: "acme",
    repository: "commerce-service",
    number: 418,
    url: "https://github.com/acme/commerce-service/pull/418",
    latestAuthorLogin: "orders-team",
    latestHeadRepositoryOwner: "acme",
    latestHeadRepositoryName: "commerce-service",
    localRepositoryPath: repositoryRoot,
    gitCommonDir,
    latestTitle,
    latestBody,
    latestBaseRefName: "main",
    latestHeadRefName: "orders/resilient-placement",
    latestBaseOid: baseOid,
    latestComparisonBaseOid: baseOid,
    latestHeadOid: headOid,
    githubCreatedAt: commits[0].authoredAt,
    githubUpdatedAt: commits.at(-1).authoredAt,
    githubState: "OPEN",
    githubIsDraft: false,
    fetchedAt: commits.at(-1).authoredAt,
    createdAt: commits[0].authoredAt,
    updatedAt: commits.at(-1).authoredAt,
  };

  const changes = changedFiles(baseOid, headOid);
  const entries = repositoryEntriesAt(headOid);
  const changeKinds = Object.fromEntries(
    ["added", "modified", "renamed", "deleted", "type-changed"].map((kind) => [
      kind,
      changes.filter((change) => change.kind === kind).length,
    ]),
  );
  const manifest = {
    commitCount: commits.length,
    repositoryFileCount: entries.length,
    changedFileCount: changes.length,
    changeKinds,
    changedDirectories: [
      ...new Set(changes.map((change) => (change.newPath ?? change.oldPath).split("/")[0])),
    ].sort(),
    layers: [
      "application",
      "domain",
      "http",
      "infrastructure",
      "workers",
      "test",
      "migration",
      "docs",
    ],
    commentCount: comments.length,
    unresolvedCommentCount: comments.filter((comment) => comment.resolvedAt === null).length,
    resolvedCommentCount: comments.filter((comment) => comment.resolvedAt !== null).length,
    repliedThreadCount: comments.filter((comment) => comment.posts.length > 1).length,
    walkthroughCount: walkthroughs.length,
    structureCount: structures.length,
    rename: {
      oldPath: "src/application/orders/retry-policy.ts",
      newPath: "src/application/orders/idempotency-policy.ts",
      commentId: comments[5].id,
    },
    deleted: { path: "src/workers/legacy-payment-cleaner.ts", commentId: comments[6].id },
    multiStructurePath: "src/application/orders/create-order.ts",
    originKinds: {
      entry: "Order placement behavior",
      hub: "Idempotent retry convergence",
      terminal: "Payment reconciliation recovery",
    },
  };

  const resolvePathAt = (sourceOid, sourcePath, targetOid) => {
    if (repositoryEntriesAt(targetOid).some((entry) => entry.path === sourcePath))
      return sourcePath;
    const change = changedFiles(sourceOid, targetOid).find(
      (candidate) => candidate.oldPath === sourcePath,
    );
    return change?.kind === "renamed" ? change.newPath : null;
  };

  const cleanup = () => rmSync(repositoryRoot, { recursive: true, force: true });
  const fixture = {
    scenario: "realistic",
    pullRequestId: realisticPullRequestId,
    baseOid,
    headOid,
    commits,
    pullRequest,
    comments,
    walkthroughs,
    structures,
    manifest,
    repositoryRoot,
    repositoryEntriesAt,
    repositoryDocumentAt,
    changedFiles,
    resolvePathAt,
    cleanup,
  };
  validateRealisticFixture(fixture);
  return fixture;
}

export function validateRealisticFixture(fixture) {
  const fail = (message) => {
    throw new Error(`invalid realistic fixture: ${message}`);
  };
  if (fixture.commits.length !== 7) fail("expected seven PR commits");
  fixture.commits.forEach((commit, index) => {
    const expectedParent = index === 0 ? fixture.baseOid : fixture.commits[index - 1].oid;
    if (commit.parentOids.length !== 1 || commit.parentOids[0] !== expectedParent) {
      fail(`commit parent chain is broken at ${commit.subject}`);
    }
  });
  if (fixture.pullRequest.latestComparisonBaseOid !== fixture.baseOid)
    fail("comparison base mismatch");
  if (fixture.pullRequest.latestHeadOid !== fixture.headOid) fail("head mismatch");
  if (fixture.manifest.repositoryFileCount < 120)
    fail("repository must contain at least 120 files");
  if (fixture.manifest.changedFileCount < 25 || fixture.manifest.changedFileCount > 45) {
    fail("changed file count must remain between 25 and 45");
  }
  for (const kind of ["added", "modified", "renamed", "deleted"]) {
    if (!fixture.manifest.changeKinds[kind]) fail(`missing ${kind} change`);
  }
  for (const directory of ["config", "docs", "migrations", "src", "test"]) {
    if (!fixture.manifest.changedDirectories.includes(directory))
      fail(`missing changed directory ${directory}`);
  }

  const stableIds = new Set();
  const claimStableId = (id, meaning) => {
    if (stableIds.has(id)) fail(`stable ID ${id} is reused for ${meaning}`);
    stableIds.add(id);
  };
  const validateAnchor = (sourceOid, sourceAnchor, meaning) => {
    const document = fixture.repositoryDocumentAt(sourceOid, sourceAnchor.path);
    if (document.availability !== "available" || document.text === null)
      fail(`${meaning} has unreadable source ${sourceAnchor.path}`);
    const lineCount = document.text.split("\n").length;
    if (sourceAnchor.startLine === null || sourceAnchor.endLine === null) return;
    if (
      sourceAnchor.startLine < 1 ||
      sourceAnchor.startLine > sourceAnchor.endLine ||
      sourceAnchor.endLine > lineCount
    ) {
      fail(`${meaning} has out-of-range lines in ${sourceAnchor.path}`);
    }
  };
  for (const walkthrough of fixture.walkthroughs) {
    claimStableId(walkthrough.id, walkthrough.title);
    if (walkthrough.sourceOid !== fixture.headOid)
      fail(`${walkthrough.title} is not fixed to head`);
    const referenceIds = new Set();
    for (const reference of walkthrough.references) {
      if (referenceIds.has(reference.id))
        fail(`${walkthrough.title} reuses reference ${reference.id}`);
      referenceIds.add(reference.id);
      validateAnchor(walkthrough.sourceOid, reference, `walkthrough reference ${reference.id}`);
    }
    for (const [diagramNode, referenceId] of Object.entries(walkthrough.diagramBindings)) {
      if (!referenceIds.has(referenceId))
        fail(`diagram node ${diagramNode} targets missing ${referenceId}`);
    }
  }
  for (const structure of fixture.structures) {
    claimStableId(structure.id, structure.title);
    const nodeIds = new Set();
    const edgeIds = new Set();
    for (const structureNode of structure.nodes) {
      if (nodeIds.has(structureNode.id)) fail(`${structure.title} reuses node ${structureNode.id}`);
      nodeIds.add(structureNode.id);
      if (structureNode.anchor)
        validateAnchor(structure.sourceOid, structureNode.anchor, `node ${structureNode.id}`);
    }
    if (!nodeIds.has(structure.originNodeId)) fail(`${structure.title} origin is missing`);
    for (const structureEdge of structure.edges) {
      if (edgeIds.has(structureEdge.id)) fail(`${structure.title} reuses edge ${structureEdge.id}`);
      edgeIds.add(structureEdge.id);
      if (!nodeIds.has(structureEdge.from) || !nodeIds.has(structureEdge.to))
        fail(`${structure.title} edge ${structureEdge.id} has a missing endpoint`);
      for (const sourceAnchor of structureEdge.anchors)
        validateAnchor(structure.sourceOid, sourceAnchor, `edge ${structureEdge.id}`);
    }
  }
  for (const comment of fixture.comments) {
    claimStableId(comment.id, comment.ref);
    for (const post of comment.posts) claimStableId(post.id, `${comment.ref} post`);
    if (!fixture.commits.some((commit) => commit.oid === comment.createdHeadOid))
      fail(`${comment.ref} has unknown created head`);
    if (comment.target.kind === "document" && comment.target.documentKind === "repository-file") {
      validateAnchor(comment.target.sourceOid, comment.target, comment.ref);
      if (comment.target.sourceOid !== comment.createdHeadOid)
        fail(`${comment.ref} target and created head differ`);
    }
    if (
      comment.target.kind === "document" &&
      comment.target.documentKind === "pull-request-markdown"
    ) {
      const markdown = `# ${fixture.pullRequest.latestTitle}\n\n${fixture.pullRequest.latestBody}`;
      if (comment.target.sourceDocumentHash !== hashDocument(markdown))
        fail(`${comment.ref} has stale PR hash`);
      const selected = markdown
        .split("\n")
        .slice(comment.target.startLine - 1, comment.target.endLine)
        .join("\n");
      if (selected !== comment.target.quotedText) fail(`${comment.ref} PR quote does not match`);
    }
    if (comment.target.kind === "walkthrough") {
      const walkthrough = fixture.walkthroughs.find(
        (candidate) => candidate.id === comment.target.walkthroughId,
      );
      if (!walkthrough) fail(`${comment.ref} targets a missing walkthrough`);
      const selected = walkthrough.body
        .split("\n")
        .slice(comment.target.startLine - 1, comment.target.endLine)
        .join("\n");
      if (selected !== comment.target.quotedText)
        fail(`${comment.ref} walkthrough quote does not match`);
    }
  }
  const renameComment = fixture.comments.find(
    (comment) => comment.id === fixture.manifest.rename.commentId,
  );
  if (
    !renameComment ||
    renameComment.target.kind !== "document" ||
    renameComment.target.documentKind !== "repository-file"
  )
    fail("rename comment is missing");
  if (
    fixture.resolvePathAt(
      renameComment.target.sourceOid,
      fixture.manifest.rename.oldPath,
      fixture.headOid,
    ) !== fixture.manifest.rename.newPath
  )
    fail("rename comment does not follow the Git rename");
  const deletedComment = fixture.comments.find(
    (comment) => comment.id === fixture.manifest.deleted.commentId,
  );
  if (
    !deletedComment ||
    deletedComment.target.kind !== "document" ||
    deletedComment.target.documentKind !== "repository-file"
  )
    fail("deleted comment is missing");
  if (
    fixture.resolvePathAt(
      deletedComment.target.sourceOid,
      fixture.manifest.deleted.path,
      fixture.headOid,
    ) !== null
  )
    fail("deleted comment is not outdated at head");
  const structureMatches = fixture.structures.filter((structure) =>
    structure.nodes.some(
      (structureNode) => structureNode.anchor?.path === fixture.manifest.multiStructurePath,
    ),
  );
  if (structureMatches.length < 2)
    fail("shared source must be discoverable from multiple Structures");
  if (
    fixture.repositoryDocumentAt(fixture.headOid, "missing/not-present.ts").availability !==
    "missing"
  )
    fail("missing path contract is broken");
}

export function readRealisticFixtureManifest() {
  const fixture = createRealisticFixture();
  try {
    return structuredClone(fixture.manifest);
  } finally {
    fixture.cleanup();
  }
}
