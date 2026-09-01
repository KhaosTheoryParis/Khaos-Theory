ALTER TABLE orders
  ADD COLUMN shipping_refunded_amount INTEGER NULL
  CHECK (
    shipping_refunded_amount IS NULL
    OR shipping_refunded_amount >= 0
  );

ALTER TABLE orders
  ADD COLUMN reserved_shipping_refund_amount INTEGER NULL
  CHECK (
    reserved_shipping_refund_amount IS NULL
    OR reserved_shipping_refund_amount >= 0
  );

ALTER TABLE refund_operations
  ADD COLUMN shipping_refund_amount INTEGER NULL
  CHECK (
    shipping_refund_amount IS NULL
    OR shipping_refund_amount >= 0
  );

CREATE TRIGGER refund_operations_reserve_shipping
BEFORE INSERT ON refund_operations
FOR EACH ROW
WHEN COALESCE(NEW.shipping_refund_amount, 0) > 0
BEGIN
  SELECT (
    CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM orders
      WHERE id = NEW.order_id
        AND shipping_amount IS NOT NULL
        AND shipping_amount > 0
        AND COALESCE(shipping_refunded_amount, 0)
          + COALESCE(reserved_shipping_refund_amount, 0)
          + NEW.shipping_refund_amount <= shipping_amount
    )
    THEN RAISE(ABORT, 'SHIPPING_REFUND_AMOUNT_UNAVAILABLE')
    END
  );

  UPDATE orders
  SET reserved_shipping_refund_amount =
        COALESCE(reserved_shipping_refund_amount, 0) + NEW.shipping_refund_amount,
      updated_at = NEW.updated_at
  WHERE id = NEW.order_id;
END;

DROP TRIGGER refund_operations_finalize_quantities;

CREATE TRIGGER refund_operations_finalize_quantities
BEFORE UPDATE OF status ON refund_operations
FOR EACH ROW
WHEN OLD.status = 'pending' AND NEW.status = 'succeeded'
BEGIN
  SELECT (
    CASE
    WHEN NEW.stripe_refund_id IS NULL
      OR (
        NOT EXISTS (
          SELECT 1 FROM refund_operation_lines
          WHERE refund_operation_id = OLD.id
        )
        AND COALESCE(OLD.shipping_refund_amount, 0) = 0
      )
      OR NEW.amount <> COALESCE(OLD.shipping_refund_amount, 0) + COALESCE((
        SELECT SUM(amount)
        FROM refund_operation_lines
        WHERE refund_operation_id = OLD.id
      ), 0)
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
      OR (
        COALESCE(OLD.shipping_refund_amount, 0) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM orders
          WHERE id = OLD.order_id
            AND shipping_amount IS NOT NULL
            AND COALESCE(reserved_shipping_refund_amount, 0)
              >= OLD.shipping_refund_amount
            AND COALESCE(shipping_refunded_amount, 0)
              + OLD.shipping_refund_amount <= shipping_amount
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

  UPDATE orders
  SET shipping_refunded_amount =
        COALESCE(shipping_refunded_amount, 0) + OLD.shipping_refund_amount,
      reserved_shipping_refund_amount =
        COALESCE(reserved_shipping_refund_amount, 0) - OLD.shipping_refund_amount,
      updated_at = NEW.updated_at
  WHERE id = OLD.order_id
    AND COALESCE(OLD.shipping_refund_amount, 0) > 0;
END;

DROP TRIGGER refund_operations_release_failed_quantities;

CREATE TRIGGER refund_operations_release_failed_quantities
BEFORE UPDATE OF status ON refund_operations
FOR EACH ROW
WHEN OLD.status = 'pending' AND NEW.status = 'failed'
BEGIN
  SELECT (
    CASE
    WHEN (
        NOT EXISTS (
          SELECT 1 FROM refund_operation_lines
          WHERE refund_operation_id = OLD.id
        )
        AND COALESCE(OLD.shipping_refund_amount, 0) = 0
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
      OR (
        COALESCE(OLD.shipping_refund_amount, 0) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM orders
          WHERE id = OLD.order_id
            AND COALESCE(reserved_shipping_refund_amount, 0)
              >= OLD.shipping_refund_amount
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

  UPDATE orders
  SET reserved_shipping_refund_amount =
        COALESCE(reserved_shipping_refund_amount, 0) - OLD.shipping_refund_amount,
      updated_at = NEW.updated_at
  WHERE id = OLD.order_id
    AND COALESCE(OLD.shipping_refund_amount, 0) > 0;
END;
