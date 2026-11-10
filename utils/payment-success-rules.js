function canRecordSuccessfulPayment({
  paymentStatus,
  manualReviewRequired,
  currentPaymentIntentId,
  successfulPaymentIntentId,
}) {
  if (["pending", "processing", "paid"].includes(paymentStatus)) {
    return true;
  }

  return (
    paymentStatus === "review_required" &&
    manualReviewRequired === true &&
    Boolean(currentPaymentIntentId) &&
    currentPaymentIntentId === successfulPaymentIntentId
  );
}

module.exports = { canRecordSuccessfulPayment };
