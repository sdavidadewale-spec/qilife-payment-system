const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const verifyWebhookSignature = require("../webhook-signature");

const secret = "local-test-webhook-secret";
const rawBody = Buffer.from(
  JSON.stringify({ name: "payment_intent.succeeded", id: "evt_test_123" })
);

function makeRequest(options = {}) {
  const timestamp = options.timestamp || String(Date.now());
  const body = options.rawBody || rawBody;
  const signingSecret = options.secret || secret;

  const signature = crypto
    .createHmac("sha256", signingSecret)
    .update(timestamp + body.toString("utf8"))
    .digest("hex");

  return {
    headers: {
      "x-timestamp": options.headerTimestamp === undefined
        ? timestamp
        : options.headerTimestamp,
      "x-signature": options.headerSignature === undefined
        ? signature
        : options.headerSignature,
    },
    rawBody: options.requestBody === undefined
      ? body
      : options.requestBody,
  };
}

test("accepts a valid webhook signature", () => {
  assert.equal(verifyWebhookSignature(makeRequest(), secret), true);
});

test("rejects a changed request body", () => {
  const req = makeRequest();
  req.rawBody = Buffer.from("changed body");

  assert.equal(verifyWebhookSignature(req, secret), false);
});

test("rejects a signature made with the wrong secret", () => {
  assert.equal(verifyWebhookSignature(makeRequest(), "wrong-secret"), false);
});

test("rejects a missing timestamp", () => {
  const req = makeRequest({ headerTimestamp: undefined });
  delete req.headers["x-timestamp"];

  assert.equal(verifyWebhookSignature(req, secret), false);
});

test("rejects a missing signature", () => {
  const req = makeRequest();
  delete req.headers["x-signature"];

  assert.equal(verifyWebhookSignature(req, secret), false);
});

test("rejects a missing raw request body", () => {
  const req = makeRequest({ requestBody: null });

  assert.equal(verifyWebhookSignature(req, secret), false);
});

test("rejects a non-numeric timestamp", () => {
  const req = makeRequest({ headerTimestamp: "not-a-timestamp" });

  assert.equal(verifyWebhookSignature(req, secret), false);
});

test("rejects a signature with an invalid format", () => {
  const req = makeRequest({ headerSignature: "invalid" });

  assert.equal(verifyWebhookSignature(req, secret), false);
});

test("rejects a timestamp older than five minutes", () => {
  const oldTimestamp = String(Date.now() - 6 * 60 * 1000);
  const req = makeRequest({ timestamp: oldTimestamp });

  assert.equal(verifyWebhookSignature(req, secret), false);
});

test("rejects a timestamp more than five minutes in the future", () => {
  const futureTimestamp = String(Date.now() + 6 * 60 * 1000);
  const req = makeRequest({ timestamp: futureTimestamp });

  assert.equal(verifyWebhookSignature(req, secret), false);
});
