const test = require("node:test");
const assert = require("node:assert/strict");

const { runDryCheck } = require("../workers/recurring-payments");

test("dry-run worker only reads payments and releases its database connection", async () => {
  const queries = [];
  const logs = [];
  let released = false;

  const database = {
    async connect() {
      return {
        async query(sql, parameters) {
          queries.push({ sql, parameters });
          return { rows: [] };
        },
        release() {
          released = true;
        },
      };
    },
  };

  const logger = {
    log(...values) {
      logs.push(values);
    },
  };

  await runDryCheck({
    database,
    logger,
    dateProvider: () => "2026-11-10",
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql.trim(), /^SELECT\b/i);
  assert.deepEqual(queries[0].parameters, ["2026-11-10"]);
  assert.doesNotMatch(
    queries[0].sql,
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|COMMIT|ROLLBACK)\b/i
  );
  assert.equal(released, true);
  assert.ok(logs.some((entry) => entry[0] === "Recurring payment worker: DRY RUN"));
  assert.ok(logs.some((entry) => entry[0] === "Eligible instalments found:"));
  assert.ok(logs.some((entry) => entry[0] === "Dry-run check completed."));
});
