BEGIN;

CREATE TABLE IF NOT EXISTS unresolved_webhook_events (
    event_id VARCHAR(255) PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    reason TEXT NOT NULL,
    received_count INTEGER NOT NULL DEFAULT 1
        CHECK (received_count > 0),
    last_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolution_status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (resolution_status IN ('pending', 'resolved')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT
);

COMMIT;
