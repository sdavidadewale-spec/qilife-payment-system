require("dotenv").config();

process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const pool = require("../db");

const {
  processRecurringPayment,
} = require("../workers/recurring-payment-processor");

function createTransactionalAdapter(client) {
  let counter = 0;
  const savepoints = [];

  return {
    async connect() {
      return {
        async query(sql, params) {
          const command = String(sql).trim().toUpperCase();

          if (command === "BEGIN") {
            const name = `processor_test_sp_${++counter}`;
            savepoints.push(name);
            return client.query(`SAVEPOINT ${name}`);
          }

          if (command === "COMMIT") {
            const name = savepoints.pop();

            if (!name) {
              throw new Error("No processor savepoint exists to commit");
            }

            return client.query(`RELEASE SAVEPOINT ${name}`);
          }

          if (command === "ROLLBACK") {
            const name = savepoints.pop();

            if (!name) {
              throw new Error("No processor savepoint exists to roll back");
            }

            await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
            return client.query(`RELEASE SAVEPOINT ${name}`);
          }

          return client.query(sql, params);
        },

        release() {
          // The outer test owns and releases the real database client.
        },
      };
    },
  };
}

async function createTestPayment(client) {
  const unique = crypto.randomUUID();

  const studentResult = await client.query(
    `INSERT INTO students (
       full_name,
       email,
       airwallex_customer_id
     )
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      "Processor Integration Test",
      `processor-${unique}@example.test`,
      `processor-customer-${unique}`,
    ]
  );

  const studentId = studentResult.rows[0].id;

  const subscriptionResult = await client.query(
    `INSERT INTO subscriptions (
       student_id,
       total_amount,
       currency,
       total_instalments,
       paid_instalments,
       status,
       airwallex_payment_consent_id,
       payment_consent_status,
       airwallex_payment_method_id,
       airwallex_payment_method_type
     )
     VALUES ($1, 200, 'SGD', 2, 1, 'active', $2, 'VERIFIED', $3, 'card')
     RETURNING id`,
    [
      studentId,
      `processor-consent-${unique}`,
      `processor-method-${unique}`,
    ]
  );

  const subscriptionId = subscriptionResult.rows[0].id;

  await client.query(
    `INSERT INTO payments (
       subscription_id,
       instalment_number,
       amount,
       currency,
       status,
       due_date
     )
     VALUES ($1, 1, 100, 'SGD', 'paid', CURRENT_DATE - 30)`,
    [subscriptionId]
  );

  const paymentResult = await client.query(
    `INSERT INTO payments (
       subscription_id,
       instalment_number,
       amount,
       currency,
       status,
       due_date
     )
     VALUES ($1, 2, 100, 'SGD', 'pending', CURRENT_DATE - 1)
     RETURNING id`,
    [subscriptionId]
  );

  return {
    paymentId: paymentResult.rows[0].id,
    studentId,
    subscriptionId,
  };
}

test("processor creates and confirms a recurring payment without marking it paid", async () => {
  const client = await pool.connect();

  try {
    const databaseResult = await client.query(
      "SELECT current_database() AS name"
    );

    assert.equal(
      databaseResult.rows[0].name,
      "qilife_test_db",
      "Test must use qilife_test_db"
    );

    await client.query("BEGIN");

    const fixture = await createTestPayment(client);
    const db = createTransactionalAdapter(client);

    let createCalls = 0;
    let confirmCalls = 0;
    let retrieveCalls = 0;

    const airwallex = {
      async createRecurringAirwallexPaymentIntent(args) {
        createCalls++;

        assert.equal(args.amount, "100.00");
        assert.equal(args.currency, "SGD");
        assert.equal(args.merchantOrderId, fixture.paymentId);
        assert.ok(args.customerId);
        assert.ok(args.requestId);

        return {
          id: `processor-test-intent-${crypto.randomUUID()}`,
          status: "REQUIRES_PAYMENT_METHOD",
          merchant_order_id: fixture.paymentId,
          amount: 100,
          currency: "SGD",
        };
      },

      async confirmAirwallexPaymentIntent(args) {
        confirmCalls++;

        assert.ok(args.paymentIntentId);
        assert.ok(args.requestId);
        assert.ok(args.customerId);
        assert.ok(args.paymentConsentId);
        assert.ok(args.paymentMethodId);

        return {
          status: "PENDING",
        };
      },

      async retrieveAirwallexPaymentIntent() {
        retrieveCalls++;
        throw new Error("Unexpected retrieve call in a new payment test");
      },
    };

    const result = await processRecurringPayment(
      fixture.paymentId,
      { db, airwallex }
    );

    assert.equal(result.status, "confirmation_submitted");
    assert.equal(result.paymentId, fixture.paymentId);
    assert.ok(result.paymentIntentId);

    assert.equal(createCalls, 1);
    assert.equal(confirmCalls, 1);
    assert.equal(retrieveCalls, 0);

    const paymentResult = await client.query(
      `SELECT
         status,
         paid_at,
         airwallex_payment_id,
         processing_claim_token,
         airwallex_create_request_id,
         airwallex_confirm_request_id
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    const payment = paymentResult.rows[0];

    assert.equal(payment.status, "processing");
    assert.equal(payment.paid_at, null);
    assert.equal(payment.airwallex_payment_id, result.paymentIntentId);
    assert.ok(payment.processing_claim_token);
    assert.ok(payment.airwallex_create_request_id);
    assert.ok(payment.airwallex_confirm_request_id);

    const historyResult = await client.query(
      `SELECT
         payment_id,
         airwallex_payment_intent_id,
         status
       FROM airwallex_payment_intents
       WHERE airwallex_payment_intent_id = $1`,
      [result.paymentIntentId]
    );

    assert.equal(historyResult.rowCount, 1);
    assert.equal(historyResult.rows[0].payment_id, fixture.paymentId);
    assert.equal(
      historyResult.rows[0].airwallex_payment_intent_id,
      result.paymentIntentId
    );
    assert.equal(
      historyResult.rows[0].status,
      "REQUIRES_PAYMENT_METHOD"
    );

    console.log("PaymentIntent creation: passed");
    console.log("PaymentIntent history: passed");
    console.log("Confirmation submission: passed");
    console.log("Payment remains processing until webhook: passed");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});


