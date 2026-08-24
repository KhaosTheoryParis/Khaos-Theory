DROP TRIGGER IF EXISTS refund_operations_reserve_quantity;
DROP TRIGGER IF EXISTS refund_operations_finalize_quantity;

CREATE TABLE refund_operations_v2 (
  id TEXT PRIMARY KEY,
  order_line_id TEXT NOT NULL,
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
  refunded_quantity_before INTEGER NOT NULL CHECK (refunded_quantity_before >= 0),
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'eur'),
  stripe_idempotency_key TEXT UNIQUE NOT NULL,
  stripe_refund_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  pennylane_credit_note_id TEXT UNIQUE,
  credit_note_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (credit_note_status IN ('pending', 'finalized')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_line_id, requested_quantity),
  FOREIGN KEY (order_line_id) REFERENCES order_lines(order_line_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

INSERT INTO refund_operations_v2 (
  id, order_line_id, requested_quantity, refunded_quantity_before,
  amount, currency, stripe_idempotency_key, stripe_refund_id,
  status, created_at, updated_at
)
SELECT
  id, order_line_id, requested_quantity, refunded_quantity_before,
  amount, currency, stripe_idempotency_key, stripe_refund_id,
  status, created_at, updated_at
FROM refund_operations;

DROP TABLE refund_operations;
ALTER TABLE refund_operations_v2 RENAME TO refund_operations;

CREATE INDEX idx_refund_operations_order_line_id
  ON refund_operations(order_line_id);
CREATE INDEX idx_refund_operations_stripe_refund_id
  ON refund_operations(stripe_refund_id);
CREATE INDEX idx_refund_operations_status
  ON refund_operations(status);

CREATE TRIGGER refund_operations_reserve_quantity
BEFORE INSERT ON refund_operations
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM order_lines
      WHERE order_line_id = NEW.order_line_id
        AND refunded_quantity = NEW.refunded_quantity_before
        AND refunded_quantity + reserved_refund_quantity + NEW.requested_quantity <= quantity
    )
    THEN RAISE(ABORT, 'REFUND_QUANTITY_UNAVAILABLE')
  END;

  UPDATE order_lines
  SET reserved_refund_quantity = reserved_refund_quantity + NEW.requested_quantity,
      updated_at = NEW.updated_at
  WHERE order_line_id = NEW.order_line_id;
END;

CREATE TRIGGER refund_operations_finalize_quantity
BEFORE UPDATE OF status ON refund_operations
FOR EACH ROW
WHEN OLD.status = 'pending' AND NEW.status = 'succeeded'
BEGIN
  SELECT CASE
    WHEN NEW.stripe_refund_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM order_lines
        WHERE order_line_id = OLD.order_line_id
          AND refunded_quantity = OLD.refunded_quantity_before
          AND reserved_refund_quantity >= OLD.requested_quantity
          AND refunded_quantity + OLD.requested_quantity <= quantity
      )
    THEN RAISE(ABORT, 'REFUND_FINALIZATION_CONFLICT')
  END;

  UPDATE order_lines
  SET refunded_quantity = refunded_quantity + OLD.requested_quantity,
      reserved_refund_quantity = reserved_refund_quantity - OLD.requested_quantity,
      updated_at = NEW.updated_at
  WHERE order_line_id = OLD.order_line_id;
END;

CREATE TRIGGER refund_operations_release_failed_quantity
BEFORE UPDATE OF status ON refund_operations
FOR EACH ROW
WHEN OLD.status = 'pending' AND NEW.status = 'failed'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM order_lines
      WHERE order_line_id = OLD.order_line_id
        AND reserved_refund_quantity >= OLD.requested_quantity
    )
    THEN RAISE(ABORT, 'REFUND_FAILURE_RELEASE_CONFLICT')
  END;

  UPDATE order_lines
  SET reserved_refund_quantity = reserved_refund_quantity - OLD.requested_quantity,
      updated_at = NEW.updated_at
  WHERE order_line_id = OLD.order_line_id;
END;
