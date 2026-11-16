BEGIN;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS payment_consent_text TEXT,
    ADD COLUMN IF NOT EXISTS payment_consent_version VARCHAR(100),
    ADD COLUMN IF NOT EXISTS payment_consent_accepted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_consent_ip TEXT,
    ADD COLUMN IF NOT EXISTS payment_consent_user_agent TEXT;

COMMIT;
