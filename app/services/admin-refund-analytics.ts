import type { OrdersDatabase } from "./orders";
import {
  AdminSalesAnalyticsQueryError,
  parseAdminSalesAnalyticsSearchParams,
  type AdminSalesAnalyticsPeriod,
  type AdminSalesAnalyticsQuery,
} from "./admin-sales-analytics";
import { catalogProductName } from "./admin-orders";

export type AdminRefundAnalyticsQuery = AdminSalesAnalyticsQuery;

export type AdminRefundProduct = {
  catalog_id: string;
  name: string;
  quantity_refunded: number;
  refunded_amount: number;
  quantity_sold: number;
  refund_rate: number;
};

export type AdminRefundAnalyticsResult = {
  period: AdminSalesAnalyticsPeriod;
  products: AdminRefundProduct[];
  totals: {
    quantity_refunded: number;
    refunded_amount: number;
    quantity_sold: number;
    refund_rate: number;
  };
};

type RefundAnalyticsRow = {
  catalog_id: string;
  quantity_sold: number;
  quantity_refunded: number;
  refunded_amount: number;
};

export function parseAdminRefundAnalyticsSearchParams(searchParams: URLSearchParams) {
  return parseAdminSalesAnalyticsSearchParams(searchParams);
}

export async function queryAdminRefundAnalytics(
  db: OrdersDatabase,
  query: AdminRefundAnalyticsQuery,
): Promise<AdminRefundAnalyticsResult> {
  const values: string[] = ["paid", "succeeded"];
  const cohortClauses = ["o.status = ?1"];
  if (query.createdAtFrom) {
    values.push(query.createdAtFrom);
    cohortClauses.push(`o.created_at >= ?${values.length}`);
  }
  if (query.createdAtToExclusive) {
    values.push(query.createdAtToExclusive);
    cohortClauses.push(`o.created_at < ?${values.length}`);
  }

  const rows = await db
    .prepare(
      `WITH cohort_lines AS (
         SELECT o.id AS order_id, ol.order_line_id, ol.catalog_id, ol.quantity
         FROM orders o
         INNER JOIN order_lines ol ON ol.order_id = o.id
         WHERE ${cohortClauses.join(" AND ")}
       ),
       sales_by_product AS (
         SELECT catalog_id, SUM(quantity) AS quantity_sold
         FROM cohort_lines
         GROUP BY catalog_id
       ),
       refunds_by_product AS (
         SELECT cl.catalog_id,
                SUM(rol.requested_quantity) AS quantity_refunded,
                SUM(rol.amount) AS refunded_amount
         FROM cohort_lines cl
         INNER JOIN refund_operation_lines rol ON rol.order_line_id = cl.order_line_id
         INNER JOIN refund_operations ro
           ON ro.id = rol.refund_operation_id
          AND ro.order_id = cl.order_id
          AND ro.status = ?2
         GROUP BY cl.catalog_id
       )
       SELECT sales.catalog_id,
              sales.quantity_sold,
              COALESCE(refunds.quantity_refunded, 0) AS quantity_refunded,
              COALESCE(refunds.refunded_amount, 0) AS refunded_amount
       FROM sales_by_product sales
       LEFT JOIN refunds_by_product refunds ON refunds.catalog_id = sales.catalog_id
       WHERE sales.quantity_sold > 0
       ORDER BY sales.catalog_id ASC`,
    )
    .bind(...values)
    .all<RefundAnalyticsRow>();

  if (!rows.success) throw new Error("ADMIN_REFUND_ANALYTICS_QUERY_FAILED");

  const products = rows.results.map((row): AdminRefundProduct => ({
    catalog_id: row.catalog_id,
    name: catalogProductName(row.catalog_id),
    quantity_refunded: row.quantity_refunded,
    refunded_amount: row.refunded_amount,
    quantity_sold: row.quantity_sold,
    refund_rate: row.quantity_sold > 0 ? row.quantity_refunded / row.quantity_sold : 0,
  }));
  const totals = products.reduce(
    (result, product) => ({
      quantity_refunded: result.quantity_refunded + product.quantity_refunded,
      refunded_amount: result.refunded_amount + product.refunded_amount,
      quantity_sold: result.quantity_sold + product.quantity_sold,
      refund_rate: 0,
    }),
    { quantity_refunded: 0, refunded_amount: 0, quantity_sold: 0, refund_rate: 0 },
  );
  totals.refund_rate = totals.quantity_sold > 0
    ? totals.quantity_refunded / totals.quantity_sold
    : 0;

  return { period: query.period, products, totals };
}

type AdminRefundAnalyticsHandlerDependencies = {
  verifyAccess(headers: Headers): Promise<{ ok: boolean }>;
  getDatabase(): OrdersDatabase | undefined;
};

export function createAdminRefundAnalyticsGetHandler(
  dependencies: AdminRefundAnalyticsHandlerDependencies,
) {
  return async function adminRefundAnalyticsGet(request: Request) {
    const access = await dependencies.verifyAccess(request.headers);
    if (!access.ok) {
      return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }

    let query: AdminRefundAnalyticsQuery;
    try {
      query = parseAdminRefundAnalyticsSearchParams(new URL(request.url).searchParams);
    } catch (error) {
      const code = error instanceof AdminSalesAnalyticsQueryError ? error.code : "INVALID_QUERY";
      return Response.json({ ok: false, error: code }, { status: 400 });
    }

    const db = dependencies.getDatabase();
    if (!db) {
      return Response.json({ ok: false, error: "MISSING_D1_DB_BINDING" }, { status: 503 });
    }

    try {
      return Response.json({ ok: true, ...(await queryAdminRefundAnalytics(db, query)) });
    } catch {
      return Response.json({ ok: false, error: "ADMIN_REFUND_ANALYTICS_QUERY_FAILED" }, { status: 500 });
    }
  };
}
