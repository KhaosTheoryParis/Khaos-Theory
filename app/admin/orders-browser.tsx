"use client";

import { FormEvent, useEffect, useState } from "react";
import { formatAdminDateTime } from "../services/admin-date";
import type { AdminOrderSummary, AdminOrdersResult } from "../services/admin-orders";
import styles from "./admin.module.css";
import { buildOrdersSearchParams, type OrdersBrowserFilters } from "./orders-filter-params";

type Filters = OrdersBrowserFilters;

type OrdersResponse = AdminOrdersResult & { ok: true };

const EMPTY_FILTERS: Filters = {
  query: "",
  name: "",
  dateFrom: "",
  dateTo: "",
  product: "",
  size: "",
  amountEuros: "",
  paymentStatus: "",
  refundStatus: "",
  sort: "created_at",
  direction: "desc",
};

const PRODUCTS = [
  ["geometry", "Geometry"],
  ["carved-cross", "Karved Kross"],
  ["hollow-cross", "Hollow Kross"],
  ["signet-corner", "Signet Korner"],
  ["damaged-ring-i", "Damaged Ring I"],
  ["damaged-ring-ii", "Damaged Ring II"],
] as const;

function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

function friendlyError(value: unknown) {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") {
    return value.error.replaceAll("_", " ").toLowerCase();
  }
  return "Unable to load orders.";
}

export default function OrdersBrowser() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [result, setResult] = useState<AdminOrdersResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  async function loadOrders(nextFilters: Filters, page: number, signal?: AbortSignal) {
    setBusy(true);
    setError("");

    try {
      const params = buildOrdersSearchParams(nextFilters, page);
      const response = await fetch(`/api/admin/orders?${params.toString()}`, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object" || !("ok" in body) || body.ok !== true) {
        throw new Error(friendlyError(body));
      }
      const ordersResponse = body as OrdersResponse;
      if (!Array.isArray(ordersResponse.orders) || !ordersResponse.pagination) {
        throw new Error("Invalid orders response.");
      }
      setResult({ orders: ordersResponse.orders, pagination: ordersResponse.pagination });
      setAppliedFilters(nextFilters);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Unable to load orders.");
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadOrders(EMPTY_FILTERS, 1, controller.signal);
    return () => controller.abort();
  }, []);

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadOrders(filters, 1);
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    void loadOrders(EMPTY_FILTERS, 1);
  }

  const page = result?.pagination.page ?? 1;
  const totalPages = result?.pagination.total_pages ?? 1;

  return (
    <section className={styles.ordersSection} aria-labelledby="orders-heading">
      <div className={styles.sectionHeading}>
        <div>
          <h2 id="orders-heading">Orders</h2>
          <p>Read-only D1 order history. Times are shown in Europe/Paris.</p>
        </div>
        <span>25 per page</span>
      </div>

      <form className={styles.orderFilters} onSubmit={submit}>
        <label className={styles.globalSearch}>
          Global search
          <input
            type="search"
            value={filters.query}
            onChange={(event) => updateFilter("query", event.target.value)}
            placeholder="Email, order ID, Checkout Session or PaymentIntent"
            maxLength={200}
          />
        </label>

        <label>
          Customer name
          <input
            value={filters.name}
            onChange={(event) => updateFilter("name", event.target.value)}
            placeholder="Partial name"
            maxLength={200}
          />
        </label>

        <label>
          Date from
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(event) => updateFilter("dateFrom", event.target.value)}
          />
        </label>
        <label>
          Date to
          <input
            type="date"
            value={filters.dateTo}
            onChange={(event) => updateFilter("dateTo", event.target.value)}
          />
        </label>
        <label>
          Product
          <select value={filters.product} onChange={(event) => updateFilter("product", event.target.value)}>
            <option value="">All products</option>
            {PRODUCTS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label>
          Size
          <input
            type="number"
            min="48"
            max="70"
            step="1"
            value={filters.size}
            onChange={(event) => updateFilter("size", event.target.value)}
            placeholder="FR"
          />
        </label>
        <label>
          Amount (EUR)
          <input
            inputMode="decimal"
            value={filters.amountEuros}
            onChange={(event) => updateFilter("amountEuros", event.target.value)}
            placeholder="250.00"
          />
        </label>
        <label>
          Payment
          <select
            value={filters.paymentStatus}
            onChange={(event) => updateFilter("paymentStatus", event.target.value)}
          >
            <option value="">All</option>
            <option value="paid">Paid</option>
          </select>
        </label>
        <label>
          Refund
          <select
            value={filters.refundStatus}
            onChange={(event) => updateFilter("refundStatus", event.target.value)}
          >
            <option value="">All</option>
            <option value="none">None</option>
            <option value="pending">Processing</option>
            <option value="partial">Partial</option>
            <option value="full">Full</option>
          </select>
        </label>
        <label>
          Sort by
          <select value={filters.sort} onChange={(event) => updateFilter("sort", event.target.value)}>
            <option value="created_at">Date</option>
            <option value="amount_total">Amount</option>
            <option value="customer_email">Email</option>
            <option value="status">Payment status</option>
            <option value="id">Order ID</option>
          </select>
        </label>
        <label>
          Direction
          <select
            value={filters.direction}
            onChange={(event) => updateFilter("direction", event.target.value as "asc" | "desc")}
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>

        <div className={styles.filterActions}>
          <button type="submit" disabled={busy}>Search</button>
          <button type="button" className={styles.secondaryButton} onClick={clearFilters} disabled={busy}>
            Clear filters
          </button>
        </div>
      </form>

      <div className={styles.orderListStatus} role="status" aria-live="polite">
        {busy ? "Loading orders…" : result ? `${result.pagination.total} order(s)` : ""}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}

      {!error && result && (
        <>
          <div className={styles.ordersTableWrapper}>
            <table className={styles.ordersTable}>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Order</th>
                  <th scope="col">Client</th>
                  <th scope="col">Email</th>
                  <th scope="col">Products</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Payment</th>
                  <th scope="col">Refund</th>
                </tr>
              </thead>
              <tbody>
                {result.orders.map((order: AdminOrderSummary) => (
                  <tr key={order.id}>
                    <td>{formatAdminDateTime(order.created_at)}</td>
                    <td><code title={order.id}>{order.id}</code></td>
                    <td>{order.customer_name || <span className={styles.muted}>—</span>}</td>
                    <td>{order.customer_email}</td>
                    <td>
                      <ul className={styles.productList}>
                        {order.lines.map((line, index) => (
                          <li key={`${line.catalog_id}-${line.size_fr}-${index}`}>
                            {line.product_name} · FR {line.size_fr} × {line.quantity}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>{formatMoney(order.amount_total, order.currency)}</td>
                    <td><span className={styles.status}>{order.payment_status}</span></td>
                    <td><span className={styles.status}>{order.refund_status}</span></td>
                  </tr>
                ))}
                {result.orders.length === 0 && (
                  <tr><td colSpan={8} className={styles.emptyState}>No orders match these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <nav className={styles.pagination} aria-label="Orders pagination">
            <button
              type="button"
              disabled={busy || page <= 1}
              onClick={() => void loadOrders(appliedFilters, page - 1)}
            >
              Previous
            </button>
            <span>Page {page} of {totalPages}</span>
            <button
              type="button"
              disabled={busy || page >= totalPages}
              onClick={() => void loadOrders(appliedFilters, page + 1)}
            >
              Next
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
