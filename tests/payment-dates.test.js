const test = require("node:test");
const assert = require("node:assert/strict");

const { addMonthsClamped } = require("../utils/payment-dates");

test("adds one month to a normal date", () => {
  assert.equal(addMonthsClamped("2026-01-15", 1), "2026-02-15");
});

test("clamps January 31 to the last day of February", () => {
  assert.equal(addMonthsClamped("2026-01-31", 1), "2026-02-28");
});

test("handles leap year February", () => {
  assert.equal(addMonthsClamped("2024-01-31", 1), "2024-02-29");
});

test("handles a year change", () => {
  assert.equal(addMonthsClamped("2026-12-15", 1), "2027-01-15");
});

test("handles adding several months", () => {
  assert.equal(addMonthsClamped("2026-01-31", 6), "2026-07-31");
});

test("keeps month-end dates clamped across later months", () => {
  assert.equal(addMonthsClamped("2026-01-31", 2), "2026-03-31");
});

test("handles zero months", () => {
  assert.equal(addMonthsClamped("2026-08-20", 0), "2026-08-20");
});
