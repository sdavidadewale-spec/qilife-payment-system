const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

require("dotenv").config();

process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";
process.env.FRONTEND_URL = "https://checkout.example.test";

const pool = require("../db");
const airwallex = require("../airwallex");

const createCalls = [];
let customerCreationCalls = 0;

airwallex.createAirwallexCustomer = async () => {
  customerCreationCalls += 1;
  throw new Error("Unexpected customer creation in this test");
};

airwallex.retrieveAirwallexPaymentIntent = async () => {
  throw new Error("Unexpected PaymentIntent retrieval in this test");
};

airwallex.createAirwallexPaymentIntent = async (request) => {
  createCalls.push(structuredClone(request));

  if (createCalls.length === 1) {
    throw new Error("Simulated timeout after the request was sent");
  }

  return {
    id: `int_mock_${crypto.randomUUID()}`,
    status: "REQUIRES_PAYMENT_METHOD",
    merchant_order_id: request.merchantOrderId,
    amount: Number(request.amount),
    currency: request.currency,
    updated_at: new Date().toISOString(),
    client_secret: "mock_client_secret",
  };
};

const router = require("../routes/payment-setup");

const checkoutHandler = router.stack
  .find(
    (layer) =>
      layer.route?.path === "/checkout/:token/payment-intent"
  )
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

