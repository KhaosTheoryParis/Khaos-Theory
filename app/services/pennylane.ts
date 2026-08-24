import Stripe from "stripe";

const PENNYLANE_API_BASE_URL = "https://app.pennylane.com/api/external/v2";
const STRIPE_INVOICE_REFERENCE_PREFIX = "stripe_checkout_";
const STRIPE_REFUND_REFERENCE_PREFIX = "stripe_refund_";
const STRIPE_CUSTOMER_REFERENCE_PREFIX = "stripe_email_";
const PENNYLANE_EXEMPT_VAT_RATE = "exempt";
const VAT_EXEMPTION_MENTION = "TVA non applicable, art. 293 B du CGI";

type PennylaneOperation =
  | "verify_sandbox"
  | "find_invoice"
  | "find_customer"
  | "create_customer"
  | "create_invoice"
  | "create_credit_note"
  | "find_credit_note"
  | "link_credit_note"
  | "list_invoice_lines"
  | "mark_as_paid"
  | "retrieve_invoice"
  | "send_by_email"
  | "send_credit_note_by_email"
  | "verify_credit_note"
  | "verify_invoice";

type PennylaneList<T> = {
  items?: T[];
  next_cursor?: string | null;
};

type PennylaneCustomer = {
  id?: number | string;
};

type PennylaneInvoice = {
  id?: number | string;
  currency?: string | null;
  currency_amount?: string | null;
  paid?: boolean;
  remaining_amount_with_tax?: string | null;
  draft?: boolean;
  external_reference?: string;
  status?: string;
  customer?: { id?: number | string } | null;
  credited_invoice?: { id?: number | string } | null;
  transaction_reference?: {
    banking_provider?: string;
    provider_field_name?: string;
    provider_field_value?: string;
  } | null;
};

type PennylaneProfile = {
  company?: {
    reg_no?: string | null;
  };
};

type PennylaneInvoiceLine = {
  label: string;
  quantity: number;
  unit: "piece";
  raw_currency_unit_price: string;
  vat_rate: string;
};

type StripeOrderLineMapping = {
  catalogId: string;
  orderLineId: string;
  sizeFr: string;
  stripeLineItemId: string;
  quantity: number;
  unitAmount: number;
  amountTotal: number;
};

export type PennylaneOrderLineMapping = StripeOrderLineMapping & {
  pennylaneInvoiceLineId: string;
};

type PreparedInvoiceLines = {
  invoiceLines: PennylaneInvoiceLine[];
  orderLineMappings: StripeOrderLineMapping[];
};

type PennylaneStoredInvoiceLine = {
  id?: number | string;
  label?: string;
  unit?: string | null;
  quantity?: string;
  currency_amount?: string;
  description?: string | null;
  vat_rate?: string;
  raw_currency_unit_price?: string;
};

type PennylaneCreditNoteResult = {
  status: "created" | "already_exists";
  invoiceId: number | string;
  creditNoteId: number | string;
  paymentIntentId: string;
  amount: number;
  currency: string;
  customerEmail: string | null;
  email: PennylaneEmailResult;
};

export type PennylanePartialCreditNoteResult = {
  status: "created" | "already_exists";
  invoiceId: number | string;
  creditNoteId: number | string;
  amount: number;
  currency: string;
};

type PennylaneMarkAsPaidResult =
  | { status: "marked_paid"; remainingAmountWithTax?: string | null }
  | { status: "already_paid"; remainingAmountWithTax?: string | null }
  | { status: "skipped_non_sandbox" }
  | { status: "error"; error: PennylaneErrorDetails };

type PennylaneEmailResult =
  | { status: "sent" }
  | { status: "skipped_existing_invoice" }
  | { status: "skipped_non_sandbox" }
  | { status: "skipped_mark_as_paid_incomplete" }
  | { status: "error"; error: PennylaneErrorDetails };

type PennylaneSyncResult =
  | {
      status: "created";
      invoiceId: number | string;
      customerEmail: string;
      amount: number;
      currency: string;
      paymentIntentId: string;
      markAsPaid: PennylaneMarkAsPaidResult;
      email: PennylaneEmailResult;
      orderLineMappings: PennylaneOrderLineMapping[];
      createdAt: string;
    }
  | {
      status: "already_exists";
      invoiceId: number | string;
      amount: number;
      currency: string;
      paymentIntentId: string;
      customerEmail: string | null;
      markAsPaid: PennylaneMarkAsPaidResult;
      email: PennylaneEmailResult;
      orderLineMappings: PennylaneOrderLineMapping[];
      createdAt: string;
    };

type PennylaneErrorDetails = {
  code: string;
  operation?: PennylaneOperation;
  http_status?: number;
  request_id?: string;
  error_body?: Record<string, string | number | boolean | null>;
  error_message?: string;
  missing_fields?: string[];
  invoice_id?: number | string;
  expected_amount?: number;
  actual_amount?: number;
};

type PennylaneEnvironment = {
  token: string;
  isSandbox: boolean;
};

class PennylaneSyncError extends Error {
  readonly details: PennylaneErrorDetails;

  constructor(details: PennylaneErrorDetails) {
    super(details.code);
    this.name = "PennylaneSyncError";
    this.details = details;
  }
}

function requireId(resource: { id?: number | string }, operation: PennylaneOperation) {
  if (typeof resource.id !== "number" && typeof resource.id !== "string") {
    throw new PennylaneSyncError({ code: "PENNYLANE_RESPONSE_MISSING_ID", operation });
  }

  return resource.id;
}

