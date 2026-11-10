const express = require("express");
const router = express.Router();
const pool = require("../db");
const crypto = require("crypto");
const { isValidPaymentSchedule } = require("../utils/payment-schedule");

const CONSENT_VERSION = "qilife-installments-v1";


 // Only allow a valid HTTPS hosted checkout URL.
function getHostedFrontendUrl() {
  const configured = process.env.FRONTEND_URL;

  if (!configured) return null;

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

function buildInstallmentConsentText() {
  return "I authorise QiLife to charge my saved payment card for the course fees shown on this page.";
}

// Get details for a reusable public checkout link
router.get("/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const result = await pool.query(
      `SELECT
          cl.slug,
          c.name AS course_name,
          c.duration_months,
          c.currency,
          pp.student_type,
          pp.plan_type,
          pp.total_amount,
          pp.instalment_count
       FROM checkout_links cl
       JOIN pricing_plans pp ON pp.id = cl.pricing_plan_id
       JOIN courses c ON c.id = pp.course_id
       WHERE cl.slug = $1
         AND cl.is_active = TRUE`,
      [slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Checkout link is invalid or inactive",
      });
    }

    const plan = result.rows[0];

    const schedule = await pool.query(
      `SELECT
          ppi.instalment_number,
          ppi.amount
       FROM pricing_plan_installments ppi
       JOIN checkout_links cl
         ON cl.pricing_plan_id = ppi.pricing_plan_id
       WHERE cl.slug = $1
         AND cl.is_active = TRUE
       ORDER BY ppi.instalment_number`,
      [slug]
    );

    if (schedule.rows.length !== Number(plan.instalment_count)) {
      return res.status(500).json({
        message: "Payment schedule is incomplete",
      });
    }

    const consentText = buildInstallmentConsentText(
      plan,
      schedule.rows
    );

    return res.json({
      plan,
      instalments: schedule.rows,
      consent_version: CONSENT_VERSION,
      consent_text: consentText,
    });
  } catch (error) {
    console.error("Public checkout lookup error:", error.message);

    return res.status(500).json({
      message: "Could not load checkout details",
    });
  }
});

