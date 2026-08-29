import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Stripe from "stripe";
import {
  ADMIN_REFUND_STRIPE_MAX_NETWORK_RETRIES,
  ADMIN_REFUND_STRIPE_TIMEOUT_MS,
  createAdminRefundStripeClient,
  createAdminStripeRefund,
  traceAdminRefundStep,
} from "../app/services/admin-refund-stripe";
import {
  AdminRefundRequestTimeoutError,
  buildRefundRequestPayload,
  fetchAdminRefundRequest,
  validateRefundPreviewResponse,
} from "../app/admin/refund-request";

const OPERATION_ID = "33333333-3333-4333-8333-333333333333";

test("the admin Stripe client uses fetch with a 10 second timeout and no SDK retries", () => {
  const stripe = createAdminRefundStripeClient("sk_test_not_real");
  const httpClient = stripe.getApiField("httpClient");

  assert.equal(ADMIN_REFUND_STRIPE_TIMEOUT_MS, 10_000);
  assert.equal(ADMIN_REFUND_STRIPE_MAX_NETWORK_RETRIES, 0);
  assert.equal(stripe.getApiField("timeout"), 10_000);
  assert.equal(stripe.getApiField("maxNetworkRetries"), 0);
  assert.equal(httpClient.getClientName(), "fetch");
  assert.equal(httpClient.constructor.name, "FetchHttpClient");
});

test("a Stripe timeout remains controlled and is traced without sensitive details", async () => {
  const entries: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const logger = {
    log(_message: string, fields: Record<string, unknown>) {
      entries.push({ level: "log", fields });
    },
    error(_message: string, fields: Record<string, unknown>) {
      entries.push({ level: "error", fields });
    },
  };
  const timeout = new Stripe.errors.StripeConnectionError({ message: "connection timed out" });

  await assert.rejects(
    traceAdminRefundStep(
      "stripe.paymentIntents.retrieve",
      async () => {
        throw timeout;
      },
      logger,
    ),
    (error) => error === timeout,
  );

  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0]?.fields, {
    step: "stripe.paymentIntents.retrieve",
    state: "start",
    duration_ms: 0,
  });
  assert.equal(entries[1]?.level, "error");
  assert.equal(entries[1]?.fields.step, "stripe.paymentIntents.retrieve");
  assert.equal(entries[1]?.fields.state, "error");
  assert.equal(entries[1]?.fields.error_type, "StripeConnectionError");
  assert.equal(entries[1]?.fields.error_code, null);
  assert.equal(Object.hasOwn(entries[1]?.fields ?? {}, "message"), false);
});

test("D1 reservation cannot occur before successful Stripe order validation", () => {
  const route = readFileSync("app/api/admin/refunds/route.ts", "utf8");
  const validation = route.indexOf("await validateStripeOrder(stripe, contexts)");
  const reservation = route.indexOf("reserveRefundOperationLines(", validation);

  assert.notEqual(validation, -1);
  assert.notEqual(reservation, -1);
  assert.ok(validation < reservation);
});

test("the frontend accepts an exact multi-line preview in any line order", () => {
  const preview = {
    refund_operation_id: OPERATION_ID,
    order_id: "11111111-1111-4111-8111-111111111111",
    amount: 45_000,
    currency: "eur",
    lines: [
      { order_line_id: "22222222-2222-4222-8222-222222222222", catalog_id: "geometry",
        product_name: "Geometry", size_fr: 48, unit_amount: 25_000,
        requested_quantity: 1, amount: 25_000 },
      { order_line_id: "44444444-4444-4444-8444-444444444444", catalog_id: "carved-cross",
        product_name: "Karved Kross", size_fr: 48, unit_amount: 20_000,
        requested_quantity: 1, amount: 20_000 },
    ],
  };
  const selections = [
    { orderLineId: "44444444-4444-4444-8444-444444444444", catalogId: "carved-cross",
      productName: "Karved Kross", sizeFr: 48, unitAmount: 20_000, quantity: 1 },
    { orderLineId: "22222222-2222-4222-8222-222222222222", catalogId: "geometry",
      productName: "Geometry", sizeFr: 48, unitAmount: 25_000, quantity: 1 },
  ];
  assert.equal(validateRefundPreviewResponse({
    preview,
    orderId: preview.order_id,
    currency: "eur",
    selections,
  }), true);
});

