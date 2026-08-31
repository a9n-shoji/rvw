import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import {
  sourceAnchorFingerprint,
  structureSourceAnchor,
} from "../../src/domain/source-reference.ts";
import {
  walkthroughRepositoryPaths,
  walkthroughRepositorySources,
  walkthroughRepositoryText,
  walkthroughs,
} from "./walkthrough-fixture.mjs";

const host = "127.0.0.1";
const port = Number(process.env.RVW_E2E_PORT ?? 43117);
const repositoryDemo =
  process.env.RVW_FIXTURE_MODE === "repository-demo"
    ? (await import("../../scripts/repository-demo-fixture.ts")).createRepositoryDemoFixture(
        path.resolve(import.meta.dirname, "../.."),
      )
    : null;
const pullRequestId = repositoryDemo?.pullRequestId ?? "11111111-1111-4111-8111-111111111111";
const attachmentId = "37948111-1227-4cdb-a76d-dc8eb469ae5c";
const brokenAttachmentId = "11111111-2222-4333-8444-555555555555";
const attachmentUrl = `https://github.com/user-attachments/assets/${attachmentId}`;
const brokenAttachmentUrl = `https://github.com/user-attachments/assets/${brokenAttachmentId}`;
const fixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const baseOid = repositoryDemo?.baseOid ?? "a".repeat(40);
const firstHead = repositoryDemo?.commits[0]?.oid ?? "b".repeat(40);
const secondHead = repositoryDemo?.headOid ?? "c".repeat(40);
const comments = repositoryDemo ? structuredClone(repositoryDemo.comments) : [];
const activeWalkthroughs = repositoryDemo
  ? structuredClone(repositoryDemo.walkthroughs)
  : walkthroughs;
