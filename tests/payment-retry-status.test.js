const test = require("node:test");
const assert = require("node:assert/strict");

const {
  updateRetryOperationAfterFailure,
  markOldRetryOperationForManualReview,
  markRetryOperationSucceeded,
} = require("../utils/payment-retry-status");

function makeClient() {
  const calls = [];

  return {
    calls,
    async query(sql, values) {
      calls.push({
        sql: sql.replace(/\\s+/g, " ").trim(),
        values,
      });

      return { rowCount: 1, rows: [] };
    },
  };
}

test("retryable failure marks only the matching retry operation as failed", async () => {
  const client = makeClient();

  await updateRetryOperationAfterFailure(client, {
    paymentIntentId: "pi_retry_2",
    canRetry: true,
    errorMessage: "Issuer declined the payment",
  });

  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].sql, /WHEN \$2::BOOLEAN THEN 'failed'/);
  assert.match(client.calls[0].sql, /ELSE 'manual_review'/);
  assert.match(
    client.calls[0].sql,
    /WHERE airwallex_payment_intent_id = \$1/
  );
  assert.deepEqual(client.calls[0].values, [
    "pi_retry_2",
    true,
    "Issuer declined the payment",
  ]);
});

test("failure that cannot be retried is marked for manual review", async () => {
  const client = makeClient();

  await updateRetryOperationAfterFailure(client, {
    paymentIntentId: "pi_retry_3",
    canRetry: false,
    errorMessage: "Recurring consent is unavailable",
  });

  assert.deepEqual(client.calls[0].values, [
    "pi_retry_3",
    false,
    "Recurring consent is unavailable",
  ]);
  assert.match(client.calls[0].sql, /ELSE 'manual_review'/);
});

test("missing failure message uses a safe default", async () => {
  const client = makeClient();

  await updateRetryOperationAfterFailure(client, {
    paymentIntentId: "pi_retry_2",
    canRetry: true,
  });

  assert.equal(client.calls[0].values[2], "Payment attempt failed");
});

test("old PaymentIntent success marks its own retry operation for manual review", async () => {
  const client = makeClient();

  await markOldRetryOperationForManualReview(client, "pi_old");

  assert.match(client.calls[0].sql, /SET status = 'manual_review'/);
  assert.match(
    client.calls[0].sql,
    /An older PaymentIntent succeeded after replacement/
  );
  assert.match(client.calls[0].sql, /status <> 'succeeded'/);
  assert.deepEqual(client.calls[0].values, ["pi_old"]);
});

test("current PaymentIntent success marks its matching retry operation as succeeded", async () => {
  const client = makeClient();

  await markRetryOperationSucceeded(client, "pi_current");

  assert.match(client.calls[0].sql, /SET status = 'succeeded'/);
  assert.match(client.calls[0].sql, /last_error = NULL/);
  assert.match(
    client.calls[0].sql,
    /WHERE airwallex_payment_intent_id = \$1/
  );
  assert.deepEqual(client.calls[0].values, ["pi_current"]);
});
