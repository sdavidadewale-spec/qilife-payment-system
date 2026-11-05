const express = require("express");
const router = express.Router();
const pool = require("../db");

// Register a new student
router.post("/", async (req, res) => {
  try {
    const { full_name, email, phone } = req.body;

    if (!full_name || !email) {
      return res.status(400).json({
        message: "Student name and email are required",
      });
    }

    const result = await pool.query(
      `INSERT INTO students (full_name, email, phone)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [full_name, email, phone || null]
    );

    res.status(201).json({
      message: "Student registered successfully",
      student: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        message: "A student with this email already exists",
      });
    }

    console.error("Student registration error:", error.message);

    res.status(500).json({
      message: "Could not register student",
    });
  }
});

// Get all students
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM students ORDER BY created_at DESC"
    );

    res.json({
      students: result.rows,
    });
  } catch (error) {
    console.error("Get students error:", error.message);

    res.status(500).json({
      message: "Could not retrieve students",
    });
  }
});

module.exports = router;