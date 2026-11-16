BEGIN;

ALTER TABLE payments
ADD COLUMN IF NOT EXISTS airwallex_confirmation_requested_at TIMESTAMPTZ;

COMMIT;
