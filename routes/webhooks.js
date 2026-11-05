const express = require("express");
const router = express.Router();
const pool = require("../db");
const verifyWebhookSignature = require("../webhook-signature");
const { addMonthsClamped } = require("../utils/payment-dates");

// Receive Airwallex webhook notifications
router.post("/", async (req, res) => {
  if (!verifyWebhookSignature(req)) {
    return res.status(400).json({
      message: "Invalid webhook signature",
    });
  }

  const event = req.body;
  const eventObject = event.data?.object;

  if (!event.id || !event.name) {
    return res.status(400).json({
      message: "Webhook event details are missing",
    });
  }

  let client;

  try {
    client = await pool.connect();

    await client.query("BEGIN");

    // Save each event only once
    const eventResult = await client.query(
      `INSERT INTO webhook_events (event_id, event_type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        event.id,
        event.name,
        JSON.stringify(event),
      ]
    );

    // Stop if this event was already processed
    if (eventResult.rowCount === 0) {
      await client.query("COMMIT");

      return res.status(200).json({
        received: true,
        duplicate: true,
      });
    }

    // Handle successful payments
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
        !intent.currency
      ) {
        throw new Error("Successful payment details are incomplete");
      }

      // Find and lock the matching instalment
      const paymentResult = await client.query(
        `SELECT
            p.id,
            p.subscription_id,
            p.amount,
            p.currency,
            p.status,
            s.total_instalments
         FROM payments p
         JOIN subscriptions s ON s.id = p.subscription_id
         WHERE p.id = $1
           AND p.airwallex_payment_id = $2
         FOR UPDATE OF p, s`,
        [
          intent.merchant_order_id,
          intent.id,
        ]
      );

      if (paymentResult.rows.length === 0) {
        throw new Error(
          "Matching payment was not found. Airwallex should retry this event."
        );
      }

      const payment = paymentResult.rows[0];

      // Check the amount and currency before updating
      if (
        Number(payment.amount).toFixed(2) !==
          Number(intent.amount).toFixed(2) ||
        payment.currency !== intent.currency
      ) {
        throw new Error("Payment amount or currency does not match");
      }

      // Update only a pending payment
      if (payment.status === "pending") {
        await client.query(
          `UPDATE payments
           SET status = 'paid',
               paid_at = COALESCE(paid_at, NOW())
           WHERE id = $1
             AND status = 'pending'`,
          [payment.id]
        );
      } else if (payment.status !== "paid") {
        throw new Error("Payment is not in a valid state");
      }

      // Save the consent ID if the successful payment includes it
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

      // Get the first payment date in Singapore time
      const paidDateResult = await client.query(
        `SELECT
           to_char(
             (paid_at AT TIME ZONE current_setting('TIMEZONE'))
             AT TIME ZONE 'Asia/Singapore',
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

      // Set monthly due dates after the first payment succeeds
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

      // Recalculate the subscription payment progress
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

    // Handle verified payment consent
    if (event.name === "payment_consent.verified") {
      if (!eventObject) {
        throw new Error("Payment consent event data is missing");
      }

      const consent = eventObject;

      if (
        !consent.id ||
        !consent.initial_payment_intent_id ||
        consent.status !== "VERIFIED"
      ) {
        throw new Error("Verified payment consent details are incomplete");
      }

      // Save the consent against the correct subscription
      const consentResult = await client.query(
        `UPDATE subscriptions s
         SET airwallex_payment_consent_id = $1,
             payment_consent_status = 'VERIFIED'
         FROM payments p
         WHERE p.subscription_id = s.id
           AND p.airwallex_payment_id = $2
           AND p.instalment_number = 1
           AND (
             s.airwallex_payment_consent_id IS NULL
             OR s.airwallex_payment_consent_id = $1
           )
         RETURNING s.id`,
        [
          consent.id,
          consent.initial_payment_intent_id,
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