const primaryStructureId = "80000000-0000-4000-8000-000000000001";
const secondaryStructureId = "80000000-0000-4000-8000-000000000002";
const fullStackStructureId = "80000000-0000-4000-8000-000000000003";
const primaryStructureNodes = [
  {
    id: "hub",
    label: "Create order",
    description: "注文の認可から外部side effect、永続化までを調停するapplication boundary。",
    kind: "use-case",
    notation: "class",
    anchor: { path: "src/application/orders/create-order.ts", startLine: 9, endLine: 37 },
  },
  {
    id: "http-routes",
    label: "Orders HTTP routes",
    description: "認証middlewareと注文commandのHTTP entry pointを構成する。",
    kind: "route",
    notation: "external",
    anchor: { path: "src/http/routes/orders.ts", startLine: 6, endLine: 14 },
  },
  {
    id: "auth-middleware",
    label: "Actor authentication",
    description: "access tokenを検証し、認可に必要なactor contextを組み立てる。",
    kind: "middleware",
    notation: "component",
    anchor: { path: "src/http/middleware/require-actor.ts", startLine: 4, endLine: 18 },
  },
  {
    id: "http-controller",
    label: "Create order controller",
    description: "HTTP payloadとheaderをapplication commandへ変換する。",
    kind: "controller",
    notation: "class",
    anchor: { path: "src/http/controllers/create-order.ts", startLine: 5, endLine: 19 },
  },
  {
    id: "request-schema",
    label: "Request validation",
    description: "注文requestの識別子、明細数、数量をtransport boundaryで検証する。",
    kind: "schema",
    notation: "interface",
    anchor: { path: "src/http/schemas/create-order.ts", startLine: 3, endLine: 12 },
  },
  {
    id: "composition-root",
    label: "Application wiring",
    description: "application portを具象adapterへ結線し、handlerを構築する。",
    kind: "composition",
    notation: "component",
    anchor: { path: "src/bootstrap/application.ts", startLine: 10, endLine: 22 },
  },
  {
    id: "authorization-policy",
    label: "Order authorization",
    description: "orders:create権限とcustomer scopeをapplication boundaryで保証する。",
    kind: "policy",
    notation: "class",
    anchor: { path: "src/application/authorization/order-policy.ts", startLine: 4, endLine: 11 },
  },
  {
    id: "idempotency-store",
    label: "Idempotent retry",
    description: "同じidempotency keyの再試行を元の結果へ収束させる。",
    kind: "adapter",
    notation: "database",
    anchor: { path: "src/infrastructure/db/idempotency-store.ts", startLine: 3, endLine: 18 },
  },
  {
    id: "inventory-client",
    label: "Inventory reservation",
    description: "注文明細の在庫をtimeout付きHTTP requestで予約する。",
    kind: "gateway",
    notation: "external",
    anchor: {
      path: "src/infrastructure/inventory/http-inventory-client.ts",
      startLine: 4,
      endLine: 18,
    },
  },
  {
    id: "order-aggregate",
    label: "Order aggregate",
    description: "注文totalとplaced/payment eventを保持するdomain aggregate。",
    kind: "aggregate",
    notation: "class",
    anchor: { path: "src/domain/orders/order.ts", startLine: 5, endLine: 41 },
  },
  {
    id: "pricing-policy",
    label: "Order total",
    description: "catalog priceを使って単一通貨の注文totalを計算する。",
    kind: "policy",
    notation: "class",
    anchor: { path: "src/domain/orders/pricing.ts", startLine: 1, endLine: 14 },
  },
  {
    id: "payment-gateway",
    label: "Payment authorization",
    description: "order IDをidempotency keyとして決済を手動capture前まで認証する。",
    kind: "gateway",
    notation: "external",
    anchor: { path: "src/infrastructure/payments/stripe-gateway.ts", startLine: 4, endLine: 21 },
  },
  {
    id: "transaction-runner",
    label: "Database transaction",
    description: "orderとoutboxのwriteを同じPostgres transactionへ閉じ込める。",
    kind: "adapter",
    notation: "component",
    anchor: { path: "src/infrastructure/db/transaction.ts", startLine: 3, endLine: 20 },
  },
  {
    id: "order-repository",
    label: "Order record",
    description: "domain snapshotをorders tableへ永続化する。",
    kind: "repository",
    notation: "class",
    anchor: { path: "src/infrastructure/db/order-repository.ts", startLine: 4, endLine: 16 },
  },
  {
    id: "outbox",
    label: "Transactional outbox",
    description: "domain eventをtransactional outboxへ追記する。",
    kind: "repository",
    notation: "database",
    anchor: { path: "src/infrastructure/events/postgres-outbox.ts", startLine: 4, endLine: 13 },
  },
  {
    id: "outbox-dispatcher",
    label: "Outbox delivery",
    description: "未送信eventを排他的にclaimし、event busへ配送する。",
    kind: "worker",
    notation: "component",
    anchor: { path: "src/workers/outbox-dispatcher.ts", startLine: 4, endLine: 16 },
  },
  {
    id: "payment-reconciliation",
    label:
      "Payment reconciliation worker for authorized payments without a matching persisted order",
    description:
      "注文が残らなかった認証済みpaymentを定期的に検出し、providerの現在状態と注文repositoryを照合して、安全にvoidできる対象だけを回収する。再試行時はすでにvoid済みのpaymentを成功として扱い、一時的なprovider障害は次回実行へ残す。処理対象と判断根拠は監査logへ記録し、通常の注文作成transactionから独立したrecovery boundaryとして動作する。候補ごとに取得したprovider responseと照合時刻を保持し、同じpaymentを並列workerが重複処理しないようleaseを確認する。注文が遅れて永続化された場合はvoidせず正常系へ戻し、timeoutやrate limitは失敗として確定せず再試行可能な状態を維持する。batch全体では一件の失敗が残りの候補を止めないよう分離し、終了時に成功、延期、調査対象の件数を集約する。",
    kind: "worker",
    notation: "component",
    anchor: { path: "src/workers/payment-reconciliation.ts", startLine: 3, endLine: 13 },
  },
  {
    id: "database-schema",
    label: "Orders data model",
    description: "order recordと配送待ちeventの永続化境界を定義する。",
    kind: "migration",
    notation: "database",
    anchor: { path: "migrations/018_orders_and_outbox.sql", startLine: 1, endLine: 18 },
  },
];
const primaryStructureEdges = [
  {
    id: "routes-use-auth",
    from: "http-routes",
    to: "auth-middleware",
    label: "すべてのrouteでactorを認証する",
    directed: true,
    anchors: [{ path: "src/http/routes/orders.ts", startLine: 9, endLine: 9 }],
  },
  {
    id: "routes-post-controller",
    from: "http-routes",
    to: "http-controller",
    label: "POST /ordersを委譲する",
    directed: true,
    anchors: [{ path: "src/http/routes/orders.ts", startLine: 10, endLine: 10 }],
  },
  {
    id: "controller-validates-request",
    from: "http-controller",
    to: "request-schema",
    label: "request bodyを検証する",
    directed: true,
    anchors: [
      { path: "src/http/controllers/create-order.ts", startLine: 7, endLine: 7 },
      { path: "src/http/schemas/create-order.ts", startLine: 3, endLine: 12 },
    ],
  },
  {
    id: "controller-executes-handler",
    from: "http-controller",
    to: "hub",
    label: "HTTP commandとして実行する",
    directed: true,
    anchors: [
      { path: "src/http/controllers/create-order.ts", startLine: 10, endLine: 16 },
      { path: "src/application/orders/create-order.ts", startLine: 9, endLine: 37 },
    ],
  },
  {
    id: "composition-constructs-handler",
    from: "composition-root",
    to: "hub",
    label: "具象portを注入して構築する",
    directed: true,
    anchors: [{ path: "src/bootstrap/application.ts", startLine: 10, endLine: 22 }],
  },
  {
    id: "handler-authorizes-actor",
    from: "hub",
    to: "authorization-policy",
    label: "作成権限を検証する",
    directed: true,
    anchors: [{ path: "src/application/orders/create-order.ts", startLine: 10, endLine: 10 }],
  },
  {
    id: "handler-idempotency-envelope",
    from: "hub",
    to: "idempotency-store",
    label: "再試行を束ねる",
    directed: true,
    anchors: [
      { path: "src/application/orders/create-order.ts", startLine: 12, endLine: 37 },
      { path: "src/infrastructure/db/idempotency-store.ts", startLine: 6, endLine: 16 },
    ],
  },
  {
    id: "idempotency-reuses-result",
    from: "idempotency-store",
    to: "idempotency-store",
    label: "同じkeyの保存済みresultを再利用する",
    directed: true,
    anchors: [{ path: "src/infrastructure/db/idempotency-store.ts", startLine: 6, endLine: 16 }],
  },
  {
    id: "handler-reserves-inventory",
    from: "hub",
    to: "inventory-client",
    label: "在庫を予約する",
    directed: true,
    anchors: [{ path: "src/application/orders/create-order.ts", startLine: 16, endLine: 16 }],
  },
  {
    id: "handler-places-order",
    from: "hub",
    to: "order-aggregate",
    label: "Orderを生成する",
    directed: true,
    anchors: [{ path: "src/application/orders/create-order.ts", startLine: 17, endLine: 22 }],
  },
  {
    id: "order-calculates-total",
    from: "order-aggregate",
    to: "pricing-policy",
    label: "注文totalを計算する",
    directed: true,
    anchors: [
      { path: "src/domain/orders/order.ts", startLine: 12, endLine: 18 },
      { path: "src/domain/orders/pricing.ts", startLine: 1, endLine: 14 },
    ],
  },
  {
    id: "handler-authorizes-payment",
    from: "hub",
    to: "payment-gateway",
    label: "決済を認証する",
    directed: true,
    anchors: [{ path: "src/application/orders/create-order.ts", startLine: 24, endLine: 29 }],
  },
  {
    id: "handler-opens-transaction",
    from: "hub",
    to: "transaction-runner",
    label: "transactionを開始する",
    directed: true,
    anchors: [{ path: "src/application/orders/create-order.ts", startLine: 31, endLine: 34 }],
  },
  {
    id: "handler-persists-order",
    from: "transaction-runner",
    to: "order-repository",
    label: "transaction内でOrderを保存する",
    directed: true,
    anchors: [
      { path: "src/application/orders/create-order.ts", startLine: 32, endLine: 32 },
      { path: "src/infrastructure/db/order-repository.ts", startLine: 4, endLine: 11 },
    ],
  },
  {
    id: "handler-appends-events",
    from: "transaction-runner",
    to: "outbox",
    label: "transaction内でeventを追記する",
    directed: true,
    anchors: [
      { path: "src/application/orders/create-order.ts", startLine: 33, endLine: 33 },
      { path: "src/infrastructure/events/postgres-outbox.ts", startLine: 4, endLine: 12 },
    ],
  },
  {
    id: "order-returns-snapshot",
    from: "order-aggregate",
    to: "hub",
    label: "response snapshotを返す",
    directed: true,
    anchors: [
      { path: "src/domain/orders/order.ts", startLine: 39, endLine: 41 },
      { path: "src/application/orders/create-order.ts", startLine: 36, endLine: 36 },
    ],
  },
  {
    id: "repositories-share-transaction",
    from: "order-repository",
    to: "outbox",
    label: "同じDB transactionを共有する",
    directed: false,
    anchors: [{ path: "src/application/orders/create-order.ts", startLine: 31, endLine: 34 }],
  },
  {
    id: "orders-use-schema",
    from: "order-repository",
    to: "database-schema",
    label: "orders tableへwriteする",
    directed: true,
    anchors: [{ path: "migrations/018_orders_and_outbox.sql", startLine: 1, endLine: 7 }],
  },
  {
    id: "outbox-uses-schema",
    from: "outbox",
    to: "database-schema",
    label: "outbox tableへwriteする",
    directed: true,
    anchors: [{ path: "migrations/018_orders_and_outbox.sql", startLine: 9, endLine: 18 }],
  },
  {
    id: "dispatcher-claims-outbox",
    from: "outbox-dispatcher",
    to: "outbox",
    label: "未送信eventを排他的にclaimする",
    directed: true,
    anchors: [{ path: "src/workers/outbox-dispatcher.ts", startLine: 7, endLine: 14 }],
  },
  {
    id: "reconciliation-checks-payment",
    from: "payment-reconciliation",
    to: "payment-gateway",
    label: "認証済みpaymentを照合してvoidする",
    directed: true,
    anchors: [{ path: "src/workers/payment-reconciliation.ts", startLine: 6, endLine: 11 }],
  },
  {
    id: "reconciliation-checks-order",
    from: "payment-reconciliation",
    to: "order-repository",
    label: "対応するorderの有無を照合する",
    directed: true,
    anchors: [{ path: "src/workers/payment-reconciliation.ts", startLine: 6, endLine: 11 }],
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

const secondaryStructureNodes = primaryStructureNodes.filter((node) =>
  ["payment-reconciliation", "payment-gateway", "order-repository"].includes(node.id),
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
    label: "typed payloadを渡す",
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
const fullStackRepositoryPaths = [
  ...new Set([
    ...fullStackStructureNodes.flatMap((node) => (node.anchor ? [node.anchor.path] : [])),
    ...fullStackStructureEdges.flatMap((edge) => edge.anchors.map((anchor) => anchor.path)),
  ]),
];
const activeStructures = repositoryDemo
  ? []
  : [
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
        sourceOid: firstHead,
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
const activeViewers = new Set();
const releasedViewers = new Set();
let changeSequence = 0;
let syncStage = 0;
let themePreference = "system";
let blockedImageRequestCount = 0;
let imageTextRequestCount = 0;
let pullRequestListEmpty = false;
let pullRequestListPaginated = false;
let pullRequestStatusRefreshCount = 0;
let pullRequestStatusRefreshFailure = false;
const selectedLineText = (value, startLine, endLine) =>
  value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");
const findUniqueQuotedLineRange = (quotedText, destinationText) => {
  const selected = quotedText.split("\n");
  const destination = destinationText.split("\n");
  let match = null;
  for (let index = 0; index <= destination.length - selected.length; index += 1) {
    if (!selected.every((line, offset) => destination[index + offset] === line)) continue;
    if (match) return null;
    match = { startLine: index + 1, endLine: index + selected.length };
  }
  return match;
};
const viewerIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const commit = (oid, parentOid, subject, hour) => ({
  oid,
  parentOids: [parentOid],
  subject,
  authorName: "Fixture Author",
  authoredAt: `2026-08-08T0${hour}:00:00.000Z`,
});

function currentPullRequest() {
  if (repositoryDemo) return repositoryDemo.pullRequest;
  const headOid = syncStage > 0 ? secondHead : firstHead;
  const body =
    syncStage > 1
      ? "The PR body was rewritten.\nAdditional review details.\n\nFinal note."
      : syncStage > 0
        ? "This is always the latest PR body."
        : "Review the fixture application.";
  return {
    id: pullRequestId,
    host: "github.com",
    owner: "acme",
    repository: "review-repo",
    number: 7,
    url: "https://github.com/acme/review-repo/pull/7",
    localRepositoryPath: "/fixture/review-repo",
    gitCommonDir: "/fixture/review-repo/.git",
    latestTitle: syncStage > 0 ? "Fixture review updated" : "Fixture review",
    latestBody: [
      body,
      `![Private attachment](${attachmentUrl})`,
      `![Broken attachment](${brokenAttachmentUrl})`,
      `![External PR image](http://${host}:${port}/api/test/external-image)`,
    ].join("\n\n"),
    latestBaseRefName: "main",
    latestHeadRefName: "feature",
    latestBaseOid: baseOid,
    latestComparisonBaseOid: baseOid,
    latestHeadOid: headOid,
    githubCreatedAt: "2026-08-07T01:00:00.000Z",
    githubUpdatedAt:
      syncStage > 1
        ? "2026-08-08T03:00:00.000Z"
        : syncStage > 0
          ? "2026-08-08T02:00:00.000Z"
          : "2026-08-08T01:00:00.000Z",
    githubState: "OPEN",
    githubIsDraft: false,
    fetchedAt: "2026-08-08T02:00:00.000Z",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T02:00:00.000Z",
  };
}

function currentView() {
  if (repositoryDemo) {
    return {
      pullRequest: repositoryDemo.pullRequest,
      comparisonBaseOid: repositoryDemo.baseOid,
      headOid: repositoryDemo.headOid,
      commits: repositoryDemo.commits,
    };
  }
  const pullRequest = currentPullRequest();
  return {
    pullRequest,
    comparisonBaseOid: baseOid,
    headOid: pullRequest.latestHeadOid,
    commits:
      syncStage > 0
        ? [
            commit(firstHead, baseOid, "Add fixture function", 1),
            commit(secondHead, firstHead, "Trim fixture input", 2),
          ]
        : [commit(firstHead, baseOid, "Add fixture function", 1)],
  };
}

function repositoryText(oid) {
  return [
    "export function fixture(value: string) {",
    oid === secondHead
      ? "  return value.trim();"
      : oid === baseOid
        ? "  return   value.toString();"
        : "  return value.toString();",
    "}",
    "",
    "const stableOne = true;",
    "const stableTwo = true;",
    "const stableThree = true;",
    "const stableFour = true;",
    "const stableFive = true;",
    "const stableSix = true;",
    "const stableSeven = true;",
    "const stableEight = true;",
    'export const fixtureSearchTarget = "fixture";',
    "",
  ].join("\n");
}

function viewportRepositoryText(oid) {
  return [
    "export function preserveViewport(input: string) {",
    oid === baseOid ? "  return   input.toString();" : "  return input.toString();",
    "}",
    "",
    ...Array.from({ length: 755 }, (_, index) => {
      const lineNumber = index + 5;
      const value = oid === secondHead && lineNumber % 20 === 0 ? lineNumber + 1 : lineNumber;
      return `export const viewportLine${lineNumber} = ${value};`;
    }),
    oid === secondHead
      ? 'export const viewportAnchor = "after";'
      : 'export const viewportAnchor = "before";',
    ...Array.from(
      { length: 40 },
      (_, index) => `export const viewportLine${index + 761} = ${index + 761};`,
    ),
    "",
  ].join("\n");
}

function repositoryDocumentText(oid, filePath) {
  if (repositoryDemo) return repositoryDemo.repositoryDocumentAt(oid, filePath).text ?? "";
  if (filePath === "binary.bin" || filePath === "large.txt") return "";
  if (/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(filePath)) return "";
  if (filePath === "docs/hybrid.md") {
    return "# Hybrid document\n\nThe renamed image is now Markdown.\n";
  }
  if (filePath === "README.md") {
    return [
      "# Orders service",
      "",
      "> A Fixture reference service for resilient order placement and asynchronous fulfillment.",
      "",
      oid === secondHead ? "Repository documentation updated." : "Repository documentation.",
      "This repository line uses a soft break.",
      "It stays inline when rendered as a Markdown file.",
      "",
      "Jump to [the request lifecycle](#request-lifecycle).",
      "",
      "![Order lifecycle](docs/order-lifecycle.svg)",
      "",
      "## Request lifecycle",
      "",
      "1. Authenticate the actor at the HTTP boundary.",
      "2. Validate and authorize the application command.",
      "3. Reserve inventory and authorize payment.",
      "4. Persist the order and its domain events in one transaction.",
      "5. Deliver events from the transactional outbox.",
      "",
      "## Local development",
      "",
      "```bash",
      "npm install",
      "npm test",
      "npm run dev",
      "```",
      "",
      "## Release readiness",
      "",
      "| Check | Status | Notes |",
      "| --- | --- | --- |",
      "| Unit tests | Ready | Fast checks cover the application and infrastructure boundaries. |",
      "| Deployment review | Pending | This intentionally long note verifies that prose in a wide Markdown table wraps at a readable column width instead of forcing the reader to scroll across one unbroken line for every row. |",
      "",
      "- [x] Unit tests",
      "- [ ] Deployment review",
      "",
      "<details>",
      "<summary>Operational details</summary>",
      "",
      "Payment reconciliation can be inspected without leaving the Markdown preview.",
      "",
      "</details>",
      "",
      "<script>window.__rvwUnsafeMarkdownExecuted = true;</script>",
      "",
      "## Operational notes",
      "",
      "The dispatcher uses `FOR UPDATE SKIP LOCKED`, so multiple workers can drain the outbox without claiming the same row. Consumers must still tolerate duplicate delivery.",
      "",
      "See [the order workflow](docs/order-workflow.md) for the complete failure model.",
      "",
      `![External telemetry](http://${host}:${port}/api/test/external-image)`,
      "",
    ].join("\n");
  }
  if (filePath === "src/new.ts") return "export const added = true;\n";
  if (filePath === "src/removed.ts") return "export const removed = true;\n";
  if (filePath === "src/viewport-anchor.ts") return viewportRepositoryText(oid);
  if (filePath in walkthroughRepositorySources || walkthroughRepositoryPaths.includes(filePath)) {
    const source = walkthroughRepositoryText(filePath);
    return filePath === "src/application/orders/create-order.ts" && oid === secondHead
      ? `${source.trimEnd()}\n\n// Updated orchestration path.\n`
      : source;
  }
  if (fullStackRepositoryPaths.includes(filePath)) {
    return [
      `// Full-stack Structure demonstration source: ${filePath}`,
      ...Array.from(
        { length: 47 },
        (_, index) => `export const demonstrationLine${index + 2} = ${index + 2};`,
      ),
      "",
    ].join("\n");
  }
  return repositoryText(oid);
}

function repositoryPathsAt(oid) {
  if (repositoryDemo) {
    return repositoryDemo.repositoryEntriesAt(oid).map((entry) => entry.path);
  }
  return [
    ...new Set([
      "README.md",
      "binary.bin",
      "large.txt",
      "src/fixture.ts",
      "src/viewport-anchor.ts",
      ...(oid === secondHead ? ["src/new.ts"] : ["src/removed.ts"]),
      "assets/modified.png",
      "assets/broken.png",
      "assets/too-large.png",
      "assets/unsupported.png",
      ...(oid === baseOid
        ? ["assets/deleted.png", "assets/old-name.png", "assets/hybrid.png"]
        : []),
      ...(oid === baseOid ? [] : ["assets/added.png", "assets/new-name.png", "docs/hybrid.md"]),
      ...walkthroughRepositoryPaths,
      ...fullStackRepositoryPaths,
    ]),
  ];
}

function missingRepositoryDocument(ref) {
  return {
    ref,
    availability: "missing",
    text: null,
    byteLength: 0,
    entryKind: "file",
    normalizedLineEndings: false,
    oid: null,
  };
}

function unavailableRepositoryDocument(ref, availability) {
  return {
    ref,
    availability,
    text: null,
    byteLength: availability === "binary" ? 4 : 1024 * 1024 + 1,
    entryKind: "file",
    normalizedLineEndings: false,
    oid: "d".repeat(40),
  };
}

function fixedStringMatches(text, query, matchCase, wholeWord) {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(escaped, matchCase ? "gu" : "giu");
  const wordCharacter = /[\p{L}\p{N}_]/u;
  const isWordCharacter = (value) => value !== undefined && wordCharacter.test(value);
  return [...text.matchAll(expression)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }))
    .filter(
      ({ start, end }) =>
        !wholeWord ||
        !(
          (isWordCharacter(text[start - 1]) && isWordCharacter(text[start])) ||
          (isWordCharacter(text[end - 1]) && isWordCharacter(text[end]))
        ),
    );
}

function document(ref, text, isVirtual = false) {
  return {
    ref,
    availability: "available",
    text,
    byteLength: Buffer.byteLength(text),
    entryKind: isVirtual ? "virtual" : "file",
    normalizedLineEndings: false,
    oid: isVirtual ? null : "d".repeat(40),
  };
}

function repositoryDocument(ref) {
  if (repositoryDemo) {
    return { ref, ...repositoryDemo.repositoryDocumentAt(ref.sourceOid, ref.path) };
  }
  if (ref.path === "binary.bin") return unavailableRepositoryDocument(ref, "binary");
  if (ref.path === "large.txt") return unavailableRepositoryDocument(ref, "too-large");
  return document(ref, repositoryDocumentText(ref.sourceOid, ref.path));
}

function hashDocument(text) {
  return createHash("sha256").update(text).digest("hex");
}

function enrichCommentTarget(target) {
  if (target.kind !== "document" || target.documentKind !== "pull-request-markdown") {
    return target;
  }
  const pullRequest = currentPullRequest();
  const markdown = `# ${pullRequest.latestTitle}\n\n${pullRequest.latestBody}`;
  const quotedText =
    target.startLine === null || target.endLine === null
      ? null
      : markdown
          .split("\n")
          .slice(target.startLine - 1, target.endLine)
          .join("\n");
  return {
    ...target,
    sourceDocumentHash: hashDocument(markdown),
    quotedText,
  };
}

const app = new Hono();
app.use("*", async (context, next) => {
  if (context.req.header("host") !== `${host}:${port}`) {
    return context.json(
      { ok: false, error: { code: "HOST_NOT_ALLOWED", message: "bad host" } },
      403,
    );
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(context.req.method)) {
    if (context.req.header("content-type")?.split(";")[0] !== "application/json") {
      return context.json(
        { ok: false, error: { code: "CONTENT_TYPE_REQUIRED", message: "json only" } },
        415,
      );
    }
    const origin = context.req.header("origin");
    if (origin && origin !== `http://${host}:${port}`) {
      return context.json(
        { ok: false, error: { code: "INVALID_ORIGIN", message: "bad origin" } },
        403,
      );
    }
  }
  await next();
});

app.use("/api/pull-requests/*", async (context, next) => {
  if (
    context.req.path === "/api/pull-requests" ||
    context.req.path === "/api/pull-requests/refresh-statuses"
  ) {
    await next();
    return;
  }
  const requestedId = context.req.path.match(/^\/api\/pull-requests\/([^/]+)/)?.[1] ?? "";
  if (!viewerIdPattern.test(requestedId)) {
    return context.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "invalid pull request ID" } },
      400,
    );
  }
  if (requestedId !== pullRequestId) {
    return context.json(
      { ok: false, error: { code: "PULL_REQUEST_NOT_FOUND", message: "missing pull request" } },
      404,
    );
  }
  await next();
});

