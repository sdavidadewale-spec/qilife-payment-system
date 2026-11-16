BEGIN;

ALTER TABLE airwallex_payment_attempts
ADD COLUMN IF NOT EXISTS merchant_advice_code VARCHAR(100),
ADD COLUMN IF NOT EXISTS issuer_response_code VARCHAR(20);

COMMIT;
