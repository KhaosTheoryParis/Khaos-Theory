type D1Bindable = string | number | null;

type D1QueryResult<T> = {
  results: T[];
  success: boolean;
};

export type OrdersPreparedStatement = {
  bind(...values: D1Bindable[]): OrdersPreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1QueryResult<T>>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
};

export type OrdersDatabase = {
  prepare(query: string): OrdersPreparedStatement;
  batch(statements: OrdersPreparedStatement[]): Promise<Array<{ success: boolean }>>;
};

export type PersistedOrderLineInput = {
  orderLineId: string;
  stripeLineItemId: string;
  pennylaneInvoiceLineId: string;
  catalogId: string;
  sizeFr: string;
  quantity: number;
  unitAmount: number;
};

export type PersistOrderInput = {
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string;
  pennylaneInvoiceId: string;
  customerName: string | null;
  customerEmail: string;
  currency: string;
  amountTotal: number;
  status: "paid";
  schemaVersion: 1;
  createdAt: string;
  lines: PersistedOrderLineInput[];
};

type OrderRow = {
  id: string;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string;
  pennylane_invoice_id: string;
  customer_name: string | null;
  customer_email: string;
  currency: string;
  amount_total: number;
  status: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
};

type OrderLineRow = {
  id: string;
  order_id: string;
  order_line_id: string;
  stripe_line_item_id: string;
  pennylane_invoice_line_id: string;
  catalog_id: string;
  size_fr: number;
  quantity: number;
  unit_amount: number;
  refunded_quantity: number;
  created_at: string;
  updated_at: string;
};

type OrderPersistenceErrorDetails = {
  code: string;
  conflicting_fields?: string[];
};

class OrderPersistenceError extends Error {
  readonly details: OrderPersistenceErrorDetails;

  constructor(details: OrderPersistenceErrorDetails) {
    super(details.code);
    this.name = "OrderPersistenceError";
    this.details = details;
  }
}

export function normalizeCustomerName(value: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function assertValidInput(input: PersistOrderInput) {
  const invalidFields: string[] = [];

  if (!/^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(input.stripeCheckoutSessionId)) {
    invalidFields.push("stripe_checkout_session_id");
  }
  if (!/^pi_[A-Za-z0-9]+$/.test(input.stripePaymentIntentId)) {
    invalidFields.push("stripe_payment_intent_id");
  }
  if (!input.pennylaneInvoiceId.trim()) invalidFields.push("pennylane_invoice_id");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.customerEmail)) {
    invalidFields.push("customer_email");
  }
  if (!/^[a-z]{3}$/.test(input.currency)) invalidFields.push("currency");
  if (!Number.isInteger(input.amountTotal) || input.amountTotal < 0) {
    invalidFields.push("amount_total");
  }
  if (input.status !== "paid") invalidFields.push("status");
  if (input.schemaVersion !== 1) invalidFields.push("schema_version");
  const createdAt = Date.parse(input.createdAt);
  if (
    Number.isNaN(createdAt) ||
    !input.createdAt.endsWith("Z") ||
    new Date(createdAt).toISOString() !== input.createdAt
  ) invalidFields.push("created_at");
  if (input.lines.length === 0) invalidFields.push("lines");

  const orderLineIds = new Set<string>();
  const stripeLineItemIds = new Set<string>();
  const pennylaneLineIds = new Set<string>();
  let computedTotal = 0;

  for (const [index, line] of input.lines.entries()) {
    const prefix = `lines.${index}`;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(line.orderLineId)) {
      invalidFields.push(`${prefix}.order_line_id`);
    }
    if (!/^li_[A-Za-z0-9]+$/.test(line.stripeLineItemId)) {
      invalidFields.push(`${prefix}.stripe_line_item_id`);
    }
    if (!line.pennylaneInvoiceLineId.trim()) {
      invalidFields.push(`${prefix}.pennylane_invoice_line_id`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(line.catalogId)) {
      invalidFields.push(`${prefix}.catalog_id`);
    }

    const sizeFr = Number(line.sizeFr);
    if (!Number.isInteger(sizeFr) || sizeFr < 48 || sizeFr > 70) {
      invalidFields.push(`${prefix}.size_fr`);
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      invalidFields.push(`${prefix}.quantity`);
    }
    if (!Number.isInteger(line.unitAmount) || line.unitAmount < 0) {
      invalidFields.push(`${prefix}.unit_amount`);
    }

    if (orderLineIds.has(line.orderLineId)) invalidFields.push(`${prefix}.order_line_id_duplicate`);
    if (stripeLineItemIds.has(line.stripeLineItemId)) {
      invalidFields.push(`${prefix}.stripe_line_item_id_duplicate`);
    }
    if (pennylaneLineIds.has(line.pennylaneInvoiceLineId)) {
      invalidFields.push(`${prefix}.pennylane_invoice_line_id_duplicate`);
    }

    orderLineIds.add(line.orderLineId);
    stripeLineItemIds.add(line.stripeLineItemId);
    pennylaneLineIds.add(line.pennylaneInvoiceLineId);
    computedTotal += line.quantity * line.unitAmount;
  }

  if (computedTotal !== input.amountTotal) invalidFields.push("lines.amount_total");

  if (invalidFields.length > 0) {
    throw new OrderPersistenceError({
      code: "INVALID_ORDER_PERSISTENCE_INPUT",
      conflicting_fields: invalidFields,
    });
  }
}

