import type { OrdersDatabase } from "./orders";
import { parisDateRangeToUtc, parseParisCalendarDate } from "./admin-date";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 200;
const ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRODUCT_SORT_SQL = `(SELECT MIN(CASE ol_sort.catalog_id
  WHEN 'geometry' THEN 'Geometry'
  WHEN 'carved-cross' THEN 'Karved Kross'
  WHEN 'hollow-cross' THEN 'Hollow Kross'
  WHEN 'signet-corner' THEN 'Signet Korner'
  WHEN 'damaged-ring-i' THEN 'Damaged Ring I'
  WHEN 'damaged-ring-ii' THEN 'Damaged Ring II'
  ELSE ol_sort.catalog_id END)
  FROM order_lines ol_sort WHERE ol_sort.order_id = o.id)`;

const SORT_COLUMNS = {
  created_at: "o.created_at",
  customer_name: "LOWER(COALESCE(o.customer_name, ''))",
  product: PRODUCT_SORT_SQL,
  amount_total: "o.amount_total",
  customer_email: "o.customer_email",
  status: "o.status",
  id: "o.id",
} as const;

const PAYMENT_STATUSES = new Set(["paid"]);
const REFUND_STATUSES = new Set(["none", "pending", "partial", "full"]);
const ALLOWED_PARAMETERS = new Set([
  "page",
  "page_size",
  "q",
  "name",
  "email",
  "date",
  "date_from",
  "date_to",
  "product",
  "size",
  "amount",
  "status",
  "refund_status",
  "sort",
  "direction",
]);

const CATALOG_NAMES: Readonly<Record<string, string>> = {
  geometry: "Geometry",
  "carved-cross": "Karved Kross",
  "hollow-cross": "Hollow Kross",
  "signet-corner": "Signet Korner",
  "damaged-ring-i": "Damaged Ring I",
  "damaged-ring-ii": "Damaged Ring II",
};

/** Shared read-only catalogue display names for Admin views. */
export function catalogProductName(catalogId: string) {
  return CATALOG_NAMES[catalogId] ?? catalogId;
}

export type AdminOrdersSort = keyof typeof SORT_COLUMNS;
export type AdminRefundStatus = "none" | "pending" | "partial" | "full";

export type AdminOrdersQuery = {
  page: number;
  pageSize: number;
  q?: string;
  name?: string;
  email?: string;
  dateFrom?: string;
  dateToExclusive?: string;
  product?: string;
  size?: number;
  amount?: number;
  status?: "paid";
  refundStatus?: AdminRefundStatus;
  sort: AdminOrdersSort;
  direction: "asc" | "desc";
};

export type AdminOrderLineSummary = {
  catalog_id: string;
  product_name: string;
  size_fr: number;
  quantity: number;
  unit_amount: number;
  refunded_quantity: number;
  reserved_refund_quantity: number;
};

export type AdminOrderSummary = {
  id: string;
  customer_name: string | null;
  customer_email: string;
  currency: string;
  amount_total: number;
  payment_status: string;
  refund_status: AdminRefundStatus;
  created_at: string;
  lines: AdminOrderLineSummary[];
};

export type AdminOrderDetailLine = AdminOrderLineSummary & {
  order_line_id: string;
  refundable_quantity: number;
  refundable_amount: number;
};

export type AdminOrderShippingDetail = {
  amount: number;
  country: string | null;
  zone: string | null;
  refunded_amount: number;
  reserved_amount: number;
  refundable_amount: number;
};

export type AdminOrderShippingAddress = {
  name: string | null;
  line1: string;
  line2: string | null;
  postal_code: string;
  city: string;
  country: string;
};

export type AdminStripeCheckoutSession = {
  id: string;
  collected_information?: {
    shipping_details?: {
      name?: string | null;
      address?: {
        line1?: string | null;
        line2?: string | null;
        postal_code?: string | null;
        city?: string | null;
        country?: string | null;
      } | null;
    } | null;
  } | null;
};

export type AdminOrderDetail = {
  id: string;
  customer_name: string | null;
  customer_email: string;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string;
  pennylane_invoice_id: string;
  currency: string;
  products_subtotal: number | null;
  shipping: AdminOrderShippingDetail | null;
  shipping_address: AdminOrderShippingAddress | null;
  amount_total: number;
  payment_status: string;
  created_at: string;
  remaining_refundable_amount: number;
  lines: AdminOrderDetailLine[];
};

