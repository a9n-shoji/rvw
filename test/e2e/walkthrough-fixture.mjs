const pullRequestId = "11111111-1111-4111-8111-111111111111";
const sourceOid = "c".repeat(40);

/** @param {string} value */
const source = (value) => `${value.trim()}\n`;

/** @type {Record<string, string>} */
export const walkthroughRepositorySources = {
  "docs/order-workflow.md": source(`
# Order workflow

The order workflow crosses authentication, inventory, payment, persistence, and asynchronous event delivery.

## Failure model

Inventory reservations and payment authorizations are remote side effects. The idempotency envelope and reconciliation worker make retries explicit without hiding partial failure.
  `),
  "src/http/routes/orders.ts": source(`
import { Hono } from "hono";
import { requireActor } from "../middleware/require-actor.js";
import { createOrderController } from "../controllers/create-order.js";
import { getOrderController } from "../controllers/get-order.js";

export function orderRoutes() {
  const routes = new Hono();

  routes.use("*", requireActor());
  routes.post("/", createOrderController);
  routes.get("/:orderId", getOrderController);

  return routes;
}
  `),
  "src/http/controllers/create-order.ts": source(`
import type { Context } from "hono";
import { createOrderSchema } from "../schemas/create-order.js";
import { application } from "../../bootstrap/application.js";

export async function createOrderController(context: Context) {
  const actor = context.get("actor");
  const request = createOrderSchema.parse(await context.req.json());
  const idempotencyKey = context.req.header("idempotency-key");

  const result = await application.createOrder.execute({
    actor,
    idempotencyKey,
    customerId: request.customerId,
    lines: request.lines,
    paymentMethodId: request.paymentMethodId,
  });

  return context.json({ order: result.order }, 201);
}
  `),
  "src/http/middleware/require-actor.ts": source(`
import type { MiddlewareHandler } from "hono";
import { verifyAccessToken } from "../../infrastructure/auth/jwt-verifier.js";

export function requireActor(): MiddlewareHandler {
  return async (context, next) => {
    const header = context.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return context.json({ error: "unauthorized" }, 401);

    const claims = await verifyAccessToken(token);
    context.set("actor", {
      subject: claims.sub,
      organizationId: claims.org,
      permissions: new Set(claims.permissions),
    });
    await next();
  };
}
  `),
  "src/http/schemas/create-order.ts": source(`
import { z } from "zod";

export const createOrderSchema = z.object({
  customerId: z.string().uuid(),
  paymentMethodId: z.string().min(1),
  lines: z.array(
    z.object({
      sku: z.string().min(1),
      quantity: z.number().int().positive().max(50),
    }),
  ).min(1).max(100),
});
  `),
  "src/application/orders/create-order.ts": source(`
import { Order } from "../../domain/orders/order.js";
import { assertCanCreateOrder } from "../authorization/order-policy.js";
import type { CreateOrderCommand, CreateOrderResult } from "./types.js";
import type { ApplicationPorts } from "../ports.js";

export class CreateOrderHandler {
  constructor(private readonly ports: ApplicationPorts) {}

  async execute(command: CreateOrderCommand): Promise<CreateOrderResult> {
    assertCanCreateOrder(command.actor, command.customerId);

    return this.ports.idempotency.run(command.idempotencyKey, async () => {
      const catalogItems = await this.ports.catalog.getBySkus(
        command.lines.map((line) => line.sku),
      );
      const reservation = await this.ports.inventory.reserve(command.lines);
      const order = Order.place({
        customerId: command.customerId,
        lines: command.lines,
        catalogItems,
        reservationId: reservation.id,
      });

      const authorization = await this.ports.payments.authorize({
        orderId: order.id,
        paymentMethodId: command.paymentMethodId,
        amount: order.total,
      });
      order.recordPaymentAuthorization(authorization.id);

      await this.ports.transaction.run(async (transaction) => {
        await this.ports.orders.insert(order, transaction);
        await this.ports.outbox.append(order.releaseEvents(), transaction);
      });

      return { order: order.toSnapshot() };
    });
  }
}
  `),
  "src/application/orders/types.ts": source(`
import type { Actor } from "../authorization/actor.js";

export interface CreateOrderCommand {
  actor: Actor;
  idempotencyKey?: string;
  customerId: string;
  paymentMethodId: string;
  lines: Array<{ sku: string; quantity: number }>;
}

export interface CreateOrderResult {
  order: {
    id: string;
    status: "placed";
    total: { amount: number; currency: string };
  };
}
  `),
  "src/application/authorization/order-policy.ts": source(`
import type { Actor } from "./actor.js";
import { ForbiddenError } from "../errors.js";

export function assertCanCreateOrder(actor: Actor, customerId: string): void {
  if (!actor.permissions.has("orders:create")) {
    throw new ForbiddenError("orders:create is required");
  }
  if (actor.customerScope !== "all" && actor.customerScope !== customerId) {
    throw new ForbiddenError("customer is outside the actor scope");
  }
}

export function assertCanReadOrder(actor: Actor, organizationId: string): void {
  if (actor.organizationId !== organizationId) {
    throw new ForbiddenError("organization boundary violation");
  }
}
  `),
  "src/domain/orders/order.ts": source(`
import { randomUUID } from "node:crypto";
import { calculateOrderTotal } from "./pricing.js";
import type { DomainEvent } from "../events.js";

export class Order {
  readonly id = randomUUID();
  readonly status = "placed" as const;
  readonly total;
  private paymentAuthorizationId: string | null = null;
  private readonly events: DomainEvent[] = [];

  private constructor(private readonly state: OrderState) {
    this.total = calculateOrderTotal(state.lines, state.catalogItems);
    this.events.push({
      type: "order.placed",
      aggregateId: this.id,
      payload: { customerId: state.customerId, total: this.total },
    });
  }

  static place(state: OrderState): Order {
    if (state.lines.length === 0) throw new Error("order requires at least one line");
    return new Order(state);
  }

  recordPaymentAuthorization(authorizationId: string): void {
    this.paymentAuthorizationId = authorizationId;
    this.events.push({
      type: "payment.authorized",
      aggregateId: this.id,
      payload: { authorizationId },
    });
  }

  releaseEvents(): DomainEvent[] {
    return this.events.splice(0, this.events.length);
  }

  toSnapshot() {
    return { id: this.id, status: this.status, total: this.total };
  }
}

interface OrderState {
  customerId: string;
  reservationId: string;
  lines: Array<{ sku: string; quantity: number }>;
  catalogItems: Array<{ sku: string; unitPrice: number; currency: string }>;
}
  `),
  "src/domain/orders/pricing.ts": source(`
export function calculateOrderTotal(
  lines: Array<{ sku: string; quantity: number }>,
  catalogItems: Array<{ sku: string; unitPrice: number; currency: string }>,
) {
  const prices = new Map(catalogItems.map((item) => [item.sku, item]));
  const currency = catalogItems[0]?.currency ?? "USD";
  const amount = lines.reduce((total, line) => {
    const item = prices.get(line.sku);
    if (!item) throw new Error("catalog item not found: " + line.sku);
    if (item.currency !== currency) throw new Error("mixed currencies are not supported");
    return total + item.unitPrice * line.quantity;
  }, 0);
  return { amount, currency };
}
  `),
  "src/infrastructure/inventory/http-inventory-client.ts": source(`
import type { InventoryPort } from "../../application/ports.js";
import { InventoryUnavailableError } from "../../application/errors.js";

export class HttpInventoryClient implements InventoryPort {
  constructor(private readonly baseUrl: string, private readonly fetchImpl = fetch) {}

  async reserve(lines: Array<{ sku: string; quantity: number }>) {
    const response = await this.fetchImpl(this.baseUrl + "/v1/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines }),
      signal: AbortSignal.timeout(2500),
    });
    if (response.status === 409) throw new InventoryUnavailableError();
    if (!response.ok) throw new Error("inventory returned " + response.status);
    return await response.json();
  }
}
  `),
  "src/infrastructure/payments/stripe-gateway.ts": source(`
import type { PaymentPort } from "../../application/ports.js";
import { PaymentDeclinedError } from "../../application/errors.js";

export class StripeGateway implements PaymentPort {
  constructor(private readonly stripe: StripeClient) {}

  async authorize(input: AuthorizationInput) {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amount.amount,
        currency: input.amount.currency,
        payment_method: input.paymentMethodId,
        capture_method: "manual",
        confirm: true,
        metadata: { orderId: input.orderId },
      },
      { idempotencyKey: "order-auth:" + input.orderId },
    );
    if (intent.status !== "requires_capture") throw new PaymentDeclinedError();
    return { id: intent.id };
  }
}
  `),
  "src/infrastructure/db/transaction.ts": source(`
import type { Pool, PoolClient } from "pg";

export class TransactionRunner {
  constructor(private readonly pool: Pool) {}

  async run<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
  `),
  "src/infrastructure/db/order-repository.ts": source(`
import type { PoolClient } from "pg";
import type { Order } from "../../domain/orders/order.js";

export class PostgresOrderRepository {
  async insert(order: Order, transaction: PoolClient): Promise<void> {
    const snapshot = order.toSnapshot();
    await transaction.query(
      "INSERT INTO orders (id, status, total_amount, currency) VALUES ($1, $2, $3, $4)",
      [snapshot.id, snapshot.status, snapshot.total.amount, snapshot.total.currency],
    );
  }

  async findById(orderId: string, transaction: PoolClient) {
    const result = await transaction.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    return result.rows[0] ?? null;
  }
}
  `),
  "src/infrastructure/db/idempotency-store.ts": source(`
import type { Pool } from "pg";

export class PostgresIdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async run<T>(key: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (!key) return await operation();
    const cached = await this.pool.query("SELECT response FROM idempotency_keys WHERE key = $1", [key]);
    if (cached.rowCount) return cached.rows[0].response as T;

    const result = await operation();
    await this.pool.query(
      "INSERT INTO idempotency_keys (key, response) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [key, result],
    );
    return result;
  }
}
  `),
  "src/infrastructure/events/postgres-outbox.ts": source(`
import type { PoolClient } from "pg";
import type { DomainEvent } from "../../domain/events.js";

export class PostgresOutbox {
  async append(events: DomainEvent[], transaction: PoolClient): Promise<void> {
    for (const event of events) {
      await transaction.query(
        "INSERT INTO outbox_events (id, type, aggregate_id, payload) VALUES (gen_random_uuid(), $1, $2, $3)",
        [event.type, event.aggregateId, event.payload],
      );
    }
  }
}
  `),
  "src/workers/outbox-dispatcher.ts": source(`
import type { Pool } from "pg";
import type { EventBus } from "../infrastructure/events/event-bus.js";

export class OutboxDispatcher {
  constructor(private readonly pool: Pool, private readonly bus: EventBus) {}

  async tick(): Promise<void> {
    const events = await this.pool.query(
      "SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED",
    );
    for (const event of events.rows) {
      await this.bus.publish(event.type, event.payload);
      await this.pool.query("UPDATE outbox_events SET published_at = now() WHERE id = $1", [event.id]);
    }
  }
}
  `),
  "src/workers/payment-reconciliation.ts": source(`
import type { PaymentPort, OrderRepositoryPort } from "../application/ports.js";

export class PaymentReconciliationWorker {
  constructor(private readonly payments: PaymentPort, private readonly orders: OrderRepositoryPort) {}

  async reconcile(authorizationId: string): Promise<void> {
    const payment = await this.payments.getAuthorization(authorizationId);
    const order = await this.orders.findByPaymentAuthorization(authorizationId);
    if (!order && payment.status === "authorized") {
      await this.payments.voidAuthorization(authorizationId);
    }
  }
}
  `),
  "src/bootstrap/application.ts": source(`
import { pool } from "./database.js";
import { CreateOrderHandler } from "../application/orders/create-order.js";
import { PostgresOrderRepository } from "../infrastructure/db/order-repository.js";
import { PostgresIdempotencyStore } from "../infrastructure/db/idempotency-store.js";
import { PostgresOutbox } from "../infrastructure/events/postgres-outbox.js";
import { TransactionRunner } from "../infrastructure/db/transaction.js";
import { StripeGateway } from "../infrastructure/payments/stripe-gateway.js";
import { HttpInventoryClient } from "../infrastructure/inventory/http-inventory-client.js";

const ports = {
  orders: new PostgresOrderRepository(),
  idempotency: new PostgresIdempotencyStore(pool),
  outbox: new PostgresOutbox(),
  transaction: new TransactionRunner(pool),
  payments: new StripeGateway(stripeClient),
  inventory: new HttpInventoryClient(config.inventoryUrl),
  catalog: catalogClient,
};

export const application = {
  createOrder: new CreateOrderHandler(ports),
};
  `),
  "test/integration/create-order.test.ts": source(`
import { describe, expect, it } from "vitest";
import { createIntegrationHarness } from "../support/integration-harness.js";

describe("CreateOrderHandler", () => {
  it("persists the order and publishes events after authorization", async () => {
    const harness = await createIntegrationHarness();
    const result = await harness.createOrder.execute(harness.validCommand());
    expect(result.order.status).toBe("placed");
    expect(await harness.orders.findById(result.order.id)).not.toBeNull();
    expect(await harness.outbox.pendingTypes()).toEqual(["order.placed", "payment.authorized"]);
  });

  it("returns the original result for a repeated idempotency key", async () => {
    const harness = await createIntegrationHarness();
    const command = harness.validCommand({ idempotencyKey: "checkout-42" });
    const first = await harness.createOrder.execute(command);
    const second = await harness.createOrder.execute(command);
    expect(second).toEqual(first);
    expect(harness.payments.authorizeCalls).toHaveLength(1);
  });
});
  `),
  "test/contract/order-api.test.ts": source(`
import { describe, expect, it } from "vitest";
import { apiClient } from "../support/api-client.js";

describe("POST /orders", () => {
  it("requires an authenticated actor", async () => {
    const response = await apiClient.post("/orders", { lines: [] });
    expect(response.status).toBe(401);
  });

  it("returns the stable placed order representation", async () => {
    const response = await apiClient.asOrderWriter().post("/orders", validPayload());
    expect(response.status).toBe(201);
    expect(response.body.order).toMatchObject({ status: "placed" });
  });
});
  `),
  "migrations/018_orders_and_outbox.sql": source(`
CREATE TABLE orders (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  total_amount integer NOT NULL,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX outbox_pending_idx ON outbox_events (created_at) WHERE published_at IS NULL;
  `),
};

const supportingPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",
  "README.md",
  "docs/architecture.md",
  "docs/runbooks/payment-reconciliation.md",
  "docs/runbooks/stuck-outbox.md",
  "src/application/errors.ts",
  "src/application/ports.ts",
  "src/application/authorization/actor.ts",
  "src/bootstrap/config.ts",
  "src/bootstrap/database.ts",
  "src/domain/events.ts",
  "src/http/controllers/get-order.ts",
  "src/infrastructure/auth/jwt-verifier.ts",
  "src/infrastructure/catalog/http-catalog-client.ts",
  "src/infrastructure/events/event-bus.ts",
  "src/infrastructure/telemetry/tracing.ts",
  "src/server.ts",
  "test/support/api-client.ts",
  "test/support/integration-harness.ts",
  "test/unit/order.test.ts",
  "test/unit/pricing.test.ts",
  "tsconfig.json",
  "vite.config.ts",
];

export const walkthroughRepositoryPaths = [
  ...Object.keys(walkthroughRepositorySources),
  ...supportingPaths,
].sort();

/**
 * @param {string} filePath
 * @returns {string}
 */
export function walkthroughRepositoryText(filePath) {
  return (
    walkthroughRepositorySources[filePath] ??
    source(`
// ${filePath}
// Supporting repository document included to make navigation density realistic.

export const moduleName = "${filePath.replaceAll('"', "")}";
export const enabled = true;
    `)
  );
}

