"use client";

import { useRef, useState, type FormEvent } from "react";
import styles from "./admin.module.css";

type OrderLine = {
  order_line_id: string;
  catalog_id: string;
  product_name: string;
  size_fr: number;
  quantity: number;
  unit_amount: number;
  refunded_quantity: number;
  refundable_quantity: number;
  refundable_amount: number;
};

type OrderSearchResult = {
  id: string;
  stripe_payment_intent_id: string;
  stripe_checkout_session_id: string;
  amount_total: number;
  currency: string;
  lines: OrderLine[];
};

type RefundPreview = {
  order_line_id: string;
  catalog_id: string;
  product_name: string;
  size_fr: number;
  unit_amount: number;
  available_quantity: number;
  refundable_amount: number;
  currency: string;
};

type ReviewedRefund = RefundPreview & {
  requestedAmount: number;
  requestedQuantity: number;
};

type Status =
  | { type: "idle"; message: "" }
  | { type: "error" | "success"; message: string };

type AdminRefundResponse = {
  ok?: boolean;
  error?: string;
  order?: OrderSearchResult;
  preview?: RefundPreview;
  refund_id?: string;
  amount?: number;
};

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST_ORIGIN: "The request origin was refused.",
  INVALID_REFUND_REQUEST: "The request is invalid.",
  ORDER_NOT_FOUND: "No order was found for this reference.",
  ORDER_LINE_NOT_FOUND: "The selected order line no longer exists.",
  ORDER_NOT_PAID: "This order is not marked as paid.",
  REFUND_AMOUNT_UNAVAILABLE: "This amount is not available for refund.",
  REFUND_QUANTITY_UNAVAILABLE: "The requested quantity is no longer refundable.",
  REFUNDS_SANDBOX_ONLY: "Refunds are currently restricted to Stripe Sandbox.",
  UNAUTHORIZED: "Your Cloudflare Access session is not authorized.",
};

function eurosToCents(value: string) {
  const normalized = value.trim().replace(",", ".");
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(normalized);

  if (!match) return null;

  const euros = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const amount = euros * 100 + cents;

  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function formatAmount(amount: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "EUR",
  }).format(amount / 100);
}

