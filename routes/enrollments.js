const express = require("express");
const router = express.Router();
const pool = require("../db");
const crypto = require("crypto");

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
