import type { OrdersDatabase } from "./orders";
import { parisMonthRangeToUtc, parisYearRangeToUtc } from "./admin-date";
import { catalogProductName } from "./admin-orders";

const ALLOWED_PARAMETERS = new Set(["month", "year"]);

export type AdminSalesAnalyticsPeriod =
  | { kind: "all_time"; value: null }
  | { kind: "month"; value: string }
  | { kind: "year"; value: string };

export type AdminSalesAnalyticsQuery = {
  period: AdminSalesAnalyticsPeriod;
  createdAtFrom?: string;
  createdAtToExclusive?: string;
};

export type AdminSalesProduct = {
  catalog_id: string;
  product_name: string;
  quantity_sold: number;
  gross_revenue: number;
};

export type AdminSalesAnalyticsResult = {
  period: AdminSalesAnalyticsPeriod;
  products: AdminSalesProduct[];
  totals: {
    quantity_sold: number;
    gross_revenue: number;
  };
};

type SalesRow = {
  catalog_id: string;
  quantity_sold: number;
  gross_revenue: number;
};

export class AdminSalesAnalyticsQueryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AdminSalesAnalyticsQueryError";
    this.code = code;
  }
}

function singleValue(searchParams: URLSearchParams, key: string) {
  const values = searchParams.getAll(key);
  if (values.length > 1) throw new AdminSalesAnalyticsQueryError("DUPLICATE_QUERY_PARAMETER");
  return values[0]?.trim() ?? "";
}

export function parseAdminSalesAnalyticsSearchParams(
  searchParams: URLSearchParams,
): AdminSalesAnalyticsQuery {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) {
      throw new AdminSalesAnalyticsQueryError("UNKNOWN_QUERY_PARAMETER");
    }
  }

  const month = singleValue(searchParams, "month");
  const year = singleValue(searchParams, "year");
  if (month && year) throw new AdminSalesAnalyticsQueryError("CONFLICTING_PERIOD_FILTERS");

  try {
    if (month) {
      const range = parisMonthRangeToUtc(month);
      return {
        period: { kind: "month", value: month },
        createdAtFrom: range.startUtc,
        createdAtToExclusive: range.endUtcExclusive,
      };
    }
    if (year) {
      const range = parisYearRangeToUtc(year);
      return {
        period: { kind: "year", value: year },
        createdAtFrom: range.startUtc,
        createdAtToExclusive: range.endUtcExclusive,
      };
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "INVALID_PERIOD_FILTER";
    throw new AdminSalesAnalyticsQueryError(code);
  }

  return { period: { kind: "all_time", value: null } };
}

export async function queryAdminSalesAnalytics(
  db: OrdersDatabase,
  query: AdminSalesAnalyticsQuery,
): Promise<AdminSalesAnalyticsResult> {
  const values: Array<string> = ["paid"];
  const clauses = ["o.status = ?1"];
  if (query.createdAtFrom) {
    values.push(query.createdAtFrom);
    clauses.push(`o.created_at >= ?${values.length}`);
  }
  if (query.createdAtToExclusive) {
    values.push(query.createdAtToExclusive);
    clauses.push(`o.created_at < ?${values.length}`);
  }

  const rows = await db
    .prepare(
      `SELECT ol.catalog_id,
              SUM(ol.quantity) AS quantity_sold,
              SUM(ol.quantity * ol.unit_amount) AS gross_revenue
       FROM order_lines ol
       INNER JOIN orders o ON o.id = ol.order_id
       WHERE ${clauses.join(" AND ")}
       GROUP BY ol.catalog_id
       ORDER BY ol.catalog_id ASC`,
    )
    .bind(...values)
    .all<SalesRow>();

  if (!rows.success) throw new Error("ADMIN_SALES_ANALYTICS_QUERY_FAILED");
  const products = rows.results.map((row) => ({
    catalog_id: row.catalog_id,
    product_name: catalogProductName(row.catalog_id),
    quantity_sold: row.quantity_sold,
    gross_revenue: row.gross_revenue,
  }));

  return {
    period: query.period,
    products,
    totals: products.reduce(
      (totals, product) => ({
        quantity_sold: totals.quantity_sold + product.quantity_sold,
        gross_revenue: totals.gross_revenue + product.gross_revenue,
      }),
      { quantity_sold: 0, gross_revenue: 0 },
    ),
  };
}

type AdminSalesAnalyticsHandlerDependencies = {
  verifyAccess(headers: Headers): Promise<{ ok: boolean }>;
  getDatabase(): OrdersDatabase | undefined;
};

export function createAdminSalesAnalyticsGetHandler(
  dependencies: AdminSalesAnalyticsHandlerDependencies,
) {
  return async function adminSalesAnalyticsGet(request: Request) {
    const access = await dependencies.verifyAccess(request.headers);
    if (!access.ok) {
      return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }

    let query: AdminSalesAnalyticsQuery;
    try {
      query = parseAdminSalesAnalyticsSearchParams(new URL(request.url).searchParams);
    } catch (error) {
      const code = error instanceof AdminSalesAnalyticsQueryError ? error.code : "INVALID_QUERY";
      return Response.json({ ok: false, error: code }, { status: 400 });
    }

    const db = dependencies.getDatabase();
    if (!db) {
      return Response.json({ ok: false, error: "MISSING_D1_DB_BINDING" }, { status: 503 });
    }

    try {
      return Response.json({ ok: true, ...(await queryAdminSalesAnalytics(db, query)) });
    } catch {
      return Response.json({ ok: false, error: "ADMIN_SALES_ANALYTICS_QUERY_FAILED" }, { status: 500 });
    }
  };
}
