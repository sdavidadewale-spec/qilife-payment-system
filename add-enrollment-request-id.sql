BEGIN;

ALTER TABLE subscriptions
ADD COLUMN IF NOT EXISTS enrollment_request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS
subscriptions_enrollment_request_id_unique
ON subscriptions (enrollment_request_id)
WHERE enrollment_request_id IS NOT NULL;

COMMIT;
