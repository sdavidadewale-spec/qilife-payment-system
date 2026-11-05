
const express = require("express");
const router = express.Router();
const pool = require("../db");
const crypto = require("crypto");

// Create a new student enrolment
router.post("/", async (req, res) => {
  const { student_id, pricing_plan_id } = req.body;

  if (!student_id || !pricing_plan_id) {
    return res.status(400).json({
      message: "Student ID and pricing plan ID are required",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check that the student exists
    const studentResult = await client.query(
      "SELECT id FROM students WHERE id = $1",
      [student_id]
    );

    if (studentResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        message: "Student not found",
      });
    }

    // Get the selected pricing plan
    const planResult = await client.query(
      `SELECT
          pp.id,
          pp.total_amount,
          c.currency,
          pp.instalment_count
       FROM pricing_plans pp
       JOIN courses c ON c.id = pp.course_id
       WHERE pp.id = $1`,
      [pricing_plan_id]
    );

    if (planResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        message: "Pricing plan not found",
      });
    }

    const plan = planResult.rows[0];

    // Generate a secure checkout token
    const checkoutToken = crypto.randomBytes(32).toString("hex");

    const checkoutTokenHash = crypto
      .createHash("sha256")
      .update(checkoutToken)
      .digest("hex");

    // Create the enrolment
    const enrollmentResult = await client.query(
      `INSERT INTO subscriptions (
          student_id,
          pricing_plan_id,
          total_amount,
          currency,
          total_instalments,
          paid_instalments,
          status,
          checkout_token_hash,
          checkout_token_expires_at
       )
       VALUES ($1, $2, $3, $4, $5, 0, 'pending', $6, NOW() + INTERVAL '7 days')
       RETURNING
          id,
          student_id,
          pricing_plan_id,
          total_amount,
          currency,
          total_instalments,
          paid_instalments,
          status,
          created_at`,
      [
        student_id,
        pricing_plan_id,
        plan.total_amount,
        plan.currency,
        plan.instalment_count,
        checkoutTokenHash,
      ]
    );

    const enrollment = enrollmentResult.rows[0];

    // Create all pending instalment records
    const paymentResult = await client.query(
      `INSERT INTO payments (
          subscription_id,
          instalment_number,
          amount,
          currency,
          status
       )
       SELECT
          $1,
          instalment_number,
          amount,
          $2,
          'pending'
       FROM pricing_plan_installments
       WHERE pricing_plan_id = $3
       ORDER BY instalment_number
       RETURNING *`,
      [
        enrollment.id,
        plan.currency,
        pricing_plan_id,
      ]
    );

    // Confirm that all expected instalments were created
    if (paymentResult.rows.length !== plan.instalment_count) {
      throw new Error("Instalment records do not match the selected plan");
    }

    await client.query("COMMIT");

    const checkoutUrl = `${
      process.env.FRONTEND_URL || "http://localhost:5000"
    }/checkout/${checkoutToken}`;

    res.status(201).json({
      message: "Student enrolled successfully",
      enrollment,
      payments: paymentResult.rows,
      checkout_url: checkoutUrl,
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Enrolment error:", error.message);

    res.status(500).json({
      message: "Could not create student enrolment",
    });

  } finally {
    client.release();
  }
});

// Get checkout details using the secure token
router.get("/checkout/:token", async (req, res) => {
  try {
    const { token } = req.params;

    // Hash the token before searching the database
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    // Find the enrolment and its details
    const enrollmentResult = await pool.query(
      `SELECT
          s.id AS enrollment_id,
          s.total_amount,
          s.currency,
          s.total_instalments,
          s.paid_instalments,
          s.status,
          st.full_name,
          st.email,
          c.name AS course_name,
          c.duration_months,
          s.checkout_token_expires_at
       FROM subscriptions s
       JOIN students st ON st.id = s.student_id
       JOIN pricing_plans pp ON pp.id = s.pricing_plan_id
       JOIN courses c ON c.id = pp.course_id
       WHERE s.checkout_token_hash = $1
         AND s.checkout_token_expires_at > NOW()`,
      [tokenHash]
    );

    if (enrollmentResult.rows.length === 0) {
      return res.status(404).json({
        message: "Checkout link is invalid or has expired",
      });
    }

    const enrollment = enrollmentResult.rows[0];

    // Get all instalments for this enrolment
    const paymentsResult = await pool.query(
      `SELECT
          instalment_number,
          amount,
          currency,
          status,
          due_date,
          paid_at
       FROM payments
       WHERE subscription_id = $1
       ORDER BY instalment_number ASC`,
      [enrollment.enrollment_id]
    );

    const payments = paymentsResult.rows;

    // Check that the payment schedule is complete
    if (
      payments.length === 0 ||
      payments.length !== Number(enrollment.total_instalments)
    ) {
      return res.status(500).json({
        message: "Payment schedule is incomplete",
      });
    }

    // Get the first instalment
    const firstPayment = payments.find(
      payment => Number(payment.instalment_number) === 1
    );

    if (!firstPayment) {
      return res.status(500).json({
        message: "First instalment was not found",
      });
    }

    // Find the highest instalment amount
    const maxPaymentAmount = Math.max(
      ...payments.map(payment => Number(payment.amount))
    );

    // Prepare payment consent details
    // Get today's date in Singapore time
    const startDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    }).format(new Date());

    // Prepare payment consent details
    const paymentConsent = {
    next_triggered_by: "merchant",
    merchant_trigger_reason: "installments",
    terms_of_use: {
        payment_amount_type: "VARIABLE",
        payment_currency: enrollment.currency,
        start_date: startDate,
        first_payment_amount: Number(firstPayment.amount),
        max_payment_amount: maxPaymentAmount,
        total_billing_cycles: payments.length,
    },
    };

    return res.json({
      enrollment,
      payments,
      payment_consent: paymentConsent,
    });

  } catch (error) {
    console.error("Checkout details error:", error.message);

    return res.status(500).json({
      message: "Could not retrieve checkout details",
    });
  }
});

module.exports = router;
