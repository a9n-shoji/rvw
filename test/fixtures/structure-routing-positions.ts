// Fixed reviewer positions isolate routing/label regression coverage from canonical placement changes.
export const routingPositions = {
  order: {
    "authorization-policy": {
      x: 648,
      y: 84,
    },
    "idempotency-store": {
      x: 356,
      y: 268,
    },
    hub: {
      x: 648,
      y: 268,
    },
    "transaction-runner": {
      x: 1004,
      y: 84,
    },
    "order-repository": {
      x: 1296,
      y: 84,
    },
    outbox: {
      x: 1004,
      y: 268,
    },
    "database-schema": {
      x: 1296,
      y: 268,
    },
    "order-aggregate": {
      x: 356,
      y: 510,
    },
    "inventory-client": {
      x: 648,
      y: 510,
    },
    "pricing-policy": {
      x: 356,
      y: 694,
    },
    "payment-gateway": {
      x: 648,
      y: 694,
    },
    "http-controller": {
      x: 1004,
      y: 510,
    },
    "http-routes": {
      x: 1296,
      y: 510,
    },
    "request-schema": {
      x: 1004,
      y: 694,
    },
    "auth-middleware": {
      x: 1296,
      y: 694,
    },
    "composition-root": {
      x: 64,
      y: 64,
    },
  },
  detail: {
    "order-read-repository": {
      x: 1004,
      y: 64,
    },
    "orders-read-model": {
      x: 1296,
      y: 64,
    },
    "get-order-query": {
      x: 1004,
      y: 248,
    },
    "order-response-presenter": {
      x: 1296,
      y: 248,
    },
    "order-not-found": {
      x: 1004,
      y: 432,
    },
    "order-line-items": {
      x: 356,
      y: 674,
    },
    "order-detail-error": {
      x: 648,
      y: 674,
    },
    "order-status-badge": {
      x: 64,
      y: 858,
    },
    "order-detail-page": {
      x: 356,
      y: 858,
    },
    "order-detail-query-hook": {
      x: 648,
      y: 858,
    },
    "order-summary-card": {
      x: 356,
      y: 1042,
    },
    "order-query-cache": {
      x: 648,
      y: 1042,
    },
    "detail-params": {
      x: 210,
      y: 156,
    },
    "order-detail-route": {
      x: 502,
      y: 156,
    },
    "detail-actor-auth": {
      x: 502,
      y: 340,
    },
    "order-api-client": {
      x: 1004,
      y: 858,
    },
    "order-detail-contract": {
      x: 1296,
      y: 858,
    },
  },
  fanOut: {
    hub: {
      x: 1152,
      y: 758,
    },
    "leaf-00": {
      x: 1152,
      y: 922,
    },
    "leaf-01": {
      x: 880,
      y: 758,
    },
    "leaf-02": {
      x: 880,
      y: 922,
    },
    "leaf-03": {
      x: 1424,
      y: 758,
    },
    "leaf-04": {
      x: 1152,
      y: 594,
    },
    "leaf-05": {
      x: 880,
      y: 594,
    },
    "leaf-06": {
      x: 1424,
      y: 594,
    },
    "leaf-07": {
      x: 1424,
      y: 922,
    },
    "leaf-08": {
      x: 1152,
      y: 430,
    },
    "leaf-09": {
      x: 608,
      y: 758,
    },
    "leaf-10": {
      x: 608,
      y: 556,
    },
    "leaf-11": {
      x: 1696,
      y: 758,
    },
    "leaf-12": {
      x: 1152,
      y: 1086,
    },
    "leaf-13": {
      x: 1696,
      y: 556,
    },
    "leaf-14": {
      x: 608,
      y: 1086,
    },
    "leaf-15": {
      x: 1696,
      y: 1086,
    },
    "leaf-16": {
      x: 1676,
      y: 392,
    },
    "leaf-17": {
      x: 608,
      y: 392,
    },
    "leaf-18": {
      x: 1948,
      y: 922,
    },
    "leaf-19": {
      x: 1968,
      y: 594,
    },
    "leaf-20": {
      x: 1404,
      y: 266,
    },
    "leaf-21": {
      x: 880,
      y: 266,
    },
    "leaf-22": {
      x: 1968,
      y: 1086,
    },
    "leaf-23": {
      x: 336,
      y: 594,
    },
    "leaf-24": {
      x: 336,
      y: 922,
    },
    "leaf-25": {
      x: 336,
      y: 1086,
    },
    "leaf-26": {
      x: 1404,
      y: 1250,
    },
    "leaf-27": {
      x: 880,
      y: 1250,
    },
    "leaf-28": {
      x: 1676,
      y: 1250,
    },
    "leaf-29": {
      x: 608,
      y: 1250,
    },
    "leaf-30": {
      x: 880,
      y: 430,
    },
    "leaf-31": {
      x: 880,
      y: 1086,
    },
    "leaf-32": {
      x: 1424,
      y: 1086,
    },
    "leaf-33": {
      x: 608,
      y: 922,
    },
    "leaf-34": {
      x: 336,
      y: 758,
    },
    "leaf-35": {
      x: 1968,
      y: 758,
    },
    "leaf-36": {
      x: 336,
      y: 430,
    },
    "leaf-37": {
      x: 1968,
      y: 430,
    },
    "leaf-38": {
      x: 1676,
      y: 228,
    },
    "leaf-39": {
      x: 608,
      y: 228,
    },
    "leaf-40": {
      x: 64,
      y: 758,
    },
    "leaf-41": {
      x: 1152,
      y: 102,
    },
    "leaf-42": {
      x: 880,
      y: 102,
    },
    "leaf-43": {
      x: 1424,
      y: 64,
    },
    "leaf-44": {
      x: 2240,
      y: 758,
    },
    "leaf-45": {
      x: 2220,
      y: 922,
    },
    "leaf-46": {
      x: 1696,
      y: 64,
    },
    "leaf-47": {
      x: 608,
      y: 64,
    },
    "leaf-48": {
      x: 64,
      y: 594,
    },
  },
};
