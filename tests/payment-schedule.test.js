const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isValidPaymentSchedule,
} = require("../utils/payment-schedule");

const validSchedule = [
  { instalment_number: 1, amount: "2100.00" },
  { instalment_number: 2, amount: "2100.00" },
  { instalment_number: 3, amount: "2100.00" },
];

test("accepts a complete schedule with the correct total", () => {
  assert.equal(
    isValidPaymentSchedule({
      schedule: validSchedule,
      expectedCount: 3,
      expectedTotal: "6300.00",
    }),
    true
  );
});

test("rejects a schedule with the wrong total", () => {
  assert.equal(
    isValidPaymentSchedule({
      schedule: validSchedule,
      expectedCount: 3,
      expectedTotal: "6300.01",
    }),
    false
  );
});

test("rejects a schedule with a missing instalment", () => {
  assert.equal(
    isValidPaymentSchedule({
      schedule: validSchedule.slice(0, 2),
      expectedCount: 3,
      expectedTotal: "6300.00",
    }),
    false
  );
});

test("rejects duplicate or out-of-order instalment numbers", () => {
  assert.equal(
    isValidPaymentSchedule({
      schedule: [
        { instalment_number: 1, amount: "2100.00" },
        { instalment_number: 1, amount: "2100.00" },
        { instalment_number: 3, amount: "2100.00" },
      ],
      expectedCount: 3,
      expectedTotal: "6300.00",
    }),
    false
  );
});

test("rejects zero, negative, or invalid amounts", () => {
  for (const amount of ["0.00", "-10.00", "invalid"]) {
    const schedule = [
      { instalment_number: 1, amount },
      { instalment_number: 2, amount: "2100.00" },
      { instalment_number: 3, amount: "2100.00" },
    ];

    assert.equal(
      isValidPaymentSchedule({
        schedule,
        expectedCount: 3,
        expectedTotal: "4200.00",
      }),
      false
    );
  }
});

test("handles decimal totals without floating-point rounding", () => {
  assert.equal(
    isValidPaymentSchedule({
      schedule: [
        { instalment_number: 1, amount: "95.50" },
        { instalment_number: 2, amount: "95.50" },
        { instalment_number: 3, amount: "95.50" },
      ],
      expectedCount: 3,
      expectedTotal: "286.50",
    }),
    true
  );
});
