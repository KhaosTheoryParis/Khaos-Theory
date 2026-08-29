# Stripe Queue operations

This runbook applies to the prepared Cloudflare Queue architecture. It must not
be used to bypass the Stripe signature verification or the registry checks.

## Dead-letter diagnosis

The DLQ message body contains only `schemaVersion`, `stripeEventId`,
`eventType`, and `stripeObjectId`. Use `stripeEventId` to read the corresponding
row in `stripe_events`. Its `status`, `attempts`, `last_error`, and timestamps
show the last consumer result. A message that exhausts Queue retries normally
remains `failed`; a validation failure acknowledged by the consumer is stored as
`permanent_failure` and does not enter the DLQ.

The queue message ID is diagnostic only. The Stripe event ID is the durable
idempotency key shared by the queue payload and D1 registry.

Cloudflare retains messages in a DLQ without a consumer for four days. A safe
diagnostic handler is prepared in `handleStripeEventDeadLetterQueue()`, but the
DLQ is deliberately not configured with a remote consumer yet. When that
consumer is explicitly enabled later, it will read the matching registry row,
emit `STRIPE_QUEUE_DEAD_LETTER`, and acknowledge without executing any
Stripe/Pennylane business operation.

## Controlled replay after a correction

1. Verify the Stripe event is still present in Stripe and identify the exact
   `stripe_event_id` from the DLQ message.
2. Inspect `stripe_events`, Pennylane, `orders`, and `order_lines` before replay.
   Never infer absence from the registry status alone because an earlier attempt
   may have completed only part of the external workflow.
3. Deploy the correction first and keep the normal business idempotency checks
   enabled.
4. In one controlled operator action, reset only a `failed` or
   `permanent_failure` registry row with
   `resetStripeEventForControlledReplay()`, then publish the original minimal
   queue message. There is intentionally no public HTTP replay route.
5. Confirm the registry reaches `succeeded`. Repeating the same message after
   that point is safe: the consumer acknowledges it without business processing.

Do not delete registry rows or change a terminal status directly. Do not replay
both from Stripe and from the DLQ at the same time.
