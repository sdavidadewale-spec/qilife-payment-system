-- QiLife Payment System Database

-- 1. Students
CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(50),
    airwallex_customer_id VARCHAR(255) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Courses
CREATE TABLE courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,
    duration_months INTEGER NOT NULL,
    base_fee NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'SGD',
    airwallex_product_id VARCHAR(255) UNIQUE
);

INSERT INTO courses (
    name,
    duration_months,
    base_fee,
    currency,
    airwallex_product_id
)
VALUES
(
    'Professional Certificate Program',
    12,
    12000.00,
    'SGD',
    'prd_sgpdcvb7lhntaf8xtjb'
),
(
    'Advanced Diploma Program',
    24,
    20000.00,
    'SGD',
    'prd_sgpdcvb7lhnukpt06d7'
),
(
    'Master Practitioner Program',
    36,
    25000.00,
    'SGD',
    'prd_sgpd6jww9hnukptcbte'
);

-- 3. Pricing plans
CREATE TABLE pricing_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID REFERENCES courses(id),
    student_type VARCHAR(20) NOT NULL
        CHECK (student_type IN ('local', 'international')),
    plan_type VARCHAR(20) NOT NULL
        CHECK (plan_type IN ('full', 'three_part', 'six_part')),
    admin_fee_rate NUMERIC(5, 2) DEFAULT 0,
    gst_rate NUMERIC(5, 2) DEFAULT 0,
    total_amount NUMERIC(12, 2) NOT NULL,
    instalment_count INTEGER NOT NULL,
    UNIQUE (course_id, student_type, plan_type)
);

-- 4. Pricing plan instalments
CREATE TABLE pricing_plan_installments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pricing_plan_id UUID REFERENCES pricing_plans(id)
        ON DELETE CASCADE,
    instalment_number INTEGER NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    UNIQUE (pricing_plan_id, instalment_number)
);

-- 5. Student subscriptions
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    pricing_plan_id UUID REFERENCES pricing_plans(id),
    airwallex_subscription_id VARCHAR(255) UNIQUE,
    airwallex_payment_consent_id VARCHAR(255) UNIQUE,
    payment_consent_status VARCHAR(50),
    checkout_token_hash VARCHAR(255) UNIQUE,
    checkout_token_expires_at TIMESTAMP,
    total_amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'SGD',
    total_instalments INTEGER NOT NULL DEFAULT 6,
    paid_instalments INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Payments
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID REFERENCES subscriptions(id)
        ON DELETE CASCADE,
    airwallex_payment_id VARCHAR(255) UNIQUE,
    instalment_number INTEGER NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'SGD',
    status VARCHAR(50) DEFAULT 'pending',
    due_date DATE,
    payment_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Airwallex webhook events
CREATE TABLE webhook_events (
    event_id VARCHAR(255) PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);