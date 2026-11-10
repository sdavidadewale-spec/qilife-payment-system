const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("webhook payment state updates release processing claims", () => {
  const filePath = path.join(__dirname, "../routes/webhooks.js");
  const source = fs.readFileSync(filePath, "utf8");

  const paymentUpdates = [
    ...source.matchAll(/`UPDATE payments[\s\S]*?`/g),
  ].map((match) => match[0]);

  const claimReleasingUpdates = paymentUpdates.filter((sql) =>
    /processing_started_at\s*=\s*NULL/i.test(sql)
  );

  assert.equal(
    claimReleasingUpdates.length,
    4,
    "Expected exactly four webhook updates to clear processing_started_at"
  );

  for (const sql of claimReleasingUpdates) {
    assert.match(
      sql,
      /processing_claim_token\s*=\s*NULL/i,
      "Every update that clears processing_started_at must also clear processing_claim_token"
    );
  }
});
