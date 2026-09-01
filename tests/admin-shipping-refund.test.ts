import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAdminRefundRequest } from "../app/services/admin-refund-command";
import {
  AdminRefundShippingError,
  adminRefundShippingSummary,
  resolveAdminShippingRefundAmount,
} from "../app/services/admin-refund-shipping";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const LINE_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";

test("historical and free shipping do not expose a refundable component", () => {
  assert.equal(adminRefundShippingSummary({
    shippingAmount: null, shippingRefundedAmount: null, reservedShippingRefundAmount: null,
  }), null);
  assert.equal(adminRefundShippingSummary({
    shippingAmount: 0, shippingRefundedAmount: 0, reservedShippingRefundAmount: 0,
  }), null);
});

test("paid shipping is summarized separately with refunds and reservations", () => {
  assert.deepEqual(adminRefundShippingSummary({
    shippingAmount: 1_000, shippingRefundedAmount: 200, reservedShippingRefundAmount: 300,
  }), {
    label: "Livraison sécurisée / Secure shipping",
    amount: 1_000,
    refundedAmount: 200,
    reservedAmount: 300,
    refundableAmount: 500,
  });
});

test("the server resolves an explicit shipping intent to the entire remaining amount", () => {
  const state = {
    shippingAmount: 1_000, shippingRefundedAmount: 200, reservedShippingRefundAmount: 300,
  };
  assert.equal(resolveAdminShippingRefundAmount(state, false), 0);
  assert.equal(resolveAdminShippingRefundAmount(state, true), 500);
});

test("fully refunded or fully reserved shipping cannot be refunded twice", () => {
  for (const state of [
    { shippingAmount: 1_000, shippingRefundedAmount: 1_000, reservedShippingRefundAmount: 0 },
    { shippingAmount: 1_000, shippingRefundedAmount: 0, reservedShippingRefundAmount: 1_000 },
  ]) {
    assert.throws(
      () => resolveAdminShippingRefundAmount(state, true),
      (error) => error instanceof AdminRefundShippingError &&
        error.code === "SHIPPING_REFUND_AMOUNT_UNAVAILABLE",
    );
  }
});

test("invalid shipping counters are rejected", () => {
  assert.throws(() => adminRefundShippingSummary({
    shippingAmount: 1_000, shippingRefundedAmount: 800, reservedShippingRefundAmount: 300,
  }), /INVALID_SHIPPING_REFUND_STATE/);
});

test("admin requests support product-only, combined and shipping-only intents", () => {
  const product = { order_line_id: LINE_ID, quantity: 1 };
  assert.deepEqual(parseAdminRefundRequest({
    action: "preview", order_id: ORDER_ID, lines: [product], refundShipping: false,
  }), { action: "preview", orderId: ORDER_ID,
    lines: [{ orderLineId: LINE_ID, requestedQuantity: 1 }], refundShipping: false });
  const combined = parseAdminRefundRequest({
    action: "preview", order_id: ORDER_ID, lines: [product], refundShipping: true,
  });
  assert.equal(combined?.action === "preview" && combined.refundShipping, true);
  assert.deepEqual(parseAdminRefundRequest({
    action: "preview", order_id: ORDER_ID, lines: [], refundShipping: true,
  }), { action: "preview", orderId: ORDER_ID, lines: [], refundShipping: true });
});

test("all products can be selected without implicitly selecting shipping", () => {
  const parsed = parseAdminRefundRequest({
    action: "refund", order_id: ORDER_ID,
    lines: [{ order_line_id: LINE_ID, quantity: 5 }], refundShipping: false,
    refund_operation_id: OPERATION_ID,
  });
  assert.equal(parsed?.action, "refund");
  if (parsed?.action === "refund") assert.equal(parsed.refundShipping, false);
});

test("the historical product-only Admin contract remains compatible", () => {
  const product = { order_line_id: LINE_ID, quantity: 1 };
  assert.deepEqual(parseAdminRefundRequest({ action: "preview", lines: [product] }), {
    action: "preview",
    orderId: null,
    lines: [{ orderLineId: LINE_ID, requestedQuantity: 1 }],
    refundShipping: false,
  });
  assert.deepEqual(parseAdminRefundRequest({
    action: "refund",
    lines: [product],
    refund_operation_id: OPERATION_ID,
  }), {
    action: "refund",
    orderId: null,
    lines: [{ orderLineId: LINE_ID, requestedQuantity: 1 }],
    refundShipping: false,
    operationId: OPERATION_ID,
  });
});

test("an empty request without shipping is refused", () => {
  assert.equal(parseAdminRefundRequest({
    action: "preview", order_id: ORDER_ID, lines: [], refundShipping: false,
  }), null);
});

test("client shipping amount forgery is rejected by the strict server contract", () => {
  for (const field of ["shippingAmount", "shipping_amount"]) {
    assert.equal(parseAdminRefundRequest({
      action: "preview", order_id: ORDER_ID, lines: [], refundShipping: true, [field]: 1,
    }), null);
  }
});

test("unexpected bodies, quantities and shipping values are rejected", () => {
  for (const body of [null, [], "refund", 1]) {
    assert.equal(parseAdminRefundRequest(body), null);
  }
  for (const quantity of [-1, 1.5, Number.NaN]) {
    assert.equal(parseAdminRefundRequest({
      action: "preview",
      order_id: ORDER_ID,
      lines: [{ order_line_id: LINE_ID, quantity }],
      refundShipping: false,
    }), null);
  }
  for (const forgedAmount of [-1, 1.5, Number.NaN]) {
    assert.equal(parseAdminRefundRequest({
      action: "preview",
      order_id: ORDER_ID,
      lines: [],
      refundShipping: true,
      shippingAmount: forgedAmount,
    }), null);
  }
  assert.equal(parseAdminRefundRequest({
    action: "preview", order_id: ORDER_ID, lines: [], refundShipping: 1,
  }), null);
  assert.equal(parseAdminRefundRequest({
    action: "preview", order_id: ORDER_ID, lines: [{ order_line_id: LINE_ID, quantity: 1 }],
  }), null);
});

test("the Admin route preserves Access, origin and Sandbox guards before refund work", () => {
  const source = readFileSync("app/api/admin/refunds/route.ts", "utf8");
  const access = source.indexOf("await verifyCloudflareAccess(request.headers)");
  const sandbox = source.indexOf('env.STRIPE_SECRET_KEY?.startsWith("sk_test_")');
  const origin = source.indexOf("hasTrustedAdminOrigin(request, env.STRIPE_SECRET_KEY)");
  const parseBody = source.indexOf("body = await request.json()");
  const shippingAmount = source.indexOf("const shippingRefundAmount");
  const reservation = source.indexOf('traceAdminRefundStep("d1.reserveRefundOperation"');
  const stripeCreation = source.indexOf("await createAdminStripeRefund(stripe", reservation);

  assert.ok(access >= 0 && sandbox > access && origin > sandbox && parseBody > origin);
  assert.ok(shippingAmount > parseBody && reservation > shippingAmount);
  assert.ok(stripeCreation > reservation);
});

test("refund analytics remain product-line based and do not count shipping as product quantity", () => {
  const source = readFileSync("app/services/admin-refund-analytics.ts", "utf8");
  assert.match(source, /refund_operation_lines rol/);
  assert.doesNotMatch(source, /shipping_refund_amount/);
});
