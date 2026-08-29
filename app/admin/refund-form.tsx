"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import styles from "./admin.module.css";
import {
  buildRefundRequestPayload,
  fetchAdminRefundRequest,
  validateRefundPreviewResponse,
} from "./refund-request";

type OrderLine = {
  order_line_id: string; catalog_id: string; product_name: string; size_fr: number;
  quantity: number; unit_amount: number; refunded_quantity: number;
  refundable_quantity: number; refundable_amount: number;
};
type OrderSearchResult = {
  id: string; stripe_payment_intent_id: string; stripe_checkout_session_id: string;
  amount_total: number; currency: string; lines: OrderLine[];
};
type PreviewLine = {
  order_line_id: string; catalog_id: string; product_name: string; size_fr: number;
  unit_amount: number; requested_quantity: number; amount: number;
};
type RefundPreview = {
  refund_operation_id: string; order_id: string; amount: number; currency: string;
  lines: PreviewLine[];
};
type Status = { type: "idle"; message: "" } | { type: "error" | "success"; message: string };
type AdminRefundResponse = {
  ok?: boolean; error?: string; order?: OrderSearchResult; preview?: RefundPreview;
  refund_id?: string; amount?: number;
};

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST_ORIGIN: "The request origin was refused.",
  INVALID_REFUND_REQUEST: "The request is invalid.",
  ORDER_NOT_FOUND: "No order was found for this reference.",
  ORDER_LINE_NOT_FOUND: "A selected order line no longer exists.",
  ORDER_NOT_PAID: "This order is not marked as paid.",
  REFUND_LINES_ORDER_MISMATCH: "All selected items must belong to the same order.",
  REFUND_QUANTITY_UNAVAILABLE: "A selected quantity is no longer refundable.",
  REFUND_OPERATION_FAILED: "This refund attempt failed. Review it again before retrying.",
  REFUNDS_SANDBOX_ONLY: "Refunds are currently restricted to Stripe Sandbox.",
  UNAUTHORIZED: "Your Cloudflare Access session is not authorized.",
};

function formatAmount(amount: number) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }).format(amount / 100);
}

