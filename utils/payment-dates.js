function addDays(dateString, daysToAdd) {
  if (!Number.isInteger(daysToAdd) || daysToAdd < 0) {
    throw new Error("Days to add must be a non-negative integer");
  }

  if (
    typeof dateString !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dateString)
  ) {
    throw new Error("A valid date is required");
  }

  const [year, month, day] = dateString.split("-").map(Number);
  const originalDate = new Date(Date.UTC(year, month - 1, day));

  if (
    originalDate.getUTCFullYear() !== year ||
    originalDate.getUTCMonth() !== month - 1 ||
    originalDate.getUTCDate() !== day
  ) {
    throw new Error("A valid date is required");
  }

  const date = new Date(
    Date.UTC(year, month - 1, day + daysToAdd)
  );

  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 1
  ) {
    throw new Error("A valid date is required");
  }

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function getMonthlyInstalmentDueDate(checkoutDate, instalmentNumber) {
  if (!Number.isInteger(instalmentNumber) || instalmentNumber < 2) {
    throw new Error("Instalment number must be at least 2");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkoutDate)) {
    throw new Error("A valid checkout date is required");
  }

  const [year, month, day] = checkoutDate.split("-").map(Number);
  const firstDate = new Date(Date.UTC(year, month - 1, day));

  if (
    firstDate.getUTCFullYear() !== year ||
    firstDate.getUTCMonth() !== month - 1 ||
    firstDate.getUTCDate() !== day
  ) {
    throw new Error("A valid checkout date is required");
  }

  let dueMonth = month - 1;

  if (day >= 5) {
    dueMonth += 1;
  }

  dueMonth += instalmentNumber - 2;

  const dueDate = new Date(Date.UTC(year, dueMonth, 5));

  return [
    dueDate.getUTCFullYear(),
    String(dueDate.getUTCMonth() + 1).padStart(2, "0"),
    "05",
  ].join("-");
}

module.exports = {
  addDays,
  getMonthlyInstalmentDueDate,
};
