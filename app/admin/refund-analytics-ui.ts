import type { AdminRefundAnalyticsResult, AdminRefundProduct } from "../services/admin-refund-analytics";
import {
  buildAnalyticsRequest,
  type SalesAnalyticsRequest,
  type SalesPeriodInput,
} from "./sales-analytics-ui";

export type RefundSortColumn = "product" | "quantity" | "amount" | "rate";
export type RefundSort = { column: RefundSortColumn; direction: "asc" | "desc" } | null;

export function buildRefundAnalyticsRequest(input: SalesPeriodInput): SalesAnalyticsRequest {
  return buildAnalyticsRequest("/api/admin/analytics/refunds", input);
}

export function nextRefundSort(current: RefundSort, column: RefundSortColumn): RefundSort {
  if (current?.column === column) {
    return { column, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { column, direction: column === "product" ? "asc" : "desc" };
}

export function sortRefundProducts(products: AdminRefundProduct[], sort: RefundSort) {
  const sorted = [...products];
  if (!sort) return sorted;

  const direction = sort.direction === "asc" ? 1 : -1;
  sorted.sort((left, right) => {
    if (sort.column === "product") {
      return direction * left.name.localeCompare(right.name, "fr");
    }
    const difference = sort.column === "quantity"
      ? left.quantity_refunded - right.quantity_refunded
      : sort.column === "amount"
        ? left.refunded_amount - right.refunded_amount
        : left.refund_rate - right.refund_rate;
    return difference === 0 ? left.name.localeCompare(right.name, "fr") : direction * difference;
  });
  return sorted;
}

export function formatRefundMoney(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(value / 100);
}

export function formatRefundRate(rate: number, quantitySold: number) {
  const percent = new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(rate);
  const units = quantitySold === 1 ? "unité vendue" : "unités vendues";
  return `${percent} (${quantitySold} ${units})`;
}

export function refundAnalyticsView(result: AdminRefundAnalyticsResult, sort: RefundSort) {
  return {
    quantityRefundedTotal: String(result.totals.quantity_refunded),
    refundedAmountTotal: formatRefundMoney(result.totals.refunded_amount),
    refundRateTotal: formatRefundRate(result.totals.refund_rate, result.totals.quantity_sold),
    hasSales: result.totals.quantity_sold > 0,
    hasRefunds: result.totals.quantity_refunded > 0,
    products: sortRefundProducts(result.products, sort).map((product) => ({
      ...product,
      quantityRefundedText: String(product.quantity_refunded),
      refundedAmountText: formatRefundMoney(product.refunded_amount),
      refundRateText: formatRefundRate(product.refund_rate, product.quantity_sold),
    })),
  };
}

export function refundAnalyticsErrorMessage() {
  return "Unable to load refund analytics. Please try again.";
}
