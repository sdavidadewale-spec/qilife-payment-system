require("dotenv").config();

const dns = require("dns");
const { Pool } = require("pg");

dns.lookup(process.env.DB_HOST, (error, address) => {
  if (error) {
    console.error("DATABASE DNS TEST:", error.message);
  } else {
    console.log("DATABASE DNS TEST SUCCESS:", address);
  }
});

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,

  ssl: {
  rejectUnauthorized: false,
  },
});

module.exports = pool;