PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  stripe_checkout_session_id TEXT UNIQUE NOT NULL,
  stripe_payment_intent_id TEXT UNIQUE NOT NULL,
  pennylane_invoice_id TEXT UNIQUE NOT NULL,
  customer_email TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_total INTEGER NOT NULL CHECK (amount_total >= 0),
  status TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  order_line_id TEXT UNIQUE NOT NULL,
  stripe_line_item_id TEXT UNIQUE NOT NULL,
  pennylane_invoice_line_id TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  size_fr INTEGER NOT NULL CHECK (size_fr BETWEEN 48 AND 70),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_amount INTEGER NOT NULL CHECK (unit_amount >= 0),
  refunded_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (refunded_quantity >= 0 AND refunded_quantity <= quantity),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_orders_stripe_checkout_session_id
  ON orders(stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_payment_intent_id
  ON orders(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_orders_pennylane_invoice_id
  ON orders(pennylane_invoice_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_order_line_id
  ON order_lines(order_line_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_stripe_line_item_id
  ON order_lines(stripe_line_item_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_order_id
  ON order_lines(order_id);
