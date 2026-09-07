export type OrdersBrowserFilters = {
  query: string;
  name: string;
  dateFrom: string;
  dateTo: string;
  product: string;
  size: string;
  amountEuros: string;
  paymentStatus: string;
  refundStatus: string;
  sort: string;
  direction: "asc" | "desc";
};

export type OrdersTableSortColumn = "created_at" | "customer_name" | "product";
export type OrdersTableSort = {
  column: OrdersTableSortColumn;
  direction: "asc" | "desc";
};

export function nextOrdersTableSort(
  current: OrdersTableSort,
  column: OrdersTableSortColumn,
): OrdersTableSort {
  if (current.column !== column) {
    return { column, direction: column === "created_at" ? "desc" : "asc" };
  }
  return { column, direction: current.direction === "asc" ? "desc" : "asc" };
}

export function buildOrdersTableSearchParams(
  query: string,
  page: number,
  sort: OrdersTableSort,
) {
  const params = new URLSearchParams({
    page: String(page),
    page_size: "25",
    sort: sort.column,
    direction: sort.direction,
  });
  if (query.trim()) params.set("q", query.trim());
  return params;
}

function centsFromEuros(value: string) {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

/**
 * Converts the current native form-control values into the read-only API
 * query. Date inputs provide ISO calendar values (YYYY-MM-DD) when valid.
 */
export function buildOrdersSearchParams(filters: OrdersBrowserFilters, page: number) {
  const params = new URLSearchParams({ page: String(page), page_size: "25" });
  const amount = centsFromEuros(filters.amountEuros);
  if (amount === undefined) throw new Error("Enter a valid amount with at most two decimals.");
  if (filters.query.trim()) params.set("q", filters.query.trim());
  if (filters.name.trim()) params.set("name", filters.name.trim());
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.product) params.set("product", filters.product);
  if (filters.size) params.set("size", filters.size);
  if (amount !== null) params.set("amount", String(amount));
  if (filters.paymentStatus) params.set("status", filters.paymentStatus);
  if (filters.refundStatus) params.set("refund_status", filters.refundStatus);
  params.set("sort", filters.sort);
  params.set("direction", filters.direction);
  return params;
}
