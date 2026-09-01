import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  getPennylaneErrorDetails,
  syncMultiLineRefundToPennylane,
} from "../app/services/pennylane";
import type { OrdersDatabase } from "../app/services/orders";
import type { RefundOperation, RefundShippingContext } from "../app/services/refunds";
import { processStructuredRefundEvent } from "../app/services/stripe-events";

const SHIPPING_LABEL = "Livraison sécurisée / Secure shipping";
const PRODUCT_LINE = {
  orderLineId: "order-line-geometry",
  invoiceLineId: "invoice-line-geometry",
  quantity: 1,
  unitAmount: 25_000,
};
const PRODUCT_SOURCE_LINE = {
  id: "invoice-line-geometry",
  label: "Geometry — FR58",
  unit: "piece",
  quantity: "1",
  currency_amount: "250.00",
  raw_currency_unit_price: "250.00",
  vat_rate: "exempt",
};
const SHIPPING_SOURCE_LINE = {
  id: "invoice-line-shipping",
  label: SHIPPING_LABEL,
  unit: "piece",
  quantity: "1",
  currency_amount: "10.00",
  raw_currency_unit_price: "10.00",
  vat_rate: "exempt",
};

const baseInput = {
  token: "sandbox-not-real",
  refundId: "re_shippingCreditNote",
  refundCreated: 1_788_000_000,
  paymentIntentId: "pi_shippingCreditNote",
  checkoutSessionId: "cs_test_shippingCreditNote",
  invoiceId: "invoice-shipping-credit-note",
  invoiceAmountTotal: 26_000,
  currency: "eur",
  customerEmail: "shipping-refund@example.test",
};

function invoice(amount = "260.00") {
  return {
    id: "invoice-shipping-credit-note",
    draft: false,
    status: "paid",
    external_reference: "stripe_checkout_cs_test_shippingCreditNote",
    currency: "EUR",
    currency_amount: amount,
    customer: { id: "customer-shipping-credit-note" },
    transaction_reference: {
      banking_provider: "stripe",
      provider_field_name: "payment_id",
      provider_field_value: "pi_shippingCreditNote",
    },
  };
}

function mocks({
  invoiceAmount = "260.00",
  sourceLines = [PRODUCT_SOURCE_LINE, SHIPPING_SOURCE_LINE],
}: {
  invoiceAmount?: string;
  sourceLines?: Array<Record<string, string>>;
} = {}) {
  let existing = false;
  let inspectCount = 0;
  let createCount = 0;
  let verifyLinesCount = 0;
  let capturedPayload: Record<string, unknown> | null = null;
  let verifiedLines: unknown[] = [];
  const dependencies = {
    inspectEnvironment: async (token: string) => {
      inspectCount += 1;
      return { token, isSandbox: true };
    },
    findInvoice: async () => ({ id: "invoice-shipping-credit-note" }),
    retrieveInvoice: async () => invoice(invoiceAmount),
    listInvoiceLines: async () => sourceLines,
    findCreditNote: async () => existing ? { id: "credit-note-shipping" } : undefined,
    createCreditNote: async (_token: string, payload: Record<string, unknown>) => {
      createCount += 1;
      existing = true;
      capturedPayload = payload;
      return { id: "credit-note-shipping" };
    },
    verifyAndLink: async () => undefined,
    verifyLines: async (...args: unknown[]) => {
      verifyLinesCount += 1;
      verifiedLines = args[2] as unknown[];
    },
    sendEmail: async () => ({ status: "sent" as const }),
  };
  return {
    dependencies,
    state: () => ({ inspectCount, createCount, verifyLinesCount, capturedPayload, verifiedLines }),
  };
}

function payloadLines(payload: Record<string, unknown> | null) {
  return (payload as { invoice_lines: Array<Record<string, unknown>> } | null)?.invoice_lines ?? [];
}

