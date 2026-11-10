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

-- Public checkout links
CREATE TABLE checkout_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(150) NOT NULL UNIQUE,
    pricing_plan_id UUID NOT NULL UNIQUE
        REFERENCES pricing_plans(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Student subscriptions
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    pricing_plan_id UUID REFERENCES pricing_plans(id),
    enrollment_request_id VARCHAR(64),
    airwallex_subscription_id VARCHAR(255) UNIQUE,
    airwallex_payment_consent_id VARCHAR(255) UNIQUE,
    airwallex_payment_method_id VARCHAR(255),
    airwallex_payment_method_type VARCHAR(50),
    payment_consent_status VARCHAR(50),
    payment_consent_text TEXT,
    payment_consent_version VARCHAR(100),
    payment_consent_accepted_at TIMESTAMPTZ,
    payment_consent_ip TEXT,
    payment_consent_user_agent TEXT,
    checkout_token_hash VARCHAR(255) UNIQUE,
    checkout_token_expires_at TIMESTAMP,
    total_amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'SGD',
    total_instalments INTEGER NOT NULL DEFAULT 6,
    paid_instalments INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX subscriptions_enrollment_request_id_unique
ON subscriptions (enrollment_request_id)
WHERE enrollment_request_id IS NOT NULL;

-- 6. Payments
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID REFERENCES subscriptions(id)
        ON DELETE CASCADE,
    airwallex_payment_id VARCHAR(255) UNIQUE,
    airwallex_create_request_id VARCHAR(64),
    airwallex_confirm_request_id VARCHAR(64),
    airwallex_payment_intent_status VARCHAR(50),
    airwallex_payment_intent_updated_at TIMESTAMPTZ,
    instalment_number INTEGER NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'SGD',
    status VARCHAR(50) DEFAULT 'pending',
    due_date DATE,
    payment_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    processing_started_at TIMESTAMP,
    airwallex_confirmation_requested_at TIMESTAMPTZ,
    payment_consent_start_date DATE,
    next_retry_at TIMESTAMPTZ,
    manual_review_required BOOLEAN NOT NULL DEFAULT FALSE,
    manual_review_reason TEXT,
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX payments_subscription_instalment_unique_idx
ON payments (subscription_id, instalment_number);

CREATE UNIQUE INDEX payments_airwallex_create_request_id_unique_idx
ON payments (airwallex_create_request_id)
WHERE airwallex_create_request_id IS NOT NULL;

CREATE UNIQUE INDEX payments_airwallex_confirm_request_id_unique_idx
ON payments (airwallex_confirm_request_id)
WHERE airwallex_confirm_request_id IS NOT NULL;

-- 7. Airwallex PaymentIntent history
CREATE TABLE airwallex_payment_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id)
        ON DELETE CASCADE,
    airwallex_payment_intent_id VARCHAR(255) NOT NULL UNIQUE,
    request_id VARCHAR(255) UNIQUE,
    status VARCHAR(50),
    airwallex_updated_at TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX airwallex_payment_intents_payment_idx
ON airwallex_payment_intents (payment_id);

-- 8. Airwallex payment attempts
CREATE TABLE airwallex_payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    request_id VARCHAR(255) UNIQUE,
    airwallex_payment_intent_id VARCHAR(255),
    airwallex_payment_attempt_id VARCHAR(255) UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    airwallex_created_at TIMESTAMPTZ,
    airwallex_updated_at TIMESTAMPTZ,
    failure_code VARCHAR(255),
    merchant_advice_code VARCHAR(100),
    issuer_response_code VARCHAR(20),
    failure_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    CONSTRAINT payment_attempt_number_positive CHECK (attempt_number > 0),
    CONSTRAINT payment_attempt_unique_number UNIQUE (payment_id, attempt_number)
);

CREATE INDEX airwallex_payment_attempts_payment_idx
ON airwallex_payment_attempts (payment_id);

CREATE INDEX airwallex_payment_attempts_status_idx
ON airwallex_payment_attempts (status);

CREATE INDEX payments_pending_due_date_idx
ON payments (due_date, subscription_id, instalment_number)
WHERE status = 'pending'
  AND due_date IS NOT NULL;

-- 8. Airwallex webhook events
CREATE TABLE webhook_events (
    event_id VARCHAR(255) PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- 9. Payments requiring manual review
CREATE TABLE payment_review_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(255) NOT NULL UNIQUE
        REFERENCES webhook_events(event_id),
    payment_id UUID NOT NULL REFERENCES payments(id),
    airwallex_payment_intent_id VARCHAR(255) NOT NULL,
    reason TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending_review',
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX payment_review_events_payment_idx
ON payment_review_events (payment_id);
