import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import type { OrdersDatabase } from "../../../services/orders";
import {
  createStripeEventQueueMessage,
  SUPPORTED_STRIPE_QUEUE_EVENT_TYPES,
  type StripeEventQueueProducer,
} from "../../../services/stripe-event-queue";
import {
  getStripeEventRegistryErrorCode,
  markStripeEventQueued,
  registerStripeEvent,
} from "../../../services/stripe-event-registry";
import {
  createStripeClient,
  createWebhookTrace,
  getStripeEventProcessingErrorDetails,
  processStripeEvent,
  type StripeEventEnvironment,
} from "../../../services/stripe-events";
import { determineStripeWebhookProcessingMode } from "../../../services/stripe-webhook-mode";

export const runtime = "nodejs";

type WebhookEnvironment = StripeEventEnvironment & {
  STRIPE_WEBHOOK_SECRET: string;
  DB?: OrdersDatabase;
  STRIPE_EVENTS_QUEUE?: StripeEventQueueProducer;
  STRIPE_QUEUE_MODE?: "required" | "legacy_local";
};

export async function POST(req: Request) {
  const requestStartedAt = Date.now();
  const requestId = crypto.randomUUID();
  const trace = createWebhookTrace(requestStartedAt, requestId);
  trace("request_received", "success");

  const { env, ctx } = getCloudflareContext();
  const runtimeEnv = env as typeof env & WebhookEnvironment;
  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();

  trace("stripe_signature_verification", "start");
  if (!signature || !runtimeEnv.STRIPE_SECRET_KEY || !runtimeEnv.STRIPE_WEBHOOK_SECRET) {
    trace("stripe_signature_verification", "error", undefined, {
      code: "MISSING_STRIPE_SIGNATURE_OR_CONFIGURATION",
    });
    return NextResponse.json(
      { error: "Missing Stripe signature or configuration." },
      { status: 400 },
    );
  }

  const stripe = createStripeClient(runtimeEnv.STRIPE_SECRET_KEY);
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(payload, signature, runtimeEnv.STRIPE_WEBHOOK_SECRET);
    trace("stripe_signature_verification", "success", event);
  } catch {
    trace("stripe_signature_verification", "error", undefined, {
      code: "INVALID_STRIPE_SIGNATURE",
    });
    return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }

  trace("event_type_validation", "start", event);
  trace("event_type_validation", "success", event, {
    supported: SUPPORTED_STRIPE_QUEUE_EVENT_TYPES.has(event.type),
  });

  const processingMode = determineStripeWebhookProcessingMode({
    hasDatabase: Boolean(runtimeEnv.DB),
    hasQueue: Boolean(runtimeEnv.STRIPE_EVENTS_QUEUE),
    configuredMode: runtimeEnv.STRIPE_QUEUE_MODE,
    nodeEnvironment: process.env.NODE_ENV,
  });

  if (processingMode === "unavailable") {
    trace("queue_configuration", "error", event, {
      code: "STRIPE_QUEUE_REQUIRED_BINDING_MISSING",
      missing_db: !runtimeEnv.DB,
      missing_queue: !runtimeEnv.STRIPE_EVENTS_QUEUE,
    });
    return NextResponse.json(
      { error: "Stripe event queue is unavailable." },
      { status: 503 },
    );
  }

  if (!SUPPORTED_STRIPE_QUEUE_EVENT_TYPES.has(event.type)) {
    trace("http_acknowledgement", "success", event, {
      ignored_event: true,
      http_status: 200,
    });
    return NextResponse.json({ received: true }, { status: 200 });
  }

  if (processingMode === "queue" && runtimeEnv.DB && runtimeEnv.STRIPE_EVENTS_QUEUE) {
    const queueMessage = createStripeEventQueueMessage(event);

    try {
      trace("event_registry", "start", event);
      const record = await registerStripeEvent(runtimeEnv.DB, {
        stripeEventId: queueMessage.stripeEventId,
        eventType: queueMessage.eventType,
        stripeObjectId: queueMessage.stripeObjectId,
      });
      trace("event_registry", "success", event, { registry_status: record.status });

      if (
        record.status === "succeeded" ||
        record.status === "permanent_failure" ||
        record.status === "queued" ||
        record.status === "processing"
      ) {
        trace("queue_publish", "success", event, {
          skipped_duplicate: true,
          registry_status: record.status,
        });
      } else {
        trace("queue_publish", "start", event);
        await runtimeEnv.STRIPE_EVENTS_QUEUE.send(queueMessage);
        await markStripeEventQueued(runtimeEnv.DB, event.id);
        trace("queue_publish", "success", event, { skipped_duplicate: false });
      }

      trace("http_acknowledgement", "success", event, {
        processing_mode: "queue",
        http_status: 200,
      });
      return NextResponse.json({ received: true }, { status: 200 });
    } catch (error) {
      const registryCode = getStripeEventRegistryErrorCode(error);
      const code =
        registryCode === "UNEXPECTED_STRIPE_EVENT_REGISTRY_ERROR"
          ? "STRIPE_EVENT_QUEUE_PUBLISH_FAILED"
          : registryCode;
      trace("queue_publish", "error", event, { code });
      return NextResponse.json({ error: "Stripe event could not be queued." }, { status: 503 });
    }
  }

  // Explicit local-only fallback. The policy above makes this path unreachable whenever
  // NODE_ENV is production, even if STRIPE_QUEUE_MODE is accidentally set to legacy_local.
  trace("legacy_background_fallback", "start", event, {
    missing_db: !runtimeEnv.DB,
    missing_queue: !runtimeEnv.STRIPE_EVENTS_QUEUE,
  });
  const backgroundProcessing = processStripeEvent({
    event,
    env: runtimeEnv,
    trace,
    stripe,
  }).catch((error) => {
    const details = getStripeEventProcessingErrorDetails(error);
    trace("legacy_background_fallback", "error", event, { code: details.code });
  });
  ctx.waitUntil(backgroundProcessing);
  trace("http_acknowledgement", "success", event, {
    processing_mode: "legacy_wait_until",
    http_status: 200,
  });
  return NextResponse.json({ received: true }, { status: 200 });
}
