const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

require("dotenv").config();

process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";

const pool = require("../db");

// Replace the Airwallex retrieval function before loading the webhook route.
const airwallex = require("../airwallex");

let mockedConsent = null;
let retrievalCalls = 0;

airwallex.retrieveAirwallexPaymentConsent = async (consentId) => {
  retrievalCalls++;
  assert.equal(consentId, mockedConsent.id);
  return mockedConsent;
};

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

async function createFixture({
  savedConsentId = null,
  savedPaymentMethodId = null,
  savedPaymentMethodType = null,
} = {}) {
  const suffix = crypto.randomUUID();

  const fixture = {
    email: `payment-consent-${suffix}@example.test`,
    customerId: `customer-consent-${suffix}`,
    paymentIntentId: `pi-consent-${suffix}`,
    eventIds: [],
  };

  try {
    const studentResult = await pool.query(
      `INSERT INTO students (
         full_name,
         email,
         airwallex_customer_id
       )
       VALUES ($1, $2, $3)
       RETURNING id`,
      [
        "Payment Consent Test Student",
        fixture.email,
        fixture.customerId,
      ]
    );

    fixture.studentId = studentResult.rows[0].id;

    const subscriptionResult = await pool.query(
      `INSERT INTO subscriptions (
         student_id,
         total_amount,
         currency,
         total_instalments,
         paid_instalments,
         status,
         airwallex_payment_consent_id,
         airwallex_payment_method_id,
         airwallex_payment_method_type
       )
       VALUES ($1, 12480, 'SGD', 3, 0, 'pending', $2, $3, $4)
       RETURNING id`,
      [
        fixture.studentId,
        savedConsentId,
        savedPaymentMethodId,
        savedPaymentMethodType,
      ]
    );

    fixture.subscriptionId = subscriptionResult.rows[0].id;

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
       VALUES ($1, 1, 4480, 'SGD', 'processing', $2, NOW())
       RETURNING id`,
      [fixture.subscriptionId, fixture.paymentIntentId]
    );

    fixture.firstPaymentId = paymentResult.rows[0].id;

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

function makeConsentEvent(fixture) {
  const eventId = `event-consent-${crypto.randomUUID()}`;
  fixture.eventIds.push(eventId);

  return {
    id: eventId,
    name: "payment_consent.verified",
    data: {
      object: {
        id: mockedConsent.id,
      },
    },
  };
}

function setMockConsent(fixture, {
  consentId = `consent-${crypto.randomUUID()}`,
  customerId = fixture.customerId,
  paymentMethodId = `pm-${crypto.randomUUID()}`,
} = {}) {
  mockedConsent = {
    id: consentId,
    status: "VERIFIED",
    initial_payment_intent_id: fixture.paymentIntentId,
    customer_id: customerId,
    payment_method: {
      id: paymentMethodId,
      type: "card",
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
  "verified consent is saved to the matching subscription and duplicate events are ignored",
  async () => {
    const fixture = await createFixture();

    try {
      setMockConsent(fixture);
      const event = makeConsentEvent(fixture);
      const callsBeforeFirst = retrievalCalls;

      const firstResult = await sendWebhook(event);

      assert.equal(firstResult.statusCode, 200);
      assert.equal(firstResult.responseBody.processed, true);
      assert.equal(retrievalCalls, callsBeforeFirst + 1);

      const savedResult = await pool.query(
        `SELECT
           airwallex_payment_consent_id,
           airwallex_payment_method_id,
           airwallex_payment_method_type,
           payment_consent_status
         FROM subscriptions
         WHERE id = $1`,
        [fixture.subscriptionId]
      );

      assert.equal(savedResult.rows.length, 1);
      assert.equal(
        savedResult.rows[0].airwallex_payment_consent_id,
        mockedConsent.id
      );
      assert.equal(
        savedResult.rows[0].airwallex_payment_method_id,
        mockedConsent.payment_method.id
      );
      assert.equal(
        savedResult.rows[0].airwallex_payment_method_type,
        "card"
      );
      assert.equal(savedResult.rows[0].payment_consent_status, "VERIFIED");

      const callsBeforeDuplicate = retrievalCalls;
      const duplicateResult = await sendWebhook(event);

      assert.equal(duplicateResult.statusCode, 200);
      assert.equal(duplicateResult.responseBody.duplicate, true);
      assert.equal(retrievalCalls, callsBeforeDuplicate);

      const eventCount = await pool.query(
        "SELECT COUNT(*)::int AS count FROM webhook_events WHERE event_id = $1",
        [event.id]
      );

      assert.equal(eventCount.rows[0].count, 1);
    } finally {
      await cleanupFixture(fixture);
    }
  }
);

test(
  "consent for a different Airwallex customer is rejected",
  async () => {
    const fixture = await createFixture();

    try {
      setMockConsent(fixture, {
        customerId: `different-customer-${crypto.randomUUID()}`,
      });

      const event = makeConsentEvent(fixture);
      const result = await sendWebhook(event);

      assert.equal(result.statusCode, 500);

      const subscriptionResult = await pool.query(
        `SELECT
           airwallex_payment_consent_id,
           airwallex_payment_method_id,
           payment_consent_status
         FROM subscriptions
         WHERE id = $1`,
        [fixture.subscriptionId]
      );

      assert.equal(
        subscriptionResult.rows[0].airwallex_payment_consent_id,
        null
      );
      assert.equal(
        subscriptionResult.rows[0].airwallex_payment_method_id,
        null
      );
      assert.equal(
        subscriptionResult.rows[0].payment_consent_status,
        null
      );

      const eventResult = await pool.query(
        "SELECT event_id FROM webhook_events WHERE event_id = $1",
        [event.id]
      );

      assert.equal(eventResult.rowCount, 0);
    } finally {
      await cleanupFixture(fixture);
    }
  }
);

test(
  "a different existing consent cannot be overwritten",
  async () => {
    const existingConsentId = `existing-consent-${crypto.randomUUID()}`;
    const existingMethodId = `existing-method-${crypto.randomUUID()}`;
    const fixture = await createFixture({
      savedConsentId: existingConsentId,
      savedPaymentMethodId: existingMethodId,
      savedPaymentMethodType: "card",
    });

    try {
      setMockConsent(fixture);
      const event = makeConsentEvent(fixture);

      const result = await sendWebhook(event);

      assert.equal(result.statusCode, 500);

      const savedResult = await pool.query(
        `SELECT
           airwallex_payment_consent_id,
           airwallex_payment_method_id,
           airwallex_payment_method_type
         FROM subscriptions
         WHERE id = $1`,
        [fixture.subscriptionId]
      );

      assert.equal(
        savedResult.rows[0].airwallex_payment_consent_id,
        existingConsentId
      );
      assert.equal(
        savedResult.rows[0].airwallex_payment_method_id,
        existingMethodId
      );
      assert.equal(
        savedResult.rows[0].airwallex_payment_method_type,
        "card"
      );
    } finally {
      await cleanupFixture(fixture);
    }
  }
);

test(
  "a different saved card cannot be overwritten by a verified consent",
  async () => {
    const existingConsentId = `consent-${crypto.randomUUID()}`;
    const existingMethodId = `existing-method-${crypto.randomUUID()}`;
    const fixture = await createFixture({
      savedConsentId: existingConsentId,
      savedPaymentMethodId: existingMethodId,
      savedPaymentMethodType: "card",
    });

    try {
      setMockConsent(fixture, {
        consentId: existingConsentId,
      });

      const event = makeConsentEvent(fixture);
      const result = await sendWebhook(event);

      assert.equal(result.statusCode, 500);

      const savedResult = await pool.query(
        `SELECT
           airwallex_payment_consent_id,
           airwallex_payment_method_id,
           airwallex_payment_method_type
         FROM subscriptions
         WHERE id = $1`,
        [fixture.subscriptionId]
      );

      assert.equal(
        savedResult.rows[0].airwallex_payment_consent_id,
        existingConsentId
      );
      assert.equal(
        savedResult.rows[0].airwallex_payment_method_id,
        existingMethodId
      );
      assert.equal(
        savedResult.rows[0].airwallex_payment_method_type,
        "card"
      );
    } finally {
      await cleanupFixture(fixture);
    }
  }
);
