import Stripe from "stripe";
import type { OrdersDatabase } from "./orders";
import {
  claimStripeEvent,
  getStripeEventRecord,
  getStripeEventRegistryErrorCode,
  markStripeEventFailed,
  markStripeEventPermanentFailure,
  markStripeEventSucceeded,
} from "./stripe-event-registry";
import {
  createStripeClient,
  createWebhookTrace,
  getStripeEventProcessingErrorDetails,
  processStripeEvent,
  type StripeEventEnvironment,
} from "./stripe-events";

export const STRIPE_EVENTS_QUEUE_NAME = "khaos-theory-stripe-events";
export const STRIPE_EVENTS_DLQ_NAME = "khaos-theory-stripe-events-dlq";

export type StripeEventQueueMessage = {
  schemaVersion: 1;
  stripeEventId: string;
  eventType: string;
  stripeObjectId: string | null;
};

export type StripeEventQueueProducer = {
  send(message: StripeEventQueueMessage): Promise<unknown>;
};

type StripeEventQueueDelivery = {
  readonly id: string;
  readonly attempts: number;
  readonly body: StripeEventQueueMessage;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export type StripeEventQueueBatch = {
  readonly queue: string;
  readonly messages: readonly StripeEventQueueDelivery[];
};

export type StripeEventQueueEnvironment = StripeEventEnvironment & {
  DB: OrdersDatabase;
};

export type StripeQueueErrorClassification = {
  code: string;
  disposition: "transient" | "permanent";
};

export const SUPPORTED_STRIPE_QUEUE_EVENT_TYPES = new Set<Stripe.Event.Type>([
  "checkout.session.completed",
  "payment_intent.payment_failed",
  "checkout.session.expired",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.refunded",
]);

type StripeEventQueueDependencies = {
  retrieveEvent?: (stripeEventId: string) => Promise<Stripe.Event>;
  processEvent?: (event: Stripe.Event) => Promise<void>;
  claimEvent?: typeof claimStripeEvent;
  markSucceeded?: typeof markStripeEventSucceeded;
  markFailed?: typeof markStripeEventFailed;
  markPermanentFailure?: typeof markStripeEventPermanentFailure;
};

export function getStripeObjectId(event: Stripe.Event) {
  const object = event.data.object as { id?: unknown };
  return typeof object.id === "string" && object.id.length > 0 ? object.id : null;
}

export function createStripeEventQueueMessage(event: Stripe.Event): StripeEventQueueMessage {
  return {
    schemaVersion: 1,
    stripeEventId: event.id,
    eventType: event.type,
    stripeObjectId: getStripeObjectId(event),
  };
}

function assertQueueMessage(message: StripeEventQueueMessage) {
  if (
    message.schemaVersion !== 1 ||
    !/^evt_[A-Za-z0-9]+$/.test(message.stripeEventId) ||
    !/^[a-z0-9_.]+$/.test(message.eventType) ||
    (message.stripeObjectId !== null && !/^[A-Za-z0-9_]+$/.test(message.stripeObjectId))
  ) {
    throw new Error("INVALID_STRIPE_EVENT_QUEUE_MESSAGE");
  }
}

function validateRetrievedEvent(event: Stripe.Event, message: StripeEventQueueMessage) {
  if (
    event.id !== message.stripeEventId ||
    event.type !== message.eventType ||
    getStripeObjectId(event) !== message.stripeObjectId
  ) {
    throw new Error("STRIPE_EVENT_QUEUE_IDENTITY_MISMATCH");
  }
  if (!SUPPORTED_STRIPE_QUEUE_EVENT_TYPES.has(event.type)) {
    throw new Error("UNSUPPORTED_STRIPE_EVENT_TYPE");
  }
}

function getSafeProcessingErrorCode(error: unknown) {
  const registryCode = getStripeEventRegistryErrorCode(error);
  if (registryCode !== "UNEXPECTED_STRIPE_EVENT_REGISTRY_ERROR") return registryCode;
  return getStripeEventProcessingErrorDetails(error).code;
}

const PERMANENT_ERROR_CODES = new Set([
  "INVALID_STRIPE_EVENT_QUEUE_MESSAGE",
  "STRIPE_EVENT_QUEUE_IDENTITY_MISMATCH",
  "STRIPE_EVENT_IDENTITY_CONFLICT",
  "UNSUPPORTED_STRIPE_EVENT_TYPE",
  "INVALID_STRIPE_EVENT_ID",
  "INVALID_STRIPE_EVENT_TYPE",
  "INVALID_STRIPE_OBJECT_ID",
  "STRIPE_SESSION_NOT_PAID",
  "MISSING_OR_UNSUPPORTED_STRIPE_CURRENCY",
  "MISSING_STRIPE_CUSTOMER_DETAILS",
  "MISSING_STRIPE_ORDER_LINE_MAPPING",
  "PENNYLANE_VAT_RATE_MUST_BE_EXEMPT",
  "STRIPE_TAX_DOES_NOT_MATCH_PENNYLANE_VAT_RATE",
  "STRIPE_DISCOUNT_NOT_SUPPORTED",
  "PENNYLANE_SANDBOX_REQUIRED",
  "STRIPE_SANDBOX_REQUIRED",
  "UNSUPPORTED_EXTERNAL_REFUND",
]);

const TRANSIENT_ERROR_CODES = new Set([
  "MISSING_D1_DB_BINDING",
  "MISSING_PENNYLANE_API_TOKEN",
  "PENNYLANE_REQUEST_TIMEOUT",
  "PENNYLANE_API_UNREACHABLE",
  "PENNYLANE_INVALID_JSON_RESPONSE",
  "PENNYLANE_EMAIL_RETRY_LIMIT_REACHED",
  "PENNYLANE_MARK_AS_PAID_NOT_CONFIRMED",
  "STRIPE_EVENT_ALREADY_PROCESSING",
  "STRIPE_REQUEST_TIMEOUT",
  "STRIPE_NETWORK_ERROR",
]);

export function classifyStripeQueueError(error: unknown): StripeQueueErrorClassification {
  const details = getStripeEventProcessingErrorDetails(error);
  const code = getSafeProcessingErrorCode(error);
  const httpStatus = details.http_status;

  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeRateLimitError ||
    httpStatus === 408 ||
    httpStatus === 409 ||
    httpStatus === 425 ||
    httpStatus === 429 ||
    (typeof httpStatus === "number" && httpStatus >= 500) ||
    TRANSIENT_ERROR_CODES.has(code)
  ) {
    return { code, disposition: "transient" };
  }

  if (
    PERMANENT_ERROR_CODES.has(code) ||
    code.startsWith("INVALID_") ||
    code.startsWith("MISSING_") ||
    code.includes("_MISMATCH") ||
    code.startsWith("DUPLICATE_") ||
    code.includes("_MUST_BE_") ||
    code.endsWith("_NOT_FOUND") ||
    code.endsWith("_NOT_SUCCEEDED") ||
    code.endsWith("_REQUIRED") ||
    (typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500)
  ) {
    return { code, disposition: "permanent" };
  }

  // Unknown infrastructure failures are retried to avoid silently losing paid orders.
  return { code, disposition: "transient" };
}