app.get("/api/meta/change-sequence", (context) => {
  const viewerId = context.req.header("x-rvw-viewer-id");
  if (!viewerIdPattern.test(viewerId ?? "")) {
    return context.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "invalid viewer ID" } },
      400,
    );
  }
  activeViewers.add(viewerId);
  releasedViewers.delete(viewerId);
  return context.json({ ok: true, changeSequence });
});

app.post("/api/meta/viewers/release", async (context) => {
  const { viewerId } = await context.req.json();
  if (!viewerIdPattern.test(viewerId ?? "")) {
    return context.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "invalid viewer ID" } },
      400,
    );
  }
  activeViewers.delete(viewerId);
  releasedViewers.add(viewerId);
  return context.json({ ok: true });
});

app.get("/api/preferences/theme", (context) => context.json({ ok: true, themePreference }));

app.post("/api/preferences/theme", async (context) => {
  const input = await context.req.json();
  if (!["light", "dark", "system"].includes(input.themePreference)) {
    return context.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "invalid theme" } },
      400,
    );
  }
  themePreference = input.themePreference;
  return context.json({ ok: true, themePreference });
});

app.get("/api/test/viewers", (context) =>
  context.json({
    ok: true,
    activeViewers: [...activeViewers],
    releasedViewers: [...releasedViewers],
  }),
);

