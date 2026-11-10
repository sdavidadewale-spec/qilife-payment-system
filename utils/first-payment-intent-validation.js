function validateFirstPaymentIntent(
  intent,
  payment,
  expectedIntentId = null
) {
  if (!intent || !intent.id || !intent.status) {
    throw new Error(
      "Airwallex returned incomplete PaymentIntent details"
    );
  }

  if (expectedIntentId && intent.id !== expectedIntentId) {
    throw new Error(
      "Retrieved PaymentIntent ID does not match the requested ID"
    );
  }

  if (intent.merchant_order_id !== payment.id) {
    throw new Error(
      "PaymentIntent merchant order ID does not match the payment"
    );
  }

  const intentAmount = Number(intent.amount);
  const paymentAmount = Number(payment.amount);

  if (
    intent.amount === undefined ||
    !Number.isFinite(intentAmount) ||
    !Number.isFinite(paymentAmount) ||
    intentAmount.toFixed(2) !== paymentAmount.toFixed(2)
  ) {
    throw new Error(
      "PaymentIntent amount does not match the payment"
    );
  }

  if (
    !intent.currency ||
    String(intent.currency).toUpperCase() !==
      String(payment.currency).toUpperCase()
  ) {
    throw new Error(
      "PaymentIntent currency does not match the payment"
    );
  }

  if (intent.updated_at) {
    const timestamp = new Date(intent.updated_at);

    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error(
        "Airwallex returned an invalid PaymentIntent timestamp"
      );
    }
  }

  return true;
}

module.exports = { validateFirstPaymentIntent };
