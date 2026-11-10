function getNextRetryAttemptNumber(failedCount) {
  const count = Number(failedCount);

  if (!Number.isInteger(count) || count < 1 || count >= 3) {
    return null;
  }

  return count + 1;
}

function isRetryablePaymentFailure({
  merchantAdviceCode,
  issuerResponseCode,
}) {
  const approvedIssuerCodes = ["51", "79", "82", "83"];

  return (
    String(merchantAdviceCode || "").trim() === "02" &&
    approvedIssuerCodes.includes(
      String(issuerResponseCode || "").trim()
    )
  );
}

function hasVerifiedRecurringConsent({
  paymentConsentStatus,
  paymentConsentId,
  paymentMethodId,
  paymentMethodType,
}) {
  return (
    paymentConsentStatus === "VERIFIED" &&
    Boolean(paymentConsentId) &&
    Boolean(paymentMethodId) &&
    paymentMethodType === "card"
  );
}

module.exports = {
  getNextRetryAttemptNumber,
  isRetryablePaymentFailure,
  hasVerifiedRecurringConsent,
};
