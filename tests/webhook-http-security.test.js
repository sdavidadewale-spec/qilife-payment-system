const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");

process.env.NODE_ENV = "test";
process.env.DB_NAME = "qilife_test_db";
process.env.DB_HOST = "127.0.0.1";
process.env.AIRWALLEX_WEBHOOK_SECRET = "local-http-test-secret";

let connectCalls = 0;
const savedEvents = [];

const mockClient = {
  async query(sql, params = []) {
    const query = sql.replace(/\s+/g, " ").trim();

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) {
      return { rowCount: null, rows: [] };
    }

    if (query.includes("INSERT INTO webhook_events")) {
      savedEvents.push({
        eventId: params[0],
        eventType: params[1],
      });

      return {
        rowCount: 1,
        rows: [{ event_id: params[0] }],
      };
    }

    throw new Error(`Unexpected SQL in HTTP webhook test: ${query}`);
  },

  release() {},
};

const mockPool = {
  async connect() {
    connectCalls += 1;
    return mockClient;
  },

  async query(sql) {
    throw new Error(
      `Unexpected direct pool query in HTTP webhook test: ${sql}`
    );
  },
};

// Install the database mock before importing the Express app.
const dbPath = require.resolve("../db");
const originalDbModule = require.cache[dbPath];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: mockPool,
};

let app;

try {
  app = require("../server");
} finally {
  if (originalDbModule) {
    require.cache[dbPath] = originalDbModule;
  } else {
    delete require.cache[dbPath];
  }
}

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

async function sendWebhook(event, options = {}) {
  const rawBody = JSON.stringify(event);
  const timestamp = String(Date.now());
  const signingSecret =
    options.signingSecret || process.env.AIRWALLEX_WEBHOOK_SECRET;

  const signature = crypto
    .createHmac("sha256", signingSecret)
    .update(timestamp + rawBody)
    .digest("hex");

  const headers = {
    "content-type": "application/json",
    "x-timestamp": timestamp,
    "x-signature": signature,
    ...(options.testSecret
      ? { "client-secret-key": options.testSecret }
      : {}),
  };

  const response = await fetch(`${baseUrl}/api/webhooks`, {
    method: "POST",
    headers,
    body: rawBody,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

test("rejects an invalid production webhook signature before database access", async () => {
  const previousConnectCalls = connectCalls;

  const result = await sendWebhook(
    {
      id: "evt-http-invalid-signature",
      name: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi-http-invalid",
        },
      },
    },
    {
      signingSecret: "incorrect-local-secret",
    }
  );

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, {
    message: "Invalid webhook signature",
  });
  assert.equal(connectCalls, previousConnectCalls);
});

test("accepts a valid production webhook and reaches database processing", async () => {
  const previousConnectCalls = connectCalls;

  const result = await sendWebhook({
    id: "evt-http-valid-production",
    name: "customer.created",
    data: {
      object: {
        id: "cus-http-test",
      },
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    received: true,
    processed: true,
  });
  assert.equal(connectCalls, previousConnectCalls + 1);
  assert.ok(
    savedEvents.some(
      (event) => event.eventId === "evt-http-valid-production"
    )
  );
});

test("acknowledges a valid Airwallex test event without database access", async () => {
  const previousConnectCalls = connectCalls;
  const previousSavedEvents = savedEvents.length;
  const testSecret = "local-airwallex-test-secret";

  const result = await sendWebhook(
    {
      id: "evt-http-valid-test",
      name: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi-http-test",
        },
      },
    },
    {
      testSecret,
      signingSecret: testSecret,
    }
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    received: true,
    test: true,
  });
  assert.equal(connectCalls, previousConnectCalls);
  assert.equal(savedEvents.length, previousSavedEvents);
});

test("rejects a test event with an invalid signature before database access", async () => {
  const previousConnectCalls = connectCalls;
  const previousSavedEvents = savedEvents.length;
  const testSecret = "local-airwallex-test-secret";

  const result = await sendWebhook(
    {
      id: "evt-http-invalid-test-signature",
      name: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi-http-invalid-test",
        },
      },
    },
    {
      testSecret,
      signingSecret: "incorrect-local-test-secret",
    }
  );

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, {
    message: "Invalid webhook signature",
  });
  assert.equal(connectCalls, previousConnectCalls);
  assert.equal(savedEvents.length, previousSavedEvents);
});

test("sets no-referrer policy on the public checkout page and blocks the old checkout page", async () => {
  const checkoutResponse = await fetch(`${baseUrl}/public-checkout.html`);
  const otherPageResponse = await fetch(`${baseUrl}/checkout.html`);

  assert.equal(checkoutResponse.status, 200);
  assert.equal(
    checkoutResponse.headers.get("referrer-policy"),
    "no-referrer"
  );

  assert.equal(otherPageResponse.status, 404);
  assert.equal(otherPageResponse.headers.get("referrer-policy"), null);
});
