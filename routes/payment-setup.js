const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../db");
const { isValidPaymentSchedule } = require("../utils/payment-schedule");

const {
  createAirwallexCustomer,
  createAirwallexPaymentIntent,
  retrieveAirwallexPaymentIntent,
} = require("../airwallex");

// Only allow a valid HTTPS hosted checkout URL.
function getHostedFrontendUrl() {
  const configured = process.env.FRONTEND_URL;

  if (!configured) {
    return null;
  }

  try {
    const parsed = new URL(configured);

    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

// Create or retrieve an Airwallex customer
router.post("/customer", async (req, res) => {
  if (!getHostedFrontendUrl()) {
    return res.status(503).json({
      message:
        "Secure hosted checkout is not configured. Payment setup is unavailable.",
    });
  }

  const { student_id } = req.body;

  if (!student_id) {
    return res.status(400).json({
      message: "Student ID is required",
    });
  }

  try {
    const studentResult = await pool.query(
      `SELECT id, full_name, email, phone, airwallex_customer_id
       FROM students
       WHERE id = $1`,
      [student_id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({
        message: "Student not found",
      });
    }

    const student = studentResult.rows[0];

    if (student.airwallex_customer_id) {
      return res.json({
        message: "Airwallex customer already exists",
        airwallex_customer_id: student.airwallex_customer_id,
      });
    }

    const customer = await createAirwallexCustomer(student);

    if (!customer.id) {
      throw new Error("Airwallex did not return a customer ID");
    }

    const savedCustomer = await pool.query(
      `UPDATE students
       SET airwallex_customer_id = $1
       WHERE id = $2
         AND (
           airwallex_customer_id IS NULL
           OR airwallex_customer_id = $1
         )
       RETURNING airwallex_customer_id`,
      [customer.id, student.id]
    );

    if (savedCustomer.rowCount !== 1) {
      throw new Error(
        "Airwallex customer ID could not be saved safely"
      );
    }

    return res.status(201).json({
      message: "Airwallex customer created successfully",
      airwallex_customer_id: customer.id,
    });
  } catch (error) {
    console.error("Payment setup error:", error.message);

    return res.status(500).json({
      message: "Could not set up Airwallex customer",
    });
  }
});

// Create or recover the first instalment PaymentIntent
router.post("/checkout/:token/payment-intent", async (req, res) => {
  // Stop before database or Airwallex calls if hosting is not configured.
  const hostedFrontendUrl = getHostedFrontendUrl();

  if (!hostedFrontendUrl) {
    return res.status(503).json({
      message:
        "Secure hosted checkout is not configured. Payment setup is unavailable.",
    });
  }

  let payment;

  try {
    const { token } = req.params;

    // Hash the checkout token.
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    // Find the enrolment, student, and active public checkout link.
    const result = await pool.query(
      `SELECT
        s.id AS subscription_id,
        s.status AS subscription_status,
        s.total_amount,
        s.total_instalments,
        st.id AS student_id,
        st.full_name,
        st.email,
        st.phone,
        st.airwallex_customer_id,
        cl.slug AS checkout_slug
      FROM subscriptions s
      JOIN students st
        ON st.id = s.student_id
      JOIN checkout_links cl
        ON cl.pricing_plan_id = s.pricing_plan_id
       AND cl.is_active = TRUE
      WHERE s.checkout_token_hash = $1
        AND s.checkout_token_expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Checkout link is invalid or has expired",
      });
    }

    const subscription = result.rows[0];

    if (subscription.subscription_status !== "pending") {
      return res.status(400).json({
        message: "This enrolment is not available for payment",
      });
    }

    // Build the URL Airwallex will use after customer authentication.
    const returnUrl = new URL(
      "/public-checkout.html",
      hostedFrontendUrl
    );

    returnUrl.searchParams.set("plan", subscription.checkout_slug);
    returnUrl.searchParams.set("checkout_token", token);

    let airwallexCustomerId =
      subscription.airwallex_customer_id;

    let schedule;
    let startDate;

    // Prepare the payment using a short database transaction.
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const paymentResult = await client.query(
        `SELECT
          id,
          amount,
          currency,
          status,
          airwallex_payment_id,
          payment_consent_start_date,
          processing_started_at,
          (
            processing_started_at <= NOW() - INTERVAL '5 minutes'
          ) AS processing_is_stale
         FROM payments
         WHERE subscription_id = $1
           AND instalment_number = 1
         FOR UPDATE`,
        [subscription.subscription_id]
      );

      if (paymentResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          message: "First instalment was not found",
        });
      }

      payment = paymentResult.rows[0];

      // Only pending payments or safely recoverable processing
      // payments can continue.
      if (
        payment.status !== "pending" &&
        payment.status !== "processing"
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          message: "First instalment is not available for payment",
        });
      }

      // Prevent two requests from working on the same payment
      // at the same time.
      if (
        payment.status === "processing" &&
        !payment.airwallex_payment_id &&
        payment.processing_is_stale !== true
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          message:
            "Payment setup is already in progress. Please try again shortly.",
        });
      }

      // Load the complete instalment schedule.
      const scheduleResult = await client.query(
        `SELECT instalment_number, amount
         FROM payments
         WHERE subscription_id = $1
         ORDER BY instalment_number ASC`,
        [subscription.subscription_id]
      );

      schedule = scheduleResult.rows;

      if (!isValidPaymentSchedule({
        schedule,
        expectedCount: subscription.total_instalments,
        expectedTotal: subscription.total_amount,
      })) {
        throw new Error("Payment schedule does not match the subscription");
      }

      // Get today's date in Singapore time.
      const dateParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Singapore",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());

      const todayInSingapore = [
        dateParts.find(part => part.type === "year").value,
        dateParts.find(part => part.type === "month").value,
        dateParts.find(part => part.type === "day").value,
      ].join("-");

      // Keep the original consent date when recovering a request.
      startDate = payment.payment_consent_start_date
        ? String(payment.payment_consent_start_date).slice(0, 10)
        : todayInSingapore;

      // Claim the payment before contacting Airwallex.
      await client.query(
        `UPDATE payments
         SET status = 'processing',
             processing_started_at = NOW(),
             payment_consent_start_date =
               COALESCE(payment_consent_start_date, $2),
             last_error = NULL
         WHERE id = $1`,
        [payment.id, startDate]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // Create or retrieve the Airwallex customer only after
    // the saved payment schedule has passed validation.
    if (!airwallexCustomerId) {
      const customer = await createAirwallexCustomer({
        id: subscription.student_id,
        full_name: subscription.full_name,
        email: subscription.email,
        phone: subscription.phone,
      });

      if (!customer?.id) {
        throw new Error(
          "Airwallex did not return a customer ID"
        );
      }

      const savedCustomer = await pool.query(
        `UPDATE students
         SET airwallex_customer_id = $1
         WHERE id = $2
           AND (
             airwallex_customer_id IS NULL
             OR airwallex_customer_id = $1
           )
         RETURNING airwallex_customer_id`,
        [customer.id, subscription.student_id]
      );

      if (savedCustomer.rowCount !== 1) {
        throw new Error(
          "Airwallex customer ID could not be saved safely"
        );
      }

      airwallexCustomerId =
        savedCustomer.rows[0].airwallex_customer_id;
    }

    // Airwallex requests happen after the transaction is closed.
    const maxPaymentAmount = Math.max(
      ...schedule.map(item => Number(item.amount))
    );

    // Prepare the recurring payment consent.
    const paymentConsent = {
      next_triggered_by: "merchant",
      merchant_trigger_reason: "installments",
      terms_of_use: {
        payment_amount_type: "VARIABLE",
        payment_currency: payment.currency,
        start_date: startDate,
        first_payment_amount: Number(payment.amount),
        max_payment_amount: maxPaymentAmount,
        total_billing_cycles: schedule.length,
      },
    };

    let intent;

    if (payment.airwallex_payment_id) {
      // Recover the existing PaymentIntent.
      intent = await retrieveAirwallexPaymentIntent(
        payment.airwallex_payment_id
      );
    } else {
      // Use the payment UUID as the stable request ID.
      // Retries must use the same request ID and request details.
      intent = await createAirwallexPaymentIntent({
        amount: payment.amount,
        currency: payment.currency,
        customerId: airwallexCustomerId,
        merchantOrderId: payment.id,
        requestId: payment.id,
        paymentConsent,
        returnUrl: returnUrl.toString(),
      });
    }

    if (!intent.id) {
      throw new Error(
        "Airwallex did not return a PaymentIntent ID"
      );
    }

    // Save the PaymentIntent in both payment records.
    const saveClient = await pool.connect();

    try {
      await saveClient.query("BEGIN");

      const saveResult = await saveClient.query(
        `UPDATE payments
         SET airwallex_payment_id = $1,
             last_error = NULL
         WHERE id = $2
           AND (
             airwallex_payment_id IS NULL
             OR airwallex_payment_id = $1
           )
         RETURNING id`,
        [intent.id, payment.id]
      );

      if (saveResult.rowCount !== 1) {
        throw new Error(
          "PaymentIntent ID could not be saved safely"
        );
      }

      await saveClient.query(
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
          payment.id,
          intent.status || "CREATED",
          intent.updated_at || null,
        ]
      );

      const historyCheck = await saveClient.query(
        `SELECT id
         FROM airwallex_payment_intents
         WHERE payment_id = $1
           AND airwallex_payment_intent_id = $2`,
        [payment.id, intent.id]
      );

      if (historyCheck.rowCount !== 1) {
        throw new Error(
          "PaymentIntent history could not be saved safely"
        );
      }

      await saveClient.query("COMMIT");
    } catch (saveError) {
      await saveClient.query("ROLLBACK");
      throw saveError;
    } finally {
      saveClient.release();
    }

    // A completed payment must be handled by the webhook.
    if (intent.status === "SUCCEEDED") {
      return res.status(409).json({
        message:
          "This payment has already completed. Please refresh.",
      });
    }

    if (!intent.client_secret) {
      throw new Error(
        "PaymentIntent client secret is missing"
      );
    }

    return res.json({
      payment_intent_id: intent.id,
      payment_intent_status: intent.status,
      client_secret: intent.client_secret,
      amount: payment.amount,
      currency: payment.currency,
      customer_id: airwallexCustomerId,
      payment_consent: paymentConsent,
    });
  } catch (error) {
    console.error(
      "First payment setup error:",
      error.message
    );

    // Keep the payment in processing if its result is uncertain.
    // Save the error for recovery and investigation.
    if (payment?.id) {
      try {
        await pool.query(
          `UPDATE payments
           SET last_error = $1
           WHERE id = $2
             AND status = 'processing'`,
          [
            String(error.message).slice(0, 1000),
            payment.id,
          ]
        );
      } catch (saveError) {
        console.error(
          "Could not save payment setup error:",
          saveError.message
        );
      }
    }

    return res.status(500).json({
      message: "Could not prepare the first payment",
    });
  }
});

module.exports = router;
