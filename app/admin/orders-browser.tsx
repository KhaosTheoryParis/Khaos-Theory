"use client";

import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { formatAdminDateTime } from "../services/admin-date";
import type {
  AdminOrderDetail,
  AdminOrderSummary,
  AdminOrdersResult,
} from "../services/admin-orders";
import styles from "./admin.module.css";
import {
  buildOrdersTableSearchParams,
  nextOrdersTableSort,
  type OrdersTableSort,
  type OrdersTableSortColumn,
} from "./orders-filter-params";
import RefundForm from "./refund-form";

type OrdersResponse = AdminOrdersResult & { ok: true };
type OrderDetailResponse = { ok: true; order: AdminOrderDetail };

const INITIAL_SORT: OrdersTableSort = { column: "created_at", direction: "desc" };

function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

function friendlyError(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") {
    const messages: Record<string, string> = {
      ORDER_NOT_FOUND: "Cette commande n’existe plus.",
      UNAUTHORIZED: "La session Cloudflare Access n’est pas autorisée.",
      INVALID_ORDER_ID: "La référence de commande est invalide.",
    };
    return messages[value.error] ?? fallback;
  }
  return fallback;
}

function sortIndicator(sort: OrdersTableSort, column: OrdersTableSortColumn) {
  if (sort.column !== column) return "↕";
  return sort.direction === "asc" ? "↑" : "↓";
}

function ariaSort(sort: OrdersTableSort, column: OrdersTableSortColumn) {
  if (sort.column !== column) return "none" as const;
  return sort.direction === "asc" ? "ascending" as const : "descending" as const;
}

function OrderDetailView({
  order,
  onBack,
  onRefresh,
}: {
  order: AdminOrderDetail;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <section className={styles.orderDetail} aria-labelledby="order-detail-title">
      <div className={styles.orderDetailHeader}>
        <div>
          <p className={styles.eyebrow}>Transaction</p>
          <h2 id="order-detail-title">{order.customer_name || "Client non renseigné"}</h2>
          <code>{order.id}</code>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={onBack}>
          Retour aux commandes
        </button>
      </div>

      <div className={styles.orderDetailGrid}>
        <section className={styles.orderDetailPanel} aria-labelledby="customer-detail-title">
          <h3 id="customer-detail-title">Client et paiement</h3>
          <dl className={styles.orderDetailList}>
            <div><dt>Nom</dt><dd>{order.customer_name || "Non renseigné"}</dd></div>
            <div><dt>E-mail</dt><dd>{order.customer_email}</dd></div>
            <div><dt>Date d’achat</dt><dd>{formatAdminDateTime(order.created_at)}</dd></div>
            <div><dt>Statut du paiement</dt><dd>{order.payment_status}</dd></div>
            <div><dt>Moyen de paiement</dt><dd>Non enregistré dans D1</dd></div>
          </dl>
        </section>

        <section className={styles.orderDetailPanel} aria-labelledby="references-detail-title">
          <h3 id="references-detail-title">Références</h3>
          <dl className={styles.orderDetailList}>
            <div><dt>Commande</dt><dd><code>{order.id}</code></dd></div>
            <div><dt>PaymentIntent</dt><dd><code>{order.stripe_payment_intent_id}</code></dd></div>
            <div><dt>Checkout Session</dt><dd><code>{order.stripe_checkout_session_id}</code></dd></div>
            <div><dt>Facture Pennylane</dt><dd><code>{order.pennylane_invoice_id}</code></dd></div>
          </dl>
        </section>

        <section className={styles.orderDetailPanel} aria-labelledby="shipping-detail-title">
          <h3 id="shipping-detail-title">Livraison</h3>
          {order.shipping_address ? (
            <dl className={styles.orderDetailList}>
              <div><dt>Destinataire</dt><dd>{order.shipping_address.name ?? "Non renseigné"}</dd></div>
              <div><dt>Adresse</dt><dd>{order.shipping_address.line1}</dd></div>
              {order.shipping_address.line2
                ? <div><dt>Complément</dt><dd>{order.shipping_address.line2}</dd></div>
                : null}
              <div><dt>Ville</dt><dd>{order.shipping_address.postal_code} {order.shipping_address.city}</dd></div>
              <div><dt>Pays</dt><dd>{order.shipping_address.country}</dd></div>
            </dl>
          ) : (
            <p className={styles.muted}>Adresse de livraison indisponible dans Stripe.</p>
          )}
          {order.shipping ? (
            <dl className={styles.orderDetailList}>
              <div><dt>Pays enregistré</dt><dd>{order.shipping.country ?? "Non renseigné"}</dd></div>
              <div><dt>Zone</dt><dd>{order.shipping.zone ?? "Non renseignée"}</dd></div>
              <div><dt>Montant payé</dt><dd>{formatMoney(order.shipping.amount, order.currency)}</dd></div>
              <div><dt>Déjà remboursé</dt><dd>{formatMoney(order.shipping.refunded_amount, order.currency)}</dd></div>
              <div><dt>Réservé</dt><dd>{formatMoney(order.shipping.reserved_amount, order.currency)}</dd></div>
              <div><dt>Encore remboursable</dt><dd>{formatMoney(order.shipping.refundable_amount, order.currency)}</dd></div>
            </dl>
          ) : <p className={styles.muted}>Aucune ligne de livraison enregistrée.</p>}
        </section>

        <section className={styles.orderDetailPanel} aria-labelledby="amounts-detail-title">
          <h3 id="amounts-detail-title">Montants</h3>
          <dl className={styles.orderDetailList}>
            <div><dt>Produits</dt><dd>{order.products_subtotal === null
              ? "Non renseigné" : formatMoney(order.products_subtotal, order.currency)}</dd></div>
            <div><dt>Shipping</dt><dd>{formatMoney(order.shipping?.amount ?? 0, order.currency)}</dd></div>
            <div><dt>Total payé</dt><dd>{formatMoney(order.amount_total, order.currency)}</dd></div>
            <div><dt>Reste remboursable</dt><dd>{formatMoney(order.remaining_refundable_amount, order.currency)}</dd></div>
          </dl>
        </section>
      </div>

      <section className={styles.orderProducts} aria-labelledby="order-products-title">
        <h3 id="order-products-title">Produits</h3>
        <div className={styles.ordersTableWrapper}>
          <table className={styles.orderDetailTable}>
            <thead>
              <tr>
                <th scope="col">Produit</th>
                <th scope="col">Référence</th>
                <th scope="col">Taille</th>
                <th scope="col">Quantité</th>
                <th scope="col">Prix unitaire</th>
                <th scope="col">Remboursé</th>
                <th scope="col">Réservé</th>
                <th scope="col">Restant</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.order_line_id}>
                  <td>{line.product_name}</td>
                  <td><code>{line.catalog_id}</code></td>
                  <td>FR {line.size_fr}</td>
                  <td>{line.quantity}</td>
                  <td>{formatMoney(line.unit_amount, order.currency)}</td>
                  <td>{line.refunded_quantity}</td>
                  <td>{line.reserved_refund_quantity}</td>
                  <td>{line.refundable_quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <RefundForm key={order.id} order={order} onRefunded={onRefresh} />
    </section>
  );
}