export async function handleStripeEventQueue(
  batch: StripeEventQueueBatch,
  env: StripeEventQueueEnvironment,
  dependencies: StripeEventQueueDependencies = {},
) {
  for (const message of batch.messages) {
    let stripeEventId: string | null = null;

    try {
      const candidateEventId = (message.body as Partial<StripeEventQueueMessage>)?.stripeEventId;
      if (typeof candidateEventId === "string" && /^evt_[A-Za-z0-9]+$/.test(candidateEventId)) {
        stripeEventId = candidateEventId;
      }
      assertQueueMessage(message.body);
      const validatedEventId = message.body.stripeEventId;
      stripeEventId = validatedEventId;
      const claim = await (dependencies.claimEvent ?? claimStripeEvent)(env.DB, validatedEventId);

      if (claim.status === "already_terminal") {
        console.log("STRIPE_QUEUE_EVENT_ALREADY_TERMINAL", {
          stripe_event_id: stripeEventId,
          registry_status: claim.record.status,
          queue_message_id: message.id,
          delivery_attempt: message.attempts,
        });
        message.ack();
        continue;
      }

      const stripe = dependencies.retrieveEvent ? null : createStripeClient(env.STRIPE_SECRET_KEY);
      const event = dependencies.retrieveEvent
        ? await dependencies.retrieveEvent(validatedEventId)
        : await (stripe as Stripe).events.retrieve(validatedEventId);
      validateRetrievedEvent(event, message.body);
      const trace = createWebhookTrace(Date.now(), `queue:${message.id}`);

      if (dependencies.processEvent) {
        await dependencies.processEvent(event);
      } else {
        await processStripeEvent({ event, env, trace, stripe: stripe as Stripe });
      }
      await (dependencies.markSucceeded ?? markStripeEventSucceeded)(env.DB, validatedEventId);

      console.log("STRIPE_QUEUE_EVENT_SUCCEEDED", {
        stripe_event_id: stripeEventId,
        event_type: event.type,
        queue_message_id: message.id,
        delivery_attempt: message.attempts,
      });
      message.ack();
    } catch (error) {
      const classification = classifyStripeQueueError(error);
      const { code } = classification;

      if (classification.disposition === "permanent") {
        if (stripeEventId) {
          try {
            await (dependencies.markPermanentFailure ?? markStripeEventPermanentFailure)(
              env.DB,
              stripeEventId,
              code,
            );
          } catch (registryError) {
            console.error("STRIPE_QUEUE_REGISTRY_UPDATE_ERROR", {
              stripe_event_id: stripeEventId,
              code: getStripeEventRegistryErrorCode(registryError),
            });
            message.retry({ delaySeconds: 60 });
            continue;
          }
        }

        console.error("STRIPE_QUEUE_EVENT_PERMANENT_FAILURE", {
          stripe_event_id: stripeEventId,
          queue_message_id: message.id,
          delivery_attempt: message.attempts,
          code,
        });
        message.ack();
        continue;
      }

      if (stripeEventId) {
        try {
          await (dependencies.markFailed ?? markStripeEventFailed)(env.DB, stripeEventId, code);
        } catch (registryError) {
          console.error("STRIPE_QUEUE_REGISTRY_UPDATE_ERROR", {
            stripe_event_id: stripeEventId,
            code: getStripeEventRegistryErrorCode(registryError),
          });
        }
      }

      console.error("STRIPE_QUEUE_EVENT_RETRY", {
        stripe_event_id: stripeEventId,
        queue_message_id: message.id,
        delivery_attempt: message.attempts,
        code,
      });
      message.retry({ delaySeconds: 60 });
    }
  }
}