function normalizedStripeText(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

export function projectAdminShippingAddress(
  session: AdminStripeCheckoutSession,
  expectedSessionId: string,
): AdminOrderShippingAddress | null {
  if (session.id !== expectedSessionId) return null;
  const shippingDetails = session.collected_information?.shipping_details;
  const address = shippingDetails?.address;
  const line1 = normalizedStripeText(address?.line1);
  const postalCode = normalizedStripeText(address?.postal_code);
  const city = normalizedStripeText(address?.city);
  const country = normalizedStripeText(address?.country);

  if (!line1 || !postalCode || !city || !country) return null;

  return {
    name: normalizedStripeText(shippingDetails?.name),
    line1,
    line2: normalizedStripeText(address?.line2),
    postal_code: postalCode,
    city,
    country,
  };
}

export type AdminOrdersResult = {
  orders: AdminOrderSummary[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
};

type OrderRow = {
  id: string;
  customer_name: string | null;
  customer_email: string;
  currency: string;
  amount_total: number;
  status: string;
  created_at: string;
};

type OrderLineRow = {
  order_id: string;
  catalog_id: string;
  size_fr: number;
  quantity: number;
  unit_amount: number;
  refunded_quantity: number;
  reserved_refund_quantity: number;
};

type OrderDetailRow = OrderRow & {
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string;
  pennylane_invoice_id: string;
  products_subtotal: number | null;
  shipping_amount: number | null;
  shipping_country: string | null;
  shipping_zone: string | null;
  shipping_refunded_amount: number | null;
  reserved_shipping_refund_amount: number | null;
};

type OrderDetailLineRow = OrderLineRow & {
  order_line_id: string;
};

export class AdminOrdersQueryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AdminOrdersQueryError";
    this.code = code;
  }
}

function singleValue(searchParams: URLSearchParams, key: string) {
  const values = searchParams.getAll(key);
  if (values.length > 1) throw new AdminOrdersQueryError("DUPLICATE_QUERY_PARAMETER");
  return values[0]?.trim() ?? "";
}

function positiveInteger(value: string, code: string, maximum: number) {
  if (!/^\d+$/.test(value)) throw new AdminOrdersQueryError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AdminOrdersQueryError(code);
  }
  return parsed;
}

