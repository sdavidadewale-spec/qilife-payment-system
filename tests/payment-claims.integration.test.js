require("dotenv").config();

process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const pool = require("../db");

const { claimRecurringPayment } = require("../utils/payment-claims");

async function createPayment(client, options = {}) {
  const {
    instalmentNumber = 2,
    status = "pending",
    manualReviewRequired = false,
    processingStartedAt = null,
    createRequestId = null,
    confirmRequestId = null,
    airwallexPaymentId = null,
  } = options;

  const result = await client.query(
    `INSERT INTO payments (
       instalment_number,
       amount,
       currency,
       status,
       manual_review_required,
       processing_started_at,
       airwallex_create_request_id,
       airwallex_confirm_request_id,
       airwallex_payment_id
     )
     VALUES ($1, 100, 'SGD', $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      instalmentNumber,
      status,
      manualReviewRequired,
      processingStartedAt,
      createRequestId,
      confirmRequestId,
      airwallexPaymentId,
    ]
  );

  return result.rows[0].id;
}

test("recurring payment claims enforce ownership, stale recovery, and concurrent exclusion", async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const database = await client.query(
      "SELECT current_database() AS name"
    );
    assert.equal(database.rows[0].name, "qilife_test_db");

    const pendingId = await createPayment(client, {
      createRequestId: "test-create-stable-claim",
      confirmRequestId: "test-confirm-stable-claim",
      airwallexPaymentId: "test-existing-intent-claim",
    });

    const firstClaim = await claimRecurringPayment(client, pendingId);

    assert.ok(firstClaim);
    assert.equal(firstClaim.id, pendingId);
    assert.equal(firstClaim.instalment_number, 2);
    assert.ok(firstClaim.processing_claim_token);
    assert.ok(firstClaim.processing_started_at);

    const secondClaim = await claimRecurringPayment(client, pendingId);
    assert.equal(secondClaim, null);

    let result = await client.query(
      `SELECT status,
              processing_claim_token,
              airwallex_create_request_id,
              airwallex_confirm_request_id,
              airwallex_payment_id
       FROM payments
       WHERE id = $1`,
      [pendingId]
    );

    assert.equal(result.rows[0].status, "processing");
    assert.equal(
      result.rows[0].processing_claim_token,
      firstClaim.processing_claim_token
    );
    assert.equal(
      result.rows[0].airwallex_create_request_id,
      "test-create-stable-claim"
    );
    assert.equal(
      result.rows[0].airwallex_confirm_request_id,
      "test-confirm-stable-claim"
    );
    assert.equal(
      result.rows[0].airwallex_payment_id,
      "test-existing-intent-claim"
    );

    const staleId = await createPayment(client, {
      status: "processing",
      processingStartedAt: new Date(Date.now() - 6 * 60 * 1000),
    });

    const staleClaim = await claimRecurringPayment(client, staleId);
    assert.ok(staleClaim);
    assert.ok(staleClaim.processing_claim_token);

    const manualReviewId = await createPayment(client, {
      manualReviewRequired: true,
    });

    const blockedClaim = await claimRecurringPayment(client, manualReviewId);
    assert.equal(blockedClaim, null);

    const firstInstalmentId = await createPayment(client, {
      instalmentNumber: 1,
    });

    const firstInstalmentClaim = await claimRecurringPayment(
      client,
      firstInstalmentId
    );
    assert.equal(firstInstalmentClaim, null);

    // Create a committed test payment so both connections can see it.
    const setupClient = await pool.connect();
    let concurrentPaymentId = null;
    let claimClientA = null;
    let claimClientB = null;

    try {
      concurrentPaymentId = await createPayment(setupClient, {
        createRequestId: `concurrent-create-${crypto.randomUUID()}`,
        confirmRequestId: `concurrent-confirm-${crypto.randomUUID()}`,
      });

      claimClientA = await pool.connect();
      claimClientB = await pool.connect();

      const concurrentClaims = await Promise.all([
        claimRecurringPayment(claimClientA, concurrentPaymentId),
        claimRecurringPayment(claimClientB, concurrentPaymentId),
      ]);

      const successfulClaims = concurrentClaims.filter(Boolean);
      const rejectedClaims = concurrentClaims.filter(
        (claim) => claim === null
      );

      assert.equal(successfulClaims.length, 1);
      assert.equal(rejectedClaims.length, 1);
      assert.ok(successfulClaims[0].processing_claim_token);

      console.log("Concurrent claim protection passed:", true);
    } finally {
      if (claimClientA) claimClientA.release();
      if (claimClientB) claimClientB.release();

      if (concurrentPaymentId) {
        await setupClient.query(
          "DELETE FROM payments WHERE id = $1",
          [concurrentPaymentId]
        );
      }

      setupClient.release();
    }

    console.log("All recurring payment claim checks passed.");
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