async function findOrderByReferences(db: OrdersDatabase, input: PersistOrderInput) {
  const result = await db
    .prepare(
      `SELECT * FROM orders
       WHERE stripe_checkout_session_id = ?1
          OR stripe_payment_intent_id = ?2
          OR pennylane_invoice_id = ?3`,
    )
    .bind(
      input.stripeCheckoutSessionId,
      input.stripePaymentIntentId,
      input.pennylaneInvoiceId,
    )
    .all<OrderRow>();

  if (!result.success) {
    throw new OrderPersistenceError({ code: "ORDER_LOOKUP_FAILED" });
  }

  if (result.results.length > 1) {
    throw new OrderPersistenceError({ code: "ORDER_REFERENCES_MATCH_MULTIPLE_ROWS" });
  }

  return result.results[0];
}

async function verifyExistingOrder(
  db: OrdersDatabase,
  input: PersistOrderInput,
  order: OrderRow,
) {
  const conflictingFields: string[] = [];
  const immutableOrderFields: Array<[string, string | number, string | number]> = [
    ["stripe_checkout_session_id", order.stripe_checkout_session_id, input.stripeCheckoutSessionId],
    ["stripe_payment_intent_id", order.stripe_payment_intent_id, input.stripePaymentIntentId],
    ["pennylane_invoice_id", order.pennylane_invoice_id, input.pennylaneInvoiceId],
    ["customer_email", order.customer_email, input.customerEmail],
    ["currency", order.currency, input.currency],
    ["amount_total", order.amount_total, input.amountTotal],
    ["schema_version", order.schema_version, input.schemaVersion],
    ["created_at", order.created_at, input.createdAt],
  ];

  if (
    order.customer_name !== null &&
    input.customerName !== null &&
    order.customer_name !== input.customerName
  ) conflictingFields.push("customer_name");

  for (const [field, actual, expected] of immutableOrderFields) {
    if (actual !== expected) conflictingFields.push(field);
  }

  const lineResult = await db
    .prepare("SELECT * FROM order_lines WHERE order_id = ?1 ORDER BY order_line_id")
    .bind(order.id)
    .all<OrderLineRow>();

  if (!lineResult.success) {
    throw new OrderPersistenceError({ code: "ORDER_LINES_LOOKUP_FAILED" });
  }

  if (lineResult.results.length !== input.lines.length) {
    conflictingFields.push("order_lines.length");
  }

  const expectedByOrderLineId = new Map(input.lines.map((line) => [line.orderLineId, line]));

  for (const row of lineResult.results) {
    const expected = expectedByOrderLineId.get(row.order_line_id);

    if (!expected) {
      conflictingFields.push(`order_lines.${row.order_line_id}`);
      continue;
    }

    const immutableLineFields: Array<[string, string | number, string | number]> = [
      ["stripe_line_item_id", row.stripe_line_item_id, expected.stripeLineItemId],
      ["pennylane_invoice_line_id", row.pennylane_invoice_line_id, expected.pennylaneInvoiceLineId],
      ["catalog_id", row.catalog_id, expected.catalogId],
      ["size_fr", row.size_fr, Number(expected.sizeFr)],
      ["quantity", row.quantity, expected.quantity],
      ["unit_amount", row.unit_amount, expected.unitAmount],
      ["created_at", row.created_at, input.createdAt],
    ];

    for (const [field, actual, expectedValue] of immutableLineFields) {
      if (actual !== expectedValue) conflictingFields.push(`order_lines.${row.order_line_id}.${field}`);
    }

    if (row.refunded_quantity < 0 || row.refunded_quantity > row.quantity) {
      conflictingFields.push(`order_lines.${row.order_line_id}.refunded_quantity`);
    }
  }

  if (conflictingFields.length > 0) {
    throw new OrderPersistenceError({
      code: "ORDER_PERSISTENCE_CONFLICT",
      conflicting_fields: conflictingFields,
    });
  }

  return order.id;
}

