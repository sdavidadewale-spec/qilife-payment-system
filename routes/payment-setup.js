const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../db");

const {
  createAirwallexCustomer,
  createAirwallexPaymentIntent,
  retrieveAirwallexPaymentIntent,
} = require("../airwallex");

// Create or retrieve an Airwallex customer
router.post("/customer", async (req, res) => {
  const { student_id } = req.body;

  if (!student_id) {
    return res.status(400).json({
      message: "Student ID is required",
    });
  }

  try {
    // Find the student
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

    // Reuse the existing Airwallex customer
    if (student.airwallex_customer_id) {
      return res.json({
        message: "Airwallex customer already exists",
        airwallex_customer_id: student.airwallex_customer_id,
      });
    }

    // Create the customer in Airwallex
    const customer = await createAirwallexCustomer(student);

    if (!customer.id) {
      throw new Error("Airwallex did not return a customer ID");
    }

    // Save the Airwallex customer ID
    await pool.query(
      `UPDATE students
       SET airwallex_customer_id = $1
       WHERE id = $2`,
      [customer.id, student.id]
    );

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

// Create the first instalment PaymentIntent
router.post("/checkout/:token/payment-intent", async (req, res) => {
  try {
    const { token } = req.params;

    // Hash the checkout token
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    // Find the enrolment and student
    const result = await pool.query(
      `SELECT
          s.id AS subscription_id,
          s.status AS subscription_status,
          st.airwallex_customer_id
       FROM subscriptions s
       JOIN students st ON st.id = s.student_id
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

    // Check enrolment status
    if (subscription.subscription_status !== "pending") {
      return res.status(400).json({
        message: "This enrolment is not available for payment",
      });
    }

    // Check Airwallex customer
    if (!subscription.airwallex_customer_id) {
      return res.status(400).json({
        message: "Airwallex customer is not set up",
      });
    }

    // Get a database connection
    const client = await pool.connect();

    try {
      // Start database transaction
      await client.query("BEGIN");

      // Lock the first instalment
      const paymentResult = await client.query(
        `SELECT
            id,
            amount,
            currency,
            status,
            airwallex_payment_id
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

      const payment = paymentResult.rows[0];

      // Check payment status
      if (payment.status !== "pending") {
        await client.query("ROLLBACK");

        return res.status(400).json({
          message: "First instalment is not available for payment",
        });
      }

      // Reuse the existing PaymentIntent
        if (payment.airwallex_payment_id) {
        const existingIntent = await retrieveAirwallexPaymentIntent(
            payment.airwallex_payment_id
        );

        if (!existingIntent.id || !existingIntent.client_secret) {
            throw new Error("Could not retrieve the existing PaymentIntent");
        }

        await client.query("ROLLBACK");

        return res.json({
            payment_intent_id: existingIntent.id,
            client_secret: existingIntent.client_secret,
            amount: payment.amount,
            currency: payment.currency,
        });
        }

      // Get all instalments for the payment consent
        const scheduleResult = await client.query(
        `SELECT amount
        FROM payments
        WHERE subscription_id = $1
        ORDER BY instalment_number ASC`,
        [subscription.subscription_id]
        );

        const schedule = scheduleResult.rows;

        const maxPaymentAmount = Math.max(
        ...schedule.map(item => Number(item.amount))
        );

        // Get today's date in Singapore time
        const startDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Singapore",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        }).format(new Date());

        // Prepare payment consent
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

        // Create the Airwallex PaymentIntent
        const intent = await createAirwallexPaymentIntent({
        amount: payment.amount,
        currency: payment.currency,
        customerId: subscription.airwallex_customer_id,
        merchantOrderId: payment.id,
        requestId: payment.id,
        paymentConsent,
        });

      // Save the PaymentIntent ID
      await client.query(
        `UPDATE payments
         SET airwallex_payment_id = $1
         WHERE id = $2`,
        [intent.id, payment.id]
      );

      // Finish the transaction
      await client.query("COMMIT");

      return res.json({
        payment_intent_id: intent.id,
        client_secret: intent.client_secret,
        amount: payment.amount,
        currency: payment.currency,
      });

    } catch (error) {
      await client.query("ROLLBACK");
      throw error;

    } finally {
      // Release the database connection
      client.release();
    }

  } catch (error) {
    console.error("First payment setup error:", error.message);

    return res.status(500).json({
      message: "Could not prepare the first payment",
    });
  }
});

module.exports = router;