test("processor recovers from an unknown confirmation outcome without confirming twice", async () => {
  const client = await pool.connect();

  try {
    const databaseResult = await client.query(
      "SELECT current_database() AS name"
    );
    assert.equal(databaseResult.rows[0].name, "qilife_test_db");

    await client.query("BEGIN");

    const fixture = await createTestPayment(client);
    const db = createTransactionalAdapter(client);

    let createCalls = 0;
    let confirmCalls = 0;
    let retrieveCalls = 0;
    const confirmRequestIds = [];
    let providerIntent = null;

    const airwallex = {
      async createRecurringAirwallexPaymentIntent(args) {
        createCalls++;

        providerIntent = {
          id: `processor-confirm-recovery-${crypto.randomUUID()}`,
          status: "REQUIRES_PAYMENT_METHOD",
          merchant_order_id: fixture.paymentId,
          amount: 100,
          currency: "SGD",
        };

        return providerIntent;
      },

      async confirmAirwallexPaymentIntent(args) {
        confirmCalls++;
        confirmRequestIds.push(args.requestId);

        const error = new Error("Simulated lost confirmation response");
        error.outcomeUnknown = true;
        error.requestMayHaveReachedAirwallex = true;
        throw error;
      },

      async retrieveAirwallexPaymentIntent(paymentIntentId) {
        retrieveCalls++;
        assert.equal(paymentIntentId, providerIntent.id);

        return {
          ...providerIntent,
          status: "PENDING",
        };
      },
    };

    await assert.rejects(
      processRecurringPayment(fixture.paymentId, { db, airwallex }),
      /Simulated lost confirmation response/
    );

    const firstState = await client.query(
      `SELECT
         status,
         paid_at,
         airwallex_payment_id,
         airwallex_confirm_request_id,
         processing_claim_token
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    const firstPayment = firstState.rows[0];

    assert.equal(firstPayment.status, "processing");
    assert.equal(firstPayment.paid_at, null);
    assert.equal(firstPayment.airwallex_payment_id, providerIntent.id);
    assert.ok(firstPayment.airwallex_confirm_request_id);
    assert.ok(firstPayment.processing_claim_token);

    await client.query(
      `UPDATE payments
       SET processing_started_at = NOW() - INTERVAL '6 minutes'
       WHERE id = $1`,
      [fixture.paymentId]
    );

    const result = await processRecurringPayment(
      fixture.paymentId,
      { db, airwallex }
    );

    assert.equal(result.status, "awaiting_action");
    assert.equal(result.paymentIntentStatus, "PENDING");
    assert.equal(createCalls, 1);
    assert.equal(confirmCalls, 1);
    assert.equal(retrieveCalls, 1);
    assert.equal(confirmRequestIds.length, 1);
    assert.equal(
      confirmRequestIds[0],
      firstPayment.airwallex_confirm_request_id
    );

    const finalState = await client.query(
      `SELECT status, paid_at, airwallex_payment_id
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    assert.equal(finalState.rows[0].status, "processing");
    assert.equal(finalState.rows[0].paid_at, null);
    assert.equal(finalState.rows[0].airwallex_payment_id, providerIntent.id);

    console.log("Unknown confirmation outcome preserved PaymentIntent: passed");
    console.log("Recovery retrieved the existing PaymentIntent: passed");
    console.log("Duplicate confirmation prevented for PENDING status: passed");
    console.log("Payment remains unpaid until webhook: passed");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});

test("processor waits for webhook when recovered PaymentIntent succeeded", async () => {
  const client = await pool.connect();

  try {
    const databaseResult = await client.query(
      "SELECT current_database() AS name"
    );
    assert.equal(databaseResult.rows[0].name, "qilife_test_db");

    await client.query("BEGIN");

    const fixture = await createTestPayment(client);
    const db = createTransactionalAdapter(client);

    let confirmCalls = 0;
    let retrieveCalls = 0;
    let providerIntent = null;

    const airwallex = {
      async createRecurringAirwallexPaymentIntent() {
        providerIntent = {
          id: `processor-succeeded-recovery-${crypto.randomUUID()}`,
          status: "REQUIRES_PAYMENT_METHOD",
          merchant_order_id: fixture.paymentId,
          amount: 100,
          currency: "SGD",
        };
        return providerIntent;
      },

      async confirmAirwallexPaymentIntent() {
        confirmCalls++;
        const error = new Error("Simulated lost confirmation response");
        error.outcomeUnknown = true;
        error.requestMayHaveReachedAirwallex = true;
        throw error;
      },

      async retrieveAirwallexPaymentIntent(paymentIntentId) {
        retrieveCalls++;
        assert.equal(paymentIntentId, providerIntent.id);
        return { ...providerIntent, status: "SUCCEEDED" };
      },
    };

    await assert.rejects(
      processRecurringPayment(fixture.paymentId, { db, airwallex }),
      /Simulated lost confirmation response/
    );

    await client.query(
      `UPDATE payments
       SET processing_started_at = NOW() - INTERVAL '6 minutes'
       WHERE id = $1`,
      [fixture.paymentId]
    );

    const result = await processRecurringPayment(
      fixture.paymentId,
      { db, airwallex }
    );

    assert.equal(result.status, "awaiting_webhook");
    assert.equal(result.paymentIntentId, providerIntent.id);
    assert.equal(confirmCalls, 1);
    assert.equal(retrieveCalls, 1);

    const finalState = await client.query(
      `SELECT status, paid_at, airwallex_payment_id
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    assert.equal(finalState.rows[0].status, "processing");
    assert.equal(finalState.rows[0].paid_at, null);
    assert.equal(finalState.rows[0].airwallex_payment_id, providerIntent.id);

    console.log("Recovered SUCCEEDED PaymentIntent detected: passed");
    console.log("No duplicate confirmation submitted: passed");
    console.log("Payment remains unpaid until webhook: passed");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});

test("processor waits for customer action without confirming again", async () => {
  const client = await pool.connect();

  try {
    const databaseResult = await client.query(
      "SELECT current_database() AS name"
    );
    assert.equal(databaseResult.rows[0].name, "qilife_test_db");

    await client.query("BEGIN");

    const fixture = await createTestPayment(client);
    const db = createTransactionalAdapter(client);

    let confirmCalls = 0;
    let retrieveCalls = 0;
    let providerIntent = null;

    const airwallex = {
      async createRecurringAirwallexPaymentIntent() {
        providerIntent = {
          id: `processor-action-recovery-${crypto.randomUUID()}`,
          status: "REQUIRES_PAYMENT_METHOD",
          merchant_order_id: fixture.paymentId,
          amount: 100,
          currency: "SGD",
        };
        return providerIntent;
      },

      async confirmAirwallexPaymentIntent() {
        confirmCalls++;
        const error = new Error("Simulated lost confirmation response");
        error.outcomeUnknown = true;
        error.requestMayHaveReachedAirwallex = true;
        throw error;
      },

      async retrieveAirwallexPaymentIntent(paymentIntentId) {
        retrieveCalls++;
        assert.equal(paymentIntentId, providerIntent.id);
        return {
          ...providerIntent,
          status: "REQUIRES_CUSTOMER_ACTION",
        };
      },
    };

    await assert.rejects(
      processRecurringPayment(fixture.paymentId, { db, airwallex }),
      /Simulated lost confirmation response/
    );

    await client.query(
      `UPDATE payments
       SET processing_started_at = NOW() - INTERVAL '6 minutes'
       WHERE id = $1`,
      [fixture.paymentId]
    );

    const result = await processRecurringPayment(
      fixture.paymentId,
      { db, airwallex }
    );

    assert.equal(result.status, "awaiting_action");
    assert.equal(
      result.paymentIntentStatus,
      "REQUIRES_CUSTOMER_ACTION"
    );
    assert.equal(confirmCalls, 1);
    assert.equal(retrieveCalls, 1);

    const finalState = await client.query(
      `SELECT status, paid_at, airwallex_payment_id
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    assert.equal(finalState.rows[0].status, "processing");
    assert.equal(finalState.rows[0].paid_at, null);
    assert.equal(finalState.rows[0].airwallex_payment_id, providerIntent.id);

    console.log("Customer action status detected: passed");
    console.log("No duplicate confirmation submitted: passed");
    console.log("Payment remains unpaid: passed");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});

test("processor retrieves and reuses an existing PaymentIntent", async () => {
  const client = await pool.connect();

  try {
    const databaseResult = await client.query(
      "SELECT current_database() AS name"
    );
    assert.equal(databaseResult.rows[0].name, "qilife_test_db");

    await client.query("BEGIN");

    const fixture = await createTestPayment(client);
    const db = createTransactionalAdapter(client);
    const existingIntentId = `processor-existing-intent-${crypto.randomUUID()}`;

    await client.query(
      `UPDATE payments
       SET airwallex_payment_id = $2
       WHERE id = $1`,
      [fixture.paymentId, existingIntentId]
    );

    await client.query(
      `INSERT INTO airwallex_payment_intents (
         payment_id,
         airwallex_payment_intent_id,
         status
       )
       VALUES ($1, $2, 'REQUIRES_PAYMENT_METHOD')`,
      [fixture.paymentId, existingIntentId]
    );

    let createCalls = 0;
    let retrieveCalls = 0;
    let confirmCalls = 0;

    const airwallex = {
      async createRecurringAirwallexPaymentIntent() {
        createCalls++;
        throw new Error("Processor must not create a duplicate PaymentIntent");
      },

      async retrieveAirwallexPaymentIntent(paymentIntentId) {
        retrieveCalls++;
        assert.equal(paymentIntentId, existingIntentId);

        return {
          id: existingIntentId,
          status: "REQUIRES_PAYMENT_METHOD",
          merchant_order_id: fixture.paymentId,
          amount: 100,
          currency: "SGD",
        };
      },

      async confirmAirwallexPaymentIntent(args) {
        confirmCalls++;
        assert.equal(args.paymentIntentId, existingIntentId);
        assert.ok(args.requestId);
        assert.ok(args.customerId);
        assert.ok(args.paymentConsentId);
        assert.ok(args.paymentMethodId);

        return { status: "PENDING" };
      },
    };

    const result = await processRecurringPayment(
      fixture.paymentId,
      { db, airwallex }
    );

    assert.equal(result.status, "confirmation_submitted");
    assert.equal(result.paymentIntentId, existingIntentId);
    assert.equal(createCalls, 0);
    assert.equal(retrieveCalls, 1);
    assert.equal(confirmCalls, 1);

    const paymentResult = await client.query(
      `SELECT
         status,
         paid_at,
         airwallex_payment_id
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    assert.equal(paymentResult.rows[0].status, "processing");
    assert.equal(paymentResult.rows[0].paid_at, null);
    assert.equal(paymentResult.rows[0].airwallex_payment_id, existingIntentId);

    const historyResult = await client.query(
      `SELECT COUNT(*)::INTEGER AS count
       FROM airwallex_payment_intents
       WHERE payment_id = $1`,
      [fixture.paymentId]
    );

    assert.equal(historyResult.rows[0].count, 1);

    console.log("Existing PaymentIntent retrieved: passed");
    console.log("Duplicate creation prevented: passed");
    console.log("Existing PaymentIntent confirmed: passed");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});


test("processor reuses the same create request ID after an unknown outcome", async () => {
  const client = await pool.connect();

  try {
    const databaseResult = await client.query(
      "SELECT current_database() AS name"
    );
    assert.equal(databaseResult.rows[0].name, "qilife_test_db");

    await client.query("BEGIN");

    const fixture = await createTestPayment(client);
    const db = createTransactionalAdapter(client);

    const createRequestIds = [];
    let createCalls = 0;
    let confirmCalls = 0;
    let providerCreatedIntent = null;

    const airwallex = {
      async createRecurringAirwallexPaymentIntent(args) {
        createCalls++;
        createRequestIds.push(args.requestId);

        if (!providerCreatedIntent) {
          providerCreatedIntent = {
            id: `processor-recovered-intent-${crypto.randomUUID()}`,
            status: "REQUIRES_PAYMENT_METHOD",
            merchant_order_id: fixture.paymentId,
            amount: 100,
            currency: "SGD",
          };

          const error = new Error("Simulated lost Airwallex response");
          error.outcomeUnknown = true;
          error.requestMayHaveReachedAirwallex = true;
          throw error;
        }

        assert.equal(args.requestId, createRequestIds[0]);
        return providerCreatedIntent;
      },

      async confirmAirwallexPaymentIntent(args) {
        confirmCalls++;
        assert.ok(args.requestId);
        return { status: "PENDING" };
      },

      async retrieveAirwallexPaymentIntent() {
        throw new Error("Unexpected retrieve call");
      },
    };

    await assert.rejects(
      processRecurringPayment(fixture.paymentId, { db, airwallex }),
      /Simulated lost Airwallex response/
    );

    const firstState = await client.query(
      `SELECT
         status,
         airwallex_payment_id,
         airwallex_create_request_id,
         airwallex_confirm_request_id,
         processing_claim_token
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    const firstPayment = firstState.rows[0];

    assert.equal(firstPayment.status, "processing");
    assert.equal(firstPayment.airwallex_payment_id, null);
    assert.ok(firstPayment.airwallex_create_request_id);
    assert.ok(firstPayment.airwallex_confirm_request_id);
    assert.ok(firstPayment.processing_claim_token);

    await client.query(
      `UPDATE payments
       SET processing_started_at = NOW() - INTERVAL '6 minutes'
       WHERE id = $1`,
      [fixture.paymentId]
    );

    const result = await processRecurringPayment(
      fixture.paymentId,
      { db, airwallex }
    );

    assert.equal(result.status, "confirmation_submitted");
    assert.equal(createCalls, 2);
    assert.equal(confirmCalls, 1);
    assert.equal(createRequestIds.length, 2);
    assert.equal(createRequestIds[0], createRequestIds[1]);
    assert.equal(
      createRequestIds[1],
      firstPayment.airwallex_create_request_id
    );
    assert.equal(result.paymentIntentId, providerCreatedIntent.id);

    const finalState = await client.query(
      `SELECT
         status,
         paid_at,
         airwallex_payment_id,
         airwallex_create_request_id
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    assert.equal(finalState.rows[0].status, "processing");
    assert.equal(finalState.rows[0].paid_at, null);
    assert.equal(finalState.rows[0].airwallex_payment_id, result.paymentIntentId);
    assert.equal(
      finalState.rows[0].airwallex_create_request_id,
      createRequestIds[0]
    );

    console.log("Unknown create outcome preserved request ID: passed");
    console.log("Recovery reused the same request ID: passed");
    console.log("Payment was not marked paid: passed");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});


test("processor moves an uncertain normal confirmation to manual review", async () => {
  const client = await pool.connect();

  try {
    const databaseResult = await client.query(
      "SELECT current_database() AS name"
    );
    assert.equal(databaseResult.rows[0].name, "qilife_test_db");

    await client.query("BEGIN");

    const fixture = await createTestPayment(client);
    const db = createTransactionalAdapter(client);

    let confirmCalls = 0;
    let retrieveCalls = 0;
    let providerIntent = null;

    const airwallex = {
      async createRecurringAirwallexPaymentIntent() {
        providerIntent = {
          id: "uncertain-normal-" + crypto.randomUUID(),
          status: "REQUIRES_PAYMENT_METHOD",
          merchant_order_id: fixture.paymentId,
          amount: 100,
          currency: "SGD",
        };
        return providerIntent;
      },

      async confirmAirwallexPaymentIntent() {
        confirmCalls++;
        const error = new Error("Simulated lost confirmation response");
        error.outcomeUnknown = true;
        error.requestMayHaveReachedAirwallex = true;
        throw error;
      },

      async retrieveAirwallexPaymentIntent(paymentIntentId) {
        retrieveCalls++;
        assert.equal(paymentIntentId, providerIntent.id);
        return {
          ...providerIntent,
          status: "REQUIRES_PAYMENT_METHOD",
        };
      },
    };

    await assert.rejects(
      processRecurringPayment(fixture.paymentId, { db, airwallex }),
      /Simulated lost confirmation response/
    );

    const firstState = await client.query(
      `SELECT airwallex_confirmation_requested_at,
              processing_claim_token
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    assert.ok(firstState.rows[0].airwallex_confirmation_requested_at);
    assert.ok(firstState.rows[0].processing_claim_token);

    await client.query(
      `UPDATE payments
       SET processing_started_at = NOW() - INTERVAL '6 minutes'
       WHERE id = $1`,
      [fixture.paymentId]
    );

    const result = await processRecurringPayment(
      fixture.paymentId,
      { db, airwallex }
    );

    assert.equal(result.status, "manual_review_required");
    assert.equal(result.paymentIntentId, providerIntent.id);
    assert.equal(confirmCalls, 1);
    assert.equal(retrieveCalls, 1);

    const finalState = await client.query(
      `SELECT status, manual_review_required,
              manual_review_reason, next_retry_at,
              processing_claim_token, paid_at
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    const payment = finalState.rows[0];
    assert.equal(payment.status, "review_required");
    assert.equal(payment.manual_review_required, true);
    assert.match(payment.manual_review_reason, /previous confirmation request may have reached Airwallex/);
    assert.equal(payment.next_retry_at, null);
    assert.equal(payment.processing_claim_token, null);
    assert.equal(payment.paid_at, null);

    console.log("Normal payment moved to manual review: passed");
    console.log("Duplicate confirmation prevented: passed");
    console.log("Payment remains unpaid: passed");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});

test("processor moves an uncertain retry confirmation to manual review", async () => {
  const client = await pool.connect();

  try {
    const databaseResult = await client.query(
      "SELECT current_database() AS name"
    );
    assert.equal(databaseResult.rows[0].name, "qilife_test_db");

    await client.query("BEGIN");

    const fixture = await createTestPayment(client);
    const db = createTransactionalAdapter(client);
    const paymentIntentId = "uncertain-retry-" + crypto.randomUUID();

    await client.query(
      `UPDATE payments
       SET airwallex_payment_id = $2,
           next_retry_at = NOW() - INTERVAL '1 minute'
       WHERE id = $1`,
      [fixture.paymentId, paymentIntentId]
    );

    await client.query(
      `INSERT INTO airwallex_payment_intents (
         payment_id, airwallex_payment_intent_id, status
       )
       VALUES ($1, $2, 'REQUIRES_PAYMENT_METHOD')`,
      [fixture.paymentId, paymentIntentId]
    );

    await client.query(
      `INSERT INTO airwallex_payment_attempts (
         payment_id, attempt_number, request_id,
         airwallex_payment_intent_id,
         airwallex_payment_attempt_id, status,
         amount, currency, merchant_advice_code,
         issuer_response_code, completed_at
       )
       VALUES ($1, 1, $2, $3, $4, 'FAILED',
               100, 'SGD', '02', '51', NOW())`,
      [
        fixture.paymentId,
        "failed-request-" + crypto.randomUUID(),
        paymentIntentId,
        "provider-attempt-" + crypto.randomUUID(),
      ]
    );

    await client.query(
      `INSERT INTO payment_retry_operations (
         payment_id, payment_attempt_number,
         create_request_id, confirm_request_id,
         airwallex_payment_intent_id, status
       )
       VALUES ($1, 2, $2, $3, $4, 'confirmation_requested')`,
      [
        fixture.paymentId,
        "retry-create-" + crypto.randomUUID(),
        "retry-confirm-" + crypto.randomUUID(),
        paymentIntentId,
      ]
    );

    let retrieveCalls = 0;
    let confirmCalls = 0;
    let createCalls = 0;

    const airwallex = {
      async createRecurringAirwallexPaymentIntent() {
        createCalls++;
        throw new Error("Unexpected PaymentIntent creation");
      },

      async retrieveAirwallexPaymentIntent(id) {
        retrieveCalls++;
        assert.equal(id, paymentIntentId);
        return {
          id: paymentIntentId,
          status: "REQUIRES_PAYMENT_METHOD",
          merchant_order_id: fixture.paymentId,
          amount: 100,
          currency: "SGD",
        };
      },

      async confirmAirwallexPaymentIntent() {
        confirmCalls++;
        throw new Error("Unexpected confirmation request");
      },
    };

    const result = await processRecurringPayment(
      fixture.paymentId,
      { db, airwallex }
    );

    assert.equal(result.status, "manual_review_required");
    assert.equal(result.paymentIntentId, paymentIntentId);
    assert.equal(retrieveCalls, 1);
    assert.equal(createCalls, 0);
    assert.equal(confirmCalls, 0);

    const paymentResult = await client.query(
      `SELECT status, manual_review_required,
              manual_review_reason, next_retry_at,
              processing_claim_token, paid_at
       FROM payments
       WHERE id = $1`,
      [fixture.paymentId]
    );

    const payment = paymentResult.rows[0];
    assert.equal(payment.status, "review_required");
    assert.equal(payment.manual_review_required, true);
    assert.match(payment.manual_review_reason, /previous confirmation request may have reached Airwallex/);
    assert.equal(payment.next_retry_at, null);
    assert.equal(payment.processing_claim_token, null);
    assert.equal(payment.paid_at, null);

    const retryResult = await client.query(
      `SELECT status, last_error
       FROM payment_retry_operations
       WHERE payment_id = $1
         AND payment_attempt_number = 2`,
      [fixture.paymentId]
    );

    assert.equal(retryResult.rows[0].status, "manual_review");
    assert.match(retryResult.rows[0].last_error, /previous confirmation request may have reached Airwallex/);

    console.log("Retry payment moved to manual review: passed");
    console.log("Retry operation marked for manual review: passed");
    console.log("No duplicate confirmation or intent creation: passed");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});

test.after(async () => {
  await pool.end();
});

test("processor blocks recurring payments when card consent is missing or unverified", async () => {
  const client = await pool.connect();

  try {
    const databaseResult = await client.query(
      "SELECT current_database() AS name"
    );

    assert.equal(
      databaseResult.rows[0].name,
      "qilife_test_db",
      "Test must use qilife_test_db"
    );

    await client.query("BEGIN");

    const db = createTransactionalAdapter(client);

    let createCalls = 0;
    let retrieveCalls = 0;
    let confirmCalls = 0;

    const airwallex = {
      async createRecurringAirwallexPaymentIntent() {
        createCalls++;
        throw new Error("Unexpected Airwallex create call");
      },

      async retrieveAirwallexPaymentIntent() {
        retrieveCalls++;
        throw new Error("Unexpected Airwallex retrieve call");
      },

      async confirmAirwallexPaymentIntent() {
        confirmCalls++;
        throw new Error("Unexpected Airwallex confirm call");
      },
    };

    const invalidConsentCases = [
      {
        label: "PENDING consent",
        sql: `
          UPDATE subscriptions
          SET payment_consent_status = 'PENDING'
          WHERE id = $1
        `,
      },
      {
        label: "missing consent ID",
        sql: `
          UPDATE subscriptions
          SET airwallex_payment_consent_id = NULL
          WHERE id = $1
        `,
      },
      {
        label: "missing payment method ID",
        sql: `
          UPDATE subscriptions
          SET airwallex_payment_method_id = NULL
          WHERE id = $1
        `,
      },
      {
        label: "non-card payment method",
        sql: `
          UPDATE subscriptions
          SET airwallex_payment_method_type = 'bank'
          WHERE id = $1
        `,
      },
    ];

    for (const invalidCase of invalidConsentCases) {
      const fixture = await createTestPayment(client);

      await client.query(invalidCase.sql, [fixture.subscriptionId]);

      await assert.rejects(
        () => processRecurringPayment(fixture.paymentId, { db, airwallex }),
        /Verified recurring card consent is required/,
        invalidCase.label
      );

      const paymentResult = await client.query(
        `SELECT status, processing_claim_token,
                processing_started_at, manual_review_required,
                paid_at
         FROM payments
         WHERE id = $1`,
        [fixture.paymentId]
      );

      assert.equal(paymentResult.rows.length, 1);

      const payment = paymentResult.rows[0];

      assert.equal(payment.status, "pending", invalidCase.label);
      assert.equal(payment.processing_claim_token, null, invalidCase.label);
      assert.equal(payment.processing_started_at, null, invalidCase.label);
      assert.equal(payment.manual_review_required, false, invalidCase.label);
      assert.equal(payment.paid_at, null, invalidCase.label);

      console.log(`Blocked ${invalidCase.label}: passed`);
    }

    assert.equal(createCalls, 0);
    assert.equal(retrieveCalls, 0);
    assert.equal(confirmCalls, 0);

    console.log("No Airwallex calls made: passed");
    console.log("All invalid consent cases rolled back their payment claims: passed");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});
