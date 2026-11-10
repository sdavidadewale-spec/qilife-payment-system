require("dotenv").config();

process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";

const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");

const {
  prepareRecurringPaymentRequestIds,
} = require("../utils/payment-request-ids");
const {
  claimRecurringPayment,
} = require("../utils/payment-claims");

test("recurring payment request IDs remain stable and preserve existing IDs", async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const database = await client.query(
      "SELECT current_database() AS name"
    );
    assert.equal(database.rows[0].name, "qilife_test_db");

    const created = await client.query(
      `INSERT INTO payments (
         instalment_number,
         amount,
         currency,
         status
       )
       VALUES (2, 100, 'SGD', 'pending')
       RETURNING id`,
    );

    const paymentId = created.rows[0].id;

    const firstClaim = await claimRecurringPayment(client, paymentId);
    assert.ok(firstClaim);

    const first = await prepareRecurringPaymentRequestIds(
      client,
      paymentId,
      firstClaim.processing_claim_token
    );

    assert.ok(first.airwallex_create_request_id);
    assert.ok(first.airwallex_confirm_request_id);
    assert.notEqual(
      first.airwallex_create_request_id,
      first.airwallex_confirm_request_id
    );

    const second = await prepareRecurringPaymentRequestIds(
      client,
      paymentId,
      firstClaim.processing_claim_token
    );

    assert.equal(
      second.airwallex_create_request_id,
      first.airwallex_create_request_id
    );
    assert.equal(
      second.airwallex_confirm_request_id,
      first.airwallex_confirm_request_id
    );

    const existingCreateId = `existing-create-${paymentId}`;

    const existingPayment = await client.query(
      `INSERT INTO payments (
         instalment_number,
         amount,
         currency,
         status,
         airwallex_create_request_id
       )
       VALUES (2, 100, 'SGD', 'pending', $1)
       RETURNING id`,
      [existingCreateId]
    );

    const existingClaim = await claimRecurringPayment(
      client,
      existingPayment.rows[0].id
    );
    assert.ok(existingClaim);

    const preserved = await prepareRecurringPaymentRequestIds(
      client,
      existingPayment.rows[0].id,
      existingClaim.processing_claim_token
    );

    assert.equal(
      preserved.airwallex_create_request_id,
      existingCreateId
    );
    assert.ok(preserved.airwallex_confirm_request_id);

    await assert.rejects(
      prepareRecurringPaymentRequestIds(
        client,
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-0000-0000-000000000001"
      ),
      /claim was lost or payment is not eligible/
    );

    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
