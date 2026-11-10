require("dotenv").config();

process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const pool = require("../db");

const { claimRecurringPayment } = require("../utils/payment-claims");

const {
  prepareRetryOperation,
  updateRetryOperationAfterFailure,
  markOldRetryOperationForManualReview,
  markRetryOperationSucceeded,
} = require("../utils/payment-retry-status");

async function createRetryOperation(client, status, intentId) {
  const payment = await client.query(
    `INSERT INTO payments (instalment_number, amount, currency, status)
     VALUES (2, 100, 'SGD', 'pending')
     RETURNING id`
  );

  const result = await client.query(
    `INSERT INTO payment_retry_operations (
       payment_id,
       payment_attempt_number,
       create_request_id,
       confirm_request_id,
       airwallex_payment_intent_id,
       status
     )
     VALUES ($1, 2, $2, $3, $4, $5)
     RETURNING id`,
    [
      payment.rows[0].id,
      `test-create-${crypto.randomUUID()}`,
      `test-confirm-${crypto.randomUUID()}`,
      intentId,
      status,
    ]
  );

  return result.rows[0].id;
}

test("retry status helpers update the correct PostgreSQL records", async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const database = await client.query(
      "SELECT current_database() AS name"
    );

    assert.equal(database.rows[0].name, "qilife_test_db");

    const payment = await client.query(
      `INSERT INTO payments (instalment_number, amount, currency, status)
       VALUES (2, 100, 'SGD', 'pending')
       RETURNING id`
    );

    const claim = await claimRecurringPayment(
      client,
      payment.rows[0].id
    );

    assert.ok(claim);

    const firstPreparation = await prepareRetryOperation(client, {
      paymentId: payment.rows[0].id,
      paymentAttemptNumber: 2,
      claimToken: claim.processing_claim_token,
    });

    const savedIntentId = `test-recovered-intent-${crypto.randomUUID()}`;

    await client.query(
      `UPDATE payment_retry_operations
       SET airwallex_payment_intent_id = $2,
           status = 'intent_created'
       WHERE id = $1`,
      [firstPreparation.id, savedIntentId]
    );

    const secondPreparation = await prepareRetryOperation(client, {
      paymentId: payment.rows[0].id,
      paymentAttemptNumber: 2,
      claimToken: claim.processing_claim_token,
    });

    assert.equal(
      secondPreparation.create_request_id,
      firstPreparation.create_request_id
    );
    assert.equal(
      secondPreparation.confirm_request_id,
      firstPreparation.confirm_request_id
    );
    assert.equal(secondPreparation.id, firstPreparation.id);
    assert.equal(secondPreparation.airwallex_payment_intent_id, savedIntentId);
    assert.equal(secondPreparation.status, "intent_created");

    const retryableId = await createRetryOperation(
      client,
      "intent_created",
      "test-retryable-failure"
    );

    const nonRetryableId = await createRetryOperation(
      client,
      "confirmation_requested",
      "test-non-retryable-failure"
    );

    const oldIntentId = await createRetryOperation(
      client,
      "intent_created",
      "test-old-intent"
    );

    const currentIntentId = await createRetryOperation(
      client,
      "failed",
      "test-current-intent"
    );

    const protectedId = await createRetryOperation(
      client,
      "succeeded",
      "test-already-succeeded"
    );

    const unrelatedId = await createRetryOperation(
      client,
      "intent_created",
      "test-unrelated-intent"
    );

    await updateRetryOperationAfterFailure(client, {
      paymentIntentId: "test-retryable-failure",
      canRetry: true,
      errorMessage: "Retry may continue",
    });

    let result = await client.query(
      "SELECT status, last_error FROM payment_retry_operations WHERE id = $1",
      [retryableId]
    );

    assert.equal(result.rows[0].status, "failed");
    assert.equal(result.rows[0].last_error, "Retry may continue");

    await updateRetryOperationAfterFailure(client, {
      paymentIntentId: "test-non-retryable-failure",
      canRetry: false,
      errorMessage: "Manual review needed",
    });

    result = await client.query(
      "SELECT status, last_error FROM payment_retry_operations WHERE id = $1",
      [nonRetryableId]
    );

    assert.equal(result.rows[0].status, "manual_review");
    assert.equal(result.rows[0].last_error, "Manual review needed");

    await markOldRetryOperationForManualReview(
      client,
      "test-old-intent"
    );

    result = await client.query(
      "SELECT status, last_error FROM payment_retry_operations WHERE id = $1",
      [oldIntentId]
    );

    assert.equal(result.rows[0].status, "manual_review");
    assert.equal(
      result.rows[0].last_error,
      "An older PaymentIntent succeeded after replacement."
    );

    await markRetryOperationSucceeded(
      client,
      "test-current-intent"
    );

    result = await client.query(
      "SELECT status, last_error FROM payment_retry_operations WHERE id = $1",
      [currentIntentId]
    );

    assert.equal(result.rows[0].status, "succeeded");
    assert.equal(result.rows[0].last_error, null);

    await markOldRetryOperationForManualReview(
      client,
      "test-already-succeeded"
    );

    result = await client.query(
      "SELECT status FROM payment_retry_operations WHERE id = $1",
      [protectedId]
    );

    assert.equal(result.rows[0].status, "succeeded");

    result = await client.query(
      "SELECT status FROM payment_retry_operations WHERE id = $1",
      [unrelatedId]
    );

    assert.equal(result.rows[0].status, "intent_created");

    console.log("All PostgreSQL retry status checks passed.");
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