app.get("/api/test/external-image", (context) => {
  blockedImageRequestCount += 1;
  return context.body(null, 204);
});

app.get("/api/test/external-image-count", (context) =>
  context.json({ ok: true, count: blockedImageRequestCount }),
);

app.get("/api/test/image-text-request-count", (context) =>
  context.json({ ok: true, count: imageTextRequestCount }),
);

app.post("/api/test/pull-request-list-empty", async (context) => {
  const input = await context.req.json();
  pullRequestListEmpty = input.enabled === true;
  return context.json({ ok: true, enabled: pullRequestListEmpty });
});

app.post("/api/test/pull-request-list-paginated", async (context) => {
  const input = await context.req.json();
  pullRequestListPaginated = input.enabled === true;
  return context.json({ ok: true, enabled: pullRequestListPaginated });
});

app.post("/api/test/reset-pull-request-list", (context) => {
  pullRequestListEmpty = false;
  pullRequestListPaginated = false;
  pullRequestStatusRefreshCount = 0;
  pullRequestStatusRefreshFailure = false;
  return context.json({ ok: true });
});

app.post("/api/test/pull-request-status-refresh-failure", async (context) => {
  const input = await context.req.json();
  pullRequestStatusRefreshFailure = input.enabled === true;
  return context.json({ ok: true, enabled: pullRequestStatusRefreshFailure });
});

app.get("/api/test/pull-request-status-refresh-count", (context) =>
  context.json({ ok: true, count: pullRequestStatusRefreshCount }),
);

app.post("/api/test/reset-sync-stage", (context) => {
  syncStage = 0;
  return context.json({ ok: true });
});

app.get("/api/pull-requests", (context) => {
  const offset = Math.max(0, Number(context.req.query("offset") ?? 0));
  const limit = Math.min(100, Math.max(1, Number(context.req.query("limit") ?? 50)));
  const hideClosedOrMerged = context.req.query("hideClosedOrMerged") !== "false";
  const pullRequest = currentPullRequest();
  const currentSummary = {
    pullRequestId: pullRequest.id,
    owner: pullRequest.owner,
    repository: pullRequest.repository,
    number: pullRequest.number,
    title: pullRequest.latestTitle,
    githubCreatedAt: pullRequest.githubCreatedAt,
    githubUpdatedAt: pullRequest.githubUpdatedAt,
    githubState: pullRequestStatusRefreshCount > 0 ? "MERGED" : pullRequest.githubState,
    githubIsDraft: pullRequest.githubIsDraft,
    unresolvedCommentCount: comments.filter((comment) => comment.resolvedAt === null).length,
    resolvedCommentCount: comments.filter((comment) => comment.resolvedAt !== null).length,
    walkthroughCount: activeWalkthroughs.length,
    structureCount: activeStructures.length,
  };
  const paginatedItems = Array.from({ length: 50 }, (_, index) => ({
    pullRequestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    owner: "fixture-org",
    repository: "pagination-repo",
    number: 100 - index,
    title: `Pagination fixture ${index + 1}`,
    githubCreatedAt: "2026-08-01T00:00:00.000Z",
    githubUpdatedAt: "2026-08-07T00:00:00.000Z",
    githubState: "OPEN",
    githubIsDraft: false,
    unresolvedCommentCount: 0,
    resolvedCommentCount: 0,
    walkthroughCount: 0,
    structureCount: 0,
  }));
  const statusFixtureItems = repositoryDemo
    ? [
        {
          pullRequestId,
          owner: "a9n-shoji",
          repository: "rvw",
          number: 998,
          title: "Draft: refine the review workspace",
          githubCreatedAt: "2026-08-20T00:00:00.000Z",
          githubUpdatedAt: "2026-08-22T00:00:00.000Z",
          githubState: "OPEN",
          githubIsDraft: true,
          unresolvedCommentCount: 1,
          resolvedCommentCount: 0,
          walkthroughCount: 1,
          structureCount: 1,
        },
        {
          pullRequestId,
          owner: "a9n-shoji",
          repository: "rvw",
          number: 997,
          title: "Legacy: status not synchronized yet",
          githubCreatedAt: null,
          githubUpdatedAt: "2026-08-21T12:00:00.000Z",
          githubState: null,
          githubIsDraft: null,
          unresolvedCommentCount: 2,
          resolvedCommentCount: 1,
          walkthroughCount: 1,
          structureCount: 0,
        },
        {
          pullRequestId,
          owner: "a9n-shoji",
          repository: "rvw",
          number: 996,
          title: "Closed: explore an alternate navigation model",
          githubCreatedAt: "2026-08-18T00:00:00.000Z",
          githubUpdatedAt: "2026-08-21T00:00:00.000Z",
          githubState: "CLOSED",
          githubIsDraft: false,
          unresolvedCommentCount: 2,
          resolvedCommentCount: 3,
          walkthroughCount: 0,
          structureCount: 0,
        },
        {
          pullRequestId,
          owner: "a9n-shoji",
          repository: "rvw",
          number: 995,
          title: "Merged: add local-first review history",
          githubCreatedAt: "2026-08-15T00:00:00.000Z",
          githubUpdatedAt: "2026-08-20T00:00:00.000Z",
          githubState: "MERGED",
          githubIsDraft: false,
          unresolvedCommentCount: 0,
          resolvedCommentCount: 8,
          walkthroughCount: 2,
          structureCount: 1,
        },
      ]
    : [
        {
          pullRequestId: "22222222-2222-4222-8222-222222222222",
          owner: "octo-org",
          repository: "review-repo",
          number: 3,
          title:
            "Older fixture review with a deliberately long Pull Request title that must wrap onto multiple lines without being truncated",
          githubCreatedAt: null,
          githubUpdatedAt: "2026-07-01T00:00:00.000Z",
          githubState:
            pullRequestStatusRefreshCount > 0 && !pullRequestStatusRefreshFailure
              ? "CLOSED"
              : "OPEN",
          githubIsDraft: true,
          unresolvedCommentCount: 3,
          resolvedCommentCount: 5,
          walkthroughCount: 2,
          structureCount: 1,
        },
      ];
  const allItems = pullRequestListEmpty
    ? []
    : pullRequestListPaginated
      ? [...paginatedItems, currentSummary]
      : [currentSummary, ...statusFixtureItems];
  const items = hideClosedOrMerged
    ? allItems.filter((item) => item.githubState === null || item.githubState === "OPEN")
    : allItems;
  const pageItems = items.slice(offset, offset + limit);
  const hasMore = offset + pageItems.length < items.length;
  return context.json({
    ok: true,
    items: pageItems,
    pagination: {
      offset,
      limit,
      returned: pageItems.length,
      total: items.length,
      hasMore,
      nextOffset: hasMore ? offset + pageItems.length : null,
    },
  });
});

