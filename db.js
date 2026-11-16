require("dotenv").config();

const { Pool } = require("pg");

// TEST_DATABASE_SAFETY_GUARD
if (process.env.NODE_ENV === "test") {
  const allowedTestHosts = ["localhost", "127.0.0.1", "::1"];
  const testHost = (process.env.DB_HOST || "").toLowerCase();

  if (process.env.DATABASE_URL) {
    throw new Error(
      "TEST SAFETY BLOCKED: Test mode may not use DATABASE_URL."
    );
  }

  if (process.env.DB_NAME !== "qilife_test_db") {
    throw new Error(
      "TEST SAFETY BLOCKED: Test mode may only connect to qilife_test_db."
    );
  }

  if (!allowedTestHosts.includes(testHost)) {
    throw new Error(
      "TEST SAFETY BLOCKED: Test mode may only use a local database host."
    );
  }
}

const isProduction = process.env.NODE_ENV === "production";

const poolConfig = {
  ssl: isProduction
    ? { rejectUnauthorized: false }
    : false,
};

if (process.env.DATABASE_URL && process.env.NODE_ENV !== "test") {
  poolConfig.connectionString = process.env.DATABASE_URL;
} else {
  poolConfig.user = process.env.DB_USER;
  poolConfig.host = process.env.DB_HOST;
  poolConfig.database = process.env.DB_NAME;
  poolConfig.password = process.env.DB_PASSWORD;
  poolConfig.port = process.env.DB_PORT;
}

const pool = new Pool(poolConfig);

module.exports = pool;
