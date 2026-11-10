const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canRecordSuccessfulPayment,
} = require("../utils/payment-success-rules");

test("pending, processing and paid payments accept success", () => {
  for (const paymentStatus of ["pending", "processing", "paid"]) {
    assert.equal(
      canRecordSuccessfulPayment({ paymentStatus }),
      true
    );
  }
});

test("current successful intent can complete a payment under manual review", () => {
  assert.equal(
    canRecordSuccessfulPayment({
      paymentStatus: "review_required",
      manualReviewRequired: true,
      currentPaymentIntentId: "pi_current",
      successfulPaymentIntentId: "pi_current",
    }),
    true
  );
});

test("review-required payment is rejected when manual review is not active", () => {
  assert.equal(
    canRecordSuccessfulPayment({
      paymentStatus: "review_required",
      manualReviewRequired: false,
      currentPaymentIntentId: "pi_current",
      successfulPaymentIntentId: "pi_current",
    }),
    false
  );
});

test("older successful intent cannot pass the review exception", () => {
  assert.equal(
    canRecordSuccessfulPayment({
      paymentStatus: "review_required",
      manualReviewRequired: true,
      currentPaymentIntentId: "pi_current",
      successfulPaymentIntentId: "pi_old",
    }),
    false
  );
});

test("missing current intent cannot pass the review exception", () => {
  assert.equal(
    canRecordSuccessfulPayment({
      paymentStatus: "review_required",
      manualReviewRequired: true,
      currentPaymentIntentId: null,
      successfulPaymentIntentId: "pi_current",
    }),
    false
  );
});

test("unrecognised payment states are rejected", () => {
  assert.equal(
    canRecordSuccessfulPayment({
      paymentStatus: "failed",
      manualReviewRequired: true,
      currentPaymentIntentId: "pi_current",
      successfulPaymentIntentId: "pi_current",
    }),
    false
  );
});
