import type { OrdersDatabase } from "./orders";

export type StripeEventStatus =
  | "received"
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "permanent_failure";

export type StripeEventRecord = {
  stripe_event_id: string;
  event_type: string;
  stripe_object_id: string | null;
  status: StripeEventStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
};

type StripeEventIdentity = {
  stripeEventId: string;
  eventType: string;
  stripeObjectId: string | null;
};

export class StripeEventRegistryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "StripeEventRegistryError";
    this.code = code;
  }
}

export const STRIPE_EVENT_PROCESSING_LEASE_MS = 5 * 60_000;

export function getStripeEventStaleBefore(now = new Date()) {
  return new Date(now.getTime() - STRIPE_EVENT_PROCESSING_LEASE_MS).toISOString();
}

function assertIdentity(identity: StripeEventIdentity) {
  if (!/^evt_[A-Za-z0-9]+$/.test(identity.stripeEventId)) {
    throw new StripeEventRegistryError("INVALID_STRIPE_EVENT_ID");
  }
  if (!/^[a-z0-9_.]+$/.test(identity.eventType)) {
    throw new StripeEventRegistryError("INVALID_STRIPE_EVENT_TYPE");
  }
  if (identity.stripeObjectId !== null && !/^[A-Za-z0-9_]+$/.test(identity.stripeObjectId)) {
    throw new StripeEventRegistryError("INVALID_STRIPE_OBJECT_ID");
  }
}

export async function getStripeEventRecord(
  db: OrdersDatabase,
  stripeEventId: string,
) {
  return db
    .prepare("SELECT * FROM stripe_events WHERE stripe_event_id = ?1")
    .bind(stripeEventId)
    .first<StripeEventRecord>();
}

export async function registerStripeEvent(
  db: OrdersDatabase,
  identity: StripeEventIdentity,
) {
  assertIdentity(identity);
  const now = new Date().toISOString();
  const insertion = await db
    .prepare(
      `INSERT OR IGNORE INTO stripe_events (
        stripe_event_id, event_type, stripe_object_id, status, attempts,
        last_error, created_at, updated_at, processed_at
      ) VALUES (?1, ?2, ?3, 'received', 0, NULL, ?4, ?4, NULL)`,
    )
    .bind(identity.stripeEventId, identity.eventType, identity.stripeObjectId, now)
    .run();

  if (!insertion.success) {
    throw new StripeEventRegistryError("STRIPE_EVENT_REGISTRATION_FAILED");
  }

  const record = await getStripeEventRecord(db, identity.stripeEventId);
  if (!record) throw new StripeEventRegistryError("STRIPE_EVENT_REGISTRATION_NOT_FOUND");

  if (
    record.event_type !== identity.eventType ||
    record.stripe_object_id !== identity.stripeObjectId
  ) {
    throw new StripeEventRegistryError("STRIPE_EVENT_IDENTITY_CONFLICT");
  }

  return record;
}