test("the frontend rejects any preview line or total mismatch", () => {
  const selection = {
    orderLineId: "22222222-2222-4222-8222-222222222222",
    catalogId: "geometry", productName: "Geometry", sizeFr: 48,
    unitAmount: 25_000, quantity: 1,
  };
  const base = {
    refund_operation_id: OPERATION_ID,
    order_id: "11111111-1111-4111-8111-111111111111",
    amount: 25_000,
    currency: "eur",
    lines: [{ order_line_id: selection.orderLineId, catalog_id: selection.catalogId,
      product_name: selection.productName, size_fr: selection.sizeFr,
      unit_amount: selection.unitAmount, requested_quantity: 2, amount: 50_000 }],
  };
  assert.equal(validateRefundPreviewResponse({
    preview: base,
    orderId: base.order_id,
    currency: "eur",
    selections: [selection],
  }), false);
});

test("multiple selected lines still produce one global Stripe Refund request", async () => {
  const calls: Array<{ payload: unknown; options: unknown }> = [];
  const stripe = {
    refunds: {
      create: async (payload: unknown, options: unknown) => {
        calls.push({ payload, options });
        return { id: "re_multi", amount: 45_000 };
      },
    },
  } as unknown as Stripe;
  await createAdminStripeRefund(stripe, {
    paymentIntentId: "pi_multi",
    amount: 45_000,
    metadata: {
      schema_version: "3",
      order_id: "11111111-1111-4111-8111-111111111111",
      checkout_session_id: "cs_test_multi",
      refund_operation_id: OPERATION_ID,
    },
    idempotencyKey: `khaos-refund-v3:${OPERATION_ID}`,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    payload: {
      payment_intent: "pi_multi",
      amount: 45_000,
      metadata: {
        schema_version: "3",
        order_id: "11111111-1111-4111-8111-111111111111",
        checkout_session_id: "cs_test_multi",
        refund_operation_id: OPERATION_ID,
      },
    },
    options: { idempotencyKey: `khaos-refund-v3:${OPERATION_ID}` },
  });
});

test("the admin UI disables fully refunded lines and preserves the reviewed operation ID", () => {
  const source = readFileSync("app/admin/refund-form.tsx", "utf8");
  assert.match(source, /const unavailable = line\.refundable_quantity < 1/);
  assert.match(source, /disabled=\{busy \|\| unavailable\}/);
  assert.match(source, /operationId: reviewedRefund\.refund_operation_id/);
  assert.equal((source.match(/crypto\.randomUUID/g) ?? []).length, 0);
});

test("frontend timeout aborts once without an automatic retry", async () => {
  let calls = 0;
  const fetchImplementation = async (_input: string, init: RequestInit) => {
    calls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  };

  await assert.rejects(
    fetchAdminRefundRequest(
      "/api/admin/refunds",
      { method: "POST" },
      { timeoutMs: 5, fetchImplementation },
    ),
    (error) =>
      error instanceof AdminRefundRequestTimeoutError &&
      error.message === "Request timed out. Check the refund status before retrying.",
  );
  assert.equal(calls, 1);
});

test("manual retry preserves the immutable refund operation id and payload", async () => {
  const payload = buildRefundRequestPayload({
    lines: [{
      orderLineId: "22222222-2222-4222-8222-222222222222",
      quantity: 1,
    }],
    operationId: OPERATION_ID,
  });
  const bodies: string[] = [];
  const fetchImplementation = async (_input: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Response(JSON.stringify({ ok: true, refund_id: "re_test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await fetchAdminRefundRequest(
    "/api/admin/refunds",
    { method: "POST", body: JSON.stringify(payload) },
    { fetchImplementation },
  );
  await fetchAdminRefundRequest(
    "/api/admin/refunds",
    { method: "POST", body: JSON.stringify(payload) },
    { fetchImplementation },
  );

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[0] ?? "{}").refund_operation_id, OPERATION_ID);
});

test("normal frontend success remains unchanged", async () => {
  const response = await fetchAdminRefundRequest(
    "/api/admin/refunds",
    { method: "POST" },
    {
      fetchImplementation: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
