import path from "node:path";
import {
  walkthroughRepositoryPaths,
  walkthroughRepositoryText,
} from "../../e2e/walkthrough-fixture.mjs";

const primaryStructureId = "80000000-0000-4000-8000-000000000001";
const secondaryStructureId = "80000000-0000-4000-8000-000000000002";
const fullStackStructureId = "80000000-0000-4000-8000-000000000003";
const semanticAnchorNeedles = new Map();

function semanticAnchor(filePath, needle, span = 0) {
  const text = walkthroughRepositoryText(filePath);
  const firstOffset = text.indexOf(needle);
  const secondOffset = firstOffset < 0 ? -1 : text.indexOf(needle, firstOffset + 1);
  if (firstOffset < 0) throw new Error(`contract anchor could not find ${needle} in ${filePath}`);
  if (secondOffset >= 0) throw new Error(`contract anchor is not unique: ${needle} in ${filePath}`);
  const startLine = text.slice(0, firstOffset).split("\n").length;
  const anchor = {
    path: filePath,
    startLine,
    endLine: Math.min(startLine + span, text.trimEnd().split("\n").length),
  };
  semanticAnchorNeedles.set(`${anchor.path}\0${anchor.startLine}\0${anchor.endLine}`, needle);
  return anchor;
}

const primaryStructureNodes = [
  {
    id: "hub",
    label: "Create order",
    description: "注文の認可から外部side effect、永続化までを調停するapplication boundary。",
    kind: "use-case",
    notation: "class",
    anchor: semanticAnchor(
      "src/application/orders/create-order.ts",
      "export class CreateOrderHandler",
      42,
    ),
  },
  {
    id: "http-routes",
    label: "Orders HTTP routes",
    description: "認証middlewareと注文commandのHTTP entry pointを構成する。",
    kind: "route",
    notation: "external",
    anchor: semanticAnchor("src/http/routes/orders.ts", "export function orderRoutes", 8),
  },
  {
    id: "auth-middleware",
    label: "Actor authentication",
    description: "access tokenを検証し、認可に必要なactor contextを組み立てる。",
    kind: "middleware",
    notation: "component",
    anchor: semanticAnchor(
      "src/http/middleware/require-actor.ts",
      "export function requireActor",
      14,
    ),
  },
  {
    id: "http-controller",
    label: "Create order controller",
    description: "HTTP payloadとheaderをapplication commandへ変換する。",
    kind: "controller",
    notation: "class",
    anchor: semanticAnchor(
      "src/http/controllers/create-order.ts",
      "export function createOrderControllerFor",
      18,
    ),
  },
  {
    id: "request-schema",
    label: "Request validation",
    description: "注文requestの識別子、明細数、数量をtransport boundaryで検証する。",
    kind: "schema",
    notation: "interface",
    anchor: semanticAnchor("src/http/schemas/create-order.ts", "export const createOrderSchema", 9),
  },
  {
    id: "composition-root",
    label: "Application wiring",
    description: "application portを具象adapterへ結線し、handlerを構築する。",
    kind: "composition",
    notation: "component",
    anchor: semanticAnchor("src/bootstrap/application.ts", "const ports =", 12),
  },
  {
    id: "authorization-policy",
    label: "Order authorization",
    description: "orders:create権限とcustomer scopeをapplication boundaryで保証する。",
    kind: "policy",
    notation: "class",
    anchor: semanticAnchor(
      "src/application/authorization/order-policy.ts",
      "export function assertCanCreateOrder",
      7,
    ),
  },
  {
    id: "idempotency-store",
    label: "Idempotent retry",
    description: "同じidempotency keyの再試行を元の結果へ収束させる。",
    kind: "adapter",
    notation: "database",
    anchor: semanticAnchor(
      "src/infrastructure/db/idempotency-store.ts",
      "export class PostgresIdempotencyStore",
      15,
    ),
  },
  {
    id: "inventory-client",
    label: "Inventory reservation",
    description: "注文明細の在庫をtimeout付きHTTP requestで予約する。",
    kind: "gateway",
    notation: "external",
    anchor: semanticAnchor(
      "src/infrastructure/inventory/http-inventory-client.ts",
      "export class HttpInventoryClient",
      14,
    ),
  },
  {
    id: "order-aggregate",
    label: "Order aggregate",
    description: "注文totalとplaced/payment eventを保持するdomain aggregate。",
    kind: "aggregate",
    notation: "class",
    anchor: semanticAnchor("src/domain/orders/order.ts", "export class Order", 41),
  },
  {
    id: "pricing-policy",
    label: "Order total",
    description: "catalog priceを使って単一通貨の注文totalを計算する。",
    kind: "policy",
    notation: "class",
    anchor: semanticAnchor(
      "src/domain/orders/pricing.ts",
      "export function calculateOrderTotal",
      13,
    ),
  },
  {
    id: "payment-gateway",
    label: "Payment authorization",
    description: "order IDをidempotency keyとして決済を手動capture前まで認証する。",
    kind: "gateway",
    notation: "external",
    anchor: semanticAnchor(
      "src/infrastructure/payments/stripe-gateway.ts",
      "export class StripeGateway",
      26,
    ),
  },
  {
    id: "transaction-runner",
    label: "Database transaction",
    description: "orderとoutboxのwriteを同じPostgres transactionへ閉じ込める。",
    kind: "adapter",
    notation: "component",
    anchor: semanticAnchor(
      "src/infrastructure/db/transaction.ts",
      "export class TransactionRunner",
      17,
    ),
  },
  {
    id: "order-repository",
    label: "Order record",
    description: "domain snapshotをorders tableへ永続化する。",
    kind: "repository",
    notation: "class",
    anchor: semanticAnchor(
      "src/infrastructure/db/order-repository.ts",
      "export class PostgresOrderRepository",
      12,
    ),
  },
  {
    id: "outbox",
    label: "Transactional outbox",
    description: "domain eventをtransactional outboxへ追記する。",
    kind: "repository",
    notation: "database",
    anchor: semanticAnchor(
      "src/infrastructure/events/postgres-outbox.ts",
      "export class PostgresOutbox",
      9,
    ),
  },
  {
    id: "outbox-dispatcher",
    label: "Outbox delivery",
    description: "未送信eventを排他的にclaimし、event busへ配送する。",
    kind: "worker",
    notation: "component",
    anchor: semanticAnchor("src/workers/outbox-dispatcher.ts", "export class OutboxDispatcher", 23),
  },
  {
    id: "payment-reconciliation",
    label:
      "Payment reconciliation worker for authorized payments without a matching persisted order",
    description:
      "注文が残らなかった認証済みpaymentを定期的に検出し、providerの現在状態と注文repositoryを照合して、安全にvoidできる対象だけを回収する。再試行時はすでにvoid済みのpaymentを成功として扱い、一時的なprovider障害は次回実行へ残す。処理対象と判断根拠は監査logへ記録し、通常の注文作成transactionから独立したrecovery boundaryとして動作する。候補ごとに取得したprovider responseと照合時刻を保持し、同じpaymentを並列workerが重複処理しないようleaseを確認する。注文が遅れて永続化された場合はvoidせず正常系へ戻し、timeoutやrate limitは失敗として確定せず再試行可能な状態を維持する。batch全体では一件の失敗が残りの候補を止めないよう分離し、終了時に成功、延期、調査対象の件数を集約する。",
    kind: "worker",
    notation: "component",
    anchor: semanticAnchor(
      "src/workers/payment-reconciliation.ts",
      "export class PaymentReconciliationWorker",
      22,
    ),
  },
  {
    id: "database-schema",
    label: "Orders data model",
    description: "order recordと配送待ちeventの永続化境界を定義する。",
    kind: "migration",
    notation: "database",
    anchor: semanticAnchor("migrations/018_orders_and_outbox.sql", "CREATE TABLE orders", 31),
  },
];
const primaryStructureEdges = [
  {
    id: "routes-use-auth",
    from: "http-routes",
    to: "auth-middleware",
    label: "すべてのrouteでactorを認証する",
    directed: true,
    anchors: [semanticAnchor("src/http/routes/orders.ts", 'routes.use("*"')],
  },
  {
    id: "routes-post-controller",
    from: "http-routes",
    to: "http-controller",
    label: "POST /ordersを委譲する",
    directed: true,
    anchors: [semanticAnchor("src/http/routes/orders.ts", 'routes.post("/"')],
  },
  {
    id: "controller-validates-request",
    from: "http-controller",
    to: "request-schema",
    label: "request bodyを検証する",
    directed: true,
    anchors: [
      semanticAnchor("src/http/controllers/create-order.ts", "createOrderSchema.parse"),
      semanticAnchor("src/http/schemas/create-order.ts", "export const createOrderSchema", 9),
    ],
  },
  {
    id: "controller-executes-handler",
    from: "http-controller",
    to: "hub",
    label: "HTTP commandとして実行する",
    directed: true,
    anchors: [
      semanticAnchor(
        "src/http/controllers/create-order.ts",
        "const result = await createOrder.execute",
        7,
      ),
      semanticAnchor("src/application/orders/create-order.ts", "async execute", 36),
    ],
  },
  {
    id: "composition-constructs-handler",
    from: "composition-root",
    to: "hub",
    label: "具象portを注入して構築する",
    directed: true,
    anchors: [
      semanticAnchor("src/bootstrap/application.ts", "const ports =", 12),
      semanticAnchor("src/edge-only-evidence.ts", "export const moduleName"),
    ],
  },
  {
    id: "handler-authorizes-actor",
    from: "hub",
    to: "authorization-policy",
    label: "作成権限を検証する",
    directed: true,
    anchors: [
      semanticAnchor(
        "src/application/orders/create-order.ts",
        "assertCanCreateOrder(command.actor",
      ),
    ],
  },
  {
    id: "handler-idempotency-envelope",
    from: "hub",
    to: "idempotency-store",
    label: "再試行を束ねる",
    directed: true,
    anchors: [
      semanticAnchor(
        "src/application/orders/create-order.ts",
        "return this.ports.idempotency.run",
        31,
      ),
      semanticAnchor("src/infrastructure/db/idempotency-store.ts", "async run", 28),
    ],
  },
  {
    id: "idempotency-reuses-result",
    from: "idempotency-store",
    to: "idempotency-store",
    label: "同じkeyの保存済みresultを再利用する",
    directed: true,
    anchors: [
      semanticAnchor(
        "src/infrastructure/db/idempotency-store.ts",
        "const cached = await this.pool.query",
        5,
      ),
    ],
  },
  {
    id: "handler-reserves-inventory",
    from: "hub",
    to: "inventory-client",
    label: "在庫を予約する",
    directed: true,
    anchors: [
      semanticAnchor("src/application/orders/create-order.ts", "this.ports.inventory.reserve"),
    ],
  },
  {
    id: "handler-places-order",
    from: "hub",
    to: "order-aggregate",
    label: "Orderを生成する",
    directed: true,
    anchors: [
      semanticAnchor("src/application/orders/create-order.ts", "const order = Order.place", 5),
    ],
  },
  {
    id: "order-calculates-total",
    from: "order-aggregate",
    to: "pricing-policy",
    label: "注文totalを計算する",
    directed: true,
    anchors: [
      semanticAnchor("src/domain/orders/order.ts", "this.total = calculateOrderTotal"),
      semanticAnchor("src/domain/orders/pricing.ts", "export function calculateOrderTotal", 13),
    ],
  },
  {
    id: "handler-authorizes-payment",
    from: "hub",
    to: "payment-gateway",
    label: "決済を認証する",
    directed: true,
    anchors: [
      semanticAnchor(
        "src/application/orders/create-order.ts",
        "const authorization = await this.ports.payments.authorize",
        4,
      ),
    ],
  },
  {
    id: "handler-opens-transaction",
    from: "hub",
    to: "transaction-runner",
    label: "transactionを開始する",
    directed: true,
    anchors: [
      semanticAnchor(
        "src/application/orders/create-order.ts",
        "await this.ports.transaction.run",
        3,
      ),
    ],
  },
  {
    id: "handler-persists-order",
    from: "transaction-runner",
    to: "order-repository",
    label: "transaction内でOrderを保存する",
    directed: true,
    anchors: [
      semanticAnchor("src/application/orders/create-order.ts", "await this.ports.orders.insert"),
      semanticAnchor("src/infrastructure/db/order-repository.ts", "async insert", 6),
    ],
  },
  {
    id: "handler-appends-events",
    from: "transaction-runner",
    to: "outbox",
    label: "transaction内でeventを追記する",
    directed: true,
    anchors: [
      semanticAnchor("src/application/orders/create-order.ts", "await this.ports.outbox.append"),
      semanticAnchor("src/infrastructure/events/postgres-outbox.ts", "async append", 6),
    ],
  },
  {
    id: "order-returns-snapshot",
    from: "order-aggregate",
    to: "hub",
    label: "response snapshotを返す",
    directed: true,
    anchors: [
      semanticAnchor("src/domain/orders/order.ts", "toSnapshot()", 6),
      semanticAnchor(
        "src/application/orders/create-order.ts",
        "return { order: order.toSnapshot() }",
      ),
    ],
  },
  {
    id: "repositories-share-transaction",
    from: "order-repository",
    to: "outbox",
    label: "同じDB transactionを共有する",
    directed: false,
    anchors: [
      semanticAnchor(
        "src/application/orders/create-order.ts",
        "await this.ports.transaction.run",
        3,
      ),
    ],
  },
  {
    id: "orders-use-schema",
    from: "order-repository",
    to: "database-schema",
    label: "orders tableへwriteする",
    directed: true,
    anchors: [semanticAnchor("migrations/018_orders_and_outbox.sql", "CREATE TABLE orders", 7)],
  },
  {
    id: "outbox-uses-schema",
    from: "outbox",
    to: "database-schema",
    label: "outbox tableへwriteする",
    directed: true,
    anchors: [
      semanticAnchor("migrations/018_orders_and_outbox.sql", "CREATE TABLE outbox_events", 7),
    ],
  },
  {
    id: "dispatcher-claims-outbox",
    from: "outbox-dispatcher",
    to: "outbox",
    label: "未送信eventを排他的にclaimする",
    directed: true,
    anchors: [semanticAnchor("src/workers/outbox-dispatcher.ts", "FOR UPDATE SKIP LOCKED", 6)],
  },
  {
    id: "reconciliation-checks-payment",
    from: "payment-reconciliation",
    to: "payment-gateway",
    label: "認証済みpaymentを照合してvoidする",
    directed: true,
    anchors: [
      semanticAnchor(
        "src/workers/payment-reconciliation.ts",
        "const payment = await this.payments.getAuthorization",
        4,
      ),
    ],
  },
  {
    id: "reconciliation-checks-order",
    from: "payment-reconciliation",
    to: "order-repository",
    label: "対応するorderの有無を照合する",
    directed: true,
    anchors: [
      semanticAnchor(
        "src/workers/payment-reconciliation.ts",
        "const order = await this.orders.findByPaymentAuthorization",
        3,
      ),
    ],
  },
];