test("a product-only refund keeps the historical product-only credit note", async () => {
  const mock = mocks();
  await syncMultiLineRefundToPennylane({
    ...baseInput,
    lines: [PRODUCT_LINE],
    shippingRefundAmount: 0,
    shippingAmountPaid: 1_000,
    refundAmount: 25_000,
    dependencies: mock.dependencies,
  });
  assert.deepEqual(payloadLines(mock.state().capturedPayload), [{
    label: "Geometry — FR58",
    quantity: 1,
    unit: "piece",
    raw_currency_unit_price: "-250.00",
    vat_rate: "exempt",
  }]);
});

test("a product and shipping refund creates one distinct exempt shipping line", async () => {
  const mock = mocks();
  await syncMultiLineRefundToPennylane({
    ...baseInput,
    lines: [PRODUCT_LINE],
    shippingRefundAmount: 1_000,
    shippingAmountPaid: 1_000,
    refundAmount: 26_000,
    dependencies: mock.dependencies,
  });
  const payload = mock.state().capturedPayload as Record<string, unknown>;
  assert.equal(payload.special_mention, "TVA non applicable, art. 293 B du CGI");
  assert.deepEqual(payloadLines(payload), [
    { label: "Geometry — FR58", quantity: 1, unit: "piece",
      raw_currency_unit_price: "-250.00", vat_rate: "exempt" },
    { label: SHIPPING_LABEL, quantity: 1, unit: "piece",
      raw_currency_unit_price: "-10", vat_rate: "exempt" },
  ]);
});

test("a shipping-only refund creates one shipping line and no fake product line", async () => {
  const mock = mocks();
  await syncMultiLineRefundToPennylane({
    ...baseInput,
    lines: [],
    shippingRefundAmount: 1_000,
    shippingAmountPaid: 1_000,
    refundAmount: 1_000,
    dependencies: mock.dependencies,
  });
  assert.deepEqual(payloadLines(mock.state().capturedPayload), [{
    label: SHIPPING_LABEL,
    quantity: 1,
    unit: "piece",
    raw_currency_unit_price: "-10",
    vat_rate: "exempt",
  }]);
});

test("zero and historical NULL shipping create no shipping credit-note line", async () => {
  for (const shippingRefundAmount of [0, null] as const) {
    const mock = mocks();
    await syncMultiLineRefundToPennylane({
      ...baseInput,
      lines: [PRODUCT_LINE],
      shippingRefundAmount,
      shippingAmountPaid: shippingRefundAmount === null ? null : 1_000,
      refundAmount: 25_000,
      dependencies: mock.dependencies,
    });
    assert.equal(payloadLines(mock.state().capturedPayload).some(
      (line) => line.label === SHIPPING_LABEL,
    ), false);
  }
});

test("a refund total mismatch is rejected before any Pennylane request", async () => {
  const mock = mocks();
  await assert.rejects(
    syncMultiLineRefundToPennylane({
      ...baseInput,
      lines: [PRODUCT_LINE],
      shippingRefundAmount: 1_000,
      shippingAmountPaid: 1_000,
      refundAmount: 25_999,
      dependencies: mock.dependencies,
    }),
    (error) => getPennylaneErrorDetails(error).code ===
      "INVALID_PARTIAL_REFUND_AMOUNT_OR_CURRENCY",
  );
  assert.equal(mock.state().inspectCount, 0);
});

test("a shipping refund exceeding paid shipping is rejected before Pennylane", async () => {
  const mock = mocks();
  await assert.rejects(
    syncMultiLineRefundToPennylane({
      ...baseInput,
      lines: [],
      shippingRefundAmount: 1_001,
      shippingAmountPaid: 1_000,
      refundAmount: 1_001,
      dependencies: mock.dependencies,
    }),
    (error) => getPennylaneErrorDetails(error).code ===
      "INVALID_PARTIAL_REFUND_AMOUNT_OR_CURRENCY",
  );
  assert.equal(mock.state().inspectCount, 0);
});

