"use client";

import { useMemo, useRef, useState } from "react";
import type { AdminOrderDetail, AdminOrderDetailLine } from "../services/admin-orders";
import styles from "./admin.module.css";
import {
  buildRefundPreviewPayload,
  buildRefundRequestPayload,
  estimatedRefundAmount,
  fetchAdminRefundRequest,
  selectedRefundLines,
  validateRefundPreviewResponse,
} from "./refund-request";

type PreviewLine = {
  order_line_id: string;
  catalog_id: string;
  product_name: string;
  size_fr: number;
  unit_amount: number;
  requested_quantity: number;
  amount: number;
};

type RefundPreview = {
  refund_operation_id: string;
  order_id: string;
  amount: number;
  currency: string;
  shipping: { label: string; amount: number } | null;
  lines: PreviewLine[];
};

type Status = { type: "idle"; message: "" } | { type: "error" | "success"; message: string };
type AdminRefundResponse = {
  ok?: boolean;
  error?: string;
  preview?: RefundPreview;
  refund_id?: string;
  amount?: number;
};

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST_ORIGIN: "La requête a été refusée.",
  INVALID_REFUND_REQUEST: "La demande de remboursement est invalide.",
  ORDER_NOT_FOUND: "Cette commande n’existe plus.",
  ORDER_LINE_NOT_FOUND: "Une ligne sélectionnée n’existe plus.",
  ORDER_NOT_PAID: "Cette commande n’est pas marquée comme payée.",
  REFUND_LINES_ORDER_MISMATCH: "Les lignes sélectionnées ne correspondent plus à cette commande.",
  REFUND_QUANTITY_UNAVAILABLE: "Une quantité sélectionnée n’est plus remboursable.",
  SHIPPING_REFUND_AMOUNT_UNAVAILABLE: "La livraison n’est plus remboursable.",
  REFUND_OPERATION_FAILED: "Cette tentative a échoué. Vérifiez son état avant de réessayer.",
  REFUND_PERSISTENCE_PENDING: "Le remboursement existe, mais sa synchronisation est encore en cours.",
  STRIPE_REFUND_FAILED: "Stripe n’a pas pu finaliser ce remboursement.",
  REFUNDS_SANDBOX_ONLY: "Les remboursements sont limités à Stripe TEST.",
  UNAUTHORIZED: "La session Cloudflare Access n’est pas autorisée.",
};

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

