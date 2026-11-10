function toCents(value) {
  const amount = String(value);

  const match = amount.match(/^(\d+)(?:\.(\d{1,2}))?$/);

  if (!match) {
    return null;
  }

  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || "").padEnd(2, "0"));

  return whole * 100n + fraction;
}

function isValidPaymentSchedule({
  schedule,
  expectedCount,
  expectedTotal,
}) {
  if (
    !Array.isArray(schedule) ||
    !Number.isInteger(Number(expectedCount)) ||
    Number(expectedCount) < 1 ||
    schedule.length !== Number(expectedCount)
  ) {
    return false;
  }

  const expectedTotalCents = toCents(expectedTotal);

  if (expectedTotalCents === null) {
    return false;
  }

  let scheduleTotalCents = 0n;

  for (let index = 0; index < schedule.length; index++) {
    const item = schedule[index];

    if (Number(item.instalment_number) !== index + 1) {
      return false;
    }

    const amountCents = toCents(item.amount);

    if (amountCents === null || amountCents <= 0n) {
      return false;
    }

    scheduleTotalCents += amountCents;
  }

  return scheduleTotalCents === expectedTotalCents;
}

module.exports = {
  isValidPaymentSchedule,
};
