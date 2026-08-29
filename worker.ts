// The OpenNext worker is generated locally by `opennextjs-cloudflare build`.
// @ts-expect-error The generated module does not exist before the first OpenNext build.
import { default as openNextWorker } from "./.open-next/worker.js";
import {
  handleStripeEventDeadLetterQueue,
  handleStripeEventQueue,
  STRIPE_EVENTS_DLQ_NAME,
  STRIPE_EVENTS_QUEUE_NAME,
  type StripeEventQueueBatch,
  type StripeEventQueueEnvironment,
} from "./app/services/stripe-event-queue";

export default {
  fetch: openNextWorker.fetch,
  async queue(batch: StripeEventQueueBatch, env: StripeEventQueueEnvironment) {
    if (batch.queue === STRIPE_EVENTS_DLQ_NAME) {
      await handleStripeEventDeadLetterQueue(batch, env);
      return;
    }
    if (batch.queue === STRIPE_EVENTS_QUEUE_NAME) {
      await handleStripeEventQueue(batch, env);
      return;
    }

    console.error("STRIPE_QUEUE_UNKNOWN_SOURCE", { queue: batch.queue });
    for (const message of batch.messages) message.retry({ delaySeconds: 60 });
  },
};
