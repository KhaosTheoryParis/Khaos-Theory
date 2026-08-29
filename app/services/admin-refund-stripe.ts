import Stripe from "stripe";

export const ADMIN_REFUND_STRIPE_TIMEOUT_MS = 10_000;
export const ADMIN_REFUND_STRIPE_MAX_NETWORK_RETRIES = 0;

type TraceLogger = Pick<Console, "log" | "error">;

function safeErrorDetails(error: unknown) {
  if (error instanceof Stripe.errors.StripeError) {
    return {
      error_type: error.type,
      error_code: error.code ?? null,
    };
  }

  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      error_type: error.name || "Error",
      error_code: typeof code === "string" ? code : null,
    };
  }

  return {
    error_type: "UnknownError",
    error_code: null,
  };
}

export function createAdminRefundStripeClient(secretKey: string) {
  return new Stripe(secretKey, {
    timeout: ADMIN_REFUND_STRIPE_TIMEOUT_MS,
    maxNetworkRetries: ADMIN_REFUND_STRIPE_MAX_NETWORK_RETRIES,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function createAdminStripeRefund(
  stripe: Stripe,
  input: {
    paymentIntentId: string;
    amount: number;
    metadata: Record<string, string>;
    idempotencyKey: string;
  },
) {
  return stripe.refunds.create(
    {
      payment_intent: input.paymentIntentId,
      amount: input.amount,
      metadata: input.metadata,
    },
    { idempotencyKey: input.idempotencyKey },
  );
}

export async function traceAdminRefundStep<T>(
  step: string,
  action: () => Promise<T>,
  logger: TraceLogger = console,
) {
  const startedAt = Date.now();

  logger.log("ADMIN_REFUND_TRACE", {
    step,
    state: "start",
    duration_ms: 0,
  });

  try {
    const result = await action();
    logger.log("ADMIN_REFUND_TRACE", {
      step,
      state: "success",
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logger.error("ADMIN_REFUND_TRACE", {
      step,
      state: "error",
      duration_ms: Date.now() - startedAt,
      ...safeErrorDetails(error),
    });
    throw error;
  }
}
