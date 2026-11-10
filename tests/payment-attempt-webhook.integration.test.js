const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

require("dotenv").config();

process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";

const pool = require("../db");
const router = require("../routes/webhooks");

const webhookHandler = router.stack
  .find((layer) => layer.route?.path === "/")
  .route.stack
  .find((layer) => layer.method === "post")
  .handle;

async function verifyTestDatabase() {
  const result = await pool.query(
    "SELECT current_database() AS database_name"
  );

  assert.equal(
    result.rows[0].database_name,
    "qilife_test_db",
    "Safety check failed. This test may only use qilife_test_db."
  );
}

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

async function createFixture({ consentReady = true } = {}) {
  const suffix = crypto.randomUUID();
  const fixture = {
    email: `payment-attempt-${suffix}@example.test`,
    eventIds: [],
  };

  try {
    const studentResult = await pool.query(
      `INSERT INTO students (full_name, email)
       VALUES ($1, $2)
       RETURNING id`,
      ["Payment Attempt Test Student", fixture.email]
    );

    fixture.studentId = studentResult.rows[0].id;

    const subscriptionResult = await pool.query(
      `INSERT INTO subscriptions (
         student_id,
         total_amount,
         currency,
         total_instalments,
         payment_consent_status,
         airwallex_payment_consent_id,
         airwallex_payment_method_id,
         airwallex_payment_method_type
       )
       VALUES ($1, 12600, 'SGD', 6, $2, $3, $4, $5)
       RETURNING id`,
      [
        fixture.studentId,
        consentReady ? "VERIFIED" : null,
        consentReady ? `consent-${suffix}` : null,
        consentReady ? `pm-${suffix}` : null,
        consentReady ? "card" : null,
      ]
    );

    fixture.subscriptionId = subscriptionResult.rows[0].id;
    fixture.paymentIntentId = `pi-test-${suffix}`;
    fixture.paymentAttemptId = `pa-test-${suffix}`;

    const paymentResult = await pool.query(
      `INSERT INTO payments (
         subscription_id,
         airwallex_payment_id,
         instalment_number,
         amount,
         currency,
         status,
         processing_started_at
       )
       VALUES ($1, $2, 2, 2100, 'SGD', 'processing', NOW())
       RETURNING id`,
      [
        fixture.subscriptionId,
        fixture.paymentIntentId,
      ]
    );

    fixture.paymentId = paymentResult.rows[0].id;

    await pool.query(
      `INSERT INTO airwallex_payment_intents (
         payment_id,
         airwallex_payment_intent_id,
         status
       )
       VALUES ($1, $2, 'REQUIRES_PAYMENT_METHOD')`,
      [
        fixture.paymentId,
        fixture.paymentIntentId,
      ]
    );

    return fixture;
  } catch (error) {
    await cleanupFixture(fixture);
    throw error;
  }
}

async function cleanupFixture(fixture) {
  if (fixture.eventIds?.length) {
    await pool.query(
      `DELETE FROM payment_review_events
       WHERE event_id = ANY($1::varchar[])`,
      [fixture.eventIds]
    );

    await pool.query(
      `DELETE FROM webhook_events
       WHERE event_id = ANY($1::varchar[])`,
      [fixture.eventIds]
    );
  }

  if (fixture.studentId) {
    await pool.query(
      "DELETE FROM students WHERE id = $1",
      [fixture.studentId]
    );
  }
}

function makeAttemptEvent(fixture, {
  eventId,
  status = "FAILED",
  createdAt = "2026-11-10T01:00:00.000Z",
  updatedAt = "2026-11-10T02:00:00.000Z",
  merchantAdviceCode = "02",
  issuerResponseCode = "51",
} = {}) {
  fixture.eventIds.push(eventId);

  return {
    id: eventId,
    name: "payment_attempt.failed",
    data: {
      object: {
        id: fixture.paymentAttemptId,
        payment_intent_id: fixture.paymentIntentId,
        status,
        amount: 2100,
        currency: "SGD",
        created_at: createdAt,
        updated_at: updatedAt,
        failure_code: "DECLINED",
        merchant_advice_code: merchantAdviceCode,
        provider_original_response_code: issuerResponseCode,
        failure_details: {
          message: "Test payment attempt failure",
        },
      },
    },
  };
}

test.before(async () => {
  await verifyTestDatabase();
});

