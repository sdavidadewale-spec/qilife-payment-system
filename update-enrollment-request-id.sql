BEGIN;

ALTER TABLE subscriptions
ALTER COLUMN enrollment_request_id TYPE VARCHAR(64)
USING enrollment_request_id::TEXT;

COMMIT;
