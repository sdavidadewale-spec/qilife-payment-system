
require("dotenv").config();

const { Pool } = require("pg");


// TEST_DATABASE_SAFETY_GUARD
if (process.env.NODE_ENV === "test") {
  const allowedTestHosts = ["localhost", "127.0.0.1", "::1"];
  const testHost = (process.env.DB_HOST || "").toLowerCase();

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

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: isProduction
    ? { rejectUnauthorized: false }
    : false,
});

module.exports = pool;