BEGIN;

ALTER TABLE payments
ADD COLUMN IF NOT EXISTS airwallex_create_request_id VARCHAR(64),
ADD COLUMN IF NOT EXISTS airwallex_confirm_request_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS
  payments_airwallex_create_request_id_unique_idx
  ON payments (airwallex_create_request_id)
  WHERE airwallex_create_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  payments_airwallex_confirm_request_id_unique_idx
  ON payments (airwallex_confirm_request_id)
  WHERE airwallex_confirm_request_id IS NOT NULL;

COMMIT;
