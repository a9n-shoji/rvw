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

export function orderRoutes(overrides: { verifyToken?: Parameters<typeof requireActor>[0]; createOrder?: typeof createOrderController } = {}) {
  const routes = new Hono();

  routes.use("*", requireActor(overrides.verifyToken));
  routes.post("/", overrides.createOrder ?? createOrderController);
  routes.get("/:orderId", getOrderController);

  return routes;
}
  `),
  "src/http/controllers/create-order.ts": source(`
import type { Context } from "hono";
import { createOrderSchema } from "../schemas/create-order.js";
import { application } from "../../bootstrap/application.js";

export function createOrderControllerFor(createOrder = application.createOrder) {
  return async function createOrderController(context: Context) {
  const actor = context.get("actor");
  const request = createOrderSchema.parse(await context.req.json());
  const idempotencyKey = context.req.header("idempotency-key");
  const requestId = context.req.header("x-request-id") ?? "request-unknown";

  const result = await createOrder.execute({
    actor,
    requestId,
    idempotencyKey,
    customerId: request.customerId,
    lines: request.lines,
    paymentMethodId: request.paymentMethodId,
  });

  return context.json({ order: result.order }, 201);
  };
}

export const createOrderController = createOrderControllerFor();
  `),
  "src/http/middleware/require-actor.ts": source(`
import type { MiddlewareHandler } from "hono";
import { verifyAccessToken } from "../../infrastructure/auth/jwt-verifier.js";

