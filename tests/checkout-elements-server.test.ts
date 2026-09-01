import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type Stripe from "stripe";
import { handleCheckoutShippingUpdate, handleCreateCheckoutSession } from "../app/services/checkout-elements-http";
import {
  CHECKOUT_ELEMENTS_FLOW,
  type CheckoutSessionUpdateParams,
  type CreateCheckoutSessionPort,
  type UpdateCheckoutSessionPort,
} from "../app/services/stripe-checkout-elements";

const CREATE_URL = "https://example.test/api/create-checkout-session";
const UPDATE_URL = "https://example.test/api/checkout/update-shipping";
const SESSION_ID = "cs_test_khaosElements";
const CLIENT_SECRET = `${SESSION_ID}_secret_not_real`;

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createDependencies(captured: Stripe.Checkout.SessionCreateParams[]) {
  const stripe: CreateCheckoutSessionPort = {
    create: async (params) => {
      captured.push(params);
      const amountSubtotal = (params.line_items ?? []).reduce((sum, line) => {
        return sum + (line.price_data?.unit_amount ?? 0) * (line.quantity ?? 0);
      }, 0);
      return {
        id: SESSION_ID,
        object: "checkout.session",
        client_secret: CLIENT_SECRET,
        livemode: false,
        ui_mode: "elements",
        mode: "payment",
        status: "open",
        payment_status: "unpaid",
        currency: "eur",
        amount_subtotal: amountSubtotal,
      } as unknown as Stripe.Checkout.Session;
    },
  };

  return {
    env: {
      STRIPE_SECRET_KEY: "sk_test_not_real",
      STRIPE_PUBLISHABLE_KEY: "pk_test_not_real",
      SITE_URL: "https://khaostheoryparis.com",
    },
    stripe,
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
  };
}

test("Checkout Elements creation uses only the server catalog and the typed server-only shipping contract", async () => {
  const captured: Stripe.Checkout.SessionCreateParams[] = [];
  const response = await handleCreateCheckoutSession(
    jsonRequest(CREATE_URL, { items: [{ productId: "geometry", size: 48, quantity: 1 }], locale: "fr" }),
    createDependencies(captured),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    checkoutSessionId: SESSION_ID,
    clientSecret: CLIENT_SECRET,
    publishableKey: "pk_test_not_real",
  });
  assert.equal(captured.length, 1);
  const params = captured[0];
  assert.equal(params.ui_mode, "elements");
  assert.equal(params.mode, "payment");
  assert.deepEqual(params.permissions, { update_shipping_details: "server_only" });
  assert.deepEqual(params.shipping_address_collection, { allowed_countries: ["FR"] });
  assert.equal(params.return_url, "https://khaostheoryparis.com/fr/success?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(params.success_url, undefined);
  assert.equal(params.cancel_url, undefined);
  assert.equal(params.shipping_options, undefined);
  assert.equal(params.line_items?.[0]?.price_data?.unit_amount, 25_000);
  assert.equal(params.line_items?.[0]?.quantity, 1);
  assert.equal(params.metadata?.checkout_flow, CHECKOUT_ELEMENTS_FLOW);
});

test("Checkout Elements creation preserves the validated English locale", async () => {
  const captured: Stripe.Checkout.SessionCreateParams[] = [];
  const response = await handleCreateCheckoutSession(
    jsonRequest(CREATE_URL, {
      items: [{ productId: "geometry", size: 48, quantity: 1 }],
      locale: "en",
    }),
    createDependencies(captured),
  );

  assert.equal(response.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.locale, "en");
  assert.equal(
    captured[0]?.return_url,
    "https://khaostheoryparis.com/en/success?session_id={CHECKOUT_SESSION_ID}",
  );
});

test("Checkout Elements creation fails explicitly without the publishable test key", async () => {
  const captured: Stripe.Checkout.SessionCreateParams[] = [];
  const dependencies = createDependencies(captured);
  const response = await handleCreateCheckoutSession(
    jsonRequest(CREATE_URL, {
      items: [{ productId: "geometry", size: 48, quantity: 1 }],
      locale: "fr",
    }),
    {
      ...dependencies,
      env: {
        STRIPE_SECRET_KEY: dependencies.env.STRIPE_SECRET_KEY,
        SITE_URL: dependencies.env.SITE_URL,
      },
    },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Stripe runtime variables are not configured.",
  });
  assert.equal(captured.length, 0);
});

