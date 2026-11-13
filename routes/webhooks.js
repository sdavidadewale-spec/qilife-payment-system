const express = require("express");
const router = express.Router();
const pool = require("../db");
const { addMonthsClamped } = require("../utils/payment-dates");
const {
  retrieveAirwallexPaymentConsent,
} = require("../airwallex");
const {
  getNextRetryAttemptNumber,
  isRetryablePaymentFailure,
  hasVerifiedRecurringConsent,
} = require("../utils/payment-retry-rules");
const {
  canRecordSuccessfulPayment,
} = require("../utils/payment-success-rules");
const {
  updateRetryOperationAfterFailure,
  markOldRetryOperationForManualReview,
  markRetryOperationSucceeded,
} = require("../utils/payment-retry-status");

const PAYMENT_INTENT_STATUS_EVENTS = [
  "payment_intent.created",
  "payment_intent.requires_payment_method",
  "payment_intent.updated",
  "payment_intent.requires_capture",
  "payment_intent.requires_customer_action",
  "payment_intent.pending",
  "payment_intent.pending_review",
  "payment_intent.cancelled",
  "payment_intent.payment_failed",
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Receive Airwallex webhook notifications.
router.post("/", async (req, res) => {
  if (req.webhookSignatureValid !== true) {
    return res.status(400).json({
      message: "Invalid webhook signature",
    });
  }

  // Acknowledge verified test events without processing payments.
  if (req.isAirwallexTestEvent === true) {
    return res.status(200).json({
      received: true,
      test: true,
    });
  }

  const event = req.body;
  const eventObject = event.data?.object;

  if (!event.id || !event.name) {
    return res.status(400).json({
      message: "Webhook event details are missing",
    });
  }

  const isSuccessfulPaymentEvent =
    event.name === "payment_intent.succeeded";

  const isPaymentIntentStatusEvent =
    PAYMENT_INTENT_STATUS_EVENTS.includes(event.name);

  if (isSuccessfulPaymentEvent || isPaymentIntentStatusEvent) {
    const merchantOrderId = eventObject?.merchant_order_id;

    // Leave missing IDs to the existing event validation below.
    // Only reject a supplied, non-empty ID that is not a valid UUID.
    if (
      merchantOrderId !== undefined &&
      merchantOrderId !== null &&
      merchantOrderId !== "" &&
      (
        typeof merchantOrderId !== "string" ||
        !UUID_PATTERN.test(merchantOrderId)
      )
    ) {
      if (isSuccessfulPaymentEvent) {
        console.error(
          "Webhook processing error: successful PaymentIntent has an invalid merchant_order_id",
          { eventId: event.id }
        );

        return res.status(500).json({
          message: "Could not process webhook",
        });
      }

      console.warn(
        "Ignoring PaymentIntent status event with an invalid merchant_order_id",
        {
          eventId: event.id,
          eventName: event.name,
        }
      );

      return res.status(200).json({
        received: true,
        ignored: true,
      });
    }
  }

  let client;
  let verifiedConsent = null;

  try {
    // Avoid another Airwallex lookup for an already processed consent event.
    if (event.name === "payment_consent.verified") {
      const existingEventResult = await pool.query(
        "SELECT 1 FROM webhook_events WHERE event_id = $1 LIMIT 1",
        [event.id]
      );

      if (existingEventResult.rowCount > 0) {
        return res.status(200).json({
          received: true,
          duplicate: true,
        });
      }
    }

    // Retrieve and validate the consent before opening a database transaction.
    if (event.name === "payment_consent.verified") {
      if (!eventObject?.id) {
        throw new Error("Payment consent ID is missing from the event");
      }

      verifiedConsent = await retrieveAirwallexPaymentConsent(
        eventObject.id
      );

      if (
        !verifiedConsent ||
        verifiedConsent.id !== eventObject.id ||
        verifiedConsent.status !== "VERIFIED" ||
        !verifiedConsent.initial_payment_intent_id ||
        !verifiedConsent.customer_id ||
        !verifiedConsent.payment_method?.id ||
        verifiedConsent.payment_method.type !== "card"
      ) {
        throw new Error(
          "Airwallex returned incomplete or invalid verified card consent"
        );
      }
    }

    client = await pool.connect();

    await client.query("BEGIN");

    // Save each event only once.
    const eventResult = await client.query(
      `INSERT INTO webhook_events (event_id, event_type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, event.name, JSON.stringify(event)]
    );

    // Stop if this event was already processed.
    if (eventResult.rowCount === 0) {
      await client.query("COMMIT");

      return res.status(200).json({
        received: true,
        duplicate: true,
      });
    }

    // Track Airwallex PaymentAttempt events.
    if (event.name.startsWith("payment_attempt.")) {
      if (!eventObject) {
        throw new Error("PaymentAttempt event data is missing");
      }

      const attempt = eventObject;

      if (
        !attempt.id ||
        !attempt.payment_intent_id ||
        !attempt.status ||
        attempt.amount === undefined ||
        !attempt.currency ||
        !attempt.created_at ||
        !Number.isFinite(Date.parse(attempt.created_at)) ||
        !attempt.updated_at ||
        !Number.isFinite(Date.parse(attempt.updated_at))
      ) {
        throw new Error("PaymentAttempt details are incomplete");
      }

      // Find and lock the instalment through PaymentIntent history.
      const paymentResult = await client.query(
        `SELECT
           p.id,
           p.amount,
           p.currency,
           p.status AS payment_status,
           p.instalment_number,
           p.airwallex_payment_id AS current_payment_intent_id,
           p.payment_attempts,
           p.manual_review_required,
           s.payment_consent_status,
           s.airwallex_payment_consent_id,
           s.airwallex_payment_method_id,
           s.airwallex_payment_method_type,
           intents.status AS payment_intent_status
         FROM airwallex_payment_intents AS intents
         JOIN payments AS p
           ON p.id = intents.payment_id
         JOIN subscriptions AS s
           ON s.id = p.subscription_id
         WHERE intents.airwallex_payment_intent_id = $1
         FOR UPDATE OF p, intents, s`,
        [attempt.payment_intent_id]
      );

      if (paymentResult.rows.length !== 1) {
        throw new Error(
          "Payment for this PaymentAttempt was not found. Airwallex should retry this event."
        );
      }

      const payment = paymentResult.rows[0];

      // Verify the attempt amount and currency.
      if (
        Number(payment.amount).toFixed(2) !==
          Number(attempt.amount).toFixed(2) ||
        payment.currency !== attempt.currency
      ) {
        throw new Error("PaymentAttempt amount or currency does not match");
      }

      // The final attempt number is assigned by creation time below.
      const attemptNumber = 1000000;

      const failureCode =
        attempt.failure_code ||
        attempt.failure_details?.code ||
        null;

      const merchantAdviceCode =
        attempt.merchant_advice_code || null;

      const issuerResponseCode =
        attempt.provider_original_response_code ||
        attempt.failure_details?.details?.original_response_code ||
        null;

      const failureMessage =
        attempt.failure_details?.message || null;

      // Only completed attempt states receive a completion time.
      const completedStatuses = [
        "CAPTURE_REQUESTED",
        "SETTLED",
        "PAID",
        "FAILED",
        "EXPIRED",
        "CANCELLED",
      ];

      const completedAt = completedStatuses.includes(attempt.status)
        ? new Date(attempt.updated_at)
        : null;

      // Check whether this attempt already exists before updating it.
      const existingAttemptBeforeSave = await client.query(
        `SELECT
           payment_id,
           airwallex_payment_intent_id,
           status
         FROM airwallex_payment_attempts
         WHERE airwallex_payment_attempt_id = $1`,
        [attempt.id]
      );

      if (
        existingAttemptBeforeSave.rows.length > 0 &&
        (
          existingAttemptBeforeSave.rows[0].payment_id !== payment.id ||
          existingAttemptBeforeSave.rows[0].airwallex_payment_intent_id !==
            attempt.payment_intent_id
        )
      ) {
        throw new Error(
          "PaymentAttempt ID is already linked to a different payment"
        );
      }

      const isNewFailedAttempt =
        (
          existingAttemptBeforeSave.rows.length === 0 ||
          String(existingAttemptBeforeSave.rows[0].status).toUpperCase() !==
            "FAILED"
        ) &&
        String(attempt.status).toUpperCase() === "FAILED";

      // Save the attempt and protect its payment ownership.
      const attemptResult = await client.query(
        `INSERT INTO airwallex_payment_attempts (
           payment_id,
           attempt_number,
           airwallex_payment_intent_id,
           airwallex_payment_attempt_id,
           status,
           amount,
           currency,
           airwallex_created_at,
           airwallex_updated_at,
           failure_code,
           merchant_advice_code,
           issuer_response_code,
           failure_message,
           completed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (airwallex_payment_attempt_id)
         DO UPDATE SET
           status = EXCLUDED.status,
           amount = EXCLUDED.amount,
           currency = EXCLUDED.currency,
           airwallex_created_at = EXCLUDED.airwallex_created_at,
           airwallex_updated_at = EXCLUDED.airwallex_updated_at,
           failure_code = EXCLUDED.failure_code,
           merchant_advice_code = EXCLUDED.merchant_advice_code,
           issuer_response_code = EXCLUDED.issuer_response_code,
           failure_message = EXCLUDED.failure_message,
           completed_at = EXCLUDED.completed_at,
           updated_at = NOW()
         WHERE airwallex_payment_attempts.payment_id = EXCLUDED.payment_id
           AND airwallex_payment_attempts.airwallex_payment_intent_id =
               EXCLUDED.airwallex_payment_intent_id
           AND (
             airwallex_payment_attempts.airwallex_updated_at IS NULL
             OR airwallex_payment_attempts.airwallex_updated_at
                < EXCLUDED.airwallex_updated_at
           )
         RETURNING id`,
        [
          payment.id,
          attemptNumber,
          attempt.payment_intent_id,
          attempt.id,
          attempt.status,
          attempt.amount,
          attempt.currency,
          attempt.created_at,
          attempt.updated_at,
          failureCode,
          merchantAdviceCode,
          issuerResponseCode,
          failureMessage,
          completedAt,
        ]
      );

      // Check whether the attempt ID belongs to another payment.
      if (attemptResult.rowCount === 0) {
        const existingAttempt = await client.query(
          `SELECT payment_id, airwallex_payment_intent_id
           FROM airwallex_payment_attempts
           WHERE airwallex_payment_attempt_id = $1`,
          [attempt.id]
        );

        if (
          existingAttempt.rows.length === 0 ||
          existingAttempt.rows[0].payment_id !== payment.id ||
          existingAttempt.rows[0].airwallex_payment_intent_id !==
            attempt.payment_intent_id
        ) {
          throw new Error(
            "PaymentAttempt ID is already linked to a different payment"
          );
        }
      }

      // Number attempts by Airwallex creation time, not webhook arrival order.
      await client.query(
        `UPDATE airwallex_payment_attempts
         SET attempt_number = attempt_number + 1000000
         WHERE payment_id = $1`,
        [payment.id]
      );

      await client.query(
        `WITH ranked_attempts AS (
           SELECT
             id,
             ROW_NUMBER() OVER (
               ORDER BY airwallex_created_at ASC,
                        airwallex_payment_attempt_id ASC
             ) AS new_attempt_number
           FROM airwallex_payment_attempts
           WHERE payment_id = $1
         )
         UPDATE airwallex_payment_attempts AS attempts
         SET attempt_number = ranked_attempts.new_attempt_number
         FROM ranked_attempts
         WHERE attempts.id = ranked_attempts.id`,
        [payment.id]
      );

      // Schedule retries only for a newly recorded failed attempt.
      if (
        isNewFailedAttempt &&
        attemptResult.rowCount === 1 &&
        attempt.status === "FAILED" &&
        payment.instalment_number > 1 &&
        payment.current_payment_intent_id === attempt.payment_intent_id &&
        ["pending", "processing"].includes(payment.payment_status) &&
        !payment.manual_review_required
      ) {
        const failedCountResult = await client.query(
          `SELECT COUNT(*)::INTEGER AS failed_count
           FROM airwallex_payment_attempts
           WHERE payment_id = $1
             AND UPPER(status) = 'FAILED'`,
          [payment.id]
        );

        const failedCount = failedCountResult.rows[0].failed_count;

        const nextRetryAttemptNumber =
          getNextRetryAttemptNumber(failedCount);

        const retryable = isRetryablePaymentFailure({
          merchantAdviceCode,
          issuerResponseCode,
        });

        const consentReady = hasVerifiedRecurringConsent({
          paymentConsentStatus: payment.payment_consent_status,
          paymentConsentId: payment.airwallex_payment_consent_id,
          paymentMethodId: payment.airwallex_payment_method_id,
          paymentMethodType: payment.airwallex_payment_method_type,
        });

        const retryCanContinue =
          retryable &&
          nextRetryAttemptNumber !== null &&
          consentReady;

        // Update only the retry operation linked to this exact PaymentIntent.
        await updateRetryOperationAfterFailure(client, {
          paymentIntentId: attempt.payment_intent_id,
          canRetry: retryCanContinue,
          errorMessage:
            failureMessage || failureCode || "Payment attempt failed",
        });

        if (retryCanContinue) {
          const retryUpdateResult = await client.query(
            `UPDATE payments
             SET status = 'pending',
                 payment_attempts = $2,
                 next_retry_at = NOW() + INTERVAL '72 hours',
                 manual_review_required = FALSE,
                 manual_review_reason = NULL,
                 processing_started_at = NULL,
                 processing_claim_token = NULL,
                 last_error = $3
             WHERE id = $1
               AND airwallex_payment_id = $4
               AND status IN ('pending', 'processing')
               AND manual_review_required = FALSE`,
            [
              payment.id,
              failedCount,
              failureMessage || failureCode || "Payment attempt failed",
              attempt.payment_intent_id,
            ]
          );

          if (retryUpdateResult.rowCount !== 1) {
            throw new Error("Failed to schedule the payment retry");
          }
        } else {
          const reviewReason =
            nextRetryAttemptNumber === null
              ? "Maximum of three failed payment attempts reached."
              : !retryable
                ? "Payment failure is not approved for automatic retry."
                : "Verified recurring payment consent is unavailable.";

          const reviewUpdateResult = await client.query(
            `UPDATE payments
             SET status = 'review_required',
                 payment_attempts = $2,
                 manual_review_required = TRUE,
                 manual_review_reason = $3,
                 next_retry_at = NULL,
                 processing_started_at = NULL,
                 processing_claim_token = NULL,
                 last_error = $4
             WHERE id = $1
               AND airwallex_payment_id = $5
               AND status IN ('pending', 'processing')
               AND manual_review_required = FALSE`,
            [
              payment.id,
              failedCount,
              reviewReason,
              failureMessage || failureCode || reviewReason,
              attempt.payment_intent_id,
            ]
          );

          if (reviewUpdateResult.rowCount !== 1) {
            throw new Error("Failed to mark the payment for manual review");
          }
        }
      }
    }

    // Handle successful payments.
    if (event.name === "payment_intent.succeeded") {
      if (!eventObject) {
        throw new Error("PaymentIntent event data is missing");
      }

      const intent = eventObject;

      if (
        !intent.id ||
        !intent.merchant_order_id ||
        intent.status !== "SUCCEEDED" ||
        intent.amount === undefined ||
        !intent.currency ||
        !intent.updated_at ||
        !Number.isFinite(Date.parse(intent.updated_at))
      ) {
        throw new Error("Successful payment details are incomplete");
      }

      // Find the instalment through PaymentIntent history.
      const paymentResult = await client.query(
        `SELECT
           p.id,
           p.subscription_id,
           p.amount,
           p.currency,
           p.status,
           p.manual_review_required,
           p.airwallex_payment_id,
           s.total_instalments
         FROM airwallex_payment_intents AS intents
         JOIN payments AS p
           ON p.id = intents.payment_id
         JOIN subscriptions AS s
           ON s.id = p.subscription_id
         WHERE p.id = $1
           AND intents.airwallex_payment_intent_id = $2
         FOR UPDATE OF p, s, intents`,
        [
          intent.merchant_order_id,
          intent.id,
        ]
      );

      if (paymentResult.rows.length !== 1) {
        throw new Error(
          "Matching PaymentIntent was not found. Airwallex should retry this event."
        );
      }

      const payment = paymentResult.rows[0];

      // Verify the payment amount and currency.
      if (
        Number(payment.amount).toFixed(2) !==
          Number(intent.amount).toFixed(2) ||
        payment.currency !== intent.currency
      ) {
        throw new Error("Payment amount or currency does not match");
      }

      if (
        !canRecordSuccessfulPayment({
          paymentStatus: payment.status,
          manualReviewRequired: payment.manual_review_required,
          currentPaymentIntentId: payment.airwallex_payment_id,
          successfulPaymentIntentId: intent.id,
        })
      ) {
        throw new Error("Payment is not in a valid state");
      }

      // Record an old successful PaymentIntent for manual review.
      if (payment.airwallex_payment_id !== intent.id) {
        await markOldRetryOperationForManualReview(client, intent.id);

        await client.query(
          `UPDATE airwallex_payment_intents
           SET status = 'SUCCEEDED',
               airwallex_updated_at = GREATEST(
                 COALESCE(airwallex_updated_at, $2::timestamptz),
                 $2::timestamptz
               ),
               updated_at = NOW()
           WHERE payment_id = $1
             AND airwallex_payment_intent_id = $3`,
          [
            payment.id,
            intent.updated_at,
            intent.id,
          ]
        );

        await client.query(
          `UPDATE payments
           SET status = CASE
                 WHEN status = 'paid' THEN status
                 ELSE 'review_required'
               END,
               manual_review_required = TRUE,
               manual_review_reason =
                 'An older PaymentIntent succeeded after replacement.',
               next_retry_at = NULL,
               processing_started_at = NULL,
               processing_claim_token = NULL
           WHERE id = $1
           AND status IN ('pending', 'processing', 'paid')`,
          [payment.id]
        );


        await client.query(
          `INSERT INTO payment_review_events (
             event_id,
             payment_id,
             airwallex_payment_intent_id,
             reason,
             amount,
             currency
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            event.id,
            payment.id,
            intent.id,
            "An older PaymentIntent succeeded after replacement.",
            intent.amount,
            intent.currency,
          ]
        );

        console.warn(
          "Payment requires manual review:",
          payment.id,
          intent.id
        );

        await client.query("COMMIT");

        return res.status(200).json({
          received: true,
          processed: true,
          manual_review_required: true,
        });
      }

      // Update the PaymentIntent history record.
      await client.query(
        `UPDATE airwallex_payment_intents
         SET status = 'SUCCEEDED',
             airwallex_updated_at = GREATEST(
               COALESCE(airwallex_updated_at, $2::timestamptz),
               $2::timestamptz
             ),
             updated_at = NOW()
         WHERE payment_id = $1
           AND airwallex_payment_intent_id = $3`,
        [
          payment.id,
          intent.updated_at,
          intent.id,
        ]
      );

      // Mark the matching retry operation as successful, if this was a retry.
      await markRetryOperationSucceeded(client, intent.id);

      // Mark the instalment as paid.
      const updateResult = await client.query(
        `UPDATE payments
         SET status = 'paid',
             paid_at = COALESCE(paid_at, NOW()),
             processing_started_at = NULL,
             processing_claim_token = NULL,
             airwallex_payment_intent_status =
               CASE
                 WHEN airwallex_payment_intent_updated_at IS NULL
                   OR airwallex_payment_intent_updated_at <= $2::timestamptz
                 THEN 'SUCCEEDED'
                 ELSE airwallex_payment_intent_status
               END,
             airwallex_payment_intent_updated_at =
               GREATEST(
                 COALESCE(airwallex_payment_intent_updated_at, $2::timestamptz),
                 $2::timestamptz
               )
         WHERE id = $1
           AND airwallex_payment_id = $3
         RETURNING id`,
        [
          payment.id,
          intent.updated_at,
          intent.id,
        ]
      );

      if (updateResult.rowCount !== 1) {
        throw new Error("Payment status could not be updated");
      }

      // Save the consent ID if the successful payment includes it.
      if (intent.payment_consent_id) {
        const consentResult = await client.query(
          `UPDATE subscriptions
           SET airwallex_payment_consent_id = $1
           WHERE id = $2
             AND (
               airwallex_payment_consent_id IS NULL
               OR airwallex_payment_consent_id = $1
             )
           RETURNING id`,
          [
            intent.payment_consent_id,
            payment.subscription_id,
          ]
        );

        if (consentResult.rowCount === 0) {
          throw new Error("Payment consent ID could not be saved");
        }
      }

      // Get the first payment date in Singapore time.
      const paidDateResult = await client.query(
        `SELECT
           to_char(
             paid_at AT TIME ZONE 'Asia/Singapore',
             'YYYY-MM-DD'
           ) AS paid_date_singapore,
           instalment_number
         FROM payments
         WHERE id = $1`,
        [payment.id]
      );

      if (paidDateResult.rows.length === 0) {
        throw new Error("Paid instalment record was not found");
      }

      // Set monthly due dates after the first payment succeeds.
      if (Number(paidDateResult.rows[0].instalment_number) === 1) {
        const firstPaidDate =
          paidDateResult.rows[0].paid_date_singapore;

        if (!firstPaidDate) {
          throw new Error("First payment date is missing");
        }

        const scheduleResult = await client.query(
          `SELECT id, instalment_number
           FROM payments
           WHERE subscription_id = $1
             AND instalment_number > 1
             AND status = 'pending'`,
          [payment.subscription_id]
        );

        for (const instalment of scheduleResult.rows) {
          const dueDate = addMonthsClamped(
            firstPaidDate,
            Number(instalment.instalment_number) - 1
          );

          await client.query(
            `UPDATE payments
             SET due_date = $1
             WHERE id = $2`,
            [dueDate, instalment.id]
          );
        }
      }

      // Recalculate subscription payment progress.
      await client.query(
        `UPDATE subscriptions s
         SET paid_instalments = (
           SELECT COUNT(*)::INTEGER
           FROM payments p
           WHERE p.subscription_id = s.id
             AND p.status = 'paid'
         ),
         status = CASE
           WHEN (
             SELECT COUNT(*)
             FROM payments p
             WHERE p.subscription_id = s.id
               AND p.status = 'paid'
           ) >= s.total_instalments
           THEN 'completed'
           ELSE 'active'
         END
         WHERE s.id = $1`,
        [payment.subscription_id]
      );
    }

    // Track other PaymentIntent status events.
    if (PAYMENT_INTENT_STATUS_EVENTS.includes(event.name)) {
      if (!eventObject) {
        throw new Error("PaymentIntent event data is missing");
      }

      const intent = eventObject;

      if (
        !intent.id ||
        !intent.merchant_order_id ||
        !intent.status ||
        !intent.updated_at ||
        !Number.isFinite(Date.parse(intent.updated_at))
      ) {
        throw new Error("PaymentIntent details are incomplete");
      }

      // Update the matching PaymentIntent history record.
      const historyResult = await client.query(
        `UPDATE airwallex_payment_intents
         SET status = $1,
             airwallex_updated_at = $2,
             updated_at = NOW()
         WHERE payment_id = $3
           AND airwallex_payment_intent_id = $4
           AND status IS DISTINCT FROM 'SUCCEEDED'
           AND (
             airwallex_updated_at IS NULL
             OR airwallex_updated_at < $2::timestamptz
          )
         RETURNING payment_id`,
        [
          intent.status,
          intent.updated_at,
          intent.merchant_order_id,
          intent.id,
        ]
      );

      // Confirm that the PaymentIntent exists in history.
      if (historyResult.rowCount === 0) {
        const existingIntent = await client.query(
          `SELECT payment_id
           FROM airwallex_payment_intents
           WHERE payment_id = $1
             AND airwallex_payment_intent_id = $2`,
          [
            intent.merchant_order_id,
            intent.id,
          ]
        );

        if (existingIntent.rowCount === 0) {
          throw new Error(
            "Matching PaymentIntent was not found. Airwallex should retry this event."
          );
        }
      }

      // Update the payment only when its history record accepted this event.
      if (historyResult.rowCount === 1) {
        await client.query(
          `UPDATE payments
           SET airwallex_payment_intent_status = $1,
               airwallex_payment_intent_updated_at = $2
           WHERE id = $3
             AND airwallex_payment_id = $4
             AND status IS DISTINCT FROM 'paid'
             AND (
               airwallex_payment_intent_updated_at IS NULL
               OR airwallex_payment_intent_updated_at < $2::timestamptz
             )`,
          [
            intent.status,
            intent.updated_at,
            intent.merchant_order_id,
            intent.id,
          ]
        );
      }
    }

    // Handle verified payment consent.
    if (event.name === "payment_consent.verified") {
      if (!eventObject) {
        throw new Error("Payment consent event data is missing");
      }

      const consent = verifiedConsent;

      if (!consent) {
        throw new Error("Verified Airwallex consent was not retrieved");
      }

      // Save the verified consent and card against the correct student.
      const consentResult = await client.query(
        `UPDATE subscriptions s
         SET airwallex_payment_consent_id = $1,
             airwallex_payment_method_id = $4,
             airwallex_payment_method_type = $5,
             payment_consent_status = 'VERIFIED'
         FROM payments p
         JOIN airwallex_payment_intents AS intents
           ON intents.payment_id = p.id
         CROSS JOIN students st
         WHERE st.id = s.student_id
           AND p.subscription_id = s.id
           AND intents.airwallex_payment_intent_id = $2
           AND p.airwallex_payment_id = intents.airwallex_payment_intent_id
           AND p.instalment_number = 1
           AND st.airwallex_customer_id = $3
           AND (
             s.airwallex_payment_consent_id IS NULL
             OR s.airwallex_payment_consent_id = $1
           )
           AND (
             s.airwallex_payment_method_id IS NULL
             OR s.airwallex_payment_method_id = $4
           )
           AND (
             s.airwallex_payment_method_type IS NULL
             OR s.airwallex_payment_method_type = $5
           )
         RETURNING s.id`,
        [
          consent.id,
          consent.initial_payment_intent_id,
          consent.customer_id,
          consent.payment_method.id,
          consent.payment_method.type,
        ]
      );

      if (consentResult.rowCount === 0) {
        throw new Error(
          "Matching subscription for payment consent was not found. Airwallex should retry this event."
        );
      }
    }

    await client.query("COMMIT");

    return res.status(200).json({
      received: true,
      processed: true,
    });

  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Webhook rollback error:", rollbackError.message);
      }
    }

    console.error("Webhook processing error:", error.message);

    return res.status(500).json({
      message: "Could not process webhook",
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;