export async function markStripeEventQueued(
  db: OrdersDatabase,
  stripeEventId: string,
) {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE stripe_events
       SET status = 'queued', last_error = NULL, updated_at = ?2
       WHERE stripe_event_id = ?1 AND status IN ('received', 'failed')`,
    )
    .bind(stripeEventId, now)
    .run();

  if (!result.success) throw new StripeEventRegistryError("STRIPE_EVENT_QUEUE_STATUS_FAILED");

  const record = await getStripeEventRecord(db, stripeEventId);
  if (!record) throw new StripeEventRegistryError("STRIPE_EVENT_QUEUE_STATUS_NOT_FOUND");
  if (
    !(["queued", "processing", "succeeded", "permanent_failure"] as StripeEventStatus[]).includes(
      record.status,
    )
  ) {
    throw new StripeEventRegistryError("STRIPE_EVENT_QUEUE_STATUS_CONFLICT");
  }

  return record;
}

export async function claimStripeEvent(
  db: OrdersDatabase,
  stripeEventId: string,
) {
  const now = new Date();
  const staleBefore = getStripeEventStaleBefore(now);
  const result = await db
    .prepare(
      `UPDATE stripe_events
       SET status = 'processing', attempts = attempts + 1,
           last_error = NULL, updated_at = ?2
       WHERE stripe_event_id = ?1
         AND status NOT IN ('succeeded', 'permanent_failure')
         AND (status <> 'processing' OR updated_at <= ?3)`,
    )
    .bind(stripeEventId, now.toISOString(), staleBefore)
    .run();

  if (!result.success) throw new StripeEventRegistryError("STRIPE_EVENT_CLAIM_FAILED");

  const record = await getStripeEventRecord(db, stripeEventId);
  if (!record) throw new StripeEventRegistryError("STRIPE_EVENT_CLAIM_NOT_FOUND");
  if (record.status === "succeeded" || record.status === "permanent_failure") {
    return { status: "already_terminal" as const, record };
  }
  if ((result.meta?.changes ?? 0) !== 1 || record.status !== "processing") {
    throw new StripeEventRegistryError("STRIPE_EVENT_ALREADY_PROCESSING");
  }

  return { status: "claimed" as const, record };
}

export async function markStripeEventSucceeded(
  db: OrdersDatabase,
  stripeEventId: string,
) {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE stripe_events
       SET status = 'succeeded', last_error = NULL,
           updated_at = ?2, processed_at = ?2
       WHERE stripe_event_id = ?1 AND status = 'processing'`,
    )
    .bind(stripeEventId, now)
    .run();

  if (!result.success || (result.meta?.changes ?? 0) !== 1) {
    const record = await getStripeEventRecord(db, stripeEventId);
    if (record?.status === "succeeded") return record;
    throw new StripeEventRegistryError("STRIPE_EVENT_SUCCESS_STATUS_FAILED");
  }

  const record = await getStripeEventRecord(db, stripeEventId);
  if (!record) throw new StripeEventRegistryError("STRIPE_EVENT_SUCCESS_STATUS_NOT_FOUND");
  return record;
}

export async function markStripeEventFailed(
  db: OrdersDatabase,
  stripeEventId: string,
  errorCode: string,
) {
  const now = new Date().toISOString();
  const safeError = errorCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 500);
  const result = await db
    .prepare(
      `UPDATE stripe_events
       SET status = 'failed', last_error = ?2, updated_at = ?3
       WHERE stripe_event_id = ?1 AND status NOT IN ('succeeded', 'permanent_failure')`,
    )
    .bind(stripeEventId, safeError || "UNKNOWN_PROCESSING_ERROR", now)
    .run();

  if (!result.success) throw new StripeEventRegistryError("STRIPE_EVENT_FAILURE_STATUS_FAILED");
}

export async function markStripeEventPermanentFailure(
  db: OrdersDatabase,
  stripeEventId: string,
  errorCode: string,
) {
  const now = new Date().toISOString();
  const safeError = errorCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 500);
  const result = await db
    .prepare(
      `UPDATE stripe_events
       SET status = 'permanent_failure', last_error = ?2,
           updated_at = ?3, processed_at = ?3
       WHERE stripe_event_id = ?1 AND status <> 'succeeded'`,
    )
    .bind(stripeEventId, safeError || "UNKNOWN_PERMANENT_ERROR", now)
    .run();

  if (!result.success || (result.meta?.changes ?? 0) !== 1) {
    const record = await getStripeEventRecord(db, stripeEventId);
    if (record?.status === "permanent_failure") return record;
    throw new StripeEventRegistryError("STRIPE_EVENT_PERMANENT_FAILURE_STATUS_FAILED");
  }

  const record = await getStripeEventRecord(db, stripeEventId);
  if (!record) {
    throw new StripeEventRegistryError("STRIPE_EVENT_PERMANENT_FAILURE_STATUS_NOT_FOUND");
  }
  return record;
}

export async function resetStripeEventForControlledReplay(
  db: OrdersDatabase,
  stripeEventId: string,
) {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE stripe_events
       SET status = 'received', last_error = NULL,
           updated_at = ?2, processed_at = NULL
       WHERE stripe_event_id = ?1 AND status IN ('failed', 'permanent_failure')`,
    )
    .bind(stripeEventId, now)
    .run();

  if (!result.success || (result.meta?.changes ?? 0) !== 1) {
    throw new StripeEventRegistryError("STRIPE_EVENT_REPLAY_RESET_NOT_ALLOWED");
  }
}

export function getStripeEventRegistryErrorCode(error: unknown) {
  return error instanceof StripeEventRegistryError
    ? error.code
    : "UNEXPECTED_STRIPE_EVENT_REGISTRY_ERROR";
}