test.after(async () => {
  await pool.end();
});

test(
  "retryable failure is recorded once and older updates cannot replace it",
  async () => {
    const fixture = await createFixture();

    try {
      const firstEvent = makeAttemptEvent(fixture, {
        eventId: `event-first-${crypto.randomUUID()}`,
      });

      const firstResult = await sendWebhook(firstEvent);

      assert.equal(firstResult.statusCode, 200);
      assert.equal(firstResult.responseBody.processed, true);

      let paymentResult = await pool.query(
        `SELECT
           status,
           payment_attempts,
           next_retry_at,
           manual_review_required,
           manual_review_reason,
           processing_started_at
         FROM payments
         WHERE id = $1`,
        [fixture.paymentId]
      );

      let payment = paymentResult.rows[0];

      assert.equal(payment.status, "pending");
      assert.equal(payment.payment_attempts, 1);
      assert.ok(payment.next_retry_at);
      assert.equal(payment.manual_review_required, false);
      assert.equal(payment.manual_review_reason, null);
      assert.equal(payment.processing_started_at, null);

      const retryTimeResult = await pool.query(
        `SELECT EXTRACT(
           EPOCH FROM (next_retry_at - NOW())
         ) AS seconds_remaining
         FROM payments
         WHERE id = $1`,
        [fixture.paymentId]
      );

      const secondsRemaining = Number(
        retryTimeResult.rows[0].seconds_remaining
      );

      assert.ok(
        secondsRemaining > 71 * 60 * 60 &&
        secondsRemaining <= 72 * 60 * 60,
        "The retry should be scheduled about 72 hours ahead."
      );

      let attemptResult = await pool.query(
        `SELECT
           attempt_number,
           status,
           merchant_advice_code,
           issuer_response_code
         FROM airwallex_payment_attempts
         WHERE payment_id = $1`,
        [fixture.paymentId]
      );

      assert.equal(attemptResult.rows.length, 1);
      assert.equal(attemptResult.rows[0].attempt_number, 1);
      assert.equal(attemptResult.rows[0].status, "FAILED");
      assert.equal(attemptResult.rows[0].merchant_advice_code, "02");
      assert.equal(attemptResult.rows[0].issuer_response_code, "51");

      const duplicateResult = await sendWebhook(firstEvent);

      assert.equal(duplicateResult.statusCode, 200);
      assert.equal(duplicateResult.responseBody.duplicate, true);

      paymentResult = await pool.query(
        `SELECT payment_attempts, status
         FROM payments
         WHERE id = $1`,
        [fixture.paymentId]
      );

      assert.equal(paymentResult.rows[0].payment_attempts, 1);
      assert.equal(paymentResult.rows[0].status, "pending");

      const olderEvent = makeAttemptEvent(fixture, {
        eventId: `event-older-${crypto.randomUUID()}`,
        status: "PENDING",
        createdAt: "2026-11-10T01:00:00.000Z",
        updatedAt: "2026-11-10T01:30:00.000Z",
      });

      const olderResult = await sendWebhook(olderEvent);

      assert.equal(olderResult.statusCode, 200);
      assert.equal(olderResult.responseBody.processed, true);

      attemptResult = await pool.query(
        `SELECT
           attempt_number,
           status,
           merchant_advice_code,
           issuer_response_code,
           airwallex_updated_at
         FROM airwallex_payment_attempts
         WHERE payment_id = $1`,
        [fixture.paymentId]
      );

      assert.equal(attemptResult.rows.length, 1);
      assert.equal(attemptResult.rows[0].attempt_number, 1);
      assert.equal(attemptResult.rows[0].status, "FAILED");
      assert.equal(attemptResult.rows[0].merchant_advice_code, "02");
      assert.equal(attemptResult.rows[0].issuer_response_code, "51");
      assert.equal(
        new Date(attemptResult.rows[0].airwallex_updated_at).toISOString(),
        "2026-11-10T02:00:00.000Z"
      );

      paymentResult = await pool.query(
        `SELECT payment_attempts, status
         FROM payments
         WHERE id = $1`,
        [fixture.paymentId]
      );

      assert.equal(paymentResult.rows[0].payment_attempts, 1);
      assert.equal(paymentResult.rows[0].status, "pending");
    } finally {
      await cleanupFixture(fixture);
    }
  }
);

