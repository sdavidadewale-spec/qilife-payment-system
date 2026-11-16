BEGIN;

CREATE TABLE payment_retry_operations (
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

CREATE INDEX idx_payment_retry_operations_status
  ON payment_retry_operations(status, updated_at);

CREATE INDEX idx_payment_retry_operations_payment
  ON payment_retry_operations(payment_id);

COMMIT;
