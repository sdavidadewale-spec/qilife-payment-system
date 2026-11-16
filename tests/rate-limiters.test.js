const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const {
  publicPlanLookupLimiter,
  publicEnrollmentLimiter,
  paymentSetupLimiter,
  enrollmentStatusLimiter,
} = require("../middleware/rate-limiters");

async function startTestServer(limiter) {
  const app = express();
  app.set("trust proxy", "loopback");

  app.get("/", limiter, (req, res) => {
    res.status(200).json({ success: true });
  });

  const server = app.listen(0);

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function checkLimit({ limiter, limit, ip, message }) {
  const server = await startTestServer(limiter);

  try {
    for (let i = 0; i < limit; i += 1) {
      const response = await fetch(server.url, {
        headers: { "X-Forwarded-For": ip },
      });

      assert.equal(
        response.status,
        200,
        `Request ${i + 1} of ${limit} should be allowed`
      );
    }

    const blockedResponse = await fetch(server.url, {
      headers: { "X-Forwarded-For": ip },
    });

    assert.equal(blockedResponse.status, 429);
    assert.equal(
      (await blockedResponse.json()).message,
      message
    );
    assert.ok(
      blockedResponse.headers.get("ratelimit"),
      "Rate limit response header should be present"
    );
  } finally {
    await server.close();
  }
}

test("public plan lookup allows 60 requests and blocks the 61st", async () => {
  await checkLimit({
    limiter: publicPlanLookupLimiter,
    limit: 60,
    ip: "198.51.100.11",
    message: "Too many checkout requests. Please wait and try again.",
  });
});

test("public enrolment allows 10 requests and blocks the 11th", async () => {
  await checkLimit({
    limiter: publicEnrollmentLimiter,
    limit: 10,
    ip: "198.51.100.12",
    message: "Too many enrolment attempts. Please wait before trying again.",
  });
});

test("payment setup allows 10 requests and blocks the 11th", async () => {
  await checkLimit({
    limiter: paymentSetupLimiter,
    limit: 10,
    ip: "198.51.100.13",
    message: "Too many payment setup attempts. Please wait before trying again.",
  });
});

test("enrolment status allows 60 requests and blocks the 61st", async () => {
  await checkLimit({
    limiter: enrollmentStatusLimiter,
    limit: 60,
    ip: "198.51.100.14",
    message: "Too many status requests. Please wait and try again.",
  });
});

test("changing CF-Connecting-IP cannot bypass the rate limit", async () => {
  const server = await startTestServer(publicPlanLookupLimiter);

  try {
    for (let i = 0; i < 60; i += 1) {
      const response = await fetch(server.url, {
        headers: { "CF-Connecting-IP": `198.51.100.${i + 1}` },
      });

      assert.equal(response.status, 200);
    }

    const blockedResponse = await fetch(server.url, {
      headers: { "CF-Connecting-IP": "203.0.113.99" },
    });

    assert.equal(blockedResponse.status, 429);
  } finally {
    await server.close();
  }
});
