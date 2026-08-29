import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  classifyStripeQueueError,
  handleStripeEventQueue,
  SUPPORTED_STRIPE_QUEUE_EVENT_TYPES,
  type StripeEventQueueBatch,
  type StripeEventQueueEnvironment,
  type StripeEventQueueMessage,
} from "../app/services/stripe-event-queue";
import {
  getStripeEventStaleBefore,
  STRIPE_EVENT_PROCESSING_LEASE_MS,
  type StripeEventRecord,
  type StripeEventStatus,
} from "../app/services/stripe-event-registry";
import {
  createStripeClient,
  getStripeEventProcessingErrorDetails,
  StripeEventProcessingError,
} from "../app/services/stripe-events";
import { determineStripeWebhookProcessingMode } from "../app/services/stripe-webhook-mode";

const EVENT_ID = "evt_queueHardening1";
const SESSION_ID = "cs_test_queueHardening1";

function record(status: StripeEventStatus): StripeEventRecord {
  return {
    stripe_event_id: EVENT_ID,
    event_type: "checkout.session.completed",
    stripe_object_id: SESSION_ID,
    status,
    attempts: 1,
    last_error: null,
    created_at: "2026-08-26T10:00:00.000Z",
    updated_at: "2026-08-26T10:00:00.000Z",
    processed_at: status === "succeeded" ? "2026-08-26T10:00:01.000Z" : null,
  };
}

function stripeEvent(): Stripe.Event {
  return {
    id: EVENT_ID,
    object: "event",
    api_version: "2026-08-27.basil",
    created: 0,
    data: { object: { id: SESSION_ID } as Stripe.Checkout.Session },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.completed",
  } as Stripe.Event;
}

function delivery() {
  const state = { ackCount: 0, retryDelays: [] as Array<number | undefined> };
  const body: StripeEventQueueMessage = {
    schemaVersion: 1,
    stripeEventId: EVENT_ID,
    eventType: "checkout.session.completed",
    stripeObjectId: SESSION_ID,
  };
  return {
    state,
    message: {
      id: "queue-message-1",
      attempts: 1,
      body,
      ack() {
        state.ackCount += 1;
      },
      retry(options?: { delaySeconds?: number }) {
        state.retryDelays.push(options?.delaySeconds);
      },
    },
  };
}

function batch(message: ReturnType<typeof delivery>["message"]): StripeEventQueueBatch {
  return { queue: "local-test", messages: [message] };
}

const env = {
  DB: {},
  STRIPE_SECRET_KEY: "sk_test_not_a_real_key",
} as StripeEventQueueEnvironment;

test("the Worker Stripe client uses fetch with bounded network behavior", () => {
  const stripe = createStripeClient("sk_test_not_a_real_key");
  const httpClient = stripe.getApiField("httpClient");

  assert.equal(httpClient.getClientName(), "fetch");
  assert.equal(httpClient.constructor.name, "FetchHttpClient");
  assert.equal(stripe.getApiField("timeout"), 10_000);
  assert.equal(stripe.getApiField("maxNetworkRetries"), 0);
});

test("a repeated delivery does not process an event twice after succeeded", async () => {
  let status: StripeEventStatus = "queued";
  let processCount = 0;
  const dependencies = {
    claimEvent: async () =>
      status === "succeeded"
        ? { status: "already_terminal" as const, record: record(status) }
        : { status: "claimed" as const, record: record("processing") },
    retrieveEvent: async () => stripeEvent(),
    processEvent: async () => {
      processCount += 1;
    },
    markSucceeded: async () => {
      status = "succeeded";
      return record(status);
    },
  };

  const first = delivery();
  await handleStripeEventQueue(batch(first.message), env, dependencies as never);
  const replay = delivery();
  await handleStripeEventQueue(batch(replay.message), env, dependencies as never);

  assert.equal(processCount, 1);
  assert.equal(first.state.ackCount, 1);
  assert.equal(replay.state.ackCount, 1);
  assert.deepEqual(first.state.retryDelays, []);
  assert.deepEqual(replay.state.retryDelays, []);
});

test("an already succeeded event is acknowledged without Stripe retrieval", async () => {
  let retrievalCount = 0;
  const item = delivery();

  await handleStripeEventQueue(batch(item.message), env, {
    claimEvent: async () => ({ status: "already_terminal", record: record("succeeded") }),
    retrieveEvent: async () => {
      retrievalCount += 1;
      return stripeEvent();
    },
  } as never);

  assert.equal(retrievalCount, 0);
  assert.equal(item.state.ackCount, 1);
  assert.deepEqual(item.state.retryDelays, []);
});

test("a permanent mapping error is persisted and acknowledged without retry", async () => {
  let permanentCode: string | null = null;
  const item = delivery();

  await handleStripeEventQueue(batch(item.message), env, {
    claimEvent: async () => ({ status: "claimed", record: record("processing") }),
    retrieveEvent: async () => stripeEvent(),
    processEvent: async () => {
      throw new Error("STRIPE_EVENT_QUEUE_IDENTITY_MISMATCH");
    },
    markPermanentFailure: async (_db: unknown, _eventId: string, code: string) => {
      permanentCode = code;
      return record("permanent_failure");
    },
  } as never);

  assert.equal(permanentCode, "STRIPE_EVENT_QUEUE_IDENTITY_MISMATCH");
  assert.equal(item.state.ackCount, 1);
  assert.deepEqual(item.state.retryDelays, []);
});