app.get("/api/pull-requests/:id", (context) => context.json({ ok: true, ...currentView() }));

app.post("/api/pull-requests/refresh-statuses", async (context) => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  pullRequestStatusRefreshCount += 1;
  changeSequence += 1;
  return context.json({
    ok: true,
    attempted: 2,
    updated: pullRequestStatusRefreshFailure ? 1 : 2,
    failures: pullRequestStatusRefreshFailure
      ? [
          {
            pullRequestId: "22222222-2222-4222-8222-222222222222",
            owner: "octo-org",
            repository: "review-repo",
            number: 3,
            error: {
              code: "GITHUB_ERROR",
              message: "Pull Request状態をGitHubから取得できませんでした。",
              suggestions: ["PR URLとgh認証を確認してください。"],
            },
          },
        ]
      : [],
  });
});

app.post("/api/pull-requests/:id/refresh", async (context) => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (!repositoryDemo) syncStage = Math.min(syncStage + 1, 2);
  changeSequence += 1;
  return context.json({ ok: true, ...currentView(), commentUpdatesApplied: 0 });
});

app.get("/api/pull-requests/:id/tree", (context) => {
  const oid = repositoryDemo
    ? (context.req.query("oid") ?? currentView().headOid)
    : currentView().headOid;
  if (repositoryDemo) {
    return context.json({
      ok: true,
      virtual: "Pull Request.md",
      entries: repositoryDemo.repositoryEntriesAt(oid),
    });
  }
  const paths = repositoryPathsAt(oid);
  return context.json({
    ok: true,
    virtual: "Pull Request.md",
    entries: paths.map((filePath, index) => ({
      mode: "100644",
      type: "blob",
      oid: index.toString(16).padStart(40, "0"),
      size:
        filePath === "binary.bin"
          ? 4
          : filePath === "large.txt"
            ? 1024 * 1024 + 1
            : Buffer.byteLength(repositoryDocumentText(oid, filePath)),
      path: filePath,
      kind: "file",
    })),
  });
});

app.get("/api/pull-requests/:id/changed-files", (context) => {
  if (repositoryDemo) {
    const oldOid = context.req.query("oldOid");
    const newOid = context.req.query("newOid");
    return context.json({
      ok: true,
      oldOid,
      newOid,
      files: repositoryDemo.changedFiles(oldOid, newOid),
    });
  }
  const range = context.req.query("oldOid") === firstHead;
  const files = range
    ? [
        {
          kind: "modified",
          status: "M",
          similarity: null,
          oldPath: "src/fixture.ts",
          newPath: "src/fixture.ts",
        },
        {
          kind: "modified",
          status: "M",
          similarity: null,
          oldPath: "README.md",
          newPath: "README.md",
        },
        {
          kind: "modified",
          status: "M",
          similarity: null,
          oldPath: "src/viewport-anchor.ts",
          newPath: "src/viewport-anchor.ts",
        },
      ]
    : [
        {
          kind: "modified",
          status: "M",
          similarity: null,
          oldPath: "src/fixture.ts",
          newPath: "src/fixture.ts",
        },
        {
          kind: "added",
          status: "A",
          similarity: null,
          oldPath: null,
          newPath: "src/new.ts",
        },
        {
          kind: "deleted",
          status: "D",
          similarity: null,
          oldPath: "src/removed.ts",
          newPath: null,
        },
        {
          kind: "modified",
          status: "M",
          similarity: null,
          oldPath: "src/viewport-anchor.ts",
          newPath: "src/viewport-anchor.ts",
        },
      ];
  files.push(
    {
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "src/http/routes/orders.ts",
      newPath: "src/http/routes/orders.ts",
    },
    {
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "src/application/orders/create-order.ts",
      newPath: "src/application/orders/create-order.ts",
    },
    {
      kind: "added",
      status: "A",
      similarity: null,
      oldPath: null,
      newPath: "src/infrastructure/events/postgres-outbox.ts",
    },
    {
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "src/http/routes/order-detail.ts",
      newPath: "src/http/routes/order-detail.ts",
    },
    {
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "src/shared/contracts/order-detail.ts",
      newPath: "src/shared/contracts/order-detail.ts",
    },
    {
      kind: "added",
      status: "A",
      similarity: null,
      oldPath: null,
      newPath: "src/frontend/orders/OrderDetailPage.tsx",
    },
    {
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "assets/modified.png",
      newPath: "assets/modified.png",
    },
    {
      kind: "added",
      status: "A",
      similarity: null,
      oldPath: null,
      newPath: "assets/added.png",
    },
    {
      kind: "deleted",
      status: "D",
      similarity: null,
      oldPath: "assets/deleted.png",
      newPath: null,
    },
    {
      kind: "renamed",
      status: "R100",
      similarity: 100,
      oldPath: "assets/old-name.png",
      newPath: "assets/new-name.png",
    },
    {
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "assets/too-large.png",
      newPath: "assets/too-large.png",
    },
    {
      kind: "modified",
      status: "M",
      similarity: null,
      oldPath: "assets/unsupported.png",
      newPath: "assets/unsupported.png",
    },
  );
  if (context.req.query("oldOid") === baseOid) {
    files.push({
      kind: "renamed",
      status: "R100",
      similarity: 100,
      oldPath: "assets/hybrid.png",
      newPath: "docs/hybrid.md",
    });
  }
  return context.json({
    ok: true,
    oldOid: context.req.query("oldOid"),
    newOid: context.req.query("newOid"),
    files,
  });
});

app.get("/api/pull-requests/:id/document", (context) => {
  if (context.req.query("kind") === "pull-request-markdown") {
    const pullRequest = currentPullRequest();
    const ref = { kind: "pull-request-markdown", pullRequestId };
    return context.json({
      ok: true,
      document: document(ref, `# ${pullRequest.latestTitle}\n\n${pullRequest.latestBody}`, true),
    });
  }
  const sourceOid = context.req.query("sourceOid");
  const filePath = context.req.query("path");
  if (/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(filePath ?? "")) {
    imageTextRequestCount += 1;
  }
  const ref = { kind: "repository-file", pullRequestId, sourceOid, path: filePath };
  if (!repositoryPathsAt(sourceOid).includes(filePath)) {
    return context.json({
      ok: true,
      document: missingRepositoryDocument(ref),
    });
  }
  return context.json({ ok: true, document: repositoryDocument(ref) });
});

