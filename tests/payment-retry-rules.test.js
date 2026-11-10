const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getNextRetryAttemptNumber,
  isRetryablePaymentFailure,
  hasVerifiedRecurringConsent,
} = require("../utils/payment-retry-rules");

test("first failed attempt allows retry attempt two", () => {
  assert.equal(getNextRetryAttemptNumber(1), 2);
});

test("second failed attempt allows retry attempt three", () => {
  assert.equal(getNextRetryAttemptNumber(2), 3);
});

test("third failed attempt does not allow another retry", () => {
  assert.equal(getNextRetryAttemptNumber(3), null);
});

test("invalid failed attempt counts do not allow a retry", () => {
  for (const count of [0, -1, 1.5, "invalid", null, undefined]) {
    assert.equal(getNextRetryAttemptNumber(count), null);
  }
});

test("approved merchant advice and issuer codes allow retry", () => {
  for (const issuerResponseCode of ["51", "79", "82", "83"]) {
    assert.equal(
      isRetryablePaymentFailure({
        merchantAdviceCode: "02",
        issuerResponseCode,
      }),
      true
    );
  }
});

test("retry rules allow surrounding whitespace in response codes", () => {
  assert.equal(
    isRetryablePaymentFailure({
      merchantAdviceCode: " 02 ",
      issuerResponseCode: " 51 ",
    }),
    true
  );
});

test("unapproved merchant advice code blocks retry", () => {
  assert.equal(
    isRetryablePaymentFailure({
      merchantAdviceCode: "01",
      issuerResponseCode: "51",
    }),
    false
  );
});

test("unapproved issuer response code blocks retry", () => {
  assert.equal(
    isRetryablePaymentFailure({
      merchantAdviceCode: "02",
      issuerResponseCode: "05",
    }),
    false
  );
});

test("verified card consent allows recurring payment", () => {
  assert.equal(
    hasVerifiedRecurringConsent({
      paymentConsentStatus: "VERIFIED",
      paymentConsentId: "consent_test",
      paymentMethodId: "method_test",
      paymentMethodType: "card",
    }),
    true
  );
});

test("missing or unverified consent blocks recurring payment", () => {
  const validConsent = {
    paymentConsentStatus: "VERIFIED",
    paymentConsentId: "consent_test",
    paymentMethodId: "method_test",
    paymentMethodType: "card",
  };

  for (const changes of [
    { paymentConsentStatus: "PENDING" },
    { paymentConsentId: null },
    { paymentMethodId: null },
    { paymentMethodType: "bank_transfer" },
  ]) {
    assert.equal(
      hasVerifiedRecurringConsent({
        ...validConsent,
        ...changes,
      }),
      false
    );
  }
});