export default function OrdersBrowser() {
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [sort, setSort] = useState<OrdersTableSort>(INITIAL_SORT);
  const [result, setResult] = useState<AdminOrdersResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<AdminOrderDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");

  async function loadOrders(
    nextQuery: string,
    page: number,
    nextSort: OrdersTableSort,
    signal?: AbortSignal,
  ) {
    setBusy(true);
    setError("");
    try {
      const params = buildOrdersTableSearchParams(nextQuery, page, nextSort);
      const response = await fetch(`/api/admin/orders?${params.toString()}`, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object" || !("ok" in body) || body.ok !== true) {
        throw new Error(friendlyError(body, "Impossible de charger les commandes."));
      }
      const ordersResponse = body as OrdersResponse;
      if (!Array.isArray(ordersResponse.orders) || !ordersResponse.pagination) {
        throw new Error("Réponse commandes invalide.");
      }
      setResult({ orders: ordersResponse.orders, pagination: ordersResponse.pagination });
      setAppliedQuery(nextQuery);
      setSort(nextSort);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Impossible de charger les commandes.");
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }

  async function loadOrderDetail(orderId: string) {
    setDetailBusy(true);
    setDetailError("");
    try {
      const response = await fetch(`/api/admin/orders?order_id=${encodeURIComponent(orderId)}`, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object" || !("ok" in body) || body.ok !== true) {
        throw new Error(friendlyError(body, "Impossible de charger cette commande."));
      }
      const detailResponse = body as OrderDetailResponse;
      if (!detailResponse.order || !Array.isArray(detailResponse.order.lines)) {
        throw new Error("Réponse commande invalide.");
      }
      setSelectedOrder(detailResponse.order);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : "Impossible de charger cette commande.");
    } finally {
      setDetailBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadOrders("", 1, INITIAL_SORT, controller.signal);
    return () => controller.abort();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadOrders(query, 1, sort);
  }

  function clearSearch() {
    setQuery("");
    void loadOrders("", 1, sort);
  }

  function changeSort(column: OrdersTableSortColumn) {
    const nextSort = nextOrdersTableSort(sort, column);
    void loadOrders(appliedQuery, 1, nextSort);
  }

  function openOrder(order: AdminOrderSummary) {
    setSelectedOrder(null);
    void loadOrderDetail(order.id);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, order: AdminOrderSummary) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openOrder(order);
    }
  }

  if (detailBusy) {
    return <p className={styles.orderListStatus} role="status">Chargement de la transaction…</p>;
  }

  if (detailError) {
    return (
      <section className={styles.ordersSection}>
        <button type="button" className={styles.secondaryButton}
          onClick={() => { setDetailError(""); setSelectedOrder(null); }}>Retour aux commandes</button>
        <p className={styles.error} role="alert">{detailError}</p>
      </section>
    );
  }

  if (selectedOrder) {
    return <OrderDetailView order={selectedOrder}
      onBack={() => setSelectedOrder(null)}
      onRefresh={() => loadOrderDetail(selectedOrder.id)} />;
  }

  const page = result?.pagination.page ?? 1;
  const totalPages = result?.pagination.total_pages ?? 1;

  return (
    <section className={styles.ordersSection} aria-labelledby="orders-heading">
      <div className={styles.sectionHeading}>
        <div>
          <h2 id="orders-heading">Commandes</h2>
          <p>Recherche D1 protégée. 25 résultats maximum par page.</p>
        </div>
      </div>

      <form className={styles.orderSearch} onSubmit={submit}>
        <label>
          <span>Rechercher une commande</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Client, e-mail, produit, commande, PaymentIntent, Session ou facture"
            maxLength={200} autoComplete="off" />
        </label>
        <button type="submit" disabled={busy}>Rechercher</button>
        <button type="button" className={styles.secondaryButton} onClick={clearSearch} disabled={busy || (!query && !appliedQuery)}>
          Effacer
        </button>
      </form>

      <div className={styles.orderListStatus} role="status" aria-live="polite">
        {busy ? "Chargement des commandes…" : result ? `${result.pagination.total} commande(s)` : ""}
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      {!error && result ? (
        <>
          <div className={styles.ordersTableWrapper}>
            <table className={styles.ordersTable}>
              <thead>
                <tr>
                  <th scope="col" aria-sort={ariaSort(sort, "created_at")}><button type="button" onClick={() => changeSort("created_at")}>Date <span aria-hidden="true">{sortIndicator(sort, "created_at")}</span></button></th>
                  <th scope="col" aria-sort={ariaSort(sort, "customer_name")}><button type="button" onClick={() => changeSort("customer_name")}>Nom du client <span aria-hidden="true">{sortIndicator(sort, "customer_name")}</span></button></th>
                  <th scope="col" aria-sort={ariaSort(sort, "product")}><button type="button" onClick={() => changeSort("product")}>Produit <span aria-hidden="true">{sortIndicator(sort, "product")}</span></button></th>
                </tr>
              </thead>
              <tbody>
                {result.orders.map((order) => (
                  <tr key={order.id} className={styles.orderRow} role="button" tabIndex={0}
                    aria-label={`Ouvrir la commande de ${order.customer_name || order.customer_email}`}
                    onClick={() => openOrder(order)} onKeyDown={(event) => handleRowKeyDown(event, order)}>
                    <td>{formatAdminDateTime(order.created_at)}</td>
                    <td>{order.customer_name || <span className={styles.muted}>Non renseigné</span>}</td>
                    <td><ul className={styles.productList}>{order.lines.map((line, index) => (
                      <li key={`${line.catalog_id}-${line.size_fr}-${index}`}>{line.product_name} × {line.quantity}</li>
                    ))}</ul></td>
                  </tr>
                ))}
                {result.orders.length === 0 ? (
                  <tr><td colSpan={3} className={styles.emptyState}>Aucune commande ne correspond à cette recherche.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <nav className={styles.pagination} aria-label="Pagination des commandes">
            <button type="button" disabled={busy || page <= 1}
              onClick={() => void loadOrders(appliedQuery, page - 1, sort)}>Précédent</button>
            <span>Page {page} sur {totalPages}</span>
            <button type="button" disabled={busy || page >= totalPages}
              onClick={() => void loadOrders(appliedQuery, page + 1, sort)}>Suivant</button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
