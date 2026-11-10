
// Always use the isolated local test database.
process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";

const pool = require("./db");

async function testConnection() {
  try {
    const result = await pool.query("SELECT current_database() AS database_name");

    if (result.rows[0].database_name !== "qilife_test_db") {
      throw new Error(
        "TEST SAFETY BLOCKED: Connected to " + result.rows[0].database_name
      );
    }

    console.log("Test database connection successful.");
    console.log("Connected database:", result.rows[0].database_name);
  } catch (error) {
    console.error("Test database check failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

testConnection();