/**
 * @param {string} id
 * @param {string} label
 * @param {string} filePath
 * @param {string} needle
 * @param {number} span
 * @param {string} description
 */
function reference(id, label, filePath, needle, span, description) {
  const text = walkthroughRepositoryText(filePath);
  const startLine = text.slice(0, text.indexOf(needle)).split("\n").length;
  if (!text.includes(needle)) throw new Error(`fixture reference not found: ${id}`);
  return {
    id,
    label,
    path: filePath,
    startLine,
    endLine: Math.min(startLine + span, text.split("\n").length - 1),
    description,
  };
}

/**
 * @param {string} id
 * @param {string} label
 * @param {string} filePath
 * @param {string} description
 */
function fileReference(id, label, filePath, description) {
  return {
    id,
    label,
    path: filePath,
    startLine: null,
    endLine: null,
    description,
  };
}

const mainReferences = [
  reference(
    "route",
    "POST /orders route",
    "src/http/routes/orders.ts",
    "routes.post",
    2,
    "HTTP entry point and middleware boundary",
  ),
  reference(
    "controller",
    "createOrderController",
    "src/http/controllers/create-order.ts",
    "export async function createOrderController",
    14,
    "Request parsing and application handoff",
  ),
  reference(
    "schema",
    "createOrderSchema",
    "src/http/schemas/create-order.ts",
    "export const createOrderSchema",
    9,
    "External request shape and limits",
  ),
  reference(
    "actor",
    "requireActor",
    "src/http/middleware/require-actor.ts",
    "export function requireActor",
    13,
    "JWT claims become the application actor",
  ),
  reference(
    "handler",
    "CreateOrderHandler.execute",
    "src/application/orders/create-order.ts",
    "async execute",
    32,
    "The orchestration boundary",
  ),
  fileReference(
    "handler_file",
    "CreateOrderHandler file",
    "src/application/orders/create-order.ts",
    "The complete application handler module",
  ),
  reference(
    "policy",
    "assertCanCreateOrder",
    "src/application/authorization/order-policy.ts",
    "export function assertCanCreateOrder",
    8,
    "Permission and customer-scope checks",
  ),
  reference(
    "command",
    "CreateOrderCommand",
    "src/application/orders/types.ts",
    "export interface CreateOrderCommand",
    7,
    "Internal application input",
  ),
  reference(
    "idempotency",
    "PostgresIdempotencyStore.run",
    "src/infrastructure/db/idempotency-store.ts",
    "async run",
    13,
    "Retry-safe command execution",
  ),
  reference(
    "inventory",
    "HttpInventoryClient.reserve",
    "src/infrastructure/inventory/http-inventory-client.ts",
    "async reserve",
    11,
    "Remote stock reservation and timeout",
  ),
  reference(
    "place",
    "Order.place",
    "src/domain/orders/order.ts",
    "static place",
    4,
    "Aggregate construction and invariant",
  ),
  reference(
    "pricing",
    "calculateOrderTotal",
    "src/domain/orders/pricing.ts",
    "export function calculateOrderTotal",
    13,
    "Currency and total calculation",
  ),
  reference(
    "authorize",
    "StripeGateway.authorize",
    "src/infrastructure/payments/stripe-gateway.ts",
    "async authorize",
    18,
    "Manual-capture payment authorization",
  ),
  reference(
    "payment_event",
    "recordPaymentAuthorization",
    "src/domain/orders/order.ts",
    "recordPaymentAuthorization",
    8,
    "Aggregate records payment state and event",
  ),
  reference(
    "transaction",
    "TransactionRunner.run",
    "src/infrastructure/db/transaction.ts",
    "async run",
    15,
    "Atomic persistence boundary",
  ),
  reference(
    "repository",
    "PostgresOrderRepository.insert",
    "src/infrastructure/db/order-repository.ts",
    "async insert",
    8,
    "Order write inside the shared transaction",
  ),
  reference(
    "outbox",
    "PostgresOutbox.append",
    "src/infrastructure/events/postgres-outbox.ts",
    "async append",
    9,
    "Domain events saved in the same transaction",
  ),
  reference(
    "dispatcher",
    "OutboxDispatcher.tick",
    "src/workers/outbox-dispatcher.ts",
    "async tick",
    10,
    "Asynchronous event publication",
  ),
  fileReference(
    "wiring",
    "application composition",
    "src/bootstrap/application.ts",
    "Concrete adapters wired at startup",
  ),
];

