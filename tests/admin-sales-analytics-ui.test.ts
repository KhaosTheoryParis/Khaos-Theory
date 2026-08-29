import assert from "node:assert/strict";
import test from "node:test";
import type { AdminSalesAnalyticsResult } from "../app/services/admin-sales-analytics";
import {
  buildSalesAnalyticsRequest,
  nextSalesSort,
  salesAnalyticsErrorMessage,
  salesAnalyticsView,
  sortSalesProducts,
} from "../app/admin/sales-analytics-ui";

const RESULT: AdminSalesAnalyticsResult = {
  period: { kind: "all_time", value: null },
  totals: { quantity_sold: 6, gross_revenue: 95_000 },
  products: [
    { catalog_id: "geometry", product_name: "Geometry", quantity_sold: 3, gross_revenue: 75_000 },
    { catalog_id: "hollow-cross", product_name: "Hollow Kross", quantity_sold: 2, gross_revenue: 20_000 },
    { catalog_id: "damaged-ring-i", product_name: "Damaged Ring I", quantity_sold: 1, gross_revenue: 15_000 },
  ],
};

test("the sales presentation model renders totals and product values", () => {
  const view = salesAnalyticsView(RESULT, null);
  assert.equal(view.quantityTotal, "6");
  assert.match(view.grossRevenueTotal, /950/);
  assert.deepEqual(view.products.map((product) => product.product_name), [
    "Geometry", "Hollow Kross", "Damaged Ring I",
  ]);
  assert.equal(view.products[0]?.quantityText, "3");
  assert.match(view.products[0]?.grossRevenueText ?? "", /750/);
});

test("all-time, month and year period controls build the only allowed API URLs", () => {
  assert.deepEqual(
    buildSalesAnalyticsRequest({ mode: "all_time", month: "", year: "" }),
    { ok: true, url: "/api/admin/analytics/sales", periodLabel: "All time" },
  );
  assert.deepEqual(
    buildSalesAnalyticsRequest({ mode: "month", month: "2026-08", year: "2026" }),
    { ok: true, url: "/api/admin/analytics/sales?month=2026-08", periodLabel: "Month: 2026-08" },
  );
  assert.deepEqual(
    buildSalesAnalyticsRequest({ mode: "year", month: "2026-08", year: "2026" }),
    { ok: true, url: "/api/admin/analytics/sales?year=2026", periodLabel: "Year: 2026" },
  );
});

test("period controls keep month and year mutually exclusive in the generated request", () => {
  const request = buildSalesAnalyticsRequest({ mode: "month", month: "2026-08", year: "2026" });
  assert.equal(request.ok, true);
  if (request.ok) {
    assert.match(request.url, /month=2026-08/);
    assert.doesNotMatch(request.url, /year=/);
  }

  assert.deepEqual(
    buildSalesAnalyticsRequest({ mode: "year", month: "", year: "20A6" }),
    { ok: false, message: "Enter a valid four-digit year." },
  );
});

test("numeric quantity sorting starts descending and toggles ascending", () => {
  const descending = nextSalesSort(null, "quantity");
  assert.deepEqual(descending, { column: "quantity", direction: "desc" });
  assert.deepEqual(
    sortSalesProducts(RESULT.products, descending).map((product) => product.quantity_sold),
    [3, 2, 1],
  );
  const ascending = nextSalesSort(descending, "quantity");
  assert.deepEqual(ascending, { column: "quantity", direction: "asc" });
  assert.deepEqual(
    sortSalesProducts(RESULT.products, ascending).map((product) => product.quantity_sold),
    [1, 2, 3],
  );
});

test("gross revenue sorting uses numeric cents rather than formatted money text", () => {
  const descending = nextSalesSort(null, "revenue");
  assert.deepEqual(
    sortSalesProducts(RESULT.products, descending).map((product) => product.gross_revenue),
    [75_000, 20_000, 15_000],
  );
  const ascending = nextSalesSort(descending, "revenue");
  assert.deepEqual(
    sortSalesProducts(RESULT.products, ascending).map((product) => product.gross_revenue),
    [15_000, 20_000, 75_000],
  );
});

test("an empty API result stays empty and API failures use a safe retryable message", () => {
  const empty = salesAnalyticsView({
    period: { kind: "month", value: "2026-08" },
    products: [],
    totals: { quantity_sold: 0, gross_revenue: 0 },
  }, null);
  assert.deepEqual(empty.products, []);
  assert.equal(empty.quantityTotal, "0");
  assert.match(salesAnalyticsErrorMessage(), /Unable to load sales analytics/);
  assert.doesNotMatch(salesAnalyticsErrorMessage(), /500|stack|exception/i);
});
