ALTER TABLE students
ADD COLUMN airwallex_customer_id VARCHAR(255) UNIQUE;

ALTER TABLE subscriptions
ADD COLUMN airwallex_payment_consent_id VARCHAR(255) UNIQUE,
ADD COLUMN payment_consent_status VARCHAR(50);
