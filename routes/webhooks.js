const express = require("express");
const router = express.Router();
const pool = require("../db");
const verifyWebhookSignature = require("../webhook-signature");

// Receive Airwallex webhook notifications
router.post("/", async (req, res) => {
  try {
    // Verify that the notification came from Airwallex
    if (!verifyWebhookSignature(req)) {
      return res.status(400).json({
        message: "Invalid webhook signature",
      });
    }

    const event = req.body;

    if (!event.id || !event.name) {
      return res.status(400).json({
        message: "Webhook event details are missing",
      });
    }

    // Save the event only once
    await pool.query(
      `INSERT INTO webhook_events (event_id, event_type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.id,
        event.name,
        JSON.stringify(event),
      ]
    );

    return res.status(200).json({
      received: true,
    });

  } catch (error) {
    console.error("Webhook error:", error.message);

    return res.status(500).json({
      message: "Could not process webhook",
    });
  }
});

module.exports = router;