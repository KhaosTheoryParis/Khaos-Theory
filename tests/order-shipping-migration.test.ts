import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const MIGRATIONS = [
  "0001_create_orders.sql",
  "0002_create_refund_operations.sql",
  "0003_track_refund_credit_notes.sql",
  "0004_create_stripe_event_registry.sql",
  "0005_add_permanent_stripe_event_failure.sql",
  "0006_harden_refund_operations.sql",
  "0007_create_multi_line_refund_operations.sql",
  "0008_add_order_customer_name.sql",
  "0009_add_shipping_to_orders.sql",
] as const;

function applyMigrations(sqlite: DatabaseSync, throughVersion: number = MIGRATIONS.length) {
  for (const migration of MIGRATIONS.slice(0, throughVersion)) {
    sqlite.exec(readFileSync(`migrations/${migration}`, "utf8"));
  }
}

function insertOrder(
  sqlite: DatabaseSync,
  suffix: string,
  shipping: {
    productsSubtotal?: number | null;
    shippingAmount?: number | null;
    shippingCountry?: string | null;
    shippingZone?: string | null;
  } = {},
) {
  sqlite.prepare(
    `INSERT INTO orders (
      id, stripe_checkout_session_id, stripe_payment_intent_id, pennylane_invoice_id,
      customer_email, currency, amount_total, status, schema_version, created_at, updated_at,
      products_subtotal, shipping_amount, shipping_country, shipping_zone
    ) VALUES (?, ?, ?, ?, ?, 'eur', 20000, 'paid', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `11111111-1111-4111-8111-${suffix.padStart(12, "0")}`,
    `cs_test_shipping${suffix}`,
    `pi_shipping${suffix}`,
    `invoice-shipping-${suffix}`,
    `shipping-${suffix}@example.test`,
    "2026-08-30T12:00:00.000Z",
    "2026-08-30T12:00:00.000Z",
    shipping.productsSubtotal ?? null,
    shipping.shippingAmount ?? null,
    shipping.shippingCountry ?? null,
    shipping.shippingZone ?? null,
  );
}

test("migration 0009 preserves historical orders with NULL shipping fields", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, 8);
  sqlite.prepare(
    `INSERT INTO orders (
      id, stripe_checkout_session_id, stripe_payment_intent_id, pennylane_invoice_id,
      customer_email, currency, amount_total, status, schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'eur', 20000, 'paid', 1, ?, ?)`,
  ).run(
    "11111111-1111-4111-8111-000000000001",
    "cs_test_historicalShipping",
    "pi_historicalShipping",
    "invoice-historical-shipping",
    "historical@example.test",
    "2026-08-29T12:00:00.000Z",
    "2026-08-29T12:00:00.000Z",
  );

  sqlite.exec(readFileSync("migrations/0009_add_shipping_to_orders.sql", "utf8"));
  const historical = sqlite.prepare(
    `SELECT products_subtotal, shipping_amount, shipping_country, shipping_zone
     FROM orders WHERE stripe_checkout_session_id = ?`,
  ).get("cs_test_historicalShipping") as Record<string, unknown>;
  assert.equal(historical.products_subtotal, null);
  assert.equal(historical.shipping_amount, null);
  assert.equal(historical.shipping_country, null);
  assert.equal(historical.shipping_zone, null);
});

test("migration 0009 keeps every shipping column nullable without a default", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const columns = sqlite.prepare("PRAGMA table_info(orders)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | number | null;
  }>;

  for (const name of ["products_subtotal", "shipping_amount", "shipping_country", "shipping_zone"]) {
    const column = columns.find((candidate) => candidate.name === name);
    assert.deepEqual(
      column && { notnull: column.notnull, defaultValue: column.dflt_value },
      { notnull: 0, defaultValue: null },
    );
  }
});

test("migration 0009 rejects a negative products subtotal", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  assert.throws(
    () => insertOrder(sqlite, "2", { productsSubtotal: -1 }),
    /CHECK constraint failed/,
  );
});

test("migration 0009 rejects a negative shipping amount", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  assert.throws(
    () => insertOrder(sqlite, "3", { shippingAmount: -1 }),
    /CHECK constraint failed/,
  );
});

test("migration 0009 accepts every known shipping zone", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);

  for (const [index, shippingZone] of ["FR", "EU", "JP", "KR"].entries()) {
    insertOrder(sqlite, String(index + 4), { shippingCountry: "FR", shippingZone });
  }

  const zones = sqlite.prepare("SELECT shipping_zone FROM orders ORDER BY shipping_zone").all()
    .map((row) => row.shipping_zone);
  assert.deepEqual(zones, ["EU", "FR", "JP", "KR"]);
});

test("migration 0009 rejects the unsupported WORLD shipping zone", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  assert.throws(
    () => insertOrder(sqlite, "8", { shippingZone: "WORLD" }),
    /CHECK constraint failed/,
  );
});

test("migration 0009 accepts an explicit NULL shipping zone", () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  insertOrder(sqlite, "9", { shippingZone: null });
  assert.equal(
    sqlite.prepare("SELECT shipping_zone FROM orders WHERE stripe_checkout_session_id = ?")
      .get("cs_test_shipping9")?.shipping_zone,
    null,
  );
});
