CREATE TABLE IF NOT EXISTS stripe_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  stripe_object_id TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'queued', 'processing', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_events_event_id
  ON stripe_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_stripe_events_status_updated_at
  ON stripe_events(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_stripe_events_object_id
  ON stripe_events(stripe_object_id);