async function sendCheckoutRequest(token) {
  let statusCode = 200;
  let responseBody;

  const req = {
    params: { token },
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

  await checkoutHandler(req, res);

  return { statusCode, responseBody };
}

async function createFixture() {
  const suffix = crypto.randomUUID();
  const token = crypto.randomUUID();

  const fixture = {
    email: `checkout-recovery-${suffix}@example.test`,
    courseName: `Checkout Recovery Test Course ${suffix}`,
    checkoutSlug: `checkout-recovery-${suffix}`,
    customerId: `cus_test_${suffix.replace(/-/g, "")}`,
    token,
    tokenHash: crypto
      .createHash("sha256")
      .update(token)
      .digest("hex"),
  };

  try {
    const studentResult = await pool.query(
      `INSERT INTO students (
         full_name,
         email,
         phone,
         airwallex_customer_id
       )
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        "Checkout Recovery Test Student",
        fixture.email,
        "+6500000000",
        fixture.customerId,
      ]
    );

    fixture.studentId = studentResult.rows[0].id;

    const courseResult = await pool.query(
      `INSERT INTO courses (
         name,
         duration_months,
         base_fee,
         currency
       )
       VALUES ($1, 12, 300, 'SGD')
       RETURNING id`,
      [fixture.courseName]
    );

    fixture.courseId = courseResult.rows[0].id;

    const planResult = await pool.query(
      `INSERT INTO pricing_plans (
         course_id,
         student_type,
         plan_type,
         total_amount,
         instalment_count
       )
       VALUES ($1, 'local', 'three_part', 300, 3)
       RETURNING id`,
      [fixture.courseId]
    );

    fixture.pricingPlanId = planResult.rows[0].id;

    for (let number = 1; number <= 3; number += 1) {
      await pool.query(
        `INSERT INTO pricing_plan_installments (
           pricing_plan_id,
           instalment_number,
           amount
         )
         VALUES ($1, $2, 100)`,
        [fixture.pricingPlanId, number]
      );
    }

    const checkoutResult = await pool.query(
      `INSERT INTO checkout_links (
         slug,
         pricing_plan_id,
         is_active
       )
       VALUES ($1, $2, TRUE)
       RETURNING id`,
      [fixture.checkoutSlug, fixture.pricingPlanId]
    );

    fixture.checkoutLinkId = checkoutResult.rows[0].id;

    const subscriptionResult = await pool.query(
      `INSERT INTO subscriptions (
         student_id,
         pricing_plan_id,
         checkout_token_hash,
         checkout_token_expires_at,
         total_amount,
         currency,
         total_instalments,
         paid_instalments,
         status
       )
       VALUES (
         $1,
         $2,
         $3,
         NOW() + INTERVAL '1 day',
         300,
         'SGD',
         3,
         0,
         'pending'
       )
       RETURNING id`,
      [
        fixture.studentId,
        fixture.pricingPlanId,
        fixture.tokenHash,
      ]
    );

    fixture.subscriptionId = subscriptionResult.rows[0].id;

    fixture.paymentIds = [];

    for (let number = 1; number <= 3; number += 1) {
      const paymentResult = await pool.query(
        `INSERT INTO payments (
           subscription_id,
           instalment_number,
           amount,
           currency,
           status
         )
         VALUES ($1, $2, 100, 'SGD', 'pending')
         RETURNING id`,
        [fixture.subscriptionId, number]
      );

      fixture.paymentIds.push(paymentResult.rows[0].id);
    }

    fixture.firstPaymentId = fixture.paymentIds[0];

    return fixture;
  } catch (error) {
    try {
      await cleanupFixture(fixture);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }

    throw error;
  }
}

async function cleanupFixture(fixture) {
  const errors = [];

  const operations = [
    fixture.checkoutLinkId
      ? [
          "DELETE FROM checkout_links WHERE id = $1",
          [fixture.checkoutLinkId],
        ]
      : null,
    fixture.studentId
      ? [
          "DELETE FROM students WHERE id = $1",
          [fixture.studentId],
        ]
      : null,
    fixture.pricingPlanId
      ? [
          "DELETE FROM pricing_plans WHERE id = $1",
          [fixture.pricingPlanId],
        ]
      : null,
    fixture.courseId
      ? [
          "DELETE FROM courses WHERE id = $1",
          [fixture.courseId],
        ]
      : null,
  ].filter(Boolean);

  for (const [sql, values] of operations) {
    try {
      await pool.query(sql, values);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length) {
    throw new AggregateError(
      errors,
      "One or more test fixture cleanup operations failed"
    );
  }
}

test.before(async () => {
  await verifyTestDatabase();
});

test.after(async () => {
  await pool.end();
});

test(
  "first payment checkout recovers after a timeout using the same request ID and details",
  async () => {
    createCalls.length = 0;
    customerCreationCalls = 0;

    const fixture = await createFixture();

    try {
      // First request: simulate a timeout after sending the request.
      const firstResult = await sendCheckoutRequest(fixture.token);

      assert.equal(firstResult.statusCode, 500);
      assert.equal(
        firstResult.responseBody.message,
        "Could not prepare the first payment"
      );
      assert.equal(createCalls.length, 1);

      let paymentResult = await pool.query(
        `SELECT
           id,
           status,
           airwallex_payment_id,
           last_error,
           processing_started_at,
           TO_CHAR(payment_consent_start_date, 'YYYY-MM-DD') AS payment_consent_start_date
         FROM payments
         WHERE id = $1`,
        [fixture.firstPaymentId]
      );

      assert.equal(paymentResult.rows.length, 1);

      const afterTimeout = paymentResult.rows[0];

      assert.equal(afterTimeout.status, "processing");
      assert.equal(afterTimeout.airwallex_payment_id, null);
      assert.match(afterTimeout.last_error, /Simulated timeout/);
      assert.ok(afterTimeout.processing_started_at);

      const originalConsentDate = afterTimeout.payment_consent_start_date;

      // Immediate retry: the active processing claim must block it.
      const blockedResult = await sendCheckoutRequest(fixture.token);

      assert.equal(blockedResult.statusCode, 409);
      assert.equal(createCalls.length, 1);

      // Simulate recovery after the five-minute processing timeout.
      await pool.query(
        `UPDATE payments
         SET processing_started_at = NOW() - INTERVAL '6 minutes'
         WHERE id = $1`,
        [fixture.firstPaymentId]
      );

      // Recovery request: Airwallex returns a valid PaymentIntent.
      const recoveryResult = await sendCheckoutRequest(fixture.token);

      assert.equal(recoveryResult.statusCode, 200);
      assert.equal(
        recoveryResult.responseBody.payment_intent_status,
        "REQUIRES_PAYMENT_METHOD"
      );
      assert.equal(
        recoveryResult.responseBody.client_secret,
        "mock_client_secret"
      );
      assert.equal(Number(recoveryResult.responseBody.amount), 100);
      assert.equal(recoveryResult.responseBody.currency, "SGD");
      assert.equal(
        recoveryResult.responseBody.customer_id,
        fixture.customerId
      );

      assert.equal(createCalls.length, 2);
      assert.equal(customerCreationCalls, 0);

      const firstRequest = createCalls[0];
      const recoveryRequest = createCalls[1];

      // Both attempts must use the same stable request ID and order ID.
      assert.equal(firstRequest.requestId, fixture.firstPaymentId);
      assert.equal(recoveryRequest.requestId, fixture.firstPaymentId);
      assert.equal(firstRequest.merchantOrderId, fixture.firstPaymentId);
      assert.equal(recoveryRequest.merchantOrderId, fixture.firstPaymentId);

      // All request details must remain identical across the retry.
      assert.deepEqual(recoveryRequest, firstRequest);

      assert.equal(Number(recoveryRequest.amount), 100);
      assert.equal(recoveryRequest.currency, "SGD");
      assert.equal(recoveryRequest.customerId, fixture.customerId);

      assert.equal(
        recoveryRequest.paymentConsent.next_triggered_by,
        "merchant"
      );
      assert.equal(
        recoveryRequest.paymentConsent.merchant_trigger_reason,
        "installments"
      );
      assert.equal(
        recoveryRequest.paymentConsent.terms_of_use.payment_amount_type,
        "VARIABLE"
      );
      assert.equal(
        recoveryRequest.paymentConsent.terms_of_use.payment_currency,
        "SGD"
      );
      assert.equal(
        Number(
          recoveryRequest.paymentConsent.terms_of_use.first_payment_amount
        ),
        100
      );
      assert.equal(
        Number(
          recoveryRequest.paymentConsent.terms_of_use.max_payment_amount
        ),
        100
      );
      assert.equal(
        recoveryRequest.paymentConsent.terms_of_use.total_billing_cycles,
        3
      );

      assert.equal(
        recoveryRequest.paymentConsent.terms_of_use.start_date,
        String(originalConsentDate).slice(0, 10)
      );

      paymentResult = await pool.query(
        `SELECT
           status,
           airwallex_payment_id,
           last_error,
           TO_CHAR(payment_consent_start_date, 'YYYY-MM-DD') AS payment_consent_start_date
         FROM payments
         WHERE id = $1`,
        [fixture.firstPaymentId]
      );

      const recoveredPayment = paymentResult.rows[0];

      assert.equal(recoveredPayment.status, "processing");
      assert.equal(
        recoveredPayment.airwallex_payment_id,
        recoveryResult.responseBody.payment_intent_id
      );
      assert.equal(recoveredPayment.last_error, null);
      assert.equal(
        String(recoveredPayment.payment_consent_start_date).slice(0, 10),
        String(originalConsentDate).slice(0, 10)
      );

      const historyResult = await pool.query(
        `SELECT
           payment_id,
           airwallex_payment_intent_id,
           request_id,
           status
         FROM airwallex_payment_intents
         WHERE payment_id = $1`,
        [fixture.firstPaymentId]
      );

      assert.equal(historyResult.rows.length, 1);
      assert.equal(
        historyResult.rows[0].payment_id,
        fixture.firstPaymentId
      );
      assert.equal(
        historyResult.rows[0].airwallex_payment_intent_id,
        recoveryResult.responseBody.payment_intent_id
      );
      assert.equal(
        historyResult.rows[0].request_id,
        fixture.firstPaymentId
      );
      assert.equal(
        historyResult.rows[0].status,
        "REQUIRES_PAYMENT_METHOD"
      );
    } finally {
      await cleanupFixture(fixture);
    }
  }
);
