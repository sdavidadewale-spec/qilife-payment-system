const {
  rateLimit,
  ipKeyGenerator,
} = require("express-rate-limit");

function createLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
    handler: (req, res) => {
      return res.status(429).json({ message });
    },
  });
}

const publicPlanLookupLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  message: "Too many checkout requests. Please wait and try again.",
});

const publicEnrollmentLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: "Too many enrolment attempts. Please wait before trying again.",
});

const paymentSetupLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: "Too many payment setup attempts. Please wait before trying again.",
});

const enrollmentStatusLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  message: "Too many status requests. Please wait and try again.",
});

module.exports = {
  publicPlanLookupLimiter,
  publicEnrollmentLimiter,
  paymentSetupLimiter,
  enrollmentStatusLimiter,
};
