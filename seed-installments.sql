WITH schedules (course_name, student_type, plan_type, amounts) AS (
    VALUES
    -- Professional Certificate: Local
    ('Professional Certificate Program', 'local', 'full', ARRAY[13080.00]::NUMERIC[]),
    ('Professional Certificate Program', 'local', 'three_part', ARRAY[4535.20, 4534.00, 4534.00]),
    ('Professional Certificate Program', 'local', 'six_part', ARRAY[2284.00, 2290.00, 2290.00, 2290.00, 2290.00, 2290.00]),

    -- Professional Certificate: International
    ('Professional Certificate Program', 'international', 'full', ARRAY[12000.00]),
    ('Professional Certificate Program', 'international', 'three_part', ARRAY[4480.00, 4000.00, 4000.00]),
    ('Professional Certificate Program', 'international', 'six_part', ARRAY[2100.00, 2100.00, 2100.00, 2100.00, 2100.00, 2100.00]),

    -- Advanced Diploma: Local
    ('Advanced Diploma Program', 'local', 'full', ARRAY[21800.00]),
    ('Advanced Diploma Program', 'local', 'three_part', ARRAY[7558.00, 7557.00, 7557.00]),
    ('Advanced Diploma Program', 'local', 'six_part', ARRAY[5890.00, 3400.00, 3400.00, 3400.00, 3400.00, 3400.00]),

    -- Advanced Diploma: International
    ('Advanced Diploma Program', 'international', 'full', ARRAY[20000.00]),
    ('Advanced Diploma Program', 'international', 'three_part', ARRAY[7800.00, 6500.00, 6500.00]),
    ('Advanced Diploma Program', 'international', 'six_part', ARRAY[5000.00, 3200.00, 3200.00, 3200.00, 3200.00, 3200.00]),

    -- Master Practitioner: Local
    ('Master Practitioner Program', 'local', 'full', ARRAY[27250.00]),
    ('Master Practitioner Program', 'local', 'three_part', ARRAY[10340.00, 9000.00, 9000.00]),
    ('Master Practitioner Program', 'local', 'six_part', ARRAY[7612.50, 4200.00, 4200.00, 4200.00, 4200.00, 4200.00]),

    -- Master Practitioner: International
    ('Master Practitioner Program', 'international', 'full', ARRAY[25000.00]),
    ('Master Practitioner Program', 'international', 'three_part', ARRAY[9000.00, 8500.00, 8500.00]),
    ('Master Practitioner Program', 'international', 'six_part', ARRAY[6750.00, 3900.00, 3900.00, 3900.00, 3900.00, 3900.00])
),
expanded AS (
    SELECT
        course_name,
        student_type,
        plan_type,
        amount,
        instalment_number
    FROM schedules
    CROSS JOIN LATERAL
        unnest(amounts) WITH ORDINALITY AS u(amount, instalment_number)
)
INSERT INTO pricing_plan_installments (
    pricing_plan_id,
    instalment_number,
    amount
)
SELECT
    pp.id,
    e.instalment_number,
    e.amount
FROM expanded e
JOIN courses c
    ON c.name = e.course_name
JOIN pricing_plans pp
    ON pp.course_id = c.id
    AND pp.student_type = e.student_type
    AND pp.plan_type = e.plan_type
ON CONFLICT (pricing_plan_id, instalment_number) DO NOTHING;