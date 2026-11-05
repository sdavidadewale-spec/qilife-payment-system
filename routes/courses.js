const express = require("express");
const router = express.Router();
const pool = require("../db");

// Get all courses
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, duration_months, base_fee, currency
       FROM courses
       ORDER BY duration_months ASC`
    );

    res.json({
      courses: result.rows,
    });
  } catch (error) {
    console.error("Get courses error:", error.message);

    res.status(500).json({
      message: "Could not retrieve courses",
    });
  }
});

module.exports = router;