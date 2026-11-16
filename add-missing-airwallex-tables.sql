BEGIN;

CREATE TABLE IF NOT EXISTS airwallex_payment_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id)
        ON DELETE CASCADE,
    airwallex_payment_intent_id VARCHAR(255) NOT NULL UNIQUE,
    request_id VARCHAR(255) UNIQUE,
    status VARCHAR(50),
    airwallex_updated_at TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS airwallex_payment_intents_payment_idx
ON airwallex_payment_intents (payment_id);

CREATE TABLE IF NOT EXISTS airwallex_payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id)
        ON DELETE CASCADE,
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
    CONSTRAINT payment_attempt_number_positive
        CHECK (attempt_number > 0),
    CONSTRAINT payment_attempt_unique_number
        UNIQUE (payment_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS airwallex_payment_attempts_payment_idx
ON airwallex_payment_attempts (payment_id);

CREATE INDEX IF NOT EXISTS airwallex_payment_attempts_status_idx
ON airwallex_payment_attempts (status);

CREATE INDEX IF NOT EXISTS payments_pending_due_date_idx
ON payments (due_date, subscription_id, instalment_number)
WHERE status = 'pending'
  AND due_date IS NOT NULL;

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

COMMIT;
