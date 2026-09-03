import {
  source,
  walkthroughRepositorySources as orderServiceSources,
} from "../order-service/order-service-sources.mjs";

const fullStackPlaceholderPaths = [
  "migrations/021_order_detail_view.sql",
  "src/application/orders/get-order-detail.ts",
  "src/frontend/api/orders.ts",
  "src/frontend/orders/OrderDetailError.tsx",
  "src/frontend/orders/OrderDetailPage.tsx",
  "src/frontend/orders/OrderLineItems.tsx",
  "src/frontend/orders/OrderStatusBadge.tsx",
  "src/frontend/orders/OrderSummaryCard.tsx",
  "src/frontend/orders/use-order-detail.ts",
  "src/frontend/query/query-client.ts",
  "src/http/controllers/order-detail.ts",
  "src/http/presenters/order-detail.ts",
  "src/http/routes/order-detail.ts",
  "src/http/schemas/order-detail.ts",
  "src/infrastructure/db/order-read-repository.ts",
  "src/shared/contracts/order-detail.ts",
];

const supportingSources = {
  ".github/workflows/ci.yml": "name: CI\non: [push]\njobs: {}\n",
  ".github/workflows/deploy.yml": "name: Deploy\non: [workflow_dispatch]\njobs: {}\n",
  "README.md": source(`
# Orders service

Contract fixture for reviewing resilient order placement.
  `),
  "docs/architecture.md": source(`
# Architecture

The application layer coordinates domain decisions and infrastructure ports.
  `),
  "docs/runbooks/payment-reconciliation.md": source(`
# Payment reconciliation

Retry ambiguous provider states and void only confirmed orphan authorizations.
  `),
  "docs/runbooks/stuck-outbox.md": source(`
# Stuck outbox

Inspect lease progress and the oldest unpublished event before scaling workers.
  `),
  "src/infrastructure/telemetry/tracing.ts": source(`
export function traceOperation<T>(operation: () => T): T {
  return operation();
}
  `),
  "src/server.ts": source(`
export { application } from "./bootstrap/application.js";
  `),
  "test/support/api-client.ts": source(`
export const apiOrigin = "http://127.0.0.1:3000";
  `),
  "test/support/integration-harness.ts": source(`
export const integrationHarness = { database: "isolated" } as const;
  `),
  "test/unit/order.test.ts": source(`
import { describe, expect, it } from "vitest";
import { Order } from "../../src/domain/orders/order.js";

describe("Order", () => {
  it("exposes the placement factory", () => expect(typeof Order.place).toBe("function"));
});
  `),
  "test/unit/pricing.test.ts": source(`
import { describe, expect, it } from "vitest";
import { calculateOrderTotal } from "../../src/domain/orders/pricing.js";

describe("pricing", () => {
  it("exposes the total calculator", () => expect(typeof calculateOrderTotal).toBe("function"));
});
  `),
  "tsconfig.json": `${JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
      },
      include: ["src/**/*.ts", "test/**/*.ts"],
    },
    null,
    2,
  )}\n`,
  "vite.config.ts": source(`
export default { server: { port: 3000 } };
  `),
};

const fullStackPlaceholders = Object.fromEntries(
  fullStackPlaceholderPaths.map((filePath) => [
    filePath,
    [
      `// Full-stack Structure demonstration source: ${filePath}`,
      ...Array.from(
        { length: 47 },
        (_, index) => `export const demonstrationLine${index + 2} = ${index + 2};`,
      ),
      "",
    ].join("\n"),
  ]),
);

