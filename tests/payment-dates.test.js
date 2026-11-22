const test = require("node:test");
const assert = require("node:assert/strict");

const { addDays } = require("../utils/payment-dates");

test("adds 30 days to a normal date", () => {
  assert.equal(addDays("2026-01-15", 30), "2026-02-14");
});

test("adds 60 days across multiple months", () => {
  assert.equal(addDays("2026-01-15", 60), "2026-03-16");
});

test("handles February and leap years", () => {
  assert.equal(addDays("2024-01-31", 30), "2024-03-01");
});

test("handles a year change", () => {
  assert.equal(addDays("2026-12-15", 30), "2027-01-14");
});

test("handles zero days", () => {
  assert.equal(addDays("2026-08-20", 0), "2026-08-20");
});

test("rejects negative days", () => {
  assert.throws(() => addDays("2026-01-15", -1));
});

test("rejects invalid dates", () => {
  assert.throws(() => addDays("2026-02-30", 30));
  assert.throws(() => addDays("invalid", 30));
  assert.throws(() => addDays("", 30));
});

const { getMonthlyInstalmentDueDate } = require("../utils/payment-dates");

test("sets the second instalment to the 5th when first payment is before the 5th", () => {
  assert.equal(
    getMonthlyInstalmentDueDate("2026-11-04", 2),
    "2026-11-05"
  );
});

test("moves the second instalment to next month when first payment is on the 5th", () => {
  assert.equal(
    getMonthlyInstalmentDueDate("2026-11-05", 2),
    "2026-12-05"
  );
});

test("sets later instalments to the 5th of each following month", () => {
  assert.equal(
    getMonthlyInstalmentDueDate("2026-11-18", 2),
    "2026-12-05"
  );
  assert.equal(
    getMonthlyInstalmentDueDate("2026-11-18", 3),
    "2027-01-05"
  );
});

test("handles year changes", () => {
  assert.equal(
    getMonthlyInstalmentDueDate("2026-12-20", 2),
    "2027-01-05"
  );
  assert.equal(
    getMonthlyInstalmentDueDate("2026-12-20", 3),
    "2027-02-05"
  );
});

test("rejects invalid instalment numbers", () => {
  assert.throws(() => getMonthlyInstalmentDueDate("2026-11-18", 1));
  assert.throws(() => getMonthlyInstalmentDueDate("2026-11-18", 0));
});

test("rejects invalid first payment dates", () => {
  assert.throws(() => getMonthlyInstalmentDueDate("2026-02-30", 2));
  assert.throws(() => getMonthlyInstalmentDueDate("invalid", 2));
});