const recoveryReferences = [
  mainReferences.find((item) => item.id === "idempotency"),
  mainReferences.find((item) => item.id === "inventory"),
  mainReferences.find((item) => item.id === "authorize"),
  mainReferences.find((item) => item.id === "transaction"),
  mainReferences.find((item) => item.id === "outbox"),
  mainReferences.find((item) => item.id === "dispatcher"),
  reference(
    "reconcile",
    "PaymentReconciliationWorker",
    "src/workers/payment-reconciliation.ts",
    "async reconcile",
    8,
    "Voids an orphan authorization",
  ),
  reference(
    "outbox_schema",
    "outbox_events schema",
    "migrations/018_orders_and_outbox.sql",
    "CREATE TABLE outbox_events",
    10,
    "Pending work is queryable and durable",
  ),
  reference(
    "retry_test",
    "idempotency integration test",
    "test/integration/create-order.test.ts",
    "returns the original result",
    8,
    "Proves the external authorization runs once",
  ),
].filter(Boolean);

const authReferences = [
  mainReferences.find((item) => item.id === "route"),
  mainReferences.find((item) => item.id === "actor"),
  mainReferences.find((item) => item.id === "schema"),
  mainReferences.find((item) => item.id === "controller"),
  mainReferences.find((item) => item.id === "policy"),
  mainReferences.find((item) => item.id === "command"),
  reference(
    "auth_contract",
    "authentication contract test",
    "test/contract/order-api.test.ts",
    "requires an authenticated actor",
    4,
    "Anonymous requests stop at the HTTP boundary",
  ),
].filter(Boolean);