function sanitizePennylaneErrorText(value: string, token: string) {
  return value
    .replaceAll(token, "[REDACTED]")
    .replace(/authorization\s*[:=]\s*[^\s,;]+/gi, "Authorization: [REDACTED]")
    .replace(/bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/\bwhsec_[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .slice(0, 1_000);
}

async function readSafePennylaneError(response: Response, token: string) {
  const textFallbackResponse = response.clone();

  try {
    const body = (await response.json()) as unknown;

    if (typeof body === "string") {
      return { error_message: sanitizePennylaneErrorText(body, token) };
    }

    if (body && typeof body === "object" && !Array.isArray(body)) {
      const source = body as Record<string, unknown>;
      const safeBody: Record<string, string | number | boolean | null> = {};

      for (const key of ["error", "message", "code", "field", "status"] as const) {
        const value = source[key];

        if (typeof value === "string") {
          safeBody[key] = sanitizePennylaneErrorText(value, token);
        } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
          safeBody[key] = value;
        }
      }

      if (Object.keys(safeBody).length > 0) {
        return { error_body: safeBody };
      }
    }
  } catch {
    try {
      const text = await textFallbackResponse.text();

      if (text.trim()) {
        return { error_message: sanitizePennylaneErrorText(text.trim(), token) };
      }
    } catch {
      // The HTTP status and request ID remain available even without a readable body.
    }
  }

  return {};
}

async function pennylaneRequest<T>(
  token: string,
  path: string,
  operation: PennylaneOperation,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${PENNYLANE_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
    });
  } catch {
    throw new PennylaneSyncError({ code: "PENNYLANE_API_UNREACHABLE", operation });
  }

  if (!response.ok) {
    const safeError = await readSafePennylaneError(response, token);

    throw new PennylaneSyncError({
      code: "PENNYLANE_API_REQUEST_FAILED",
      operation,
      http_status: response.status,
      request_id: response.headers.get("x-request-id") ?? undefined,
      ...safeError,
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new PennylaneSyncError({ code: "PENNYLANE_INVALID_JSON_RESPONSE", operation });
  }
}

function buildFilter(field: string, operator: string, value: unknown) {
  const parameters = new URLSearchParams({
    limit: "1",
    filter: JSON.stringify([{ field, operator, value }]),
  });

  return parameters.toString();
}

async function inspectPennylaneEnvironment(token: string): Promise<PennylaneEnvironment> {
  const profile = await pennylaneRequest<PennylaneProfile>(token, "/me", "verify_sandbox");

  return {
    token,
    isSandbox: profile.company?.reg_no?.toLowerCase().startsWith("sandbox-") === true,
  };
}

async function findInvoice(token: string, externalReference: string) {
  const query = buildFilter("external_reference", "eq", externalReference);
  const result = await pennylaneRequest<PennylaneList<PennylaneInvoice>>(
    token,
    `/customer_invoices?${query}`,
    "find_invoice",
  );

  return Array.isArray(result.items) ? result.items[0] : undefined;
}

async function findCreditNote(token: string, externalReference: string) {
  const query = buildFilter("external_reference", "eq", externalReference);
  const result = await pennylaneRequest<PennylaneList<PennylaneInvoice>>(
    token,
    `/customer_invoices?${query}`,
    "find_credit_note",
  );

  return Array.isArray(result.items) ? result.items[0] : undefined;
}

async function findCustomer(token: string, email: string) {
  const query = buildFilter("emails", "in", [email]);
  const result = await pennylaneRequest<PennylaneList<PennylaneCustomer>>(
    token,
    `/customers?${query}`,
    "find_customer",
  );

  return Array.isArray(result.items) ? result.items[0] : undefined;
}

async function findCustomerByReference(token: string, externalReference: string) {
  const query = buildFilter("external_reference", "eq", externalReference);
  const result = await pennylaneRequest<PennylaneList<PennylaneCustomer>>(
    token,
    `/customers?${query}`,
    "find_customer",
  );

  return Array.isArray(result.items) ? result.items[0] : undefined;
}

async function hashEmail(email: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.toLowerCase()));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${STRIPE_CUSTOMER_REFERENCE_PREFIX}${hash}`;
}

function getBillingAddress(details: Stripe.Checkout.Session.CustomerDetails) {
  const address = details.address;
  const missingFields: string[] = [];

  if (!address?.line1) missingFields.push("customer_details.address.line1");
  if (!address?.postal_code) missingFields.push("customer_details.address.postal_code");
  if (!address?.city) missingFields.push("customer_details.address.city");
  if (!address?.country) missingFields.push("customer_details.address.country");

  if (missingFields.length > 0) {
    throw new PennylaneSyncError({ code: "MISSING_CUSTOMER_BILLING_ADDRESS", missing_fields: missingFields });
  }

  const completeAddress = address as Stripe.Address & {
    line1: string;
    postal_code: string;
    city: string;
    country: string;
  };

  return {
    address: [completeAddress.line1, completeAddress.line2].filter(Boolean).join(", "),
    postal_code: completeAddress.postal_code,
    city: completeAddress.city,
    country_alpha2: completeAddress.country,
  };
}

function splitIndividualName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    throw new PennylaneSyncError({
      code: "MISSING_CUSTOMER_NAME_PARTS",
      missing_fields: ["customer_details.individual_name.first_name", "customer_details.individual_name.last_name"],
    });
  }

  return {
    first_name: parts.slice(0, -1).join(" "),
    last_name: parts.at(-1) as string,
  };
}

async function createCustomer(
  token: string,
  details: Stripe.Checkout.Session.CustomerDetails,
  email: string,
) {
  const externalReference = await hashEmail(email);
  const billingAddress = getBillingAddress(details);
  const businessName = details.business_name?.trim();
  const individualName = (details.individual_name ?? (businessName ? null : details.name))?.trim();
  const commonFields = {
    emails: [email],
    billing_address: billingAddress,
    external_reference: externalReference,
    ...(details.phone ? { phone: details.phone } : {}),
  };

  let path: string;
  let body: Record<string, unknown>;

  if (businessName) {
    path = "/company_customers";
    body = {
      ...commonFields,
      name: businessName,
      ...(details.name ? { recipient: details.name } : {}),
    };
  } else if (individualName) {
    path = "/individual_customers";
    body = {
      ...commonFields,
      ...splitIndividualName(individualName),
      recipient: individualName,
    };
  } else {
    throw new PennylaneSyncError({
      code: "MISSING_CUSTOMER_NAME",
      missing_fields: ["customer_details.business_name", "customer_details.individual_name"],
    });
  }

  try {
    const customer = await pennylaneRequest<PennylaneCustomer>(token, path, "create_customer", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return requireId(customer, "create_customer");
  } catch (error) {
    if (error instanceof PennylaneSyncError && error.details.http_status === 409) {
      const existingCustomer =
        (await findCustomer(token, email)) ?? (await findCustomerByReference(token, externalReference));

      if (existingCustomer) return requireId(existingCustomer, "find_customer");
    }

    throw error;
  }
}

function getPennylaneVatRate(lineItem: Stripe.LineItem) {
  const product = lineItem.price?.product;
  const productMetadata =
    product && typeof product !== "string" && !product.deleted ? product.metadata : undefined;
  const vatRate =
    lineItem.metadata?.pennylane_vat_rate?.trim() ?? productMetadata?.pennylane_vat_rate?.trim();

  if (!vatRate) {
    throw new PennylaneSyncError({
      code: "MISSING_PENNYLANE_VAT_RATE",
      missing_fields: [`line_items.${lineItem.id}.metadata.pennylane_vat_rate`],
    });
  }

  if (vatRate !== PENNYLANE_EXEMPT_VAT_RATE) {
    throw new PennylaneSyncError({ code: "PENNYLANE_VAT_RATE_MUST_BE_EXEMPT" });
  }

  if (lineItem.amount_tax !== 0) {
    throw new PennylaneSyncError({ code: "STRIPE_TAX_DOES_NOT_MATCH_PENNYLANE_VAT_RATE" });
  }

  return PENNYLANE_EXEMPT_VAT_RATE;
}

const STRIPE_ORDER_LINE_METADATA_KEYS = [
  "catalog_id",
  "order_line_id",
  "size_fr",
  "pennylane_vat_rate",
  "schema_version",
] as const;

function validateSchemaV1OrderLineMapping(lineItem: Stripe.LineItem): StripeOrderLineMapping {
  const lineItemId = lineItem.id?.trim();

  if (!lineItemId || !/^li_[A-Za-z0-9]+$/.test(lineItemId)) {
    throw new PennylaneSyncError({
      code: "MISSING_OR_INVALID_STRIPE_LINE_ITEM_ID",
      missing_fields: ["line_items.id"],
    });
  }

  const lineMetadata = lineItem.metadata ?? {};
  const catalogId = lineMetadata.catalog_id?.trim();
  const orderLineId = lineMetadata.order_line_id?.trim();
  const sizeFr = lineMetadata.size_fr?.trim();
  const schemaVersion = lineMetadata.schema_version?.trim();
  const vatRate = lineMetadata.pennylane_vat_rate?.trim();
  const quantity = lineItem.quantity;
  const unitAmount = lineItem.price?.unit_amount;
  const missingFields = STRIPE_ORDER_LINE_METADATA_KEYS.filter(
    (key) => !lineMetadata[key]?.trim(),
  ).map((key) => `line_items.${lineItemId}.metadata.${key}`);

  if (missingFields.length > 0) {
    throw new PennylaneSyncError({
      code: "MISSING_STRIPE_ORDER_LINE_MAPPING",
      missing_fields: missingFields,
    });
  }

  if (
    !catalogId ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(catalogId) ||
    !orderLineId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      orderLineId,
    ) ||
    !sizeFr ||
    !/^(?:4[89]|5\d|6\d|70)$/.test(sizeFr) ||
    schemaVersion !== "1" ||
    vatRate !== PENNYLANE_EXEMPT_VAT_RATE ||
    !quantity ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    !Number.isInteger(unitAmount) ||
    (unitAmount as number) < 0 ||
    lineItem.amount_total !== (unitAmount as number) * quantity
  ) {
    throw new PennylaneSyncError({ code: "INVALID_STRIPE_ORDER_LINE_MAPPING" });
  }

  const product = lineItem.price?.product;

  if (!product || typeof product === "string" || product.deleted) {
    throw new PennylaneSyncError({
      code: "MISSING_EXPANDED_STRIPE_PRODUCT_MAPPING",
      missing_fields: [`line_items.${lineItemId}.price.product.metadata`],
    });
  }

  for (const key of STRIPE_ORDER_LINE_METADATA_KEYS) {
    if (product.metadata[key]?.trim() !== lineMetadata[key]?.trim()) {
      throw new PennylaneSyncError({ code: "STRIPE_PRODUCT_LINE_MAPPING_MISMATCH" });
    }
  }

  return {
    catalogId,
    orderLineId,
    sizeFr,
    stripeLineItemId: lineItemId,
    quantity,
    unitAmount: unitAmount as number,
    amountTotal: lineItem.amount_total,
  };
}

function formatUnitPrice(netAmount: number, quantity: number) {
  const scaledNumerator = BigInt(netAmount) * 10_000n;
  const divisor = BigInt(quantity);

  if (scaledNumerator % divisor !== 0n) {
    throw new PennylaneSyncError({ code: "UNIT_PRICE_EXCEEDS_SIX_DECIMALS" });
  }

  const scaled = scaledNumerator / divisor;
  const whole = scaled / 1_000_000n;
  const fraction = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function buildInvoiceLines(
  lineItems: Stripe.LineItem[],
  currency: string,
  requireSchemaV1Mapping: boolean,
): PreparedInvoiceLines {
  if (lineItems.length === 0) {
    throw new PennylaneSyncError({ code: "MISSING_STRIPE_LINE_ITEMS" });
  }

  const orderLineMappings: StripeOrderLineMapping[] = [];
  const seenStripeLineItemIds = new Set<string>();
  const seenOrderLineIds = new Set<string>();
  const invoiceLines = lineItems.map<PennylaneInvoiceLine>((lineItem) => {
    if (requireSchemaV1Mapping) {
      const mapping = validateSchemaV1OrderLineMapping(lineItem);

      if (seenStripeLineItemIds.has(mapping.stripeLineItemId)) {
        throw new PennylaneSyncError({ code: "DUPLICATE_STRIPE_LINE_ITEM_ID" });
      }

      if (seenOrderLineIds.has(mapping.orderLineId)) {
        throw new PennylaneSyncError({ code: "DUPLICATE_STRIPE_ORDER_LINE_ID" });
      }

      seenStripeLineItemIds.add(mapping.stripeLineItemId);
      seenOrderLineIds.add(mapping.orderLineId);
      orderLineMappings.push(mapping);
    }

    const quantity = lineItem.quantity;

    if (!quantity || !Number.isInteger(quantity) || quantity < 1) {
      throw new PennylaneSyncError({
        code: "INVALID_STRIPE_LINE_ITEM_QUANTITY",
        missing_fields: [`line_items.${lineItem.id}.quantity`],
      });
    }

    if (!lineItem.description) {
      throw new PennylaneSyncError({
        code: "MISSING_STRIPE_LINE_ITEM_DESCRIPTION",
        missing_fields: [`line_items.${lineItem.id}.description`],
      });
    }

    if (lineItem.currency !== currency) {
      throw new PennylaneSyncError({ code: "STRIPE_LINE_ITEM_CURRENCY_MISMATCH" });
    }

    if (lineItem.amount_discount !== 0) {
      throw new PennylaneSyncError({ code: "STRIPE_DISCOUNT_NOT_SUPPORTED" });
    }

    const netAmount = lineItem.amount_total - lineItem.amount_tax;

    if (netAmount < 0) {
      throw new PennylaneSyncError({ code: "INVALID_STRIPE_LINE_ITEM_AMOUNT" });
    }

    return {
      label: lineItem.description,
      quantity,
      unit: "piece",
      raw_currency_unit_price: formatUnitPrice(netAmount, quantity),
      vat_rate: getPennylaneVatRate(lineItem),
    };
  });

  return { invoiceLines, orderLineMappings };
}

function parseEuroAmountToCents(amount: string) {
  const match = amount.match(/^(-?)(\d+)(?:\.(\d{1,6}))?$/);

  if (!match) return null;

  const fraction = (match[3] ?? "").padEnd(6, "0");

  if (!/^\d{2}0{4}$/.test(fraction)) return null;

  const cents = Number(match[2]) * 100 + Number(fraction.slice(0, 2));

  return match[1] === "-" ? -cents : cents;
}

async function retrieveSucceededPaymentIntent(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
) {
  const paymentIntentReference = session.payment_intent;
  const paymentIntentId =
    typeof paymentIntentReference === "string"
      ? paymentIntentReference
      : paymentIntentReference?.id;

  if (!paymentIntentId || !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) {
    throw new PennylaneSyncError({
      code: "MISSING_OR_INVALID_STRIPE_PAYMENT_INTENT",
      missing_fields: ["checkout_session.payment_intent"],
    });
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (paymentIntent.id !== paymentIntentId || paymentIntent.object !== "payment_intent") {
    throw new PennylaneSyncError({ code: "STRIPE_PAYMENT_INTENT_ID_MISMATCH" });
  }

  if (paymentIntent.status !== "succeeded") {
    throw new PennylaneSyncError({ code: "STRIPE_PAYMENT_INTENT_NOT_SUCCEEDED" });
  }

  if (
    paymentIntent.currency !== session.currency ||
    paymentIntent.amount_received !== session.amount_total
  ) {
    throw new PennylaneSyncError({ code: "STRIPE_PAYMENT_INTENT_AMOUNT_OR_CURRENCY_MISMATCH" });
  }

  return paymentIntent.id;
}

async function verifyCreatedInvoiceAmount(
  token: string,
  invoice: PennylaneInvoice,
  invoiceId: number | string,
  expectedAmount: number,
) {
  const invoiceWithAmount =
    typeof invoice.currency_amount === "string"
      ? invoice
      : await pennylaneRequest<PennylaneInvoice>(
          token,
          `/customer_invoices/${encodeURIComponent(String(invoiceId))}`,
          "verify_invoice",
        );
  const actualAmount = invoiceWithAmount.currency_amount
    ? parseEuroAmountToCents(invoiceWithAmount.currency_amount)
    : null;

  if (actualAmount !== expectedAmount) {
    throw new PennylaneSyncError({
      code: "PENNYLANE_INVOICE_AMOUNT_MISMATCH",
      operation: "verify_invoice",
      invoice_id: invoiceId,
      expected_amount: expectedAmount,
      ...(actualAmount === null ? {} : { actual_amount: actualAmount }),
    });
  }

  return invoiceWithAmount;
}

async function retrieveInvoice(token: string, invoiceId: number | string) {
  return pennylaneRequest<PennylaneInvoice>(
    token,
    `/customer_invoices/${encodeURIComponent(String(invoiceId))}`,
    "retrieve_invoice",
  );
}

async function markSandboxInvoiceAsPaid(
  environment: PennylaneEnvironment,
  invoiceId: number | string,
  invoice: PennylaneInvoice,
): Promise<PennylaneMarkAsPaidResult> {
  // Runtime guard: the mutating endpoint is unreachable for every non-Sandbox token.
  if (!environment.isSandbox) {
    return { status: "skipped_non_sandbox" };
  }

  try {
    const currentInvoice =
      typeof invoice.paid === "boolean"
        ? invoice
        : await retrieveInvoice(environment.token, invoiceId);

    if (currentInvoice.paid === true) {
      return {
        status: "already_paid",
        remainingAmountWithTax: currentInvoice.remaining_amount_with_tax,
      };
    }

    await pennylaneRequest<void>(
      environment.token,
      `/customer_invoices/${encodeURIComponent(String(invoiceId))}/mark_as_paid`,
      "mark_as_paid",
      { method: "PUT" },
    );

    const paidInvoice = await retrieveInvoice(environment.token, invoiceId);
    if (paidInvoice.paid !== true) {
      throw new PennylaneSyncError({
        code: "PENNYLANE_MARK_AS_PAID_NOT_CONFIRMED",
        operation: "mark_as_paid",
        invoice_id: invoiceId,
      });
    }

    return {
      status: "marked_paid",
      remainingAmountWithTax: paidInvoice.remaining_amount_with_tax,
    };
  } catch (error) {
    return { status: "error", error: getPennylaneErrorDetails(error) };
  }
}

function isValidCustomerEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function sendPennylaneDocumentByEmail(
  environment: PennylaneEnvironment,
  documentId: number | string,
  customerEmail: string,
  operation: "send_by_email" | "send_credit_note_by_email",
): Promise<PennylaneEmailResult> {
  // Final runtime guard immediately before the mutating email endpoint.
  if (!environment.isSandbox) {
    return { status: "skipped_non_sandbox" };
  }

  if (!isValidCustomerEmail(customerEmail)) {
    return {
      status: "error",
      error: {
        code: "INVALID_STRIPE_CUSTOMER_EMAIL",
        operation,
        missing_fields: ["checkout_session.customer_details.email"],
      },
    };
  }

  const retryDelays = [2_000, 4_000];

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await pennylaneRequest<void>(
          environment.token,
          `/customer_invoices/${encodeURIComponent(String(documentId))}/send_by_email`,
          operation,
          {
            method: "POST",
            body: JSON.stringify({ recipients: [customerEmail] }),
          },
        );

        return { status: "sent" };
      } catch (error) {
        const isPdfPending =
          error instanceof PennylaneSyncError && error.details.http_status === 409;

        if (!isPdfPending || attempt === 2) {
          throw error;
        }

        await wait(retryDelays[attempt]);
      }
    }

    throw new PennylaneSyncError({
      code: "PENNYLANE_EMAIL_RETRY_LIMIT_REACHED",
      operation,
      invoice_id: documentId,
    });
  } catch (error) {
    return { status: "error", error: getPennylaneErrorDetails(error) };
  }
}

async function sendSandboxInvoiceByEmail(
  environment: PennylaneEnvironment,
  invoiceId: number | string,
  externalReference: string,
  customerEmail: string,
): Promise<PennylaneEmailResult> {
  // Independent runtime guard: production can never reach the email endpoint.
  if (!environment.isSandbox) {
    return { status: "skipped_non_sandbox" };
  }

  try {
    const invoice = await retrieveInvoice(environment.token, invoiceId);

    if (invoice.draft !== false) {
      throw new PennylaneSyncError({
        code: "PENNYLANE_EMAIL_REQUIRES_FINALIZED_INVOICE",
        operation: "send_by_email",
        invoice_id: invoiceId,
      });
    }

    if (invoice.external_reference !== externalReference) {
      throw new PennylaneSyncError({
        code: "PENNYLANE_INVOICE_EXTERNAL_REFERENCE_MISMATCH",
        operation: "send_by_email",
        invoice_id: invoiceId,
      });
    }

    return sendPennylaneDocumentByEmail(
      environment,
      invoiceId,
      customerEmail,
      "send_by_email",
    );
  } catch (error) {
    return { status: "error", error: getPennylaneErrorDetails(error) };
  }
}

async function sendSandboxCreditNoteByEmail(
  environment: PennylaneEnvironment,
  creditNoteId: number | string,
  invoiceId: number | string,
  externalReference: string,
  customerEmail: string,
): Promise<PennylaneEmailResult> {
  // Independent runtime guard: a production token can never reach the email endpoint.
  if (!environment.isSandbox) {
    return { status: "skipped_non_sandbox" };
  }

  try {
    const creditNote = await retrieveInvoice(environment.token, creditNoteId);
    const isFinalizedCreditNote =
      creditNote.draft === false &&
      (creditNote.status === "credit_note" || creditNote.status === "cancelled");

    if (!isFinalizedCreditNote) {
      throw new PennylaneSyncError({
        code: "PENNYLANE_EMAIL_REQUIRES_FINALIZED_CREDIT_NOTE",
        operation: "send_credit_note_by_email",
        invoice_id: creditNoteId,
      });
    }

    if (
      creditNote.external_reference !== externalReference ||
      String(creditNote.credited_invoice?.id) !== String(invoiceId)
    ) {
      throw new PennylaneSyncError({
        code: "PENNYLANE_CREDIT_NOTE_EMAIL_LINK_MISMATCH",
        operation: "send_credit_note_by_email",
        invoice_id: creditNoteId,
      });
    }

    return sendPennylaneDocumentByEmail(
      environment,
      creditNoteId,
      customerEmail,
      "send_credit_note_by_email",
    );
  } catch (error) {
    return { status: "error", error: getPennylaneErrorDetails(error) };
  }
}

function requireStripePaymentIntentId(
  paymentIntent: string | Stripe.PaymentIntent | null,
) {
  const paymentIntentId =
    typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id;

  if (!paymentIntentId || !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) {
    throw new PennylaneSyncError({ code: "MISSING_OR_INVALID_STRIPE_PAYMENT_INTENT" });
  }

  return paymentIntentId;
}

async function retrieveRefundCheckoutContext(stripe: Stripe, charge: Stripe.Charge) {
  const paymentIntentId = requireStripePaymentIntentId(charge.payment_intent);
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const latestChargeId =
    typeof paymentIntent.latest_charge === "string"
      ? paymentIntent.latest_charge
      : paymentIntent.latest_charge?.id;

  if (
    paymentIntent.id !== paymentIntentId ||
    paymentIntent.object !== "payment_intent" ||
    paymentIntent.status !== "succeeded" ||
    latestChargeId !== charge.id
  ) {
    throw new PennylaneSyncError({ code: "STRIPE_REFUND_PAYMENT_INTENT_MISMATCH" });
  }

  if (
    paymentIntent.amount_received !== charge.amount ||
    paymentIntent.currency !== charge.currency
  ) {
    throw new PennylaneSyncError({ code: "STRIPE_REFUND_AMOUNT_OR_CURRENCY_MISMATCH" });
  }

  const sessions = await stripe.checkout.sessions.list({
    payment_intent: paymentIntentId,
    limit: 2,
  });

  if (sessions.data.length !== 1) {
    throw new PennylaneSyncError({ code: "STRIPE_REFUND_CHECKOUT_SESSION_NOT_UNIQUE" });
  }

  const listedSession = sessions.data[0];

  if (!listedSession) {
    throw new PennylaneSyncError({ code: "STRIPE_REFUND_CHECKOUT_SESSION_MISMATCH" });
  }

  const session = await stripe.checkout.sessions.retrieve(listedSession.id);

  if (
    session.mode !== "payment" ||
    session.payment_status !== "paid" ||
    session.amount_total !== charge.amount ||
    session.currency !== charge.currency
  ) {
    throw new PennylaneSyncError({ code: "STRIPE_REFUND_CHECKOUT_SESSION_MISMATCH" });
  }

  return { paymentIntentId, session };
}

async function listAllInvoiceLines(
  token: string,
  invoiceId: number | string,
  sort: "id" | "rank" = "id",
) {
  const lines: PennylaneStoredInvoiceLine[] = [];
  let cursor: string | undefined;

  do {
    const parameters = new URLSearchParams({ limit: "100", sort });

    if (cursor) parameters.set("cursor", cursor);

    const result = await pennylaneRequest<PennylaneList<PennylaneStoredInvoiceLine>>(
      token,
      `/customer_invoices/${encodeURIComponent(String(invoiceId))}/invoice_lines?${parameters}`,
      "list_invoice_lines",
    );

    if (Array.isArray(result.items)) lines.push(...result.items);
    cursor = result.next_cursor ?? undefined;

    if (lines.length > 1_000) {
      throw new PennylaneSyncError({ code: "PENNYLANE_TOO_MANY_INVOICE_LINES" });
    }
  } while (cursor);

  if (lines.length === 0) {
    throw new PennylaneSyncError({ code: "PENNYLANE_INVOICE_LINES_MISSING" });
  }

  return lines;
}

async function attachPennylaneInvoiceLineIds(
  token: string,
  invoiceId: number | string,
  mappings: StripeOrderLineMapping[],
): Promise<PennylaneOrderLineMapping[]> {
  if (mappings.length === 0) return [];

  const pennylaneLines = await listAllInvoiceLines(token, invoiceId, "rank");

  if (pennylaneLines.length !== mappings.length) {
    throw new PennylaneSyncError({ code: "PENNYLANE_INVOICE_LINE_COUNT_MISMATCH" });
  }

  return mappings.map((mapping, index) => {
    const pennylaneLine = pennylaneLines[index];

    if (!pennylaneLine) {
      throw new PennylaneSyncError({ code: "PENNYLANE_INVOICE_LINE_MISSING" });
    }

    const pennylaneLineId = requireId(pennylaneLine, "list_invoice_lines");
    const quantity = Number(pennylaneLine.quantity);
    const amountTotal = pennylaneLine.currency_amount
      ? parseEuroAmountToCents(pennylaneLine.currency_amount)
      : null;
    const unitAmount = pennylaneLine.raw_currency_unit_price
      ? parseEuroAmountToCents(pennylaneLine.raw_currency_unit_price)
      : null;

    if (
      quantity !== mapping.quantity ||
      amountTotal !== mapping.amountTotal ||
      unitAmount !== mapping.unitAmount ||
      pennylaneLine.vat_rate !== PENNYLANE_EXEMPT_VAT_RATE
    ) {
      throw new PennylaneSyncError({
        code: "PENNYLANE_STRIPE_LINE_MAPPING_MISMATCH",
        operation: "list_invoice_lines",
        invoice_id: invoiceId,
      });
    }

    return {
      ...mapping,
      pennylaneInvoiceLineId: String(pennylaneLineId),
    };
  });
}

function negatePennylaneUnitPrice(value: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new PennylaneSyncError({ code: "INVALID_PENNYLANE_INVOICE_UNIT_PRICE" });
  }

  return /^0+(?:\.0+)?$/.test(value) ? value : `-${value}`;
}

function buildCreditNoteLines(
  sourceLines: PennylaneStoredInvoiceLine[],
  expectedAmount: number,
) {
  let sourceTotal = 0;

  const creditNoteLines = sourceLines.map((line) => {
    const quantity = Number(line.quantity);
    const lineAmount = line.currency_amount
      ? parseEuroAmountToCents(line.currency_amount)
      : null;

    if (
      !line.label ||
      !line.unit ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !line.raw_currency_unit_price ||
      line.vat_rate !== PENNYLANE_EXEMPT_VAT_RATE ||
      lineAmount === null ||
      lineAmount < 0
    ) {
      throw new PennylaneSyncError({ code: "INVALID_PENNYLANE_SOURCE_INVOICE_LINE" });
    }

    sourceTotal += lineAmount;

    return {
      label: line.label,
      quantity,
      unit: line.unit,
      raw_currency_unit_price: negatePennylaneUnitPrice(line.raw_currency_unit_price),
      vat_rate: PENNYLANE_EXEMPT_VAT_RATE,
      ...(line.description ? { description: line.description } : {}),
    };
  });

  if (sourceTotal !== expectedAmount) {
    throw new PennylaneSyncError({ code: "PENNYLANE_SOURCE_LINES_TOTAL_MISMATCH" });
  }

  return creditNoteLines;
}

async function verifyAndLinkCreditNote(
  token: string,
  creditNoteId: number | string,
  invoiceId: number | string,
  externalReference: string,
  expectedAmount: number,
  currency: string,
  customerId: number | string,
) {
  const completeCreditNote = await retrieveInvoice(token, creditNoteId);
  const creditNoteAmount = completeCreditNote.currency_amount
    ? parseEuroAmountToCents(completeCreditNote.currency_amount)
    : null;
  const isCreditNoteStatus =
    completeCreditNote.status === "credit_note" ||
    (completeCreditNote.status === "cancelled" &&
      completeCreditNote.credited_invoice?.id !== undefined &&
      completeCreditNote.credited_invoice.id !== null);

  if (
    completeCreditNote.draft !== false ||
    !isCreditNoteStatus ||
    completeCreditNote.external_reference !== externalReference ||
    completeCreditNote.currency !== currency.toUpperCase() ||
    creditNoteAmount !== -expectedAmount ||
    String(completeCreditNote.customer?.id) !== String(customerId)
  ) {
    throw new PennylaneSyncError({
      code: "PENNYLANE_CREDIT_NOTE_VERIFICATION_FAILED",
      operation: "verify_credit_note",
      invoice_id: creditNoteId,
    });
  }

  const creditedInvoiceId = completeCreditNote.credited_invoice?.id;

  if (creditedInvoiceId !== undefined && creditedInvoiceId !== null) {
    if (String(creditedInvoiceId) !== String(invoiceId)) {
      throw new PennylaneSyncError({
        code: "PENNYLANE_CREDIT_NOTE_LINK_MISMATCH",
        operation: "link_credit_note",
        invoice_id: creditNoteId,
      });
    }

    return;
  }

  await pennylaneRequest<PennylaneInvoice>(
    token,
    `/customer_invoices/${encodeURIComponent(String(invoiceId))}/link_credit_note`,
    "link_credit_note",
    {
      method: "POST",
      body: JSON.stringify({ credit_note_id: creditNoteId }),
    },
  );

  const linkedCreditNote = await retrieveInvoice(token, creditNoteId);

  if (String(linkedCreditNote.credited_invoice?.id) !== String(invoiceId)) {
    throw new PennylaneSyncError({
      code: "PENNYLANE_CREDIT_NOTE_LINK_NOT_CONFIRMED",
      operation: "link_credit_note",
      invoice_id: creditNoteId,
    });
  }
}

export async function syncTotalRefundToPennylane({
  stripe,
  charge,
  eventCreated,
  token,
}: {
  stripe: Stripe;
  charge: Stripe.Charge;
  eventCreated: number;
  token: string;
}): Promise<PennylaneCreditNoteResult> {
  const environment = await inspectPennylaneEnvironment(token);

  if (!environment.isSandbox) {
    throw new PennylaneSyncError({ code: "PENNYLANE_SANDBOX_REQUIRED" });
  }

  if (charge.amount_refunded !== charge.amount || charge.amount <= 0) {
    throw new PennylaneSyncError({ code: "STRIPE_TOTAL_REFUND_REQUIRED" });
  }

  if (charge.currency !== "eur") {
    throw new PennylaneSyncError({ code: "STRIPE_REFUND_CURRENCY_NOT_SUPPORTED" });
  }

  const { paymentIntentId, session } = await retrieveRefundCheckoutContext(stripe, charge);
  const rawCustomerEmail = session.customer_details?.email ?? session.customer_email;
  const customerEmail = rawCustomerEmail?.trim().toLowerCase() ?? null;
  const invoiceExternalReference = `${STRIPE_INVOICE_REFERENCE_PREFIX}${session.id}`;
  const listedInvoice = await findInvoice(token, invoiceExternalReference);

  if (!listedInvoice) {
    throw new PennylaneSyncError({ code: "PENNYLANE_REFUNDED_INVOICE_NOT_FOUND" });
  }

  const invoiceId = requireId(listedInvoice, "find_invoice");
  const invoice = await retrieveInvoice(token, invoiceId);
  const customerId = invoice.customer ? requireId(invoice.customer, "retrieve_invoice") : null;
  const transactionReference = invoice.transaction_reference;
  const invoiceAmount = invoice.currency_amount
    ? parseEuroAmountToCents(invoice.currency_amount)
    : null;

  if (
    invoice.draft !== false ||
    invoice.status === "credit_note" ||
    invoice.external_reference !== invoiceExternalReference ||
    !customerId ||
    invoice.currency !== charge.currency.toUpperCase() ||
    invoiceAmount !== charge.amount ||
    transactionReference?.banking_provider !== "stripe" ||
    transactionReference.provider_field_name !== "payment_id" ||
    transactionReference.provider_field_value !== paymentIntentId
  ) {
    throw new PennylaneSyncError({ code: "PENNYLANE_REFUNDED_INVOICE_MISMATCH" });
  }

  const creditNoteExternalReference = `${STRIPE_REFUND_REFERENCE_PREFIX}${charge.id}`;
  const existingCreditNote = await findCreditNote(token, creditNoteExternalReference);

  if (existingCreditNote) {
    const creditNoteId = requireId(existingCreditNote, "find_credit_note");
    await verifyAndLinkCreditNote(
      token,
      creditNoteId,
      invoiceId,
      creditNoteExternalReference,
      charge.amount_refunded,
      charge.currency,
      customerId,
    );

    return {
      status: "already_exists",
      invoiceId,
      creditNoteId,
      paymentIntentId,
      amount: charge.amount_refunded,
      currency: charge.currency,
      customerEmail,
      email: { status: "skipped_existing_invoice" },
    };
  }

  const sourceLines = await listAllInvoiceLines(token, invoiceId);
  const creditNoteLines = buildCreditNoteLines(sourceLines, charge.amount_refunded);
  const creditNoteDate = new Date(eventCreated * 1_000).toISOString().slice(0, 10);
  const creditNotePayload = {
    customer_id: customerId,
    date: creditNoteDate,
    deadline: creditNoteDate,
    currency: charge.currency.toUpperCase(),
    draft: false,
    special_mention: VAT_EXEMPTION_MENTION,
    external_reference: creditNoteExternalReference,
    invoice_lines: creditNoteLines,
  };

  let creditNote: PennylaneInvoice;

  try {
    creditNote = await pennylaneRequest<PennylaneInvoice>(
      token,
      "/customer_invoices",
      "create_credit_note",
      { method: "POST", body: JSON.stringify(creditNotePayload) },
    );
  } catch (error) {
    const creditNoteCreatedByConcurrentRequest = await findCreditNote(
      token,
      creditNoteExternalReference,
    );

    if (!creditNoteCreatedByConcurrentRequest) throw error;

    const creditNoteId = requireId(creditNoteCreatedByConcurrentRequest, "find_credit_note");
    await verifyAndLinkCreditNote(
      token,
      creditNoteId,
      invoiceId,
      creditNoteExternalReference,
      charge.amount_refunded,
      charge.currency,
      customerId,
    );

    return {
      status: "already_exists",
      invoiceId,
      creditNoteId,
      paymentIntentId,
      amount: charge.amount_refunded,
      currency: charge.currency,
      customerEmail,
      email: { status: "skipped_existing_invoice" },
    };
  }

  const creditNoteId = requireId(creditNote, "create_credit_note");
  await verifyAndLinkCreditNote(
    token,
    creditNoteId,
    invoiceId,
    creditNoteExternalReference,
    charge.amount_refunded,
    charge.currency,
    customerId,
  );
  const email = await sendSandboxCreditNoteByEmail(
    environment,
    creditNoteId,
    invoiceId,
    creditNoteExternalReference,
    customerEmail ?? "",
  );

  return {
    status: "created",
    invoiceId,
    creditNoteId,
    paymentIntentId,
    amount: charge.amount_refunded,
    currency: charge.currency,
    customerEmail,
    email,
  };
}

async function verifyPartialCreditNoteLine(
  token: string,
  creditNoteId: number | string,
  sourceLine: PennylaneStoredInvoiceLine,
  quantity: number,
  unitAmount: number,
) {
  const lines = await listAllInvoiceLines(token, creditNoteId, "rank");

  if (lines.length !== 1) {
    throw new PennylaneSyncError({
      code: "PENNYLANE_PARTIAL_CREDIT_NOTE_LINE_COUNT_MISMATCH",
      operation: "verify_credit_note",
      invoice_id: creditNoteId,
    });
  }

  const line = lines[0];
  const lineQuantity = Number(line?.quantity);
  const lineAmount = line?.currency_amount
    ? parseEuroAmountToCents(line.currency_amount)
    : null;
  const lineUnitAmount = line?.raw_currency_unit_price
    ? parseEuroAmountToCents(line.raw_currency_unit_price)
    : null;

  if (
    !line ||
    line.label !== sourceLine.label ||
    line.unit !== sourceLine.unit ||
    lineQuantity !== quantity ||
    lineAmount !== -(unitAmount * quantity) ||
    lineUnitAmount !== -unitAmount ||
    line.vat_rate !== PENNYLANE_EXEMPT_VAT_RATE
  ) {
    throw new PennylaneSyncError({
      code: "PENNYLANE_PARTIAL_CREDIT_NOTE_LINE_MISMATCH",
      operation: "verify_credit_note",
      invoice_id: creditNoteId,
    });
  }
}

export async function syncPartialRefundToPennylane({
  token,
  refundId,
  refundCreated,
  paymentIntentId,
  checkoutSessionId,
  invoiceId: expectedInvoiceId,
  invoiceLineId,
  quantity,
  unitAmount,
  refundAmount,
  invoiceAmountTotal,
  currency,
}: {
  token: string;
  refundId: string;
  refundCreated: number;
  paymentIntentId: string;
  checkoutSessionId: string;
  invoiceId: string;
  invoiceLineId: string;
  quantity: number;
  unitAmount: number;
  refundAmount: number;
  invoiceAmountTotal: number;
  currency: string;
}): Promise<PennylanePartialCreditNoteResult> {
  const environment = await inspectPennylaneEnvironment(token);

  if (!environment.isSandbox) {
    throw new PennylaneSyncError({ code: "PENNYLANE_SANDBOX_REQUIRED" });
  }
  if (
    currency !== "eur" ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    !Number.isInteger(unitAmount) ||
    unitAmount < 1 ||
    refundAmount !== unitAmount * quantity
  ) {
    throw new PennylaneSyncError({ code: "INVALID_PARTIAL_REFUND_AMOUNT_OR_CURRENCY" });
  }

  const invoiceExternalReference = `${STRIPE_INVOICE_REFERENCE_PREFIX}${checkoutSessionId}`;
  const listedInvoice = await findInvoice(token, invoiceExternalReference);

  if (!listedInvoice || String(requireId(listedInvoice, "find_invoice")) !== expectedInvoiceId) {
    throw new PennylaneSyncError({ code: "PENNYLANE_REFUNDED_INVOICE_NOT_FOUND" });
  }

  const invoice = await retrieveInvoice(token, expectedInvoiceId);
  const customerId = invoice.customer ? requireId(invoice.customer, "retrieve_invoice") : null;
  const invoiceAmount = invoice.currency_amount
    ? parseEuroAmountToCents(invoice.currency_amount)
    : null;

  if (
    invoice.draft !== false ||
    invoice.status === "credit_note" ||
    invoice.external_reference !== invoiceExternalReference ||
    !customerId ||
    invoice.currency !== currency.toUpperCase() ||
    invoiceAmount !== invoiceAmountTotal ||
    invoice.transaction_reference?.banking_provider !== "stripe" ||
    invoice.transaction_reference.provider_field_name !== "payment_id" ||
    invoice.transaction_reference.provider_field_value !== paymentIntentId
  ) {
    throw new PennylaneSyncError({ code: "PENNYLANE_REFUNDED_INVOICE_MISMATCH" });
  }

  const sourceLines = await listAllInvoiceLines(token, expectedInvoiceId, "rank");
  const sourceLine = sourceLines.find((line) => String(line.id) === invoiceLineId);
  const sourceQuantity = Number(sourceLine?.quantity);
  const sourceUnitAmount = sourceLine?.raw_currency_unit_price
    ? parseEuroAmountToCents(sourceLine.raw_currency_unit_price)
    : null;
  const sourceLineAmount = sourceLine?.currency_amount
    ? parseEuroAmountToCents(sourceLine.currency_amount)
    : null;

  if (
    !sourceLine ||
    !sourceLine.label ||
    !sourceLine.unit ||
    !Number.isInteger(sourceQuantity) ||
    sourceQuantity < quantity ||
    sourceUnitAmount !== unitAmount ||
    sourceLineAmount !== unitAmount * sourceQuantity ||
    sourceLine.vat_rate !== PENNYLANE_EXEMPT_VAT_RATE
  ) {
    throw new PennylaneSyncError({ code: "PENNYLANE_SOURCE_INVOICE_LINE_MISMATCH" });
  }

  const externalReference = `${STRIPE_REFUND_REFERENCE_PREFIX}${refundId}`;
  const verifyExistingCreditNote = async (listedCreditNote: PennylaneInvoice) => {
    const creditNoteId = requireId(listedCreditNote, "find_credit_note");
    await verifyAndLinkCreditNote(
      token,
      creditNoteId,
      expectedInvoiceId,
      externalReference,
      refundAmount,
      currency,
      customerId,
    );
    await verifyPartialCreditNoteLine(
      token,
      creditNoteId,
      sourceLine,
      quantity,
      unitAmount,
    );
    return creditNoteId;
  };

  const existingCreditNote = await findCreditNote(token, externalReference);

  if (existingCreditNote) {
    return {
      status: "already_exists",
      invoiceId: expectedInvoiceId,
      creditNoteId: await verifyExistingCreditNote(existingCreditNote),
      amount: refundAmount,
      currency,
    };
  }

  const creditNoteDate = new Date(refundCreated * 1_000).toISOString().slice(0, 10);
  const payload = {
    customer_id: customerId,
    date: creditNoteDate,
    deadline: creditNoteDate,
    currency: currency.toUpperCase(),
    draft: false,
    special_mention: VAT_EXEMPTION_MENTION,
    external_reference: externalReference,
    invoice_lines: [
      {
        label: sourceLine.label,
        quantity,
        unit: sourceLine.unit,
        raw_currency_unit_price: negatePennylaneUnitPrice(
          sourceLine.raw_currency_unit_price as string,
        ),
        vat_rate: PENNYLANE_EXEMPT_VAT_RATE,
      },
    ],
  };

  try {
    const creditNote = await pennylaneRequest<PennylaneInvoice>(
      token,
      "/customer_invoices",
      "create_credit_note",
      { method: "POST", body: JSON.stringify(payload) },
    );
    const creditNoteId = requireId(creditNote, "create_credit_note");
    await verifyAndLinkCreditNote(
      token,
      creditNoteId,
      expectedInvoiceId,
      externalReference,
      refundAmount,
      currency,
      customerId,
    );
    await verifyPartialCreditNoteLine(token, creditNoteId, sourceLine, quantity, unitAmount);

    return {
      status: "created",
      invoiceId: expectedInvoiceId,
      creditNoteId,
      amount: refundAmount,
      currency,
    };
  } catch (error) {
    const concurrentCreditNote = await findCreditNote(token, externalReference);
    if (!concurrentCreditNote) throw error;

    return {
      status: "already_exists",
      invoiceId: expectedInvoiceId,
      creditNoteId: await verifyExistingCreditNote(concurrentCreditNote),
      amount: refundAmount,
      currency,
    };
  }
}

export async function syncPaidCheckoutSessionToPennylane({
  stripe,
  sessionId,
  token,
}: {
  stripe: Stripe;
  sessionId: string;
  token: string;
}): Promise<PennylaneSyncResult> {
  const environment = await inspectPennylaneEnvironment(token);

  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["customer"] });

  if (session.payment_status !== "paid") {
    throw new PennylaneSyncError({ code: "STRIPE_SESSION_NOT_PAID" });
  }

  if (session.currency !== "eur" || session.amount_total === null) {
    throw new PennylaneSyncError({
      code: "MISSING_OR_UNSUPPORTED_STRIPE_CURRENCY",
      missing_fields: ["checkout_session.currency", "checkout_session.amount_total"],
    });
  }

  const sessionCurrency = session.currency;

  const paymentIntentId = await retrieveSucceededPaymentIntent(stripe, session);

  const requiresSchemaV1Mapping = session.metadata?.schema_version === "1";
  let preparedInvoiceLines: PreparedInvoiceLines | undefined;

  const prepareInvoiceLines = async () => {
    const lineItems = await stripe.checkout.sessions
      .listLineItems(session.id, { limit: 100, expand: ["data.price.product"] })
      .autoPagingToArray({ limit: 1000 });
    const stripeLineItemsTotal = lineItems.reduce(
      (total, lineItem) => total + lineItem.amount_total,
      0,
    );

    if (stripeLineItemsTotal !== session.amount_total) {
      throw new PennylaneSyncError({ code: "STRIPE_SESSION_TOTAL_MISMATCH" });
    }

    return buildInvoiceLines(lineItems, sessionCurrency, requiresSchemaV1Mapping);
  };

  // New schema-v1 sessions are validated before any idempotent early return.
  // Legacy sessions retain the previous lazy line-item retrieval behavior.
  if (requiresSchemaV1Mapping) {
    preparedInvoiceLines = await prepareInvoiceLines();
  }

  const customerEmail =
    (session.customer_details?.email ?? session.customer_email)?.trim().toLowerCase() ?? null;
  const createdAt = new Date(session.created * 1_000).toISOString();
  const externalReference = `${STRIPE_INVOICE_REFERENCE_PREFIX}${sessionId}`;
  const existingInvoice = await findInvoice(token, externalReference);

  if (existingInvoice) {
    const invoiceId = requireId(existingInvoice, "find_invoice");
    const verifiedInvoice = await verifyCreatedInvoiceAmount(
      token,
      existingInvoice,
      invoiceId,
      session.amount_total,
    );
    const markAsPaid = await markSandboxInvoiceAsPaid(environment, invoiceId, verifiedInvoice);
    const orderLineMappings = await attachPennylaneInvoiceLineIds(
      token,
      invoiceId,
      preparedInvoiceLines?.orderLineMappings ?? [],
    );

    return {
      status: "already_exists",
      invoiceId,
      amount: session.amount_total,
      currency: session.currency,
      paymentIntentId,
      customerEmail,
      markAsPaid,
      email: { status: "skipped_existing_invoice" },
      orderLineMappings,
      createdAt,
    };
  }

  if (!customerEmail || !isValidCustomerEmail(customerEmail) || !session.customer_details) {
    throw new PennylaneSyncError({
      code: "MISSING_STRIPE_CUSTOMER_DETAILS",
      missing_fields: ["checkout_session.customer_details.email"],
    });
  }

  preparedInvoiceLines ??= await prepareInvoiceLines();
  const { invoiceLines, orderLineMappings } = preparedInvoiceLines;
  const existingCustomer = await findCustomer(token, customerEmail);
  const customerId = existingCustomer
    ? requireId(existingCustomer, "find_customer")
    : await createCustomer(token, session.customer_details, customerEmail);
  const invoiceDate = new Date(session.created * 1000).toISOString().slice(0, 10);
  const invoicePayload = {
    customer_id: customerId,
    date: invoiceDate,
    deadline: invoiceDate,
    currency: session.currency.toUpperCase(),
    draft: false,
    special_mention: VAT_EXEMPTION_MENTION,
    external_reference: externalReference,
    transaction_reference: {
      banking_provider: "stripe",
      provider_field_name: "payment_id",
      provider_field_value: paymentIntentId,
    },
    invoice_lines: invoiceLines,
  };

  let invoice: PennylaneInvoice;

  try {
    invoice = await pennylaneRequest<PennylaneInvoice>(token, "/customer_invoices", "create_invoice", {
      method: "POST",
      body: JSON.stringify(invoicePayload),
    });
  } catch (error) {
    const invoiceCreatedByConcurrentRequest = await findInvoice(token, externalReference);

    if (invoiceCreatedByConcurrentRequest) {
      const invoiceId = requireId(invoiceCreatedByConcurrentRequest, "find_invoice");
      const verifiedInvoice = await verifyCreatedInvoiceAmount(
        token,
        invoiceCreatedByConcurrentRequest,
        invoiceId,
        session.amount_total,
      );
      const markAsPaid = await markSandboxInvoiceAsPaid(environment, invoiceId, verifiedInvoice);
      const persistedOrderLineMappings = await attachPennylaneInvoiceLineIds(
        token,
        invoiceId,
        orderLineMappings,
      );

      return {
        status: "already_exists",
        invoiceId,
        amount: session.amount_total,
        currency: session.currency,
        paymentIntentId,
        customerEmail,
        markAsPaid,
        email: { status: "skipped_existing_invoice" },
        orderLineMappings: persistedOrderLineMappings,
        createdAt,
      };
    }

    throw error;
  }

  const invoiceId = requireId(invoice, "create_invoice");
  const verifiedInvoice = await verifyCreatedInvoiceAmount(
    token,
    invoice,
    invoiceId,
    session.amount_total,
  );
  const markAsPaid = await markSandboxInvoiceAsPaid(environment, invoiceId, verifiedInvoice);
  const email =
    markAsPaid.status === "marked_paid" || markAsPaid.status === "already_paid"
      ? await sendSandboxInvoiceByEmail(
          environment,
          invoiceId,
          externalReference,
          customerEmail,
        )
      : { status: "skipped_mark_as_paid_incomplete" as const };
  const persistedOrderLineMappings = await attachPennylaneInvoiceLineIds(
    token,
    invoiceId,
    orderLineMappings,
  );

  return {
    status: "created",
    invoiceId,
    customerEmail,
    amount: session.amount_total,
    currency: session.currency,
    paymentIntentId,
    markAsPaid,
    email,
    orderLineMappings: persistedOrderLineMappings,
    createdAt,
  };
}

export function getPennylaneErrorDetails(error: unknown): PennylaneErrorDetails {
  return error instanceof PennylaneSyncError ? error.details : { code: "UNEXPECTED_PENNYLANE_ERROR" };
}