test("missing mandatory business metadata is classified as permanent", () => {
  assert.deepEqual(
    classifyStripeQueueError(new Error("MISSING_EXPANDED_STRIPE_PRODUCT_MAPPING")),
    {
      code: "MISSING_EXPANDED_STRIPE_PRODUCT_MAPPING",
      disposition: "permanent",
    },
  );
});

test("refund.updated is supported and external refunds require manual intervention", () => {
  assert.equal(SUPPORTED_STRIPE_QUEUE_EVENT_TYPES.has("refund.updated"), true);
  assert.deepEqual(classifyStripeQueueError(new Error("UNSUPPORTED_EXTERNAL_REFUND")), {
    code: "UNSUPPORTED_EXTERNAL_REFUND",
    disposition: "permanent",
  });
});

for (const httpStatus of [400, 401, 403, 422]) {
  test(`an HTTP ${httpStatus} processing error remains structured and permanent`, () => {
    const error = new StripeEventProcessingError({
      code: "PENNYLANE_API_REQUEST_FAILED",
      http_status: httpStatus,
    });

    assert.deepEqual(getStripeEventProcessingErrorDetails(error), {
      code: "PENNYLANE_API_REQUEST_FAILED",
      http_status: httpStatus,
    });
    assert.deepEqual(classifyStripeQueueError(error), {
      code: "PENNYLANE_API_REQUEST_FAILED",
      disposition: "permanent",
    });
  });
}

for (const httpStatus of [429, 500]) {
  test(`an HTTP ${httpStatus} processing error remains structured and transient`, () => {
    const error = new StripeEventProcessingError({
      code: "PENNYLANE_API_REQUEST_FAILED",
      http_status: httpStatus,
    });

    assert.deepEqual(getStripeEventProcessingErrorDetails(error), {
      code: "PENNYLANE_API_REQUEST_FAILED",
      http_status: httpStatus,
    });
    assert.deepEqual(classifyStripeQueueError(error), {
      code: "PENNYLANE_API_REQUEST_FAILED",
      disposition: "transient",
    });
  });
}

test("a propagated timeout remains transient", () => {
  const error = new StripeEventProcessingError({ code: "PENNYLANE_REQUEST_TIMEOUT" });

  assert.deepEqual(getStripeEventProcessingErrorDetails(error), {
    code: "PENNYLANE_REQUEST_TIMEOUT",
  });
  assert.deepEqual(classifyStripeQueueError(error), {
    code: "PENNYLANE_REQUEST_TIMEOUT",
    disposition: "transient",
  });
});

test("a transient Pennylane timeout is persisted and retried after 60 seconds", async () => {
  let failedCode: string | null = null;
  const item = delivery();

  await handleStripeEventQueue(batch(item.message), env, {
    claimEvent: async () => ({ status: "claimed", record: record("processing") }),
    retrieveEvent: async () => stripeEvent(),
    processEvent: async () => {
      throw new Error("PENNYLANE_REQUEST_TIMEOUT");
    },
    markFailed: async (_db: unknown, _eventId: string, code: string) => {
      failedCode = code;
    },
  } as never);

  assert.equal(failedCode, "PENNYLANE_REQUEST_TIMEOUT");
  assert.equal(item.state.ackCount, 0);
  assert.deepEqual(item.state.retryDelays, [60]);
});

test("the processing lease becomes stale after exactly five minutes", () => {
  const now = new Date("2026-08-26T12:00:00.000Z");
  assert.equal(STRIPE_EVENT_PROCESSING_LEASE_MS, 300_000);
  assert.equal(getStripeEventStaleBefore(now), "2026-08-26T11:55:00.000Z");
});

test("production refuses a missing Queue or missing D1 binding", () => {
  assert.equal(
    determineStripeWebhookProcessingMode({
      hasDatabase: true,
      hasQueue: false,
      configuredMode: "required",
      nodeEnvironment: "production",
    }),
    "unavailable",
  );
  assert.equal(
    determineStripeWebhookProcessingMode({
      hasDatabase: false,
      hasQueue: true,
      configuredMode: "required",
      nodeEnvironment: "production",
    }),
    "unavailable",
  );
  assert.equal(
    determineStripeWebhookProcessingMode({
      hasDatabase: false,
      hasQueue: false,
      configuredMode: "legacy_local",
      nodeEnvironment: "production",
    }),
    "unavailable",
  );
  assert.equal(
    determineStripeWebhookProcessingMode({
      hasDatabase: false,
      hasQueue: false,
      configuredMode: "legacy_local",
      nodeEnvironment: undefined,
    }),
    "unavailable",
  );
});

test("legacy waitUntil fallback requires an explicit non-production mode", () => {
  assert.equal(
    determineStripeWebhookProcessingMode({
      hasDatabase: false,
      hasQueue: false,
      configuredMode: "legacy_local",
      nodeEnvironment: "development",
    }),
    "legacy_local",
  );
});