test("the create endpoint rejects all client financial and redirect fields before Stripe", async () => {
  for (const extra of [
    { price: 1 },
    { subtotal: 1 },
    { productsSubtotal: 1 },
    { shippingAmount: 0 },
    { total: 1 },
    { success_url: "https://evil.example" },
    { cancel_url: "https://evil.example" },
    { return_url: "https://evil.example" },
    { origin: "https://evil.example" },
  ]) {
    const captured: Stripe.Checkout.SessionCreateParams[] = [];
    const response = await handleCreateCheckoutSession(
      jsonRequest(CREATE_URL, {
        items: [{ productId: "geometry", size: 48, quantity: 1 }],
        locale: "fr",
        ...extra,
      }),
      createDependencies(captured),
    );
    assert.equal(response.status, 400);
    assert.equal(captured.length, 0);
  }

  const captured: Stripe.Checkout.SessionCreateParams[] = [];
  const itemWithPrice = await handleCreateCheckoutSession(
    jsonRequest(CREATE_URL, {
      items: [{ productId: "geometry", size: 48, quantity: 1, price: 1 }],
      locale: "fr",
    }),
    createDependencies(captured),
  );
  assert.equal(itemWithPrice.status, 400);
  assert.equal(captured.length, 0);
});

test("strict create body validation preserves absent-locale French compatibility and rejects malformed bodies", async () => {
  const captured: Stripe.Checkout.SessionCreateParams[] = [];
  const historical = await handleCreateCheckoutSession(
    jsonRequest(CREATE_URL, { items: [{ productId: "geometry", size: 48, quantity: 1 }] }),
    createDependencies(captured),
  );
  assert.equal(historical.status, 200);
  assert.equal(captured[0]?.locale, "fr");

  for (const body of [null, [], "value", 1, { items: [] }, { items: [{ productId: "geometry", size: "48", quantity: 1 }] }]) {
    const attempts: Stripe.Checkout.SessionCreateParams[] = [];
    const response = await handleCreateCheckoutSession(jsonRequest(CREATE_URL, body), createDependencies(attempts));
    assert.equal(response.status, 400);
    assert.equal(attempts.length, 0);
  }
});

test("the server catalog rejects unknown products and invalid quantities before Stripe", async () => {
  for (const item of [
    { productId: "unknown-product", size: 48, quantity: 1 },
    { productId: "geometry", size: 48, quantity: 0 },
    { productId: "geometry", size: 48, quantity: 1.5 },
    { productId: "geometry", size: 48, quantity: 6 },
  ]) {
    const captured: Stripe.Checkout.SessionCreateParams[] = [];
    const response = await handleCreateCheckoutSession(
      jsonRequest(CREATE_URL, { items: [item], locale: "fr" }),
      createDependencies(captured),
    );
    assert.equal(response.status, 400);
    assert.equal(captured.length, 0);
  }
});

function lineItem(productId = "geometry", amount = 25_000, quantity = 1, size = 48): Stripe.LineItem {
  return {
    id: `li_${productId}`,
    object: "item",
    adjustable_quantity: null,
    amount_discount: 0,
    amount_subtotal: amount * quantity,
    amount_tax: 0,
    amount_total: amount * quantity,
    currency: "eur",
    description: productId,
    metadata: {
      catalog_id: productId,
      order_line_id: `order_line_${productId}`,
      size_fr: String(size),
      pennylane_vat_rate: "exempt",
      schema_version: "1",
    },
    price: { currency: "eur", unit_amount: amount } as Stripe.Price,
    quantity,
  };
}

