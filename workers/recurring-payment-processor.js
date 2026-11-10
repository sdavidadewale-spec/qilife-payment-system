const pool = require("../db");
const airwallex = require("../airwallex");

const {
  claimRecurringPayment,
  assertRecurringPaymentClaim,
} = require("../utils/payment-claims");

const {
  prepareRecurringPaymentRequestIds,
} = require("../utils/payment-request-ids");

const {
  prepareRetryOperation,
} = require("../utils/payment-retry-status");

const {
  getNextRetryAttemptNumber,
  isRetryablePaymentFailure,
  hasVerifiedRecurringConsent,
} = require("../utils/payment-retry-rules");

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

function getAirwallexUpdatedAt(intent) {
  if (!intent.updated_at) return null;

  const timestamp = new Date(intent.updated_at);

  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Airwallex returned an invalid PaymentIntent timestamp");
  }

  return timestamp;
}

function validateIntent(intent, payment, expectedIntentId = null) {
  if (!intent || !intent.id || !intent.status) {
    throw new Error("Airwallex returned incomplete PaymentIntent details");
  }

  if (expectedIntentId && intent.id !== expectedIntentId) {
    throw new Error("Retrieved PaymentIntent ID does not match the requested ID");
  }

  if (intent.merchant_order_id !== payment.id) {
    throw new Error("PaymentIntent merchant order ID does not match the payment");
  }

  if (
    intent.amount === undefined ||
    Number(intent.amount).toFixed(2) !== Number(payment.amount).toFixed(2)
  ) {
    throw new Error("PaymentIntent amount does not match the payment");
  }

  if (
    !intent.currency ||
    String(intent.currency).toUpperCase() !==
      String(payment.currency).toUpperCase()
  ) {
    throw new Error("PaymentIntent currency does not match the payment");
  }

  getAirwallexUpdatedAt(intent);

  return true;
}

