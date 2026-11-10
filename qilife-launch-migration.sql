BEGIN;

-- Add enrolment request and consent fields.
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS enrollment_request_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS airwallex_payment_method_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS airwallex_payment_method_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS payment_consent_text TEXT,
    ADD COLUMN IF NOT EXISTS payment_consent_version VARCHAR(100),
    ADD COLUMN IF NOT EXISTS payment_consent_accepted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_consent_ip TEXT,
    ADD COLUMN IF NOT EXISTS payment_consent_user_agent TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_enrollment_request_id_unique
ON subscriptions (enrollment_request_id)
WHERE enrollment_request_id IS NOT NULL;

-- Add payment processing fields.
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS airwallex_payment_intent_status VARCHAR(50),
    ADD COLUMN IF NOT EXISTS airwallex_payment_intent_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS airwallex_create_request_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS airwallex_confirm_request_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS processing_claim_token UUID,
    ADD COLUMN IF NOT EXISTS airwallex_confirmation_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_consent_start_date DATE,
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS manual_review_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS manual_review_reason TEXT;

-- Add unique request ID and processing claim indexes.
CREATE UNIQUE INDEX IF NOT EXISTS
    payments_airwallex_create_request_id_unique_idx
ON payments (airwallex_create_request_id)
WHERE airwallex_create_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
    payments_airwallex_confirm_request_id_unique_idx
ON payments (airwallex_confirm_request_id)
WHERE airwallex_confirm_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
    payments_processing_claim_token_unique_idx
ON payments (processing_claim_token)
WHERE processing_claim_token IS NOT NULL;

-- Stop if existing payment instalments cannot safely be made unique.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM payments
        GROUP BY subscription_id, instalment_number
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Duplicate payment instalments found. Migration stopped.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM payments
        WHERE subscription_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Payments with missing subscription IDs found. Migration stopped.';
    END IF;
END $$;

-- Require every payment to belong to a subscription.
ALTER TABLE payments
ALTER COLUMN subscription_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
    payments_subscription_instalment_unique_idx
ON payments (subscription_id, instalment_number);

