"use client";

import { useEffect, useMemo, useState } from "react";
import type { AdminSalesAnalyticsResult } from "../services/admin-sales-analytics";
import styles from "./admin.module.css";
import RefundAnalytics from "./refund-analytics";
import { buildRefundAnalyticsRequest } from "./refund-analytics-ui";
import {
  buildSalesAnalyticsRequest,
  nextSalesSort,
  salesAnalyticsErrorMessage,
  salesAnalyticsView,
  type SalesPeriodMode,
  type SalesSortColumn,
  type SalesSort,
} from "./sales-analytics-ui";

type SalesResponse = AdminSalesAnalyticsResult & { ok: true };
type SalesProduct = AdminSalesAnalyticsResult["products"][number];
type DetailSortColumn = "label" | "quantity";
type DetailSort = { column: DetailSortColumn; direction: "asc" | "desc" } | null;
type StatisticsUiState = "loading" | "empty" | "error";

function sortIndicator(sort: SalesSort, column: SalesSortColumn) {
  if (sort?.column !== column) return "↕";
  return sort.direction === "asc" ? "↑" : "↓";
}

function detailSortIndicator(sort: DetailSort, column: DetailSortColumn) {
  if (sort?.column !== column) return "↕";
  return sort.direction === "asc" ? "↑" : "↓";
}

function StatisticsState({ state, message }: { state: StatisticsUiState; message: string }) {
  return (
    <p className={styles.statisticsTableState} role={state === "error" ? "alert" : "status"}>
      {message}
    </p>
  );
}

function DetailTableState({
  state,
  colSpan,
  message,
}: {
  state: StatisticsUiState;
  colSpan: number;
  message: string;
}) {
  return (
    <tr>
      <td className={styles.detailEmptyState} colSpan={colSpan}>
        <span className={styles.statisticsTableState} role={state === "error" ? "alert" : "status"}>
          {message}
        </span>
      </td>
    </tr>
  );
}

