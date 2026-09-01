import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type Stripe from "stripe";
import { getCheckoutCustomerName } from "../app/services/pennylane";
import {
  getOrderPersistenceErrorDetails,
  persistPaidOrder,
  type OrdersDatabase,
  type OrdersPreparedStatement,
  type PersistOrderInput,
} from "../app/services/orders";

class SQLiteStatementAdapter implements OrdersPreparedStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: Array<string | number | null> = [],
  ) {}

  bind(...values: Array<string | number | null>) {
    return new SQLiteStatementAdapter(this.statement, values);
  }

  async first<T>() {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { results: this.statement.all(...this.values) as T[], success: true };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SQLiteDatabaseAdapter implements OrdersDatabase {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(query: string) {
    return new SQLiteStatementAdapter(this.sqlite.prepare(query));
  }

  async batch(statements: OrdersPreparedStatement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        const result = await statement.run();
        results.push({ success: result.success });
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function migratedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  for (let version = 1; version <= 10; version += 1) {
    const prefix = String(version).padStart(4, "0");
    const migration = [
      "0001_create_orders.sql",
      "0002_create_refund_operations.sql",
      "0003_track_refund_credit_notes.sql",
      "0004_create_stripe_event_registry.sql",
      "0005_add_permanent_stripe_event_failure.sql",
      "0006_harden_refund_operations.sql",
      "0007_create_multi_line_refund_operations.sql",
      "0008_add_order_customer_name.sql",
      "0009_add_shipping_to_orders.sql",
      "0010_add_shipping_refunds.sql",
    ][version - 1];
    assert.ok(migration?.startsWith(prefix));
    sqlite.exec(readFileSync(`migrations/${migration}`, "utf8"));
  }
  return new SQLiteDatabaseAdapter(sqlite);
}

function paidOrder(customerName: string | null): PersistOrderInput {
  return {
    stripeCheckoutSessionId: "cs_test_customerName",
    stripePaymentIntentId: "pi_customerName",
    pennylaneInvoiceId: "invoice-customer-name",
    customerName,
    customerEmail: "customer@example.test",
    currency: "eur",
    amountTotal: 20_000,
    status: "paid",
    schemaVersion: 1,
    createdAt: "2026-08-29T12:00:00.000Z",
    lines: [{
      orderLineId: "11111111-1111-4111-8111-111111111111",
      stripeLineItemId: "li_customerName",
      pennylaneInvoiceLineId: "invoice-line-customer-name",
      catalogId: "hollow-cross",
      sizeFr: "58",
      quantity: 1,
      unitAmount: 20_000,
    }],
  };
}

function storedName(db: SQLiteDatabaseAdapter) {
  return db.sqlite.prepare("SELECT customer_name FROM orders").get() as {
    customer_name: string | null;
  };
}

test("migration 0008 adds a nullable customer_name without rebuilding orders", () => {
  const db = migratedDatabase();
  const columns = db.sqlite.prepare("PRAGMA table_info(orders)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const customerName = columns.find((column) => column.name === "customer_name");
  assert.deepEqual(customerName && { name: customerName.name, notnull: customerName.notnull }, {
    name: "customer_name",
    notnull: 0,
  });
});

test("Stripe individual_name is preferred and billing-style name is only a fallback", () => {
  const details = {
    individual_name: "  Vincent Gerard  ",
    name: "Different Billing Name",
  } as Stripe.Checkout.Session.CustomerDetails;
  assert.equal(getCheckoutCustomerName(details), "Vincent Gerard");
  assert.equal(getCheckoutCustomerName({
    individual_name: null,
    name: "  Historical Name  ",
  } as Stripe.Checkout.Session.CustomerDetails), "Historical Name");
});

test("a new paid order persists the trimmed Stripe customer name", async () => {
  const db = migratedDatabase();
  const result = await persistPaidOrder(db, paidOrder("  Vincent Gerard  "));
  assert.equal(result.status, "created");
  assert.equal(storedName(db).customer_name, "Vincent Gerard");
});

test("an empty Stripe customer name is persisted as NULL", async () => {
  const db = migratedDatabase();
  await persistPaidOrder(db, paidOrder("   "));
  assert.equal(storedName(db).customer_name, null);
});

test("a historical NULL name remains compatible and is not silently backfilled on replay", async () => {
  const db = migratedDatabase();
  await persistPaidOrder(db, paidOrder(null));
  const replay = await persistPaidOrder(db, paidOrder("Vincent Gerard"));
  assert.equal(replay.status, "already_exists");
  assert.equal(storedName(db).customer_name, null);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get()?.count, 1);
});

test("order persistence rejects a non-canonical UTC created_at timestamp", async () => {
  const db = migratedDatabase();
  const input = { ...paidOrder("Vincent Gerard"), createdAt: "2026-08-29T14:00:00+02:00" };
  await assert.rejects(
    persistPaidOrder(db, input),
    (error) => getOrderPersistenceErrorDetails(error).conflicting_fields?.includes("created_at") === true,
  );
});