test("a replay reuses the same credit note and verifies the shipping line", async () => {
  const mock = mocks();
  const synchronize = () => syncMultiLineRefundToPennylane({
    ...baseInput,
    lines: [PRODUCT_LINE],
    shippingRefundAmount: 1_000,
    shippingAmountPaid: 1_000,
    refundAmount: 26_000,
    dependencies: mock.dependencies,
  });
  assert.equal((await synchronize()).status, "created");
  assert.equal((await synchronize()).status, "already_exists");
  assert.equal(mock.state().createCount, 1);
  assert.equal(mock.state().verifyLinesCount, 2);
  assert.equal(mock.state().verifiedLines.length, 2);
  assert.equal(
    (mock.state().verifiedLines[1] as { sourceLine?: { label?: string } })?.sourceLine?.label,
    SHIPPING_LABEL,
  );
});

test("the structured refund flow forwards a shipping-only operation without product lines", async () => {
  const operation: RefundOperation = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    orderId: "11111111-1111-4111-8111-000000000001",
    amount: 1_000,
    currency: "eur",
    stripeIdempotencyKey: "khaos-refund-v3:shipping-only",
    stripeRefundId: null,
    status: "pending",
    failureCode: null,
    pennylaneCreditNoteId: null,
    creditNoteStatus: "pending",
    shippingRefundAmount: 1_000,
    lines: [],
    orderLineId: null,
    requestedQuantity: 0,
    refundedQuantityBefore: 0,
  };
  const context: RefundShippingContext = {
    orderId: operation.orderId,
    stripeCheckoutSessionId: "cs_test_shippingOnly",
    stripePaymentIntentId: "pi_shippingOnly",
    amountTotal: 26_000,
    currency: "eur",
    orderStatus: "paid",
    schemaVersion: 1,
    pennylaneInvoiceId: "invoice-shipping-only",
    customerEmail: "shipping-only@example.test",
    productsSubtotal: 25_000,
    shippingAmount: 1_000,
    shippingCountry: "FR",
    shippingZone: "FR",
    shippingRefundedAmount: null,
    reservedShippingRefundAmount: 1_000,
  };
  const refund = {
    id: "re_shippingOnly",
    object: "refund",
    amount: 1_000,
    currency: "eur",
    payment_intent: "pi_shippingOnly",
    metadata: {
      schema_version: "3",
      refund_operation_id: operation.id,
      checkout_session_id: context.stripeCheckoutSessionId,
      order_id: operation.orderId,
    },
    status: "succeeded",
  } as unknown as Stripe.Refund;
  let synchronized: Record<string, unknown> | null = null;
  const result = await processStructuredRefundEvent({
    stripe: {} as Stripe,
    eventRefund: refund,
    eventCreated: 1_788_000_000,
    eventType: "refund.created",
    stripeSecretKey: "sk_test_not_real",
    pennylaneToken: "sandbox-not-real",
    db: {} as OrdersDatabase,
    dependencies: {
      retrieveRefund: async () => refund,
      findOperation: async () => operation,
      getContexts: async () => [],
      getShippingContext: async () => context,
      attachRefund: async () => undefined,
      verifyWithStripe: async () => undefined,
      finalizeOperation: async () => undefined,
      syncPennylane: async (input) => {
        synchronized = input as unknown as Record<string, unknown>;
        return { status: "created" as const, invoiceId: context.pennylaneInvoiceId,
          creditNoteId: "credit-note-shipping-only", amount: 1_000, currency: "eur",
          email: { status: "sent" as const } };
      },
      recordCreditNote: async () => undefined,
    },
  });
  assert.equal(result.status, "created");
  assert.deepEqual((synchronized as Record<string, unknown> | null)?.lines, []);
  assert.equal((synchronized as Record<string, unknown> | null)?.shippingRefundAmount, 1_000);
  assert.equal((synchronized as Record<string, unknown> | null)?.shippingAmountPaid, 1_000);
});
