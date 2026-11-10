require("dotenv").config();

const pool = require("../db");

function getSingaporeDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

async function runDryCheck({
  database = pool,
  logger = console,
  dateProvider = getSingaporeDate,
} = {}) {
  const client = await database.connect();

  try {
    const singaporeDate = dateProvider();

    logger.log("Recurring payment worker: DRY RUN");
    logger.log("Singapore date:", singaporeDate);

    const result = await client.query(
      `SELECT
         p.id AS payment_id,
         p.subscription_id,
         p.instalment_number,
         p.amount,
         p.currency,
         p.due_date,
         p.next_retry_at,
         p.processing_started_at,
         p.airwallex_payment_id,
         COALESCE(attempt_counts.failed_count, 0)::INTEGER
           AS failed_attempts,
         latest_attempt.airwallex_payment_attempt_id
           AS latest_attempt_id,
         latest_attempt.merchant_advice_code,
         latest_attempt.issuer_response_code,
         CASE
           WHEN p.next_retry_at IS NULL
             THEN 'NORMAL_PAYMENT'
           ELSE 'RETRY'
         END AS payment_action
       FROM payments p
       JOIN subscriptions s
         ON s.id = p.subscription_id
       JOIN students st
         ON st.id = s.student_id

       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) FILTER (
             WHERE UPPER(a.status) = 'FAILED'
           ) AS failed_count
         FROM airwallex_payment_attempts a
         WHERE a.payment_id = p.id
       ) AS attempt_counts ON TRUE

       LEFT JOIN airwallex_payment_intents current_intent
         ON current_intent.payment_id = p.id
        AND current_intent.airwallex_payment_intent_id =
            p.airwallex_payment_id

       LEFT JOIN LATERAL (
         SELECT
           a.airwallex_payment_attempt_id,
           a.status,
           a.merchant_advice_code,
           a.issuer_response_code
         FROM airwallex_payment_attempts a
         WHERE a.payment_id = p.id
           AND a.airwallex_payment_intent_id =
               p.airwallex_payment_id
         ORDER BY
           a.airwallex_created_at DESC NULLS LAST,
           a.airwallex_payment_attempt_id DESC
         LIMIT 1
       ) AS latest_attempt ON TRUE

       WHERE p.status IN ('pending', 'processing')
         AND (
           p.status = 'pending'
           OR (
             p.status = 'processing'
             AND p.processing_started_at IS NOT NULL
             AND p.processing_started_at <=
                 NOW() - INTERVAL '5 minutes'
           )
         )
         AND p.instalment_number > 1
         AND p.manual_review_required = FALSE

         AND s.status = 'active'
         AND s.payment_consent_status = 'VERIFIED'
         AND s.airwallex_payment_consent_id IS NOT NULL
         AND s.airwallex_payment_method_id IS NOT NULL
         AND s.airwallex_payment_method_type = 'card'
         AND st.airwallex_customer_id IS NOT NULL

         AND (
           (
             -- Normal monthly payment.
             p.next_retry_at IS NULL
             AND p.due_date IS NOT NULL
             AND p.due_date <= $1::date
             AND (
               (
                 p.status = 'pending'
                 AND p.airwallex_payment_id IS NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM airwallex_payment_intents previous_intent
                   WHERE previous_intent.payment_id = p.id
                 )
               )
               OR p.status = 'processing'
             )

             -- A stale processing payment may already have a saved
             -- PaymentIntent, which must be recovered rather than replaced.
             AND NOT EXISTS (
               SELECT 1
               FROM airwallex_payment_attempts previous_attempt
               WHERE previous_attempt.payment_id = p.id
             )
           )

           OR

           (
             -- Retry of a confirmed failed payment.
             p.next_retry_at IS NOT NULL
             AND p.next_retry_at <= NOW()
             AND p.airwallex_payment_id IS NOT NULL
             AND current_intent.airwallex_payment_intent_id IS NOT NULL

             -- Only retry when the latest attempt for the current
             -- PaymentIntent is confirmed as FAILED.
             AND UPPER(latest_attempt.status) = 'FAILED'

             -- Only the approved response codes can be retried.
             AND TRIM(latest_attempt.merchant_advice_code) = '02'
             AND TRIM(latest_attempt.issuer_response_code)
                 IN ('51', '79', '82', '83')

             -- Maximum of three failed attempts per instalment.
             AND COALESCE(attempt_counts.failed_count, 0) < 3
           )
         )

         -- Only select the earliest unpaid instalment.
         AND NOT EXISTS (
           SELECT 1
           FROM payments earlier
           WHERE earlier.subscription_id = p.subscription_id
             AND earlier.instalment_number < p.instalment_number
             AND earlier.status <> 'paid'
         )

         -- Do not select another instalment while one is processing.
         AND NOT EXISTS (
           SELECT 1
           FROM payments processing
           WHERE processing.subscription_id = p.subscription_id
             AND processing.id <> p.id
             AND processing.status = 'processing'
         )

       ORDER BY
         COALESCE(p.next_retry_at, p.due_date::timestamptz) ASC,
         p.instalment_number ASC

       `,
      [singaporeDate]
    );

    logger.log("Eligible instalments found:", result.rows.length);

    for (const payment of result.rows) {
      logger.log({
        payment_id: payment.payment_id,
        subscription_id: payment.subscription_id,
        instalment_number: payment.instalment_number,
        amount: payment.amount,
        currency: payment.currency,
        due_date: payment.due_date,
        next_retry_at: payment.next_retry_at,
        processing_started_at: payment.processing_started_at,
        failed_attempts: payment.failed_attempts,
        payment_action: payment.payment_action,
        latest_attempt_id: payment.latest_attempt_id,
        merchant_advice_code: payment.merchant_advice_code,
        issuer_response_code: payment.issuer_response_code,
        action: "DRY RUN ONLY - no payment made",
      });
    }

    logger.log("Dry-run check completed.");
  } finally {
    client.release();
  }
}

module.exports = {
  runDryCheck,
  getSingaporeDate,
};

if (require.main === module) {
  runDryCheck()
    .catch((error) => {
      console.error("Recurring payment check failed:", error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      pool.end();
    });
}
