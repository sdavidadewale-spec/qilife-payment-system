const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateFirstPaymentIntent,
} = require("../utils/first-payment-intent-validation");

const payment = {
  id: "payment-test-123",
  amount: "2100.00",
  currency: "SGD",
};

const validIntent = {
  id: "intent-test-123",
  status: "REQUIRES_PAYMENT_METHOD",
  merchant_order_id: payment.id,
  amount: 2100,
  currency: "SGD",
  updated_at: "2026-11-10T10:00:00Z",
};

test("accepts a matching first-payment intent", () => {
  assert.equal(
    validateFirstPaymentIntent(validIntent, payment),
    true
  );
});

test("accepts a matching expected intent ID", () => {
  assert.equal(
    validateFirstPaymentIntent(
      validIntent,
      payment,
      validIntent.id
    ),
    true
  );
});

test("rejects an incomplete PaymentIntent", () => {
  assert.throws(
    () => validateFirstPaymentIntent(null, payment),
    /incomplete PaymentIntent/
  );
});

test("rejects a different expected intent ID", () => {
  assert.throws(
    () => validateFirstPaymentIntent(
      validIntent,
      payment,
      "another-intent"
    ),
    /does not match the requested ID/
  );
});

test("rejects a different merchant order ID", () => {
  assert.throws(
    () => validateFirstPaymentIntent(
      { ...validIntent, merchant_order_id: "another-payment" },
      payment
    ),
    /merchant order ID/
  );
});

test("rejects a different amount", () => {
  assert.throws(
    () => validateFirstPaymentIntent(
      { ...validIntent, amount: 2101 },
      payment
    ),
    /amount does not match/
  );
});

test("rejects an invalid amount", () => {
  assert.throws(
    () => validateFirstPaymentIntent(
      { ...validIntent, amount: "invalid" },
      payment
    ),
    /amount does not match/
  );
});

test("rejects a different currency", () => {
  assert.throws(
    () => validateFirstPaymentIntent(
      { ...validIntent, currency: "USD" },
      payment
    ),
    /currency does not match/
  );
});

test("rejects an invalid timestamp", () => {
  assert.throws(
    () => validateFirstPaymentIntent(
      { ...validIntent, updated_at: "not-a-date" },
      payment
    ),
    /invalid PaymentIntent timestamp/
  );
});

test("allows a missing timestamp, matching the recurring worker rule", () => {
  const intent = { ...validIntent };
  delete intent.updated_at;

  assert.equal(
    validateFirstPaymentIntent(intent, payment),
    true
  );
});
