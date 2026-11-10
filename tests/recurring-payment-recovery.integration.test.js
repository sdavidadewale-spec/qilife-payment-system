require("dotenv").config();

process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const crypto = require("crypto");
const pool = require("../db");

function getSingaporeDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

async function createTestSubscription(
  client,
  label,
  earlierPaymentStatus = "paid"
) {
  const unique = crypto.randomUUID();

  const student = await client.query(
    `INSERT INTO students (
       full_name,
       email,
       airwallex_customer_id
     )
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      `Recovery Test ${label}`,
      `recovery-${unique}@example.test`,
      `recovery-customer-${unique}`,
    ]
  );

  const subscription = await client.query(
    `INSERT INTO subscriptions (
       student_id,
       total_amount,
       currency,
       total_instalments,
       status,
       airwallex_payment_consent_id,
       payment_consent_status,
       airwallex_payment_method_id,
       airwallex_payment_method_type
     )
     VALUES ($1, 200, 'SGD', 2, 'active', $2, 'VERIFIED', $3, 'card')
     RETURNING id`,
    [
      student.rows[0].id,
      `recovery-consent-${unique}`,
      `recovery-method-${unique}`,
    ]
  );

  const subscriptionId = subscription.rows[0].id;

  await client.query(
    `INSERT INTO payments (
       subscription_id,
       instalment_number,
       amount,
       currency,
       status,
       due_date
     )
     VALUES ($1, 1, 100, 'SGD', $2, CURRENT_DATE - 30)`,
    [subscriptionId, earlierPaymentStatus]
  );

  return subscriptionId;
}

async function createRecurringPayment(
  client,
  subscriptionId,
  options = {}
) {
  const {
    status = "pending",
    processingStartedAt = null,
    nextRetryAt = null,
    paymentIntentId = null,
  } = options;

  const result = await client.query(
    `INSERT INTO payments (
       subscription_id,
       instalment_number,
       amount,
       currency,
       status,
       due_date,
       processing_started_at,
       next_retry_at,
       airwallex_payment_id
     )
     VALUES (
       $1, 2, 100, 'SGD', $2, CURRENT_DATE - 1, $3, $4, $5
     )
     RETURNING id`,
    [
      subscriptionId,
      status,
      processingStartedAt,
      nextRetryAt,
      paymentIntentId,
    ]
  );

  return result.rows[0].id;
}

async function addFailedAttempt(
  client,
  paymentId,
  intentId,
  merchantAdviceCode,
  issuerResponseCode,
  attemptNumber = 1
) {
  await client.query(
    `INSERT INTO airwallex_payment_attempts (
       payment_id,
       attempt_number,
       airwallex_payment_intent_id,
       airwallex_payment_attempt_id,
       status,
       amount,
       currency,
       merchant_advice_code,
       issuer_response_code,
       airwallex_created_at
     )
     VALUES ($1, $2, $3, $4, 'FAILED', 100, 'SGD', $5, $6, NOW())`,
    [
      paymentId,
      attemptNumber,
      intentId,
      `recovery-attempt-${crypto.randomUUID()}`,
      merchantAdviceCode,
      issuerResponseCode,
    ]
  );
}

async function addPaymentIntent(client, paymentId, intentId) {
  await client.query(
    `INSERT INTO airwallex_payment_intents (
       payment_id,
       airwallex_payment_intent_id,
       request_id,
       status
     )
     VALUES ($1, $2, $3, 'REQUIRES_PAYMENT_METHOD')`,
    [paymentId, intentId, `recovery-create-${crypto.randomUUID()}`]
  );
}

test("recurring payment worker selects normal, stale, and retry payments", async () => {
  const client = await pool.connect();

  try {
    const database = await client.query(
      "SELECT current_database() AS name"
    );
    assert.equal(database.rows[0].name, "qilife_test_db");

    const workerSource = fs.readFileSync(
      "workers/recurring-payments.js",
      "utf8"
    );

    const queryMatch = workerSource.match(
      /const result = await client\.query\(\s*`([\s\S]*?)`,\s*\[singaporeDate\]\s*\);/
    );

    assert.ok(queryMatch, "Could not extract the worker's actual SQL query");

    const workerQuery = queryMatch[1];

    await client.query("BEGIN");

    const normalSubscription = await createTestSubscription(
      client,
      "normal"
    );

    const normalPaymentId = await createRecurringPayment(
      client,
      normalSubscription
    );

    const staleSubscription = await createTestSubscription(
      client,
      "stale"
    );

    const staleIntentId = `recovery-stale-intent-${crypto.randomUUID()}`;

    const stalePaymentId = await createRecurringPayment(
      client,
      staleSubscription,
      {
        status: "processing",
        processingStartedAt: new Date(Date.now() - 6 * 60 * 1000),
        paymentIntentId: staleIntentId,
      }
    );

    await addPaymentIntent(client, stalePaymentId, staleIntentId);

    const retrySubscription = await createTestSubscription(
      client,
      "retry"
    );

    const retryIntentId = `recovery-retry-intent-${crypto.randomUUID()}`;

    const retryPaymentId = await createRecurringPayment(
      client,
      retrySubscription,
      {
        nextRetryAt: new Date(Date.now() - 60 * 60 * 1000),
        paymentIntentId: retryIntentId,
      }
    );

    await addPaymentIntent(client, retryPaymentId, retryIntentId);

    await addFailedAttempt(
      client,
      retryPaymentId,
      retryIntentId,
      "02",
      "51"
    );

    const freshProcessingSubscription = await createTestSubscription(
      client,
      "fresh-processing"
    );

    const freshProcessingPaymentId = await createRecurringPayment(
      client,
      freshProcessingSubscription,
      {
        status: "processing",
        processingStartedAt: new Date(Date.now() - 60 * 1000),
      }
    );

    const unpaidEarlierSubscription = await createTestSubscription(
      client,
      "unpaid-earlier",
      "pending"
    );

    const unpaidEarlierPaymentId = await createRecurringPayment(
      client,
      unpaidEarlierSubscription
    );

    const unapprovedRetrySubscription = await createTestSubscription(
      client,
      "unapproved-retry"
    );

    const unapprovedRetryIntentId =
      `recovery-unapproved-intent-${crypto.randomUUID()}`;

    const unapprovedRetryPaymentId = await createRecurringPayment(
      client,
      unapprovedRetrySubscription,
      {
        nextRetryAt: new Date(Date.now() - 60 * 60 * 1000),
        paymentIntentId: unapprovedRetryIntentId,
      }
    );

    await addPaymentIntent(
      client,
      unapprovedRetryPaymentId,
      unapprovedRetryIntentId
    );

    await addFailedAttempt(
      client,
      unapprovedRetryPaymentId,
      unapprovedRetryIntentId,
      "02",
      "05"
    );

    const maxAttemptsSubscription = await createTestSubscription(
      client,
      "maximum-attempts"
    );

    const maxAttemptsIntentId =
      `recovery-max-attempts-intent-${crypto.randomUUID()}`;

    const maxAttemptsPaymentId = await createRecurringPayment(
      client,
      maxAttemptsSubscription,
      {
        nextRetryAt: new Date(Date.now() - 60 * 60 * 1000),
        paymentIntentId: maxAttemptsIntentId,
      }
    );

    await addPaymentIntent(
      client,
      maxAttemptsPaymentId,
      maxAttemptsIntentId
    );

    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber++) {
      await addFailedAttempt(
        client,
        maxAttemptsPaymentId,
        maxAttemptsIntentId,
        "02",
        "51",
        attemptNumber
      );
    }

    const result = await client.query(
      workerQuery,
      [getSingaporeDate()]
    );

    const selectedIds = new Set(
      result.rows.map((row) => row.payment_id)
    );

    assert.equal(result.rows.length, 3);
    assert.ok(selectedIds.has(normalPaymentId), "Normal payment was not selected");
    assert.ok(selectedIds.has(stalePaymentId), "Stale processing payment was not selected");
    assert.ok(selectedIds.has(retryPaymentId), "Eligible retry payment was not selected");

    assert.ok(
      !selectedIds.has(freshProcessingPaymentId),
      "Fresh processing payment must not be selected"
    );
    assert.ok(
      !selectedIds.has(unpaidEarlierPaymentId),
      "Payment with an unpaid earlier instalment must not be selected"
    );
    assert.ok(
      !selectedIds.has(unapprovedRetryPaymentId),
      "Retry with an unapproved issuer response code must not be selected"
    );
    assert.ok(
      !selectedIds.has(maxAttemptsPaymentId),
      "Payment with three failed attempts must not be selected"
    );

    console.log("Normal payment selected:", selectedIds.has(normalPaymentId));
    console.log("Stale payment selected:", selectedIds.has(stalePaymentId));
    console.log("Eligible retry selected:", selectedIds.has(retryPaymentId));
    console.log("Fresh processing payment blocked:", !selectedIds.has(freshProcessingPaymentId));
    console.log("Unpaid earlier instalment blocked:", !selectedIds.has(unpaidEarlierPaymentId));
    console.log("Unapproved retry code blocked:", !selectedIds.has(unapprovedRetryPaymentId));
    console.log("Three failed attempts blocked:", !selectedIds.has(maxAttemptsPaymentId));
    console.log("All recovery selection checks passed.");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }
  }
});