const orderPlacementStructureNodes = primaryStructureNodes.filter(
  (node) => !["outbox-dispatcher", "payment-reconciliation"].includes(node.id),
);
const orderPlacementStructureEdges = primaryStructureEdges.filter(
  (edge) =>
    ![
      "dispatcher-claims-outbox",
      "reconciliation-checks-payment",
      "reconciliation-checks-order",
    ].includes(edge.id),
);

const secondaryStructureNodes = primaryStructureNodes
  .filter((node) =>
    ["payment-reconciliation", "payment-gateway", "order-repository"].includes(node.id),
  )
  .map((node) =>
    node.id === "payment-reconciliation"
      ? {
          ...node,
          anchor: { path: "assets/hybrid.png", startLine: null, endLine: null },
        }
      : node,
  );
const secondaryStructureEdges = primaryStructureEdges.filter((edge) =>
  ["reconciliation-checks-payment", "reconciliation-checks-order"].includes(edge.id),
);
const fullStackStructureNodes = [
  {
    id: "order-detail-route",
    label: "GET /orders/:orderId",
    description: "注文詳細requestを受け取るbackend entrypoint。",
    kind: "route",
    notation: "external",
    anchor: { path: "src/http/routes/order-detail.ts", startLine: 6, endLine: 14 },
  },
  {
    id: "detail-actor-auth",
    label: "Actor authentication",
    description: "閲覧者を認証してcustomer scopeを確定する。",
    kind: "middleware",
    notation: "component",
    anchor: { path: "src/http/middleware/require-actor.ts", startLine: 4, endLine: 18 },
  },
  {
    id: "detail-params",
    label: "Order ID validation",
    description: "path parameterを注文IDとして検証する。",
    kind: "schema",
    notation: "interface",
    anchor: { path: "src/http/schemas/order-detail.ts", startLine: 3, endLine: 10 },
  },
  {
    id: "get-order-query",
    label: "Get order detail",
    description: "閲覧権限のある注文詳細を取得するquery boundary。",
    kind: "query",
    notation: "class",
    anchor: { path: "src/application/orders/get-order-detail.ts", startLine: 8, endLine: 29 },
  },
  {
    id: "order-read-repository",
    label: "Order read repository",
    description: "注文詳細projectionをcustomer scope付きで読み出す。",
    kind: "repository",
    notation: "class",
    anchor: { path: "src/infrastructure/db/order-read-repository.ts", startLine: 5, endLine: 24 },
  },
  {
    id: "orders-read-model",
    label: "Orders read model",
    description: "注文、明細、statusを結合したread projection。",
    kind: "database",
    notation: "database",
    anchor: { path: "migrations/021_order_detail_view.sql", startLine: 1, endLine: 22 },
  },
  {
    id: "order-response-presenter",
    label: "Order detail presenter",
    description: "query resultを公開HTTP responseへ写像する。",
    kind: "presenter",
    notation: "class",
    anchor: { path: "src/http/presenters/order-detail.ts", startLine: 4, endLine: 25 },
  },
  {
    id: "order-not-found",
    label: "Not-found response",
    description: "見つからない注文を404 problem responseへ変換する。",
    kind: "error",
    notation: "concept",
    anchor: { path: "src/http/controllers/order-detail.ts", startLine: 18, endLine: 25 },
  },
  {
    id: "order-detail-contract",
    label: "Order detail response boundary",
    description: "backendが返しfrontend clientがtyped resultへ変換するJSON response boundary。",
    kind: "contract",
    notation: "interface",
    anchor: { path: "src/shared/contracts/order-detail.ts", startLine: 1, endLine: 24 },
  },
  {
    id: "order-api-client",
    label: "Order API client",
    description: "HTTP responseをtyped frontend resultとして受け取る。",
    kind: "client",
    notation: "component",
    anchor: { path: "src/frontend/api/orders.ts", startLine: 7, endLine: 18 },
  },
  {
    id: "order-detail-query-hook",
    label: "useOrderDetail",
    description: "注文詳細の取得、cache、loading/error stateを公開する。",
    kind: "hook",
    notation: "component",
    anchor: { path: "src/frontend/orders/use-order-detail.ts", startLine: 6, endLine: 22 },
  },
  {
    id: "order-query-cache",
    label: "Order query cache",
    description: "order IDごとのresponseと再取得状態を保持する。",
    kind: "cache",
    notation: "database",
    anchor: { path: "src/frontend/query/query-client.ts", startLine: 3, endLine: 16 },
  },
  {
    id: "order-detail-page",
    label: "OrderDetailPage",
    description: "query stateを注文詳細のReact component treeへ分配する。",
    kind: "component",
    notation: "component",
    anchor: { path: "src/frontend/orders/OrderDetailPage.tsx", startLine: 9, endLine: 38 },
  },
  {
    id: "order-summary-card",
    label: "OrderSummaryCard",
    description: "注文番号、customer、totalを表示する。",
    kind: "component",
    notation: "component",
    anchor: { path: "src/frontend/orders/OrderSummaryCard.tsx", startLine: 5, endLine: 21 },
  },
  {
    id: "order-line-items",
    label: "OrderLineItems",
    description: "responseの明細を商品行として描画する。",
    kind: "component",
    notation: "component",
    anchor: { path: "src/frontend/orders/OrderLineItems.tsx", startLine: 5, endLine: 24 },
  },
  {
    id: "order-status-badge",
    label: "OrderStatusBadge",
    description: "backend statusをreviewerが識別できる表示へ変換する。",
    kind: "component",
    notation: "component",
    anchor: { path: "src/frontend/orders/OrderStatusBadge.tsx", startLine: 4, endLine: 17 },
  },
  {
    id: "order-detail-error",
    label: "OrderDetailError",
    description: "404と一時的な取得失敗を区別して表示する。",
    kind: "component",
    notation: "component",
    anchor: { path: "src/frontend/orders/OrderDetailError.tsx", startLine: 5, endLine: 20 },
  },
];
const fullStackStructureEdges = [
  {
    id: "detail-route-authenticates",
    from: "order-detail-route",
    to: "detail-actor-auth",
    label: "閲覧者を認証する",
    directed: true,
    anchors: [{ path: "src/http/routes/order-detail.ts", startLine: 8, endLine: 8 }],
  },
  {
    id: "detail-route-validates-id",
    from: "order-detail-route",
    to: "detail-params",
    label: "order IDを検証する",
    directed: true,
    anchors: [{ path: "src/http/controllers/order-detail.ts", startLine: 7, endLine: 9 }],
  },
  {
    id: "detail-route-executes-query",
    from: "order-detail-route",
    to: "get-order-query",
    label: "detail queryを実行する",
    directed: true,
    anchors: [{ path: "src/http/controllers/order-detail.ts", startLine: 10, endLine: 17 }],
  },
  {
    id: "detail-auth-scopes-query",
    from: "detail-actor-auth",
    to: "get-order-query",
    label: "customer scopeを渡す",
    directed: true,
    anchors: [{ path: "src/http/controllers/order-detail.ts", startLine: 10, endLine: 13 }],
  },
  {
    id: "detail-params-supply-query",
    from: "detail-params",
    to: "get-order-query",
    label: "validated IDを渡す",
    directed: true,
    anchors: [{ path: "src/http/controllers/order-detail.ts", startLine: 10, endLine: 13 }],
  },
  {
    id: "detail-query-loads-read-model",
    from: "get-order-query",
    to: "order-read-repository",
    label: "注文projectionを読み出す",
    directed: true,
    anchors: [{ path: "src/application/orders/get-order-detail.ts", startLine: 13, endLine: 18 }],
  },
  {
    id: "detail-repository-queries-view",
    from: "order-read-repository",
    to: "orders-read-model",
    label: "read viewをqueryする",
    directed: true,
    anchors: [
      { path: "src/infrastructure/db/order-read-repository.ts", startLine: 8, endLine: 22 },
    ],
  },
  {
    id: "detail-query-presents-result",
    from: "get-order-query",
    to: "order-response-presenter",
    label: "resultをresponseへ写像する",
    directed: true,
    anchors: [{ path: "src/application/orders/get-order-detail.ts", startLine: 20, endLine: 27 }],
  },
  {
    id: "detail-query-maps-not-found",
    from: "get-order-query",
    to: "order-not-found",
    label: "missing resultを404へ写像する",
    directed: true,
    anchors: [{ path: "src/http/controllers/order-detail.ts", startLine: 18, endLine: 25 }],
  },
  {
    id: "detail-presenter-returns-contract",
    from: "order-response-presenter",
    to: "order-detail-contract",
    label: "200 JSONを返す",
    directed: true,
    anchors: [
      { path: "src/http/presenters/order-detail.ts", startLine: 8, endLine: 24 },
      { path: "src/shared/contracts/order-detail.ts", startLine: 1, endLine: 24 },
    ],
  },
  {
    id: "detail-not-found-returns-contract",
    from: "order-not-found",
    to: "order-detail-contract",
    label: "404 problemを返す",
    directed: true,
    anchors: [{ path: "src/http/controllers/order-detail.ts", startLine: 18, endLine: 25 }],
  },
  {
    id: "detail-response-enters-client",
    from: "order-detail-contract",
    to: "order-api-client",
    label: "応答契約の整合が確認できた場合に限りtyped payloadをクライアントへ渡す",
    directed: true,
    anchors: [
      { path: "src/shared/contracts/order-detail.ts", startLine: 1, endLine: 24 },
      { path: "src/frontend/api/orders.ts", startLine: 7, endLine: 18 },
    ],
  },
  {
    id: "detail-client-provides-hook-result",
    from: "order-api-client",
    to: "order-detail-query-hook",
    label: "typed resultを公開する",
    directed: true,
    anchors: [{ path: "src/frontend/orders/use-order-detail.ts", startLine: 9, endLine: 15 }],
  },
  {
    id: "detail-hook-uses-cache",
    from: "order-detail-query-hook",
    to: "order-query-cache",
    label: "order ID単位でcacheする",
    directed: true,
    anchors: [{ path: "src/frontend/orders/use-order-detail.ts", startLine: 9, endLine: 18 }],
  },
  {
    id: "detail-hook-provides-page-state",
    from: "order-detail-query-hook",
    to: "order-detail-page",
    label: "query stateを渡す",
    directed: true,
    anchors: [{ path: "src/frontend/orders/OrderDetailPage.tsx", startLine: 11, endLine: 18 }],
  },
  {
    id: "detail-page-renders-summary",
    from: "order-detail-page",
    to: "order-summary-card",
    label: "summaryを描画する",
    directed: true,
    anchors: [{ path: "src/frontend/orders/OrderDetailPage.tsx", startLine: 24, endLine: 24 }],
  },
  {
    id: "detail-page-renders-items",
    from: "order-detail-page",
    to: "order-line-items",
    label: "line itemsを描画する",
    directed: true,
    anchors: [{ path: "src/frontend/orders/OrderDetailPage.tsx", startLine: 25, endLine: 25 }],
  },
  {
    id: "detail-page-renders-status",
    from: "order-detail-page",
    to: "order-status-badge",
    label: "statusを描画する",
    directed: true,
    anchors: [{ path: "src/frontend/orders/OrderDetailPage.tsx", startLine: 23, endLine: 23 }],
  },
  {
    id: "detail-hook-renders-error",
    from: "order-detail-query-hook",
    to: "order-detail-error",
    label: "error stateを描画する",
    directed: true,
    anchors: [{ path: "src/frontend/orders/OrderDetailPage.tsx", startLine: 15, endLine: 18 }],
  },
];
export const fullStackRepositoryPaths = [
  ...new Set([
    ...fullStackStructureNodes.flatMap((node) => (node.anchor ? [node.anchor.path] : [])),
    ...fullStackStructureEdges.flatMap((edge) => edge.anchors.map((anchor) => anchor.path)),
  ]),
];

