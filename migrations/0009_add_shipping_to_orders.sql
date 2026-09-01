ALTER TABLE orders
  ADD COLUMN products_subtotal INTEGER NULL
  CHECK (products_subtotal IS NULL OR products_subtotal >= 0);

ALTER TABLE orders
  ADD COLUMN shipping_amount INTEGER NULL
  CHECK (shipping_amount IS NULL OR shipping_amount >= 0);

ALTER TABLE orders
  ADD COLUMN shipping_country TEXT NULL;

ALTER TABLE orders
  ADD COLUMN shipping_zone TEXT NULL
  CHECK (
    shipping_zone IS NULL
    OR shipping_zone IN ('FR', 'EU', 'JP', 'KR')
  );
