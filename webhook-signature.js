const crypto = require("crypto");

function verifyWebhookSignature(req, secretOverride) {
  const secret =
    secretOverride !== undefined
      ? secretOverride
      : process.env.AIRWALLEX_WEBHOOK_SECRET;

  const timestamp = req.headers["x-timestamp"];
  const signature = req.headers["x-signature"];

  if (
    typeof secret !== "string" ||
    !secret ||
    !timestamp ||
    !signature ||
    !req.rawBody
  ) {
    return false;
  }

  if (
    !/^\d+$/.test(timestamp) ||
    !/^[a-fA-F0-9]{64}$/.test(signature)
  ) {
    return false;
  }

  const receivedTime = Number(timestamp);

  if (!Number.isFinite(receivedTime)) {
    return false;
  }

  if (Math.abs(Date.now() - receivedTime) > 5 * 60 * 1000) {
    return false;
  }

  const valueToDigest = timestamp + req.rawBody.toString("utf8");

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(valueToDigest)
    .digest("hex");

  const receivedBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

module.exports = verifyWebhookSignature;