async function callRefundApi(payload: Record<string, unknown>) {
  const response = await fetchAdminRefundRequest("/api/admin/refunds", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as AdminRefundResponse | null;
  if (!response.ok || !body?.ok) {
    const code = body?.error ?? "REFUND_REQUEST_FAILED";
    throw new Error(ERROR_MESSAGES[code] ?? `Request failed (${code}).`);
  }
  return body;
}

export default function RefundForm() {
  const [reference, setReference] = useState("");
  const [order, setOrder] = useState<OrderSearchResult | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reviewedRefund, setReviewedRefund] = useState<RefundPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ type: "idle", message: "" });
  const requestInFlight = useRef(false);

  const selectedLines = useMemo(() => order?.lines.flatMap((line) => {
    const quantity = quantities[line.order_line_id] ?? 0;
    return quantity > 0 ? [{ orderLineId: line.order_line_id, quantity }] : [];
  }) ?? [], [order, quantities]);
  const totalRefund = useMemo(() => order?.lines.reduce(
    (total, line) => total + line.unit_amount * (quantities[line.order_line_id] ?? 0), 0,
  ) ?? 0, [order, quantities]);

  const resetConfirmation = () => {
    setReviewedRefund(null); setConfirmed(false); setStatus({ type: "idle", message: "" });
  };
  const resetSelection = () => { setQuantities({}); resetConfirmation(); };

  const searchOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (requestInFlight.current) return;
    requestInFlight.current = true; setBusy(true); setOrder(null); resetSelection();
    try {
      const body = await callRefundApi({ action: "search", reference: reference.trim() });
      if (!body.order || body.order.currency !== "eur" || !body.order.lines?.length) {
        throw new Error("The order response is incomplete.");
      }
      setOrder(body.order);
    } catch (error) {
      setStatus({ type: "error", message: error instanceof Error ? error.message : "Unable to find the order." });
    } finally { requestInFlight.current = false; setBusy(false); }
  };

  const updateQuantity = (line: OrderLine, quantity: number) => {
    if (busy || line.refundable_quantity < 1 || quantity < 0 || quantity > line.refundable_quantity) return;
    setQuantities((current) => ({ ...current, [line.order_line_id]: quantity }));
    resetConfirmation();
  };

  const reviewRefund = async () => {
    if (requestInFlight.current || selectedLines.length === 0) return;
    requestInFlight.current = true; setBusy(true); setReviewedRefund(null); setConfirmed(false);
    setStatus({ type: "idle", message: "" });
    try {
      const body = await callRefundApi({
        action: "preview",
        lines: selectedLines.map((line) => ({ order_line_id: line.orderLineId, quantity: line.quantity })),
      });
      const previewSelections = selectedLines.map((selection) => {
        const line = order?.lines.find((candidate) =>
          candidate.order_line_id === selection.orderLineId);
        if (!line) throw new Error("A selected order line no longer exists.");
        return {
          orderLineId: line.order_line_id,
          catalogId: line.catalog_id,
          productName: line.product_name,
          sizeFr: line.size_fr,
          unitAmount: line.unit_amount,
          quantity: selection.quantity,
        };
      });
      if (!body.preview || !order || body.preview.amount !== totalRefund ||
        !validateRefundPreviewResponse({
          preview: body.preview,
          orderId: order.id,
          currency: order.currency,
          selections: previewSelections,
        })) {
        throw new Error("The refund preview no longer matches the selected items.");
      }
      setReviewedRefund(body.preview);
    } catch (error) {
      setStatus({ type: "error", message: error instanceof Error ? error.message : "Unable to review the refund." });
    } finally { requestInFlight.current = false; setBusy(false); }
  };

  const confirmRefund = async () => {
    if (!reviewedRefund || !confirmed || requestInFlight.current || status.type === "success") return;
    requestInFlight.current = true; setBusy(true); setStatus({ type: "idle", message: "" });
    try {
      const body = await callRefundApi(buildRefundRequestPayload({
        lines: reviewedRefund.lines.map((line) => ({
          orderLineId: line.order_line_id, quantity: line.requested_quantity,
        })),
        operationId: reviewedRefund.refund_operation_id,
      }));
      setStatus({ type: "success", message: `Refund ${body.refund_id ?? "confirmed"}: ${formatAmount(body.amount ?? reviewedRefund.amount)}.` });
    } catch (error) {
      setStatus({ type: "error", message: error instanceof Error ? error.message : "Unable to create the refund." });
    } finally { requestInFlight.current = false; setBusy(false); }
  };

  return (
    <section className={styles.refundSection} aria-labelledby="partial-refund-title">
      <h2 id="partial-refund-title">Partial refund</h2>
      <p className={styles.sandboxNotice}>Stripe Sandbox only</p>
      <form className={styles.form} onSubmit={searchOrder}>
        <label htmlFor="order-reference">Order, PaymentIntent or Checkout Session ID</label>
        <input id="order-reference" name="reference" type="text" autoComplete="off" required
          value={reference} onChange={(event) => { setReference(event.target.value); setOrder(null); resetSelection(); }}
          placeholder="Order UUID, pi_… or cs_test_…" />
        <button type="submit" disabled={busy}>{busy && !order ? "SEARCHING…" : "SEARCH ORDER"}</button>
      </form>

      {order ? <section className={styles.orderResult} aria-labelledby="order-result-title">
        <h3 id="order-result-title">Order {order.id}</h3>
        <p>{formatAmount(order.amount_total)} · {order.lines.length} line(s)</p>
        <div className={styles.orderLines}>
          {order.lines.map((line) => {
            const selectedQuantity = quantities[line.order_line_id] ?? 0;
            const unavailable = line.refundable_quantity < 1;
            return <article className={`${styles.lineCard} ${selectedQuantity > 0 ? styles.selectedLine : ""}`} key={line.order_line_id}>
              <label className={styles.lineSelection}>
                <input type="checkbox" checked={selectedQuantity > 0} disabled={busy || unavailable}
                  onChange={(event) => updateQuantity(line, event.target.checked ? 1 : 0)} />
                <span><strong>{line.product_name}</strong><small>FR {line.size_fr}</small></span>
              </label>
              <dl>
                <div><dt>Unit price</dt><dd>{formatAmount(line.unit_amount)}</dd></div>
                <div><dt>Purchased</dt><dd>{line.quantity}</dd></div>
                <div><dt>Already refunded</dt><dd>{line.refunded_quantity}</dd></div>
                <div><dt>Still refundable</dt><dd>{line.refundable_quantity}</dd></div>
              </dl>
              <label className={styles.quantityLabel}>
                Qty to refund
                <select value={selectedQuantity} disabled={busy || unavailable}
                  onChange={(event) => updateQuantity(line, Number(event.target.value))}>
                  {Array.from({ length: line.refundable_quantity + 1 }, (_, quantity) =>
                    <option key={quantity} value={quantity}>{quantity}</option>)}
                </select>
              </label>
              {unavailable ? <p className={styles.fullyRefunded}>Fully refunded</p> : null}
            </article>;
          })}
        </div>
        <div className={styles.refundTotal}><span>TOTAL REFUND</span><strong>{formatAmount(totalRefund)}</strong></div>
        <button className={styles.confirmButton} type="button" disabled={busy || selectedLines.length === 0 || status.type === "success"}
          onClick={reviewRefund}>{busy && !reviewedRefund ? "CHECKING…" : "REFUND SELECTED ITEMS"}</button>
      </section> : null}

      {reviewedRefund ? <div className={styles.review}>
        <h3>Review refund</h3>
        <dl>{reviewedRefund.lines.map((line) =>
          <div key={line.order_line_id}><dt>{line.product_name} — FR {line.size_fr} ×{line.requested_quantity}</dt><dd>{formatAmount(line.amount)}</dd></div>)}</dl>
        <div className={styles.refundTotal}><span>TOTAL REFUND</span><strong>{formatAmount(reviewedRefund.amount)}</strong></div>
        <label className={styles.confirmation}>
          <input type="checkbox" checked={confirmed} disabled={busy || status.type === "success"}
            onChange={(event) => setConfirmed(event.target.checked)} />
          I confirm this Sandbox refund of {formatAmount(reviewedRefund.amount)}.
        </label>
        <button className={styles.confirmButton} type="button" disabled={!confirmed || busy || status.type === "success"}
          onClick={confirmRefund}>{busy ? "REFUNDING…" : "CONFIRM REFUND"}</button>
      </div> : null}
      {status.message ? <p className={status.type === "success" ? styles.success : styles.error} role="status">{status.message}</p> : null}
    </section>
  );
}