export function requireActor(verifyToken = verifyAccessToken): MiddlewareHandler {
  return async (context, next) => {
    const header = context.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return context.json({ error: "unauthorized" }, 401);

    const claims = await verifyToken(token);
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
import { orderLogContext } from "../../telemetry/order-logger.js";
import type { CreateOrderCommand, CreateOrderResult } from "./types.js";
import type { ApplicationPorts } from "../ports.js";

export class CreateOrderHandler {
  constructor(private readonly ports: ApplicationPorts) {}

  async execute(command: CreateOrderCommand): Promise<CreateOrderResult> {
    assertCanCreateOrder(command.actor, command.customerId);
    const envelope = command.idempotencyKey
      ? idempotencyEnvelope(command.idempotencyKey, command.actor.subject)
      : undefined;

    return this.ports.idempotency.run(envelope, async ({ operationId, runTransaction }) => {
      const existingResult = await runTransaction(async (transaction, complete) => {
        const existingOrder = await this.ports.orders.findById(operationId, transaction);
        if (existingOrder) {
          const result = { order: existingOrder };
          await complete(result);
          return result;
        }
        return null;
      });
      if (existingResult) {
        return existingResult;
      }
      const catalogItems = await this.ports.catalog.getBySkus(
        command.lines.map((line) => line.sku),
      );
      const reservation = await this.ports.inventory.reserve(command.lines);
      const order = Order.place({
        id: operationId,
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
      await runTransaction(async (transaction) => {
        await this.ports.paymentRecoveryCandidates.register(authorization.id, transaction);
      });
      order.recordPaymentAuthorization(authorization.id);
      this.ports.telemetry.record(orderLogContext({
        requestId: command.requestId,
        orderId: order.id,
        authorizationId: authorization.id,
        idempotencyKey: command.idempotencyKey,
      }));

      const result = { order: order.toSnapshot() };
      await runTransaction(async (transaction, complete) => {
        await this.ports.orders.insert(order, transaction);
        await this.ports.outbox.append(order.releaseEvents(), transaction);
        await this.ports.paymentRecoveryCandidates.complete(authorization.id, transaction);
        await complete(result);
      });

      return result;
    });
  }
}
  `),
  "src/application/orders/types.ts": source(`
import type { Actor } from "../authorization/actor.js";

export interface CreateOrderCommand {
  actor: Actor;
  requestId: string;
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
  readonly id;
  readonly status = "placed" as const;
  readonly total;
  private paymentAuthorizationId: string | null = null;
  private readonly events: DomainEvent[] = [];

  private constructor(private readonly state: OrderState) {
    this.id = state.id ?? randomUUID();
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
  id?: string;
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
import type {
  AuthorizationInput,
  AuthorizationState,
  PaymentPort,
} from "../../application/ports.js";
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
    const intent = await this.stripe.paymentIntents.retrieve(authorizationId);
    const states: Record<string, AuthorizationState> = {
      requires_capture: "voidable",
      canceled: "already-voided",
      succeeded: "captured",
      processing: "pending",
    };
    return { state: states[intent.status] ?? "unknown" };
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
      return await this.runWithClient(client, operation);
    } finally {
      client.release();
    }
  }

  async runWithClient<T>(
    client: PoolClient,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    await client.query("BEGIN");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
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
    const row = result.rows[0];
    return row ? {
      id: row.id,
      status: row.status,
      total: { amount: row.total_amount, currency: row.currency },
      paymentAuthorizationId: row.payment_authorization_id,
    } : null;
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
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { IdempotencyOperationContext } from "../../application/ports.js";
import type { IdempotencyEnvelope } from "../../application/orders/idempotency-policy.js";
import { TransactionRunner } from "./transaction.js";

export class PostgresIdempotencyStore {
  constructor(
    private readonly pool: Pool,
    private readonly transactions: TransactionRunner,
  ) {}

  async run<T>(
    envelope: IdempotencyEnvelope | undefined,
    operation: (context: IdempotencyOperationContext) => Promise<T>,
  ): Promise<T> {
    if (!envelope) {
      return await operation({
        operationId: randomUUID(),
        runTransaction: async (work) =>
          await this.transactions.run((client) => work(client, async () => {})),
      });
    }
    const key = [envelope.operation, envelope.actorSubject, envelope.key].join(":");
    const client = await this.pool.connect();
    let lockHeld = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      lockHeld = true;
      await client.query(
        "INSERT INTO idempotency_keys (key, operation_id, status) VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING",
        [key, randomUUID()],
      );
      const claimed = await client.query(
        "SELECT operation_id, status, response FROM idempotency_keys WHERE key = $1",
        [key],
      );
      const row = claimed.rows[0];
      if (!row) throw new Error("idempotency operation claim disappeared");
      if (row.status === "completed") {
        const response = row.response;
        return (typeof response === "string" ? JSON.parse(response) : response) as T;
      }
      return await operation({
        operationId: row.operation_id,
        runTransaction: async (work) =>
          await this.transactions.runWithClient(client, (transaction) =>
            work(transaction, async (result) => {
              await transaction.query(
                "UPDATE idempotency_keys SET status = 'completed', response = $2 WHERE key = $1",
                [key, JSON.stringify(result)],
              );
            }),
          ),
      });
    } finally {
      try {
        if (lockHeld) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      } finally {
        client.release();
      }
    }
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
import { orderMetrics } from "../telemetry/order-metrics.js";

export class OutboxDispatcher {
  constructor(private readonly pool: Pool, private readonly bus: EventBus) {}

  async tick(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const events = await client.query(
        "SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED",
      );
      const oldest = events.rows[0]?.created_at;
      if (oldest) orderMetrics.recordOutboxLag((Date.now() - new Date(oldest).getTime()) / 1000);
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
import type {
  OrderRepositoryPort,
  PaymentPort,
  PaymentRecoveryCandidatePort,
} from "../application/ports.js";

export class PaymentReconciliationWorker {
  constructor(
    private readonly payments: PaymentPort,
    private readonly orders: OrderRepositoryPort,
    private readonly candidates: PaymentRecoveryCandidatePort,
    private readonly leaseSeconds: number,
  ) {}

  async tick(): Promise<void> {
    const candidate = await this.candidates.leaseNextCandidate(this.leaseSeconds);
    if (!candidate) return;
    const outcome = await this.reconcile(candidate.authorizationId);
    if (outcome !== "retry-later") {
      await this.candidates.complete(candidate.authorizationId);
    }
  }

  async reconcile(authorizationId: string): Promise<"order-exists" | "voided" | "already-terminal" | "retry-later"> {
    const order = await this.orders.findByPaymentAuthorization(authorizationId);
    if (order) return "order-exists";
    const payment = await this.payments.getAuthorization(authorizationId);
    if (payment.state === "voidable") {
      await this.payments.voidAuthorization(authorizationId);
      return "voided";
    }
    if (payment.state === "already-voided") return "already-terminal";
    return "retry-later";
  }
}
  `),
  "src/infrastructure/payments/postgres-recovery-candidates.ts": source(`
import type { Pool } from "pg";
import type { DbTransaction, PaymentRecoveryCandidatePort } from "../../application/ports.js";

export class PostgresPaymentRecoveryCandidates implements PaymentRecoveryCandidatePort {
  constructor(private readonly pool: Pool, private readonly graceSeconds: number) {}

  async register(authorizationId: string, transaction?: DbTransaction): Promise<void> {
    await (transaction ?? this.pool).query(
      "INSERT INTO payment_recovery_candidates (authorization_id, eligible_at) VALUES ($1, now() + make_interval(secs => $2)) ON CONFLICT DO NOTHING",
      [authorizationId, this.graceSeconds],
    );
  }

  async leaseNextCandidate(leaseSeconds: number) {
    const result = await this.pool.query(
      \`UPDATE payment_recovery_candidates
       SET leased_until = now() + make_interval(secs => $1)
       WHERE authorization_id = (
         SELECT authorization_id FROM payment_recovery_candidates
         WHERE completed_at IS NULL AND eligible_at <= now()
           AND (leased_until IS NULL OR leased_until < now())
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING authorization_id\`,
      [leaseSeconds],
    );
    const authorizationId = result.rows[0]?.authorization_id;
    return authorizationId ? { authorizationId } : null;
  }

  async complete(authorizationId: string, transaction?: DbTransaction): Promise<void> {
    await (transaction ?? this.pool).query(
      "UPDATE payment_recovery_candidates SET completed_at = now() WHERE authorization_id = $1",
      [authorizationId],
    );
  }
}
  `),
  "src/bootstrap/config.ts": source(`
export const config = {
  inventoryUrl: "http://inventory.internal",
  reconciliationLeaseSeconds: 60,
  recoveryGraceSeconds: 300,
} as const;
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
import { PaymentReconciliationWorker } from "../workers/payment-reconciliation.js";
import { PostgresPaymentRecoveryCandidates } from "../infrastructure/payments/postgres-recovery-candidates.js";
import { orderTelemetry } from "../telemetry/order-logger.js";

const orderRepository = new PostgresOrderRepository(pool);
const paymentGateway = new StripeGateway(stripeClient);
const paymentRecoveryCandidates = new PostgresPaymentRecoveryCandidates(
  pool,
  config.recoveryGraceSeconds,
);
const transactionRunner = new TransactionRunner(pool);
const ports = {
  orders: orderRepository,
  idempotency: new PostgresIdempotencyStore(pool, transactionRunner),
  outbox: new PostgresOutbox(),
  payments: paymentGateway,
  paymentRecoveryCandidates,
  inventory: new HttpInventoryClient(config.inventoryUrl),
  catalog: catalogClient,
  telemetry: orderTelemetry,
};

export const application = {
  createOrder: new CreateOrderHandler(ports),
};

export const workers = {
  paymentReconciliation: new PaymentReconciliationWorker(
    paymentGateway,
    orderRepository,
    paymentRecoveryCandidates,
    config.reconciliationLeaseSeconds,
  ),
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
    expect(harness.recoveryCandidates).toEqual(["auth-1"]);
    expect(harness.completedRecoveryCandidates).toEqual(["auth-1"]);
    expect(harness.telemetryRecords).toContainEqual({
      component: "order-placement",
      requestId: "request-test-1",
      orderId: result.order.id,
      authorizationId: "auth-1",
      idempotencyKey: "checkout-42",
    });
  });

  it("returns the original result for a repeated idempotency key", async () => {
    const harness = await createIntegrationHarness();
    const command = harness.validCommand({ idempotencyKey: "checkout-42" });
    const first = await harness.createOrder.execute(command);
    const second = await harness.createOrder.execute(command);
    expect(second).toEqual(first);
    expect(harness.payments.authorizeCalls).toHaveLength(1);
  });

  it("rolls back the order when idempotency completion fails and retries with stable identity", async () => {
    const harness = await createIntegrationHarness();
    const command = harness.validCommand({ idempotencyKey: "checkout-after-failure" });
    harness.idempotency.failNextComplete();
    await expect(harness.createOrder.execute(command)).rejects.toThrow(
      "idempotency completion unavailable",
    );
    expect(await harness.orders.all()).toEqual([]);
    expect(await harness.outbox.pendingTypes()).toEqual([]);

    const retried = await harness.createOrder.execute(command);
    const attemptedOrderIds = harness.payments.authorizeCalls.map((input: any) => input.orderId);
    expect(new Set(attemptedOrderIds).size).toBe(1);
    expect(retried.order.id).toBe(attemptedOrderIds[0]);
    expect(harness.payments.createdAuthorizations).toEqual(["auth-1"]);
    expect(await harness.orders.findById(retried.order.id)).toEqual(retried.order);
  });

  it("rolls back both the order and outbox records when the outbox write fails", async () => {
    const harness = await createIntegrationHarness();
    harness.outbox.failNextAppend();
    await expect(harness.createOrder.execute(harness.validCommand())).rejects.toThrow(
      "outbox unavailable",
    );
    expect(await harness.orders.all()).toEqual([]);
    expect(await harness.outbox.pendingTypes()).toEqual([]);
    expect(harness.recoveryCandidates).toEqual(["auth-1"]);
    expect(harness.completedRecoveryCandidates).toEqual([]);
  });
});
  `),
  "test/contract/order-api.test.ts": source(`
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { orderRoutes } from "../../src/http/routes/orders.js";
import { createOrderControllerFor } from "../../src/http/controllers/create-order.js";
import { createIntegrationHarness } from "../support/integration-harness.js";

const validPayload = () => ({
  customerId: "00000000-0000-4000-8000-000000000001",
  paymentMethodId: "pm_test",
  lines: [{ sku: "sku-1", quantity: 1 }],
});

describe("POST /orders", () => {
  it("requires an authenticated actor", async () => {
    const harness = await createIntegrationHarness();
    const app = new Hono();
    app.route("/orders", orderRoutes({ createOrder: createOrderControllerFor(harness.createOrder) }));
    const response = await app.request("/orders", { method: "POST", body: JSON.stringify({ lines: [] }) });
    expect(response.status).toBe(401);
  });

  it("returns the stable placed order representation", async () => {
    const harness = await createIntegrationHarness();
    const app = new Hono();
    app.route("/orders", orderRoutes({
      createOrder: createOrderControllerFor(harness.createOrder),
      verifyToken: async () => ({
        sub: "reviewer-1", org: "acme", customerScope: "all", permissions: ["orders:create"],
      }),
    }));
    const response = await app.request("/orders", {
      method: "POST",
      headers: {
        authorization: "Bearer contract-token",
        "content-type": "application/json",
        "idempotency-key": "contract-order-1",
        "x-request-id": "request-contract-1",
      },
      body: JSON.stringify(validPayload()),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).order).toMatchObject({ status: "placed" });
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
  operation_id uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'completed')),
  response jsonb,
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

CREATE TABLE payment_recovery_candidates (
  authorization_id text PRIMARY KEY,
  eligible_at timestamptz NOT NULL,
  leased_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
  `),
};
