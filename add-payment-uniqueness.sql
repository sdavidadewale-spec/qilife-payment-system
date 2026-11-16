BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM payments
        GROUP BY subscription_id, instalment_number
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate payment instalments found. Migration stopped.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM payments
        WHERE subscription_id IS NULL
    ) THEN
        RAISE EXCEPTION 'Payments with missing subscription IDs found. Migration stopped.';
    END IF;
END $$;

CREATE UNIQUE INDEX payments_subscription_instalment_unique_idx
ON payments (subscription_id, instalment_number);

COMMIT;
