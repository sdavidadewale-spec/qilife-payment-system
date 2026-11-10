const crypto = require("crypto");

async function claimRecurringPayment(client, paymentId) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client is required");
  }

  if (!paymentId) {
    throw new Error("A payment ID is required");
  }

  const claimToken = crypto.randomUUID();

  const result = await client.query(
    `UPDATE payments
     SET status = 'processing',
         processing_started_at = NOW(),
         processing_claim_token = $2
     WHERE id = $1
       AND instalment_number > 1
       AND manual_review_required = FALSE
       AND (
         status = 'pending'
         OR (
           status = 'processing'
           AND processing_started_at IS NOT NULL
           AND processing_started_at <=
               NOW() - INTERVAL '5 minutes'
         )
       )
     RETURNING
       id,
       subscription_id,
       instalment_number,
       amount,
       currency,
       airwallex_payment_id,
       airwallex_create_request_id,
       airwallex_confirm_request_id,
       processing_started_at,
       processing_claim_token`,
    [paymentId, claimToken]
  );

  return result.rows[0] || null;
}

async function renewRecurringPaymentClaim(
  client,
  paymentId,
  claimToken
) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client is required");
  }

  if (!paymentId || !claimToken) {
    throw new Error("Payment ID and claim token are required");
  }

  const result = await client.query(
    `UPDATE payments
     SET processing_started_at = NOW()
     WHERE id = $1
       AND status = 'processing'
       AND processing_claim_token = $2
       AND manual_review_required = FALSE
     RETURNING id, processing_claim_token`,
    [paymentId, claimToken]
  );

  return result.rows[0] || null;
}

async function assertRecurringPaymentClaim(
  client,
  paymentId,
  claimToken
) {
  const renewed = await renewRecurringPaymentClaim(
    client,
    paymentId,
    claimToken
  );

  if (!renewed) {
    throw new Error(
      "Recurring payment claim was lost. Processing has stopped."
    );
  }

  return true;
}

module.exports = {
  claimRecurringPayment,
  renewRecurringPaymentClaim,
  assertRecurringPaymentClaim,
};
