CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    airwallex_subscription_id VARCHAR(255) UNIQUE,
    total_amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'SGD',
    total_instalments INTEGER NOT NULL DEFAULT 6,
    paid_instalments INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
    airwallex_payment_id VARCHAR(255) UNIQUE,
    instalment_number INTEGER NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'SGD',
    status VARCHAR(50) DEFAULT 'pending',
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Store the available courses
CREATE TABLE courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,
    duration_months INTEGER NOT NULL,
    base_fee NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'SGD'
);

-- Store prices for each course and payment option
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

-- Store the exact amount for each instalment
CREATE TABLE pricing_plan_installments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pricing_plan_id UUID REFERENCES pricing_plans(id)
        ON DELETE CASCADE,
    instalment_number INTEGER NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    UNIQUE (pricing_plan_id, instalment_number)
);

-- Link the existing subscriptions table to a pricing plan
ALTER TABLE subscriptions
ADD COLUMN pricing_plan_id UUID REFERENCES pricing_plans(id);