const testReferences = [
  reference(
    "integration_happy",
    "happy-path integration test",
    "test/integration/create-order.test.ts",
    "persists the order",
    8,
    "Covers authorization through transactional outbox",
  ),
  reference(
    "integration_retry",
    "retry integration test",
    "test/integration/create-order.test.ts",
    "returns the original result",
    8,
    "Covers idempotency under repeated delivery",
  ),
  reference(
    "contract_auth",
    "authentication contract",
    "test/contract/order-api.test.ts",
    "requires an authenticated actor",
    4,
    "Protects the public API boundary",
  ),
  reference(
    "contract_shape",
    "response contract",
    "test/contract/order-api.test.ts",
    "returns the stable placed",
    5,
    "Protects status and response shape",
  ),
  mainReferences.find((item) => item.id === "place"),
  mainReferences.find((item) => item.id === "pricing"),
  mainReferences.find((item) => item.id === "outbox"),
  recoveryReferences.find((item) => item.id === "reconcile"),
].filter(Boolean);

const showcaseReferences = mainReferences.filter(({ id }) =>
  ["route", "controller", "handler", "transaction", "outbox", "dispatcher"].includes(id),
);

const mermaidBindingReferences = mainReferences.filter(({ id }) =>
  ["route", "controller", "handler", "actor", "transaction", "place", "dispatcher"].includes(id),
);

const markdown = (...lines) => lines.join("\n");

