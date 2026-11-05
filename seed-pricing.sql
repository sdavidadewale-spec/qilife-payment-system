INSERT INTO pricing_plans (
    course_id,
    student_type,
    plan_type,
    admin_fee_rate,
    gst_rate,
    total_amount,
    instalment_count
)
SELECT
    c.id,
    v.student_type,
    v.plan_type,
    v.admin_fee_rate,
    v.gst_rate,
    v.total_amount,
    v.instalment_count
FROM (
    VALUES
    ('Professional Certificate Program', 'local', 'full', 0, 9, 13080, 1),
    ('Professional Certificate Program', 'local', 'three_part', 4, 9, 13603.20, 3),
    ('Professional Certificate Program', 'local', 'six_part', 5, 9, 13734, 6),

    ('Professional Certificate Program', 'international', 'full', 0, 0, 12000, 1),
    ('Professional Certificate Program', 'international', 'three_part', 4, 0, 12480, 3),
    ('Professional Certificate Program', 'international', 'six_part', 5, 0, 12600, 6),

    ('Advanced Diploma Program', 'local', 'full', 0, 9, 21800, 1),
    ('Advanced Diploma Program', 'local', 'three_part', 4, 9, 22672, 3),
    ('Advanced Diploma Program', 'local', 'six_part', 5, 9, 22890, 6),

    ('Advanced Diploma Program', 'international', 'full', 0, 0, 20000, 1),
    ('Advanced Diploma Program', 'international', 'three_part', 4, 0, 20800, 3),
    ('Advanced Diploma Program', 'international', 'six_part', 5, 0, 21000, 6),

    ('Master Practitioner Program', 'local', 'full', 0, 9, 27250, 1),
    ('Master Practitioner Program', 'local', 'three_part', 4, 9, 28340, 3),
    ('Master Practitioner Program', 'local', 'six_part', 5, 9, 28612.50, 6),

    ('Master Practitioner Program', 'international', 'full', 0, 0, 25000, 1),
    ('Master Practitioner Program', 'international', 'three_part', 4, 0, 26000, 3),
    ('Master Practitioner Program', 'international', 'six_part', 5, 0, 26250, 6)
) AS v(
    course_name,
    student_type,
    plan_type,
    admin_fee_rate,
    gst_rate,
    total_amount,
    instalment_count
)
JOIN courses c ON c.name = v.course_name;