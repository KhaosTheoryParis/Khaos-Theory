import type { AdminSalesAnalyticsResult, AdminSalesProduct } from "../services/admin-sales-analytics";

export type SalesPeriodMode = "all_time" | "month" | "year";
export type SalesSortColumn = "product" | "quantity" | "revenue";
export type SalesSort = { column: SalesSortColumn; direction: "asc" | "desc" } | null;

export type SalesPeriodInput = {
  mode: SalesPeriodMode;
  month: string;
  year: string;
};

export type SalesAnalyticsRequest =
  | { ok: true; url: string; periodLabel: string }
  | { ok: false; message: string };

export function buildAnalyticsRequest(
  endpoint: string,
  input: SalesPeriodInput,
): SalesAnalyticsRequest {
  if (input.mode === "all_time") {
    return { ok: true, url: endpoint, periodLabel: "All time" };
  }
  if (input.mode === "month") {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(input.month)) {
      return { ok: false, message: "Choose a valid month." };
    }
    return {
      ok: true,
      url: `${endpoint}?${new URLSearchParams({ month: input.month }).toString()}`,
      periodLabel: `Month: ${input.month}`,
    };
  }
  if (!/^\d{4}$/.test(input.year)) {
    return { ok: false, message: "Enter a valid four-digit year." };
  }
  return {
    ok: true,
    url: `${endpoint}?${new URLSearchParams({ year: input.year }).toString()}`,
    periodLabel: `Year: ${input.year}`,
  };
}

export function buildSalesAnalyticsRequest(input: SalesPeriodInput) {
  return buildAnalyticsRequest("/api/admin/analytics/sales", input);
}

export function nextSalesSort(current: SalesSort, column: SalesSortColumn): SalesSort {
  if (current?.column === column) {
    return { column, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { column, direction: column === "product" ? "asc" : "desc" };
}

export function sortSalesProducts(products: AdminSalesProduct[], sort: SalesSort) {
  const sorted = [...products];
  if (!sort) return sorted;

  const direction = sort.direction === "asc" ? 1 : -1;
  sorted.sort((left, right) => {
    if (sort.column === "product") {
      return direction * left.product_name.localeCompare(right.product_name, "en");
    }
    const values = sort.column === "quantity"
      ? left.quantity_sold - right.quantity_sold
      : left.gross_revenue - right.gross_revenue;
    return values === 0
      ? left.product_name.localeCompare(right.product_name, "en")
      : direction * values;
  });
  return sorted;
}

export function formatSalesMoney(value: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "EUR",
  }).format(value / 100);
}

/** A presentation model used by the client component and its lightweight tests. */
export function salesAnalyticsView(result: AdminSalesAnalyticsResult, sort: SalesSort) {
  return {
    quantityTotal: String(result.totals.quantity_sold),
    grossRevenueTotal: formatSalesMoney(result.totals.gross_revenue),
    products: sortSalesProducts(result.products, sort).map((product) => ({
      ...product,
      quantityText: String(product.quantity_sold),
      grossRevenueText: formatSalesMoney(product.gross_revenue),
    })),
  };
}

export function salesAnalyticsErrorMessage() {
  return "Unable to load sales analytics. Please try again.";
}
