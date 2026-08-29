import assert from "node:assert/strict";
import test from "node:test";
import type { AdminRefundAnalyticsResult } from "../app/services/admin-refund-analytics";
import {
  buildRefundAnalyticsRequest,
  nextRefundSort,
  refundAnalyticsErrorMessage,
  refundAnalyticsView,
  sortRefundProducts,
} from "../app/admin/refund-analytics-ui";

const RESULT: AdminRefundAnalyticsResult = {
  period: { kind: "all_time", value: null },
  products: [
    {
      catalog_id: "geometry", name: "Geometry", quantity_refunded: 2,
      refunded_amount: 50_000, quantity_sold: 42, refund_rate: 2 / 42,
    },
    {
      catalog_id: "hollow-cross", name: "Hollow Kross", quantity_refunded: 0,
      refunded_amount: 0, quantity_sold: 1, refund_rate: 0,
    },
    {
      catalog_id: "signet-corner", name: "Signet Korner", quantity_refunded: 1,
      refunded_amount: 15_000, quantity_sold: 1, refund_rate: 1,
    },
  ],
  totals: {
    quantity_refunded: 3,
    refunded_amount: 65_000,
    quantity_sold: 44,
    refund_rate: 3 / 44,
  },
};

function plain(value: string) {
  return value.replace(/[\u00a0\u202f]/g, " ");
}

test("refund presentation renders products, quantities, amounts and readable rates", () => {
  const view = refundAnalyticsView(RESULT, null);
  assert.deepEqual(view.products.map((product) => product.name), [
    "Geometry", "Hollow Kross", "Signet Korner",
  ]);
  assert.equal(view.products[0]?.quantityRefundedText, "2");
  assert.match(plain(view.products[0]?.refundedAmountText ?? ""), /500,00 €|500 €/);
  assert.equal(plain(view.products[0]?.refundRateText ?? ""), "4,8 % (42 unités vendues)");
});

test("refund rate formatting handles singular, zero and one hundred percent", () => {
  const view = refundAnalyticsView(RESULT, null);
  assert.equal(plain(view.products[1]?.refundRateText ?? ""), "0 % (1 unité vendue)");
  assert.equal(plain(view.products[2]?.refundRateText ?? ""), "100 % (1 unité vendue)");
});

test("global refund totals use the API rate and include the sold-unit denominator", () => {
  const view = refundAnalyticsView(RESULT, null);
  assert.equal(view.quantityRefundedTotal, "3");
  assert.match(plain(view.refundedAmountTotal), /650,00 €|650 €/);
  assert.equal(plain(view.refundRateTotal), "6,8 % (44 unités vendues)");
});

test("refund quantity sorting starts descending and toggles ascending", () => {
  const descending = nextRefundSort(null, "quantity");
  assert.deepEqual(
    sortRefundProducts(RESULT.products, descending).map((product) => product.quantity_refunded),
    [2, 1, 0],
  );
  const ascending = nextRefundSort(descending, "quantity");
  assert.deepEqual(
    sortRefundProducts(RESULT.products, ascending).map((product) => product.quantity_refunded),
    [0, 1, 2],
  );
});

test("refund amount sorting uses numeric cents in both directions", () => {
  const descending = nextRefundSort(null, "amount");
  assert.deepEqual(
    sortRefundProducts(RESULT.products, descending).map((product) => product.refunded_amount),
    [50_000, 15_000, 0],
  );
  assert.deepEqual(
    sortRefundProducts(RESULT.products, nextRefundSort(descending, "amount"))
      .map((product) => product.refunded_amount),
    [0, 15_000, 50_000],
  );
});

test("refund rate sorting uses the raw numeric rate in both directions", () => {
  const descending = nextRefundSort(null, "rate");
  assert.deepEqual(
    sortRefundProducts(RESULT.products, descending).map((product) => product.refund_rate),
    [1, 2 / 42, 0],
  );
  assert.deepEqual(
    sortRefundProducts(RESULT.products, nextRefundSort(descending, "rate"))
      .map((product) => product.refund_rate),
    [0, 2 / 42, 1],
  );
});

test("shared period selection builds refund all-time, month and year URLs", () => {
  assert.deepEqual(
    buildRefundAnalyticsRequest({ mode: "all_time", month: "", year: "" }),
    { ok: true, url: "/api/admin/analytics/refunds", periodLabel: "All time" },
  );
  assert.deepEqual(
    buildRefundAnalyticsRequest({ mode: "month", month: "2026-08", year: "2026" }),
    { ok: true, url: "/api/admin/analytics/refunds?month=2026-08", periodLabel: "Month: 2026-08" },
  );
  assert.deepEqual(
    buildRefundAnalyticsRequest({ mode: "year", month: "2026-08", year: "2026" }),
    { ok: true, url: "/api/admin/analytics/refunds?year=2026", periodLabel: "Year: 2026" },
  );
});

test("a cohort with sales but no refunds still renders zero-valued products", () => {
  const view = refundAnalyticsView({
    period: { kind: "month", value: "2026-08" },
    products: [{
      catalog_id: "geometry", name: "Geometry", quantity_refunded: 0,
      refunded_amount: 0, quantity_sold: 4, refund_rate: 0,
    }],
    totals: { quantity_refunded: 0, refunded_amount: 0, quantity_sold: 4, refund_rate: 0 },
  }, null);
  assert.equal(view.hasSales, true);
  assert.equal(view.hasRefunds, false);
  assert.equal(view.products.length, 1);
  assert.equal(plain(view.products[0]?.refundRateText ?? ""), "0 % (4 unités vendues)");
});

test("an empty cohort and an API failure have distinct safe UI states", () => {
  const view = refundAnalyticsView({
    period: { kind: "year", value: "2025" },
    products: [],
    totals: { quantity_refunded: 0, refunded_amount: 0, quantity_sold: 0, refund_rate: 0 },
  }, null);
  assert.equal(view.hasSales, false);
  assert.deepEqual(view.products, []);
  assert.match(refundAnalyticsErrorMessage(), /Unable to load refund analytics/);
  assert.doesNotMatch(refundAnalyticsErrorMessage(), /stack|exception|500/i);
});
