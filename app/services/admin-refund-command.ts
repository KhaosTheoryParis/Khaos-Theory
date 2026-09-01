import type { RefundSelection } from "./refunds";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_REFERENCE_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|pi_[A-Za-z0-9]+|cs_(?:test_|live_)?[A-Za-z0-9]+)$/i;

export type ParsedAdminRefundRequest =
  | { action: "search"; reference: string }
  | {
      action: "preview";
      orderId: string | null;
      lines: RefundSelection[];
      refundShipping: boolean;
    }
  | {
      action: "refund";
      orderId: string | null;
      lines: RefundSelection[];
      refundShipping: boolean;
      operationId: string;
    };

export function parseAdminRefundRequest(body: unknown): ParsedAdminRefundRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>;
  const action = source.action;
  const reference = typeof source.reference === "string" ? source.reference.trim() : "";

  if (
    action === "search" && Object.keys(source).length === 2 &&
    Object.hasOwn(source, "action") && Object.hasOwn(source, "reference") &&
    ORDER_REFERENCE_PATTERN.test(reference)
  ) return { action, reference };

  const hasOrderId = Object.hasOwn(source, "order_id");
  const hasRefundShipping = Object.hasOwn(source, "refundShipping");
  if (hasOrderId !== hasRefundShipping) return null;
  const usesShippingContract = hasOrderId && hasRefundShipping;
  const orderId = typeof source.order_id === "string" ? source.order_id.trim() : "";
  const operationId = typeof source.refund_operation_id === "string"
    ? source.refund_operation_id.trim()
    : "";
  const refundShipping = usesShippingContract ? source.refundShipping : false;
  const rawLines = source.lines;
  if ((usesShippingContract && !UUID_PATTERN.test(orderId)) ||
    typeof refundShipping !== "boolean" ||
    !Array.isArray(rawLines) || rawLines.length > 100) return null;

  const lines: RefundSelection[] = [];
  const ids = new Set<string>();
  for (const rawLine of rawLines) {
    if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) return null;
    const line = rawLine as Record<string, unknown>;
    const lineId = typeof line.order_line_id === "string" ? line.order_line_id.trim() : "";
    if (Object.keys(line).length !== 2 || !Object.hasOwn(line, "order_line_id") ||
      !Object.hasOwn(line, "quantity") || !UUID_PATTERN.test(lineId) ||
      !Number.isSafeInteger(line.quantity) || (line.quantity as number) < 1 || ids.has(lineId)) {
      return null;
    }
    ids.add(lineId);
    lines.push({ orderLineId: lineId, requestedQuantity: line.quantity as number });
  }
  if (lines.length === 0 && !refundShipping) return null;

  if (action === "preview" && Object.hasOwn(source, "action") &&
    Object.hasOwn(source, "lines") &&
    ((!usesShippingContract && Object.keys(source).length === 2) ||
      (usesShippingContract && Object.keys(source).length === 4))) {
    return { action, orderId: usesShippingContract ? orderId : null, lines, refundShipping };
  }
  if (action === "refund" && Object.hasOwn(source, "action") &&
    Object.hasOwn(source, "lines") && Object.hasOwn(source, "refund_operation_id") &&
    UUID_PATTERN.test(operationId) &&
    ((!usesShippingContract && Object.keys(source).length === 3) ||
      (usesShippingContract && Object.keys(source).length === 5))) {
    return {
      action,
      orderId: usesShippingContract ? orderId : null,
      lines,
      refundShipping,
      operationId,
    };
  }
  return null;
}