const coherentSupportingSources = {
  "src/application/errors.ts": source(`
export class ForbiddenError extends Error {}
export class InventoryUnavailableError extends Error {}
export class PaymentDeclinedError extends Error {}
  `),
  "src/application/authorization/actor.ts": source(`
export interface Actor {
  subject: string;
  organizationId: string;
  customerScope: "all" | string;
  permissions: Set<string>;
}
  `),
  "src/application/orders/idempotency-policy.ts": source(`
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
  "src/application/ports.ts": source(`
import type { DomainEvent } from "../domain/events.js";
import type { Order } from "../domain/orders/order.js";
import type { IdempotencyEnvelope } from "./orders/idempotency-policy.js";

export interface DbTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface CatalogItem { sku: string; unitPrice: number; currency: string; }
export interface CatalogPort { getBySkus(skus: string[]): Promise<CatalogItem[]>; }
export interface InventoryPort {
  reserve(lines: Array<{ sku: string; quantity: number }>): Promise<{ id: string }>;
}
export interface AuthorizationInput {
  orderId: string;
  paymentMethodId: string;
  amount: { amount: number; currency: string };
}
export type AuthorizationState =
  | "voidable"
  | "already-voided"
  | "captured"
  | "pending"
  | "unknown";
export interface PaymentPort {
  authorize(input: AuthorizationInput): Promise<{ id: string }>;
  getAuthorization(authorizationId: string): Promise<{ state: AuthorizationState }>;
  voidAuthorization(authorizationId: string): Promise<void>;
}
export interface OrderRepositoryPort {
  insert(order: Order, transaction: DbTransaction): Promise<void>;
  findById(orderId: string): Promise<ReturnType<Order["toSnapshot"]> | null>;
  findByPaymentAuthorization(authorizationId: string): Promise<unknown | null>;
}
export interface PaymentRecoveryCandidatePort {
  register(authorizationId: string, transaction?: DbTransaction): Promise<void>;
  leaseNextCandidate(leaseSeconds: number): Promise<{ authorizationId: string } | null>;
  complete(authorizationId: string, transaction?: DbTransaction): Promise<void>;
}
export interface IdempotencyOperationContext {
  operationId: string;
  runTransaction<T>(
    work: (
      transaction: DbTransaction,
      complete: (result: unknown) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}
export interface ApplicationPorts {
  idempotency: {
    run<T>(
      envelope: IdempotencyEnvelope | undefined,
      work: (context: IdempotencyOperationContext) => Promise<T>,
    ): Promise<T>;
  };
  catalog: CatalogPort;
  inventory: InventoryPort;
  payments: PaymentPort;
  paymentRecoveryCandidates: PaymentRecoveryCandidatePort;
  transaction: { run<T>(work: (transaction: DbTransaction) => Promise<T>): Promise<T> };
  orders: OrderRepositoryPort;
  outbox: { append(events: DomainEvent[], transaction: DbTransaction): Promise<void> };
  telemetry: { record(context: Record<string, string | undefined>): void };
}
  `),
  "src/bootstrap/config.ts": source(`
export const config = {
  inventoryUrl: "http://inventory.internal",
  reconciliationLeaseSeconds: 60,
  recoveryGraceSeconds: 300,
} as const;
  `),
  "src/bootstrap/database.ts": source(`
import type { Pool } from "pg";
export const pool = null as unknown as Pool;
  `),
  "src/domain/events.ts": source(`
export interface DomainEvent {
  type: "order.placed" | "payment.authorized";
  aggregateId: string;
  payload: Record<string, unknown>;
}
  `),
  "src/http/controllers/get-order.ts": source(`
import type { Context } from "hono";
export async function getOrderController(context: Context) {
  return context.json({ orderId: context.req.param("orderId") }, 200);
}
  `),
  "src/infrastructure/auth/jwt-verifier.ts": source(`
export async function verifyAccessToken(token: string) {
  if (!token) throw new Error("access token is required");
  return { sub: "service-account", org: "acme", customerScope: "all", permissions: ["orders:create"] };
}
  `),
  "src/infrastructure/catalog/http-catalog-client.ts": source(`
import type { CatalogPort } from "../../application/ports.js";
export const catalogClient: CatalogPort = {
  async getBySkus(skus) {
    return skus.map((sku) => ({ sku, unitPrice: 1200, currency: "USD" }));
  },
};
  `),
  "src/infrastructure/events/event-bus.ts": source(`
export interface EventBus {
  publish(event: { id: string; type: string; payload: unknown }): Promise<void>;
}
  `),
  "src/infrastructure/payments/stripe-client.ts": source(`
export const stripeClient = {
  paymentIntents: {
    async create() { return { id: "pi_configured", status: "requires_capture" }; },
    async retrieve(id: string) { return { id, status: "requires_capture" }; },
    async cancel() {},
  },
};
  `),
  "src/telemetry/order-logger.ts": source(`
export function orderLogContext(input: Record<string, string | undefined>) {
  return { ...input, component: "order-placement" };
}

const records: Array<Record<string, string | undefined>> = [];
export const orderTelemetry = {
  record(context: Record<string, string | undefined>) { records.push({ ...context }); },
  snapshot() { return records.map((context) => ({ ...context })); },
};
  `),
  "src/telemetry/order-metrics.ts": source(`
export const orderMetrics = {
  outboxLag: "outbox.oldest_unpublished_age_seconds",
  measurements: [] as number[],
  recordOutboxLag(seconds: number) { this.measurements.push(seconds); },
} as const;
  `),
  "src/edge-only-evidence.ts": source(`
export const edgeOnlyEvidence = true;
  `),
};

/** @type {Readonly<Record<string, string>>} */
export const contractRepositorySources = {
  ...supportingSources,
  ...fullStackPlaceholders,
  ...orderServiceSources,
  ...coherentSupportingSources,
};

export const contractRepositoryPaths = Object.keys(contractRepositorySources).sort();

/**
 * @param {string} filePath
 * @returns {string}
 */
export function contractRepositoryText(filePath) {
  const text = contractRepositorySources[filePath];
  if (text === undefined) throw new Error(`unknown contract repository path: ${filePath}`);
  return text;
}