export const walkthroughs = [
  {
    id: "70000000-0000-4000-8000-000000000001",
    ref: "rvw://walkthrough/70000000-0000-4000-8000-000000000001",
    pullRequestId,
    sourceOid,
    title: "注文作成フロー：HTTPからtransactional outboxまで",
    authorLabel: "Codex · implementation walkthrough",
    createdAt: "2026-08-09T04:24:00.000Z",
    references: mainReferences,
    diagramBindings: {
      Route: "route",
      Controller: "controller",
      Handler: "handler",
      Inventory: "inventory",
      Order: "place",
      Payment: "authorize",
      Transaction: "transaction",
      Outbox: "outbox",
      Worker: "dispatcher",
    },
    body: markdown(
      "# 注文作成フローの全体像",
      "",
      "> この文書は Agent が実装時点の commit を source anchor として生成した説明です。リンクや図の node を選ぶまで、rvw の表示位置は変わりません。選ぶと、rvw は現在のPR上の対応箇所を開きます。",
      "",
      "この変更は、注文作成を単なる HTTP handler ではなく、**認可・在庫確保・決済与信・永続化・event 配信**までを一つの application flow として組み立てています。入口は [POST /orders](rvw-ref:route) で、payload は [createOrderSchema](rvw-ref:schema) によって境界で確定します。",
      "",
      "```mermaid",
      "flowchart LR",
      "  Route[POST /orders] --> Controller[Controller]",
      "  Controller --> Handler[CreateOrderHandler]",
      "  Handler --> Inventory[Reserve inventory]",
      "  Handler --> Order[Place aggregate]",
      "  Handler --> Payment[Authorize payment]",
      "  Handler --> Transaction[DB transaction]",
      "  Transaction --> Outbox[Transactional outbox]",
      "  Outbox -. async .-> Worker[Dispatcher]",
      "```",
      "",
      "## 1. 外部入力を application command に変換する",
      "",
      "[requireActor](rvw-ref:actor) が token claims を `Actor` に変換し、[createOrderController](rvw-ref:controller) はその actor と検証済み request を [CreateOrderCommand](rvw-ref:command) にまとめます。HTTP の型や Hono の `Context` は application layer より内側へ入りません。",
      "",
      "ここで重要なのは、認証済みであることと注文を作成できることを分けている点です。business permission と customer scope は [assertCanCreateOrder](rvw-ref:policy) が application boundary で検証します。",
      "",
      "## 2. orchestration と domain decision を分ける",
      "",
      "[CreateOrderHandler.execute](rvw-ref:handler) は処理順を管理しますが、金額計算や aggregate invariant 自体は持ちません。retry は [PostgresIdempotencyStore.run](rvw-ref:idempotency) で包み、外部副作用の重複を抑えます。",
      "",
      "在庫は [HttpInventoryClient.reserve](rvw-ref:inventory) で 2.5 秒の timeout を設けて先に確保します。その後 [Order.place](rvw-ref:place) が aggregate を生成し、[calculateOrderTotal](rvw-ref:pricing) が SKU と通貨の整合性を検証します。",
      "",
      "## 3. 決済と永続化の不一致を閉じ込める",
      "",
      "[StripeGateway.authorize](rvw-ref:authorize) は capture せず与信だけを作ります。成功した authorization は [recordPaymentAuthorization](rvw-ref:payment_event) で aggregate と domain event に反映されます。",
      "",
      "DB 内では [TransactionRunner.run](rvw-ref:transaction) の同じ transaction client を使って、[PostgresOrderRepository.insert](rvw-ref:repository) と [PostgresOutbox.append](rvw-ref:outbox) を一緒に commit します。これにより『注文だけ保存され event が消える』状態は作りません。",
      "",
      "## 4. commit 後の非同期処理",
      "",
      "[OutboxDispatcher.tick](rvw-ref:dispatcher) が未送信 event を `FOR UPDATE SKIP LOCKED` で取得します。複数 worker でも一つの row を同時処理せず、publish 完了後に `published_at` を更新します。具体 adapter の組み合わせは [application composition](rvw-ref:wiring) で一望できます。",
      "",
      "### レビュー時に見るべき境界",
      "",
      "1. payment authorization 後、DB commit 前に落ちた場合の補償が運用上十分か。",
      "2. idempotency key が未指定の client を許容する契約でよいか。",
      "3. outbox publish と `published_at` 更新の間の重複配信を consumer が吸収できるか。",
      "",
      "![External walkthrough](https://example.invalid/walkthrough.png)",
    ),
  },
  {
    id: "70000000-0000-4000-8000-000000000002",
    ref: "rvw://walkthrough/70000000-0000-4000-8000-000000000002",
    pullRequestId,
    sourceOid,
    title: "障害とretry：どこまで自動回復できるか",
    authorLabel: "Codex · failure analysis",
    createdAt: "2026-08-09T04:26:00.000Z",
    references: recoveryReferences,
    diagramBindings: {
      Retry: "idempotency",
      Inventory: "inventory",
      Payment: "authorize",
      Tx: "transaction",
      Outbox: "outbox",
      Reconcile: "reconcile",
    },
    body: markdown(
      "# 障害と retry の境界",
      "",
      "注文処理には remote API と local transaction が混在します。ここでは失敗地点ごとに、再試行と補償の責務を追います。",
      "",
      "```mermaid",
      "flowchart TD",
      "  Retry[Idempotency envelope] --> Inventory[Inventory timeout]",
      "  Inventory --> Payment[Payment authorization]",
      "  Payment --> Tx[Order transaction]",
      "  Tx --> Outbox[Durable outbox]",
      "  Payment -. orphan auth .-> Reconcile[Reconciliation]",
      "```",
      "",
      "[PostgresIdempotencyStore.run](rvw-ref:idempotency) は同一 request の application result を再利用します。[HttpInventoryClient.reserve](rvw-ref:inventory) の timeout は明示的ですが、remote 側で reservation が成立して response だけ失われる場合は別途 reservation key が必要です。",
      "",
      "決済成功後に [TransactionRunner.run](rvw-ref:transaction) が rollback したケースは [PaymentReconciliationWorker](rvw-ref:reconcile) が orphan authorization を void します。DB commit 後の event は [PostgresOutbox.append](rvw-ref:outbox) と [OutboxDispatcher.tick](rvw-ref:dispatcher) が引き継ぎます。",
      "",
      "永続的な backlog は [outbox_events schema](rvw-ref:outbox_schema) の partial index で検出可能です。[idempotency integration test](rvw-ref:retry_test) は repeated delivery でも payment call が一度であることを確認します。",
    ),
  },
  {
    id: "70000000-0000-4000-8000-000000000003",
    ref: "rvw://walkthrough/70000000-0000-4000-8000-000000000003",
    pullRequestId,
    sourceOid,
    title: "認証・認可境界：actorが注文に到達するまで",
    authorLabel: "Codex · security walkthrough",
    createdAt: "2026-08-09T04:28:00.000Z",
    references: authReferences,
    diagramBindings: {
      Route: "route",
      Auth: "actor",
      Schema: "schema",
      Controller: "controller",
      Policy: "policy",
    },
    body: markdown(
      "# actor と権限の流れ",
      "",
      "```mermaid",
      "flowchart LR",
      "  Route[Orders route] --> Auth[JWT to Actor]",
      "  Auth --> Schema[Validate body]",
      "  Schema --> Controller[Build command]",
      "  Controller --> Policy[Permission and scope]",
      "```",
      "",
      "[POST /orders route](rvw-ref:route) は全 handler より前に [requireActor](rvw-ref:actor) を通します。外部 payload は [createOrderSchema](rvw-ref:schema)、内部の identity と permission は [CreateOrderCommand](rvw-ref:command) に分かれます。",
      "",
      "[createOrderController](rvw-ref:controller) 自体は permission を判断せず、[assertCanCreateOrder](rvw-ref:policy) が use case の直前で `orders:create` と customer scope を検証します。[authentication contract test](rvw-ref:auth_contract) は anonymous request が application layer へ入らないことを固定します。",
    ),
  },
  {
    id: "70000000-0000-4000-8000-000000000004",
    ref: "rvw://walkthrough/70000000-0000-4000-8000-000000000004",
    pullRequestId,
    sourceOid,
    title: "テストマップ：各層で何を保証しているか",
    authorLabel: "Codex · class diagram",
    createdAt: "2026-08-09T04:30:00.000Z",
    references: testReferences,
    diagramBindings: {
      OrderApiContract: "contract_shape",
      CreateOrderTest: "integration_happy",
      Order: "place",
      PostgresOutbox: "outbox",
      PaymentReconciliationWorker: "reconcile",
    },
    body: markdown(
      "# 変更を支えるテストの地図",
      "",
      "```mermaid",
      "classDiagram",
      "  direction LR",
      "  class OrderApiContract {",
      "    +requiresAuthenticatedActor()",
      "    +returnsPlacedOrder()",
      "  }",
      "  class CreateOrderTest {",
      "    +persistsOrderAndOutbox()",
      "    +reusesIdempotentResult()",
      "  }",
      "  class Order {",
      "    +place() Order",
      "    +recordPaymentAuthorization()",
      "    +releaseEvents() DomainEvent[]",
      "  }",
      "  class PostgresOutbox {",
      "    +append(events, transaction)",
      "  }",
      "  class PaymentReconciliationWorker {",
      "    +reconcile()",
      "  }",
      "  OrderApiContract ..> CreateOrderTest : protects boundary",
      "  CreateOrderTest ..> Order : exercises",
      "  CreateOrderTest ..> PostgresOutbox : verifies",
      "  CreateOrderTest ..> PaymentReconciliationWorker : covers recovery",
      "```",
      "",
      "[happy-path integration test](rvw-ref:integration_happy) は order と outbox event の両方を確認します。[retry integration test](rvw-ref:integration_retry) は repeated command による二重与信を防ぎます。",
      "",
      "public boundary は [authentication contract](rvw-ref:contract_auth) と [response contract](rvw-ref:contract_shape)、domain は [Order.place](rvw-ref:place) と [calculateOrderTotal](rvw-ref:pricing) が中心です。非同期の補償は [PaymentReconciliationWorker](rvw-ref:reconcile) まで含めて確認対象になります。",
    ),
  },
  {
    id: "70000000-0000-4000-8000-000000000005",
    ref: "rvw://walkthrough/70000000-0000-4000-8000-000000000005",
    pullRequestId,
    sourceOid,
    title: "Markdown表現デモ：レビューコメントのショーケース",
    authorLabel: "Codex · Markdown showcase",
    createdAt: "2026-08-11T06:30:00.000Z",
    references: showcaseReferences,
    diagramBindings: {
      Request: "route",
      Controller: "controller",
      Handler: "handler",
      Transaction: "transaction",
      Outbox: "outbox",
      Worker: "dispatcher",
    },
    body: markdown(
      "# Markdownレビュー・ショーケース",
      "",
      "> **デモの目的** — rendered Markdown を読みながら、見えている文章を選択して、その元の行範囲へ直接コメントできることを確認します。",
      "",
      "このウォークスルーは **太字**、*斜体*、~~取り消し線~~、`inline code`、[コード参照](rvw-ref:handler) を一つの長めの文書にまとめたダミーです。各表現を選択すると、Markdown source の対応行がコメント対象になります。",
      "",
      "## レビューサマリー",
      "",
      "| 観点 | 状態 | Owner | レビューメモ |",
      "| :--- | :---: | ---: | --- |",
      "| HTTP境界 | ✅ Ready | API | [route](rvw-ref:route) から controller まで入力を限定 |",
      "| transaction | ⚠️ Review | App | DB write と outbox の原子性を重点確認 |",
      "| event配信 | 🧪 Test | Worker | at-least-once 前提で consumer の冪等性を確認 |",
      "",
      "### チェックリスト",
      "",
      "- [x] public API の入力検証を確認した",
      "- [x] transaction と outbox が同じ接続を使う",
      "- [ ] payment成功後の補償運用を runbook に追記する",
      "- [ ] consumer 側の重複イベントtestを追加する",
      "",
      "<details>",
      "<summary>補足：失敗時の確認ポイント（クリックで開閉）</summary>",
      "",
      "折りたたみの中にある文章も、開いている間は通常の本文と同じように選択できます。閉じてもコメント自体は sidebar に残り、再び開けば元の位置に表示されます。",
      "",
      "- inventory timeout の直前・直後で reservation key が安定しているか",
      "- payment authorization と DB rollback の相関IDが追えるか",
      "- outbox backlog の件数・最古時刻をalertに含めるか",
      "",
      "</details>",
      "",
      "## システム全体図",
      "",
      "Mermaid は描画結果の内部テキストではなく、**図全体**が一つのコメント対象です。各 node は対応するコード参照にもなっています。",
      "",
      "```mermaid",
      "flowchart LR",
      "  Request[POST /orders] --> Controller[Validate request]",
      "  Controller --> Handler[CreateOrderHandler]",
      "  Handler --> Transaction[DB transaction]",
      "  Transaction --> Outbox[Transactional outbox]",
      "  Outbox -. async .-> Worker[Event dispatcher]",
      "```",
      "",
      "## 実装の流れ",
      "",
      "1. [POST /orders](rvw-ref:route) が認証済み request を受け取る。",
      "2. [createOrderController](rvw-ref:controller) が payload を application command に変換する。",
      "3. [CreateOrderHandler.execute](rvw-ref:handler) が remote side effect と domain decision を順序づける。",
      "4. [TransactionRunner.run](rvw-ref:transaction) の中で order と [PostgresOutbox.append](rvw-ref:outbox) を永続化する。",
      "5. commit 後は [OutboxDispatcher.tick](rvw-ref:dispatcher) が非同期配信を引き継ぐ。",
      "",
      "### TypeScript例",
      "",
      "```ts",
      "await transaction.run(async (tx) => {",
      "  await orders.insert(order, tx);",
      "  await outbox.append(order.releaseEvents(), tx);",
      "});",
      "```",
      "",
      "### 設定例",
      "",
      "```json",
      "{",
      '  "delivery": "at-least-once",',
      '  "batchSize": 50,',
      '  "timeoutMs": 2500',
      "}",
      "```",
      "",
      "> **レビューのヒント**",
      ">",
      "> 1行だけ選ぶ場合も、複数段落をまたぐ場合も、画面上の選択から source line range を逆引きします。文頭付近で選択してもコメント枠は表示領域の内側へ収まります。",
      "",
      "---",
      "",
      "## 最後に確認したいこと",
      "",
      "- retry可能な失敗と、人手でreconcileすべき失敗の境界は明確か",
      "- Outdatedになったウォークスルーコメントをレビュー履歴として残す方針でよいか",
      "- 図全体コメントから、必要ならコード参照へ迷わず移動できるか",
    ),
  },
  {
    id: "70000000-0000-4000-8000-000000000006",
    ref: "rvw://walkthrough/70000000-0000-4000-8000-000000000006",
    pullRequestId,
    sourceOid,
    title: "Mermaid binding対応図種",
    authorLabel: "Codex · Mermaid binding contract",
    createdAt: "2026-08-30T06:30:00.000Z",
    references: mermaidBindingReferences,
    diagramBindings: {
      service: "route",
      ClassNode: "controller",
      C: "handler",
      U: "actor",
      Draft: "transaction",
      p: "place",
      worker: "dispatcher",
    },
    body: markdown(
      "# Mermaid binding対応図種",
      "",
      "```mermaid",
      "flowchart LR",
      "  service[Service]:::backend --> UnboundFlow[Unbound flow node]",
      "```",
      "",
      "```mermaid",
      "classDiagram",
      "  class ClassNode",
      "  class UnboundClass",
      "  ClassNode --> UnboundClass",
      "```",
      "",
      "```mermaid",
      "sequenceDiagram",
      '  participant C@{ "type": "boundary" } as Controller',
      "  participant S as Service",
      "  actor U as User",
      "  U->>C: request",
      "  C->>S: execute",
      "```",
      "",
      "```mermaid",
      "stateDiagram-v2",
      "  Draft",
      '  state "Submitted" as Submitted',
      "  Draft:::notMoving --> Submitted:::movement : submit",
      "```",
      "",
      "```mermaid",
      "erDiagram",
      "  p[Person] {",
      "    string name",
      "  }",
      "  p 1 to zero or more ORDER : places",
      "  HOUSE",
      "  PERSON:::model,aggregate ||--|| CAR:::vehicle,asset : owns",
      "```",
      "",
      "```mermaid",
      "architecture-beta",
      "  service web(server)[Web]",
      "  service worker(server)[Worker]",
      "  service db(database)[Database]",
      "  web:R -- L:db",
      "  worker:R -- L:db",
      "```",
    ),
  },
];
