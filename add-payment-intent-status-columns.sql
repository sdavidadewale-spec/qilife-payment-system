BEGIN;

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS airwallex_payment_intent_status VARCHAR(50),
    ADD COLUMN IF NOT EXISTS airwallex_payment_intent_updated_at TIMESTAMPTZ;

COMMIT;
