function addMonthsClamped(dateString, monthsToAdd) {
  const [year, month, day] = dateString.split("-").map(Number);

  const targetDate = new Date(
    Date.UTC(year, month - 1 + monthsToAdd, 1)
  );

  const targetYear = targetDate.getUTCFullYear();
  const targetMonth = targetDate.getUTCMonth();

  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0)
  ).getUTCDate();

  const finalDay = Math.min(day, lastDay);

  return [
    targetYear,
    String(targetMonth + 1).padStart(2, "0"),
    String(finalDay).padStart(2, "0"),
  ].join("-");
}

module.exports = { addMonthsClamped };