app.on(["GET", "HEAD"], "/api/pull-requests/:id/markdown-asset", (context) => {
  const sourceOid = context.req.query("sourceOid");
  const filePath = context.req.query("path");
  if (filePath === "docs/order-lifecycle.svg") {
    context.header("content-type", "image/svg+xml; charset=utf-8");
    return context.req.method === "HEAD"
      ? context.body(null)
      : context.body(
          '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60"><rect width="240" height="60" rx="8" fill="#1f6feb"/><text x="120" y="36" text-anchor="middle" fill="white" font-family="sans-serif" font-size="16">Order lifecycle</text></svg>',
        );
  }
  if (filePath === "assets/too-large.png") {
    return context.json(
      { ok: false, error: { code: "FILE_TOO_LARGE", message: "too large" } },
      413,
    );
  }
  if (filePath === "assets/unsupported.png") {
    return context.json(
      { ok: false, error: { code: "UNSUPPORTED_IMAGE", message: "unsupported" } },
      415,
    );
  }
  if (
    !filePath ||
    !sourceOid ||
    filePath === "assets/broken.png" ||
    !repositoryPathsAt(sourceOid).includes(filePath) ||
    !/\.(?:png|jpe?g|gif|webp|avif)$/i.test(filePath)
  ) {
    return context.json(
      { ok: false, error: { code: "DOCUMENT_NOT_FOUND", message: "missing asset" } },
      404,
    );
  }
  context.header("content-type", "image/png");
  context.header("cache-control", "private, max-age=31536000, immutable");
  context.header("x-content-type-options", "nosniff");
  context.header("cross-origin-resource-policy", "same-origin");
  return context.req.method === "HEAD" ? context.body(null) : context.body(fixturePng);
});

app.get("/api/pull-requests/:id/github-attachment", (context) => {
  if (context.req.query("url") !== attachmentUrl) {
    return context.json(
      { ok: false, error: { code: "GITHUB_ERROR", message: "attachment unavailable" } },
      502,
    );
  }
  context.header("content-type", "image/png");
  context.header("cache-control", "private, max-age=31536000, immutable");
  context.header("x-content-type-options", "nosniff");
  context.header("cross-origin-resource-policy", "same-origin");
  return context.body(fixturePng);
});

app.get("/api/pull-requests/:id/diff", (context) => {
  const oldOid = context.req.query("oldOid");
  const newOid = context.req.query("newOid");
  const oldPath = context.req.query("oldPath");
  const newPath = context.req.query("newPath");
  if (
    [oldPath, newPath].some((filePath) =>
      /\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(filePath ?? ""),
    )
  ) {
    imageTextRequestCount += 1;
  }
  const oldDocument =
    oldPath && repositoryPathsAt(oldOid).includes(oldPath)
      ? repositoryDocument({
          kind: "repository-file",
          pullRequestId,
          sourceOid: oldOid,
          path: oldPath,
        })
      : null;
  const newDocument =
    newPath && repositoryPathsAt(newOid).includes(newPath)
      ? repositoryDocument({
          kind: "repository-file",
          pullRequestId,
          sourceOid: newOid,
          path: newPath,
        })
      : null;
  return context.json({ ok: true, diff: { old: oldDocument, new: newDocument } });
});

app.get("/api/pull-requests/:id/search", (context) => {
  const oid = context.req.query("oid");
  const query = context.req.query("q") ?? "";
  const matchCase = context.req.query("matchCase") === "true";
  const wholeWord = context.req.query("wholeWord") === "true";
  const pullRequest = currentPullRequest();
  const documents = [
    {
      document: { kind: "pull-request-markdown", pullRequestId },
      path: "Pull Request.md",
      text: `# ${pullRequest.latestTitle}\n\n${pullRequest.latestBody}`,
    },
    ...repositoryPathsAt(oid).map((filePath) => ({
      document: {
        kind: "repository-file",
        pullRequestId,
        sourceOid: oid,
        path: filePath,
      },
      path: filePath,
      text: repositoryDocumentText(oid, filePath),
    })),
  ];
  const results = documents.flatMap(({ document: documentRef, path: filePath, text }) =>
    text.split("\n").flatMap((lineText, index) => {
      const matches = fixedStringMatches(lineText, query, matchCase, wholeWord);
      return matches.length > 0
        ? [
            {
              document: documentRef,
              path: filePath,
              line: index + 1,
              text: lineText,
              matches,
            },
          ]
        : [];
    }),
  );
  return context.json({
    ok: true,
    results,
    matchCount: results.reduce((count, result) => count + result.matches.length, 0),
    truncated: false,
    limits: { queryBytes: 1024, resultCount: 500, stdoutBytes: 8388608 },
  });
});

app.get("/api/pull-requests/:id/comments", (context) => context.json({ ok: true, comments }));

app.get("/api/pull-requests/:id/walkthroughs", (context) =>
  context.json({
    ok: true,
    walkthroughs: activeWalkthroughs.map((walkthrough) => ({
      id: walkthrough.id,
      pullRequestId: walkthrough.pullRequestId,
      sourceOid: walkthrough.sourceOid,
      title: walkthrough.title,
      authorLabel: walkthrough.authorLabel,
      referenceCount: walkthrough.references.length,
      createdAt: walkthrough.createdAt,
    })),
  }),
);

app.get("/api/pull-requests/:id/structures", (context) =>
  context.json({
    ok: true,
    structures: activeStructures.map((structure) => ({
      id: structure.id,
      ref: structure.ref,
      pullRequestId: structure.pullRequestId,
      sourceOid: structure.sourceOid,
      title: structure.title,
      scope: structure.scope,
      createdAt: structure.createdAt,
      updatedAt: structure.updatedAt,
    })),
  }),
);

app.get("/api/pull-requests/:id/structures/:structureId", (context) => {
  const structure = activeStructures.find(
    (candidate) => candidate.id === context.req.param("structureId"),
  );
  return structure
    ? context.json({ ok: true, structure })
    : context.json({ ok: false, error: { code: "NOT_FOUND", message: "missing structure" } }, 404);
});

app.get("/api/pull-requests/:id/structures/:structureId/anchors/resolve", (context) => {
  const structure = activeStructures.find(
    (candidate) => candidate.id === context.req.param("structureId"),
  );
  const locatorKind = context.req.query("locatorKind");
  const locator =
    locatorKind === "node"
      ? { kind: "node", nodeId: context.req.query("nodeId") }
      : locatorKind === "edge"
        ? {
            kind: "edge",
            edgeId: context.req.query("edgeId"),
            anchorIndex: Number(context.req.query("anchorIndex")),
          }
        : null;
  const sourceAnchor = structure && locator ? structureSourceAnchor(structure, locator) : null;
  if (!structure || !sourceAnchor) {
    return context.json(
      { ok: false, error: { code: "NOT_FOUND", message: "missing structure anchor" } },
      404,
    );
  }
  const latestHeadOid = currentView().headOid;
  const ref = {
    kind: "repository-file",
    pullRequestId,
    sourceOid: latestHeadOid,
    path: sourceAnchor.path,
  };
  return context.json({
    ok: true,
    resolution: {
      outcome: "latest",
      anchorSourceOid: structure.sourceOid,
      latestHeadOid,
      referenceFingerprint: sourceAnchorFingerprint(structure.sourceOid, sourceAnchor),
      resolvedAnchor: sourceAnchor,
      target: {
        sourceOid: latestHeadOid,
        path: sourceAnchor.path,
        diffBaseOid: null,
        oldPath: sourceAnchor.path,
        newPath: sourceAnchor.path,
        hasDiff: false,
        startLine: sourceAnchor.startLine,
        endLine: sourceAnchor.endLine,
      },
      latestFile: null,
      document: repositoryDocument(ref),
    },
  });
});