async function callRefundApi(payload: Record<string, unknown>) {
  const response = await fetchAdminRefundRequest("/api/admin/refunds", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as AdminRefundResponse | null;
  if (!response.ok || !body?.ok) {
    const code = body?.error ?? "REFUND_REQUEST_FAILED";
    throw new Error(ERROR_MESSAGES[code] ?? "Impossible de traiter le remboursement.");
  }
  return body;
}

export default function RefundForm({
  order,
  onRefunded,
}: {
  order: AdminOrderDetail;
  onRefunded: () => Promise<void>;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [refundShipping, setRefundShipping] = useState(false);
  const [reviewedRefund, setReviewedRefund] = useState<RefundPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ type: "idle", message: "" });
  const requestInFlight = useRef(false);
  const shippingRefundableAmount = order.shipping?.refundable_amount ?? 0;

  const selectedLines = useMemo(
    () => selectedRefundLines(order.lines, quantities),
    [order.lines, quantities],
  );
  const totalRefund = useMemo(() => estimatedRefundAmount({
    lines: order.lines,
    quantities,
    refundShipping,
    shippingAmount: shippingRefundableAmount,
  }), [order.lines, quantities, refundShipping, shippingRefundableAmount]);
  const hasSelection = selectedLines.length > 0 || refundShipping;

  const resetReview = () => {
    setReviewedRefund(null);
    setStatus({ type: "idle", message: "" });
  };

  const updateQuantity = (line: AdminOrderDetailLine, quantity: number) => {
    if (busy || quantity < 0 || quantity > line.refundable_quantity) return;
    setQuantities((current) => ({ ...current, [line.order_line_id]: quantity }));
    resetReview();
  };

  const updateShipping = (selected: boolean) => {
    if (busy || shippingRefundableAmount <= 0) return;
    setRefundShipping(selected);
    resetReview();
  };

  const reviewRefund = async () => {
    if (requestInFlight.current || !hasSelection) return;
    requestInFlight.current = true;
    setBusy(true);
    setReviewedRefund(null);
    setStatus({ type: "idle", message: "" });
    try {
      const body = await callRefundApi(buildRefundPreviewPayload({
        orderId: order.id,
        lines: selectedLines,
        refundShipping,
      }));
      const previewSelections = selectedLines.map((selection) => {
        const line = order.lines.find((candidate) => candidate.order_line_id === selection.orderLineId);
        if (!line) throw new Error("Une ligne sélectionnée n’existe plus.");
        return {
          orderLineId: line.order_line_id,
          catalogId: line.catalog_id,
          productName: line.product_name,
          sizeFr: line.size_fr,
          unitAmount: line.unit_amount,
          quantity: selection.quantity,
        };
      });
      if (!body.preview || body.preview.amount !== totalRefund ||
        !validateRefundPreviewResponse({
          preview: body.preview,
          orderId: order.id,
          currency: order.currency,
          selections: previewSelections,
          refundShipping,
          shippingAmount: shippingRefundableAmount,
        })) {
        throw new Error("L’aperçu serveur ne correspond plus à la sélection.");
      }
      setReviewedRefund(body.preview);
    } catch (error) {
      setStatus({ type: "error", message: error instanceof Error
        ? error.message : "Impossible de préparer le remboursement." });
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  };

  const confirmRefund = async () => {
    if (!reviewedRefund || requestInFlight.current || status.type === "success") return;
    requestInFlight.current = true;
    setBusy(true);
    setStatus({ type: "idle", message: "" });
    try {
      const body = await callRefundApi(buildRefundRequestPayload({
        lines: reviewedRefund.lines.map((line) => ({
          orderLineId: line.order_line_id,
          quantity: line.requested_quantity,
        })),
        operationId: reviewedRefund.refund_operation_id,
        orderId: order.id,
        refundShipping: reviewedRefund.shipping !== null,
      }));
      setStatus({
        type: "success",
        message: `Remboursement ${body.refund_id ?? "confirmé"} : ${formatAmount(body.amount ?? reviewedRefund.amount, order.currency)}.`,
      });
      await onRefunded();
    } catch (error) {
      setStatus({ type: "error", message: error instanceof Error
        ? error.message : "Impossible de créer le remboursement." });
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section className={styles.refundSection} aria-labelledby="refund-title">
      <div className={styles.refundHeading}>
        <div>
          <h2 id="refund-title">Préparer un remboursement</h2>
          <p>Sélection informative ; le serveur recalcule et valide le montant final.</p>
        </div>
        <span className={styles.sandboxNotice}>Stripe TEST / Pennylane Sandbox</span>
      </div>

      <div className={styles.orderLines}>
        {order.lines.map((line) => {
          const selectedQuantity = quantities[line.order_line_id] ?? 0;
          const unavailable = line.refundable_quantity < 1;
          return (
            <article className={`${styles.lineCard} ${selectedQuantity > 0 ? styles.selectedLine : ""}`} key={line.order_line_id}>
              <label className={styles.lineSelection}>
                <input type="checkbox" checked={selectedQuantity > 0} disabled={busy || unavailable}
                  onChange={(event) => updateQuantity(line, event.target.checked ? 1 : 0)} />
                <span><strong>{line.product_name}</strong><small>{line.catalog_id} · FR {line.size_fr}</small></span>
              </label>
              <dl>
                <div><dt>Prix unitaire</dt><dd>{formatAmount(line.unit_amount, order.currency)}</dd></div>
                <div><dt>Acheté</dt><dd>{line.quantity}</dd></div>
                <div><dt>Déjà remboursé</dt><dd>{line.refunded_quantity}</dd></div>
                <div><dt>Réservé</dt><dd>{line.reserved_refund_quantity}</dd></div>
                <div><dt>Remboursable</dt><dd>{line.refundable_quantity}</dd></div>
              </dl>
              {line.refundable_quantity > 1 ? (
                <label className={styles.quantityLabel}>
                  Quantité à rembourser
                  <select value={selectedQuantity} disabled={busy || unavailable}
                    onChange={(event) => updateQuantity(line, Number(event.target.value))}>
                    {Array.from({ length: line.refundable_quantity + 1 }, (_, quantity) => (
                      <option key={quantity} value={quantity}>{quantity}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {unavailable ? <p className={styles.fullyRefunded}>Entièrement remboursé ou réservé</p> : null}
            </article>
          );
        })}

        {order.shipping ? (
          <article className={`${styles.lineCard} ${refundShipping ? styles.selectedLine : ""}`}>
            <label className={styles.lineSelection}>
              <input type="checkbox" checked={refundShipping} disabled={busy || shippingRefundableAmount <= 0}
                onChange={(event) => updateShipping(event.target.checked)} />
              <span><strong>Livraison sécurisée</strong><small>Ligne indépendante des produits</small></span>
            </label>
            <dl>
              <div><dt>Payé</dt><dd>{formatAmount(order.shipping.amount, order.currency)}</dd></div>
              <div><dt>Déjà remboursé</dt><dd>{formatAmount(order.shipping.refunded_amount, order.currency)}</dd></div>
              <div><dt>Réservé</dt><dd>{formatAmount(order.shipping.reserved_amount, order.currency)}</dd></div>
              <div><dt>Remboursable</dt><dd>{formatAmount(shippingRefundableAmount, order.currency)}</dd></div>
            </dl>
            {shippingRefundableAmount <= 0
              ? <p className={styles.fullyRefunded}>Livraison déjà remboursée ou non remboursable</p>
              : null}
          </article>
        ) : null}
      </div>

      <div className={styles.refundTotal} aria-live="polite">
        <span>Total estimé</span><strong>{formatAmount(totalRefund, order.currency)}</strong>
      </div>
      <button className={styles.confirmButton} type="button"
        disabled={busy || !hasSelection || status.type === "success"} onClick={reviewRefund}>
        {busy && !reviewedRefund ? "VÉRIFICATION…" : "REMBOURSER"}
      </button>

      {reviewedRefund ? (
        <div className={styles.review} role="dialog" aria-modal="false" aria-labelledby="refund-review-title">
          <h3 id="refund-review-title">Confirmer le remboursement</h3>
          <dl>
            {reviewedRefund.lines.map((line) => (
              <div key={line.order_line_id}>
                <dt>{line.product_name} — FR {line.size_fr} × {line.requested_quantity}</dt>
                <dd>{formatAmount(line.amount, order.currency)}</dd>
              </div>
            ))}
            {reviewedRefund.shipping ? (
              <div><dt>Livraison sécurisée</dt><dd>{formatAmount(reviewedRefund.shipping.amount, order.currency)}</dd></div>
            ) : null}
          </dl>
          <div className={styles.refundTotal}>
            <span>Total validé par le serveur</span><strong>{formatAmount(reviewedRefund.amount, order.currency)}</strong>
          </div>
          <div className={styles.reviewActions}>
            <button className={styles.secondaryButton} type="button" disabled={busy}
              onClick={() => setReviewedRefund(null)}>Annuler</button>
            <button className={styles.confirmButton} type="button" disabled={busy || status.type === "success"}
              onClick={confirmRefund}>{busy ? "REMBOURSEMENT…" : "CONFIRMER LE REMBOURSEMENT"}</button>
          </div>
        </div>
      ) : null}

      {status.message ? (
        <p className={status.type === "success" ? styles.success : styles.error} role="status">{status.message}</p>
      ) : null}
    </section>
  );
}
