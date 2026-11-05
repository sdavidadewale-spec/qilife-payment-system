const express = require("express");
const router = express.Router();
const pool = require("../db");

// Get pricing for a selected course and payment option
router.get("/", async (req, res) => {
  try {
    const { course_id, student_type, plan_type } = req.query;

    if (!course_id || !student_type || !plan_type) {
      return res.status(400).json({
        message: "Course, student type, and payment option are required",
      });
    }

    if (!["local", "international"].includes(student_type)) {
      return res.status(400).json({
        message: "Invalid student type",
      });
    }

    if (!["full", "three_part", "six_part"].includes(plan_type)) {
      return res.status(400).json({
        message: "Invalid payment option",
      });
    }

    const planResult = await pool.query(
      `SELECT
          pp.id AS pricing_plan_id,
          c.id AS course_id,
          c.name AS course_name,
          c.duration_months,
          c.base_fee,
          c.currency,
          pp.student_type,
          pp.plan_type,
          pp.admin_fee_rate,
          pp.gst_rate,
          pp.total_amount,
          pp.instalment_count
       FROM pricing_plans pp
       JOIN courses c ON c.id = pp.course_id
       WHERE pp.course_id = $1
         AND pp.student_type = $2
         AND pp.plan_type = $3`,
      [course_id, student_type, plan_type]
    );

    if (planResult.rows.length === 0) {
      return res.status(404).json({
        message: "Pricing plan not found",
      });
    }

    const plan = planResult.rows[0];

    const instalmentResult = await pool.query(
      `SELECT instalment_number, amount
       FROM pricing_plan_installments
       WHERE pricing_plan_id = $1
       ORDER BY instalment_number ASC`,
      [plan.pricing_plan_id]
    );

    res.json({
      pricing: plan,
      instalments: instalmentResult.rows,
    });

  } catch (error) {
    console.error("Get pricing error:", error.message);

    res.status(500).json({
      message: "Could not retrieve pricing",
    });
  }
});

module.exports = router;