function openSession(productsSubtotal = 25_000, overrides: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return {
    id: SESSION_ID,
    object: "checkout.session",
    client_secret: CLIENT_SECRET,
    livemode: false,
    ui_mode: "elements",
    mode: "payment",
    status: "open",
    payment_status: "unpaid",
    currency: "eur",
    amount_subtotal: productsSubtotal,
    amount_total: productsSubtotal,
    permissions: { update_shipping_details: "server_only" },
    shipping_address_collection: { allowed_countries: ["FR"] },
    metadata: {
      schema_version: "1",
      checkout_flow: CHECKOUT_ELEMENTS_FLOW,
      checkout_locale: "fr",
    },
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function updatedSession(
  base: Stripe.Checkout.Session,
  params: CheckoutSessionUpdateParams,
): Stripe.Checkout.Session {
  const shippingOptions = Array.isArray(params.shipping_options) ? params.shipping_options : [];
  const shippingAmount = shippingOptions[0]?.shipping_rate_data?.fixed_amount?.amount ?? -1;
  const details = params.collected_information?.shipping_details;
  return {
    ...base,
    amount_total: (base.amount_subtotal ?? 0) + shippingAmount,
    collected_information: { shipping_details: details },
    shipping_cost: {
      amount_subtotal: shippingAmount,
      amount_tax: 0,
      amount_total: shippingAmount,
      shipping_rate: "shr_test_not_real",
      taxes: [],
    },
    total_details: { amount_discount: 0, amount_shipping: shippingAmount, amount_tax: 0 },
  } as unknown as Stripe.Checkout.Session;
}

function updateDependencies({
  session = openSession(),
  lineItems = [lineItem()],
}: {
  session?: Stripe.Checkout.Session;
  lineItems?: Stripe.LineItem[];
} = {}) {
  const updates: CheckoutSessionUpdateParams[] = [];
  const stripe: UpdateCheckoutSessionPort = {
    retrieve: async () => session,
    listLineItems: async () => ({ object: "list", data: lineItems, has_more: false, url: "/v1/checkout/sessions/line_items" }),
    update: async (_id, params) => {
      updates.push(params);
      return updatedSession(session, params);
    },
  };
  return { secretKey: "sk_test_not_real", stripe, updates };
}

function shippingBody(postalCode = "75001", city = "Paris") {
  return {
    checkoutSessionId: SESSION_ID,
    clientSecret: CLIENT_SECRET,
    shippingDetails: {
      name: "Test Customer",
      address: { country: "FR", postal_code: postalCode, city, line1: "1 rue de Test" },
    },
  };
}

test("server update validates Paris and adds the exact authoritative 10 euro shipping amount", async () => {
  const dependencies = updateDependencies();
  const response = await handleCheckoutShippingUpdate(jsonRequest(UPDATE_URL, shippingBody()), dependencies);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    updated: true,
    shippingAmount: 1_000,
    amountTotal: 26_000,
    currency: "eur",
  });
  assert.equal(dependencies.updates.length, 1);
  const options = dependencies.updates[0]?.shipping_options;
  assert.equal(Array.isArray(options) ? options[0]?.shipping_rate_data?.fixed_amount?.amount : undefined, 1_000);
  assert.equal(dependencies.updates[0]?.collected_information?.shipping_details?.address.country, "FR");
});

test("server update grants free shipping only from a server-catalog subtotal of 400 euros", async () => {
  const session = openSession(40_000);
  const dependencies = updateDependencies({ session, lineItems: [lineItem("carved-cross", 20_000, 2)] });
  const response = await handleCheckoutShippingUpdate(jsonRequest(UPDATE_URL, shippingBody()), dependencies);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    updated: true,
    shippingAmount: 0,
    amountTotal: 40_000,
    currency: "eur",
  });
  const options = dependencies.updates[0]?.shipping_options;
  assert.equal(Array.isArray(options) ? options[0]?.shipping_rate_data?.fixed_amount?.amount : undefined, 0);
});

test("server update keeps shipping free above 400 euros from catalog line items", async () => {
  const session = openSession(45_000);
  const dependencies = updateDependencies({
    session,
    lineItems: [lineItem("geometry", 25_000), lineItem("carved-cross", 20_000)],
  });
  const response = await handleCheckoutShippingUpdate(
    jsonRequest(UPDATE_URL, shippingBody()),
    dependencies,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    updated: true,
    shippingAmount: 0,
    amountTotal: 45_000,
    currency: "eur",
  });
});