function ProductAnalyticsDetail({
  product,
  onBack,
}: {
  product: SalesProduct;
  onBack: () => void;
}) {
  const [sizeSort, setSizeSort] = useState<DetailSort>(null);
  const [countrySort, setCountrySort] = useState<DetailSort>(null);

  function nextDetailSort(current: DetailSort, column: DetailSortColumn): DetailSort {
    if (current?.column !== column) return { column, direction: "asc" };
    return { column, direction: current.direction === "asc" ? "desc" : "asc" };
  }

  return (
    <div className={styles.productDetail}>
      <div className={styles.productDetailHeader}>
        <div>
          <p className={styles.eyebrow}>Détail produit</p>
          <h3>{product.product_name}</h3>
        </div>
        <button type="button" className={styles.productDetailBack} onClick={onBack}>
          Retour aux statistiques
        </button>
      </div>

      <div className={styles.productDetailSections}>
        <section className={styles.productDetailSection} aria-labelledby="sales-by-size-heading">
          <h4 id="sales-by-size-heading">Ventes par taille</h4>
          <div className={styles.detailTableWrapper}>
            <table className={styles.detailTable}>
              <thead>
                <tr>
                  <th scope="col">
                    <button type="button" onClick={() => setSizeSort((current) => nextDetailSort(current, "label"))}>
                      Taille <span aria-hidden="true">{detailSortIndicator(sizeSort, "label")}</span>
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" onClick={() => setSizeSort((current) => nextDetailSort(current, "quantity"))}>
                      Nombre de ventes <span aria-hidden="true">{detailSortIndicator(sizeSort, "quantity")}</span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <DetailTableState state="empty" colSpan={2} message="Données indisponibles pour le moment." />
              </tbody>
            </table>
          </div>
        </section>
        <section className={styles.productDetailSection} aria-labelledby="sales-by-country-heading">
          <h4 id="sales-by-country-heading">Ventes par pays</h4>
          <div className={styles.detailTableWrapper}>
            <table className={styles.detailTable}>
              <thead>
                <tr>
                  <th scope="col">
                    <button type="button" onClick={() => setCountrySort((current) => nextDetailSort(current, "label"))}>
                      Pays <span aria-hidden="true">{detailSortIndicator(countrySort, "label")}</span>
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" onClick={() => setCountrySort((current) => nextDetailSort(current, "quantity"))}>
                      Nombre de ventes <span aria-hidden="true">{detailSortIndicator(countrySort, "quantity")}</span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <DetailTableState state="empty" colSpan={2} message="Données indisponibles pour le moment." />
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

export default function SalesAnalytics() {
  const [mode, setMode] = useState<SalesPeriodMode>("all_time");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [result, setResult] = useState<AdminSalesAnalyticsResult | null>(null);
  const [sort, setSort] = useState<SalesSort>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState<SalesProduct | null>(null);

  const request = useMemo(
    () => buildSalesAnalyticsRequest({ mode, month, year }),
    [mode, month, year],
  );
  const refundRequest = useMemo(
    () => buildRefundAnalyticsRequest({ mode, month, year }),
    [mode, month, year],
  );

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
          throw new Error("SALES_ANALYTICS_REQUEST_FAILED");
        }
        const analytics = body as SalesResponse;
        if (!Array.isArray(analytics.products) || !analytics.totals) {
          throw new Error("SALES_ANALYTICS_RESPONSE_INVALID");
        }
        setResult(analytics);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setResult(null);
        setError(salesAnalyticsErrorMessage());
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();

    return () => controller.abort();
  }, [request, attempt]);

  const view = result ? salesAnalyticsView(result, sort) : null;

  return (
    <section className={styles.analyticsSection} aria-labelledby="analytics-heading">
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>Admin v2</p>
          <h2 id="analytics-heading">Analytics</h2>
          <p>Read-only sales cohorts. Periods use the Europe/Paris business calendar.</p>
        </div>
      </div>

      <div className={styles.analyticsControls}>
        <label>
          Period
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as SalesPeriodMode)}
          >
            <option value="all_time">All time</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </label>
        {mode === "month" && (
          <label>
            Month
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </label>
        )}
        {mode === "year" && (
          <label>
            Year
            <input
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              placeholder="YYYY"
              value={year}
              onChange={(event) => setYear(event.target.value)}
            />
          </label>
        )}
        <span className={styles.activePeriod}>
          {request.ok ? request.periodLabel : request.message}
        </span>
      </div>

      <section className={styles.analyticsPanel} aria-labelledby="analytics-sales-heading">
        <div className={styles.analyticsPanelHeading}>
          <h3 id="analytics-sales-heading">Sales</h3>
          <p>Gross sales from paid D1 orders. Refunds do not reduce these totals.</p>
        </div>

        {busy && <StatisticsState state="loading" message="Chargement des statistiques…" />}
        {!busy && error && (
          <div className={styles.analyticsError} role="alert">
            <StatisticsState state="error" message={error} />
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
          </div>
        )}
        {!busy && !error && !request.ok && (
          <StatisticsState state="error" message={request.message} />
        )}
        {!busy && !error && request.ok && !view && (
          <StatisticsState state="empty" message="Aucune donnée disponible pour cette période." />
        )}

        {!busy && !error && request.ok && view && (
          <>
            <div className={styles.analyticsTotals} aria-label="Sales totals">
              <article>
                <span>Quantity sold</span>
                <strong>{view.quantityTotal}</strong>
              </article>
              <article>
                <span>Gross revenue</span>
                <strong>{view.grossRevenueTotal}</strong>
              </article>
            </div>

            {selectedProduct ? (
              <ProductAnalyticsDetail product={selectedProduct} onBack={() => setSelectedProduct(null)} />
            ) : (
              <div className={styles.salesTableWrapper}>
                <table className={styles.salesTable}>
                <thead>
                  <tr>
                    <th scope="col">
                      <button type="button" onClick={() => setSort((current) => nextSalesSort(current, "product"))}>
                        Produit <span aria-hidden="true">{sortIndicator(sort, "product")}</span>
                      </button>
                    </th>
                    <th scope="col">
                      <button type="button" onClick={() => setSort((current) => nextSalesSort(current, "quantity"))}>
                        Nombre de ventes <span aria-hidden="true">{sortIndicator(sort, "quantity")}</span>
                      </button>
                    </th>
                    <th scope="col">
                      <button type="button" onClick={() => setSort((current) => nextSalesSort(current, "revenue"))}>
                        Chiffre d’affaires <span aria-hidden="true">{sortIndicator(sort, "revenue")}</span>
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.products.map((product) => (
                  <tr
                    key={product.catalog_id}
                    className={styles.salesTableRow}
                    role="button"
                    tabIndex={0}
                    aria-label={`Voir le détail de ${product.product_name}`}
                    onClick={() => setSelectedProduct(product)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedProduct(product);
                      }
                    }}
                  >
                      <td>{product.product_name}</td>
                      <td>{product.quantityText}</td>
                      <td>{product.grossRevenueText}</td>
                    </tr>
                  ))}
                  {view.products.length === 0 && (
                    <tr><td className={styles.emptyState} colSpan={3}>No sales for this period.</td></tr>
                  )}
                </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <RefundAnalytics request={refundRequest} />
    </section>
  );
}
