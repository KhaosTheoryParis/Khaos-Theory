ALTER TABLE orders
  ADD COLUMN terms_version TEXT NULL;

ALTER TABLE orders
  ADD COLUMN terms_accepted_at TEXT NULL
  CHECK (
    (terms_version IS NULL AND terms_accepted_at IS NULL)
    OR (terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL)
  );
