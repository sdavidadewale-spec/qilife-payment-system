ALTER TABLE courses
ADD COLUMN airwallex_product_id VARCHAR(255) UNIQUE;

UPDATE courses
SET airwallex_product_id = 'prd_sgpdcvb7lhntaf8xtjb'
WHERE name = 'Professional Certificate Program';