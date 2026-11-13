const test = require("node:test");
const assert = require("node:assert/strict");

const payment = {
  id: "11111111-1111-4111-8111-111111111111",
  subscription_id: "22222222-2222-4222-8222-222222222222",
  amount: "2100.00",
  currency: "SGD",
  status: "pending",
  manual_review_required: false,
  manual_review_reason: null,
  airwallex_payment_id: "pi-current-test",
  total_instalments: 6,
};

const history = new Map([
  ["pi-old-test", "REQUIRES_PAYMENT_METHOD"],
  ["pi-current-test", "REQUIRES_PAYMENT_METHOD"],
]);

const retryCalls = {
  oldIntentManualReview: [],
  successfulIntent: [],
};

const mockClient = {
  async query(sql, params = []) {
    const query = sql.replace(/\s+/g, " ").trim();

    if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") {
      return { rowCount: null, rows: [] };
    }

    if (query.includes("INSERT INTO webhook_events")) {
      return { rowCount: 1, rows: [{ event_id: params[0] }] };
    }

    if (query.includes("FROM airwallex_payment_intents AS intents")) {
      const intentId = params[1];

      if (!history.has(intentId)) {
        return { rowCount: 0, rows: [] };
      }

      return {
        rowCount: 1,
        rows: [{
          id: payment.id,
          subscription_id: payment.subscription_id,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          manual_review_required: payment.manual_review_required,
          airwallex_payment_id: payment.airwallex_payment_id,
          total_instalments: payment.total_instalments,
        }],
      };
    }

    if (
      query.includes("UPDATE airwallex_payment_intents") &&
      query.includes("SET status = 'SUCCEEDED'")
    ) {
      const intentId = params[2];
      history.set(intentId, "SUCCEEDED");
      return { rowCount: 1, rows: [] };
    }

    if (
      query.includes("UPDATE payments") &&
      query.includes("SET status = CASE")
    ) {
      payment.status =
        payment.status === "paid" ? "paid" : "review_required";
      payment.manual_review_required = true;
      payment.manual_review_reason =
        "An older PaymentIntent succeeded after replacement.";

      return { rowCount: 1, rows: [] };
    }

    if (query.includes("INSERT INTO payment_review_events")) {
      return { rowCount: 1, rows: [] };
    }

    if (
      query.includes("UPDATE payments") &&
      query.includes("SET status = 'paid'")
    ) {
      if (payment.airwallex_payment_id !== params[2]) {
        return { rowCount: 0, rows: [] };
      }

      payment.status = "paid";
      return { rowCount: 1, rows: [{ id: payment.id }] };
    }

    if (
      query.includes("SELECT") &&
      query.includes("paid_at AT TIME ZONE 'Asia/Singapore'")
    ) {
      return {
        rowCount: 1,
        rows: [{
          paid_date_singapore: "2026-11-10",
          instalment_number: 2,
        }],
      };
    }

    if (query.includes("UPDATE subscriptions s")) {
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Unexpected SQL in webhook test: ${query}`);
  },

  release() {},
};

let connectCalls = 0;

const mockPool = {
  async connect() {
    connectCalls += 1;
    return mockClient;
  },
};

const dbPath = require.resolve("../db");
const airwallexPath = require.resolve("../airwallex");
const retryStatusPath = require.resolve("../utils/payment-retry-status");

const originalModules = {
  db: require.cache[dbPath],
  airwallex: require.cache[airwallexPath],
  retryStatus: require.cache[retryStatusPath],
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: mockPool,
};

require.cache[airwallexPath] = {
  id: airwallexPath,
  filename: airwallexPath,
  loaded: true,
  exports: {
    retrieveAirwallexPaymentConsent: async () => {
      throw new Error("This test must not retrieve payment consent");
    },
  },
};

require.cache[retryStatusPath] = {
  id: retryStatusPath,
  filename: retryStatusPath,
  loaded: true,
  exports: {
    updateRetryOperationAfterFailure: async () => {},
    markOldRetryOperationForManualReview: async (_client, intentId) => {
      retryCalls.oldIntentManualReview.push(intentId);
    },
    markRetryOperationSucceeded: async (_client, intentId) => {
      retryCalls.successfulIntent.push(intentId);
    },
  },
};

const router = require("../routes/webhooks");

for (const [path, original] of [
  [dbPath, originalModules.db],
  [airwallexPath, originalModules.airwallex],
  [retryStatusPath, originalModules.retryStatus],
]) {
  if (original) {
    require.cache[path] = original;
  } else {
    delete require.cache[path];
  }
}

const webhookHandler = router.stack
  .find((layer) => layer.route?.path === "/")
  .route.stack
  .find((layer) => layer.method === "post")
  .handle;

async function sendWebhook(event) {
  let statusCode;
  let responseBody;

  const req = {
    webhookSignatureValid: true,
    isAirwallexTestEvent: false,
    body: event,
  };

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await webhookHandler(req, res);

  return { statusCode, responseBody };
}

test("a PaymentIntent status event with a malformed merchant order ID is ignored before database access", async () => {
  const previousConnectCalls = connectCalls;

  const result = await sendWebhook({
    id: "event-malformed-status-test",
    name: "payment_intent.updated",
    data: {
      object: {
        id: "pi-unrelated-test",
        merchant_order_id: "qi-webhook-probe-1794565884379",
        status: "PENDING",
        updated_at: "2026-11-13T10:00:00Z",
      },
    },
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.responseBody, {
    received: true,
    ignored: true,
  });
  assert.equal(connectCalls, previousConnectCalls);
});

test("a successful PaymentIntent with a malformed merchant order ID returns 500 before database access", async () => {
  const previousConnectCalls = connectCalls;

  const result = await sendWebhook({
    id: "event-malformed-success-test",
    name: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi-unmatched-success-test",
        merchant_order_id: "qi-webhook-probe-1794565884379",
        status: "SUCCEEDED",
        amount: 2100,
        currency: "SGD",
        updated_at: "2026-11-13T10:00:00Z",
      },
    },
  });

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.responseBody, {
    message: "Could not process webhook",
  });
  assert.equal(connectCalls, previousConnectCalls);
});

test("an old PaymentIntent success is reviewed, then the current success is recorded as paid", async () => {
  const oldResult = await sendWebhook({
    id: "event-old-success-test",
    name: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi-old-test",
        merchant_order_id: payment.id,
        status: "SUCCEEDED",
        amount: 2100,
        currency: "SGD",
        updated_at: "2026-11-10T01:00:00Z",
      },
    },
  });

  assert.equal(oldResult.statusCode, 200);
  assert.equal(oldResult.responseBody.manual_review_required, true);
  assert.equal(payment.status, "review_required");
  assert.equal(payment.manual_review_required, true);
  assert.equal(
    payment.manual_review_reason,
    "An older PaymentIntent succeeded after replacement."
  );
  assert.equal(history.get("pi-old-test"), "SUCCEEDED");
  assert.deepEqual(retryCalls.oldIntentManualReview, ["pi-old-test"]);

  const currentResult = await sendWebhook({
    id: "event-current-success-test",
    name: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi-current-test",
        merchant_order_id: payment.id,
        status: "SUCCEEDED",
        amount: 2100,
        currency: "SGD",
        updated_at: "2026-11-10T02:00:00Z",
      },
    },
  });

  assert.equal(currentResult.statusCode, 200);
  assert.equal(currentResult.responseBody.processed, true);
  assert.equal(payment.status, "paid");
  assert.equal(payment.manual_review_required, true);
  assert.equal(
    payment.manual_review_reason,
    "An older PaymentIntent succeeded after replacement."
  );
  assert.equal(history.get("pi-current-test"), "SUCCEEDED");
  assert.deepEqual(retryCalls.successfulIntent, ["pi-current-test"]);
});
