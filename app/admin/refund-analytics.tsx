"use client";

import { useEffect, useState } from "react";
import type { AdminRefundAnalyticsResult } from "../services/admin-refund-analytics";
import styles from "./admin.module.css";
import {
  nextRefundSort,
  refundAnalyticsErrorMessage,
  refundAnalyticsView,
  type RefundSort,
  type RefundSortColumn,
} from "./refund-analytics-ui";
import type { SalesAnalyticsRequest } from "./sales-analytics-ui";

type RefundResponse = AdminRefundAnalyticsResult & { ok: true };

function sortIndicator(sort: RefundSort, column: RefundSortColumn) {
  if (sort?.column !== column) return "↕";
  return sort.direction === "asc" ? "↑" : "↓";
}

export default function RefundAnalytics({ request }: { request: SalesAnalyticsRequest }) {
  const [result, setResult] = useState<AdminRefundAnalyticsResult | null>(null);
  const [sort, setSort] = useState<RefundSort>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!request.ok) {
      setResult(null);
      setError("");
      setBusy(false);
      return;
    }

    const controller = new AbortController();
    setBusy(true);
    setError("");
    void (async () => {
      try {
        const response = await fetch(request.url, {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !body || typeof body !== "object" || !("ok" in body) || body.ok !== true) {
          throw new Error("REFUND_ANALYTICS_REQUEST_FAILED");
        }
        const analytics = body as RefundResponse;
        if (!Array.isArray(analytics.products) || !analytics.totals) {
          throw new Error("REFUND_ANALYTICS_RESPONSE_INVALID");
        }
        setResult(analytics);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setResult(null);
        setError(refundAnalyticsErrorMessage());
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();

    return () => controller.abort();
  }, [request, attempt]);

  const view = result ? refundAnalyticsView(result, sort) : null;

  return (
    <section className={styles.analyticsPanel} aria-labelledby="analytics-refunds-heading">
      <div className={styles.analyticsPanelHeading}>
        <h3 id="analytics-refunds-heading">Remboursements</h3>
        <p>Cohorte basée sur la date de vente, indépendamment de la date du remboursement.</p>
      </div>

      {busy && <p className={styles.analyticsStatus} role="status">Loading refund analytics…</p>}
      {!busy && error && (
        <div className={styles.analyticsError} role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
        </div>
      )}
      {!busy && !error && !request.ok && <p className={styles.analyticsStatus}>{request.message}</p>}

      {!busy && !error && request.ok && view && (
        <>
          <div className={styles.analyticsTotals} aria-label="Refund totals">
            <article>
              <span>Quantité remboursée</span>
              <strong>{view.quantityRefundedTotal}</strong>
            </article>
            <article>
              <span>Montant remboursé</span>
              <strong>{view.refundedAmountTotal}</strong>
            </article>
            <article>
              <span>Taux global de remboursement</span>
              <strong>{view.refundRateTotal}</strong>
            </article>
          </div>

          {!view.hasSales ? (
            <p className={styles.analyticsStatus}>No sales for this period.</p>
          ) : (
            <div className={styles.salesTableWrapper}>
              <table className={styles.salesTable}>
                <thead>
                  <tr>
                    <th scope="col">
                      <button type="button" onClick={() => setSort((current) => nextRefundSort(current, "product"))}>
                        Produit <span aria-hidden="true">{sortIndicator(sort, "product")}</span>
                      </button>
                    </th>
                    <th scope="col">
                      <button type="button" onClick={() => setSort((current) => nextRefundSort(current, "quantity"))}>
                        Quantité remboursée <span aria-hidden="true">{sortIndicator(sort, "quantity")}</span>
                      </button>
                    </th>
                    <th scope="col">
                      <button type="button" onClick={() => setSort((current) => nextRefundSort(current, "amount"))}>
                        Montant remboursé <span aria-hidden="true">{sortIndicator(sort, "amount")}</span>
                      </button>
                    </th>
                    <th scope="col">
                      <button type="button" onClick={() => setSort((current) => nextRefundSort(current, "rate"))}>
                        Taux de remboursement <span aria-hidden="true">{sortIndicator(sort, "rate")}</span>
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.products.map((product) => (
                    <tr key={product.catalog_id}>
                      <td>{product.name}</td>
                      <td>{product.quantityRefundedText}</td>
                      <td>{product.refundedAmountText}</td>
                      <td>{product.refundRateText}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