async function savePaymentIntent(
  client,
  {
    payment,
    claimToken,
    intent,
    requestId,
    retryOperation,
  }
) {
  await client.query("BEGIN");

  try {
    await assertRecurringPaymentClaim(
      client,
      payment.id,
      claimToken
    );

    await client.query(
      `INSERT INTO airwallex_payment_intents (
         payment_id,
         airwallex_payment_intent_id,
         request_id,
         status,
         airwallex_updated_at
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (airwallex_payment_intent_id)
       DO NOTHING`,
      [
        payment.id,
        intent.id,
        requestId,
        intent.status,
        getAirwallexUpdatedAt(intent),
      ]
    );

    const history = await client.query(
      `SELECT payment_id, request_id
       FROM airwallex_payment_intents
       WHERE airwallex_payment_intent_id = $1
       FOR UPDATE`,
      [intent.id]
    );

    if (
      history.rows.length !== 1 ||
      history.rows[0].payment_id !== payment.id ||
      history.rows[0].request_id !== requestId
    ) {
      throw new Error(
        "PaymentIntent history is already linked to different payment details"
      );
    }

    const paymentUpdate = await client.query(
      `UPDATE payments
       SET airwallex_payment_id = $3
       WHERE id = $1
         AND processing_claim_token = $2
         AND status = 'processing'
         AND manual_review_required = FALSE
         AND (
           airwallex_payment_id IS NULL
           OR airwallex_payment_id = $3
           OR (
             $4::BOOLEAN = TRUE
             AND airwallex_payment_id = $5
           )
         )
       RETURNING id`,
      [
        payment.id,
        claimToken,
        intent.id,
        Boolean(retryOperation),
        payment.airwallex_payment_id,
      ]
    );

    if (paymentUpdate.rowCount !== 1) {
      throw new Error("Payment could not be linked to its PaymentIntent");
    }

    if (retryOperation) {
      const retryUpdate = await client.query(
        `UPDATE payment_retry_operations
         SET airwallex_payment_intent_id = $2,
             status = 'intent_created',
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('prepared', 'intent_created')
           AND (
             airwallex_payment_intent_id IS NULL
             OR airwallex_payment_intent_id = $2
           )
         RETURNING id`,
        [retryOperation.id, intent.id]
      );

      if (retryUpdate.rowCount !== 1) {
        throw new Error("Retry operation could not be linked to its PaymentIntent");
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function markConfirmationRequested(
  client,
  paymentId,
  claimToken,
  retryOperation
) {
  await client.query("BEGIN");

  try {
    await assertRecurringPaymentClaim(
      client,
      paymentId,
      claimToken
    );

    const result = await client.query(
      `UPDATE payment_retry_operations
       SET status = 'confirmation_requested',
           updated_at = NOW()
       WHERE id = $1
         AND payment_id = $2
         AND status = 'intent_created'
         AND EXISTS (
           SELECT 1
           FROM payments
           WHERE id = $2
             AND processing_claim_token = $3
             AND status = 'processing'
             AND manual_review_required = FALSE
         )
       RETURNING id`,
      [
        retryOperation.id,
        paymentId,
        claimToken,
      ]
    );

    if (result.rowCount !== 1) {
      throw new Error("Retry confirmation could not be safely recorded");
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}


async function markPaymentConfirmationRequested(
  client,
  paymentId,
  claimToken
) {
  await client.query("BEGIN");

  try {
    await assertRecurringPaymentClaim(client, paymentId, claimToken);

    const result = await client.query(
      `UPDATE payments
       SET airwallex_confirmation_requested_at = NOW()
       WHERE id = $1
         AND processing_claim_token = $2
         AND status = 'processing'
         AND manual_review_required = FALSE
         AND airwallex_confirmation_requested_at IS NULL
       RETURNING id`,
      [paymentId, claimToken]
    );

    if (result.rowCount !== 1) {
      throw new Error(
        "Payment confirmation request could not be safely recorded"
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function markPaymentForConfirmationReview(
  client,
  {
    paymentId,
    claimToken,
    paymentIntentId,
    retryOperation,
    reason,
  }
) {
  await client.query("BEGIN");

  try {
    await assertRecurringPaymentClaim(client, paymentId, claimToken);

    const paymentResult = await client.query(
      `UPDATE payments
       SET status = 'review_required',
           manual_review_required = TRUE,
           manual_review_reason = $3,
           last_error = $3,
           next_retry_at = NULL,
           processing_started_at = NULL,
           processing_claim_token = NULL
       WHERE id = $1
         AND processing_claim_token = $2
         AND status = 'processing'
         AND manual_review_required = FALSE
       RETURNING id`,
      [paymentId, claimToken, reason]
    );

    if (paymentResult.rowCount !== 1) {
      throw new Error("Payment could not be moved to manual review");
    }

    if (retryOperation) {
      const retryResult = await client.query(
        `UPDATE payment_retry_operations
         SET status = 'manual_review',
             last_error = $3,
             updated_at = NOW()
         WHERE id = $1
           AND payment_id = $2
           AND status = 'confirmation_requested'
         RETURNING id`,
        [retryOperation.id, paymentId, reason]
      );

      if (retryResult.rowCount !== 1) {
        throw new Error(
          "Retry operation could not be moved to manual review"
        );
      }
    }

    await client.query("COMMIT");

    return {
      status: "manual_review_required",
      paymentId,
      paymentIntentId,
      reason,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function processRecurringPayment(paymentId, dependencies = {}) {
  if (!paymentId) {
    throw new Error("A payment ID is required");
  }

  const db = dependencies.db || pool;
  const api = dependencies.airwallex || airwallex;
  const client = await db.connect();

  let payment;
  let claimToken;
  let requestId;
  let confirmRequestId;
  let retryOperation = null;
  let paymentIntentId = null;
  let isRetry = false;

  try {
    await client.query("BEGIN");

    const claim = await claimRecurringPayment(client, paymentId);

    if (!claim) {
      await client.query("ROLLBACK");
      client.release();

      return {
        status: "skipped",
        reason: "Payment is not available for processing",
      };
    }

    claimToken = claim.processing_claim_token;

    const result = await client.query(
      `SELECT
         p.id,
         p.subscription_id,
         p.instalment_number,
         p.amount,
         p.currency,
         p.status,
         p.due_date,
         p.next_retry_at,
         p.airwallex_payment_id,
         p.airwallex_create_request_id,
         p.airwallex_confirm_request_id,
         p.airwallex_confirmation_requested_at,
         s.status AS subscription_status,
         s.payment_consent_status,
         s.airwallex_payment_consent_id,
         s.airwallex_payment_method_id,
         s.airwallex_payment_method_type,
         st.airwallex_customer_id,
         COALESCE(attempt_counts.failed_count, 0)::INTEGER
           AS failed_count,
         latest_attempt.status AS latest_attempt_status,
         latest_attempt.merchant_advice_code,
         latest_attempt.issuer_response_code,
         current_intent.airwallex_payment_intent_id
           AS current_history_intent_id,
         EXISTS (
           SELECT 1
           FROM airwallex_payment_intents any_intent
           WHERE any_intent.payment_id = p.id
         ) AS has_payment_intent_history,
         (
           p.due_date IS NOT NULL
           AND p.due_date <=
             (NOW() AT TIME ZONE 'Asia/Singapore')::date
         ) AS is_due,
         (
           p.next_retry_at IS NOT NULL
           AND p.next_retry_at <= NOW()
         ) AS retry_is_due,
         EXISTS (
           SELECT 1
           FROM payments earlier
           WHERE earlier.subscription_id = p.subscription_id
             AND earlier.instalment_number < p.instalment_number
             AND earlier.status <> 'paid'
         ) AS has_earlier_unpaid,
         EXISTS (
           SELECT 1
           FROM payments other_payment
           WHERE other_payment.subscription_id = p.subscription_id
             AND other_payment.id <> p.id
             AND other_payment.status = 'processing'
         ) AS has_other_processing
       FROM payments p
       JOIN subscriptions s ON s.id = p.subscription_id
       JOIN students st ON st.id = s.student_id

       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (
           WHERE UPPER(a.status) = 'FAILED'
         ) AS failed_count
         FROM airwallex_payment_attempts a
         WHERE a.payment_id = p.id
       ) attempt_counts ON TRUE

       LEFT JOIN LATERAL (
         SELECT
           a.status,
           a.merchant_advice_code,
           a.issuer_response_code
         FROM airwallex_payment_attempts a
         WHERE a.payment_id = p.id
           AND a.airwallex_payment_intent_id = p.airwallex_payment_id
         ORDER BY
           a.airwallex_created_at DESC NULLS LAST,
           a.airwallex_payment_attempt_id DESC
         LIMIT 1
       ) latest_attempt ON TRUE

       LEFT JOIN airwallex_payment_intents current_intent
         ON current_intent.payment_id = p.id
        AND current_intent.airwallex_payment_intent_id =
            p.airwallex_payment_id

       WHERE p.id = $1
       FOR UPDATE OF p, s, st`,
      [paymentId]
    );

    if (result.rows.length !== 1) {
      throw new Error("Payment details could not be found");
    }

    payment = result.rows[0];

    if (Number(payment.instalment_number) <= 1) {
      throw new Error("The recurring processor cannot process the first instalment");
    }

    if (payment.subscription_status !== "active") {
      throw new Error("Subscription is not active");
    }

    if (
      !hasVerifiedRecurringConsent({
        paymentConsentStatus: payment.payment_consent_status,
        paymentConsentId: payment.airwallex_payment_consent_id,
        paymentMethodId: payment.airwallex_payment_method_id,
        paymentMethodType: payment.airwallex_payment_method_type,
      })
    ) {
      throw new Error("Verified recurring card consent is required");
    }

    if (!payment.airwallex_customer_id) {
      throw new Error("Airwallex customer ID is missing");
    }

    if (payment.has_earlier_unpaid || payment.has_other_processing) {
      await client.query("ROLLBACK");
      client.release();

      return {
        status: "skipped",
        reason: "Another instalment must be completed first",
      };
    }

    isRetry = payment.next_retry_at !== null;

    if (isRetry) {
      if (!payment.retry_is_due) {
        await client.query("ROLLBACK");
        client.release();

        return {
          status: "skipped",
          reason: "Retry is not due yet",
        };
      }

      if (
        !payment.airwallex_payment_id ||
        payment.current_history_intent_id !== payment.airwallex_payment_id
      ) {
        throw new Error("Current failed PaymentIntent history is missing");
      }

      if (String(payment.latest_attempt_status).toUpperCase() !== "FAILED") {
        throw new Error("Current PaymentIntent has no confirmed failed attempt");
      }

      if (
        !isRetryablePaymentFailure({
          merchantAdviceCode: payment.merchant_advice_code,
          issuerResponseCode: payment.issuer_response_code,
        })
      ) {
        throw new Error("Current payment failure is not approved for retry");
      }

      const nextAttempt = getNextRetryAttemptNumber(
        payment.failed_count
      );

      if (!nextAttempt) {
        throw new Error("Maximum failed payment attempts have been reached");
      }

      retryOperation = await prepareRetryOperation(client, {
        paymentId,
        paymentAttemptNumber: nextAttempt,
        claimToken,
      });

      if (
        retryOperation.status === "failed" ||
        retryOperation.status === "manual_review" ||
        retryOperation.status === "succeeded"
      ) {
        throw new Error(
          `Retry operation cannot continue from status: ${retryOperation.status}`
        );
      }

      requestId = retryOperation.create_request_id;
      confirmRequestId = retryOperation.confirm_request_id;
      paymentIntentId = retryOperation.airwallex_payment_intent_id;
    } else {
      if (
        payment.airwallex_payment_id &&
        payment.current_history_intent_id !== payment.airwallex_payment_id
      ) {
        throw new Error(
          "Existing PaymentIntent is missing its matching history record"
        );
      }

      if (
        !payment.airwallex_payment_id &&
        payment.has_payment_intent_history
      ) {
        throw new Error(
          "PaymentIntent history exists but the payment has no current PaymentIntent ID"
        );
      }

      if (!payment.is_due) {
        await client.query("ROLLBACK");
        client.release();

        return {
          status: "skipped",
          reason: "Payment is not due yet",
        };
      }

      requestId = null;
      confirmRequestId = null;
    }

    if (!isRetry) {
      const requestIds = await prepareRecurringPaymentRequestIds(
        client,
        paymentId,
        claimToken
      );

      requestId = requestIds.airwallex_create_request_id;
      confirmRequestId = requestIds.airwallex_confirm_request_id;
      paymentIntentId = payment.airwallex_payment_id;
    }

    if (paymentIntentId && !isRetry && !payment.airwallex_payment_id) {
      throw new Error("PaymentIntent recovery state is inconsistent");
    }

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    throw error;
  }

  try {
    await assertRecurringPaymentClaim(
      client,
      paymentId,
      claimToken
    );

    let intent;

    if (paymentIntentId) {
      intent = await api.retrieveAirwallexPaymentIntent(paymentIntentId);

      await assertRecurringPaymentClaim(
        client,
        paymentId,
        claimToken
      );

      validateIntent(intent, payment, paymentIntentId);
    } else {
      intent = await api.createRecurringAirwallexPaymentIntent({
        amount: payment.amount,
        currency: payment.currency,
        customerId: payment.airwallex_customer_id,
        merchantOrderId: payment.id,
        requestId,
      });

      validateIntent(intent, payment);

      await assertRecurringPaymentClaim(
        client,
        paymentId,
        claimToken
      );

      await savePaymentIntent(client, {
        payment,
        claimToken,
        intent,
        requestId,
        retryOperation,
      });

      paymentIntentId = intent.id;
    }

    if (
      intent.status === "REQUIRES_PAYMENT_METHOD" &&
      (
        (
          retryOperation &&
          retryOperation.status === "confirmation_requested"
        ) ||
        (
          !retryOperation &&
          payment.airwallex_confirmation_requested_at
        )
      )
    ) {
      const reason =
        "A previous confirmation request may have reached Airwallex, "
        "but the PaymentIntent still requires a payment method. "
        "Automatic reconfirmation is blocked pending manual review.";

      return await markPaymentForConfirmationReview(client, {
        paymentId,
        claimToken,
        paymentIntentId: intent.id,
        retryOperation,
        reason,
      });
    }

    if (intent.status === "SUCCEEDED") {
      return {
        status: "awaiting_webhook",
        paymentId,
        paymentIntentId: intent.id,
        reason: "PaymentIntent is successful; webhook must confirm payment",
      };
    }

    if (intent.status !== "REQUIRES_PAYMENT_METHOD") {
      return {
        status: "awaiting_action",
        paymentId,
        paymentIntentId: intent.id,
        paymentIntentStatus: intent.status,
        reason: "PaymentIntent is not ready for confirmation",
      };
    }

    await assertRecurringPaymentClaim(
      client,
      paymentId,
      claimToken
    );

    if (retryOperation) {
      await markConfirmationRequested(
        client,
        paymentId,
        claimToken,
        retryOperation
      );
    } else {
      await markPaymentConfirmationRequested(
        client,
        paymentId,
        claimToken
      );
    }

    await assertRecurringPaymentClaim(
      client,
      paymentId,
      claimToken
    );

    const confirmation = await api.confirmAirwallexPaymentIntent({
      paymentIntentId: intent.id,
      requestId: confirmRequestId,
      customerId: payment.airwallex_customer_id,
      paymentConsentId: payment.airwallex_payment_consent_id,
      paymentMethodId: payment.airwallex_payment_method_id,
    });

    return {
      status: "confirmation_submitted",
      paymentId,
      paymentIntentId: intent.id,
      paymentIntentStatus: confirmation?.status || "unknown",
      reason: "Waiting for the Airwallex webhook to confirm the result",
    };
  } finally {
    client.release();
  }
}

module.exports = {
  processRecurringPayment,
  getSingaporeDate,
};