test(
  "a non-retryable failure sends the payment to manual review",
  async () => {
    const fixture = await createFixture();

    try {
      const event = makeAttemptEvent(fixture, {
        eventId: `event-review-${crypto.randomUUID()}`,
        merchantAdviceCode: "01",
        issuerResponseCode: "05",
      });

      const result = await sendWebhook(event);

      assert.equal(result.statusCode, 200);
      assert.equal(result.responseBody.processed, true);

      const paymentResult = await pool.query(
        `SELECT
           status,
           payment_attempts,
           next_retry_at,
           manual_review_required,
           manual_review_reason,
           processing_started_at
         FROM payments
         WHERE id = $1`,
        [fixture.paymentId]
      );

      const payment = paymentResult.rows[0];

      assert.equal(payment.status, "review_required");
      assert.equal(payment.payment_attempts, 1);
      assert.equal(payment.next_retry_at, null);
      assert.equal(payment.manual_review_required, true);
      assert.equal(
        payment.manual_review_reason,
        "Payment failure is not approved for automatic retry."
      );
      assert.equal(payment.processing_started_at, null);

      const attemptResult = await pool.query(
        `SELECT status, merchant_advice_code, issuer_response_code
         FROM airwallex_payment_attempts
         WHERE payment_id = $1`,
        [fixture.paymentId]
      );

      assert.equal(attemptResult.rows.length, 1);
      assert.equal(attemptResult.rows[0].status, "FAILED");
      assert.equal(attemptResult.rows[0].merchant_advice_code, "01");
      assert.equal(attemptResult.rows[0].issuer_response_code, "05");
    } finally {
      await cleanupFixture(fixture);
    }
  }
);

test(
  "concurrent PaymentAttempt events are saved once and numbered by creation time",
  async () => {
    const fixture = await createFixture();

    try {
      const earlierAttemptId = `pa-earlier-${crypto.randomUUID()}`;
      const laterAttemptId = `pa-later-${crypto.randomUUID()}`;

      const earlierEvent = makeAttemptEvent(fixture, {
        eventId: `event-earlier-${crypto.randomUUID()}`,
        createdAt: "2026-11-10T01:00:00.000Z",
        updatedAt: "2026-11-10T01:30:00.000Z",
      });

      const laterEvent = makeAttemptEvent(fixture, {
        eventId: `event-later-${crypto.randomUUID()}`,
        createdAt: "2026-11-10T02:00:00.000Z",
        updatedAt: "2026-11-10T02:30:00.000Z",
      });

      earlierEvent.data.object.id = earlierAttemptId;
      laterEvent.data.object.id = laterAttemptId;

      const results = await Promise.all([
        sendWebhook(laterEvent),
        sendWebhook(earlierEvent),
      ]);

      for (const result of results) {
        assert.equal(result.statusCode, 200);
        assert.equal(result.responseBody.processed, true);
      }

      const attemptResult = await pool.query(
        `SELECT
           attempt_number,
           airwallex_payment_attempt_id,
           airwallex_created_at,
           status
         FROM airwallex_payment_attempts
         WHERE payment_id = $1
         ORDER BY attempt_number`,
        [fixture.paymentId]
      );

      assert.equal(attemptResult.rows.length, 2);
      assert.deepEqual(
        attemptResult.rows.map((row) => Number(row.attempt_number)),
        [1, 2]
      );
      assert.deepEqual(
        attemptResult.rows.map((row) => row.airwallex_payment_attempt_id),
        [earlierAttemptId, laterAttemptId]
      );
      assert.deepEqual(
        attemptResult.rows.map((row) =>
          new Date(row.airwallex_created_at).toISOString()
        ),
        [
          "2026-11-10T01:00:00.000Z",
          "2026-11-10T02:00:00.000Z",
        ]
      );
      assert.ok(attemptResult.rows.every((row) => row.status === "FAILED"));

      const paymentResult = await pool.query(
        `SELECT
           status,
           payment_attempts,
           next_retry_at,
           manual_review_required
         FROM payments
         WHERE id = $1`,
        [fixture.paymentId]
      );

      assert.equal(paymentResult.rows[0].status, "pending");
      assert.equal(paymentResult.rows[0].payment_attempts, 2);
      assert.ok(paymentResult.rows[0].next_retry_at);
      assert.equal(paymentResult.rows[0].manual_review_required, false);
    } finally {
      await cleanupFixture(fixture);
    }
  }
);