export function validateContractStructureFixture() {
  const structures = [
    {
      title: "Order placement behavior",
      nodes: orderPlacementStructureNodes,
      edges: orderPlacementStructureEdges,
    },
  ];
  for (const structure of structures) {
    for (const [kind, id, sourceAnchor] of [
      ...structure.nodes.flatMap((node) => (node.anchor ? [["node", node.id, node.anchor]] : [])),
      ...structure.edges.flatMap((edge) =>
        edge.anchors.map((sourceAnchor) => ["edge", edge.id, sourceAnchor]),
      ),
    ]) {
      const needle = semanticAnchorNeedles.get(
        `${sourceAnchor.path}\0${sourceAnchor.startLine}\0${sourceAnchor.endLine}`,
      );
      if (!needle) throw new Error(`${structure.title} ${kind} ${id} lacks a semantic anchor`);
      const selected = walkthroughRepositoryText(sourceAnchor.path)
        .split("\n")
        .slice(sourceAnchor.startLine - 1, sourceAnchor.endLine)
        .join("\n");
      if (!selected.includes(needle)) {
        throw new Error(`${structure.title} ${kind} ${id} no longer selects ${needle}`);
      }
    }
  }

  const repositoryPaths = new Set([...walkthroughRepositoryPaths, ...fullStackRepositoryPaths]);
  for (const filePath of repositoryPaths) {
    if (!/\.[cm]?[jt]sx?$/u.test(filePath)) continue;
    const text = walkthroughRepositoryText(filePath);
    for (const match of text.matchAll(/\bfrom\s+["'](\.[^"']+)["']/gu)) {
      const specifier = match[1];
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(filePath), specifier.replace(/\.js$/u, ".ts")),
      );
      if (!repositoryPaths.has(resolved)) {
        throw new Error(`contract repository ${filePath} imports missing ${resolved}`);
      }
    }
  }
}

