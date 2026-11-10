require("dotenv").config();

const express = require("express");
const path = require("path");
const verifyWebhookSignature = require("./webhook-signature");


const app = express();
// Serve the custom checkout page
app.use(express.static(path.join(__dirname, "public")));

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;

      if (req.originalUrl.split("?")[0].replace(/\/+$/, "") === "/api/webhooks") {
        const testSecret = req.headers["client-secret-key"];
        const isTestEvent =
          typeof testSecret === "string" && testSecret.length > 0;

        req.isAirwallexTestEvent = isTestEvent;
        req.webhookSignatureValid = verifyWebhookSignature(
          {
            headers: req.headers,
            rawBody: buf,
          },
          isTestEvent ? testSecret : undefined
        );
      }
    },
  })
);

const studentRoutes = require("./routes/students");
const courseRoutes = require("./routes/courses");
const pricingRoutes = require("./routes/pricing");
const enrollmentRoutes = require("./routes/enrollments");
const paymentSetupRoutes = require("./routes/payment-setup");
const webhookRoutes = require("./routes/webhooks");
const publicCheckoutRoutes = require("./routes/public-checkout");

app.use("/api/students", studentRoutes);
app.use("/api/courses", courseRoutes);
app.use("/api/pricing", pricingRoutes);
app.use("/api/enrollments", enrollmentRoutes);
app.use("/api/payment-setup", paymentSetupRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/public-checkout", publicCheckoutRoutes);

app.get("/", (req, res) => {
  res.json({
    message: "QiLife Payment Backend is running",
  });
});

const PORT = process.env.PORT || 5000;
// Open the checkout page using its secure token
app.get("/checkout/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "checkout.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});