export function parseAdminOrdersSearchParams(searchParams: URLSearchParams): AdminOrdersQuery {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) {
      throw new AdminOrdersQueryError("UNKNOWN_QUERY_PARAMETER");
    }
  }

  const rawPage = singleValue(searchParams, "page");
  const rawPageSize = singleValue(searchParams, "page_size");
  const rawQuery = singleValue(searchParams, "q");
  const rawName = singleValue(searchParams, "name");
  const rawEmail = singleValue(searchParams, "email");
  const rawDate = singleValue(searchParams, "date");
  const rawDateFrom = singleValue(searchParams, "date_from");
  const rawDateTo = singleValue(searchParams, "date_to");
  const rawProduct = singleValue(searchParams, "product");
  const rawSize = singleValue(searchParams, "size");
  const rawAmount = singleValue(searchParams, "amount");
  const rawStatus = singleValue(searchParams, "status");
  const rawRefundStatus = singleValue(searchParams, "refund_status");
  const rawSort = singleValue(searchParams, "sort");
  const rawDirection = singleValue(searchParams, "direction").toLowerCase();

  if (rawDate && (rawDateFrom || rawDateTo)) {
    throw new AdminOrdersQueryError("CONFLICTING_DATE_FILTERS");
  }
  if (
    rawQuery.length > MAX_QUERY_LENGTH ||
    rawName.length > MAX_QUERY_LENGTH ||
    rawEmail.length > 254
  ) {
    throw new AdminOrdersQueryError("QUERY_PARAMETER_TOO_LONG");
  }
  if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    throw new AdminOrdersQueryError("INVALID_EMAIL_FILTER");
  }
  if (rawProduct && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawProduct)) {
    throw new AdminOrdersQueryError("INVALID_PRODUCT_FILTER");
  }

  const normalizedSize = rawSize.toUpperCase().replace(/^FR\s*/, "");
  const size = rawSize ? positiveInteger(normalizedSize, "INVALID_SIZE_FILTER", 70) : undefined;
  if (size !== undefined && size < 48) throw new AdminOrdersQueryError("INVALID_SIZE_FILTER");

  let amount: number | undefined;
  if (rawAmount) {
    if (!/^\d+$/.test(rawAmount)) throw new AdminOrdersQueryError("INVALID_AMOUNT_FILTER");
    amount = Number(rawAmount);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100_000_000) {
      throw new AdminOrdersQueryError("INVALID_AMOUNT_FILTER");
    }
  }

  if (rawStatus && !PAYMENT_STATUSES.has(rawStatus)) {
    throw new AdminOrdersQueryError("INVALID_PAYMENT_STATUS_FILTER");
  }
  if (rawRefundStatus && !REFUND_STATUSES.has(rawRefundStatus)) {
    throw new AdminOrdersQueryError("INVALID_REFUND_STATUS_FILTER");
  }
  if (rawSort && !Object.hasOwn(SORT_COLUMNS, rawSort)) {
    throw new AdminOrdersQueryError("INVALID_SORT_COLUMN");
  }
  if (rawDirection && rawDirection !== "asc" && rawDirection !== "desc") {
    throw new AdminOrdersQueryError("INVALID_SORT_DIRECTION");
  }

  let dateFrom: string | undefined;
  let dateToExclusive: string | undefined;
  try {
    if (rawDate) {
      parseParisCalendarDate(rawDate, "INVALID_DATE_FILTER");
      const range = parisDateRangeToUtc(rawDate, rawDate);
      dateFrom = range.startUtc;
      dateToExclusive = range.endUtcExclusive;
    } else {
      if (rawDateFrom && rawDateTo && rawDateFrom > rawDateTo) {
        throw new Error("INVALID_DATE_RANGE");
      }
      if (rawDateFrom) {
        dateFrom = parisDateRangeToUtc(rawDateFrom, rawDateFrom).startUtc;
      }
      if (rawDateTo) {
        dateToExclusive = parisDateRangeToUtc(rawDateTo, rawDateTo).endUtcExclusive;
      }
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "INVALID_DATE_FILTER";
    throw new AdminOrdersQueryError(code);
  }

  return {
    page: rawPage ? positiveInteger(rawPage, "INVALID_PAGE", 1_000_000) : 1,
    pageSize: rawPageSize
      ? positiveInteger(rawPageSize, "INVALID_PAGE_SIZE", MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE,
    q: rawQuery || undefined,
    name: rawName || undefined,
    email: rawEmail.toLowerCase() || undefined,
    dateFrom,
    dateToExclusive,
    product: rawProduct || undefined,
    size,
    amount,
    status: rawStatus ? "paid" : undefined,
    refundStatus: rawRefundStatus as AdminRefundStatus || undefined,
    sort: (rawSort || "created_at") as AdminOrdersSort,
    direction: (rawDirection || "desc") as "asc" | "desc",
  };
}

export function parseAdminOrderDetailSearchParams(searchParams: URLSearchParams) {
  if (!searchParams.has("order_id")) return null;
  if ([...searchParams.keys()].some((key) => key !== "order_id")) {
    throw new AdminOrdersQueryError("CONFLICTING_DETAIL_PARAMETERS");
  }
  const orderId = singleValue(searchParams, "order_id");
  if (!ORDER_ID_PATTERN.test(orderId)) {
    throw new AdminOrdersQueryError("INVALID_ORDER_ID");
  }
  return orderId;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function buildWhere(query: AdminOrdersQuery) {
  const values: Array<string | number | null> = [];
  const clauses: string[] = [];
  const bind = (value: string | number) => {
    values.push(value);
    return `?${values.length}`;
  };

  if (query.q) {
    const placeholder = bind(`%${escapeLike(query.q)}%`);
    clauses.push(`(
      LOWER(o.customer_email) LIKE LOWER(${placeholder}) ESCAPE '\\'
      OR LOWER(COALESCE(o.customer_name, '')) LIKE LOWER(${placeholder}) ESCAPE '\\'
      OR LOWER(o.id) LIKE LOWER(${placeholder}) ESCAPE '\\'
      OR LOWER(o.stripe_checkout_session_id) LIKE LOWER(${placeholder}) ESCAPE '\\'
      OR LOWER(o.stripe_payment_intent_id) LIKE LOWER(${placeholder}) ESCAPE '\\'
      OR LOWER(o.pennylane_invoice_id) LIKE LOWER(${placeholder}) ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM order_lines ol_search
        WHERE ol_search.order_id = o.id
          AND (
            LOWER(ol_search.catalog_id) LIKE LOWER(${placeholder}) ESCAPE '\\'
            OR LOWER(CASE ol_search.catalog_id
              WHEN 'geometry' THEN 'Geometry'
              WHEN 'carved-cross' THEN 'Karved Kross'
              WHEN 'hollow-cross' THEN 'Hollow Kross'
              WHEN 'signet-corner' THEN 'Signet Korner'
              WHEN 'damaged-ring-i' THEN 'Damaged Ring I'
              WHEN 'damaged-ring-ii' THEN 'Damaged Ring II'
              ELSE ol_search.catalog_id END) LIKE LOWER(${placeholder}) ESCAPE '\\'
          )
      )
    )`);
  }
  if (query.name) {
    clauses.push(
      `LOWER(COALESCE(o.customer_name, '')) LIKE LOWER(${bind(`%${escapeLike(query.name)}%`)}) ESCAPE '\\'`,
    );
  }
  if (query.email) clauses.push(`LOWER(o.customer_email) = LOWER(${bind(query.email)})`);
  if (query.dateFrom) clauses.push(`o.created_at >= ${bind(query.dateFrom)}`);
  if (query.dateToExclusive) clauses.push(`o.created_at < ${bind(query.dateToExclusive)}`);
  if (query.amount !== undefined) clauses.push(`o.amount_total = ${bind(query.amount)}`);
  if (query.status) clauses.push(`o.status = ${bind(query.status)}`);

  if (query.product || query.size !== undefined) {
    const lineClauses: string[] = ["ol.order_id = o.id"];
    if (query.product) lineClauses.push(`ol.catalog_id = ${bind(query.product)}`);
    if (query.size !== undefined) lineClauses.push(`ol.size_fr = ${bind(query.size)}`);
    clauses.push(`EXISTS (SELECT 1 FROM order_lines ol WHERE ${lineClauses.join(" AND ")})`);
  }

  const refunded = "COALESCE((SELECT SUM(ol.refunded_quantity) FROM order_lines ol WHERE ol.order_id = o.id), 0)";
  const reserved = "COALESCE((SELECT SUM(ol.reserved_refund_quantity) FROM order_lines ol WHERE ol.order_id = o.id), 0)";
  const quantity = "COALESCE((SELECT SUM(ol.quantity) FROM order_lines ol WHERE ol.order_id = o.id), 0)";

  if (query.refundStatus === "none") clauses.push(`${refunded} = 0 AND ${reserved} = 0`);
  if (query.refundStatus === "pending") clauses.push(`${reserved} > 0`);
  if (query.refundStatus === "partial") {
    clauses.push(`${reserved} = 0 AND ${refunded} > 0 AND ${refunded} < ${quantity}`);
  }
  if (query.refundStatus === "full") {
    clauses.push(`${reserved} = 0 AND ${quantity} > 0 AND ${refunded} = ${quantity}`);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

export async function queryAdminOrderDetail(
  db: OrdersDatabase,
  orderId: string,
): Promise<AdminOrderDetail | null> {
  if (!ORDER_ID_PATTERN.test(orderId)) throw new AdminOrdersQueryError("INVALID_ORDER_ID");

  const order = await db.prepare(
    `SELECT id, customer_name, customer_email, currency, amount_total, status, created_at,
            stripe_checkout_session_id, stripe_payment_intent_id, pennylane_invoice_id,
            products_subtotal, shipping_amount, shipping_country, shipping_zone,
            shipping_refunded_amount, reserved_shipping_refund_amount
     FROM orders WHERE id = ?1`,
  ).bind(orderId).first<OrderDetailRow>();
  if (!order) return null;

  const lineRows = await db.prepare(
    `SELECT order_id, order_line_id, catalog_id, size_fr, quantity, unit_amount,
            refunded_quantity, reserved_refund_quantity
     FROM order_lines
     WHERE order_id = ?1
     ORDER BY created_at ASC, id ASC`,
  ).bind(orderId).all<OrderDetailLineRow>();
  if (!lineRows.success) throw new Error("ADMIN_ORDER_DETAIL_LINES_QUERY_FAILED");

  const lines = lineRows.results.map((line): AdminOrderDetailLine => {
    const refundableQuantity = line.quantity - line.refunded_quantity - line.reserved_refund_quantity;
    if (refundableQuantity < 0) throw new Error("ADMIN_ORDER_DETAIL_REFUND_STATE_INVALID");
    return {
      order_line_id: line.order_line_id,
      catalog_id: line.catalog_id,
      product_name: catalogProductName(line.catalog_id),
      size_fr: line.size_fr,
      quantity: line.quantity,
      unit_amount: line.unit_amount,
      refunded_quantity: line.refunded_quantity,
      reserved_refund_quantity: line.reserved_refund_quantity,
      refundable_quantity: refundableQuantity,
      refundable_amount: refundableQuantity * line.unit_amount,
    };
  });

  let shipping: AdminOrderShippingDetail | null = null;
  if (order.shipping_amount !== null) {
    const refundedAmount = order.shipping_refunded_amount ?? 0;
    const reservedAmount = order.reserved_shipping_refund_amount ?? 0;
    const refundableAmount = order.shipping_amount - refundedAmount - reservedAmount;
    if (refundableAmount < 0) throw new Error("ADMIN_ORDER_DETAIL_SHIPPING_STATE_INVALID");
    shipping = {
      amount: order.shipping_amount,
      country: order.shipping_country,
      zone: order.shipping_zone,
      refunded_amount: refundedAmount,
      reserved_amount: reservedAmount,
      refundable_amount: refundableAmount,
    };
  }

  return {
    id: order.id,
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    stripe_checkout_session_id: order.stripe_checkout_session_id,
    stripe_payment_intent_id: order.stripe_payment_intent_id,
    pennylane_invoice_id: order.pennylane_invoice_id,
    currency: order.currency,
    products_subtotal: order.products_subtotal,
    shipping,
    shipping_address: null,
    amount_total: order.amount_total,
    payment_status: order.status,
    created_at: order.created_at,
    remaining_refundable_amount:
      lines.reduce((total, line) => total + line.refundable_amount, 0) +
      (shipping?.refundable_amount ?? 0),
    lines,
  };
}

function refundStatus(lines: AdminOrderLineSummary[]): AdminRefundStatus {
  const quantities = lines.reduce(
    (totals, line) => ({
      ordered: totals.ordered + line.quantity,
      refunded: totals.refunded + line.refunded_quantity,
      reserved: totals.reserved + line.reserved_refund_quantity,
    }),
    { ordered: 0, refunded: 0, reserved: 0 },
  );

  if (quantities.reserved > 0) return "pending";
  if (quantities.ordered > 0 && quantities.refunded === quantities.ordered) return "full";
  if (quantities.refunded > 0) return "partial";
  return "none";
}

export async function queryAdminOrders(
  db: OrdersDatabase,
  query: AdminOrdersQuery,
): Promise<AdminOrdersResult> {
  const where = buildWhere(query);
  const count = await db
    .prepare(`SELECT COUNT(*) AS total FROM orders o ${where.sql}`)
    .bind(...where.values)
    .first<{ total: number }>();

  if (!count || !Number.isInteger(count.total)) {
    throw new Error("ADMIN_ORDERS_COUNT_FAILED");
  }

  const offset = (query.page - 1) * query.pageSize;
  const sortColumn = SORT_COLUMNS[query.sort];
  const sortDirection = query.direction === "asc" ? "ASC" : "DESC";
  const pageValues = [...where.values, query.pageSize, offset];
  const limitPlaceholder = `?${where.values.length + 1}`;
  const offsetPlaceholder = `?${where.values.length + 2}`;
  const orderRows = await db
    .prepare(
      `SELECT o.id, o.customer_name, o.customer_email, o.currency,
              o.amount_total, o.status, o.created_at
       FROM orders o
       ${where.sql}
       ORDER BY ${sortColumn} ${sortDirection}, o.id ASC
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    )
    .bind(...pageValues)
    .all<OrderRow>();

  if (!orderRows.success) throw new Error("ADMIN_ORDERS_QUERY_FAILED");

  const linesByOrder = new Map<string, AdminOrderLineSummary[]>();
  if (orderRows.results.length > 0) {
    const placeholders = orderRows.results.map((_, index) => `?${index + 1}`).join(", ");
    const lineRows = await db
      .prepare(
        `SELECT order_id, catalog_id, size_fr, quantity, unit_amount,
                refunded_quantity, reserved_refund_quantity
         FROM order_lines
         WHERE order_id IN (${placeholders})
         ORDER BY order_id ASC, created_at ASC, id ASC`,
      )
      .bind(...orderRows.results.map((order) => order.id))
      .all<OrderLineRow>();

    if (!lineRows.success) throw new Error("ADMIN_ORDER_LINES_QUERY_FAILED");

    for (const line of lineRows.results) {
      const lines = linesByOrder.get(line.order_id) ?? [];
      lines.push({
        catalog_id: line.catalog_id,
        product_name: catalogProductName(line.catalog_id),
        size_fr: line.size_fr,
        quantity: line.quantity,
        unit_amount: line.unit_amount,
        refunded_quantity: line.refunded_quantity,
        reserved_refund_quantity: line.reserved_refund_quantity,
      });
      linesByOrder.set(line.order_id, lines);
    }
  }

  const orders = orderRows.results.map((order) => {
    const lines = linesByOrder.get(order.id) ?? [];
    return {
      id: order.id,
      customer_name: order.customer_name,
      customer_email: order.customer_email,
      currency: order.currency,
      amount_total: order.amount_total,
      payment_status: order.status,
      refund_status: refundStatus(lines),
      created_at: order.created_at,
      lines,
    } satisfies AdminOrderSummary;
  });

  return {
    orders,
    pagination: {
      page: query.page,
      page_size: query.pageSize,
      total: count.total,
      total_pages: Math.max(1, Math.ceil(count.total / query.pageSize)),
    },
  };
}

type AdminOrdersHandlerDependencies = {
  verifyAccess(headers: Headers): Promise<{ ok: boolean }>;
  getDatabase(): OrdersDatabase | undefined;
  retrieveCheckoutSession?: (sessionId: string) => Promise<AdminStripeCheckoutSession>;
};

export function createAdminOrdersGetHandler(dependencies: AdminOrdersHandlerDependencies) {
  return async function adminOrdersGet(request: Request) {
    const access = await dependencies.verifyAccess(request.headers);
    if (!access.ok) {
      return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }

    let query: AdminOrdersQuery | null = null;
    let detailOrderId: string | null = null;
    try {
      const searchParams = new URL(request.url).searchParams;
      detailOrderId = parseAdminOrderDetailSearchParams(searchParams);
      if (!detailOrderId) query = parseAdminOrdersSearchParams(searchParams);
    } catch (error) {
      const code = error instanceof AdminOrdersQueryError ? error.code : "INVALID_QUERY";
      return Response.json({ ok: false, error: code }, { status: 400 });
    }

    const db = dependencies.getDatabase();
    if (!db) {
      return Response.json({ ok: false, error: "MISSING_D1_DB_BINDING" }, { status: 503 });
    }

    try {
      if (detailOrderId) {
        const order = await queryAdminOrderDetail(db, detailOrderId);
        if (!order) {
          return Response.json({ ok: false, error: "ORDER_NOT_FOUND" }, { status: 404 });
        }
        let shippingAddress: AdminOrderShippingAddress | null = null;
        if (dependencies.retrieveCheckoutSession) {
          try {
            const session = await dependencies.retrieveCheckoutSession(
              order.stripe_checkout_session_id,
            );
            shippingAddress = projectAdminShippingAddress(
              session,
              order.stripe_checkout_session_id,
            );
          } catch {
            // Stripe lookup is optional enrichment; the protected D1 detail remains available.
          }
        }
        return Response.json({
          ok: true,
          order: { ...order, shipping_address: shippingAddress },
        }, {
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      if (!query) throw new Error("ADMIN_ORDERS_QUERY_MISSING");
      const result = await queryAdminOrders(db, query);
      return Response.json({
        ok: true,
        ...result,
        capabilities: {
          customer_name: true,
          refund_status_source: "order_line_quantities",
        },
      });
    } catch {
      return Response.json({ ok: false, error: "ADMIN_ORDERS_QUERY_FAILED" }, { status: 500 });
    }
  };
}