async function callRefundApi(payload: Record<string, unknown>) {
  const response = await fetch("/api/admin/refunds", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
  const [selectedLine, setSelectedLine] = useState<OrderLine | null>(null);
  const [amount, setAmount] = useState("");
  const [reviewedRefund, setReviewedRefund] = useState<ReviewedRefund | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ type: "idle", message: "" });
  const requestInFlight = useRef(false);

  const resetConfirmation = () => {
    setReviewedRefund(null);
    setConfirmed(false);
    setStatus({ type: "idle", message: "" });
  };

  const searchOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (requestInFlight.current) return;

    requestInFlight.current = true;
    setBusy(true);
    setOrder(null);
    setSelectedLine(null);
    setAmount("");
    resetConfirmation();

    try {
      const body = await callRefundApi({ action: "search", reference: reference.trim() });

      if (
        !body.order ||
        body.order.currency !== "eur" ||
        !Array.isArray(body.order.lines) ||
        body.order.lines.length === 0
      ) {
        throw new Error("The order response is incomplete.");
      }

      setOrder(body.order);
    } catch (error) {
      setStatus({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to find the order.",
      });
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  };

  const chooseLine = (line: OrderLine) => {
    if (line.refundable_quantity < 1 || busy) return;

    setSelectedLine(line);
    setAmount("");
    resetConfirmation();
  };

  const reviewRefund = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedLine || requestInFlight.current) return;

    const requestedAmount = eurosToCents(amount);

    if (!requestedAmount) {
      setStatus({ type: "error", message: "Enter a valid positive amount in euros." });
      return;
    }

    requestInFlight.current = true;
    setBusy(true);
    setReviewedRefund(null);
    setConfirmed(false);
    setStatus({ type: "idle", message: "" });

    try {
      const body = await callRefundApi({
        action: "preview",
        order_line_id: selectedLine.order_line_id,
      });
      const preview = body.preview;

      if (
        !preview ||
        preview.currency !== "eur" ||
        !Number.isSafeInteger(preview.unit_amount) ||
        preview.unit_amount <= 0 ||
        requestedAmount > preview.refundable_amount ||
        requestedAmount % preview.unit_amount !== 0
      ) {
        throw new Error("The amount must match one or more complete refundable units.");
      }

      setReviewedRefund({
        ...preview,
        requestedAmount,
        requestedQuantity: requestedAmount / preview.unit_amount,
      });
    } catch (error) {
      setStatus({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to review the refund.",
      });
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  };

  const confirmRefund = async () => {
    if (!reviewedRefund || !confirmed || requestInFlight.current || status.type === "success") {
      return;
    }

    requestInFlight.current = true;
    setBusy(true);
    setStatus({ type: "idle", message: "" });

    try {
      const body = await callRefundApi({
        action: "refund",
        order_line_id: reviewedRefund.order_line_id,
        amount: reviewedRefund.requestedAmount,
      });

      setStatus({
        type: "success",
        message: `Refund ${body.refund_id ?? "confirmed"}: ${formatAmount(body.amount ?? reviewedRefund.requestedAmount)}.`,
      });
    } catch (error) {
      setStatus({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to create the refund.",
      });
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section className={styles.refundSection} aria-labelledby="partial-refund-title">
      <h2 id="partial-refund-title">Partial refund</h2>
      <p className={styles.sandboxNotice}>Stripe Sandbox only</p>

      <form className={styles.form} onSubmit={searchOrder}>
        <label htmlFor="order-reference">Order, PaymentIntent or Checkout Session ID</label>
        <input
          id="order-reference"
          name="reference"
          type="text"
          autoComplete="off"
          required
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
            setOrder(null);
            setSelectedLine(null);
            setAmount("");
            resetConfirmation();
          }}
          placeholder="Order UUID, pi_… or cs_test_…"
        />
        <button type="submit" disabled={busy}>
          {busy && !order ? "SEARCHING…" : "SEARCH ORDER"}
        </button>
      </form>

      {order ? (
        <section className={styles.orderResult} aria-labelledby="order-result-title">
          <h3 id="order-result-title">Order {order.id}</h3>
          <p>{formatAmount(order.amount_total)} · {order.lines.length} line(s)</p>

          <div className={styles.orderLines}>
            {order.lines.map((line) => (
              <article
                className={`${styles.lineCard} ${selectedLine?.order_line_id === line.order_line_id ? styles.selectedLine : ""}`}
                key={line.order_line_id}
              >
                <div>
                  <h4>{line.product_name}</h4>
                  <p>FR {line.size_fr}</p>
                </div>
                <dl>
                  <div><dt>Purchased</dt><dd>{line.quantity}</dd></div>
                  <div><dt>Unit price</dt><dd>{formatAmount(line.unit_amount)}</dd></div>
                  <div><dt>Already refunded</dt><dd>{line.refunded_quantity}</dd></div>
                  <div><dt>Still refundable</dt><dd>{line.refundable_quantity}</dd></div>
                  <div><dt>Maximum refund</dt><dd>{formatAmount(line.refundable_amount)}</dd></div>
                </dl>
                <button
                  type="button"
                  disabled={line.refundable_quantity < 1 || busy}
                  onClick={() => chooseLine(line)}
                >
                  {line.refundable_quantity < 1 ? "FULLY REFUNDED" : "SELECT LINE"}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {selectedLine ? (
        <form className={styles.form} onSubmit={reviewRefund}>
          <h3>Refund {selectedLine.product_name} — FR {selectedLine.size_fr}</h3>
          <label htmlFor="refund-amount">Refund amount (EUR)</label>
          <input
            id="refund-amount"
            name="amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            required
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              resetConfirmation();
            }}
            placeholder={(selectedLine.unit_amount / 100).toFixed(2)}
          />
          <p className={styles.amountHelp}>
            Complete units only · Maximum {formatAmount(selectedLine.refundable_amount)}
          </p>
          <button type="submit" disabled={busy || status.type === "success"}>
            {busy && !reviewedRefund ? "CHECKING…" : "REVIEW REFUND"}
          </button>
        </form>
      ) : null}

      {reviewedRefund ? (
        <div className={styles.review}>
          <dl>
            <div><dt>Product</dt><dd>{reviewedRefund.product_name}</dd></div>
            <div><dt>Size</dt><dd>FR {reviewedRefund.size_fr}</dd></div>
            <div><dt>Quantity</dt><dd>{reviewedRefund.requestedQuantity}</dd></div>
            <div><dt>Refund</dt><dd>{formatAmount(reviewedRefund.requestedAmount)}</dd></div>
            <div><dt>Maximum available</dt><dd>{formatAmount(reviewedRefund.refundable_amount)}</dd></div>
          </dl>

          <label className={styles.confirmation}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || status.type === "success"}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm this Sandbox refund of {formatAmount(reviewedRefund.requestedAmount)}.
          </label>

          <button
            className={styles.confirmButton}
            type="button"
            disabled={!confirmed || busy || status.type === "success"}
            onClick={confirmRefund}
          >
            {busy ? "REFUNDING…" : "CONFIRM REFUND"}
          </button>
        </div>
      ) : null}

      {status.message ? (
        <p className={status.type === "success" ? styles.success : styles.error} role="status">
          {status.message}
        </p>
      ) : null}
    </section>
  );
}