test("server update rejects Stripe line items that do not match the server catalog", async () => {
  for (const lineItems of [
    [lineItem("geometry", 1)],
    [lineItem("unknown-product", 25_000)],
    [lineItem("geometry", 25_000, 6)],
  ]) {
    const dependencies = updateDependencies({ lineItems });
    const response = await handleCheckoutShippingUpdate(
      jsonRequest(UPDATE_URL, shippingBody()),
      dependencies,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { updated: false });
    assert.equal(dependencies.updates.length, 0);
  }
});

test("Corsica is accepted while DOM, COM/TOM, Monaco and incompatible cities are rejected before Stripe update", async () => {
  const corsica = updateDependencies();
  const corsicaResponse = await handleCheckoutShippingUpdate(
    jsonRequest(UPDATE_URL, shippingBody("20000", "Ajaccio")),
    corsica,
  );
  assert.equal(corsicaResponse.status, 200);
  assert.equal(corsica.updates.length, 1);

  for (const [postalCode, city] of [
    ["97100", "Basse-Terre"],
    ["98714", "Papeete"],
    ["98000", "Monaco"],
    ["75001", "Lyon"],
  ] as const) {
    const dependencies = updateDependencies();
    const response = await handleCheckoutShippingUpdate(
      jsonRequest(UPDATE_URL, shippingBody(postalCode, city)),
      dependencies,
    );
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { updated: false });
    assert.equal(dependencies.updates.length, 0);
  }
});

test("unknown, unowned and non-Khaos sessions cannot be updated", async () => {
  const unavailable = updateDependencies();
  unavailable.stripe.retrieve = async () => { throw new Error("not found"); };
  const unknown = await handleCheckoutShippingUpdate(jsonRequest(UPDATE_URL, shippingBody()), unavailable);
  assert.equal(unknown.status, 400);
  assert.equal(unavailable.updates.length, 0);

  for (const override of [
    { client_secret: `${SESSION_ID}_secret_different` },
    { livemode: true },
    { ui_mode: "hosted_page" },
    { mode: "setup" },
    { status: "complete" },
    { payment_status: "paid" },
    { permissions: { update_shipping_details: "client_only" } },
    { shipping_address_collection: { allowed_countries: ["FR", "DE"] } },
    { metadata: { schema_version: "1", checkout_flow: "another_flow", checkout_locale: "fr" } },
  ]) {
    const dependencies = updateDependencies({ session: openSession(25_000, override) });
    const response = await handleCheckoutShippingUpdate(jsonRequest(UPDATE_URL, shippingBody()), dependencies);
    assert.equal(response.status, 400);
    assert.equal(dependencies.updates.length, 0);
  }
});

test("server update rejects client financial fields and never accepts an address as financial authority", async () => {
  for (const extra of [
    { price: 1 },
    { subtotal: 1 },
    { productsSubtotal: 1 },
    { shippingAmount: 0 },
    { total: 1 },
    { shippingZone: "WORLD" },
  ]) {
    const dependencies = updateDependencies();
    const response = await handleCheckoutShippingUpdate(
      jsonRequest(UPDATE_URL, { ...shippingBody(), ...extra }),
      dependencies,
    );
    assert.equal(response.status, 400);
    assert.equal(dependencies.updates.length, 0);
  }
});

test("server-side Checkout Elements code contains no personal-data logging", () => {
  const sources = [
    "app/api/create-checkout-session/route.ts",
    "app/api/checkout/update-shipping/route.ts",
    "app/services/checkout-elements-http.ts",
    "app/services/stripe-checkout-elements.ts",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(sources, /console\.(?:log|info|warn|error|debug)/);
  assert.doesNotMatch(sources, /STRIPE_WEBHOOK_SECRET|PENNYLANE_API_TOKEN|CLOUDFLARE_ACCESS_AUD/);
});