validateContractStructureFixture();

export function createContractStructures({ pullRequestId, baseOid, firstHead }) {
  return [
    {
      id: primaryStructureId,
      ref: `rvw://structure/${primaryStructureId}`,
      pullRequestId,
      sourceOid: firstHead,
      title: "Order placement behavior",
      scope:
        "Order creation from the authenticated HTTP boundary through domain decisions, remote side effects, transactional persistence, and event handoff; background delivery, recovery, and read paths are excluded.",
      originNodeId: "http-routes",
      nodes: orderPlacementStructureNodes,
      edges: orderPlacementStructureEdges,
      createdAt: "2026-08-08T01:00:00.000Z",
      updatedAt: "2026-08-08T01:00:00.000Z",
    },
    {
      id: secondaryStructureId,
      ref: `rvw://structure/${secondaryStructureId}`,
      pullRequestId,
      sourceOid: baseOid,
      title: "Payment reconciliation recovery",
      scope:
        "The payment reconciliation worker that finds an authorized payment without a persisted order and voids it; order placement, retry envelopes, event delivery, and test evidence are excluded.",
      originNodeId: "payment-reconciliation",
      nodes: secondaryStructureNodes,
      edges: secondaryStructureEdges,
      createdAt: "2026-08-08T01:05:00.000Z",
      updatedAt: "2026-08-08T01:05:00.000Z",
    },
    {
      id: fullStackStructureId,
      ref: `rvw://structure/${fullStackStructureId}`,
      pullRequestId,
      sourceOid: firstHead,
      title: "Order detail response rendering",
      scope:
        "GET /orders/:orderId from the backend HTTP entrypoint through read-model lookup and the shared response contract into the React query and component rendering boundary.",
      originNodeId: "order-detail-route",
      nodes: fullStackStructureNodes,
      edges: fullStackStructureEdges,
      createdAt: "2026-08-08T01:10:00.000Z",
      updatedAt: "2026-08-08T01:10:00.000Z",
    },
  ];
}
