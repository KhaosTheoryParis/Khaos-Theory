CREATE TABLE stripe_events_v2 (
  stripe_event_id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  stripe_object_id TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN (
      'received', 'queued', 'processing', 'succeeded', 'failed', 'permanent_failure'
    )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processed_at TEXT
);

INSERT INTO stripe_events_v2 (
  stripe_event_id, event_type, stripe_object_id, status, attempts,
  last_error, created_at, updated_at, processed_at
)
SELECT
  stripe_event_id, event_type, stripe_object_id, status, attempts,
  last_error, created_at, updated_at, processed_at
FROM stripe_events;

DROP TABLE stripe_events;
ALTER TABLE stripe_events_v2 RENAME TO stripe_events;

CREATE UNIQUE INDEX idx_stripe_events_event_id
  ON stripe_events(stripe_event_id);
CREATE INDEX idx_stripe_events_status_updated_at
  ON stripe_events(status, updated_at);
CREATE INDEX idx_stripe_events_object_id
  ON stripe_events(stripe_object_id);
