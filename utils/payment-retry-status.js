const crypto = require("crypto");
const { assertRecurringPaymentClaim } = require("./payment-claims");

async function prepareRetryOperation(
  client,
  { paymentId, paymentAttemptNumber, claimToken }
) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client is required");
  }

  if (!paymentId || !claimToken) {
    throw new Error("Payment ID and claim token are required");
  }

  await assertRecurringPaymentClaim(client, paymentId, claimToken);

  if (![2, 3].includes(Number(paymentAttemptNumber))) {
    throw new Error("Retry attempt number must be 2 or 3");
  }

  const createRequestId = crypto.randomUUID();
  const confirmRequestId = crypto.randomUUID();

  const inserted = await client.query(
    `INSERT INTO payment_retry_operations (
       payment_id,
       payment_attempt_number,
       create_request_id,
       confirm_request_id,
       status
     )
     VALUES ($1, $2, $3, $4, 'prepared')
     ON CONFLICT (payment_id, payment_attempt_number)
     DO NOTHING
     RETURNING
       id,
       payment_id,
       payment_attempt_number,
       create_request_id,
       confirm_request_id,
       airwallex_payment_intent_id,
       status`,
    [
      paymentId,
      Number(paymentAttemptNumber),
      createRequestId,
      confirmRequestId,
    ]
  );

  if (inserted.rows.length === 1) {
    return inserted.rows[0];
  }

  const existing = await client.query(
    `SELECT
       id,
       payment_id,
       payment_attempt_number,
       create_request_id,
       confirm_request_id,
       airwallex_payment_intent_id,
       status
     FROM payment_retry_operations
     WHERE payment_id = $1
       AND payment_attempt_number = $2
     FOR UPDATE`,
    [paymentId, Number(paymentAttemptNumber)]
  );

  if (existing.rows.length !== 1) {
    throw new Error("Could not retrieve the existing retry operation");
  }

  return existing.rows[0];
}

async function updateRetryOperationAfterFailure(
  client,
  { paymentIntentId, canRetry, errorMessage }
) {
  await client.query(
    `UPDATE payment_retry_operations
     SET status = CASE
           WHEN $2::BOOLEAN THEN 'failed'
           ELSE 'manual_review'
         END,
         last_error = $3,
         updated_at = NOW()
     WHERE airwallex_payment_intent_id = $1
       AND status IN (
         'intent_created',
         'confirmation_requested',
         'failed'
       )`,
    [
      paymentIntentId,
      canRetry,
      errorMessage || "Payment attempt failed",
    ]
  );
}

async function markOldRetryOperationForManualReview(client, paymentIntentId) {
  await client.query(
    `UPDATE payment_retry_operations
     SET status = 'manual_review',
         last_error = 'An older PaymentIntent succeeded after replacement.',
         updated_at = NOW()
     WHERE airwallex_payment_intent_id = $1
       AND status <> 'succeeded'`,
    [paymentIntentId]
  );
}

async function markRetryOperationSucceeded(client, paymentIntentId) {
  await client.query(
    `UPDATE payment_retry_operations
     SET status = 'succeeded',
         last_error = NULL,
         updated_at = NOW()
     WHERE airwallex_payment_intent_id = $1
       AND status IN (
         'prepared',
         'intent_created',
         'confirmation_requested',
         'failed'
       )`,
    [paymentIntentId]
  );
}

module.exports = {
  prepareRetryOperation,
  updateRetryOperationAfterFailure,
  markOldRetryOperationForManualReview,
  markRetryOperationSucceeded,
};
