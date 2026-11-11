const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

require("dotenv").config();

process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";

const pool = require("../db");
const router = require("../routes/webhooks");
const { addMonthsClamped } = require("../utils/payment-dates");

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

async function createFixture() {
  const suffix = crypto.randomUUID();

  const fixture = {
    email: `payment-success-${suffix}@example.test`,
    eventIds: [],
    paymentIds: [],
  };

  try {
    const studentResult = await pool.query(
      `INSERT INTO students (full_name, email)
       VALUES ($1, $2)
       RETURNING id`,
      ["Payment Success Test Student", fixture.email]
    );

    fixture.studentId = studentResult.rows[0].id;

    const subscriptionResult = await pool.query(
      `INSERT INTO subscriptions (
         student_id,
         total_amount,
         currency,
         total_instalments,
         paid_instalments,
         status
       )
       VALUES ($1, 12480, 'SGD', 3, 0, 'pending')
       RETURNING id`,
      [fixture.studentId]
    );

    fixture.subscriptionId = subscriptionResult.rows[0].id;
    fixture.paymentIntentId = `pi-success-test-${suffix}`;

    const instalments = [
      { number: 1, amount: 4480, status: "processing" },
      { number: 2, amount: 4000, status: "pending" },
      { number: 3, amount: 4000, status: "pending" },
    ];

    for (const instalment of instalments) {
      const paymentResult = await pool.query(
        `INSERT INTO payments (
           subscription_id,
           instalment_number,
           amount,
           currency,
           status,
           airwallex_payment_id,
           processing_started_at
         )
         VALUES ($1, $2, $3, 'SGD', $4, $5, $6)
         RETURNING id`,
        [
          fixture.subscriptionId,
          instalment.number,
          instalment.amount,
          instalment.status,
          instalment.number === 1 ? fixture.paymentIntentId : null,
          instalment.number === 1 ? new Date() : null,
        ]
      );

      fixture.paymentIds.push(paymentResult.rows[0].id);
    }

    fixture.firstPaymentId = fixture.paymentIds[0];

    await pool.query(
      `INSERT INTO airwallex_payment_intents (
         payment_id,
         airwallex_payment_intent_id,
         status
       )
       VALUES ($1, $2, 'REQUIRES_PAYMENT_METHOD')`,
      [fixture.firstPaymentId, fixture.paymentIntentId]
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

function makeSuccessEvent(fixture) {
  const eventId = `event-payment-success-${crypto.randomUUID()}`;
  fixture.eventIds.push(eventId);

  return {
    id: eventId,
    name: "payment_intent.succeeded",
    data: {
      object: {
        id: fixture.paymentIntentId,
        merchant_order_id: fixture.firstPaymentId,
        status: "SUCCEEDED",
        amount: 4480,
        currency: "SGD",
        updated_at: new Date().toISOString(),
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
  "successful first payment sets the instalment schedule and duplicate events are ignored",
  async () => {
    const fixture = await createFixture();

    try {
      const event = makeSuccessEvent(fixture);

      const firstResult = await sendWebhook(event);

      assert.equal(firstResult.statusCode, 200);
      assert.equal(firstResult.responseBody.processed, true);

      const paymentResult = await pool.query(
        `SELECT
           instalment_number,
           amount,
           status,
           paid_at,
           processing_started_at,
           processing_claim_token,
           airwallex_payment_intent_status,
           to_char(due_date, 'YYYY-MM-DD') AS due_date
         FROM payments
         WHERE subscription_id = $1
         ORDER BY instalment_number`,
        [fixture.subscriptionId]
      );

      assert.equal(paymentResult.rows.length, 3);

      const [first, second, third] = paymentResult.rows;

      assert.equal(first.status, "paid");
      assert.equal(Number(first.amount), 4480);
      assert.ok(first.paid_at);
      assert.equal(first.processing_started_at, null);
      assert.equal(first.processing_claim_token, null);
      assert.equal(first.airwallex_payment_intent_status, "SUCCEEDED");
      assert.equal(first.due_date, null);

      const intentHistoryResult = await pool.query(
        `SELECT status
         FROM airwallex_payment_intents
         WHERE payment_id = $1
           AND airwallex_payment_intent_id = $2`,
        [fixture.firstPaymentId, fixture.paymentIntentId]
      );

      assert.equal(intentHistoryResult.rows.length, 1);
      assert.equal(intentHistoryResult.rows[0].status, "SUCCEEDED");

      assert.equal(second.status, "pending");
      assert.equal(third.status, "pending");

      const paidDateResult = await pool.query(
        `SELECT to_char(
           paid_at AT TIME ZONE 'Asia/Singapore',
           'YYYY-MM-DD'
         ) AS paid_date
         FROM payments
         WHERE id = $1`,
        [fixture.firstPaymentId]
      );

      const firstPaidDate = paidDateResult.rows[0].paid_date;

      assert.ok(firstPaidDate);

      assert.equal(
        second.due_date,
        addMonthsClamped(firstPaidDate, 1)
      );

      assert.equal(
        third.due_date,
        addMonthsClamped(firstPaidDate, 2)
      );

      let subscriptionResult = await pool.query(
        `SELECT paid_instalments, status
         FROM subscriptions
         WHERE id = $1`,
        [fixture.subscriptionId]
      );

      assert.equal(subscriptionResult.rows[0].paid_instalments, 1);
      assert.equal(subscriptionResult.rows[0].status, "active");

      const duplicateResult = await sendWebhook(event);

      assert.equal(duplicateResult.statusCode, 200);
      assert.equal(duplicateResult.responseBody.duplicate, true);

      const duplicatePaymentResult = await pool.query(
        `SELECT
           instalment_number,
           status,
           paid_at,
           to_char(due_date, 'YYYY-MM-DD') AS due_date
         FROM payments
         WHERE subscription_id = $1
         ORDER BY instalment_number`,
        [fixture.subscriptionId]
      );

      assert.equal(duplicatePaymentResult.rows.length, 3);
      assert.equal(
        duplicatePaymentResult.rows.filter(
          (payment) => payment.status === "paid"
        ).length,
        1
      );

      assert.equal(
        duplicatePaymentResult.rows[0].paid_at.toISOString(),
        first.paid_at.toISOString()
      );

      assert.equal(
        duplicatePaymentResult.rows[1].due_date,
        second.due_date
      );

      assert.equal(
        duplicatePaymentResult.rows[2].due_date,
        third.due_date
      );

      subscriptionResult = await pool.query(
        `SELECT paid_instalments, status
         FROM subscriptions
         WHERE id = $1`,
        [fixture.subscriptionId]
      );

      assert.equal(subscriptionResult.rows[0].paid_instalments, 1);
      assert.equal(subscriptionResult.rows[0].status, "active");

      const eventCountResult = await pool.query(
        `SELECT COUNT(*)::INTEGER AS count
         FROM webhook_events
         WHERE event_id = $1`,
        [event.id]
      );

      assert.equal(eventCountResult.rows[0].count, 1);
    } finally {
      await cleanupFixture(fixture);
    }
  }
);