export async function persistPaidOrder(db: OrdersDatabase, input: PersistOrderInput) {
  input = { ...input, customerName: normalizeCustomerName(input.customerName) };
  assertValidInput(input);

  const existingOrder = await findOrderByReferences(db, input);

  if (existingOrder) {
    const orderId = await verifyExistingOrder(db, input, existingOrder);
    return { status: "already_exists" as const, orderId };
  }

  const orderId = crypto.randomUUID();
  const updatedAt = new Date().toISOString();
  const statements = [
    db
      .prepare(
        `INSERT INTO orders (
          id, stripe_checkout_session_id, stripe_payment_intent_id,
          pennylane_invoice_id, customer_name, customer_email, currency, amount_total,
          status, schema_version, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        orderId,
        input.stripeCheckoutSessionId,
        input.stripePaymentIntentId,
        input.pennylaneInvoiceId,
        input.customerName,
        input.customerEmail,
        input.currency,
        input.amountTotal,
        input.status,
        input.schemaVersion,
        input.createdAt,
        updatedAt,
      ),
    ...input.lines.map((line) =>
      db
        .prepare(
          `INSERT INTO order_lines (
            id, order_id, order_line_id, stripe_line_item_id,
            pennylane_invoice_line_id, catalog_id, size_fr, quantity,
            unit_amount, refunded_quantity, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11)`,
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          line.orderLineId,
          line.stripeLineItemId,
          line.pennylaneInvoiceLineId,
          line.catalogId,
          Number(line.sizeFr),
          line.quantity,
          line.unitAmount,
          input.createdAt,
          updatedAt,
        ),
    ),
  ];

  try {
    const results = await db.batch(statements);

    if (results.some((result) => !result.success)) {
      throw new OrderPersistenceError({ code: "ORDER_BATCH_WRITE_FAILED" });
    }

    return { status: "created" as const, orderId };
  } catch {
    const concurrentlyCreatedOrder = await findOrderByReferences(db, input);

    if (!concurrentlyCreatedOrder) {
      throw new OrderPersistenceError({ code: "ORDER_BATCH_WRITE_FAILED" });
    }

    const persistedOrderId = await verifyExistingOrder(db, input, concurrentlyCreatedOrder);
    return { status: "already_exists" as const, orderId: persistedOrderId };
  }
}

export function getOrderPersistenceErrorDetails(error: unknown): OrderPersistenceErrorDetails {
  return error instanceof OrderPersistenceError
    ? error.details
    : { code: "UNEXPECTED_ORDER_PERSISTENCE_ERROR" };
}
