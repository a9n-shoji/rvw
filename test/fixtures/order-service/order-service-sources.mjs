/** @param {string} value */
export const source = (value) => `${value.trim()}\n`;

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
      customerScope: claims.customerScope ?? "all",
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
import { idempotencyEnvelope } from "./idempotency-policy.js";
import type { CreateOrderCommand, CreateOrderResult } from "./types.js";
import type { ApplicationPorts } from "../ports.js";

export class CreateOrderHandler {
  constructor(private readonly ports: ApplicationPorts) {}

  async execute(command: CreateOrderCommand): Promise<CreateOrderResult> {
    assertCanCreateOrder(command.actor, command.customerId);
    const envelope = command.idempotencyKey
      ? idempotencyEnvelope(command.idempotencyKey, command.actor.subject)
      : undefined;

    return this.ports.idempotency.run(envelope, async () => {
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
    return {
      id: this.id,
      status: this.status,
      total: this.total,
      paymentAuthorizationId: this.paymentAuthorizationId,
    };
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
import type { AuthorizationInput } from "../../application/ports.js";
import { PaymentDeclinedError } from "../../application/errors.js";

interface StripeClient {
  paymentIntents: {
    create(
      input: Record<string, unknown>,
      options: { idempotencyKey: string },
    ): Promise<{ id: string; status: string }>;
    retrieve(id: string): Promise<{ id: string; status: string }>;
    cancel(id: string): Promise<void>;
  };
}

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

  async getAuthorization(authorizationId: string) {
    return await this.stripe.paymentIntents.retrieve(authorizationId);
  }

  async voidAuthorization(authorizationId: string): Promise<void> {
    await this.stripe.paymentIntents.cancel(authorizationId);
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
import type { Pool, PoolClient } from "pg";
import type { Order } from "../../domain/orders/order.js";

export class PostgresOrderRepository {
  constructor(private readonly pool: Pool) {}

  async insert(order: Order, transaction: PoolClient): Promise<void> {
    const snapshot = order.toSnapshot();
    await transaction.query(
      "INSERT INTO orders (id, status, total_amount, currency, payment_authorization_id) VALUES ($1, $2, $3, $4, $5)",
      [
        snapshot.id,
        snapshot.status,
        snapshot.total.amount,
        snapshot.total.currency,
        snapshot.paymentAuthorizationId,
      ],
    );
  }

  async findById(orderId: string, transaction: PoolClient) {
    const result = await transaction.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    return result.rows[0] ?? null;
  }

  async findByPaymentAuthorization(authorizationId: string) {
    const result = await this.pool.query(
      "SELECT * FROM orders WHERE payment_authorization_id = $1",
      [authorizationId],
    );
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const events = await client.query(
        "SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED",
      );
      for (const event of events.rows) {
        await this.bus.publish({ id: event.id, type: event.type, payload: event.payload });
        await client.query("UPDATE outbox_events SET published_at = now() WHERE id = $1", [event.id]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
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
import { config } from "./config.js";
import { catalogClient } from "../infrastructure/catalog/http-catalog-client.js";
import { stripeClient } from "../infrastructure/payments/stripe-client.js";
import { CreateOrderHandler } from "../application/orders/create-order.js";
import { PostgresOrderRepository } from "../infrastructure/db/order-repository.js";
import { PostgresIdempotencyStore } from "../infrastructure/db/idempotency-store.js";
import { PostgresOutbox } from "../infrastructure/events/postgres-outbox.js";
import { TransactionRunner } from "../infrastructure/db/transaction.js";
import { StripeGateway } from "../infrastructure/payments/stripe-gateway.js";
import { HttpInventoryClient } from "../infrastructure/inventory/http-inventory-client.js";

const ports = {
  orders: new PostgresOrderRepository(pool),
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

  it("rolls back both the order and outbox records when the outbox write fails", async () => {
    const harness = await createIntegrationHarness();
    harness.outbox.failNextAppend();
    await expect(harness.createOrder.execute(harness.validCommand())).rejects.toThrow(
      "outbox unavailable",
    );
    expect(await harness.orders.all()).toEqual([]);
    expect(await harness.outbox.pendingTypes()).toEqual([]);
  });
});
  `),
  "test/contract/order-api.test.ts": source(`
import { describe, expect, it } from "vitest";
import { apiClient } from "../support/api-client.js";

const validPayload = () => ({
  customerId: "00000000-0000-4000-8000-000000000001",
  paymentMethodId: "pm_test",
  lines: [{ sku: "sku-1", quantity: 1 }],
});

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
  payment_authorization_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  response jsonb NOT NULL,
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
