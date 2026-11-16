const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runLiveWorker,
  isLiveProcessingEnabled,
} = require("../workers/recurring-payments");

const productionEnvironment = {
  NODE_ENV: "production",
  RECURRING_PAYMENTS_ENABLED: "true",
};

function createLogger() {
  return {
    entries: [],
    log(...values) {
      this.entries.push(values);
    },
    error(...values) {
      this.entries.push(values);
    },
  };
}

function createPayment(id) {
  return {
    payment_id: id,
    subscription_id: `subscription-${id}`,
    instalment_number: 2,
    amount: 100,
    currency: "SGD",
    payment_action: "NORMAL_PAYMENT",
  };
}

test("live processing requires production mode and an explicit enable flag", () => {
  assert.equal(isLiveProcessingEnabled(productionEnvironment), true);

  assert.equal(
    isLiveProcessingEnabled({
      NODE_ENV: "production",
      RECURRING_PAYMENTS_ENABLED: "false",
    }),
    false
  );

  assert.equal(
    isLiveProcessingEnabled({
      NODE_ENV: "test",
      RECURRING_PAYMENTS_ENABLED: "true",
    }),
    false
  );

  assert.equal(isLiveProcessingEnabled({}), false);
});

test("live worker stays disabled without connecting to the database", async () => {
  let connectCalls = 0;
  const logger = createLogger();

  const result = await runLiveWorker({
    database: {
      async connect() {
        connectCalls += 1;
        throw new Error("Database should not be connected");
      },
    },
    logger,
    environment: {
      NODE_ENV: "production",
      RECURRING_PAYMENTS_ENABLED: "false",
    },
    paymentProcessor: async () => {
      throw new Error("Payment processor must not run");
    },
  });

  assert.deepEqual(result, {
    status: "disabled",
    processed: 0,
  });
  assert.equal(connectCalls, 0);
  assert.ok(
    logger.entries.some((entry) =>
      String(entry[0]).includes("LIVE PROCESSING BLOCKED")
    )
  );
});

test("live worker stops when another worker holds the advisory lock", async () => {
  const queries = [];
  let released = false;
  let processorCalls = 0;

  const database = {
    async connect() {
      return {
        async query(sql, parameters) {
          queries.push({ sql, parameters });
          return { rows: [{ acquired: false }] };
        },
        release() {
          released = true;
        },
      };
    },
  };

  const result = await runLiveWorker({
    database,
    logger: createLogger(),
    environment: productionEnvironment,
    paymentProcessor: async () => {
      processorCalls += 1;
    },
  });

  assert.deepEqual(result, {
    status: "locked",
    processed: 0,
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /pg_try_advisory_lock/i);
  assert.equal(processorCalls, 0);
  assert.equal(released, true);
});

test("live worker processes payments one at a time and continues after an error", async () => {
  const queries = [];
  const processorCalls = [];
  const logger = createLogger();
  let releaseArgument;
  let activeProcessors = 0;
  let maximumConcurrentProcessors = 0;

  const payments = [
    createPayment("payment-1"),
    createPayment("payment-2"),
    createPayment("payment-3"),
  ];

  const database = {
    async connect() {
      return {
        async query(sql, parameters) {
          queries.push({ sql, parameters });

          if (/pg_try_advisory_lock/i.test(sql)) {
            return { rows: [{ acquired: true }] };
          }

          if (/pg_advisory_unlock/i.test(sql)) {
            return { rows: [{ released: true }] };
          }

          return { rows: payments };
        },
        release(error) {
          releaseArgument = error;
        },
      };
    },
  };

  const result = await runLiveWorker({
    database,
    logger,
    dateProvider: () => "2026-11-15",
    environment: productionEnvironment,
    advisoryLockKey: "731942681205",
    paymentProcessor: async (paymentId, options) => {
      processorCalls.push(paymentId);
      assert.equal(options.db, database);

      activeProcessors += 1;
      maximumConcurrentProcessors = Math.max(
        maximumConcurrentProcessors,
        activeProcessors
      );

      await new Promise((resolve) => setTimeout(resolve, 5));

      activeProcessors -= 1;

      if (paymentId === "payment-2") {
        throw new Error("Simulated payment processing error");
      }

      return { status: "awaiting_webhook" };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.eligible, 3);
  assert.equal(result.processed, 3);

  assert.deepEqual(processorCalls, [
    "payment-1",
    "payment-2",
    "payment-3",
  ]);

  assert.equal(maximumConcurrentProcessors, 1);

  assert.deepEqual(
    result.results.map((item) => item.status),
    ["awaiting_webhook", "error", "awaiting_webhook"]
  );

  assert.match(queries[0].sql, /pg_try_advisory_lock/i);
  assert.match(queries[1].sql, /SELECT/i);
  assert.match(queries[2].sql, /pg_advisory_unlock/i);
  assert.equal(releaseArgument, undefined);
});

test("live worker destroys the connection if advisory lock release fails", async () => {
  const logger = createLogger();
  let releaseArgument;
  let processorCalls = 0;

  const database = {
    async connect() {
      return {
        async query(sql) {
          if (/pg_try_advisory_lock/i.test(sql)) {
            return { rows: [{ acquired: true }] };
          }

          if (/pg_advisory_unlock/i.test(sql)) {
            throw new Error("Simulated unlock failure");
          }

          return { rows: [] };
        },
        release(error) {
          releaseArgument = error;
        },
      };
    },
  };

  const result = await runLiveWorker({
    database,
    logger,
    environment: productionEnvironment,
    paymentProcessor: async () => {
      processorCalls += 1;
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.processed, 0);
  assert.equal(processorCalls, 0);

  assert.ok(releaseArgument instanceof Error);
  assert.match(releaseArgument.message, /unlock failure/i);

  assert.ok(
    logger.entries.some((entry) =>
      String(entry[0]).includes("Destroying its connection")
    )
  );
});

test("live worker destroys the connection when lock acquisition outcome is unknown", async () => {
  const logger = createLogger();
  let releaseArgument;
  let queryCalls = 0;

  const database = {
    async connect() {
      return {
        async query() {
          queryCalls += 1;
          throw new Error("Simulated connection loss during lock acquisition");
        },
        release(error) {
          releaseArgument = error;
        },
      };
    },
  };

  await assert.rejects(
    runLiveWorker({
      database,
      logger,
      environment: productionEnvironment,
      paymentProcessor: async () => {
        throw new Error("Payment processor must not run");
      },
    }),
    /connection loss during lock acquisition/i
  );

  assert.equal(queryCalls, 1);
  assert.ok(releaseArgument instanceof Error);
  assert.match(releaseArgument.message, /outcome is unknown/i);
});
