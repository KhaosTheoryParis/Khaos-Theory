PRAGMA foreign_keys = ON;

DROP TRIGGER IF EXISTS refund_operations_reserve_quantity;
DROP TRIGGER IF EXISTS refund_operations_finalize_quantity;
DROP TRIGGER IF EXISTS refund_operations_release_failed_quantity;

CREATE TABLE refund_operations_v4 (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'eur'),
  stripe_idempotency_key TEXT UNIQUE NOT NULL,
  stripe_refund_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  failure_code TEXT,
  pennylane_credit_note_id TEXT UNIQUE,
  credit_note_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (credit_note_status IN ('pending', 'finalized')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE TABLE refund_operation_lines (
  id TEXT PRIMARY KEY,
  refund_operation_id TEXT NOT NULL,
  order_line_id TEXT NOT NULL,
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
  refunded_quantity_before INTEGER NOT NULL CHECK (refunded_quantity_before >= 0),
  unit_amount INTEGER NOT NULL CHECK (unit_amount > 0),
  amount INTEGER NOT NULL CHECK (amount = unit_amount * requested_quantity),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (refund_operation_id, order_line_id),
  FOREIGN KEY (refund_operation_id) REFERENCES refund_operations_v4(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (order_line_id) REFERENCES order_lines(order_line_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

INSERT INTO refund_operations_v4 (
  id, order_id, amount, currency, stripe_idempotency_key,
  stripe_refund_id, status, failure_code, pennylane_credit_note_id,
  credit_note_status, created_at, updated_at
)
SELECT
  ro.id, ol.order_id, ro.amount, ro.currency, ro.stripe_idempotency_key,
  ro.stripe_refund_id, ro.status, ro.failure_code, ro.pennylane_credit_note_id,
  ro.credit_note_status, ro.created_at, ro.updated_at
FROM refund_operations ro
INNER JOIN order_lines ol ON ol.order_line_id = ro.order_line_id;

INSERT INTO refund_operation_lines (
  id, refund_operation_id, order_line_id, requested_quantity,
  refunded_quantity_before, unit_amount, amount, created_at, updated_at
)
SELECT
  ro.id || ':' || ro.order_line_id,
  ro.id,
  ro.order_line_id,
  ro.requested_quantity,
  ro.refunded_quantity_before,
  ro.amount / ro.requested_quantity,
  ro.amount,
  ro.created_at,
  ro.updated_at
FROM refund_operations ro;

DROP TABLE refund_operations;
ALTER TABLE refund_operations_v4 RENAME TO refund_operations;

CREATE INDEX idx_refund_operations_order_id
  ON refund_operations(order_id);
CREATE INDEX idx_refund_operations_stripe_refund_id
  ON refund_operations(stripe_refund_id);
CREATE INDEX idx_refund_operations_status
  ON refund_operations(status);
CREATE INDEX idx_refund_operation_lines_operation_id
  ON refund_operation_lines(refund_operation_id);
CREATE INDEX idx_refund_operation_lines_order_line_id
  ON refund_operation_lines(order_line_id);

CREATE TRIGGER refund_operation_lines_reserve_quantity
BEFORE INSERT ON refund_operation_lines
FOR EACH ROW
BEGIN
  SELECT (
    CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM refund_operations ro
      INNER JOIN order_lines ol ON ol.order_line_id = NEW.order_line_id
      WHERE ro.id = NEW.refund_operation_id
        AND ro.status = 'pending'
        AND ro.order_id = ol.order_id
        AND ol.refunded_quantity = NEW.refunded_quantity_before
        AND ol.unit_amount = NEW.unit_amount
        AND ol.refunded_quantity + ol.reserved_refund_quantity
          + NEW.requested_quantity <= ol.quantity
    )
    THEN RAISE(ABORT, 'REFUND_QUANTITY_UNAVAILABLE')
    END
  );

  UPDATE order_lines
  SET reserved_refund_quantity = reserved_refund_quantity + NEW.requested_quantity,
      updated_at = NEW.updated_at
  WHERE order_line_id = NEW.order_line_id;
END;

CREATE TRIGGER refund_operations_finalize_quantities
BEFORE UPDATE OF status ON refund_operations
FOR EACH ROW
WHEN OLD.status = 'pending' AND NEW.status = 'succeeded'
BEGIN
  SELECT (
    CASE
    WHEN NEW.stripe_refund_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM refund_operation_lines
        WHERE refund_operation_id = OLD.id
      )
      OR EXISTS (
        SELECT 1
        FROM refund_operation_lines rol
        LEFT JOIN order_lines ol ON ol.order_line_id = rol.order_line_id
        WHERE rol.refund_operation_id = OLD.id
          AND (
            ol.order_line_id IS NULL
            OR ol.refunded_quantity <> rol.refunded_quantity_before
            OR ol.reserved_refund_quantity < rol.requested_quantity
            OR ol.refunded_quantity + rol.requested_quantity > ol.quantity
          )
      )
    THEN RAISE(ABORT, 'REFUND_FINALIZATION_CONFLICT')
    END
  );

  UPDATE order_lines
  SET refunded_quantity = refunded_quantity + (
        SELECT requested_quantity
        FROM refund_operation_lines
        WHERE refund_operation_id = OLD.id
          AND order_line_id = order_lines.order_line_id
      ),
      reserved_refund_quantity = reserved_refund_quantity - (
        SELECT requested_quantity
        FROM refund_operation_lines
        WHERE refund_operation_id = OLD.id
          AND order_line_id = order_lines.order_line_id
      ),
      updated_at = NEW.updated_at
  WHERE order_line_id IN (
    SELECT order_line_id
    FROM refund_operation_lines
    WHERE refund_operation_id = OLD.id
  );
END;

CREATE TRIGGER refund_operations_release_failed_quantities
BEFORE UPDATE OF status ON refund_operations
FOR EACH ROW
WHEN OLD.status = 'pending' AND NEW.status = 'failed'
BEGIN
  SELECT (
    CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM refund_operation_lines
      WHERE refund_operation_id = OLD.id
    )
      OR EXISTS (
        SELECT 1
        FROM refund_operation_lines rol
        LEFT JOIN order_lines ol ON ol.order_line_id = rol.order_line_id
        WHERE rol.refund_operation_id = OLD.id
          AND (
            ol.order_line_id IS NULL
            OR ol.reserved_refund_quantity < rol.requested_quantity
          )
      )
    THEN RAISE(ABORT, 'REFUND_FAILURE_RELEASE_CONFLICT')
    END
  );

  UPDATE order_lines
  SET reserved_refund_quantity = reserved_refund_quantity - (
        SELECT requested_quantity
        FROM refund_operation_lines
        WHERE refund_operation_id = OLD.id
          AND order_line_id = order_lines.order_line_id
      ),
      updated_at = NEW.updated_at
  WHERE order_line_id IN (
    SELECT order_line_id
    FROM refund_operation_lines
    WHERE refund_operation_id = OLD.id
  );
END;
