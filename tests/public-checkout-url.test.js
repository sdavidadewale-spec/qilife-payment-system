const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let connectionAttempts = 0;

const mockPool = {
  async connect() {
    connectionAttempts++;
    throw new Error("Mock database connection reached");
  },
};

const dbPath = require.resolve("../db");
const originalDb = require.cache[dbPath];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: mockPool,
};

const router = require("../routes/public-checkout");

if (originalDb) {
  require.cache[dbPath] = originalDb;
} else {
  delete require.cache[dbPath];
}

const enrollHandler = router.stack
  .find((layer) => layer.route?.path === "/:slug/enroll")
  .route.stack
  .find((layer) => layer.method === "post")
  .handle;

async function sendEnrollment(frontendUrl) {
  if (frontendUrl === undefined) {
    delete process.env.FRONTEND_URL;
  } else {
    process.env.FRONTEND_URL = frontendUrl;
  }

  let statusCode;
  let responseBody;

  const req = {
    body: {
      full_name: "Test Student",
      email: "student@example.com",
      phone: "",
      consent_accepted: true,
      consent_version: "qilife-installments-v1",
    },
    params: { slug: "12-month-local-3-instalments" },
    get(name) {
      return name === "Idempotency-Key" ? "a".repeat(64) : undefined;
    },
  };

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await enrollHandler(req, res);

  return { statusCode, responseBody };
}

test("missing FRONTEND_URL blocks enrolment before database connection", async () => {
  connectionAttempts = 0;

  const result = await sendEnrollment(undefined);

  assert.equal(result.statusCode, 503);
  assert.match(result.responseBody.message, /secure hosted checkout/i);
  assert.equal(connectionAttempts, 0);
});

test("HTTP FRONTEND_URL blocks enrolment before database connection", async () => {
  connectionAttempts = 0;

  const result = await sendEnrollment("http://example.com");

  assert.equal(result.statusCode, 503);
  assert.equal(connectionAttempts, 0);
});

test("FRONTEND_URL with a path blocks enrolment before database connection", async () => {
  connectionAttempts = 0;

  const result = await sendEnrollment("https://example.com/checkout");

  assert.equal(result.statusCode, 503);
  assert.equal(connectionAttempts, 0);
});

test("valid HTTPS FRONTEND_URL passes URL validation", async () => {
  connectionAttempts = 0;

  await assert.rejects(
    sendEnrollment("https://example.com"),
    /Mock database connection reached/
  );

  assert.equal(connectionAttempts, 1);
});

test("public checkout extracts the token from the checkout URL query string", () => {
  const checkoutPage = fs.readFileSync(
    path.join(__dirname, "../public/public-checkout.html"),
    "utf8"
  );

  assert.match(
    checkoutPage,
    /const checkoutUrl = new URL\([\s\S]*?data\.checkout_url[\s\S]*?\);\s*checkoutToken = checkoutUrl\.searchParams\.get\(["']checkout_token["']\);/
  );

  assert.doesNotMatch(
    checkoutPage,
    /data\.checkout_url[\s\S]*?\.pathname\.split\(["']\/["']\)/
  );
});
