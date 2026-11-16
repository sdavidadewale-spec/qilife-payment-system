BEGIN;

ALTER TABLE payments
ADD COLUMN IF NOT EXISTS processing_claim_token UUID;

CREATE UNIQUE INDEX IF NOT EXISTS
  payments_processing_claim_token_unique_idx
  ON payments (processing_claim_token)
  WHERE processing_claim_token IS NOT NULL;

COMMIT;
