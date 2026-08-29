export const ADMIN_REFUND_REQUEST_TIMEOUT_MS = 20_000;

type RefundPreviewLine = {
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
  lines: RefundPreviewLine[];
};

export function validateRefundPreviewResponse({
  preview,
  orderId,
  currency,
  selections,
}: {
  preview: RefundPreview;
  orderId: string;
  currency: string;
  selections: Array<{
    orderLineId: string;
    catalogId: string;
    productName: string;
    sizeFr: number;
    unitAmount: number;
    quantity: number;
  }>;
}) {
  const operationIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!operationIdPattern.test(preview.refund_operation_id) ||
    preview.order_id !== orderId || preview.currency !== currency ||
    preview.lines.length !== selections.length || selections.length === 0) {
    return false;
  }

  const expectedById = new Map(selections.map((selection) => [selection.orderLineId, selection]));
  if (expectedById.size !== selections.length) return false;
  const seen = new Set<string>();
  let computedTotal = 0;

  for (const line of preview.lines) {
    const expected = expectedById.get(line.order_line_id);
    if (!expected || seen.has(line.order_line_id) ||
      line.catalog_id !== expected.catalogId ||
      line.product_name !== expected.productName ||
      line.size_fr !== expected.sizeFr ||
      line.unit_amount !== expected.unitAmount ||
      line.requested_quantity !== expected.quantity ||
      line.amount !== expected.unitAmount * expected.quantity) {
      return false;
    }
    seen.add(line.order_line_id);
    computedTotal += line.amount;
  }

  return seen.size === selections.length &&
    Number.isSafeInteger(preview.amount) && preview.amount > 0 &&
    preview.amount === computedTotal;
}

export class AdminRefundRequestTimeoutError extends Error {
  constructor() {
    super("Request timed out. Check the refund status before retrying.");
    this.name = "AdminRefundRequestTimeoutError";
  }
}

type FetchImplementation = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export async function fetchAdminRefundRequest(
  input: string,
  init: RequestInit,
  options: {
    timeoutMs?: number;
    fetchImplementation?: FetchImplementation;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? ADMIN_REFUND_REQUEST_TIMEOUT_MS;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImplementation(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw new AdminRefundRequestTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildRefundRequestPayload({
  lines,
  operationId,
}: {
  lines: Array<{ orderLineId: string; quantity: number }>;
  operationId: string;
}) {
  return {
    action: "refund",
    lines: lines.map((line) => ({
      order_line_id: line.orderLineId,
      quantity: line.quantity,
    })),
    refund_operation_id: operationId,
  } as const;
}
