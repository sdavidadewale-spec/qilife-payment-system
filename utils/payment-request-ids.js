const crypto = require("crypto");

async function prepareRecurringPaymentRequestIds(
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

  const createRequestId = crypto.randomUUID();
  const confirmRequestId = crypto.randomUUID();

  const result = await client.query(
    `UPDATE payments
     SET airwallex_create_request_id =
           COALESCE(airwallex_create_request_id, $3),
         airwallex_confirm_request_id =
           COALESCE(airwallex_confirm_request_id, $4)
     WHERE id = $1
       AND processing_claim_token = $2
       AND status = 'processing'
       AND instalment_number > 1
       AND manual_review_required = FALSE
     RETURNING
       id,
       airwallex_create_request_id,
       airwallex_confirm_request_id`,
    [paymentId, claimToken, createRequestId, confirmRequestId]
  );

  if (result.rows.length !== 1) {
    throw new Error(
      "Payment claim was lost or payment is not eligible for recurring request IDs"
    );
  }

  return result.rows[0];
}

module.exports = {
  prepareRecurringPaymentRequestIds,
};