-- Create recurring payment retry operations.
CREATE TABLE IF NOT EXISTS payment_retry_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL
        REFERENCES payments(id) ON DELETE CASCADE,
    payment_attempt_number INTEGER NOT NULL
        CHECK (payment_attempt_number BETWEEN 2 AND 3),
    create_request_id VARCHAR(64) NOT NULL UNIQUE,
    confirm_request_id VARCHAR(64) NOT NULL UNIQUE,
    airwallex_payment_intent_id VARCHAR(255) UNIQUE,
    status VARCHAR(40) NOT NULL DEFAULT 'prepared'
        CHECK (
            status IN (
                'prepared',
                'intent_created',
                'confirmation_requested',
                'succeeded',
                'failed',
                'manual_review'
            )
        ),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_payment_retry_attempt
        UNIQUE (payment_id, payment_attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_payment_retry_operations_status
ON payment_retry_operations (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_payment_retry_operations_payment
ON payment_retry_operations (payment_id);

-- Create public checkout links.
CREATE TABLE IF NOT EXISTS checkout_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(150) NOT NULL UNIQUE,
    pricing_plan_id UUID NOT NULL UNIQUE
        REFERENCES pricing_plans(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create PaymentIntent history.
CREATE TABLE IF NOT EXISTS airwallex_payment_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    airwallex_payment_intent_id VARCHAR(255) NOT NULL UNIQUE,
    request_id VARCHAR(255) UNIQUE,
    status VARCHAR(50),
    airwallex_updated_at TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS airwallex_payment_intents_payment_idx
ON airwallex_payment_intents (payment_id);

-- Create payment attempt records.
CREATE TABLE IF NOT EXISTS airwallex_payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    request_id VARCHAR(255) UNIQUE,
    airwallex_payment_intent_id VARCHAR(255),
    airwallex_payment_attempt_id VARCHAR(255) UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    airwallex_created_at TIMESTAMPTZ,
    airwallex_updated_at TIMESTAMPTZ,
    failure_code VARCHAR(255),
    merchant_advice_code VARCHAR(100),
    issuer_response_code VARCHAR(20),
    failure_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    CONSTRAINT payment_attempt_number_positive CHECK (attempt_number > 0),
    CONSTRAINT payment_attempt_unique_number UNIQUE (payment_id, attempt_number)
);

-- Add retry response fields to existing payment attempt tables.
ALTER TABLE airwallex_payment_attempts
    ADD COLUMN IF NOT EXISTS merchant_advice_code VARCHAR(100),
    ADD COLUMN IF NOT EXISTS issuer_response_code VARCHAR(20);

CREATE INDEX IF NOT EXISTS airwallex_payment_attempts_payment_idx
ON airwallex_payment_attempts (payment_id);

CREATE INDEX IF NOT EXISTS airwallex_payment_attempts_status_idx
ON airwallex_payment_attempts (status);

CREATE INDEX IF NOT EXISTS payments_pending_due_date_idx
ON payments (due_date, subscription_id, instalment_number)
WHERE status = 'pending' AND due_date IS NOT NULL;

-- Create records for payments that need manual review.
CREATE TABLE IF NOT EXISTS payment_review_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(255) NOT NULL UNIQUE
        REFERENCES webhook_events(event_id),
    payment_id UUID NOT NULL REFERENCES payments(id),
    airwallex_payment_intent_id VARCHAR(255) NOT NULL,
    reason TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending_review',
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_review_events_payment_idx
ON payment_review_events (payment_id);

-- Check the 12 plans and their payment schedules before creating links.
DO $$
DECLARE
    plan_count INTEGER;
    invalid_schedule_count INTEGER;
    slug_conflict_count INTEGER;
    existing_slug_mismatch_count INTEGER;
    link_count INTEGER;
    matching_link_count INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO plan_count
    FROM pricing_plans
    WHERE plan_type IN ('three_part', 'six_part')
      AND instalment_count IN (3, 6);

    IF plan_count <> 12 THEN
        RAISE EXCEPTION 'Expected 12 instalment plans, found %', plan_count;
    END IF;

    SELECT COUNT(*)
    INTO invalid_schedule_count
    FROM (
        SELECT
            pp.id,
            pp.instalment_count,
            pp.total_amount
        FROM pricing_plans pp
        LEFT JOIN pricing_plan_installments ppi
            ON ppi.pricing_plan_id = pp.id
        WHERE pp.plan_type IN ('three_part', 'six_part')
          AND pp.instalment_count IN (3, 6)
        GROUP BY pp.id, pp.instalment_count, pp.total_amount
        HAVING COUNT(ppi.id) <> pp.instalment_count
            OR COALESCE(SUM(ppi.amount), 0) <> pp.total_amount
    ) AS invalid_plans;

    IF invalid_schedule_count <> 0 THEN
        RAISE EXCEPTION 'Found % plans with invalid instalment schedules',
            invalid_schedule_count;
    END IF;

    SELECT COUNT(*)
    INTO slug_conflict_count
    FROM pricing_plans pp
    JOIN courses c ON c.id = pp.course_id
    JOIN checkout_links cl
      ON cl.slug = (
          c.duration_months || '-month-' ||
          pp.student_type || '-' ||
          pp.instalment_count || '-instalments'
      )
     AND cl.pricing_plan_id <> pp.id
    WHERE pp.plan_type IN ('three_part', 'six_part')
      AND pp.instalment_count IN (3, 6);

    IF slug_conflict_count <> 0 THEN
        RAISE EXCEPTION 'Found % checkout slug conflicts',
            slug_conflict_count;
    END IF;

    SELECT COUNT(*)
    INTO existing_slug_mismatch_count
    FROM pricing_plans pp
    JOIN courses c ON c.id = pp.course_id
    JOIN checkout_links cl ON cl.pricing_plan_id = pp.id
    WHERE pp.plan_type IN ('three_part', 'six_part')
      AND pp.instalment_count IN (3, 6)
      AND cl.slug <> (
          c.duration_months || '-month-' ||
          pp.student_type || '-' ||
          pp.instalment_count || '-instalments'
      );

    IF existing_slug_mismatch_count <> 0 THEN
        RAISE EXCEPTION 'Found % existing checkout links with unexpected slugs',
            existing_slug_mismatch_count;
    END IF;
END $$;

-- Add the 12 reusable checkout links.
INSERT INTO checkout_links (slug, pricing_plan_id)
SELECT
    c.duration_months || '-month-' ||
    pp.student_type || '-' ||
    pp.instalment_count || '-instalments',
    pp.id
FROM pricing_plans pp
JOIN courses c ON c.id = pp.course_id
WHERE pp.plan_type IN ('three_part', 'six_part')
  AND pp.instalment_count IN (3, 6)
ON CONFLICT (pricing_plan_id) DO NOTHING;

-- Confirm that all 12 links point to the correct plans.
DO $$
DECLARE
    matching_link_count INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO matching_link_count
    FROM pricing_plans pp
    JOIN courses c ON c.id = pp.course_id
    JOIN checkout_links cl
      ON cl.pricing_plan_id = pp.id
     AND cl.slug = (
         c.duration_months || '-month-' ||
         pp.student_type || '-' ||
         pp.instalment_count || '-instalments'
     )
    WHERE pp.plan_type IN ('three_part', 'six_part')
      AND pp.instalment_count IN (3, 6);

    IF matching_link_count <> 12 THEN
        RAISE EXCEPTION
            'Checkout link check failed. Matching links: %',
            matching_link_count;
    END IF;
END $$;


-- Prevent duplicate student emails regardless of letter case or extra spaces.
CREATE UNIQUE INDEX IF NOT EXISTS students_email_normalized_unique_idx
ON students (LOWER(BTRIM(email)));

COMMIT;