// Create a separate student enrolment from a reusable link
router.post("/:slug/enroll", async (req, res) => {
  const fullName =
    typeof req.body.full_name === "string"
      ? req.body.full_name.trim()
      : "";

  const email =
    typeof req.body.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";

  const phone =
    typeof req.body.phone === "string"
      ? req.body.phone.trim()
      : null;

  if (
    !fullName ||
    !email ||
    fullName.length > 255 ||
    email.length > 255 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    (phone && phone.length > 50)
  ) {
    return res.status(400).json({
      message: "Please provide a valid name and email",
    });
  }

  if (req.body.consent_accepted !== true) {
    return res.status(400).json({
      message: "You must accept the recurring payment terms to continue.",
    });
  }

  if (req.body.consent_version !== CONSENT_VERSION) {
    return res.status(409).json({
      message:
        "The payment terms have changed. Please reload the checkout page and review the updated agreement.",
    });
  }

  const requestId = req.get("Idempotency-Key") || "";

  if (!/^[a-f0-9]{64}$/i.test(requestId)) {
    return res.status(400).json({
      message: "A valid enrolment request ID is required.",
    });
  }

  const enrollmentRequestHash = crypto
    .createHash("sha256")
    .update(requestId.toLowerCase())
    .digest("hex");

  // Do not create or recover an enrolment without a secure hosted URL.
  const hostedFrontendUrl = getHostedFrontendUrl();

  if (!hostedFrontendUrl) {
    return res.status(503).json({
      message:
        "Secure hosted checkout is not configured. Please try again later.",
    });
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    // Serialize requests that use the same enrolment request ID.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [enrollmentRequestHash]
    );

    // Find the active public link and its pricing plan
    const planResult = await client.query(
      `SELECT
          cl.pricing_plan_id,
          pp.total_amount,
          pp.instalment_count,
          pp.plan_type,
          c.name AS course_name,
          c.duration_months,
          c.currency,
          pp.student_type
       FROM checkout_links cl
       JOIN pricing_plans pp ON pp.id = cl.pricing_plan_id
       JOIN courses c ON c.id = pp.course_id
       WHERE cl.slug = $1
         AND cl.is_active = TRUE
       FOR SHARE OF cl`,
      [req.params.slug]
    );

    if (planResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        message: "Checkout link is invalid or inactive",
      });
    }

    const plan = planResult.rows[0];

    if (!["three_part", "six_part"].includes(plan.plan_type)) {
      throw new Error("Unsupported public payment plan");
    }

    // Load and verify the payment schedule
    const scheduleResult = await client.query(
      `SELECT instalment_number, amount
       FROM pricing_plan_installments
       WHERE pricing_plan_id = $1
       ORDER BY instalment_number`,
      [plan.pricing_plan_id]
    );

    const schedule = scheduleResult.rows;

    if (!isValidPaymentSchedule({
      schedule,
      expectedCount: plan.instalment_count,
      expectedTotal: plan.total_amount,
    })) {
      throw new Error("Payment schedule does not match the selected plan");
    }

    // Recover an existing enrolment if this request was already processed.
    const existingEnrollmentResult = await client.query(
      `SELECT
          s.id,
          s.pricing_plan_id,
          s.total_amount,
          s.currency,
          s.total_instalments,
          s.status,
          s.paid_instalments,
          st.email
       FROM subscriptions s
       JOIN students st ON st.id = s.student_id
       WHERE s.enrollment_request_id = $1
       FOR UPDATE OF s`,
      [enrollmentRequestHash]
    );

    if (existingEnrollmentResult.rows.length > 0) {
      const existingEnrollment = existingEnrollmentResult.rows[0];

      const sameStudent =
        existingEnrollment.email.trim().toLowerCase() === email;

      const samePlan =
        existingEnrollment.pricing_plan_id === plan.pricing_plan_id;

      if (!sameStudent || !samePlan) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          message: "This request ID is already linked to different enrolment details.",
        });
      }

      if (
        existingEnrollment.status !== "pending" ||
        Number(existingEnrollment.paid_instalments) !== 0
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          message: "This enrolment is no longer waiting for its first payment.",
        });
      }

      // Refresh the private checkout token without creating another enrolment.
      const checkoutToken = crypto.randomBytes(32).toString("hex");

      const checkoutTokenHash = crypto
        .createHash("sha256")
        .update(checkoutToken)
        .digest("hex");

      await client.query(
        `UPDATE subscriptions
         SET checkout_token_hash = $1,
             checkout_token_expires_at = NOW() + INTERVAL '7 days'
         WHERE id = $2`,
        [checkoutTokenHash, existingEnrollment.id]
      );

      await client.query("COMMIT");
      transactionStarted = false;


      return res.status(200).json({
        message: "Existing enrolment recovered successfully",
        enrollment: {
          id: existingEnrollment.id,
          total_amount: existingEnrollment.total_amount,
          currency: existingEnrollment.currency,
          total_instalments: existingEnrollment.total_instalments,
          status: existingEnrollment.status,
        },
        checkout_url: `${hostedFrontendUrl}/public-checkout.html?plan=${encodeURIComponent(req.params.slug)}&checkout_token=${encodeURIComponent(checkoutToken)}`,
      });
    }

    // Build the exact consent wording from the server-side payment schedule.
    const consentText = buildInstallmentConsentText(plan, schedule);

    // Reuse an existing student or create a new one
    const studentInsert = await client.query(
      `INSERT INTO students (full_name, email, phone)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [fullName, email, phone || null]
    );

    let studentId;

    if (studentInsert.rows.length > 0) {
      studentId = studentInsert.rows[0].id;
    } else {
      const existingStudent = await client.query(
        `SELECT id
         FROM students
         WHERE LOWER(BTRIM(email)) = $1
         FOR UPDATE`,
        [email]
      );

      if (existingStudent.rows.length === 0) {
        throw new Error("Could not find or create the student");
      }

      studentId = existingStudent.rows[0].id;
    }

    // Create a private checkout token for this student
    const checkoutToken = crypto.randomBytes(32).toString("hex");

    const checkoutTokenHash = crypto
      .createHash("sha256")
      .update(checkoutToken)
      .digest("hex");

    // Record the student's accepted consent with the enrolment
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
          checkout_token_expires_at,
          payment_consent_text,
          payment_consent_version,
          payment_consent_accepted_at,
          payment_consent_ip,
          payment_consent_user_agent,
          enrollment_request_id
       )
       VALUES (
          $1, $2, $3, $4, $5, 0, 'pending', $6,
          NOW() + INTERVAL '7 days',
          $7, $8, NOW(), $9, $10, $11
       )
       RETURNING id, total_amount, currency, total_instalments, status`,
      [
        studentId,
        plan.pricing_plan_id,
        plan.total_amount,
        plan.currency,
        plan.instalment_count,
        checkoutTokenHash,
        consentText,
        CONSENT_VERSION,
        req.ip || null,
        req.get("user-agent") || null,
        enrollmentRequestHash,
      ]
    );

    const enrollment = enrollmentResult.rows[0];

    // Create the full payment schedule
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
       RETURNING id, instalment_number, amount, currency, status`,
      [
        enrollment.id,
        plan.currency,
        plan.pricing_plan_id,
      ]
    );

    if (paymentResult.rows.length !== Number(plan.instalment_count)) {
      throw new Error("Payment schedule does not match the selected plan");
    }

    await client.query("COMMIT");
    transactionStarted = false;


    return res.status(201).json({
      message: "Enrolment created successfully",
      enrollment,
      checkout_url: `${hostedFrontendUrl}/public-checkout.html?plan=${encodeURIComponent(req.params.slug)}&checkout_token=${encodeURIComponent(checkoutToken)}`,
    });
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Public enrolment error:", error.message);

    return res.status(500).json({
      message: "Could not create enrolment",
    });
  } finally {
    client.release();
  }
});

module.exports = router;
