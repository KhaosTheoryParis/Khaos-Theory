import assert from "node:assert/strict";
import test from "node:test";
import { syncMultiLineRefundToPennylane } from "../app/services/pennylane";

const baseInput = {
  token: "sandbox-not-real",
  refundId: "re_multiLineRefund",
  refundCreated: 1_788_000_000,
  paymentIntentId: "pi_multiLineRefund",
  checkoutSessionId: "cs_test_multiLineRefund",
  invoiceId: "invoice-multi-line",
  invoiceAmountTotal: 45_000,
  currency: "eur",
  customerEmail: "customer@example.test",
};

function originalInvoice() {
  return {
    id: "invoice-multi-line",
    draft: false,
    status: "paid",
    external_reference: "stripe_checkout_cs_test_multiLineRefund",
    currency: "EUR",
    currency_amount: "450.00",
    customer: { id: "customer-multi-line" },
    transaction_reference: {
      banking_provider: "stripe",
      provider_field_name: "payment_id",
      provider_field_value: "pi_multiLineRefund",
    },
  };
}

function sourceLines() {
  return [
    { id: "invoice-line-carved", label: "Karved Kross — FR48", unit: "piece",
      quantity: "1", currency_amount: "200.00", raw_currency_unit_price: "200.00",
      vat_rate: "exempt" },
    { id: "invoice-line-geometry", label: "Geometry — FR48", unit: "piece",
      quantity: "1", currency_amount: "250.00", raw_currency_unit_price: "250.00",
      vat_rate: "exempt" },
  ];
}

test("multi-line Pennylane sync creates one finalized two-line credit note", async () => {
  let capturedPayload: Record<string, unknown> | null = null;
  let createCount = 0;
  let emailCount = 0;
  const result = await syncMultiLineRefundToPennylane({
    ...baseInput,
    refundAmount: 45_000,
    lines: [
      { orderLineId: "order-line-carved", invoiceLineId: "invoice-line-carved",
        quantity: 1, unitAmount: 20_000 },
      { orderLineId: "order-line-geometry", invoiceLineId: "invoice-line-geometry",
        quantity: 1, unitAmount: 25_000 },
    ],
    dependencies: {
      inspectEnvironment: async (token) => ({ token, isSandbox: true }),
      findInvoice: async () => ({ id: "invoice-multi-line" }),
      retrieveInvoice: async () => originalInvoice(),
      listInvoiceLines: async () => sourceLines(),
      findCreditNote: async () => undefined,
      createCreditNote: async (_token, payload) => {
        createCount += 1;
        capturedPayload = payload;
        return { id: "credit-note-multi-line" };
      },
      verifyAndLink: async () => undefined,
      verifyLines: async () => undefined,
      sendEmail: async () => { emailCount += 1; return { status: "sent" as const }; },
    },
  });

  assert.equal(result.status, "created");
  assert.equal(createCount, 1);
  assert.equal(emailCount, 1);
  assert.deepEqual(capturedPayload, {
    customer_id: "customer-multi-line",
    date: "2026-08-29",
    deadline: "2026-08-29",
    currency: "EUR",
    draft: false,
    special_mention: "TVA non applicable, art. 293 B du CGI",
    external_reference: "stripe_refund_re_multiLineRefund",
    invoice_lines: [
      { label: "Karved Kross — FR48", quantity: 1, unit: "piece",
        raw_currency_unit_price: "-200.00", vat_rate: "exempt" },
      { label: "Geometry — FR48", quantity: 1, unit: "piece",
        raw_currency_unit_price: "-250.00", vat_rate: "exempt" },
    ],
  });
});

test("multi-line Pennylane sync supports quantities greater than one", async () => {
  let capturedPayload: Record<string, unknown> | null = null;
  const result = await syncMultiLineRefundToPennylane({
    ...baseInput,
    invoiceAmountTotal: 85_000,
    refundAmount: 65_000,
    lines: [
      { orderLineId: "order-line-carved", invoiceLineId: "invoice-line-carved",
        quantity: 2, unitAmount: 20_000 },
      { orderLineId: "order-line-geometry", invoiceLineId: "invoice-line-geometry",
        quantity: 1, unitAmount: 25_000 },
    ],
    dependencies: {
      inspectEnvironment: async (token) => ({ token, isSandbox: true }),
      findInvoice: async () => ({ id: "invoice-multi-line" }),
      retrieveInvoice: async () => ({ ...originalInvoice(), currency_amount: "850.00" }),
      listInvoiceLines: async () => [
        { ...sourceLines()[0], quantity: "3", currency_amount: "600.00" },
        sourceLines()[1],
      ],
      findCreditNote: async () => undefined,
      createCreditNote: async (_token, payload) => {
        capturedPayload = payload;
        return { id: "credit-note-multi-quantity" };
      },
      verifyAndLink: async () => undefined,
      verifyLines: async () => undefined,
      sendEmail: async () => ({ status: "sent" as const }),
    },
  });
  assert.equal(result.amount, 65_000);
  assert.deepEqual((capturedPayload as { invoice_lines: unknown[] } | null)?.invoice_lines, [
    { label: "Karved Kross — FR48", quantity: 2, unit: "piece",
      raw_currency_unit_price: "-200.00", vat_rate: "exempt" },
    { label: "Geometry — FR48", quantity: 1, unit: "piece",
      raw_currency_unit_price: "-250.00", vat_rate: "exempt" },
  ]);
});

test("an existing multi-line credit note is reused without creation or email", async () => {
  let createCount = 0;
  let emailCount = 0;
  const result = await syncMultiLineRefundToPennylane({
    ...baseInput,
    refundAmount: 45_000,
    lines: [
      { orderLineId: "order-line-carved", invoiceLineId: "invoice-line-carved",
        quantity: 1, unitAmount: 20_000 },
      { orderLineId: "order-line-geometry", invoiceLineId: "invoice-line-geometry",
        quantity: 1, unitAmount: 25_000 },
    ],
    dependencies: {
      inspectEnvironment: async (token) => ({ token, isSandbox: true }),
      findInvoice: async () => ({ id: "invoice-multi-line" }),
      retrieveInvoice: async () => originalInvoice(),
      listInvoiceLines: async () => sourceLines(),
      findCreditNote: async () => ({ id: "credit-note-existing" }),
      createCreditNote: async () => { createCount += 1; return { id: "unexpected" }; },
      verifyAndLink: async () => undefined,
      verifyLines: async () => undefined,
      sendEmail: async () => { emailCount += 1; return { status: "sent" as const }; },
    },
  });
  assert.equal(result.status, "already_exists");
  assert.equal(createCount, 0);
  assert.equal(emailCount, 0);
  assert.equal(result.email.status, "skipped_existing_invoice");
});
