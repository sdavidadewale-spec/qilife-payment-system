BEGIN;

CREATE TABLE IF NOT EXISTS checkout_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(150) NOT NULL UNIQUE,
    pricing_plan_id UUID NOT NULL UNIQUE
        REFERENCES pricing_plans(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
    plan_count INTEGER;
    invalid_schedule_count INTEGER;
BEGIN
    SELECT COUNT(*)
    INTO plan_count
    FROM pricing_plans
    WHERE plan_type IN ('three_part', 'six_part')
      AND instalment_count IN (3, 6);

    IF plan_count <> 12 THEN
        RAISE EXCEPTION
            'Expected 12 instalment plans, found %', plan_count;
    END IF;

    SELECT COUNT(*)
    INTO invalid_schedule_count
    FROM (
        SELECT pp.id
        FROM pricing_plans pp
        LEFT JOIN pricing_plan_installments ppi
          ON ppi.pricing_plan_id = pp.id
        WHERE pp.plan_type IN ('three_part', 'six_part')
          AND pp.instalment_count IN (3, 6)
        GROUP BY pp.id, pp.instalment_count
        HAVING COUNT(ppi.id) <> pp.instalment_count
    ) AS invalid_plans;

    IF invalid_schedule_count <> 0 THEN
        RAISE EXCEPTION
            'Found % incomplete payment schedules',
            invalid_schedule_count;
    END IF;
END $$;

INSERT INTO checkout_links (slug, pricing_plan_id)
SELECT
    c.duration_months || '-month-' ||
    pp.student_type || '-' ||
    pp.instalment_count || '-instalments',
    pp.id
FROM pricing_plans pp
JOIN courses c ON c.id = pp.course_id
WHERE pp.plan_type IN ('three_part', 'six_part')
  AND pp.instalment_count IN (3, 6)
ON CONFLICT (pricing_plan_id) DO NOTHING;

COMMIT;