app.post("/api/fixture/structures/:structureId/update", async (context) => {
  const structure = activeStructures.find(
    (candidate) => candidate.id === context.req.param("structureId"),
  );
  if (!structure) {
    return context.json(
      { ok: false, error: { code: "NOT_FOUND", message: "missing structure" } },
      404,
    );
  }
  const input = await context.req.json();
  if (input.clearFocus) {
    structure.title = input.title ?? "Order placement behavior without focus";
    structure.originNodeId = input.replacementOrigin ?? "http-controller";
    const remainingNodes = structure.nodes.filter((node) => node.id !== "hub");
    const remainingEdges = structure.edges.filter(
      (edge) => edge.from !== "hub" && edge.to !== "hub",
    );
    const neighbors = new Map(remainingNodes.map((node) => [node.id, new Set()]));
    for (const edge of remainingEdges) {
      neighbors.get(edge.from)?.add(edge.to);
      neighbors.get(edge.to)?.add(edge.from);
    }
    const reachable = new Set([structure.originNodeId]);
    const queue = [structure.originNodeId];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const neighbor of neighbors.get(current) ?? []) {
        if (reachable.has(neighbor)) continue;
        reachable.add(neighbor);
        queue.push(neighbor);
      }
    }
    structure.nodes = remainingNodes.filter((node) => reachable.has(node.id));
    structure.edges = remainingEdges.filter(
      (edge) => reachable.has(edge.from) && reachable.has(edge.to),
    );
    structure.updatedAt = "2026-08-08T05:00:00.000Z";
    changeSequence += 1;
    return context.json({ ok: true, structure });
  }
  structure.title = input.title ?? "Order placement behavior updated";
  structure.scope = input.scope ?? `${structure.scope} Updated without changing subject identity.`;
  structure.nodes = [
    ...structure.nodes
      .filter((node) => node.id !== "payment-reconciliation" && node.id !== "new-neighbor")
      .map((node) =>
        node.id === "hub" ? { ...node, label: input.hubLabel ?? "Create order updated" } : node,
      ),
    {
      id: "new-neighbor",
      label: "Order domain events",
      description: "placedとpayment.authorizedをaggregateからoutboxへ受け渡す。",
      kind: "event",
      anchor: { path: "src/domain/orders/order.ts", startLine: 14, endLine: 36 },
    },
  ];
  structure.edges = [
    ...structure.edges.filter(
      (edge) =>
        edge.id !== "reconciliation-checks-payment" &&
        edge.id !== "reconciliation-checks-order" &&
        edge.id !== "edge-new" &&
        edge.id !== "event-flows-to-outbox",
    ),
    {
      id: "edge-new",
      from: "hub",
      to: "new-neighbor",
      label: "aggregateからeventをreleaseする",
      directed: true,
      anchors: [
        { path: "src/application/orders/create-order.ts", startLine: 31, endLine: 34 },
        { path: "src/domain/orders/order.ts", startLine: 35, endLine: 37 },
      ],
    },
    {
      id: "event-flows-to-outbox",
      from: "new-neighbor",
      to: "outbox",
      label: "transaction内でreleaseして追記する",
      directed: true,
      anchors: [
        { path: "src/domain/orders/order.ts", startLine: 35, endLine: 37 },
        { path: "src/application/orders/create-order.ts", startLine: 31, endLine: 34 },
      ],
    },
  ];
  structure.updatedAt = "2026-08-08T04:00:00.000Z";
  changeSequence += 1;
  return context.json({ ok: true, structure });
});

app.post("/api/fixture/structures/:structureId/source-lifecycle", async (context) => {
  const structure = activeStructures.find(
    (candidate) => candidate.id === context.req.param("structureId"),
  );
  if (!structure) {
    return context.json(
      { ok: false, error: { code: "NOT_FOUND", message: "missing structure" } },
      404,
    );
  }
  const input = await context.req.json();
  if (input.nodeId && input.anchor) {
    const node = structure.nodes.find((candidate) => candidate.id === input.nodeId);
    if (!node) {
      return context.json(
        { ok: false, error: { code: "NOT_FOUND", message: "missing Structure node" } },
        404,
      );
    }
    const previousAnchor = node.anchor ? structuredClone(node.anchor) : null;
    node.anchor = input.anchor;
    if (input.reusePreviousAnchorOnNodeId) {
      const reuseNode = structure.nodes.find(
        (candidate) => candidate.id === input.reusePreviousAnchorOnNodeId,
      );
      if (reuseNode) reuseNode.anchor = previousAnchor;
    }
  }
  if (input.edgeId && input.anchor) {
    const edge = structure.edges.find((candidate) => candidate.id === input.edgeId);
    const anchorIndex = Number(input.anchorIndex ?? 0);
    if (!edge || !Number.isInteger(anchorIndex) || anchorIndex < 0 || !edge.anchors[anchorIndex]) {
      return context.json(
        { ok: false, error: { code: "NOT_FOUND", message: "missing Structure edge anchor" } },
        404,
      );
    }
    edge.anchors[anchorIndex] = input.anchor;
  }
  if (input.removeNodeId) {
    structure.nodes = structure.nodes.filter((node) => node.id !== input.removeNodeId);
    structure.edges = structure.edges.filter(
      (edge) => edge.from !== input.removeNodeId && edge.to !== input.removeNodeId,
    );
  }
  structure.updatedAt = new Date(Date.parse(structure.updatedAt) + 1_000).toISOString();
  changeSequence += 1;
  return context.json({ ok: true, structure });
});

app.delete("/api/pull-requests/:id/structures/:structureId", async (context) => {
  const structureIndex = activeStructures.findIndex(
    (candidate) => candidate.id === context.req.param("structureId"),
  );
  if (structureIndex < 0) {
    return context.json(
      { ok: false, error: { code: "NOT_FOUND", message: "missing structure" } },
      404,
    );
  }
  const input = await context.req.json();
  if (input.expectedUpdatedAt !== activeStructures[structureIndex].updatedAt) {
    return context.json(
      { ok: false, error: { code: "STRUCTURE_CONFLICT", message: "stale structure" } },
      409,
    );
  }
  const [structure] = activeStructures.splice(structureIndex, 1);
  const anchors =
    structure.nodes.filter((node) => node.anchor !== null).length +
    structure.edges.reduce((count, edge) => count + edge.anchors.length, 0);
  changeSequence += 1;
  return context.json({
    ok: true,
    deleted: {
      id: structure.id,
      ref: structure.ref,
      pullRequestId,
      counts: { nodes: structure.nodes.length, edges: structure.edges.length, anchors },
    },
  });
});

app.get(
  "/api/pull-requests/:id/walkthroughs/:walkthroughId/references/:referenceId/resolve",
  (context) => {
    const walkthrough = activeWalkthroughs.find(
      (candidate) => candidate.id === context.req.param("walkthroughId"),
    );
    const reference = walkthrough?.references.find(
      (candidate) => candidate.id === context.req.param("referenceId"),
    );
    if (!walkthrough || !reference) {
      return context.json(
        { ok: false, error: { code: "NOT_FOUND", message: "missing reference" } },
        404,
      );
    }
    const latestHeadOid = currentView().headOid;
    const ref = {
      kind: "repository-file",
      pullRequestId,
      sourceOid: latestHeadOid,
      path: reference.path,
    };
    return context.json({
      ok: true,
      resolution: {
        outcome: "latest",
        anchorSourceOid: walkthrough.sourceOid,
        latestHeadOid,
        referenceFingerprint: sourceAnchorFingerprint(walkthrough.sourceOid, reference),
        target: {
          sourceOid: latestHeadOid,
          path: reference.path,
          diffBaseOid: null,
          oldPath: reference.path,
          newPath: reference.path,
          hasDiff: false,
          startLine: reference.startLine,
          endLine: reference.endLine,
        },
        latestFile: null,
        document: repositoryDocument(ref),
      },
    });
  },
);

app.get("/api/pull-requests/:id/walkthroughs/:walkthroughId", (context) => {
  const walkthrough = activeWalkthroughs.find(
    (candidate) => candidate.id === context.req.param("walkthroughId"),
  );
  return walkthrough
    ? context.json({ ok: true, walkthrough })
    : context.json(
        { ok: false, error: { code: "NOT_FOUND", message: "missing walkthrough" } },
        404,
      );
});

app.post("/api/fixture/walkthroughs/:walkthroughId/update", async (context) => {
  const walkthrough = activeWalkthroughs.find(
    (candidate) => candidate.id === context.req.param("walkthroughId"),
  );
  if (!walkthrough) {
    return context.json(
      { ok: false, error: { code: "NOT_FOUND", message: "missing walkthrough" } },
      404,
    );
  }
  const input = await context.req.json();
  walkthrough.title = input.title;
  walkthrough.body = input.body;
  walkthrough.references[0].label = input.referenceLabel;
  if (typeof input.referencePath === "string") {
    walkthrough.references[0].path = input.referencePath;
  }
  if (input.referenceStartLine === null || Number.isInteger(input.referenceStartLine)) {
    walkthrough.references[0].startLine = input.referenceStartLine;
  }
  if (input.referenceEndLine === null || Number.isInteger(input.referenceEndLine)) {
    walkthrough.references[0].endLine = input.referenceEndLine;
  }
  for (const comment of comments) {
    if (comment.target.kind === "walkthrough" && comment.target.walkthroughId === walkthrough.id) {
      comment.target.walkthroughTitle = walkthrough.title;
    }
  }
  changeSequence += 1;
  return context.json({ ok: true, walkthrough });
});