export async function handleStripeEventDeadLetterQueue(
  batch: StripeEventQueueBatch,
  env: StripeEventQueueEnvironment,
) {
  for (const message of batch.messages) {
    const candidateEventId = (message.body as Partial<StripeEventQueueMessage>)?.stripeEventId;
    const stripeEventId =
      typeof candidateEventId === "string" && /^evt_[A-Za-z0-9]+$/.test(candidateEventId)
        ? candidateEventId
        : null;

    let registry: Awaited<ReturnType<typeof getStripeEventRecord>> = null;
    let registryLookupError = false;
    if (stripeEventId) {
      try {
        registry = await getStripeEventRecord(env.DB, stripeEventId);
      } catch {
        registryLookupError = true;
      }
    }

    console.error("STRIPE_QUEUE_DEAD_LETTER", {
      stripe_event_id: stripeEventId,
      event_type: message.body?.eventType ?? null,
      stripe_object_id: message.body?.stripeObjectId ?? null,
      queue_message_id: message.id,
      delivery_attempt: message.attempts,
      registry_status: registry?.status ?? null,
      registry_attempts: registry?.attempts ?? null,
      registry_last_error: registry?.last_error ?? null,
      registry_lookup_error: registryLookupError,
    });

    // The durable registry remains the source for controlled replay. A future DLQ
    // consumer may acknowledge after writing this diagnostic log without rerunning
    // any Stripe/Pennylane business operation.
    message.ack();
  }
}