app.delete("/api/pull-requests/:id/walkthroughs/:walkthroughId", (context) => {
  const walkthroughIndex = activeWalkthroughs.findIndex(
    (candidate) => candidate.id === context.req.param("walkthroughId"),
  );
  if (walkthroughIndex < 0) {
    return context.json(
      { ok: false, error: { code: "NOT_FOUND", message: "missing walkthrough" } },
      404,
    );
  }
  const [walkthrough] = activeWalkthroughs.splice(walkthroughIndex, 1);
  const associatedComments = comments.filter(
    (comment) =>
      comment.target.kind === "walkthrough" && comment.target.walkthroughId === walkthrough.id,
  );
  const associatedCommentIds = new Set(associatedComments.map((comment) => comment.id));
  const postCount = associatedComments.reduce((count, comment) => count + comment.posts.length, 0);
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    if (associatedCommentIds.has(comments[index].id)) comments.splice(index, 1);
  }
  changeSequence += 1;
  return context.json({
    ok: true,
    deleted: {
      id: walkthrough.id,
      ref: walkthrough.ref,
      pullRequestId,
      counts: {
        comments: associatedComments.length,
        posts: postCount,
        references: walkthrough.references.length,
      },
    },
  });
});

app.get("/api/comments/:id/placement", (context) => {
  const comment = comments.find((item) => item.id === context.req.param("id"));
  if (!comment) {
    return context.json(
      { ok: false, error: { code: "COMMENT_NOT_FOUND", message: "missing comment" } },
      404,
    );
  }
  if (comment.target.kind === "pull-request") {
    return context.json({ ok: true, placement: { outdated: false, range: null, path: null } });
  }
  if (comment.target.kind === "walkthrough") {
    const walkthrough = activeWalkthroughs.find(
      (candidate) => candidate.id === comment.target.walkthroughId,
    );
    if (
      !walkthrough ||
      (context.req.query("walkthroughId") && context.req.query("walkthroughId") !== walkthrough.id)
    ) {
      return context.json({ ok: true, placement: { outdated: true, range: null, path: null } });
    }
    if (comment.target.startLine === null) {
      return context.json({ ok: true, placement: { outdated: false, range: null, path: null } });
    }
    const range =
      comment.target.sourceDocumentHash === hashDocument(walkthrough.body)
        ? { startLine: comment.target.startLine, endLine: comment.target.endLine }
        : findUniqueQuotedLineRange(comment.target.quotedText, walkthrough.body);
    return context.json({
      ok: true,
      placement: range
        ? { outdated: false, range, path: null }
        : { outdated: true, range: null, path: null },
    });
  }
  const targetPath =
    comment.target.documentKind === "pull-request-markdown"
      ? "Pull Request.md"
      : comment.target.path;
  const requestedKind = context.req.query("kind");
  const requestedPath = context.req.query("path");
  const kindMatches = requestedKind === "commit" || requestedKind === comment.target.documentKind;
  const pathMatches = !requestedPath || requestedPath === targetPath;
  let range =
    comment.target.startLine === null
      ? null
      : { startLine: comment.target.startLine, endLine: comment.target.endLine };
  let targetOutdated = false;
  if (comment.target.documentKind === "pull-request-markdown" && range) {
    const pullRequest = currentPullRequest();
    const markdown = `# ${pullRequest.latestTitle}\n\n${pullRequest.latestBody}`;
    if (comment.target.sourceDocumentHash !== hashDocument(markdown)) {
      range = comment.target.quotedText
        ? findUniqueQuotedLineRange(comment.target.quotedText, markdown)
        : null;
      targetOutdated = range === null;
    }
  }
  return context.json({
    ok: true,
    placement: {
      outdated: !kindMatches || !pathMatches || targetOutdated,
      range: !kindMatches || !pathMatches || targetOutdated ? null : range,
      path: targetPath,
    },
  });
});

app.post("/api/comments", async (context) => {
  const input = await context.req.json();
  const now = new Date().toISOString();
  const id = randomUUID();
  const target =
    input.target.kind === "walkthrough"
      ? (() => {
          const walkthrough = activeWalkthroughs.find(
            (candidate) => candidate.id === input.target.walkthroughId,
          );
          const startLine = input.target.startLine ?? null;
          const endLine = input.target.endLine ?? null;
          return {
            ...input.target,
            walkthroughTitle: walkthrough?.title ?? "Walkthrough",
            sourceDocumentHash:
              walkthrough && startLine !== null && endLine !== null
                ? hashDocument(walkthrough.body)
                : null,
            quotedText:
              walkthrough && startLine !== null && endLine !== null
                ? selectedLineText(walkthrough.body, startLine, endLine)
                : null,
            startLine,
            endLine,
          };
        })()
      : enrichCommentTarget(input.target);
  const comment = {
    id,
    ref: `rvw://comment/${id}`,
    pullRequestId,
    createdHeadOid: currentPullRequest().latestHeadOid,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    target,
    posts: [
      {
        id: randomUUID(),
        commentId: id,
        body: input.body,
        relatedCommitOid: input.relatedCommitOid ?? null,
        references: input.references ?? [],
        authorLabel: input.authorLabel,
        lastModifiedBy:
          context.req.header("x-rvw-fixture-modifier") === "agent" ? "agent" : "human",
        isRoot: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  comments.push(comment);
  changeSequence += 1;
  return context.json({ ok: true, comment }, 201);
});

app.post("/api/comments/:id/posts", async (context) => {
  const input = await context.req.json();
  const comment = comments.find((item) => item.id === context.req.param("id"));
  const now = new Date().toISOString();
  const post = {
    id: randomUUID(),
    commentId: comment.id,
    body: input.body,
    relatedCommitOid: input.relatedCommitOid,
    references: input.references ?? [],
    authorLabel: input.authorLabel,
    lastModifiedBy: context.req.header("x-rvw-fixture-modifier") === "agent" ? "agent" : "human",
    isRoot: false,
    createdAt: now,
    updatedAt: now,
  };
  comment.posts.push(post);
  comment.updatedAt = post.createdAt;
  changeSequence += 1;
  return context.json({ ok: true, post }, 201);
});

app.patch("/api/comments/:id/posts/:postId", async (context) => {
  const input = await context.req.json();
  const comment = comments.find((item) => item.id === context.req.param("id"));
  const post = comment?.posts.find((item) => item.id === context.req.param("postId"));
  if (!post) {
    return context.json(
      { ok: false, error: { code: "COMMENT_POST_NOT_FOUND", message: "missing post" } },
      404,
    );
  }
  const now = new Date().toISOString();
  post.body = input.body;
  if (input.references !== undefined) post.references = input.references;
  post.lastModifiedBy =
    context.req.header("x-rvw-fixture-modifier") === "agent" ? "agent" : "human";
  post.updatedAt = now;
  comment.updatedAt = now;
  changeSequence += 1;
  return context.json({ ok: true, post });
});

app.delete("/api/comments/:id/posts/:postId", (context) => {
  const comment = comments.find((item) => item.id === context.req.param("id"));
  const postIndex =
    comment?.posts.findIndex((item) => item.id === context.req.param("postId")) ?? -1;
  if (!comment || postIndex < 0) {
    return context.json(
      { ok: false, error: { code: "COMMENT_POST_NOT_FOUND", message: "missing post" } },
      404,
    );
  }
  if (comment.posts[postIndex].isRoot) {
    return context.json(
      {
        ok: false,
        error: {
          code: "COMMENT_DELETE_NOT_ALLOWED",
          message: "root post cannot be deleted as a reply",
        },
      },
      409,
    );
  }
  const [post] = comment.posts.splice(postIndex, 1);
  comment.updatedAt = new Date().toISOString();
  changeSequence += 1;
  return context.json({ ok: true, deleted: { commentId: comment.id, postId: post.id } });
});

for (const action of ["resolve", "reopen"]) {
  app.post(`/api/comments/:id/${action}`, (context) => {
    const comment = comments.find((item) => item.id === context.req.param("id"));
    comment.resolvedAt = action === "resolve" ? new Date().toISOString() : null;
    comment.updatedAt = new Date().toISOString();
    changeSequence += 1;
    return context.json({ ok: true, comment });
  });
}

app.delete("/api/comments/:id", (context) => {
  const index = comments.findIndex((item) => item.id === context.req.param("id"));
  if (index < 0) {
    return context.json(
      { ok: false, error: { code: "COMMENT_NOT_FOUND", message: "missing comment" } },
      404,
    );
  }
  const comment = comments[index];
  comments.splice(index, 1);
  changeSequence += 1;
  return context.json({ ok: true, deleted: { id: comment.id, ref: comment.ref } });
});

const staticRoot = path.resolve("dist/web");
app.use("*", serveStatic({ root: staticRoot }));
const index = readFileSync(path.join(staticRoot, "index.html"), "utf8");
app.get("*", (context) => context.html(index));

serve({ fetch: app.fetch, hostname: host, port });
